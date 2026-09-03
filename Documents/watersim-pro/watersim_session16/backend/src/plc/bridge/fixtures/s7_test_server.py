#!/usr/bin/env python3
"""Test fixture: snap7 demo S7 server for plcDrivers.test.js.

Listens on port 10102 with DB 1 registered (128 bytes) and preset values:
    db1.real0    = 123.25   (REAL,  bytes 0-3)
    db1.int4     = 1234     (INT,   bytes 4-5)
    db1.bool6.3  = 1        (bit 3 of byte 6)
    db1.dint8    = -56789   (DINT,  bytes 8-11)
    db1.word12   = 65500    (WORD,  bytes 12-13)

Prints READY on stdout once started, then runs until killed.
"""

import ctypes
import struct
import time

from snap7.server import Server
from snap7.type import SrvArea

PORT = 10102

# Module-level so the buffer registered with the server is never GC'd.
DB1 = (ctypes.c_uint8 * 128)()
struct.pack_into(">f", DB1, 0, 123.25)
struct.pack_into(">h", DB1, 4, 1234)
DB1[6] = 0b00001000  # bit 3 of byte 6
struct.pack_into(">i", DB1, 8, -56789)
struct.pack_into(">H", DB1, 12, 65500)


def main():
    server = Server()
    server.register_area(SrvArea.DB, 1, DB1)
    server.start(tcp_port=PORT)
    print("READY", flush=True)
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.stop()
            server.destroy()
        except Exception:
            pass


if __name__ == "__main__":
    main()
