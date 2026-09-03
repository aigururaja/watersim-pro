#!/usr/bin/env python3
"""Test fixture: bridge that hangs on demand, for bridgeClient timeout tests.

Speaks the same JSON-line protocol as plc_bridge.py but:
    op "sleep" -> blocks for `seconds` (default 10) before replying, so the
                  Node-side request timeout fires first and kills us
    anything else -> immediate {"ok": true, "value": "pong"}
"""

import json
import sys
import time


def main():
    while True:
        line = sys.stdin.readline()
        if line == "":
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        if req.get("op") == "sleep":
            time.sleep(float(req.get("seconds", 10)))
            reply = {"id": req.get("id"), "ok": True, "value": "slept"}
        else:
            reply = {"id": req.get("id"), "ok": True, "value": "pong"}
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
