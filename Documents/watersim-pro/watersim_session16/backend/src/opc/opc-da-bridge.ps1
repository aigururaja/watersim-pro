# OPC DA PowerShell Bridge - Long-lived process for Node.js backend
# Communicates via stdin/stdout JSON messages
# Uses raw COM interfaces (IOPCServer, IOPCItemMgt, IOPCSyncIO)
# Must run in 32-bit PowerShell: C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe

$ErrorActionPreference = 'Stop'

# ── C# COM Interface Definitions ────────────────────────────────────────────

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("00000101-0000-0000-C000-000000000046")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IEnumString {
    [PreserveSig]
    int RemoteNext(uint celt, IntPtr rgelt, out uint pceltFetched);
    void Skip(uint celt);
    void Reset();
    void Clone(out IEnumString ppenum);
}

[ComImport, Guid("39c13a4d-011e-11d0-9675-0020afd8adb3")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOPCServer {
    void AddGroup(
        [MarshalAs(UnmanagedType.LPWStr)] string szName,
        int bActive, uint dwRequestedUpdateRate, uint hClientGroup,
        IntPtr pTimeBias, IntPtr pPercentDeadband, uint dwLCID,
        out uint phServerGroup, out uint pRevisedUpdateRate,
        ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppUnk);
    void GetErrorString(int dwError, uint dwLocale,
        [MarshalAs(UnmanagedType.LPWStr)] out string ppString);
    void GetGroupByName([MarshalAs(UnmanagedType.LPWStr)] string szName,
        ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppUnk);
    void GetStatus(out IntPtr ppServerStatus);
    void RemoveGroup(uint hServerGroup, int bForce);
    void CreateGroupEnumerator(uint dwScope, ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppUnk);
}

[ComImport, Guid("39c13a4f-011e-11d0-9675-0020afd8adb3")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOPCBrowseServerAddressSpace {
    void QueryOrganization(out int pNameSpaceType);
    void ChangeBrowsePosition(int dwBrowseDirection,
        [MarshalAs(UnmanagedType.LPWStr)] string szString);
    void BrowseOPCItemIDs(int dwBrowseFilterType,
        [MarshalAs(UnmanagedType.LPWStr)] string szFilterCriteria,
        short vtDataTypeFilter, uint dwAccessRightsFilter,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppIEnumString);
    void GetItemID([MarshalAs(UnmanagedType.LPWStr)] string szItemDataID,
        [MarshalAs(UnmanagedType.LPWStr)] out string szItemID);
    void BrowseAccessPaths([MarshalAs(UnmanagedType.LPWStr)] string szItemID,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppIEnumString);
}

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct OPCITEMDEF {
    [MarshalAs(UnmanagedType.LPWStr)] public string szAccessPath;
    [MarshalAs(UnmanagedType.LPWStr)] public string szItemID;
    public int bActive;
    public uint hClient;
    public uint dwBlobSize;
    public IntPtr pBlob;
    public short vtRequestedDataType;
    public short wReserved;
}

[StructLayout(LayoutKind.Sequential)]
public struct OPCITEMRESULT {
    public uint hServer;
    public short vtCanonicalDataType;
    public short wReserved;
    public uint dwAccessRights;
    public uint dwBlobSize;
    public IntPtr pBlob;
}

[ComImport, Guid("39c13a54-011e-11d0-9675-0020afd8adb3")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOPCItemMgt {
    void AddItems(uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] OPCITEMDEF[] pItemArray,
        out IntPtr ppAddResults, out IntPtr ppErrors);
    void ValidateItems(uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] OPCITEMDEF[] pItemArray,
        int bBlobUpdate, out IntPtr ppValidationResults, out IntPtr ppErrors);
    void RemoveItems(uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] phServer,
        out IntPtr ppErrors);
    void SetActiveState(uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] phServer,
        int bActive, out IntPtr ppErrors);
    void SetClientHandles(uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] phServer,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] phClient,
        out IntPtr ppErrors);
    void SetDatatypes(uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] phServer,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] short[] pRequestedDatatypes,
        out IntPtr ppErrors);
    void CreateEnumerator(ref Guid riid,
        [MarshalAs(UnmanagedType.IUnknown)] out object ppUnk);
}

[ComImport, Guid("39c13a52-011e-11d0-9675-0020afd8adb3")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IOPCSyncIO {
    void Read(int dwSource, uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] uint[] phServer,
        out IntPtr ppItemValues, out IntPtr ppErrors);
    void Write(uint dwCount,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] phServer,
        [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] object[] pItemValues,
        out IntPtr ppErrors);
}

public static class NativeMethods {
    [DllImport("oleaut32.dll")]
    public static extern int VariantClear(IntPtr pvarg);
}

// ── High-level OPC DA Client ────────────────────────────────────────────────

public class OpcDaSession : IDisposable {
    private object comObj;
    private IOPCServer server;
    private IOPCBrowseServerAddressSpace browser;
    public string Key;

    public void Connect(string clsid) {
        Guid guid = new Guid(clsid);
        Type type = Type.GetTypeFromCLSID(guid, true);
        comObj = Activator.CreateInstance(type);
        server = (IOPCServer)comObj;
        browser = (IOPCBrowseServerAddressSpace)comObj;
    }

    // ── Enum helper ──
    private string[] EnumStrings(object enumUnk, int maxCount) {
        if (enumUnk == null) return new string[0];
        var results = new List<string>();
        IEnumString e = (IEnumString)enumUnk;
        IntPtr pStr = Marshal.AllocCoTaskMem(IntPtr.Size);
        try {
            for (int i = 0; i < maxCount; i++) {
                uint fetched;
                int hr = e.RemoteNext(1, pStr, out fetched);
                if (hr != 0 || fetched == 0) break;
                IntPtr strPtr = Marshal.ReadIntPtr(pStr);
                if (strPtr != IntPtr.Zero) {
                    results.Add(Marshal.PtrToStringUni(strPtr));
                    Marshal.FreeCoTaskMem(strPtr);
                }
            }
        } finally {
            Marshal.FreeCoTaskMem(pStr);
            Marshal.ReleaseComObject(enumUnk);
        }
        return results.ToArray();
    }

    // ── Browse ──
    public string[] BrowseBranches(string path) {
        // Navigate down to the path
        if (!string.IsNullOrEmpty(path)) {
            string[] parts = path.Split('.');
            foreach (string p in parts)
                browser.ChangeBrowsePosition(2, p); // Down
        }

        object enumUnk;
        browser.BrowseOPCItemIDs(1, "", 0, 0, out enumUnk); // 1=Branch
        string[] result = EnumStrings(enumUnk, 500);

        // Navigate back up
        if (!string.IsNullOrEmpty(path)) {
            string[] parts = path.Split('.');
            for (int i = 0; i < parts.Length; i++)
                browser.ChangeBrowsePosition(1, ""); // Up
        }
        return result;
    }

    public string[] BrowseLeaves(string path) {
        if (!string.IsNullOrEmpty(path)) {
            string[] parts = path.Split('.');
            foreach (string p in parts)
                browser.ChangeBrowsePosition(2, p);
        }

        object enumUnk;
        browser.BrowseOPCItemIDs(2, "", 0, 0, out enumUnk); // 2=Leaf
        var items = new List<string>();
        if (enumUnk != null) {
            IEnumString e = (IEnumString)enumUnk;
            IntPtr pStr = Marshal.AllocCoTaskMem(IntPtr.Size);
            try {
                for (int i = 0; i < 10000; i++) {
                    uint fetched;
                    int hr = e.RemoteNext(1, pStr, out fetched);
                    if (hr != 0 || fetched == 0) break;
                    IntPtr strPtr = Marshal.ReadIntPtr(pStr);
                    if (strPtr != IntPtr.Zero) {
                        string name = Marshal.PtrToStringUni(strPtr);
                        Marshal.FreeCoTaskMem(strPtr);
                        string fullId;
                        browser.GetItemID(name, out fullId);
                        items.Add(fullId);
                    }
                }
            } finally {
                Marshal.FreeCoTaskMem(pStr);
                Marshal.ReleaseComObject(enumUnk);
            }
        }

        if (!string.IsNullOrEmpty(path)) {
            string[] parts = path.Split('.');
            for (int i = 0; i < parts.Length; i++)
                browser.ChangeBrowsePosition(1, "");
        }
        return items.ToArray();
    }

    // Recursive browse - returns all items in the entire tree
    public List<BrowseItem> BrowseAll() {
        var result = new List<BrowseItem>();
        BrowseRecursive(result, "", 0);
        return result;
    }

    private void BrowseRecursive(List<BrowseItem> result, string currentPath, int depth) {
        if (depth > 10) return; // safety limit

        // Get leaves at this level
        object leafEnum;
        browser.BrowseOPCItemIDs(2, "", 0, 0, out leafEnum);
        if (leafEnum != null) {
            IEnumString e = (IEnumString)leafEnum;
            IntPtr pStr = Marshal.AllocCoTaskMem(IntPtr.Size);
            try {
                for (int i = 0; i < 10000; i++) {
                    uint fetched;
                    int hr = e.RemoteNext(1, pStr, out fetched);
                    if (hr != 0 || fetched == 0) break;
                    IntPtr strPtr = Marshal.ReadIntPtr(pStr);
                    if (strPtr != IntPtr.Zero) {
                        string name = Marshal.PtrToStringUni(strPtr);
                        Marshal.FreeCoTaskMem(strPtr);
                        string fullId;
                        browser.GetItemID(name, out fullId);
                        result.Add(new BrowseItem { ItemID = fullId, Name = name, IsFolder = false, ParentPath = currentPath });
                    }
                }
            } finally {
                Marshal.FreeCoTaskMem(pStr);
                Marshal.ReleaseComObject(leafEnum);
            }
        }

        // Get branches and recurse
        object branchEnum;
        browser.BrowseOPCItemIDs(1, "", 0, 0, out branchEnum);
        if (branchEnum != null) {
            string[] branches = EnumStrings(branchEnum, 500);
            foreach (string branch in branches) {
                string subPath = string.IsNullOrEmpty(currentPath) ? branch : currentPath + "." + branch;
                result.Add(new BrowseItem { ItemID = subPath, Name = branch, IsFolder = true, ParentPath = currentPath });
                browser.ChangeBrowsePosition(2, branch); // Down
                BrowseRecursive(result, subPath, depth + 1);
                browser.ChangeBrowsePosition(1, ""); // Up
            }
        }
    }

    // ── Read ──
    public ReadResult[] ReadItems(string[] itemIds) {
        // Create temporary group
        Guid riid = typeof(IOPCItemMgt).GUID;
        object ppUnk;
        uint groupHandle, revisedRate;
        server.AddGroup("read_" + DateTime.Now.Ticks, 1, 1000, 1,
            IntPtr.Zero, IntPtr.Zero, 0x0409,
            out groupHandle, out revisedRate, ref riid, out ppUnk);

        try {
            IOPCItemMgt itemMgt = (IOPCItemMgt)ppUnk;
            IOPCSyncIO syncIO = (IOPCSyncIO)ppUnk;

            // Add items
            int count = itemIds.Length;
            OPCITEMDEF[] defs = new OPCITEMDEF[count];
            for (int i = 0; i < count; i++) {
                defs[i].szItemID = itemIds[i];
                defs[i].szAccessPath = "";
                defs[i].bActive = 1;
                defs[i].hClient = (uint)(i + 1);
                defs[i].pBlob = IntPtr.Zero;
            }

            IntPtr ppResults, ppErrors;
            itemMgt.AddItems((uint)count, defs, out ppResults, out ppErrors);

            int[] addErrors = new int[count];
            Marshal.Copy(ppErrors, addErrors, 0, count);
            Marshal.FreeCoTaskMem(ppErrors);

            // Get server handles
            uint[] serverHandles = new uint[count];
            int resultSize = Marshal.SizeOf(typeof(OPCITEMRESULT));
            for (int i = 0; i < count; i++) {
                if (addErrors[i] == 0) {
                    OPCITEMRESULT res = (OPCITEMRESULT)Marshal.PtrToStructure(
                        IntPtr.Add(ppResults, i * resultSize), typeof(OPCITEMRESULT));
                    serverHandles[i] = res.hServer;
                    if (res.pBlob != IntPtr.Zero) Marshal.FreeCoTaskMem(res.pBlob);
                }
            }
            Marshal.FreeCoTaskMem(ppResults);

            // Read from device
            IntPtr ppValues, ppReadErrors;
            syncIO.Read(2, (uint)count, serverHandles, out ppValues, out ppReadErrors);

            int[] readErrors = new int[count];
            Marshal.Copy(ppReadErrors, readErrors, 0, count);
            Marshal.FreeCoTaskMem(ppReadErrors);

            // Parse results
            ReadResult[] results = new ReadResult[count];
            // OPCITEMSTATE: hClient(4) + FILETIME(8) + wQuality(2) + wReserved(2) + VARIANT(16) = 32 bytes in 32-bit
            int stateSize = 32; // 32-bit layout
            if (IntPtr.Size == 8) stateSize = 40; // 64-bit layout has different alignment

            for (int i = 0; i < count; i++) {
                results[i] = new ReadResult();
                results[i].TagId = itemIds[i];

                if (addErrors[i] != 0) {
                    results[i].Error = "AddItem failed: 0x" + addErrors[i].ToString("X8");
                    continue;
                }
                if (readErrors[i] != 0) {
                    results[i].Error = "Read failed: 0x" + readErrors[i].ToString("X8");
                    continue;
                }

                IntPtr pState = IntPtr.Add(ppValues, i * stateSize);
                results[i].Quality = Marshal.ReadInt16(pState, 12);
                IntPtr pVariant = IntPtr.Add(pState, 16);
                try {
                    results[i].Value = Marshal.GetObjectForNativeVariant(pVariant);
                } catch {
                    results[i].Value = null;
                    results[i].Error = "Variant conversion failed";
                }
                NativeMethods.VariantClear(pVariant);
            }
            Marshal.FreeCoTaskMem(ppValues);

            return results;
        } finally {
            try { server.RemoveGroup(groupHandle, 1); } catch {}
        }
    }

    // ── Write ──
    public WriteResult[] WriteItems(string[] itemIds, object[] values) {
        Guid riid = typeof(IOPCItemMgt).GUID;
        object ppUnk;
        uint groupHandle, revisedRate;
        server.AddGroup("write_" + DateTime.Now.Ticks, 1, 1000, 1,
            IntPtr.Zero, IntPtr.Zero, 0x0409,
            out groupHandle, out revisedRate, ref riid, out ppUnk);

        try {
            IOPCItemMgt itemMgt = (IOPCItemMgt)ppUnk;
            IOPCSyncIO syncIO = (IOPCSyncIO)ppUnk;

            int count = itemIds.Length;
            OPCITEMDEF[] defs = new OPCITEMDEF[count];
            for (int i = 0; i < count; i++) {
                defs[i].szItemID = itemIds[i];
                defs[i].szAccessPath = "";
                defs[i].bActive = 1;
                defs[i].hClient = (uint)(i + 1);
                defs[i].pBlob = IntPtr.Zero;
            }

            IntPtr ppResults, ppErrors;
            itemMgt.AddItems((uint)count, defs, out ppResults, out ppErrors);

            int[] addErrors = new int[count];
            Marshal.Copy(ppErrors, addErrors, 0, count);
            Marshal.FreeCoTaskMem(ppErrors);

            uint[] serverHandles = new uint[count];
            int resultSize = Marshal.SizeOf(typeof(OPCITEMRESULT));
            for (int i = 0; i < count; i++) {
                if (addErrors[i] == 0) {
                    OPCITEMRESULT res = (OPCITEMRESULT)Marshal.PtrToStructure(
                        IntPtr.Add(ppResults, i * resultSize), typeof(OPCITEMRESULT));
                    serverHandles[i] = res.hServer;
                    if (res.pBlob != IntPtr.Zero) Marshal.FreeCoTaskMem(res.pBlob);
                }
            }
            Marshal.FreeCoTaskMem(ppResults);

            // Write
            IntPtr ppWriteErrors;
            syncIO.Write((uint)count, serverHandles, values, out ppWriteErrors);

            int[] writeErrors = new int[count];
            Marshal.Copy(ppWriteErrors, writeErrors, 0, count);
            Marshal.FreeCoTaskMem(ppWriteErrors);

            WriteResult[] results = new WriteResult[count];
            for (int i = 0; i < count; i++) {
                results[i] = new WriteResult();
                results[i].TagId = itemIds[i];
                results[i].IsGood = (addErrors[i] == 0 && writeErrors[i] == 0);
                if (addErrors[i] != 0)
                    results[i].Error = "AddItem: 0x" + addErrors[i].ToString("X8");
                else if (writeErrors[i] != 0)
                    results[i].Error = "Write: 0x" + writeErrors[i].ToString("X8");
            }
            return results;
        } finally {
            try { server.RemoveGroup(groupHandle, 1); } catch {}
        }
    }

    public void Dispose() {
        if (comObj != null) {
            Marshal.ReleaseComObject(comObj);
            comObj = null;
        }
    }
}

public class BrowseItem {
    public string ItemID;
    public string Name;
    public bool IsFolder;
    public string ParentPath;
}

public class ReadResult {
    public string TagId;
    public object Value;
    public int Quality;
    public string Error;
}

public class WriteResult {
    public string TagId;
    public bool IsGood;
    public string Error;
}
'@

# ── Session management ───────────────────────────────────────────────────────

$sessions = @{}

function Send-Response($id, $result, $error) {
    $resp = @{ id = $id }
    if ($error) { $resp.error = $error }
    else { $resp.result = $result }
    $json = $resp | ConvertTo-Json -Depth 10 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Handle-Command($cmd) {
    $id = $cmd.id
    $action = $cmd.action

    try {
        switch ($action) {
            'connect' {
                $clsid = $cmd.clsid
                $key = $cmd.key
                if ($sessions.ContainsKey($key)) {
                    Send-Response $id @{ status = 'connected'; key = $key }
                    return
                }
                $session = New-Object OpcDaSession
                $session.Key = $key
                $session.Connect($clsid)
                $sessions[$key] = $session
                Send-Response $id @{ status = 'connected'; key = $key }
            }

            'disconnect' {
                $key = $cmd.key
                if ($sessions.ContainsKey($key)) {
                    $sessions[$key].Dispose()
                    $sessions.Remove($key)
                }
                Send-Response $id @{ ok = $true }
            }

            'browse' {
                $key = $cmd.key
                if (-not $sessions.ContainsKey($key)) {
                    Send-Response $id $null 'Not connected'
                    return
                }
                $items = $sessions[$key].BrowseAll()
                $nodes = @()
                foreach ($item in $items) {
                    $nodes += @{
                        itemID = $item.ItemID
                        name = $item.Name
                        isFolder = $item.IsFolder
                        parentPath = $item.ParentPath
                    }
                }
                Send-Response $id @{ nodes = $nodes }
            }

            'read' {
                $key = $cmd.key
                $tagIds = $cmd.tagIds
                if (-not $sessions.ContainsKey($key)) {
                    Send-Response $id $null 'Not connected'
                    return
                }
                $results = $sessions[$key].ReadItems([string[]]$tagIds)
                $values = @()
                foreach ($r in $results) {
                    $entry = @{
                        tagId = $r.TagId
                        value = $r.Value
                        quality = $r.Quality
                        isGood = ($r.Quality -band 0xC0) -eq 0xC0
                        timestamp = (Get-Date).ToString('o')
                    }
                    if ($r.Error) { $entry.error = $r.Error; $entry.isGood = $false }
                    $values += $entry
                }
                Send-Response $id @{ values = $values }
            }

            'write' {
                $key = $cmd.key
                $tagIds = [string[]]$cmd.tagIds
                $tagValues = $cmd.values
                if (-not $sessions.ContainsKey($key)) {
                    Send-Response $id $null 'Not connected'
                    return
                }
                $results = $sessions[$key].WriteItems($tagIds, [object[]]$tagValues)
                $out = @()
                foreach ($r in $results) {
                    $entry = @{
                        tagId = $r.TagId
                        statusCode = if ($r.IsGood) { 'Good' } else { 'Bad' }
                        isGood = $r.IsGood
                    }
                    if ($r.Error) { $entry.error = $r.Error }
                    $out += $entry
                }
                Send-Response $id @{ results = $out }
            }

            'ping' {
                Send-Response $id @{ pong = $true }
            }

            'sessionStatus' {
                $key = $cmd.key
                $exists = $sessions.ContainsKey($key)
                Send-Response $id @{ exists = $exists; key = $key }
            }

            'quit' {
                foreach ($key in @($sessions.Keys)) {
                    $sessions[$key].Dispose()
                }
                $sessions.Clear()
                Send-Response $id @{ ok = $true }
                exit 0
            }

            default {
                Send-Response $id $null "Unknown action: $action"
            }
        }
    } catch {
        Send-Response $id $null $_.Exception.Message
    }
}

# ── Main loop: read JSON commands from stdin ─────────────────────────────────

# Signal ready
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
        # Try to send error response
        try {
            Send-Response 0 $null "Parse error: $($_.Exception.Message)"
        } catch {}
    }
}

# Cleanup on exit
foreach ($key in @($sessions.Keys)) {
    try { $sessions[$key].Dispose() } catch {}
}
