# OPC Client Development Guide — Lessons Learned

> A reusable, project-agnostic guide for building OPC client applications using Node.js.
> Covers OPC DA (Classic COM/DCOM) and OPC UA (Unified Architecture).

---

## Table of Contents

1. [OPC DA vs OPC UA — When to Use Which](#1-opc-da-vs-opc-ua--when-to-use-which)
2. [Architecture Overview](#2-architecture-overview)
3. [OPC UA Client (node-opcua)](#3-opc-ua-client-node-opcua)
4. [OPC DA Client (PowerShell COM Bridge)](#4-opc-da-client-powershell-com-bridge)
5. [Server Discovery](#5-server-discovery)
6. [Connection Management](#6-connection-management)
7. [Tag Browsing](#7-tag-browsing)
8. [Reading and Writing Tags](#8-reading-and-writing-tags)
9. [DCOM Permission Setup (DA)](#9-dcom-permission-setup-da)
10. [REST API Design for OPC](#10-rest-api-design-for-opc)
11. [Frontend Integration](#11-frontend-integration)
12. [OPC Values in Simulation / Business Logic](#12-opc-values-in-simulation--business-logic)
13. [Rate Limiting and Polling](#13-rate-limiting-and-polling)
14. [Common Pitfalls and Solutions](#14-common-pitfalls-and-solutions)
15. [Testing with Simulation Servers](#15-testing-with-simulation-servers)
16. [Security Considerations](#16-security-considerations)

---

## 1. OPC DA vs OPC UA — When to Use Which

### OPC DA (Data Access) — Classic
- **Protocol**: COM/DCOM (Windows-only)
- **When**: Connecting to legacy industrial systems, PLCs, SCADA servers (Matrikon, Kepware, Siemens WinCC, RSLinx, etc.)
- **Pros**: Ubiquitous in older plants, most existing industrial software supports it
- **Cons**: Windows-only, requires DCOM configuration, 32-bit COM can be tricky in modern 64-bit environments
- **Use when**: The OPC server only supports DA, or you're working with established industrial infrastructure

### OPC UA (Unified Architecture) — Modern
- **Protocol**: TCP binary or HTTPS (cross-platform)
- **When**: New installations, modern PLCs/SCADA, cross-platform requirements
- **Pros**: Cross-platform, built-in security, structured data model, no DCOM headaches
- **Cons**: Fewer legacy servers support it, slightly more complex protocol
- **Use when**: The server supports UA, or you need cross-platform deployment

### Recommendation
Support **both protocols** in your application — let the user choose based on their plant infrastructure. Many sites are transitioning from DA to UA, so dual support future-proofs your application.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (React)                   │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Connection   │  │  Tag Browser │  │ Tag Table  │ │
│  │   Dialog     │  │  (Tree View) │  │ (Mappings) │ │
│  └──────┬──────┘  └──────┬───────┘  └─────┬──────┘ │
│         │                │                 │        │
│         └────────┬───────┴────────┬────────┘        │
│                  │  Zustand Store  │                 │
│                  │  (OPC State)    │                 │
└──────────────────┼────────────────┼─────────────────┘
                   │   REST API     │
┌──────────────────┼────────────────┼─────────────────┐
│                  │   Express.js   │                  │
│            ┌─────┴───────────────┴─────┐            │
│            │     OPC Route Handler      │            │
│            │   /opc/* (UA)              │            │
│            │   /opc/da/* (DA)           │            │
│            └──────┬──────────┬──────────┘            │
│                   │          │                       │
│     ┌─────────────┴──┐  ┌───┴──────────────┐        │
│     │  opcClient.js  │  │  opcDaClient.js  │        │
│     │  (node-opcua)  │  │  (PS bridge mgr) │        │
│     └────────────────┘  └───────┬──────────┘        │
│                                 │ stdin/stdout JSON  │
│                        ┌────────┴──────────┐        │
│                        │ opc-da-bridge.ps1 │        │
│                        │ (32-bit PowerShell │        │
│                        │  COM interfaces)   │        │
│                        └───────────────────┘        │
└─────────────────────────────────────────────────────┘
```

**Key architectural decisions:**
1. **Separate client modules** for UA and DA — they have completely different protocols
2. **Long-lived PowerShell process** for DA — avoids COM init/teardown overhead on every call
3. **JSON-over-stdin/stdout** for DA bridge communication — simple, language-agnostic IPC
4. **REST API layer** normalizes both protocols into a uniform interface for the frontend
5. **Session caching** — one session per endpoint/server, reused across requests

---

## 3. OPC UA Client (node-opcua)

### Installation

```bash
npm install node-opcua
```

### Client Module Pattern

```javascript
'use strict';

const {
  OPCUAClient,
  MessageSecurityMode,
  SecurityPolicy,
  AttributeIds,
  DataType,
  NodeClass,
  StatusCodes,
  BrowseDirection,
  ReferenceTypeIds,
} = require('node-opcua');

// Session cache: one session per endpoint URL
const sessions = new Map();

async function connect(endpointUrl) {
  if (!endpointUrl) throw new Error('endpointUrl is required');

  // Reuse existing session
  const existing = sessions.get(endpointUrl);
  if (existing && existing.status === 'connected') {
    return { status: 'connected' };
  }

  const client = OPCUAClient.create({
    applicationName: 'MyOPCClient',
    connectionStrategy: {
      initialDelay: 1000,
      maxRetry: 3,
      maxDelay: 5000,
    },
    securityMode: MessageSecurityMode.None,   // Start with None, upgrade as needed
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false,                 // Important: allows connecting even
    requestedSessionTimeout: 60000,           // if endpoint isn't in discovery DB
  });

  try {
    await client.connect(endpointUrl);
    const session = await client.createSession();

    sessions.set(endpointUrl, { client, session, status: 'connected' });

    // Auto-detect disconnection
    client.on('close', () => {
      const entry = sessions.get(endpointUrl);
      if (entry) entry.status = 'disconnected';
    });

    return { status: 'connected' };
  } catch (err) {
    try { await client.disconnect(); } catch (_) {}
    sessions.delete(endpointUrl);
    throw new Error(`OPC connection failed: ${err.message}`);
  }
}

async function disconnect(endpointUrl) {
  const entry = sessions.get(endpointUrl);
  if (!entry) return;
  try {
    await entry.session.close();
    await entry.client.disconnect();
  } catch (_) {}
  sessions.delete(endpointUrl);
}

async function browse(endpointUrl, nodeId) {
  const entry = sessions.get(endpointUrl);
  if (!entry || entry.status !== 'connected') {
    throw new Error('Not connected');
  }

  const browseResult = await entry.session.browse({
    nodeId: nodeId || 'RootFolder',
    browseDirection: BrowseDirection.Forward,
    referenceTypeId: ReferenceTypeIds.HierarchicalReferences,
    includeSubtypes: true,
    nodeClassMask: 0,    // all node classes
    resultMask: 63,      // all fields
  });

  return (browseResult.references || []).map(ref => ({
    nodeId:      ref.nodeId?.toString() || '',
    browseName:  ref.browseName?.name || '',
    displayName: ref.displayName?.text || '',
    nodeClass:   NodeClass[ref.nodeClass] || String(ref.nodeClass),
    isFolder:    ref.nodeClass === NodeClass.Object || ref.nodeClass === NodeClass.View,
  }));
}

async function read(endpointUrl, tagIds) {
  const entry = sessions.get(endpointUrl);
  if (!entry || entry.status !== 'connected') throw new Error('Not connected');
  if (!tagIds?.length) return [];

  const nodesToRead = tagIds.map(tagId => ({
    nodeId: tagId,
    attributeId: AttributeIds.Value,
  }));

  const dataValues = await entry.session.read(nodesToRead);

  return tagIds.map((tagId, i) => {
    const dv = dataValues[i];
    return {
      tagId,
      value:      dv?.value?.value ?? null,
      dataType:   DataType[dv?.value?.dataType] || 'Unknown',
      timestamp:  dv?.serverTimestamp?.toISOString() || new Date().toISOString(),
      statusCode: dv?.statusCode?.name || 'Unknown',
      isGood:     dv?.statusCode?.equals(StatusCodes.Good) || false,
    };
  });
}

async function write(endpointUrl, tags) {
  const entry = sessions.get(endpointUrl);
  if (!entry || entry.status !== 'connected') throw new Error('Not connected');
  if (!tags?.length) return [];

  const results = [];
  for (const tag of tags) {
    try {
      const statusCode = await entry.session.write({
        nodeId: tag.tagId,
        attributeId: AttributeIds.Value,
        value: {
          value: {
            dataType: guessDataType(tag.value),
            value: tag.value,
          },
        },
      });
      results.push({
        tagId: tag.tagId,
        statusCode: statusCode?.name || 'Unknown',
        isGood: statusCode?.equals(StatusCodes.Good) || false,
      });
    } catch (err) {
      results.push({
        tagId: tag.tagId,
        statusCode: 'BadWriteFailed',
        isGood: false,
        error: err.message,
      });
    }
  }
  return results;
}

function guessDataType(value) {
  if (typeof value === 'boolean') return DataType.Boolean;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? DataType.Int32 : DataType.Double;
  }
  if (typeof value === 'string') return DataType.String;
  return DataType.Variant;
}

// Cleanup on exit
async function disconnectAll() {
  for (const [url] of sessions) {
    try { await disconnect(url); } catch (_) {}
  }
}
process.on('SIGINT', disconnectAll);
process.on('SIGTERM', disconnectAll);

module.exports = { connect, disconnect, browse, read, write, disconnectAll };
```

### Key Lessons — OPC UA

1. **`endpointMustExist: false`** — Without this, the client rejects endpoints not found during discovery. Many servers work fine without being in the discovery database.

2. **Session caching** — Creating OPC UA sessions is expensive (TLS handshake, authentication). Cache by endpoint URL and reuse.

3. **`client.on('close')` handler** — Detect server-side disconnections so you can update status and trigger reconnection.

4. **Write operations are per-item** — Unlike bulk reads, writes may need to be sent individually if you need per-tag error reporting.

5. **Data type guessing** — When writing, you often don't know the server's expected type. `guessDataType()` covers the common cases. For production, read the node's DataType attribute first.

6. **Discovery with `findServers()`** — This can fail on some servers. Always fall back to `getEndpoints()` which is more universally supported.

---

## 4. OPC DA Client (PowerShell COM Bridge)

### Why PowerShell?

OPC DA is a COM/DCOM standard from the 1990s. There is **no native Node.js library** that reliably implements OPC DA COM interfaces. The options are:

1. **node-dcom / node-opc-da** — abandoned, unreliable, missing features
2. **C++ addon** — complex build toolchain, version-specific
3. **PowerShell COM bridge** — reliable, uses .NET's built-in COM interop, well-documented

**The PowerShell bridge approach won.** It's the most maintainable and reliable solution.

### Architecture: Long-Lived Process with JSON IPC

```
Node.js (opcDaClient.js)
  │
  │ spawn 32-bit PowerShell
  │
  ├──stdin──→  { id: 1, action: "connect", clsid: "...", key: "..." }
  │
  ├──stdout←── { id: 1, result: { status: "connected" } }
  │
  ├──stdin──→  { id: 2, action: "read", key: "...", tagIds: [...] }
  │
  └──stdout←── { id: 2, result: { values: [...] } }
```

**Why long-lived instead of one-shot?**
- COM initialization (`Activator.CreateInstance`) takes ~500ms per server
- Group creation/teardown for reads adds latency
- A persistent process keeps the COM connection warm
- Polling (read every 5s) would be too slow with per-request process spawning

### The Bridge Manager (Node.js side)

```javascript
'use strict';

const { execFile, spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const BRIDGE_SCRIPT = path.join(__dirname, 'opc-da-bridge.ps1');
const PS32 = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';

let bridge = null;
let bridgeRL = null;
let bridgeReady = false;
let pendingCalls = new Map();   // id -> { resolve, reject, timer }
let nextId = 1;

function ensureBridge() {
  if (bridge && !bridge.killed) return Promise.resolve();

  return new Promise((resolve, reject) => {
    bridge = spawn(PS32, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', BRIDGE_SCRIPT,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    bridge.on('error', (err) => {
      bridge = null;
      bridgeReady = false;
      reject(err);
    });

    bridge.on('exit', (code) => {
      bridge = null;
      bridgeReady = false;
      // Reject all pending calls
      for (const [id, entry] of pendingCalls) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Bridge process exited'));
      }
      pendingCalls.clear();
    });

    // Capture stderr for diagnostics
    bridge.stderr.on('data', (data) => {
      console.error('[OPC-DA] Bridge stderr:', data.toString().trim());
    });

    // Read JSON responses line by line
    bridgeRL = readline.createInterface({ input: bridge.stdout });
    bridgeRL.on('line', (line) => {
      line = line.trim();
      if (!line) return;

      let msg;
      try { msg = JSON.parse(line); }
      catch (e) { return; }  // ignore non-JSON output

      // Handle initial ready signal
      if (msg.id === 0 && msg.result?.ready) {
        bridgeReady = true;
        resolve();
        return;
      }

      // Route response to pending call
      const entry = pendingCalls.get(msg.id);
      if (entry) {
        pendingCalls.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
      }
    });

    // Startup timeout
    setTimeout(() => {
      if (!bridgeReady) {
        reject(new Error('Bridge startup timeout'));
        if (bridge) bridge.kill();
      }
    }, 30000);
  });
}

function callBridge(action, params, timeout = 30000) {
  return ensureBridge().then(() => {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`Bridge '${action}' timed out after ${timeout}ms`));
      }, timeout);

      pendingCalls.set(id, { resolve, reject, timer });
      bridge.stdin.write(JSON.stringify({ id, action, ...params }) + '\n');
    });
  });
}
```

### Key Lessons — PowerShell Bridge

1. **MUST use 32-bit PowerShell** — OPC DA COM objects are 32-bit. The path is:
   ```
   C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe
   ```
   (Yes, `SysWOW64` contains the 32-bit binaries — a confusing Windows naming convention.)

2. **Use `-NoProfile -NonInteractive`** — Prevents PowerShell from loading user profiles or waiting for input, which would hang the bridge.

3. **`windowsHide: true`** — Prevents a console window from flashing when the bridge starts.

4. **Line-based JSON protocol** — Each message is one JSON line. Use `readline` on the Node.js side and `[Console]::Out.WriteLine()` on the PowerShell side. Don't use `Write-Host` — it goes to stderr, not stdout.

5. **Timeout every call** — COM operations can hang indefinitely. Always wrap with a timeout (30s default, 60s for browse operations).

6. **Ready signal** — The bridge sends `{ id: 0, result: { ready: true, pid: N, bitness: 32 } }` when initialized. Wait for this before sending commands.

7. **Reject pending calls on exit** — If the bridge process dies unexpectedly, reject all pending promises so callers don't hang.

### The PowerShell Bridge (COM Side)

The bridge defines C# COM interfaces inline using `Add-Type`:

```powershell
# Core interfaces needed for OPC DA:
# - IOPCServer         — connect, create groups
# - IOPCBrowseServerAddressSpace — browse tag tree
# - IOPCItemMgt        — add items to groups
# - IOPCSyncIO         — read/write item values
```

**Critical COM interface GUIDs** (these are universal OPC DA standard GUIDs):

| Interface | GUID | Purpose |
|-----------|------|---------|
| IOPCServer | `39c13a4d-011e-11d0-9675-0020afd8adb3` | Server connection, group management |
| IOPCBrowseServerAddressSpace | `39c13a4f-011e-11d0-9675-0020afd8adb3` | Browse tag address space |
| IOPCItemMgt | `39c13a54-011e-11d0-9675-0020afd8adb3` | Add/remove items in groups |
| IOPCSyncIO | `39c13a52-011e-11d0-9675-0020afd8adb3` | Synchronous read/write |
| IEnumString | `00000101-0000-0000-C000-000000000046` | Enumerate browse results |

**Connection pattern:**
```csharp
// Connect using CLSID (not ProgID — CLSID is resolved beforehand)
Guid guid = new Guid(clsid);
Type type = Type.GetTypeFromCLSID(guid, true);
object comObj = Activator.CreateInstance(type);
IOPCServer server = (IOPCServer)comObj;
IOPCBrowseServerAddressSpace browser = (IOPCBrowseServerAddressSpace)comObj;
```

**Read pattern:**
```csharp
// 1. Create a temporary group
server.AddGroup("read_group", 1, 1000, 1, IntPtr.Zero, IntPtr.Zero, 0x0409,
    out groupHandle, out revisedRate, ref riid, out ppUnk);

// 2. Add items to the group
IOPCItemMgt itemMgt = (IOPCItemMgt)ppUnk;
itemMgt.AddItems(count, itemDefs, out ppResults, out ppErrors);

// 3. Read via SyncIO (source=2 means read from device, not cache)
IOPCSyncIO syncIO = (IOPCSyncIO)ppUnk;
syncIO.Read(2, count, serverHandles, out ppValues, out ppReadErrors);

// 4. Parse VARIANT results from unmanaged memory
// 5. Remove group when done
server.RemoveGroup(groupHandle, 1);
```

**Memory management is critical:**
- Every `IntPtr` returned by COM must be freed with `Marshal.FreeCoTaskMem()`
- VARIANTs must be cleared with `VariantClear()` (from `oleaut32.dll`)
- COM objects must be released with `Marshal.ReleaseComObject()`
- Failure to free memory causes slow leaks that crash the bridge after hours of polling

### Key COM/DCOM Structs

```csharp
// OPCITEMDEF — defines an item to add to a group
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct OPCITEMDEF {
    public string szAccessPath;
    public string szItemID;           // The tag name, e.g., "Bucket Brigade.Int1"
    public int bActive;               // 1 = active
    public uint hClient;
    public uint dwBlobSize;
    public IntPtr pBlob;
    public short vtRequestedDataType; // 0 = server's native type
    public short wReserved;
}

// OPCITEMRESULT — returned after adding items
[StructLayout(LayoutKind.Sequential)]
public struct OPCITEMRESULT {
    public uint hServer;              // Server handle — used for read/write
    public short vtCanonicalDataType;
    public short wReserved;
    public uint dwAccessRights;
    public uint dwBlobSize;
    public IntPtr pBlob;
}
```

---

## 5. Server Discovery

### OPC UA Discovery

```javascript
async function discoverServers(hostname) {
  const discoveryUrl = `opc.tcp://${hostname || 'localhost'}:4840`;

  const client = OPCUAClient.create({
    applicationName: 'Discovery',
    connectionStrategy: { initialDelay: 500, maxRetry: 1, maxDelay: 3000 },
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false,
    requestedSessionTimeout: 10000,
  });

  await client.connect(discoveryUrl);

  // Method 1: findServers() — returns all registered OPC UA servers
  const servers = await client.findServers();

  // Method 2: getEndpoints() — returns endpoints of this specific server
  const endpoints = await client.getEndpoints();

  await client.disconnect();
  return { servers, endpoints };
}
```

**Lessons:**
- `findServers()` may fail on some servers — always have a `getEndpoints()` fallback
- Default discovery port is **4840** for OPC UA
- Keep discovery timeout short (10s) — if the server isn't there, fail fast

### OPC DA Discovery (Three Methods)

DA discovery requires scanning the Windows registry for registered COM servers. Use three methods in order of reliability:

**Method 1 — OPCEnum COM component** (fastest, if OPC Foundation tools are installed):
```powershell
$opcEnum = New-Object -ComObject 'OPC.ServerList.1'
$enum = $opcEnum.GetEnumerator($catid)  # Enumerate by OPC DA category ID
```

**Method 2 — Direct ProgID probe** (works without OPCEnum):
```powershell
# Check for well-known OPC server ProgIDs in the registry
$knownProgIds = @(
    'Matrikon.OPC.Simulation.1',
    'Kepware.KEPServerEX.V6',
    'OPC.SimaticNET',
    'RSLinx OPC Server'
    # ... etc
)
foreach ($progId in $knownProgIds) {
    if (Test-Path "Registry::HKEY_CLASSES_ROOT\$progId\CLSID") {
        # Found a server
    }
}
```

**Method 3 — Registry CATID search** (slowest, catches non-standard servers):
```powershell
# Search all CLSIDs for OPC DA Implemented Categories
$catids = @(
    '{63D5F430-CFE4-11D1-B2C8-0060083BA1FB}',  # OPC DA 1.0
    '{63D5F432-CFE4-11D1-B2C8-0060083BA1FB}',  # OPC DA 2.0
    '{CC603642-66D7-48F1-B69A-B625E73652D7}'   # OPC DA 3.0
)
reg query "HKCR\CLSID" /s /f $catid /k
```

**Key DA Category IDs** (universal across all OPC DA servers):

| Version | CATID |
|---------|-------|
| OPC DA 1.0 | `{63D5F430-CFE4-11D1-B2C8-0060083BA1FB}` |
| OPC DA 2.0 | `{63D5F432-CFE4-11D1-B2C8-0060083BA1FB}` |
| OPC DA 3.0 | `{CC603642-66D7-48F1-B69A-B625E73652D7}` |

---

## 6. Connection Management

### Session Caching Pattern

```javascript
// UA: cache by endpoint URL
const sessions = new Map();  // endpointUrl -> { client, session, status }

// DA: cache by "address::progId" composite key
const key = `${address}::${progId}`;
```

### Reconnection Strategy

```javascript
// UA: detect disconnection via client event
client.on('close', () => {
  entry.status = 'disconnected';
});

// DA: bridge process exit handler
bridge.on('exit', () => {
  bridgeReady = false;
  // ensureBridge() will re-spawn on next call
});

// Frontend: status polling + auto-reconnect
const checkStatus = async () => {
  const { data } = await api.get('/opc/status', { params: { endpointUrl } });
  if (data.status !== 'connected') {
    set({ connStatus: 'disconnected' });
  }
};
```

### State Machine

```
disconnected ──connect()──→ connecting ──success──→ connected
     ↑                          │                       │
     │                       failure                 close/error
     │                          │                       │
     └──────────────────────────┴───────────────────────┘
```

### Cleanup on Process Exit

```javascript
// Always register cleanup handlers
process.on('SIGINT', disconnectAll);
process.on('SIGTERM', disconnectAll);

// For DA bridge:
process.on('exit', () => {
  if (bridge && !bridge.killed) {
    bridge.stdin.write(JSON.stringify({ id: 0, action: 'quit' }) + '\n');
    bridge.kill();
  }
});
```

---

## 7. Tag Browsing

### OPC UA Browse

UA servers expose a hierarchical namespace. Browse from `RootFolder` and follow `HierarchicalReferences`:

```javascript
const result = await session.browse({
  nodeId: 'RootFolder',  // or a specific nodeId
  browseDirection: BrowseDirection.Forward,
  referenceTypeId: ReferenceTypeIds.HierarchicalReferences,
  includeSubtypes: true,
  nodeClassMask: 0,
  resultMask: 63,
});
```

Nodes with `nodeClass === NodeClass.Object` or `NodeClass.View` are folders (expandable). Nodes with `NodeClass.Variable` are leaf tags (readable/writable).

### OPC DA Browse

DA uses a stateful cursor-based browsing model:

```csharp
// Navigate into a folder
browser.ChangeBrowsePosition(2, "FolderName");  // 2 = OPC_BROWSE_DOWN

// List branches (folders) at current level
browser.BrowseOPCItemIDs(1, "", 0, 0, out enumUnk);  // 1 = OPC_BRANCH

// List leaves (tags) at current level
browser.BrowseOPCItemIDs(2, "", 0, 0, out enumUnk);  // 2 = OPC_LEAF

// Get full item ID for a leaf
browser.GetItemID(leafName, out fullItemId);

// Navigate back up
browser.ChangeBrowsePosition(1, "");  // 1 = OPC_BROWSE_UP
```

**Recursive browse** for getting the entire tag tree:

```csharp
private void BrowseRecursive(List<BrowseItem> result, string currentPath, int depth) {
    if (depth > 10) return;  // Safety limit!

    // Get leaves at this level
    // ... (enumerate with BrowseOPCItemIDs type=2)

    // Get branches and recurse
    string[] branches = GetBranches();
    foreach (string branch in branches) {
        string subPath = currentPath == "" ? branch : currentPath + "." + branch;
        result.Add(new BrowseItem { IsFolder = true, ... });

        browser.ChangeBrowsePosition(2, branch);  // Down
        BrowseRecursive(result, subPath, depth + 1);
        browser.ChangeBrowsePosition(1, "");       // Up
    }
}
```

### Building a Tree from Flat Browse Results

The DA browse returns a flat list with `parentPath` properties. Build the tree client-side:

```javascript
function buildTree(nodes) {
  const folderMap = {};
  const roots = [];

  // First pass: create folder entries
  for (const n of nodes) {
    if (n.isFolder) {
      folderMap[n.itemID || n.name] = {
        id: n.itemID || n.name,
        name: n.name || n.itemID,
        isFolder: true,
        children: [],
      };
    }
  }

  // Second pass: attach to parents
  for (const n of nodes) {
    const entry = n.isFolder
      ? folderMap[n.itemID || n.name]
      : { id: n.itemID || n.name, name: n.name, isFolder: false };

    const parent = n.parentPath ? folderMap[n.parentPath] : null;
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }

  return roots;
}
```

---

## 8. Reading and Writing Tags

### Unified Response Format

Normalize both UA and DA responses to the same shape:

```javascript
// Read response (both protocols):
{
  tagId:      'Bucket Brigade.Int1',
  value:      42,
  timestamp:  '2025-01-15T10:30:00.000Z',
  isGood:     true,
  // UA-specific:
  dataType:   'Int32',
  statusCode: 'Good',
  // DA-specific:
  quality:    192,       // OPC quality bitmask
}

// Write response (both protocols):
{
  tagId:      'Bucket Brigade.Int1',
  statusCode: 'Good',
  isGood:     true,
}
```

### Quality Bitmask (DA)

DA uses a quality bitmask. The top 2 bits determine good/bad:
```
isGood = (quality & 0xC0) === 0xC0  // bits 7-6 both set = Good (192)
```

| Quality | Hex | Meaning |
|---------|-----|---------|
| Good | 0xC0 (192) | Value is reliable |
| Uncertain | 0x40 (64) | Value may not be accurate |
| Bad | 0x00 (0) | Value is unreliable |

### Batch Reading Best Practices

```javascript
// Good: batch multiple tags in one call
const values = await read(endpoint, ['Tag1', 'Tag2', 'Tag3']);

// Bad: individual calls per tag (slow, wastes resources)
for (const tag of tags) {
  const val = await read(endpoint, [tag]);
}
```

### Write Data Type Handling

For UA writes, you need to specify the data type. A simple heuristic works for most cases:

```javascript
function guessDataType(value) {
  if (typeof value === 'boolean') return DataType.Boolean;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? DataType.Int32 : DataType.Double;
  }
  if (typeof value === 'string') return DataType.String;
  return DataType.Variant;
}
```

For DA writes, the COM VARIANT type is handled automatically by the marshaller.

---

## 9. DCOM Permission Setup (DA)

This is the **single biggest pain point** when setting up OPC DA. Without proper DCOM permissions, connections will fail with `ACCESS_DENIED (0x80070005)` or similar.

### One-Time Setup Script

Run as Administrator:

```powershell
#Requires -RunAsAdministrator

$olePath = 'HKLM:\SOFTWARE\Microsoft\Ole'

# Step 1: Set authentication levels
Set-ItemProperty -Path $olePath -Name 'LegacyAuthenticationLevel' -Value 2 -Type DWord
# 2 = Connect (authenticate on connect only, not every call)

Set-ItemProperty -Path $olePath -Name 'LegacyImpersonationLevel' -Value 3 -Type DWord
# 3 = Impersonate (standard for OPC)

# Step 2: Add Everyone + ANONYMOUS LOGON to DCOM permissions
# ... (see full script in setup-dcom-permissions.ps1)

# Step 3: Enable DCOM
Set-ItemProperty -Path $olePath -Name 'EnableDCOM' -Value 'Y' -Type String
```

### Required SIDs

| SID | Name | Why Needed |
|-----|------|------------|
| S-1-1-0 | Everyone | General access |
| S-1-5-7 | ANONYMOUS LOGON | Required for cross-machine DCOM |
| S-1-5-4 | INTERACTIVE | For local COM clients |

### Access Masks

| Permission Type | Mask | Bits |
|-----------------|------|------|
| Launch Permission | 0x1F | Local Launch + Remote Launch + Local Activate + Remote Activate |
| Access Permission | 0x03 | Local Access + Remote Access |

### Per-Server Configuration

Some servers (like Matrikon) may need their AppID authentication level set to 1 (None):

```powershell
$appIdPath = "Registry::HKEY_CLASSES_ROOT\AppID\{server-guid}"
Set-ItemProperty -Path $appIdPath -Name 'AuthenticationLevel' -Value 1 -Type DWord
```

### Troubleshooting DCOM

If DCOM issues persist:
1. Open `dcomcnfg.exe` → Component Services → Computers → My Computer → Properties
2. Check "Default Properties" tab: DCOM enabled, Authentication = Connect, Impersonation = Identify
3. Check "COM Security" tab: Launch/Access permissions include appropriate users
4. Check the specific OPC server under "DCOM Config": Identity = "The Interactive User" or "This User"
5. Check Windows Firewall: Allow DCOM traffic (TCP port 135 + dynamic ports)

---

## 10. REST API Design for OPC

### Route Structure

```
POST /opc/discover          — discover UA servers
POST /opc/connect           — connect to UA server
POST /opc/disconnect        — disconnect from UA server
POST /opc/browse            — browse UA namespace
POST /opc/read              — read UA tags
POST /opc/write             — write UA tags
GET  /opc/status            — get UA connection status

POST /opc/da/discover       — discover DA servers (registry)
POST /opc/da/connect        — connect to DA server
POST /opc/da/disconnect     — disconnect from DA server
POST /opc/da/browse         — browse DA tag tree
POST /opc/da/read           — read DA tags
POST /opc/da/write          — write DA tags
GET  /opc/da/status         — get DA connection status
```

### Express Route Pattern

```javascript
const { Router } = require('express');
const opcClient = require('../opc/opcClient');      // UA
const opcDaClient = require('../opc/opcDaClient');  // DA
const router = Router();

router.post('/read', async (req, res) => {
  try {
    const { endpointUrl, tagIds } = req.body;
    if (!endpointUrl) return res.status(400).json({ error: 'endpointUrl required' });
    if (!tagIds?.length) return res.status(400).json({ error: 'tagIds array required' });

    const values = await opcClient.read(endpointUrl, tagIds);
    res.json({ values });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

### Input Validation Checklist

Always validate:
- `endpointUrl` or `progId` present
- `tagIds` is a non-empty array (for read)
- `tags` is a non-empty array of `{ tagId, value }` (for write)

---

## 11. Frontend Integration

### State Management (Zustand)

Use a global store for OPC connection state shared across components:

```javascript
import { create } from 'zustand';

const useOpcStore = create((set, get) => ({
  protocol:     'da',               // 'da' | 'ua'
  endpointUrl:  '',                 // UA endpoint
  daServer:     null,               // { progId, clsid, name, address }
  connStatus:   'disconnected',     // 'disconnected' | 'connecting' | 'connected' | 'error'
  connError:    null,

  discoveryHost:     'localhost',
  discoveredServers: [],
  discovering:       false,

  connect: async () => { /* ... */ },
  disconnect: async () => { /* ... */ },
  discover: async () => { /* ... */ },
  checkStatus: async () => { /* ... */ },

  // Hydrate from saved node params (restore state on page load)
  hydrateFromNode: (params) => {
    if (!params) return;
    if (params.protocol) set({ protocol: params.protocol });
    if (params.endpointUrl) set({ endpointUrl: params.endpointUrl });
    if (params.daServer) set({ daServer: params.daServer });
  },
}));
```

### Polling Architecture

For live OPC values, poll the read endpoint at a fixed interval:

```javascript
useEffect(() => {
  if (connStatus !== 'connected' || readTagIds.length === 0) return;

  const poll = async () => {
    const route = protocol === 'da' ? '/opc/da/read' : '/opc/read';
    const body = protocol === 'da'
      ? { progId: daServer.progId, address: daServer.address, tagIds }
      : { endpointUrl, tagIds };

    const { data } = await api.post(route, body);
    // Update tag values in state
    updateRowsWithOpcValues(data.values);
  };

  const timer = setInterval(poll, 5000);  // 5-second polling interval
  poll();  // immediate first read

  return () => clearInterval(timer);
}, [connStatus, readTagIds]);
```

### Tag Mapping Table UI Pattern

A tag mapping table maps OPC server tags to application variables:

| Direction | OPC Tag | Application Variable | OPC Value | App Value |
|-----------|---------|---------------------|-----------|-----------|
| READ | Bucket Brigade.Int1 | Q (Flow) | 1250.5 | 1250.5 |
| READ | Random.Real4 | TSS | 180.3 | 180.3 |
| WRITE | Bucket Brigade.Int2 | effluent_BOD | — | 12.5 |

**Key behaviors:**
- READ rows: OPC value overrides application value (shown with visual indicator)
- WRITE rows: Application value is written to OPC tag
- Both: Display live OPC values via polling
- "Update Mappings" button: Immediately persist mappings and push OPC values to application state

---

## 12. OPC Values in Simulation / Business Logic

When OPC provides live values, they should **override** any internally stored or calculated values.

### Override Pattern

```javascript
// Collect OPC overrides from opc_read nodes
function collectOpcOverrides(nodes, nodeParams) {
  const overrides = {};
  const VALID_VARS = new Set(['Q', 'TSS', 'BOD', 'COD', 'TN', 'NH4', 'TP', 'DO', 'pH']);

  for (const node of nodes) {
    if (node.type !== 'opc_read') continue;
    const mappings = nodeParams[node.id]?.tagMappings || [];
    for (const m of mappings) {
      if (!m.streamVar || !VALID_VARS.has(m.streamVar)) continue;
      if (m.lastValue == null) continue;
      const val = Number(m.lastValue);
      if (!isNaN(val)) overrides[m.streamVar] = val;
    }
  }
  return overrides;
}

// Apply overrides to inlet/source node parameters
const opcOverrides = collectOpcOverrides(nodes, nodeParams);
if (Object.keys(opcOverrides).length > 0) {
  for (const node of sourceNodes) {
    nodeParams[node.id] = { ...nodeParams[node.id], ...opcOverrides };
  }
}
```

### Dynamic/Time-Series Simulation

When running diurnal (time-varying) simulations with OPC overrides, the OPC values should **skip scaling**:

```javascript
// Without OPC: apply diurnal scaling
Q = baseQ * profile[hour].Q_scale;

// With OPC: use live value directly (no scaling)
Q = opcOverrides.Q ?? (baseQ * profile[hour].Q_scale);
```

The `??` (nullish coalescing) operator is perfect here — if OPC has a value, use it; otherwise fall back to the scaled value.

### Immediate Persistence

After reading OPC values, immediately persist them to the application's data store:

```javascript
// After successful OPC read poll:
for (const mapping of tagMappings) {
  if (mapping.lastValue != null && mapping.targetNodeId && mapping.streamVar) {
    // Push OPC value directly to the target node's parameters
    updateNodeParam(mapping.targetNodeId, mapping.streamVar, mapping.lastValue);
  }
}
```

This ensures that if simulation runs between polls, it uses the most recent OPC data.

---

## 13. Rate Limiting and Polling

### The Problem

OPC polling (every 5 seconds) generates many requests. A standard rate limiter (e.g., 500 requests/15 min) will quickly exhaust its budget, blocking legitimate user interactions.

### Solution: Separate Rate Limiters

```javascript
const rateLimit = require('express-rate-limit');

// Global rate limiter — excludes OPC routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  skip: (req) => req.path.startsWith('/opc'),
});

// OPC-specific rate limiter — much higher limit
const opcLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,  // 5000 requests per 15 min
});

app.use(globalLimiter);
app.use('/opc', opcLimiter, opcRoutes);
```

### Polling Interval Guidelines

| Use Case | Interval | Rationale |
|----------|----------|-----------|
| Dashboard display | 5-10s | Human-visible updates |
| Live simulation input | 2-5s | Balance between freshness and load |
| Data logging | 1-60s | Depends on process dynamics |
| Alarm monitoring | 1-2s | Fast detection needed |

---

## 14. Common Pitfalls and Solutions

### 1. "Class not registered" (0x80040154)
**Cause:** Wrong bitness — trying to load 32-bit COM object from 64-bit process.
**Fix:** Use 32-bit PowerShell: `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`

### 2. "Access denied" (0x80070005)
**Cause:** DCOM permissions not configured.
**Fix:** Run the DCOM setup script as Administrator (see Section 9).

### 3. Bridge process hangs on startup
**Cause:** `-NonInteractive` flag missing, or PowerShell loading user profile.
**Fix:** Always use `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.

### 4. Memory leak in DA bridge
**Cause:** Not freeing COM memory (IntPtr results, VARIANTs).
**Fix:** Every `IntPtr` from `AddItems`, `Read`, or `Write` must be freed with `Marshal.FreeCoTaskMem()`. VARIANTs must use `VariantClear()`.

### 5. Rate limit exhaustion
**Cause:** OPC polling counted against global rate limiter.
**Fix:** Use separate rate limiter for OPC routes with higher limits (see Section 13).

### 6. "Not connected" errors after server restart
**Cause:** Session cache still says "connected" but the actual TCP/COM connection is dead.
**Fix:** Implement status checking and auto-reconnection. For UA, listen to `client.on('close')`. For DA, the bridge's `callBridge()` will fail and `ensureBridge()` will re-spawn.

### 7. Browse timeout on large servers
**Cause:** Recursive browse of thousands of tags takes too long.
**Fix:** Increase browse timeout (60s+), add depth limit (10 levels max), consider lazy browsing (one level at a time).

### 8. PowerShell bridge non-JSON output
**Cause:** PowerShell error messages or Write-Host output mixed with JSON responses.
**Fix:** Capture stderr separately. Ignore non-JSON lines in stdout parser. Use `[Console]::Out.WriteLine()` for JSON, never `Write-Host`.

### 9. stale OPC values in simulation
**Cause:** OPC values stored but not pushed to application parameters between polls.
**Fix:** After each poll, immediately persist `lastValue` to the target parameter (bypassing any debounce on auto-save).

### 10. VARIANT parsing errors on 64-bit
**Cause:** OPCITEMSTATE struct layout differs between 32-bit and 64-bit.
**Fix:** The bridge MUST run in 32-bit. The struct size is 32 bytes in 32-bit, 40 bytes in 64-bit. Check `IntPtr.Size` and adjust.

---

## 15. Testing with Simulation Servers

### Recommended Test Servers

| Server | Protocol | Platform | Notes |
|--------|----------|----------|-------|
| **Matrikon OPC Simulation Server** | DA | Windows | Free, most popular for DA testing |
| **Prosys OPC UA Simulation Server** | UA | Cross-platform | Free version available |
| **Unified Automation UaExpert** | UA | Cross-platform | Free client/server for testing |
| **Kepware KEPServerEX** | DA + UA | Windows | Commercial, free demo |

### Matrikon Setup for DA Testing

1. Install Matrikon OPC Simulation Server
2. Run DCOM setup script (Section 9)
3. Start the Matrikon service
4. Connect using ProgID: `Matrikon.OPC.Simulation.1`
5. Default tags: `Bucket Brigade.Int1`, `Random.Real4`, `Saw-toothed Waves.Real8`, etc.

### Verifying Your Setup

```bash
# 1. Check if OPC server is registered
powershell -Command "Test-Path 'Registry::HKEY_CLASSES_ROOT\Matrikon.OPC.Simulation.1\CLSID'"

# 2. Get CLSID
powershell -Command "(Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\Matrikon.OPC.Simulation.1\CLSID').'(default)'"

# 3. Test discovery via your API
curl -X POST http://localhost:3001/api/opc/da/discover -H "Content-Type: application/json" -d '{"hostname":"localhost"}'

# 4. Test connection
curl -X POST http://localhost:3001/api/opc/da/connect -H "Content-Type: application/json" -d '{"progId":"Matrikon.OPC.Simulation.1"}'

# 5. Test read
curl -X POST http://localhost:3001/api/opc/da/read -H "Content-Type: application/json" -d '{"progId":"Matrikon.OPC.Simulation.1","tagIds":["Bucket Brigade.Int1"]}'
```

---

## 16. Security Considerations

### OPC UA Security
- Start with `SecurityMode.None` / `SecurityPolicy.None` for development
- For production: use `SignAndEncrypt` with `Basic256Sha256` or higher
- Store certificates in a secure location
- Implement user authentication (username/password or certificate-based)

### OPC DA Security
- DCOM permissions should be tightened for production (don't leave "Everyone" with full access)
- Use specific Windows user accounts for OPC access
- Consider Windows Firewall rules for DCOM ports
- DCOM credentials should never be hard-coded — use environment variables or secure config

### General
- Never expose OPC endpoints directly to the internet
- Use HTTPS for your REST API layer
- Rate limit all OPC routes (Section 13)
- Log all OPC operations for audit trails
- Validate all tag IDs and values from user input before passing to OPC

---

## Appendix A: File Structure Template

```
project/
├── backend/
│   ├── src/
│   │   ├── opc/
│   │   │   ├── opcClient.js          # OPC UA client (node-opcua)
│   │   │   ├── opcDaClient.js         # OPC DA client (bridge manager)
│   │   │   └── opc-da-bridge.ps1      # PowerShell COM bridge (32-bit)
│   │   ├── routes/
│   │   │   └── opc.js                 # REST API routes (UA + DA)
│   │   └── server.js                  # Express server with rate limiters
│   └── scripts/
│       └── setup-dcom-permissions.ps1 # One-time DCOM setup
├── frontend/
│   ├── src/
│   │   ├── store/
│   │   │   └── opcStore.js            # Zustand OPC state
│   │   └── components/
│   │       ├── OpcConnectionDialog.jsx # Connect/disconnect UI
│   │       └── OpcTagTable.jsx         # Tag mapping table
│   └── ...
└── package.json
```

## Appendix B: npm Dependencies

```json
{
  "dependencies": {
    "node-opcua": "^2.x",
    "express": "^4.x",
    "express-rate-limit": "^7.x"
  }
}
```

Frontend (optional):
```json
{
  "dependencies": {
    "zustand": "^4.x",
    "axios": "^1.x",
    "react": "^18.x"
  }
}
```

## Appendix C: Quick Reference — COM Interface GUIDs

```
IOPCServer                    39c13a4d-011e-11d0-9675-0020afd8adb3
IOPCBrowseServerAddressSpace  39c13a4f-011e-11d0-9675-0020afd8adb3
IOPCItemMgt                   39c13a54-011e-11d0-9675-0020afd8adb3
IOPCSyncIO                    39c13a52-011e-11d0-9675-0020afd8adb3
IEnumString                   00000101-0000-0000-C000-000000000046

OPC DA 1.0 Category           63D5F430-CFE4-11D1-B2C8-0060083BA1FB
OPC DA 2.0 Category           63D5F432-CFE4-11D1-B2C8-0060083BA1FB
OPC DA 3.0 Category           CC603642-66D7-48F1-B69A-B625E73652D7
```

---

*Document generated from real-world implementation experience. All code patterns have been tested in production with Matrikon OPC Simulation Server (DA) and Prosys UA Simulation Server (UA).*
