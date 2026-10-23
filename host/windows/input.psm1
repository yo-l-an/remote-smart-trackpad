# Keyboard and mouse input on the PC, with the keys and buttons it holds down (released together by Release-All).
# Every command checks its key, button and limits before sending anything.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'native.psm1') -DisableNameChecking

$keyCodes = @{
    Escape=0x1B; Tab=0x09; Control=0x11; Shift=0x10; Alt=0x12; AltGr=0xA5; Win=0x5B
    Left=0x25; Up=0x26; Right=0x27; Down=0x28; Delete=0x2E; Backspace=0x08
    Home=0x24; End=0x23; PageUp=0x21; PageDown=0x22; Insert=0x2D; Enter=0x0D
    Space=0x20; C=0x43; V=0x56; X=0x58; A=0x41; R=0x52
    F1=0x70; F2=0x71; F3=0x72; F4=0x73; F5=0x74; F6=0x75
    F7=0x76; F8=0x77; F9=0x78; F10=0x79; F11=0x7A; F12=0x7B
    F13=0x7C; F14=0x7D; F15=0x7E; F16=0x7F; F17=0x80; F18=0x81
    F19=0x82; F20=0x83; F21=0x84; F22=0x85; F23=0x86; F24=0x87
    PrintScreen=0x2C; ScrollLock=0x91; Pause=0x13; ContextMenu=0x5D
    VolumeUp=0xAF; VolumeDown=0xAE; VolumeMute=0xAD; PlayPause=0xB3
    B=0x42; D=0x44; E=0x45; F=0x46; G=0x47; H=0x48; I=0x49; J=0x4A
    K=0x4B; L=0x4C; M=0x4D; N=0x4E; O=0x4F; P=0x50; Q=0x51; S=0x53
    T=0x54; U=0x55; W=0x57; Y=0x59; Z=0x5A
}
# Down and up flags of each button.
$buttons = @{ left=@(0x0002,0x0004); right=@(0x0008,0x0010); middle=@(0x0020,0x0040) }
$modifierNames = @('Control', 'Shift', 'Alt', 'AltGr', 'Win')
$held = New-Object 'System.Collections.Generic.HashSet[string]'

function Send-Key($name, [bool]$down) {
    if (-not $keyCodes.ContainsKey($name)) { throw "Unsupported key: $name" }
    if (-not [NativeInput]::Key($keyCodes[$name], $down)) { throw 'Windows rejected keyboard input' }
}
function Send-Button($name, [bool]$down) {
    if (-not [NativeInput]::Mouse($buttons[$name][[int](-not $down)], [int]$buttons[$name][2])) { throw 'Windows rejected mouse input' }
}
function Assert-Button($name) {
    if (-not $buttons.ContainsKey($name)) { throw 'Unsupported mouse button' }
}

function Tap-Key($name) {
    [void]$held.Add($name)
    try { Send-Key $name $true }
    finally {
        Send-Key $name $false
        [void]$held.Remove($name)
    }
}
# A key held down (down: true/false) or tapped (down: $null).
function Set-Key($name, $down) {
    if ($null -eq $down) { return Tap-Key $name }
    if ($down -and -not $held.Contains($name)) { Send-Key $name $true; [void]$held.Add($name) }
    if (-not $down -and $held.Contains($name)) { Send-Key $name $false; [void]$held.Remove($name) }
}
# True while Shift, Control or Alt is held: a caret placed then would select or act.
function Test-ModifierHeld { return $held.Contains('Shift') -or $held.Contains('Control') -or $held.Contains('Alt') }

# A key with modifiers; those already held stay, the others are released afterwards in reverse order.
function Invoke-Shortcut($name, $modifiers) {
    if (-not $keyCodes.ContainsKey($name)) { throw "Unsupported key: $name" }
    $modifiers = @($modifiers)
    if ($modifiers.Count -gt 5) { throw 'Too many shortcut modifiers' }
    foreach ($modifier in $modifiers) {
        if ($modifier -notin $modifierNames) { throw 'Unsupported shortcut modifier' }
    }
    $pressed = New-Object 'System.Collections.Generic.List[string]'
    try {
        foreach ($modifier in $modifiers) {
            if ($held.Contains($modifier)) { continue }
            $pressed.Add($modifier)
            [void]$held.Add($modifier)
            Send-Key $modifier $true
        }
        Tap-Key $name
    } finally {
        $releaseFailed = $false
        for ($index = $pressed.Count - 1; $index -ge 0; $index--) {
            $modifier = $pressed[$index]
            if ([NativeInput]::Key($keyCodes[$modifier], $false)) { [void]$held.Remove($modifier) }
            else { $releaseFailed = $true }
        }
        if ($releaseFailed) { throw 'Windows rejected shortcut key release' }
    }
}

function Invoke-Click($name, [bool]$double) {
    Assert-Button $name
    $times = if ($double) { 2 } else { 1 }
    for ($index = 0; $index -lt $times; $index++) { Send-Button $name $true; Send-Button $name $false }
}
# A mouse button held down or let go; nothing when it already is.
function Set-Button($name, [bool]$down) {
    Assert-Button $name
    if ($down -eq $held.Contains($name)) { return }
    Send-Button $name $down
    if ($down) { [void]$held.Add($name) } else { [void]$held.Remove($name) }
}

<#
How a text goes into the focused field. Facts: text, framework, className, rich (a Chromium field with children:
contenteditable). Answers characters (typed as is), shift-enter, enter or carriage-return (lines typed with that
break between them), or paste.
A line break must never press plain Enter where Enter sends (chat inputs): Chromium rich-text fields take
Shift+Enter, their newline and the only break that leaves their caret on the new line. Classic Windows edit boxes
paste only once after UI Automation read them (WinForms), so no clipboard there: an Edit takes a typed carriage
return (not the Enter key, which a dialog would take for its default button), a RichEdit only the Enter key. Other
fields get a pasted line break, a real paragraph break.
#>
function Select-InsertStrategy($facts) {
    if (-not ([string]$facts.text).Contains("`n")) { return 'characters' }
    if ($facts.framework -eq 'Chrome' -and $facts.rich) { return 'shift-enter' }
    if ($facts.className -match '(^|\.)RichEdit\w*(\.|$)') { return 'enter' }
    if ($facts.className -match '(^|\.)Edit(\.|$)') { return 'carriage-return' }
    return 'paste'
}

function Send-Characters([string]$text) {
    if ($text.Length -and -not [NativeInput]::Text($text)) { throw 'Windows rejected text input' }
}
# Types text at the caret of the focused field, line breaks included; done when it returns (a paste has landed and
# the clipboard is the user's again).
function Insert-Text([string]$text) {
    $element = if ($text.Contains("`n")) { [System.Windows.Automation.AutomationElement]::FocusedElement } else { $null }
    $facts = @{ text=$text }
    if ($null -ne $element) {
        $facts.framework = $element.Current.FrameworkId
        $facts.className = $element.Current.ClassName
        $facts.rich = $facts.framework -eq 'Chrome' -and $null -ne [System.Windows.Automation.TreeWalker]::RawViewWalker.GetFirstChild($element)
    }
    $strategy = Select-InsertStrategy $facts
    if ($strategy -eq 'characters') { return Send-Characters $text }
    if ($strategy -eq 'carriage-return') { return Send-Characters $text.Replace("`n", "`r") }
    if ($strategy -eq 'paste') {
        if (-not [ClipboardText]::Set($text)) { throw 'Clipboard unavailable' }
        try {
            $control = -not $held.Contains('Control')
            if ($control) { Send-Key 'Control' $true }
            try { Tap-Key 'V' } finally { if ($control) { Send-Key 'Control' $false } }
            # The app reads the clipboard after the keys: give it a moment before putting the user's clipboard back.
            Start-Sleep -Milliseconds 150
        } finally { [ClipboardText]::Restore() }
        return
    }
    $lines = $text.Split("`n")
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($index -and $strategy -eq 'enter') { Tap-Key 'Enter' }
        elseif ($index) {
            $shift = -not $held.Contains('Shift')
            if ($shift) { Send-Key 'Shift' $true }
            try { Tap-Key 'Enter' } finally { if ($shift) { Send-Key 'Shift' $false } }
        }
        Send-Characters $lines[$index]
    }
}

# Typing where the phone cannot read the field: Backspaces, then Deletes, then the text.
function Invoke-Typing([int]$backspaces, [int]$deletes, [string]$text) {
    if ($backspaces -lt 0 -or $deletes -lt 0 -or $backspaces + $deletes -gt 4096 -or $text.Length -gt 16384) { throw 'Invalid text operation' }
    for ($index = 0; $index -lt $backspaces; $index++) { Tap-Key 'Backspace' }
    for ($index = 0; $index -lt $deletes; $index++) { Tap-Key 'Delete' }
    if ($text.Length) { Insert-Text $text }
}

function Release-All {
    [Glider]::Stop()
    foreach ($name in @($held)) {
        if ($buttons.ContainsKey($name)) { [void][NativeInput]::Mouse($buttons[$name][1], [int]$buttons[$name][2]) }
        elseif ($keyCodes.ContainsKey($name)) { [void][NativeInput]::Key($keyCodes[$name], $false) }
        [void]$held.Remove($name)
    }
    [Dongle]::Release()
}

$mediaSessions = $null
function Get-MediaState {
    $muted = $null
    try { $muted = [SpeakerVolume]::Muted() } catch {}
    $playing = $null
    try {
        if ($null -eq $script:mediaSessions) {
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
            $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
                $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
            } | Select-Object -First 1
            $script:mediaSessions = $asTask.MakeGenericMethod($managerType).Invoke($null, @($managerType::RequestAsync())).Result
        }
        $session = $script:mediaSessions.GetCurrentSession()
        $playing = $null -ne $session -and [string]$session.GetPlaybackInfo().PlaybackStatus -eq 'Playing'
    } catch {}
    return @{ muted=$muted; playing=$playing }
}

Export-ModuleMember -Function Tap-Key, Set-Key, Test-ModifierHeld, Invoke-Shortcut, Invoke-Click, Set-Button, Select-InsertStrategy, Insert-Text, Invoke-Typing, Release-All, Get-MediaState
