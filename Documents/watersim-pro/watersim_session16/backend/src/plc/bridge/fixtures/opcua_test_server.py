#!/usr/bin/env python3
"""Test fixture: minimal asyncua OPC UA server for plcDrivers.test.js.

Serves opc.tcp://127.0.0.1:48400 with one writable Double at ns=2;s=TestVar,
preset to 42.5. Prints READY on stdout once accepting connections, then runs
until killed.
"""

import asyncio
import sys

from asyncua import Server, ua

ENDPOINT = "opc.tcp://127.0.0.1:48400"


async def main():
    server = Server()
    await server.init()
    server.set_endpoint(ENDPOINT)
    server.set_server_name("WaterSim PLC bridge test server")

    idx = await server.register_namespace("urn:watersim:plc-bridge-test")
    if idx != 2:
        print("FATAL: expected namespace index 2, got %s" % idx, file=sys.stderr, flush=True)
        sys.exit(1)

    node = await server.nodes.objects.add_variable(
        ua.NodeId("TestVar", idx), "TestVar", 42.5, varianttype=ua.VariantType.Double
    )
    await node.set_writable()

    async with server:
        print("READY", flush=True)
        while True:
            await asyncio.sleep(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
