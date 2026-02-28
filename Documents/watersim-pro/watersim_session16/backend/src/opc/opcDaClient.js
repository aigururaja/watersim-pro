/**
 * WaterSim Pro — OPC DA Client Manager
 *
 * Provides OPC DA (classic COM/DCOM) support via:
 *  - Server discovery: PowerShell registry scan for registered OPC DA servers
 *  - Connection/Browse/Read/Write: PowerShell COM bridge using raw OPC DA
 *    interfaces (IOPCServer, IOPCItemMgt, IOPCSyncIO) — no OPCDAAuto.dll needed
 *
 * The bridge runs as a long-lived 32-bit PowerShell process that maintains
 * COM connections and communicates via stdin/stdout JSON messages.
 *
 * Windows-only — OPC DA is a COM/DCOM standard.
 */

'use strict';

const { execFile, spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const logger = require('../config/index').logger || console;

// ── PowerShell COM Bridge ───────────────────────────────────────────────────

const BRIDGE_SCRIPT = path.join(__dirname, 'opc-da-bridge.ps1');
const PS32 = 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';

let bridge = null;        // child process
let bridgeRL = null;      // readline interface for stdout
let bridgeReady = false;
let pendingCalls = new Map();  // id -> { resolve, reject, timer }
let nextId = 1;

function ensureBridge() {
  if (bridge && !bridge.killed) return Promise.resolve();

  return new Promise((resolve, reject) => {
    logger.info?.('[OPC-DA] Starting PowerShell COM bridge...');

    bridge = spawn(PS32, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', BRIDGE_SCRIPT,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    bridge.on('error', (err) => {
      logger.error?.('[OPC-DA] Bridge process error: %s', err.message);
      bridge = null;
      bridgeReady = false;
      reject(err);
    });

    bridge.on('exit', (code) => {
      logger.info?.('[OPC-DA] Bridge process exited with code %d', code);
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
      logger.error?.('[OPC-DA] Bridge stderr: %s', data.toString().trim());
    });

    // Read JSON responses line by line from stdout
    bridgeRL = readline.createInterface({ input: bridge.stdout });
    bridgeRL.on('line', (line) => {
      line = line.trim();
      if (!line) return;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        logger.error?.('[OPC-DA] Bridge non-JSON output: %s', line);
        return;
      }

      // Handle ready signal
      if (msg.id === 0 && msg.result?.ready) {
        bridgeReady = true;
        logger.info?.('[OPC-DA] Bridge ready (PID=%d, %d-bit)', msg.result.pid, msg.result.bitness);
        resolve();
        return;
      }

      // Route response to pending call
      const entry = pendingCalls.get(msg.id);
      if (entry) {
        pendingCalls.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(msg.error));
        } else {
          entry.resolve(msg.result);
        }
      }
    });

    // Timeout for initial ready signal
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
      const cmd = { id, action, ...params };

      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error(`Bridge call '${action}' timed out after ${timeout}ms`));
      }, timeout);

      pendingCalls.set(id, { resolve, reject, timer });

      const json = JSON.stringify(cmd);
      bridge.stdin.write(json + '\n');
    });
  });
}

// ── Helper: run PowerShell script (one-shot, for discovery) ─────────────────

function runPS(script, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve((stdout || '').trim());
    });
  });
}

// ── Discover DA Servers (PowerShell Component Category query) ────────────────

function discoverDaServers(hostname) {
  if (!hostname) hostname = 'localhost';

  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$result = @()
$seen = @{}

# OPC DA Component Category IDs
$catids = @(
    '{63D5F430-CFE4-11D1-B2C8-0060083BA1FB}',  # OPC DA 1.0
    '{63D5F432-CFE4-11D1-B2C8-0060083BA1FB}',  # OPC DA 2.0
    '{CC603642-66D7-48F1-B69A-B625E73652D7}'   # OPC DA 3.0
)

# Method 1: Try OPCEnum COM component (fastest, standard OPC Foundation tool)
try {
    $opcEnum = New-Object -ComObject 'OPC.ServerList.1'
    if ($opcEnum) {
        foreach ($catid in $catids) {
            try {
                $enum = $opcEnum.GetEnumerator($catid)
                while ($true) {
                    $progId = $enum.Next()
                    if (-not $progId) { break }
                    if (-not $seen[$progId]) {
                        $seen[$progId] = $true
                        $clsidVal = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\$progId\\CLSID" -ErrorAction SilentlyContinue).'(default)'
                        $name = ''
                        if ($clsidVal) {
                            $name = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsidVal" -ErrorAction SilentlyContinue).'(default)'
                        }
                        $result += [PSCustomObject]@{
                            progId = $progId
                            clsid  = if($clsidVal){$clsidVal}else{''}
                            name   = if($name){$name}else{$progId}
                        }
                    }
                }
            } catch {}
        }
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($opcEnum) | Out-Null
    }
} catch {}

# Method 2: Direct probe for well-known OPC server ProgIDs (fast, O(1) per check)
if ($result.Count -eq 0) {
    $knownProgIds = @(
        'Matrikon.OPC.Simulation.1', 'Matrikon.OPC.Simulation',
        'Kepware.KEPServerEX.V6', 'Kepware.KEPServerEX.V5',
        'KEPware.KEPServerEX.V6', 'KEPware.KEPServerEX.V5',
        'OPC.SimaticNET', 'OPC.SimaticHMI.CoRtHmiRTm.1',
        'RSLinx OPC Server', 'OPC.DeltaV.1',
        'Schneider-Aut.OPC.Da', 'National Instruments.OPCLabVIEW',
        'OPCServer.WinCC.1', 'Softing.OPCToolboxDemo_ServerDA.1',
        'Honeywell.OPCServer.1', 'ICONICS.SimulatorOPCDA.2',
        'FactorySoft.ToolboxDAServer.1', 'Yokogawa.ExaopcDAEServer.1',
        'Graybox.Simulator.1', 'Advosol.OPC.Server.DA.1'
    )
    foreach ($progId in $knownProgIds) {
        $clsidPath = "Registry::HKEY_CLASSES_ROOT\\$progId\\CLSID"
        if (Test-Path $clsidPath) {
            $clsidVal = (Get-ItemProperty $clsidPath -ErrorAction SilentlyContinue).'(default)'
            if ($clsidVal -and -not $seen[$progId]) {
                $seen[$progId] = $true
                $name = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsidVal" -ErrorAction SilentlyContinue).'(default)'
                $result += [PSCustomObject]@{
                    progId = $progId
                    clsid  = $clsidVal
                    name   = if($name){$name}else{$progId}
                }
            }
        }
    }
}

# Method 3: reg.exe CATID search (slower fallback, catches non-standard servers)
if ($result.Count -eq 0) {
    foreach ($catid in $catids) {
        $regOut = reg query "HKCR\\CLSID" /s /f $catid /k 2>$null
        if ($regOut) {
            $regOut | ForEach-Object {
                if ($_ -match 'HKEY_CLASSES_ROOT\\CLSID\\(\\{[^}]+\\})\\Implemented Categories') {
                    $clsidStr = $matches[1]
                    if (-not $seen[$clsidStr]) {
                        $seen[$clsidStr] = $true
                        $name = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsidStr" -ErrorAction SilentlyContinue).'(default)'
                        $progId = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\CLSID\\$clsidStr\\ProgID" -ErrorAction SilentlyContinue).'(default)'
                        if ($progId) {
                            $result += [PSCustomObject]@{
                                progId = $progId
                                clsid  = $clsidStr
                                name   = if($name){$name}else{$progId}
                            }
                        }
                    }
                }
            }
        }
        if ($result.Count -gt 0) { break }
    }
}

$result = $result | Sort-Object progId -Unique

if ($result.Count -eq 0) {
    Write-Output '[]'
} elseif ($result.Count -eq 1) {
    Write-Output ('[' + ($result | ConvertTo-Json -Compress) + ']')
} else {
    Write-Output ($result | ConvertTo-Json -Compress)
}
`;

  return runPS(psScript, 30000).then(raw => {
    try {
      const servers = raw ? JSON.parse(raw) : [];
      return Array.isArray(servers) ? servers : [servers];
    } catch (parseErr) {
      logger.error?.('[OPC-DA] Discovery parse error: %s — stdout: %s', parseErr.message, raw);
      return [];
    }
  }).catch(err => {
    logger.error?.('[OPC-DA] Discovery failed: %s', err.message);
    throw new Error(`DA discovery failed: ${err.message}`);
  });
}

// ── Connect ──────────────────────────────────────────────────────────────────

async function connect(progId, address) {
  if (!progId) throw new Error('progId is required');
  if (!address) address = 'localhost';

  const clsid = await getClsidForProgId(progId);
  if (!clsid) throw new Error(`Cannot find CLSID for ProgID: ${progId}`);

  const key = `${address}::${progId}`;

  logger.info?.('[OPC-DA] Connecting to %s (%s) via COM bridge', progId, clsid);

  const result = await callBridge('connect', { clsid, key });
  return { status: result.status, key: result.key };
}

// ── Disconnect ───────────────────────────────────────────────────────────────

async function disconnect(progId, address) {
  const key = `${address || 'localhost'}::${progId}`;
  await callBridge('disconnect', { key });
  logger.info?.('[OPC-DA] Disconnected from %s', key);
}

// ── Browse ───────────────────────────────────────────────────────────────────

async function browse(progId, address) {
  const key = `${address || 'localhost'}::${progId}`;

  const result = await callBridge('browse', { key }, 60000);
  return (result.nodes || []).map(node => ({
    itemID: node.itemID,
    name: node.name || String(node.itemID).split('.').pop(),
    isFolder: !!node.isFolder,
    parentPath: node.parentPath || '',
  }));
}

// ── Read ─────────────────────────────────────────────────────────────────────

async function read(progId, address, tagIds) {
  if (!tagIds || tagIds.length === 0) return [];

  const key = `${address || 'localhost'}::${progId}`;

  const result = await callBridge('read', { key, tagIds });
  return (result.values || []).map(v => ({
    tagId: v.tagId,
    value: v.value ?? null,
    quality: v.quality ?? 0,
    timestamp: v.timestamp || new Date().toISOString(),
    isGood: v.isGood ?? false,
  }));
}

// ── Write ────────────────────────────────────────────────────────────────────

async function write(progId, address, tags) {
  if (!progId) throw new Error('progId is required for DA write');
  if (!tags || tags.length === 0) return [];
  if (!address) address = 'localhost';

  const key = `${address}::${progId}`;
  const tagIds = tags.map(t => t.tagId);
  const values = tags.map(t => t.value);

  const result = await callBridge('write', { key, tagIds, values });
  return (result.results || []).map(r => ({
    tagId: r.tagId,
    statusCode: r.statusCode || 'Bad',
    isGood: r.isGood ?? false,
  }));
}

// ── Status ───────────────────────────────────────────────────────────────────

async function getStatus(progId, address) {
  if (!bridge || bridge.killed || !progId) return { status: 'disconnected' };

  const key = `${address || 'localhost'}::${progId}`;
  try {
    const result = await callBridge('sessionStatus', { key }, 5000);
    return { status: result.exists ? 'connected' : 'disconnected' };
  } catch {
    return { status: 'disconnected' };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getClsidForProgId(progId) {
  const psScript = `
$clsid = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\\${progId.replace(/"/g, '`"')}\\CLSID" -ErrorAction SilentlyContinue).'(default)'
if ($clsid) { Write-Output $clsid } else { Write-Output '' }
`;
  try {
    const clsid = await runPS(psScript, 5000);
    return clsid || null;
  } catch (_) {
    return null;
  }
}

// Cleanup on process exit
process.on('exit', () => {
  if (bridge && !bridge.killed) {
    try { bridge.stdin.write(JSON.stringify({ id: 0, action: 'quit' }) + '\n'); } catch {}
    bridge.kill();
  }
});

module.exports = { discoverDaServers, connect, disconnect, browse, read, write, getStatus };
