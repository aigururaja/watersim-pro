# OPC Server Integration — Lessons Learned Document

**Project:** WaterSim Pro
**Date:** February 2026
**Scope:** Full OPC DA (Data Access) integration from scratch — server discovery, connection, tag browsing, read/write operations, live polling, and UI

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Failed Approaches and Why They Failed](#2-failed-approaches-and-why-they-failed)
3. [The Working Solution — PowerShell COM Bridge](#3-the-working-solution--powershell-com-bridge)
4. [Architecture Overview](#4-architecture-overview)
5. [Backend Implementation](#5-backend-implementation)
6. [Frontend Implementation](#6-frontend-implementation)
7. [Bugs Encountered and Fixes Applied](#7-bugs-encountered-and-fixes-applied)
8. [JWT Token and Auto-Refresh Fix](#8-jwt-token-and-auto-refresh-fix)
9. [The Right Working Approach — Step by Step](#9-the-right-working-approach--step-by-step)
10. [Error Reference Table](#10-error-reference-table)
11. [Key Takeaways](#11-key-takeaways)

---

## 1. Executive Summary

Integrating OPC DA (classic COM/DCOM) with a Node.js web application is uniquely challenging because OPC DA is a Windows-only COM protocol from the 1990s, while Node.js is a modern cross-platform runtime. After multiple failed attempts using JavaScript DCOM libraries, the final working solution uses a **long-lived 32-bit PowerShell process** that communicates with Node.js via JSON over stdin/stdout, using **raw COM interface definitions** written in C#.

**What works:** PowerShell COM Bridge (`opc-da-bridge.ps1`) spawned by Node.js (`opcDaClient.js`), with a React frontend using Zustand for global state and portal-based dropdowns.

**What does NOT work:** `node-opc-da`, `node-opc-da-fix`, `node-dcom-fix`, `OPCDAAuto.dll` (without admin registration), any Node.js DCOM library with Node.js v24+ (OpenSSL 3.5 incompatibility).

---

## 2. Failed Approaches and Why They Failed

### 2.1 — `node-opc-da` (Pure JavaScript DCOM)

**What it is:** A pure JavaScript implementation of DCOM protocol for OPC DA.

**Why it failed:**
- Module import errors (`Cannot find module 'node-opc-da/src/dcom'`) — package structure was different from documented
- Depended on `node-dcom` which had a **missing `require` for `Encdec`** class in `ntlmauthentication.js`
- After patching: `src.readUInt16LE is not a function` — NTLM authentication code passed arrays where Buffers were expected
- After more patching: NTLM Type3 response serialization completely broken

**Lesson:** Pure JS DCOM implementations are fundamentally unreliable for production use. The DCOM/NTLM handshake is extremely complex and these community libraries never got it right.

### 2.2 — `node-opc-da-fix` (Community Fork)

**What it is:** Community fork of `node-opc-da` that patches some bugs.

**Why it failed:**
- Same underlying `node-dcom-fix` dependency with same NTLM bugs
- After patching NTLM: `error:0308010C:digital envelope routines::unsupported` — Node.js v24 ships OpenSSL 3.5 which **dropped MD4 and DES-ECB** algorithms required by NTLM
- Even with `--openssl-legacy-provider` flag and custom pure-JS crypto fallbacks, connection returned `DCOM error 5: ACCESS_DENIED`

**Root cause of ACCESS_DENIED:** These libraries connect via TCP DCOM with NTLM authentication. The password hash was being sent empty due to crypto failures. PowerShell bypasses this entirely because it uses the local COM subsystem with the user's native Windows security token — no TCP DCOM or NTLM needed.

**Lesson:** Node.js DCOM libraries cannot work with modern Node.js (v18+) for NTLM authentication. The crypto algorithms they need are deprecated.

### 2.3 — `OPCDAAuto.dll` (COM Automation Wrapper)

**What it is:** Microsoft/OPC Foundation COM automation DLL that wraps OPC DA interfaces for scripting languages.

**Why it failed:**
- The DLL is **32-bit only** (`C:\Program Files (x86)\Common Files\MatrikonOPC\Common\OPCDAAuto.dll`)
- 64-bit PowerShell cannot load it (`LoadLibrary` returned 0)
- Even with 32-bit PowerShell, the DLL needs **admin-level registration** (`regsvr32` requires writing to `HKLM`)
- Per-user HKCU registration attempted → `CLASS_E_CLASSNOTAVAILABLE (0x80040111)`
- DLL checks for TypeLib registration and HKLM-specific CLSID entries that per-user registration can't provide
- `TYPE_E_CANTLOADLIBRARY (0x80029C4A)` when trying to load embedded type library

**Lesson:** `OPCDAAuto.dll` requires full system-level admin registration. If you don't have admin privileges or can't guarantee the DLL is registered on every deployment machine, don't rely on it. Use raw COM interfaces instead.

---

## 3. The Working Solution — PowerShell COM Bridge

### Why PowerShell Works

PowerShell (32-bit) can create COM objects using `[Activator]::CreateInstance()` which goes through the local COM subsystem. This means:

- **No TCP DCOM** — connects through in-process COM, not network sockets
- **No NTLM authentication** — uses the running user's Windows security token
- **No DLL registration needed** — creates objects directly by CLSID using `Type.GetTypeFromCLSID()`
- **32-bit compatible** — uses `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe` for 32-bit COM objects

### Why C# COM Interop

Instead of relying on `OPCDAAuto.dll`, we define the OPC DA 2.0 COM interfaces directly in C# using `[ComImport]` attributes:

```csharp
[ComImport, Guid("39c13a4d-011e-11d0-9675-0020afd8adb3")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOPCServer {
    void AddGroup(...);
    void GetErrorString(...);
    void GetGroupByName(...);
    void GetStatus(...);
    void RemoveGroup(...);
    void CreateGroupEnumerator(...);
}
```

These GUIDs are part of the OPC DA 2.0 standard and are the same for ALL OPC DA servers. The C# code is compiled at runtime via PowerShell's `Add-Type`, so no separate compilation step is needed.

### Key Interfaces Used

| Interface | GUID | Purpose |
|-----------|------|---------|
| `IOPCServer` | `39c13a4d-011e-11d0-9675-0020afd8adb3` | Connection and group management |
| `IOPCBrowseServerAddressSpace` | `39c13a4f-011e-11d0-9675-0020afd8adb3` | Tag tree browsing |
| `IOPCItemMgt` | `39c13a54-011e-11d0-9675-0020afd8adb3` | Adding items to groups |
| `IOPCSyncIO` | `39c13a52-011e-11d0-9675-0020afd8adb3` | Synchronous read/write |
| `IEnumString` | `00000101-0000-0000-C000-000000000046` | Enumerating browse results |

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  FRONTEND (React + Vite)                                     │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────────┐  │
│  │ OpcConnectionDialog│  │ OpcTagTable                      │  │
│  │ (connect popup)   │  │ (8-col spreadsheet, read/write)  │  │
│  └────────┬─────────┘  └──────────────┬───────────────────┘  │
│           │                           │                      │
│           └───────────┬───────────────┘                      │
│                       ▼                                      │
│              ┌────────────────┐                               │
│              │  opcStore.js   │  (Zustand — global state)    │
│              └────────┬───────┘                               │
│                       ▼                                      │
│              ┌────────────────┐                               │
│              │   api.js       │  (Axios + JWT auto-refresh)  │
│              └────────┬───────┘                               │
└───────────────────────┼─────────────────────────────────────┘
                        │ HTTP REST
                        ▼
┌───────────────────────────────────────────────────────────────┐
│  BACKEND (Express.js)                                         │
│                                                               │
│  ┌────────────────┐   ┌──────────────────────────────────┐   │
│  │ routes/opc.js  │──▶│ opcDaClient.js                    │   │
│  │ (REST API)     │   │ (spawns & manages bridge process) │   │
│  └────────────────┘   └──────────────┬───────────────────┘   │
└──────────────────────────────────────┼───────────────────────┘
                                       │ JSON over stdin/stdout
                                       ▼
┌───────────────────────────────────────────────────────────────┐
│  POWERSHELL BRIDGE (32-bit process)                           │
│                                                               │
│  opc-da-bridge.ps1                                            │
│  ┌─────────────────────────────┐                              │
│  │ C# COM Interface Defs      │                              │
│  │ (IOPCServer, IOPCSyncIO..) │                              │
│  └─────────────┬───────────────┘                              │
│                │                                              │
│  ┌─────────────▼───────────────┐                              │
│  │ OpcDaSession class          │                              │
│  │ Connect / Browse / Read /   │                              │
│  │ Write / Dispose             │                              │
│  └─────────────┬───────────────┘                              │
│                │ COM                                          │
│                ▼                                              │
│  ┌─────────────────────────────┐                              │
│  │ OPC DA Server               │                              │
│  │ (e.g., Matrikon Simulation) │                              │
│  └─────────────────────────────┘                              │
└───────────────────────────────────────────────────────────────┘
```

### API Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/opc/da/discover` | Discover DA servers on a host (registry scan) |
| POST | `/opc/da/connect` | Connect to DA server by ProgID |
| POST | `/opc/da/disconnect` | Disconnect from DA server |
| POST | `/opc/da/browse` | Browse all tags in server tree |
| POST | `/opc/da/read` | Read tag values |
| POST | `/opc/da/write` | Write tag values |
| GET  | `/opc/da/status` | Check if DA session is alive |

---

## 5. Backend Implementation

### 5.1 — PowerShell Bridge (`opc-da-bridge.ps1`)

The bridge is a long-lived PowerShell process. It:
1. Compiles C# COM interface definitions via `Add-Type` on startup
2. Reads JSON commands from stdin line-by-line
3. Executes OPC operations using COM interop
4. Sends JSON responses to stdout
5. Maintains a `$sessions` hashtable for persistent connections

**Working code — Bridge main loop:**

```powershell
# Signal ready to Node.js
Send-Response 0 @{ ready = $true; pid = $PID; bitness = ([IntPtr]::Size * 8) } $null

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }  # stdin closed
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }

    try {
        $cmd = $line | ConvertFrom-Json
        Handle-Command $cmd
    } catch {
        try { Send-Response 0 $null "Parse error: $($_.Exception.Message)" } catch {}
    }
}
```

**Working code — Connect action:**

```powershell
'connect' {
    $clsid = $cmd.clsid
    $key = $cmd.key
    if ($sessions.ContainsKey($key)) {
        Send-Response $id @{ status = 'connected'; key = $key }
        return
    }
    $session = New-Object OpcDaSession
    $session.Key = $key
    $session.Connect($clsid)       # Activator.CreateInstance via CLSID
    $sessions[$key] = $session
    Send-Response $id @{ status = 'connected'; key = $key }
}
```

**Working code — C# Connect method:**

```csharp
public void Connect(string clsid) {
    Guid guid = new Guid(clsid);
    Type type = Type.GetTypeFromCLSID(guid, true);
    comObj = Activator.CreateInstance(type);
    server = (IOPCServer)comObj;
    browser = (IOPCBrowseServerAddressSpace)comObj;
}
```

### 5.2 — Node.js Client Manager (`opcDaClient.js`)

Spawns the bridge as a child process and communicates via JSON messages.

**Working code — Spawning the bridge:**

```javascript
const PS32 = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';

bridge = spawn(PS32, [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', BRIDGE_SCRIPT,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
```

**Key:** Must use `SysWOW64` PowerShell (32-bit) for 32-bit COM objects like Matrikon OPC.

**Working code — Calling the bridge:**

```javascript
function callBridge(action, params, timeout = 30000) {
  return ensureBridge().then(() => {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const cmd = { id, action, ...params };

      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`Bridge call '${action}' timed out after ${timeout}ms`));
      }, timeout);

      pendingCalls.set(id, { resolve, reject, timer });
      bridge.stdin.write(JSON.stringify(cmd) + '\n');
    });
  });
}
```

### 5.3 — Server Discovery (`discoverDaServers`)

Uses a 3-tier approach:

1. **OPCEnum COM component** (`OPC.ServerList.1`) — fastest, standard OPC Foundation tool
2. **Known ProgID probe** — checks registry for well-known OPC server ProgIDs (Matrikon, Kepware, Siemens, etc.)
3. **Registry CATID search** (`reg query HKCR\CLSID /s /f $catid`) — slower fallback, catches non-standard servers

**OPC DA Component Category IDs:**
```
{63D5F430-CFE4-11D1-B2C8-0060083BA1FB}  # OPC DA 1.0
{63D5F432-CFE4-11D1-B2C8-0060083BA1FB}  # OPC DA 2.0
{CC603642-66D7-48F1-B69A-B625E73652D7}  # OPC DA 3.0
```

### 5.4 — Read/Write Operations

Both read and write create temporary OPC groups, add items, perform the I/O operation, then clean up:

```csharp
// 1. Create temporary group
server.AddGroup("read_" + DateTime.Now.Ticks, 1, 1000, 1,
    IntPtr.Zero, IntPtr.Zero, 0x0409,
    out groupHandle, out revisedRate, ref riid, out ppUnk);

// 2. Add items by tag ID (e.g., "Bucket Brigade.Int1")
IOPCItemMgt itemMgt = (IOPCItemMgt)ppUnk;
itemMgt.AddItems((uint)count, defs, out ppResults, out ppErrors);

// 3. Read from device (dwSource=2 means read from device, not cache)
IOPCSyncIO syncIO = (IOPCSyncIO)ppUnk;
syncIO.Read(2, (uint)count, serverHandles, out ppValues, out ppReadErrors);

// 4. Parse VARIANT results
results[i].Value = Marshal.GetObjectForNativeVariant(pVariant);

// 5. Clean up
server.RemoveGroup(groupHandle, 1);
```

---

## 6. Frontend Implementation

### 6.1 — Global OPC Store (`opcStore.js`)

Zustand store holding connection state shared across all OPC components.

**Working code:**

```javascript
import { create } from 'zustand';
import api from '../utils/api';

const useOpcStore = create((set, get) => ({
  protocol:     'da',            // 'da' | 'ua'
  daServer:     null,            // { progId, clsid, name, address }
  connStatus:   'disconnected',  // 'disconnected' | 'connecting' | 'connected' | 'error'
  connError:    null,
  discoveryHost: 'localhost',
  discoveredServers: [],

  // Connect to OPC DA server
  connect: async () => {
    const { protocol, daServer, discoveryHost, daUser, daPassword } = get();
    set({ connStatus: 'connecting', connError: null });
    try {
      if (protocol === 'da') {
        if (!daServer?.progId) throw new Error('Select a DA server first');
        await api.post('/opc/da/connect', {
          progId: daServer.progId,
          address: daServer.address || discoveryHost || 'localhost',
          credentials: (daUser || daPassword)
            ? { user: daUser || undefined, password: daPassword || undefined }
            : undefined,
        });
      }
      set({ connStatus: 'connected' });
    } catch (err) {
      set({ connStatus: 'error', connError: err.response?.data?.error || err.message });
    }
  },

  // Check if backend session is still alive (called on page load)
  checkStatus: async () => {
    const { protocol, daServer } = get();
    try {
      if (protocol === 'da') {
        if (!daServer?.progId) return;
        const { data } = await api.get('/opc/da/status', {
          params: { progId: daServer.progId, address: daServer.address || 'localhost' },
        });
        set({ connStatus: data.status === 'connected' ? 'connected' : 'disconnected' });
      }
    } catch (_) { /* keep existing status */ }
  },

  // Called on 500 errors to auto-disconnect
  markDisconnected: (errorMsg) => {
    set({ connStatus: 'disconnected', connError: errorMsg || 'Session lost — reconnect to continue' });
  },

  // Restore connection info from saved flowsheet node params
  hydrateFromNode: (params) => {
    if (!params) return;
    const updates = {};
    if (params.protocol) updates.protocol = params.protocol;
    if (params.endpointUrl) updates.endpointUrl = params.endpointUrl;
    if (params.daServer) updates.daServer = params.daServer;
    set(updates);
  },
}));
```

### 6.2 — OPC Tag Table (`OpcTagTable.jsx`)

Spreadsheet-style component with separate Read from OPC and Write to OPC sections.

**Key pattern — Project Tags (all nodes x all stream variables):**

```javascript
const STREAM_VARS = [
  { key: 'Q',    label: 'Flow (Q)' },
  { key: 'TSS',  label: 'TSS' },
  { key: 'BOD',  label: 'BOD' },
  // ... 12 total
];

const projectTags = useMemo(() => {
  const tags = [];
  const nonOpcNodes = nodes.filter(n => {
    const op = n.data?.opType;
    return op && op !== 'opc_read' && op !== 'opc_write';
  });
  for (const node of nonOpcNodes) {
    for (const sv of STREAM_VARS) {
      tags.push({
        key: `${node.id}::${sv.key}`,
        label: `${node.data?.label || node.data?.opType} / ${sv.label}`,
        nodeId: node.id, streamVar: sv.key,
      });
    }
  }
  // Fallback: if no non-OPC nodes, show basic 12 stream vars
  if (nonOpcNodes.length === 0) {
    for (const sv of STREAM_VARS) {
      tags.push({ key: sv.key, label: sv.label, streamVar: sv.key });
    }
  }
  return tags;
}, [nodes]);
```

**Key pattern — Portal-based dropdown (escapes overflow clipping):**

```javascript
function TagDropdown({ items, loading, value, onSelect, onBrowse, onClose, placeholder, anchor }) {
  const [pos, setPos] = useState(null);

  // Calculate position using fixed coords from anchor element
  useLayoutEffect(() => {
    const el = anchor || ref.current?.parentElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const showAbove = spaceBelow < 260 && rect.top > 260;
    setPos({
      top: showAbove ? undefined : rect.bottom + 2,
      bottom: showAbove ? (window.innerHeight - rect.top + 2) : undefined,
      left: rect.left,
      width: Math.max(rect.width, 260),
    });
  }, [anchor]);

  // Render via portal to escape overflow:auto containers
  return ReactDOM.createPortal(
    <div ref={ref} style={{ position: 'fixed', zIndex: 9999, ...pos }}>
      {/* search input + filtered items list */}
    </div>,
    document.body
  );
}
```

**Key pattern — Read-to-Write value bridging:**

```javascript
const writeNow = useCallback(async () => {
  // Build a map: streamVar -> OPC-read value (from read rows)
  const readValueByStreamVar = {};
  for (const r of readRowsRef.current) {
    if (r.lastValue != null && r.projectTag) {
      const parts = r.projectTag.split('::');
      const sv = parts.length > 1 ? parts[1] : parts[0];
      if (sv) readValueByStreamVar[sv] = r.lastValue;
    }
  }

  const tags = [];
  for (const w of writeRowsRef.current) {
    if (!w.opcTag) continue;
    const parts = w.projectTag?.split('::');
    const sv = parts?.length > 1 ? parts[1] : parts?.[0];
    let raw;

    // Priority: manual override > OPC-read value > simulation value
    if (w.manualOverride && w.manualValue != null) {
      raw = w.manualValue;
    } else {
      raw = readValueByStreamVar[sv] ?? getProjectValue(w.projectTag);
    }

    const val = parseFloat(raw);
    if (!isNaN(val)) {
      tags.push({ tagId: w.opcTag, value: val });
    }
  }

  // Write to OPC DA server
  await api.post('/opc/da/write', { progId, address, tags });
}, [/* deps */]);
```

**Key pattern — Ref-based polling (prevents stale closures):**

```javascript
const readNowRef = useRef(readNow);
const writeNowRef = useRef(writeNow);
const busyRef = useRef(false);

// Update refs on every render (captures latest state)
readNowRef.current = readNow;
writeNowRef.current = writeNow;

// Polling interval reads from refs, not closures
useEffect(() => {
  if (!polling || connStatus !== 'connected') return;
  const id = setInterval(() => {
    if (busyRef.current) return;  // skip if previous tick still running
    readNowRef.current();
    writeNowRef.current();
  }, intervalSec * 1000);
  return () => clearInterval(id);
}, [polling, intervalSec, connStatus]);
```

### 6.3 — OPC Store Hydration on Page Load

```javascript
// In CanvasPage.jsx
useEffect(() => {
  const opcNode = nodes.find(
    n => n.data?.opType === 'opc_read' || n.data?.opType === 'opc_write'
  );
  if (opcNode?.data?.params) {
    useOpcStore.getState().hydrateFromNode(opcNode.data.params);
    useOpcStore.getState().checkStatus();
  }
}, [nodes.length]);
```

---

## 7. Bugs Encountered and Fixes Applied

### 7.1 — Empty Dropdowns (Overflow Clipping)

**Symptom:** Tag dropdowns appeared empty — no items visible when clicked.

**Root cause:** The `TagDropdown` component used `position: absolute` with `top: 100%` inside a table wrapper with `overflow: auto`. The dropdown was being rendered but immediately clipped by the scroll container's overflow boundary.

**Fix:** Changed to `ReactDOM.createPortal()` rendering at `document.body` level with `position: fixed` coordinates calculated from `getBoundingClientRect()`. This completely escapes all parent overflow containers.

**Before (broken):**
```javascript
// Rendered inside the table cell
<div style={{ position: 'absolute', top: '100%', left: 0 }}>
  {/* items */}
</div>
```

**After (working):**
```javascript
// Rendered via portal at document.body
return ReactDOM.createPortal(
  <div style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}>
    {/* items */}
  </div>,
  document.body
);
```

### 7.2 — Write Not Using OPC-Read Values

**Symptom:** When reading Q from OPC Int2 (value = 500) and writing Q to OPC Int4, Int4 received the simulation value (340) instead of the OPC-read value (500).

**Root cause:** The `writeNow()` function only looked at simulation results (`getProjectValue(w.projectTag)`) to determine what value to write. It didn't know about values being read from OPC on the read side.

**Fix:** Built a `readValueByStreamVar` lookup map in `writeNow()` that bridges OPC-read values to the write side:

```javascript
// In writeNow():
const readValueByStreamVar = {};
for (const r of readRowsRef.current) {
  if (r.lastValue != null && r.projectTag) {
    const parts = r.projectTag.split('::');
    const sv = parts.length > 1 ? parts[1] : parts[0];
    if (sv) readValueByStreamVar[sv] = r.lastValue;
  }
}

// Priority: manual override > OPC-read value > simulation value
raw = readValueByStreamVar[sv] ?? getProjectValue(w.projectTag);
```

### 7.3 — Stale Closures in Polling

**Symptom:** Polling reads/writes only used the initial tag mappings. Adding new tags while polling was active had no effect. Not all tags were updated.

**Root cause:** `setInterval` captured the `readNow`/`writeNow` functions once. As React re-rendered with new state, the interval still called the stale versions with outdated row data.

**Fix:** Store function references in `useRef` and update them on every render. The interval callback reads from refs:

```javascript
const readNowRef = useRef(readNow);
readNowRef.current = readNow; // updated every render

useEffect(() => {
  const id = setInterval(() => {
    if (busyRef.current) return;
    readNowRef.current(); // always calls the latest version
  }, intervalSec * 1000);
  return () => clearInterval(id);
}, [polling, intervalSec, connStatus]);
```

### 7.4 — Dead Session After Backend Restart

**Symptom:** Backend restart kills the PowerShell bridge, but frontend keeps polling → flood of 500 errors in console.

**Root cause:** Frontend had no way to detect the backend session was gone.

**Fix (3-part):**
1. Added `GET /opc/da/status` endpoint that queries the bridge for session existence
2. Added `sessionStatus` handler in bridge: `$sessions.ContainsKey($key)`
3. Added auto-disconnect on 500 errors in the frontend polling loop
4. On mount, check status before starting polls

### 7.5 — Slow Server Discovery (Timeout)

**Symptom:** Discovery took 30+ seconds or timed out entirely.

**Root cause:** Original PowerShell script scanned all of `HKEY_CLASSES_ROOT` (50,000+ entries) using `Get-ChildItem`.

**Fix:** 3-tier discovery approach:
1. OPCEnum COM component (fastest)
2. Known ProgID probe (O(1) per check)
3. `reg.exe` CATID search (fallback)

Discovery now completes in 3-4 seconds.

---

## 8. JWT Token and Auto-Refresh Fix

### 8.1 — Token Duration

Access token was 15 minutes, which was too short for OPC monitoring sessions.

**Fix in `backend/src/config/index.js`:**
```javascript
jwt: {
  secret: process.env.JWT_SECRET || 'dev_secret_change_in_production',
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '8h',   // was '15m'
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d', // was '7d'
},
```

### 8.2 — Auto-Refresh Was Completely Broken (3 Bugs)

The frontend interceptor was supposed to auto-refresh expired tokens, but it never worked due to 3 separate bugs:

**Bug 1 — Auth middleware didn't set error code:**

```javascript
// backend/src/middleware/auth.js — BEFORE (broken):
const appErr = new AppError('Access token expired', 401);
// Missing: appErr.code = 'TOKEN_EXPIRED'

// AFTER (fixed):
const appErr = new AppError('Access token expired', 401);
if (err.name === 'TokenExpiredError') appErr.code = 'TOKEN_EXPIRED';
```

**Bug 2 — Error handler only included `code` in dev mode:**

```javascript
// backend/src/middleware/errorHandler.js — BEFORE (broken):
res.status(status).json({
  success: false,
  error: {
    message,
    ...(process.env.NODE_ENV !== 'production' && err.code && { code: err.code }),
  },
});

// AFTER (fixed — always include code):
res.status(status).json({
  success: false,
  error: {
    message,
    ...(err.code && { code: err.code }),
  },
});
```

**Bug 3 — Frontend interceptor checked wrong JSON path:**

```javascript
// frontend/src/utils/api.js — BEFORE (broken):
if (error.response?.status === 401 && data?.code === 'TOKEN_EXPIRED')
// But the code is at data.error.code, not data.code!

// AFTER (fixed — check both paths):
if (error.response?.status === 401 &&
    (data?.code === 'TOKEN_EXPIRED' || data?.error?.code === 'TOKEN_EXPIRED') &&
    !original._retry)
```

**Working auto-refresh interceptor:**

```javascript
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    const data = error.response?.data;

    if (error.response?.status === 401 &&
        (data?.code === 'TOKEN_EXPIRED' || data?.error?.code === 'TOKEN_EXPIRED') &&
        !original._retry) {

      if (refreshing) {
        return new Promise((resolve, reject) => {
          queue.push({ resolve, reject, config: original });
        });
      }

      original._retry = true;
      refreshing = true;

      try {
        const { data: tokens } = await axios.post(`${BASE}/auth/refresh`, {}, {
          withCredentials: true
        });
        sessionStorage.setItem('accessToken',
          tokens.data?.accessToken || tokens.accessToken);

        // Retry queued requests
        queue.forEach(({ resolve, config }) => {
          config.headers.Authorization = `Bearer ${sessionStorage.getItem('accessToken')}`;
          resolve(api(config));
        });
        queue = [];

        // Retry the original request
        original.headers.Authorization = `Bearer ${sessionStorage.getItem('accessToken')}`;
        return api(original);
      } catch (refreshErr) {
        queue.forEach(({ reject }) => reject(refreshErr));
        queue = [];
        sessionStorage.removeItem('accessToken');
        window.location.href = '/login';
        return Promise.reject(refreshErr);
      } finally {
        refreshing = false;
      }
    }

    return Promise.reject(error);
  }
);
```

---

## 9. The Right Working Approach — Step by Step

If you need to integrate OPC DA with a Node.js web application, follow this approach:

### Step 1: Set Up the PowerShell Bridge

1. Create `opc-da-bridge.ps1` with C# COM interface definitions (copy the `Add-Type` block from the working code)
2. Implement the `OpcDaSession` class with `Connect`, `BrowseAll`, `ReadItems`, `WriteItems`, `Dispose` methods
3. Implement the main loop: read JSON from stdin, dispatch to handlers, write JSON to stdout
4. Signal readiness on startup: `Send-Response 0 @{ ready = $true; pid = $PID; bitness = 8 * [IntPtr]::Size }`

### Step 2: Create the Node.js Bridge Manager

1. Spawn the bridge using **32-bit PowerShell** (`C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`)
2. Use `readline` on stdout to read JSON responses line-by-line
3. Map each call to a pending Promise using a message ID
4. Add timeouts to prevent hung calls
5. Handle bridge process exit → reject all pending calls

### Step 3: Create REST API Routes

1. `POST /da/discover` — runs a one-shot PowerShell script for discovery
2. `POST /da/connect` — calls bridge connect action
3. `POST /da/browse` — calls bridge browse action (recursive tree)
4. `POST /da/read` — calls bridge read action
5. `POST /da/write` — calls bridge write action
6. `GET /da/status` — calls bridge sessionStatus action

### Step 4: Build the Frontend

1. **Zustand store** for global connection state (protocol, server, status)
2. **Connection dialog** — discover servers, select one, connect
3. **Tag table** — map project variables to OPC tags, show live values
4. **Portal-based dropdowns** — use `ReactDOM.createPortal` + `position: fixed` to escape overflow containers
5. **Ref-based polling** — use `useRef` for all function refs in `setInterval` callbacks
6. **Auto-disconnect on 500** — catch API errors and mark disconnected
7. **Read-to-write bridge** — when writing, check if the same stream variable has an OPC-read value and use that instead of simulation value

### Step 5: Handle Session Lifecycle

1. On page load: hydrate opcStore from first OPC node's saved params
2. On page load: call `/da/status` to verify backend session is alive
3. On connect: save connection params to all OPC nodes
4. On backend restart: auto-detect dead session via 500 errors
5. On disconnect: stop polling, clear status

---

## 10. Error Reference Table

| Error Code / Message | Where | Root Cause | Fix |
|---------------------|-------|------------|-----|
| `Cannot find module 'node-opc-da/src/dcom'` | Node.js startup | Wrong import path | Don't use node-opc-da |
| `Encdec is not defined` | node-dcom NTLM | Missing require | Don't use node-dcom |
| `src.readUInt16LE is not a function` | node-dcom NTLM | Buffer/Array mismatch | Don't use node-dcom |
| `error:0308010C:digital envelope routines::unsupported` | OpenSSL 3.5 | MD4/DES-ECB deprecated | Don't use node-dcom |
| `DCOM error 5: ACCESS_DENIED` | TCP DCOM | NTLM auth failed | Use local COM via PowerShell |
| `0x80040154 (REGDB_E_CLASSNOTREG)` | COM registration | DLL not registered | Use raw ComImport interfaces |
| `0x80040111 (CLASS_E_CLASSNOTAVAILABLE)` | COM registration | Per-user registration insufficient | Use raw ComImport interfaces |
| `0x80029C4A (TYPE_E_CANTLOADLIBRARY)` | COM TypeLib | TypeLib not registered | Use raw ComImport interfaces |
| `0x80070005 (E_ACCESSDENIED)` | regsvr32 | Needs admin | Use raw ComImport interfaces |
| `0x800706F4 (null reference to stub)` | COM Browse | Marshaling issue | Fix browse parameter marshaling |
| `0x80040008` | OPC DA Write | Tag is read-only | Check tag access rights |
| `Route not found` | Express 404 | Backend not restarted | Restart backend after code changes |
| `500` flood on polling | API calls | Dead OPC session | Add auto-disconnect on 500 errors |
| Empty dropdowns | React UI | `overflow:auto` clips absolute elements | Use `ReactDOM.createPortal` + `position:fixed` |
| Wrong write value | React polling | Using sim value instead of OPC-read | Build readValueByStreamVar bridge map |
| Token expired during session | JWT auth | 15min expiry too short | Increase to 8h + fix auto-refresh chain |

---

## 11. Key Takeaways

1. **Don't use Node.js DCOM libraries for OPC DA.** They're unmaintained, have broken NTLM, and are incompatible with modern Node.js crypto. Use PowerShell COM instead.

2. **Always use 32-bit PowerShell** (`SysWOW64`) for OPC DA COM objects. Most OPC DA servers register 32-bit COM objects only.

3. **Define COM interfaces in C# using `[ComImport]`** rather than relying on `OPCDAAuto.dll`. The automation DLL requires admin registration. Raw interface definitions work with just the server's CLSID.

4. **Use a long-lived bridge process** (not one-shot scripts). Creating/destroying COM objects per request is slow and unreliable. Keep persistent sessions.

5. **Communicate via JSON over stdin/stdout.** This is simpler and more reliable than named pipes, TCP sockets, or HTTP for IPC between Node.js and PowerShell.

6. **Always use `useRef` for functions called from `setInterval`.** React's `setInterval` + closures will capture stale state. Update refs on every render.

7. **Use `ReactDOM.createPortal` for dropdowns inside scrollable containers.** Never use `position: absolute` inside `overflow: auto` — the dropdown will be clipped.

8. **Auto-disconnect on 500 errors.** When the backend restarts, OPC sessions are lost. The frontend must detect this and stop polling.

9. **Bridge OPC-read values to writes.** When the same stream variable is read from one OPC tag and written to another, use the OPC-read value, not the simulation value.

10. **Test the full chain: Backend → Bridge → COM → OPC Server.** Many issues only appear at runtime when actual COM calls are made. Unit tests can't catch COM marshaling bugs.

---

*End of Lessons Learned Document*
