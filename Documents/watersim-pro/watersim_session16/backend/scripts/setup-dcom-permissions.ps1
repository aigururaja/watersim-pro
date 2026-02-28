#Requires -RunAsAdministrator
<#
.SYNOPSIS
  One-time DCOM permission setup for OPC DA servers (e.g., Matrikon OPC Simulation).

.DESCRIPTION
  Configures Windows DCOM default security to allow OPC DA connections from
  the WaterSim backend (node-dcom-fix). This is the standard setup for OPC
  environments where the client uses DCOM to communicate with OPC DA servers.

  Changes made:
   1. Sets DCOM default authentication level to "Connect" (2)
   2. Sets DCOM default impersonation level to "Identify" (3)
   3. Adds "Everyone" and "ANONYMOUS LOGON" to default DCOM Launch and Access permissions
   4. Optionally configures the specific Matrikon OPC server DCOM AppID

  Run this script ONCE as Administrator:
    powershell -ExecutionPolicy Bypass -File setup-dcom-permissions.ps1

.NOTES
  Requires Administrator privileges. A system restart may be needed for changes
  to take full effect, but often a restart of the OPC server service is sufficient.
#>

$ErrorActionPreference = 'Stop'

Write-Host "`n=== WaterSim DCOM Permission Setup ===" -ForegroundColor Cyan
Write-Host "Configuring DCOM security for OPC DA access...`n"

# ── Step 1: Set default authentication and impersonation levels ──────────────

$olePath = 'HKLM:\SOFTWARE\Microsoft\Ole'

try {
    # Authentication Level: 2 = Connect (authenticate only on connect, not every call)
    $currentAuth = (Get-ItemProperty $olePath -Name 'LegacyAuthenticationLevel' -ErrorAction SilentlyContinue).LegacyAuthenticationLevel
    if ($currentAuth -ne 2) {
        Set-ItemProperty -Path $olePath -Name 'LegacyAuthenticationLevel' -Value 2 -Type DWord
        Write-Host "[OK] Set LegacyAuthenticationLevel = 2 (Connect)" -ForegroundColor Green
    } else {
        Write-Host "[--] LegacyAuthenticationLevel already set to 2" -ForegroundColor Gray
    }

    # Impersonation Level: 3 = Impersonate (standard for OPC)
    $currentImp = (Get-ItemProperty $olePath -Name 'LegacyImpersonationLevel' -ErrorAction SilentlyContinue).LegacyImpersonationLevel
    if ($currentImp -ne 3) {
        Set-ItemProperty -Path $olePath -Name 'LegacyImpersonationLevel' -Value 3 -Type DWord
        Write-Host "[OK] Set LegacyImpersonationLevel = 3 (Impersonate)" -ForegroundColor Green
    } else {
        Write-Host "[--] LegacyImpersonationLevel already set to 3" -ForegroundColor Gray
    }
} catch {
    Write-Host "[!!] Failed to set authentication levels: $_" -ForegroundColor Red
}

# ── Step 2: Add Everyone + ANONYMOUS LOGON to default DCOM permissions ───────

function Add-DcomPermission {
    param(
        [string]$RegistryValueName,   # 'DefaultLaunchPermission' or 'DefaultAccessPermission'
        [string]$DisplayName
    )

    try {
        # Get existing SD or create a new one
        $existingBytes = (Get-ItemProperty $olePath -Name $RegistryValueName -ErrorAction SilentlyContinue).$RegistryValueName

        if ($existingBytes) {
            $sd = New-Object System.Security.AccessControl.CommonSecurityDescriptor($true, $false, $existingBytes, 0)
        } else {
            $sd = New-Object System.Security.AccessControl.CommonSecurityDescriptor($true, $false, 'D:')
        }

        # SIDs
        $everyoneSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')       # Everyone
        $anonymousSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-7')      # ANONYMOUS LOGON
        $interactiveSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-4')    # INTERACTIVE

        # Access mask for DCOM:
        #   Launch permission:  0x1F = Local Launch + Remote Launch + Local Activate + Remote Activate
        #   Access permission:  0x03 = Local Access + Remote Access
        $mask = if ($RegistryValueName -like '*Launch*') { 0x1F } else { 0x03 }

        $added = $false
        foreach ($sid in @($everyoneSid, $anonymousSid, $interactiveSid)) {
            # Check if already present
            $found = $false
            foreach ($ace in $sd.DiscretionaryAcl) {
                if ($ace.SecurityIdentifier -eq $sid) { $found = $true; break }
            }
            if (-not $found) {
                $sd.DiscretionaryAcl.AddAccess(
                    [System.Security.AccessControl.AccessControlType]::Allow,
                    $sid, $mask, 'None', 'None'
                )
                $added = $true
            }
        }

        if ($added) {
            $bytes = New-Object byte[] $sd.BinaryLength
            $sd.GetBinaryForm($bytes, 0)
            Set-ItemProperty -Path $olePath -Name $RegistryValueName -Value $bytes -Type Binary
            Write-Host "[OK] Updated $DisplayName — added Everyone, ANONYMOUS LOGON, INTERACTIVE" -ForegroundColor Green
        } else {
            Write-Host "[--] $DisplayName already includes required principals" -ForegroundColor Gray
        }
    } catch {
        Write-Host "[!!] Failed to update ${DisplayName}: $_" -ForegroundColor Red
    }
}

Add-DcomPermission -RegistryValueName 'DefaultLaunchPermission' -DisplayName 'Default Launch Permission'
Add-DcomPermission -RegistryValueName 'DefaultAccessPermission' -DisplayName 'Default Access Permission'

# ── Step 3: Configure Matrikon-specific DCOM AppID (if found) ────────────────

$matrikonClsid = '{F8582CF2-88FB-11D0-B850-00C0F0104305}'
$appIdPath = "Registry::HKEY_CLASSES_ROOT\AppID\$matrikonClsid"

if (Test-Path $appIdPath) {
    try {
        # Set AuthenticationLevel to 1 (None) for this specific server
        Set-ItemProperty -Path $appIdPath -Name 'AuthenticationLevel' -Value 1 -Type DWord -ErrorAction SilentlyContinue
        Write-Host "[OK] Set Matrikon AppID AuthenticationLevel = 1 (None)" -ForegroundColor Green
    } catch {
        Write-Host "[!!] Could not configure Matrikon AppID: $_" -ForegroundColor Yellow
    }
} else {
    # Try finding via ProgID
    $clsidFromReg = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\Matrikon.OPC.Simulation.1\CLSID" -ErrorAction SilentlyContinue).'(default)'
    if ($clsidFromReg) {
        $appIdFromClsid = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\CLSID\$clsidFromReg" -ErrorAction SilentlyContinue).AppID
        if ($appIdFromClsid) {
            $specificAppIdPath = "Registry::HKEY_CLASSES_ROOT\AppID\$appIdFromClsid"
            if (Test-Path $specificAppIdPath) {
                Set-ItemProperty -Path $specificAppIdPath -Name 'AuthenticationLevel' -Value 1 -Type DWord -ErrorAction SilentlyContinue
                Write-Host "[OK] Set Matrikon AppID ($appIdFromClsid) AuthenticationLevel = 1" -ForegroundColor Green
            }
        }
    }
    Write-Host "[--] Matrikon AppID not found at expected path (non-critical)" -ForegroundColor Gray
}

# ── Step 4: Enable DCOM (should already be enabled) ─────────────────────────

try {
    $enableDcom = (Get-ItemProperty $olePath -Name 'EnableDCOM' -ErrorAction SilentlyContinue).EnableDCOM
    if ($enableDcom -ne 'Y') {
        Set-ItemProperty -Path $olePath -Name 'EnableDCOM' -Value 'Y' -Type String
        Write-Host "[OK] Enabled DCOM" -ForegroundColor Green
    } else {
        Write-Host "[--] DCOM already enabled" -ForegroundColor Gray
    }
} catch {
    Write-Host "[!!] Could not check DCOM status: $_" -ForegroundColor Yellow
}

Write-Host "`n=== Setup Complete ===" -ForegroundColor Cyan
Write-Host "You may need to restart the Matrikon OPC Simulation Server service"
Write-Host "or reboot for all changes to take effect.`n"
Write-Host "To restart Matrikon service:" -ForegroundColor Yellow
Write-Host "  Restart-Service 'Matrikon OPC Simulation' -ErrorAction SilentlyContinue" -ForegroundColor Yellow
Write-Host "  (or restart from Windows Services panel)`n"
