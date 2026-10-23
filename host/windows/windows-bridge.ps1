# The host's hands on the PC: one JSON command per line on stdin ({ id, action, data }), one JSON answer per line on
# stdout ({ id, ok, result } or { id, ok: false, error }). Input goes through input.psm1, the mirror through
# text-mirror.psm1.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Import-Module (Join-Path $PSScriptRoot 'input.psm1') -DisableNameChecking

<#
Reading other apps (the mirror, the media state) waits for them: UI Automation and IAccessible2 calls do not return
while the app's UI thread is busy (a browser streaming a long answer) or hung. Those calls run in a reader of their own,
so input never waits behind them: a command that does not answer within its budget returns an error and goes on in
the background, and the reader answers "busy" until it is done. One that never ends is left behind for a new reader.
#>
function New-Reader {
    $runspace = [runspacefactory]::CreateRunspace()
    $runspace.ApartmentState = 'MTA'
    $runspace.ThreadOptions = 'ReuseThread'
    $runspace.Open()
    $setup = [powershell]::Create()
    $setup.Runspace = $runspace
    [void]$setup.AddScript({
        param($directory)
        Import-Module (Join-Path $directory 'input.psm1') -DisableNameChecking
        Import-Module (Join-Path $directory 'text-mirror.psm1') -DisableNameChecking
    }).AddArgument($PSScriptRoot)
    [void]$setup.Invoke()
    $setup.Dispose()
    return $runspace
}
$reader = New-Reader
# The command still running in the background, if any: { pipeline, handle, action, clock }.
$readerBusy = $null
# How long a command may take before input goes on without it (an edit types, then waits to see the field take it).
$readerBudget = @{ 'mirror-read'=500; 'mirror-edit'=5000; 'mirror-close'=500; 'media-state'=500 }
$abandonAfter = 20000
function Invoke-Reader([string]$action, $data) {
    if ($null -ne $script:readerBusy) {
        if ($script:readerBusy.handle.IsCompleted) {
            try { [void]$script:readerBusy.pipeline.EndInvoke($script:readerBusy.handle) } catch {}
            $script:readerBusy.pipeline.Dispose()
            $script:readerBusy = $null
        } elseif ($script:readerBusy.clock.ElapsedMilliseconds -lt $abandonAfter) {
            throw 'The PC is busy: its app is not answering'
        } else {
            [Console]::Error.WriteLine("Windows bridge: $($script:readerBusy.action) did not end in $($abandonAfter / 1000) s; reading starts again in a new reader")
            $script:reader = New-Reader
            $script:readerBusy = $null
        }
    }
    $pipeline = [powershell]::Create()
    $pipeline.Runspace = $script:reader
    [void]$pipeline.AddScript({
        param($action, $data)
        switch ($action) {
            'mirror-read' { Read-MirrorFor $data.session $data.revision }
            'mirror-edit' { Edit-Mirror $data }
            'mirror-close' { Close-Mirror }
            'media-state' { Get-MediaState }
        }
    }).AddArgument($action).AddArgument($data)
    $handle = $pipeline.BeginInvoke()
    if (-not $handle.AsyncWaitHandle.WaitOne($readerBudget[$action])) {
        $script:readerBusy = @{ pipeline=$pipeline; handle=$handle; action=$action; clock=[System.Diagnostics.Stopwatch]::StartNew() }
        [Console]::Error.WriteLine("Windows bridge: $action did not answer within $($readerBudget[$action]) ms (the focused app is busy); input goes on")
        throw 'The PC is busy: its app is not answering'
    }
    try {
        $output = $pipeline.EndInvoke($handle)
        if ($output.Count) { return $output[0] }
        return $null
    } finally { $pipeline.Dispose() }
}
# Tests that type for real (tests/checks/typing-check.mjs) set this to a marker in their own windows' titles: input then
# only ever reaches a window carrying it, never another app the user has in the foreground.
$inputGuard = $env:REMOTE_SMART_TRACKPAD_INPUT_GUARD
if ($inputGuard) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InputGuard {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    public static string ForegroundTitle() {
        var text = new StringBuilder(512);
        GetWindowText(GetForegroundWindow(), text, text.Capacity);
        return text.ToString();
    }
}
'@
}
<#
Runs an input command. When Windows rejects it because an app run as administrator is in front (its tray menu, often),
the focus goes to the taskbar, which closes such a menu, and the command runs again once: it then answers with a
notice saying so. Still rejected, the error names that app: the PC's own mouse or keyboard must deal with it.
#>
function Invoke-Input([scriptblock]$command) {
    try { $null = & $command; return $null } catch { $rejected = $_ }
    $elevated = [Foreground]::Elevated()
    if ($null -eq $elevated) { throw $rejected }
    if ([Foreground]::LeaveElevated()) {
        [Console]::Error.WriteLine("Windows bridge: $elevated runs as administrator and was in front; the taskbar took the focus")
        $null = & $command
        return @{ notice="Permission denied: Unable to move, $elevated runs as administrator. The remote moved the focus off it."; level='danger' }
    }
    throw "$elevated runs as administrator: Windows keeps the remote off it. Use the PC's mouse or keyboard to leave it."
}
$readActions = @('mirror-read', 'mirror-close', 'media-state', 'release', 'dongle')
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = ConvertFrom-Json -InputObject $line
        $data = $request.data
        $result = $null
        if ($inputGuard -and $request.action -notin $readActions -and -not [InputGuard]::ForegroundTitle().Contains($inputGuard)) {
            throw "Input guard: the foreground window is not a test window"
        }
        switch ($request.action) {
            'move' {
                $result = Invoke-Input { if (-not [NativeInput]::MoveBy([int]$data.dx, [int]$data.dy)) { throw 'Windows rejected pointer movement' } }
            }
            'click' { $result = Invoke-Input { Invoke-Click ([string]$data.button) ([bool]$data.double) } }
            'button' { $result = Invoke-Input { Set-Button ([string]$data.button) ([bool]$data.down) } }
            'scroll' {
                $result = Invoke-Input {
                    if ([int]$data.dy -ne 0 -and -not [NativeInput]::Mouse(0x0800, -[int]$data.dy)) { throw 'Windows rejected scroll input' }
                    if ([int]$data.dx -ne 0 -and -not [NativeInput]::Mouse(0x1000, [int]$data.dx)) { throw 'Windows rejected horizontal scroll' }
                }
            }
            'shortcut' { $result = Invoke-Input { Invoke-Shortcut ([string]$data.key) $data.modifiers } }
            # A key held down or let go (down given), or tapped.
            'key' { $result = Invoke-Input { Set-Key ([string]$data.key) $(if ($data.PSObject.Properties.Name -contains 'down') { [bool]$data.down } else { $null }) } }
            # Typing into a PC field the phone cannot read.
            'text' { $result = Invoke-Input { Invoke-Typing ([int]$data.backspace) ([int]$data.delete) ([string]$data.text) } }
            'media-state' { $result = Invoke-Reader 'media-state' $data }
            'glide' {
                $vx = [double]$data.vx; $vy = [double]$data.vy
                if ([double]::IsNaN($vx) -or [double]::IsNaN($vy) -or [Math]::Abs($vx) -gt 20 -or [Math]::Abs($vy) -gt 20) { throw 'Invalid glide velocity' }
                [Glider]::Set($vx, $vy)
            }
            'mirror-read' { $result = Invoke-Reader 'mirror-read' $data }
            'mirror-edit' { $result = Invoke-Reader 'mirror-edit' $data }
            'mirror-close' { [void](Invoke-Reader 'mirror-close' $data) }
            'release' { Release-All }
            # The optional USB dongle (dongle/) takes over the input Windows rejects; its search runs in the background.
            'dongle' { if ($data.enabled) { [Dongle]::Start() } else { [Dongle]::Stop() } }
            default { throw 'Unknown command' }
        }
        @{ id=$request.id; ok=$true; result=$result } | ConvertTo-Json -Compress -Depth 5
    } catch {
        # The failure itself, not PowerShell's wrapper ('Exception calling "GetText" with "1" argument(s): ...').
        $failure = $_.Exception
        while ($failure -is [System.Management.Automation.MethodInvocationException] -and $null -ne $failure.InnerException) { $failure = $failure.InnerException }
        @{ id=$request.id; ok=$false; error=$failure.Message } | ConvertTo-Json -Compress -Depth 5
    }
}
Release-All
