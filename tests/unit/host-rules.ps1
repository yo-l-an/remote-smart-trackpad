# Runs the bridge's pure rules for tests/unit/host-rules.test.mjs (docs/adr/0002): one JSON request per line on stdin,
# { rule, facts }, one JSON answer per line on stdout, { ok, result } or { ok: false, error }. Nothing is read from
# or sent to the desktop.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$hostDirectory = Join-Path $PSScriptRoot '..\..\host\windows'
Import-Module (Join-Path $hostDirectory 'mirror-rules.psm1') -DisableNameChecking
Import-Module (Join-Path $hostDirectory 'input.psm1') -DisableNameChecking
# The USB dongle's keys (Dongle in native.psm1), on this PC's keyboard layout.
function Get-DongleUsage($facts) { return [Dongle]::Usage([int]$facts.virtualKey, [Dongle]::ForegroundLayout()) }
function Get-DongleTyping($facts) { return [Dongle]::TypeCommand([char][int]$facts.character, [Dongle]::ForegroundLayout(), [bool]$facts.capsLock) }
$rules = @('Get-FieldVerdict', 'Get-FieldKind', 'Repair-MirrorText', 'Get-EditOutcome', 'Select-InsertStrategy', 'Get-InlineObjectView', 'Get-DongleUsage', 'Get-DongleTyping')
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = ConvertFrom-Json -InputObject $line
        if ($request.rule -notin $rules) { throw "Unknown rule: $($request.rule)" }
        $result = & $request.rule $request.facts
        @{ ok=$true; result=$result } | ConvertTo-Json -Compress -Depth 5
    } catch {
        @{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress
    }
}
