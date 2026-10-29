# Expose the local Ollama to the P&ID reader through ngrok, with basic auth.
#
#   powershell -ExecutionPolicy Bypass -File backend\scripts\ollama-tunnel.ps1
#
# Reads OLLAMA_AUTH (user:password) from backend\.env, starts ngrok in its own
# window so it outlives the terminal, and prints the public URL. The free plan
# keeps the same ngrok-free.dev domain across restarts, so OLLAMA_BASE_URL on
# the server does not change. Ollama itself must already be running (tray app).

$ErrorActionPreference = 'Stop'
$envFile = Join-Path $PSScriptRoot '..\.env'
$line = Get-Content $envFile | Where-Object { $_ -match '^OLLAMA_AUTH=' } | Select-Object -First 1
if (-not $line) { throw "OLLAMA_AUTH=user:password is missing from $envFile" }
$auth = ($line -replace '^OLLAMA_AUTH=', '').Trim().Trim('"')

try {
  $up = (Invoke-RestMethod http://127.0.0.1:4040/api/tunnels -TimeoutSec 2).tunnels |
    Where-Object { $_.config.addr -match '11434' }
} catch { $up = $null }
if ($up) { "Tunnel already running: $($up.public_url)"; exit 0 }

Start-Process -FilePath ngrok -WindowStyle Minimized -ArgumentList @(
  'http', '11434', '--host-header=localhost:11434', '--basic-auth', $auth
)

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $t = (Invoke-RestMethod http://127.0.0.1:4040/api/tunnels -TimeoutSec 2).tunnels | Select-Object -First 1
    if ($t) { "Tunnel up: $($t.public_url)  ->  set OLLAMA_BASE_URL to this"; exit 0 }
  } catch { }
}
throw 'ngrok did not report a tunnel within 30 s (a just-stopped agent can hold the domain for a while); look at the minimised ngrok window.'
