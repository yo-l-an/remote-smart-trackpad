# Restarts the server the tray runs, with the code as it is now (host and bridge changes apply); phones reconnect on
# their own. Waits until the new server answers. Used by `npm restart`; the tray menu's Restart server does the same.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$tray = Join-Path $projectRoot '.data\RemoteSmartTrackpad.exe'
$port = if ($env:REMOTE_SMART_TRACKPAD_PORT) { $env:REMOTE_SMART_TRACKPAD_PORT } else { '8765' }
if (-not (Test-Path -LiteralPath $tray)) { throw 'No tray built yet: start it with host/tray/start-tray.ps1.' }
# Each server starts with a code of its own: a new code is the new server answering. (Its process would not do: a
# server run as administrator hides its command line from this script.)
function Get-ServerStart {
    try {
        $state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/setup" -TimeoutSec 1
        if ($state.app -eq 'remote-smart-trackpad') { return $state.pairingExpires }
    } catch { }
    return $null
}
$before = Get-ServerStart
$signal = Start-Process -FilePath $tray -ArgumentList '--restart' -Wait -PassThru
if ($signal.ExitCode -ne 0) { throw 'The tray is not running: start it with host/tray/start-tray.ps1.' }
# The old server leaves first (up to 5 s for a graceful stop), then the new one listens.
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 250
    $now = Get-ServerStart
    if ($null -ne $now -and $now -ne $before) { Write-Output "Server restarted (port $port)."; exit 0 }
}
throw "The server did not answer after the restart: see Show console in the tray menu."
