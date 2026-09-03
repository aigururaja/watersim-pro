#!/usr/bin/env python3
"""WaterSim Pro - PLC protocol bridge (JSON-line RPC over stdio).

Spawned by backend/src/plc/bridge/bridgeClient.js - one persistent child per
Node PLC client (plus short-lived one-shots for probe/test). Wire protocol:

  request (one JSON object per line on stdin):
    {"id": 1, "op": "read", "protocol": "opcua", "address": "ns=2;s=Tag"}
  reply (one JSON line on stdout, flushed per line):
    {"id": 1, "ok": true, "value": 42.5}
    {"id": 1, "ok": false, "error": "...", "connectionLost": false}

  ops:
    ping                              -> value "pong"
    probe [protocol?]                 -> {"<protocol>": {"available": bool, "reason"?: str}}
                                         (single {"available", "reason"?} when protocol given)
    test    {protocol, config}        -> {"latencyMs": n}   (connect + disconnect)
    connect {protocol, config}        -> true               (open + cache the session)
    read    {protocol, address}       -> number (raw device value)
    write   {protocol, address, value}-> true
    disconnect {protocol}             -> true

Error classification (mirrors the Node driver contract in ../README.md):
  connectionLost:true  - socket/session-level failure (refused, reset, timed
                         out, session lost). The poller drops its cached client
                         and reconnects with backoff.
  connectionLost:false - tag-level failure (bad node id, unknown tag, address
                         out of range). Only that binding goes quality 'bad'.

Protocols:
  opcua       - asyncua   (config: endpoint, username?, password?, timeoutMs?)
                address = OPC UA node id: 'ns=2;s=Tag' | 'ns=2;i=42'
  s7          - python-snap7 (config: host, rack=0, slot=1, port=102, timeoutMs?)
                address grammar (case-insensitive):
                  db<N>.real<off>         REAL  float32 at byte <off> (4 bytes)
                  db<N>.int<off>          INT   signed 16-bit         (2 bytes)
                  db<N>.dint<off>         DINT  signed 32-bit         (4 bytes)
                  db<N>.word<off>         WORD  unsigned 16-bit       (2 bytes)
                  db<N>.bool<byte>.<bit>  bit <bit> (0-7) of byte <byte>
  ethernet_ip - pycomm3 LogixDriver (config: host, slot=0, timeoutMs?)
                address = Logix tag path: 'MyTag' | 'Program:MainProgram.Counter'

The bridge never crashes on a bad line (it replies with an error) and exits
cleanly - closing open PLC sessions - when stdin reaches EOF.
"""

import asyncio
import concurrent.futures
import json
import math
import re
import sys
import threading
import time

PIP_HINT = "pip install -r backend/requirements-plc.txt"
PROTOCOLS = ("opcua", "s7", "ethernet_ip")

DEFAULT_TIMEOUT_MS = 5000
MAX_TIMEOUT_MS = 10000


class BridgeError(Exception):
    """Error with the connectionLost classification the Node side relies on."""

    def __init__(self, message, connection_lost=False):
        super().__init__(message)
        self.connection_lost = bool(connection_lost)


def _timeout_seconds(config):
    try:
        ms = float((config or {}).get("timeoutMs") or DEFAULT_TIMEOUT_MS)
    except (TypeError, ValueError):
        ms = DEFAULT_TIMEOUT_MS
    if ms <= 0:
        ms = DEFAULT_TIMEOUT_MS
    return min(ms, MAX_TIMEOUT_MS) / 1000.0


def _to_number(value, address):
    """Coerce a read value to a JSON number; tag-level error when impossible.

    NaN/Infinity (the standard 'faulted sensor' markers on S7 REALs and OPC UA
    floats) must be a TAG-level error: json.dumps would emit the non-JSON
    literal `NaN`, the Node side would drop the line, time the request out and
    misclassify one bad sensor as a lost connection for every sibling binding.
    """
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        f = float(value)
        if not math.isfinite(f):
            raise BridgeError("Tag %r returned a non-finite value (%r)" % (address, f))
        return f
    raise BridgeError(
        "Tag %r returned a non-numeric value of type %s" % (address, type(value).__name__)
    )


# ---------------------------------------------------------------------------
# OPC UA (asyncua)
# ---------------------------------------------------------------------------

class OpcuaHandler:
    """One asyncua Client on a dedicated background event loop."""

    protocol = "opcua"

    def __init__(self):
        self._loop = None
        self._thread = None
        self._client = None
        self._timeout = DEFAULT_TIMEOUT_MS / 1000.0

    @staticmethod
    def probe():
        try:
            import asyncua  # noqa: F401
        except ImportError:
            return {
                "available": False,
                "reason": "Python package 'asyncua' not installed — " + PIP_HINT,
            }
        except Exception as exc:  # broken install
            return {"available": False, "reason": "asyncua failed to import: %s" % exc}
        return {"available": True}

    def _ensure_loop(self):
        if self._loop is not None:
            return
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever, name="opcua-loop", daemon=True
        )
        self._thread.start()

    def _run(self, coro):
        """Run a coroutine on the background loop with a hard backstop timeout."""
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            # The Node side times out first (and kills us); this is a backstop.
            return fut.result(self._timeout + 5.0)
        except concurrent.futures.TimeoutError:
            fut.cancel()
            raise BridgeError("OPC UA operation timed out", connection_lost=True)

    @staticmethod
    def _is_connection_error(exc):
        if isinstance(exc, (ConnectionError, OSError, asyncio.TimeoutError, TimeoutError)):
            return True
        try:
            from asyncua.ua import UaStatusCodeError
        except ImportError:
            return False
        if isinstance(exc, UaStatusCodeError):
            name = type(exc).__name__
            markers = ("Session", "SecureChannel", "Connection", "ServerNotConnected",
                       "Communication", "Timeout", "Disconnect", "ServerHalted")
            return any(m in name for m in markers)
        return False

    def _wrap(self, exc, doing):
        if isinstance(exc, BridgeError):
            return exc
        return BridgeError(
            "OPC UA %s failed: %s" % (doing, exc),
            connection_lost=self._is_connection_error(exc),
        )

    def _require_client(self):
        if self._client is None:
            raise BridgeError("opcua: not connected — call connect first", connection_lost=True)
        return self._client

    def connect(self, config):
        try:
            from asyncua import Client
        except ImportError:
            raise BridgeError("Python package 'asyncua' not installed — " + PIP_HINT)
        config = config or {}
        endpoint = config.get("endpoint")
        if not endpoint or not isinstance(endpoint, str):
            raise BridgeError("opcua config.endpoint is required")
        self._timeout = _timeout_seconds(config)
        self._ensure_loop()
        client = Client(url=endpoint, timeout=self._timeout)
        if config.get("username"):
            client.set_user(str(config["username"]))
            if config.get("password") not in (None, ""):
                client.set_password(str(config["password"]))
        try:
            self._run(client.connect())
        except BridgeError:
            raise
        except Exception as exc:
            raise BridgeError("OPC UA connect to %s failed: %s" % (endpoint, exc),
                              connection_lost=True)
        self._client = client

    def _node(self, client, address):
        if not isinstance(address, str) or not address.strip():
            raise BridgeError("OPC UA address must be a node id string like 'ns=2;s=Tag'")
        try:
            return client.get_node(address.strip())
        except Exception as exc:  # malformed node id -> tag-level
            raise BridgeError("Invalid OPC UA node id %r: %s" % (address, exc))

    def read(self, address):
        client = self._require_client()
        node = self._node(client, address)
        try:
            value = self._run(node.read_value())
        except Exception as exc:
            raise self._wrap(exc, "read of %r" % address)
        return _to_number(value, address)

    def write(self, address, value):
        client = self._require_client()
        node = self._node(client, address)
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise BridgeError("Cannot write non-numeric value %r to %r" % (value, address))

        from asyncua import ua

        async def _write():
            vtype = await node.read_data_type_as_variant_type()
            name = vtype.name
            if name == "Boolean":
                coerced = bool(num)
            elif name in ("SByte", "Byte", "Int16", "UInt16", "Int32", "UInt32",
                          "Int64", "UInt64"):
                coerced = int(round(num))
            else:  # Float, Double, and anything else numeric-ish
                coerced = num
            await node.write_value(ua.DataValue(ua.Variant(coerced, vtype)))

        try:
            self._run(_write())
        except Exception as exc:
            raise self._wrap(exc, "write of %r" % address)

    def disconnect(self):
        client, self._client = self._client, None
        if client is not None:
            try:
                self._run(client.disconnect())
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Siemens S7 (python-snap7)
# ---------------------------------------------------------------------------

_S7_WORD_RE = re.compile(r"^db(\d+)\.(real|int|dint|word)(\d+)$")
_S7_BOOL_RE = re.compile(r"^db(\d+)\.bool(\d+)\.([0-7])$")
_S7_SIZES = {"real": 4, "int": 2, "dint": 4, "word": 2, "bool": 1}


def parse_s7_address(address):
    """Parse the S7 address grammar documented in the module docstring."""
    if not isinstance(address, str):
        raise BridgeError("S7 address must be a string")
    a = address.strip().lower()
    m = _S7_WORD_RE.match(a)
    if m:
        return {"db": int(m.group(1)), "kind": m.group(2), "offset": int(m.group(3)), "bit": None}
    m = _S7_BOOL_RE.match(a)
    if m:
        return {"db": int(m.group(1)), "kind": "bool", "offset": int(m.group(2)),
                "bit": int(m.group(3))}
    raise BridgeError(
        "Invalid S7 address %r — expected 'db<N>.real<off>' | 'db<N>.int<off>' | "
        "'db<N>.dint<off>' | 'db<N>.word<off>' | 'db<N>.bool<byte>.<bit>'" % address
    )


class S7Handler:
    protocol = "s7"

    def __init__(self):
        self._client = None

    @staticmethod
    def probe():
        try:
            import snap7
        except ImportError:
            return {
                "available": False,
                "reason": "Python package 'python-snap7' not installed — " + PIP_HINT,
            }
        try:
            # Creating a client loads the bundled snap7 native library.
            client = snap7.client.Client()
            try:
                client.destroy()
            except Exception:
                pass
        except Exception as exc:
            return {
                "available": False,
                "reason": "python-snap7 installed but its snap7 native library "
                          "failed to load: %s" % exc,
            }
        return {"available": True}

    @staticmethod
    def _is_connection_error(exc):
        try:
            from snap7.error import S7ConnectionError, S7TimeoutError
            if isinstance(exc, (S7ConnectionError, S7TimeoutError)):
                return True
        except ImportError:
            pass
        if isinstance(exc, (ConnectionError, OSError, TimeoutError)):
            return True
        msg = str(exc).lower()
        tag_markers = ("address out of range", "item not available", "invalid value",
                       "invalid transport size", "db does not exist")
        if any(m in msg for m in tag_markers):
            return False
        lost_markers = ("tcp", "iso", "connection", "timed out", "timeout",
                        "unreachable", "refused", "reset")
        return any(m in msg for m in lost_markers)

    def _wrap(self, exc, doing):
        if isinstance(exc, BridgeError):
            return exc
        return BridgeError("S7 %s failed: %s" % (doing, exc),
                           connection_lost=self._is_connection_error(exc))

    def _require_client(self):
        if self._client is None:
            raise BridgeError("s7: not connected — call connect first", connection_lost=True)
        return self._client

    def connect(self, config):
        try:
            import snap7
        except ImportError:
            raise BridgeError("Python package 'python-snap7' not installed — " + PIP_HINT)
        config = config or {}
        host = config.get("host")
        if not host or not isinstance(host, str):
            raise BridgeError("s7 config.host is required")
        rack = int(config.get("rack") or 0)
        slot = config.get("slot")
        slot = 1 if slot in (None, "") else int(slot)
        port = int(config.get("port") or 102)
        client = snap7.client.Client()
        try:
            client.connect(host, rack, slot, port)
        except Exception as exc:
            try:
                client.destroy()
            except Exception:
                pass
            raise BridgeError(
                "S7 connect to %s:%s (rack %s, slot %s) failed: %s" % (host, port, rack, slot, exc),
                connection_lost=True,
            )
        self._client = client

    def read(self, address):
        client = self._require_client()
        parsed = parse_s7_address(address)
        from snap7 import util
        try:
            raw = client.db_read(parsed["db"], parsed["offset"], _S7_SIZES[parsed["kind"]])
        except Exception as exc:
            raise self._wrap(exc, "read of %r" % address)
        kind = parsed["kind"]
        if kind == "real":
            return _to_number(util.get_real(raw, 0), address)
        if kind == "int":
            return _to_number(util.get_int(raw, 0), address)
        if kind == "dint":
            return _to_number(util.get_dint(raw, 0), address)
        if kind == "word":
            return _to_number(util.get_word(raw, 0), address)
        return _to_number(util.get_bool(raw, 0, parsed["bit"]), address)

    def write(self, address, value):
        client = self._require_client()
        parsed = parse_s7_address(address)
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise BridgeError("Cannot write non-numeric value %r to %r" % (value, address))
        from snap7 import util
        kind = parsed["kind"]
        try:
            if kind == "bool":
                # Read-modify-write of the containing byte. A protocol-level
                # single-bit write (Cli_WriteArea with S7WLBit) would be atomic
                # on a real CPU, but the snap7 demo server — which this project
                # explicitly supports as a dev/CI simulator — mishandles it and
                # replaces the WHOLE byte (verified: sibling bits get cleared).
                # Cross-process write races on sibling bits are instead closed
                # by the Node write route, which serializes writes per
                # connection (see routes/plcBindings.js). Residual: writers
                # outside this backend instance can still race the RMW window.
                raw = client.db_read(parsed["db"], parsed["offset"], 1)
                util.set_bool(raw, 0, parsed["bit"], bool(num))
                client.db_write(parsed["db"], parsed["offset"], raw)
                return
            buf = bytearray(_S7_SIZES[kind])
            if kind == "real":
                util.set_real(buf, 0, num)
            elif kind == "int":
                util.set_int(buf, 0, int(round(num)))
            elif kind == "dint":
                util.set_dint(buf, 0, int(round(num)))
            else:  # word
                # snap7.util raises struct.error for out-of-range int/dint;
                # WORD must reject too instead of masking to a wrapped value
                # (silent command corruption on the device).
                v = int(round(num))
                if not 0 <= v <= 0xFFFF:
                    raise BridgeError(
                        "value %r out of range for WORD (0..65535) at %r" % (num, address))
                util.set_word(buf, 0, v)
            client.db_write(parsed["db"], parsed["offset"], buf)
        except BridgeError:
            raise
        except Exception as exc:
            raise self._wrap(exc, "write of %r" % address)

    def disconnect(self):
        client, self._client = self._client, None
        if client is not None:
            try:
                client.disconnect()
            except Exception:
                pass
            try:
                client.destroy()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Allen-Bradley EtherNet/IP (pycomm3)
# ---------------------------------------------------------------------------

class EthernetIpHandler:
    protocol = "ethernet_ip"

    def __init__(self):
        self._driver = None

    @staticmethod
    def probe():
        try:
            import pycomm3  # noqa: F401
        except ImportError:
            return {
                "available": False,
                "reason": "Python package 'pycomm3' not installed — " + PIP_HINT,
            }
        except Exception as exc:
            return {"available": False, "reason": "pycomm3 failed to import: %s" % exc}
        return {"available": True}

    @staticmethod
    def _is_connection_error(exc):
        try:
            from pycomm3.exceptions import CommError
            if isinstance(exc, CommError):
                return True
        except ImportError:
            pass
        if isinstance(exc, (ConnectionError, OSError, TimeoutError)):
            return True
        msg = str(exc).lower()
        markers = ("connection", "socket", "timed out", "timeout", "refused", "reset")
        return any(m in msg for m in markers)

    def _wrap(self, exc, doing):
        if isinstance(exc, BridgeError):
            return exc
        return BridgeError("EtherNet/IP %s failed: %s" % (doing, exc),
                           connection_lost=self._is_connection_error(exc))

    def _require_driver(self):
        if self._driver is None:
            raise BridgeError("ethernet_ip: not connected — call connect first",
                              connection_lost=True)
        return self._driver

    def connect(self, config):
        try:
            from pycomm3 import LogixDriver
        except ImportError:
            raise BridgeError("Python package 'pycomm3' not installed — " + PIP_HINT)
        config = config or {}
        host = config.get("host")
        if not host or not isinstance(host, str):
            raise BridgeError("ethernet_ip config.host is required")
        slot = int(config.get("slot") or 0)
        path = "%s/%s" % (host, slot)
        try:
            driver = LogixDriver(path)
            driver.open()
        except Exception as exc:
            raise BridgeError("EtherNet/IP connect to %s failed: %s" % (path, exc),
                              connection_lost=True)
        self._driver = driver

    @staticmethod
    def _check_tag_result(result, address):
        if result is None:
            raise BridgeError("EtherNet/IP: no response for tag %r" % address)
        if getattr(result, "error", None):
            # Per-tag error string (unknown tag, type mismatch) -> tag-level.
            raise BridgeError("EtherNet/IP tag %r error: %s" % (address, result.error))

    def read(self, address):
        driver = self._require_driver()
        if not isinstance(address, str) or not address.strip():
            raise BridgeError("EtherNet/IP address must be a tag path string")
        try:
            result = driver.read(address.strip())
        except Exception as exc:
            raise self._wrap(exc, "read of %r" % address)
        self._check_tag_result(result, address)
        return _to_number(result.value, address)

    def write(self, address, value):
        driver = self._require_driver()
        if not isinstance(address, str) or not address.strip():
            raise BridgeError("EtherNet/IP address must be a tag path string")
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise BridgeError("Cannot write non-numeric value %r to %r" % (value, address))
        # Integral values are sent as int so integer tags (DINT/INT/BOOL) pack
        # correctly; REAL tags accept ints too. Non-integral stays float.
        coerced = int(round(num)) if float(num).is_integer() else num
        try:
            result = driver.write((address.strip(), coerced))
        except Exception as exc:
            raise self._wrap(exc, "write of %r" % address)
        self._check_tag_result(result, address)

    def disconnect(self):
        driver, self._driver = self._driver, None
        if driver is not None:
            try:
                driver.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Dispatch loop
# ---------------------------------------------------------------------------

HANDLER_TYPES = {
    "opcua": OpcuaHandler,
    "s7": S7Handler,
    "ethernet_ip": EthernetIpHandler,
}


def _handler_type(protocol):
    handler_type = HANDLER_TYPES.get(protocol)
    if handler_type is None:
        raise BridgeError("Unknown protocol %r — expected one of %s" % (protocol, list(HANDLER_TYPES)))
    return handler_type


def handle_request(req, connections):
    """Execute one request; returns the reply 'value'. Raises BridgeError."""
    op = req.get("op")
    protocol = req.get("protocol")

    if op == "ping":
        return "pong"

    if op == "probe":
        if protocol:
            return _handler_type(protocol).probe()
        return {p: HANDLER_TYPES[p].probe() for p in PROTOCOLS}

    if op == "test":
        handler = _handler_type(protocol)()
        start = time.monotonic()
        handler.connect(req.get("config"))
        latency_ms = int((time.monotonic() - start) * 1000)
        handler.disconnect()
        return {"latencyMs": latency_ms}

    if op == "connect":
        old = connections.pop(protocol, None)
        if old is not None:
            old.disconnect()
        handler = _handler_type(protocol)()
        handler.connect(req.get("config"))
        connections[protocol] = handler
        return True

    if op == "read":
        handler = connections.get(protocol)
        if handler is None:
            raise BridgeError("%s: not connected — call connect first" % protocol,
                              connection_lost=True)
        return handler.read(req.get("address"))

    if op == "write":
        handler = connections.get(protocol)
        if handler is None:
            raise BridgeError("%s: not connected — call connect first" % protocol,
                              connection_lost=True)
        handler.write(req.get("address"), req.get("value"))
        return True

    if op == "disconnect":
        handler = connections.pop(protocol, None)
        if handler is not None:
            handler.disconnect()
        return True

    raise BridgeError("Unknown op %r" % op)


def main():
    # Force UTF-8 stdio regardless of the platform locale: on Windows a piped
    # subprocess defaults to the ANSI code page (cp1252), so a UTF-8 request
    # containing a non-ASCII address/password would raise UnicodeDecodeError
    # (killing the child) or silently mojibake credentials. The Node side also
    # sets PYTHONUTF8=1; this is the in-process belt-and-braces.
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass

    connections = {}
    while True:
        line = sys.stdin.readline()
        if line == "":  # EOF — parent closed our stdin (or died)
            break
        line = line.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise BridgeError("Request must be a JSON object")
            req_id = req.get("id")
            value = handle_request(req, connections)
            reply = {"id": req_id, "ok": True, "value": value}
        except BridgeError as exc:
            reply = {"id": req_id, "ok": False, "error": str(exc),
                     "connectionLost": exc.connection_lost}
        except Exception as exc:  # never crash on a bad line
            reply = {"id": req_id, "ok": False,
                     "error": "%s: %s" % (type(exc).__name__, exc),
                     "connectionLost": False}

        try:
            # allow_nan=False backstop: _to_number already rejects non-finite
            # reads, but any handler slipping NaN/Infinity through must produce
            # a parseable tag-level error line, never invalid JSON (which the
            # Node side drops, turning it into a timeout + connection loss).
            try:
                out = json.dumps(reply, allow_nan=False)
            except ValueError:
                out = json.dumps({
                    "id": req_id, "ok": False,
                    "error": "Bridge produced a non-finite value in its reply",
                    "connectionLost": False,
                })
            sys.stdout.write(out + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError):
            break  # parent is gone

    for handler in connections.values():
        try:
            handler.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    main()
