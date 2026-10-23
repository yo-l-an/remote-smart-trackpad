# The mirror (CONTEXT.md) on the PC side: reads the focused field through UI Automation and applies the phone's edits
# to it. What the facts mean is decided by mirror-rules.psm1; this module gathers them and acts.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'native.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'input.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'mirror-rules.psm1') -DisableNameChecking

# The field being mirrored: id (the session the phone edits against), revision, element, text, start, end,
# lastOperation (the phone's last edit, applied once), believed (a caret the PC misreports, see Edit-Mirror).
$mirror = $null
# Verdicts cost tens of milliseconds (IAccessible2) and only change with the field, its text or the caret.
$resolvedField = $null
$readOnlyField = $null

# Chromium exposes a <br> that ends a line with other content as a final line break the caret can never reach.
# An empty line (<div><br></div>, <p><br></p>) is real: its break is the only content of its block.
function Test-PhantomBreak($element) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $node = $walker.GetLastChild($element)
    while ($null -ne $node) {
        $last = $walker.GetLastChild($node)
        if ($null -eq $last) { break }
        $node = $last
    }
    return $null -ne $node -and $node.Current.Name -eq "`n" -and $null -ne $walker.GetPreviousSibling($node)
}

# The facts Get-FieldVerdict decides on, for the focused element.
function Get-FieldFacts($element, [string]$text, [int]$caret) {
    $current = $element.Current
    $content = $null
    if ($current.FrameworkId -in @('Chrome', 'Gecko')) {
        # Right after a focus change IAccessible2 can lag behind UI Automation for a moment (Firefox then reports no
        # tag yet; all its fields have one, its own interface included).
        for ($attempt = 0; $attempt -lt 3 -and ($null -eq $content -or ($current.FrameworkId -eq 'Gecko' -and -not $content.Dom)); $attempt++) {
            if ($attempt) { Start-Sleep -Milliseconds 30 }
            $content = [FieldContent]::Focused($current.Name)
        }
    }
    $box = $current.BoundingRectangle
    return @{
        framework=$current.FrameworkId; className=$current.ClassName; name=$current.Name; text=$text; caret=$caret
        boxWidth=$box.Width; boxHeight=$box.Height
        win32SingleLine=[FieldContent]::Win32SingleLine([IntPtr]$current.NativeWindowHandle, $current.ClassName)
        win32Digits=[FieldContent]::Win32Digits([IntPtr]$current.NativeWindowHandle, $current.ClassName)
        windowClass=[FieldContent]::FocusedWindowClass()
        content=if ($null -eq $content) { $null } else {
            @{ dom=$content.Dom; native=$content.Native; valueLength=$content.Value.Length; editableText=$content.EditableText
               editableObject=$content.EditableObject; leafless=$content.Leafless; singleLine=$content.SingleLine
               inputType=$content.InputType }
        }
    }
}
function Resolve-FieldText($element, [string]$text, [int]$caret) {
    $cached = $script:resolvedField
    if ($null -ne $cached -and $cached.caret -eq $caret -and $cached.text -ceq $text -and $element.Equals($cached.element)) {
        return $cached.verdict
    }
    $facts = Get-FieldFacts $element $text $caret
    $verdict = Get-FieldVerdict $facts
    $script:resolvedField = @{ element=$element; text=$text; caret=$caret; facts=$facts; verdict=$verdict }
    return $verdict
}
# The facts and verdict of the last field read (tests/checks/placeholder-probe.ps1 records them for the rules' tests).
function Get-LastFieldVerdict {
    if ($null -eq $script:resolvedField) { return $null }
    return @{ facts=$script:resolvedField.facts; verdict=$script:resolvedField.verdict }
}

# UI Automation calls fail for a moment while an app rebuilds the field it reads (Chromium after a Backspace: the
# element or its text range is gone). Reading again a little later finds the new one; a lasting failure still throws.
function Read-Mirror {
    for ($attempt = 1; ; $attempt++) {
        try { return Read-MirrorOnce }
        catch {
            if ($attempt -ge 3) { throw }
            Start-Sleep -Milliseconds 25
        }
    }
}

# What a field without readable text takes, for the phone's keyboard: asked of IAccessible2 once per element, not at
# every read; again, up to three times, while it has not answered (right after a focus change it can lag behind UI
# Automation for a moment).
function Get-ElementKind($element, [string]$field) {
    if ($null -eq $element -or $element.Current.IsPassword) { return 'text' }
    $known = $script:elementKind
    if ($null -ne $known -and $known.field -ceq $field -and ($known.settled -or $known.tries -ge 3)) { return $known.kind }
    $current = $element.Current
    $content = [FieldContent]::Focused($current.Name)
    $kind = Get-FieldKind @{
        className=$current.ClassName; windowClass=[FieldContent]::FocusedWindowClass()
        win32Digits=[FieldContent]::Win32Digits([IntPtr]$current.NativeWindowHandle, $current.ClassName)
        content=if ($null -eq $content) { $null } else { @{ inputType=$content.InputType } }
    }
    $tries = if ($null -ne $known -and $known.field -ceq $field) { $known.tries + 1 } else { 1 }
    $script:elementKind = @{ field=$field; kind=$kind; tries=$tries; settled=($null -ne $content -and $content.Dom) }
    return $kind
}

function Read-MirrorOnce {
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    # Which UI element has the focus, readable or not: the phone keeps what it typed blind while this stays the same.
    $field = if ($null -ne $element) { ($element.GetRuntimeId() -join '.') } else { '' }
    $pattern = $null
    $valuePattern = $null
    if ($null -eq $element -or $element.Current.IsPassword -or
        -not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $script:mirror = $null
        return @{ field=$field; readable=$false; text=''; selectionStart=0; selectionEnd=0; kind=(Get-ElementKind $element $field) }
    }
    # A value reported read-only (Firefox reports its search boxes so, though they take typing): typed blind.
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern) -and $valuePattern.Current.IsReadOnly) {
        $script:mirror = $null
        return @{ field=$field; readable=$false; text=''; selectionStart=0; selectionEnd=0; kind=(Get-ElementKind $element $field) }
    }
    # Some providers refuse to report it at times (WPF's RichTextBox): the field cannot be followed, type blind.
    $ranges = try { $pattern.GetSelection() } catch { $null }
    if ($null -eq $ranges -or $ranges.Count -ne 1) { $script:mirror = $null; return @{ field=$field; readable=$false; text='' } }
    $document = $pattern.DocumentRange
    # Read-only text (a web page rather than a field). The selection is the cheap hint; a caret next to a
    # non-editable part (a placeholder, a mention) reads read-only too, so the whole document confirms it. That scan
    # takes up to seconds in a long text area, so its answer is kept for the field.
    if ($ranges[0].GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute) -eq $true) {
        $known = $script:readOnlyField
        if ($null -eq $known -or -not $element.Equals($known.element)) {
            $known = @{ element=$element; readOnly=($document.GetAttributeValue([System.Windows.Automation.TextPattern]::IsReadOnlyAttribute) -eq $true) }
            $script:readOnlyField = $known
        }
        if ($known.readOnly) {
            $script:mirror = $null
            return @{ field=$field; readable=$false; text='' }
        }
    }
    $raw = $document.GetText(262145)
    if ($raw.Length -gt 262144) { $script:mirror = $null; return @{ field=$field; readable=$false; text=''; reason='This field exceeds the 256 Ki character mirror limit.' } }
    $text = Normalize-MirrorText $raw
    $prefix = $document.Clone()
    $prefix.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $ranges[0], [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
    $start = (Normalize-MirrorText ($prefix.GetText(262145))).Length
    # The end follows from the selected text itself, without reading the text before it a second time.
    $end = $start + (Normalize-MirrorText ($ranges[0].GetText(262145))).Length
    $resolved = Resolve-FieldText $element $text $start
    if ($resolved.unreadable) {
        $script:mirror = $null
        $unread = @{ field=$field; readable=$false; text=''; selectionStart=0; selectionEnd=0; reason='Text not readable here'; kind=(Get-FieldKind $script:resolvedField.facts) }
        # What it reports anyway, around its caret (a code editor's hidden input holds the line being edited): the
        # phone finds where a click put the caret in the text it typed blind. Not its accessible name, which is no
        # text of the field (VS Code's EditContext editor reads only that).
        if ($text -cne $element.Current.Name) {
            $from = [Math]::Max(0, $start - 2000)
            $unread.around = $text.Substring($from, [Math]::Min($text.Length - $from, 4000))
            $unread.caret = $start - $from
        }
        return $unread
    }
    if ($resolved.empty) { $text = ''; $start = 0; $end = 0 }
    $framework = $element.Current.FrameworkId
    $phantomBreak = $framework -eq 'Chrome' -and -not $resolved.native -and $text.EndsWith("`n") -and (Test-PhantomBreak $element)
    $repaired = Repair-MirrorText @{ framework=$framework; className=$element.Current.ClassName; native=$resolved.native; text=$text; start=$start; end=$end; phantomBreak=$phantomBreak }
    $text = $repaired.text; $start = $repaired.start; $end = $repaired.end
    # Inline objects (Discord's emoji images) as one character each; positions on the phone go back through rawAt.
    $objects = $null
    if ($framework -eq 'Chrome' -and -not $resolved.native) {
        $view = Get-InlineObjectView @{ text=$text; start=$start; end=$end }
        if ($null -ne $view.rawAt) { $objects = @{ text=$view.text; rawAt=$view.rawAt; raw=$text } }
        $text = $view.text; $start = $view.start; $end = $view.end
    }
    # Chromium can misreport the caret on an empty line; after our own edit the caret position is known instead.
    $believed = if ($null -ne $script:mirror -and $element.Equals($script:mirror.element)) { $script:mirror.believed } else { $null }
    if ($null -ne $believed) {
        if ($believed.text -ceq $text -and $believed.reportedStart -eq $start -and $believed.reportedEnd -eq $end) {
            $start = $believed.start; $end = $believed.end
        } else { $script:mirror.believed = $null }
    }
    if ($null -eq $script:mirror -or -not $element.Equals($script:mirror.element)) {
        $script:mirror = @{ id=[guid]::NewGuid().ToString('N'); revision=0; element=$element; text=$text; start=$start; end=$end; lastOperation=$null; believed=$null }
    } elseif ($text -cne $script:mirror.text -or $start -ne $script:mirror.start -or $end -ne $script:mirror.end) {
        $script:mirror.revision++
        $script:mirror.text=$text; $script:mirror.start=$start; $script:mirror.end=$end
    }
    $script:mirror.objects = $objects
    # singleLine: the field cannot hold a line break (an <input>, a one-line edit box): the phone's Enter key sends
    # Enter there instead of a new line.
    return @{ field=$field; readable=$true; session=$script:mirror.id; revision=$script:mirror.revision; text=$text; selectionStart=$start; selectionEnd=$end; singleLine=($resolved.singleLine -eq $true); kind=(Get-FieldKind $script:resolvedField.facts) }
}

# A read the phone already has (same session and revision) is answered as unchanged.
function Read-MirrorFor($session, $revision) {
    $read = Read-Mirror
    if ($read.readable -and $read.session -ceq [string]$session -and $read.revision -eq $revision) { return @{ unchanged=$true } }
    return $read
}

# The phone closed its editor: the next read starts a new session.
function Close-Mirror { $script:mirror = $null }

function Select-MirrorRange([int]$start, [int]$end, [string]$text) {
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $element.Equals($script:mirror.element)) { throw 'PC focus changed' }
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $range = $pattern.DocumentRange.Clone()
    # With inline objects, the phone's positions stand in the reported text through rawAt (Get-InlineObjectView).
    $reported = $text; $rawStart = $start; $rawEnd = $end
    $objects = $script:mirror.objects
    if ($null -ne $objects -and $objects.text -ceq $text) {
        $reported = $objects.raw; $rawStart = $objects.rawAt[$start]; $rawEnd = $objects.rawAt[$end]
    }
    $elements = [System.Globalization.StringInfo]::ParseCombiningCharacters($reported)
    $from = Get-ElementIndex $elements $rawStart $reported.Length
    $to = Get-ElementIndex $elements $rawEnd $reported.Length
    $range.MoveEndpointByRange([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, $range, [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
    if ($range.MoveEndpointByUnit([System.Windows.Automation.Text.TextPatternRangeEndpoint]::End, [System.Windows.Automation.Text.TextUnit]::Character, $to) -ne $to) { throw 'PC text range cannot be selected' }
    if ($range.MoveEndpointByUnit([System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start, [System.Windows.Automation.Text.TextUnit]::Character, $from) -ne $from) { throw 'PC text range cannot be selected' }
    if ((Normalize-MirrorText ($range.GetText(262145))) -cne $reported.Substring($rawStart, $rawEnd - $rawStart)) { throw 'PC text range differs' }
    # A caret at the start of a line is ambiguous in Chromium: it can resolve to the end of the previous line. Place
    # it instead right after the last real character before the line breaks, then step over them with Right.
    if ($start -eq $end -and $start -gt 0 -and $text[$start - 1] -eq "`n" -and -not (Test-ModifierHeld)) {
        $anchor = $start
        while ($anchor -gt 0 -and $text[$anchor - 1] -eq "`n") { $anchor-- }
        Select-MirrorRange $anchor $anchor $text
        for ($step = $anchor; $step -lt $start; $step++) { Tap-Key 'Right' }
        return
    }
    $range.Select()
}

# Backspace until exactly the erased text is gone, reading the field after each: in an emoji sequence (surrogates,
# skin tones, joiners) apps erase one character or a part of it per Backspace, and .NET counts its parts apart.
function Remove-BeforeCaret([string]$old, [int]$start, [int]$end, $session) {
    $erased = $old.Substring($start, $end - $start)
    if ($erased -notmatch '[\uD800-\uDFFF\u200D\uFE0E\uFE0F\u20E3]') {
        $removed = (New-Object System.Globalization.StringInfo $erased).LengthInTextElements
        for ($index = 0; $index -lt $removed; $index++) { Tap-Key 'Backspace' }
        return
    }
    $remaining = $old.Substring(0, $start) + $old.Substring($end)
    $current = $old
    for ($press = 0; $press -lt $erased.Length -and $current -cne $remaining -and $current.Length -gt $remaining.Length; $press++) {
        Tap-Key 'Backspace'
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            $read = Read-Mirror
            if ($read.session -cne $session -or $read.text -cne $current) { break }
            Start-Sleep -Milliseconds 10
        }
        if ($read.session -cne $session) { return }
        $current = $read.text
    }
}

# Reads the field until the edit settles (Get-EditOutcome), at most about a second: the last read and its outcome.
function Wait-EditOutcome([string]$old, [string]$next, [int]$landed, $session) {
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $seen = $null; $seenAt = 0
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $read = Read-Mirror
        if ($read.text -cne $seen) { $seen = $read.text; $seenAt = $clock.ElapsedMilliseconds }
        $outcome = Get-EditOutcome @{ old=$old; next=$next; landed=$landed; session=$session; read=$read; stableMs=($clock.ElapsedMilliseconds - $seenAt) }
        if ($outcome -ne 'pending') { break }
        Start-Sleep -Milliseconds 10
    }
    return @{ read=$read; outcome=$outcome }
}

# Applies one phone edit (replace start..end with text, then the selection) to the field it was made against.
function Edit-Mirror($data) {
    $snapshot = Read-Mirror
    if (-not $snapshot.readable -or $snapshot.session -cne [string]$data.session -or $snapshot.revision -ne [int]$data.revision) {
        return @{ accepted=$false; snapshot=$snapshot }
    }
    if ([string]::IsNullOrWhiteSpace([string]$data.operationId)) { throw 'Missing operation identifier' }
    if ($script:mirror.lastOperation -ceq [string]$data.operationId) { return @{ accepted=$true; snapshot=$snapshot } }
    $old = $snapshot.text
    $start=[int]$data.start; $end=[int]$data.end; $insert=[string]$data.text
    if ($start -lt 0 -or $end -lt $start -or $end -gt $old.Length -or $insert.Length -gt 16384) { throw 'Invalid text operation' }
    $next = $old.Substring(0,$start) + $insert + $old.Substring($end)
    if ($next.Length -gt 262144) { throw 'Mirror field limit exceeded' }
    $selectionStart=[int]$data.selectionStart; $selectionEnd=[int]$data.selectionEnd
    if ($selectionStart -lt 0 -or $selectionEnd -lt $selectionStart -or $selectionEnd -gt $next.Length) { throw 'Invalid selection' }
    $changed = $old -cne $next
    $landed = $start + $insert.Length
    if ($changed) {
        # Edits at the caret (typing, Backspace, a new line) never reposition it: UI Automation character offsets
        # are unreliable around empty lines in rich-text fields, so the caret stays where the app put it.
        $atCaret = $snapshot.selectionStart -eq $snapshot.selectionEnd -and $snapshot.selectionEnd -eq $end
        $overSelection = $snapshot.selectionStart -eq $start -and $snapshot.selectionEnd -eq $end -and $start -ne $end
        if (-not $atCaret -and -not $overSelection) { Select-MirrorRange $start $end $old }
        if (-not ([System.Windows.Automation.AutomationElement]::FocusedElement).Equals($script:mirror.element)) { return @{ accepted=$false; snapshot=(Read-Mirror) } }
        if ($atCaret) {
            Remove-BeforeCaret $old $start $end $snapshot.session
            if ($insert.Length) { Insert-Text $insert }
        } elseif ($insert.Length) { Insert-Text $insert }
        elseif ($overSelection) { Tap-Key 'Backspace' }
        else { Tap-Key 'Delete' }
        $settled = Wait-EditOutcome $old $next $landed $snapshot.session
        # Typed, but the field holds something else: the phone takes the PC's text, never sends the same typing again.
        if ($settled.outcome -notin @('applied', 'completed')) { return @{ accepted=$false; typed=$true; snapshot=$settled.read } }
        # The field completed the typing itself and selected the suggestion: the PC's caret and selection stay.
        if ($settled.outcome -eq 'completed') {
            $script:mirror.lastOperation=[string]$data.operationId
            $script:mirror.believed = $null
            return @{ accepted=$true; snapshot=(Read-Mirror) }
        }
    }
    $script:mirror.lastOperation=[string]$data.operationId
    $natural = $changed -and $selectionStart -eq $landed -and $selectionEnd -eq $landed
    # After typing the caret already sits after the edit; otherwise it is placed where the phone's caret is.
    if (-not $natural) { Select-MirrorRange $selectionStart $selectionEnd $next }
    # Chromium can report the caret at the start of a new empty paragraph one line up after typing; remember where
    # typing put it. A placed caret is reported as is, so a failed placement stays visible on the phone.
    $script:mirror.believed = $null
    $final = Read-Mirror
    if ($natural -and $final.session -ceq $snapshot.session -and $final.text -ceq $next -and
            ($final.selectionStart -ne $selectionStart -or $final.selectionEnd -ne $selectionEnd)) {
        $script:mirror.believed = @{ text=$next; reportedStart=$final.selectionStart; reportedEnd=$final.selectionEnd; start=$selectionStart; end=$selectionEnd }
        $final = Read-Mirror
    }
    return @{ accepted=$true; snapshot=$final }
}

Export-ModuleMember -Function Read-Mirror, Read-MirrorFor, Edit-Mirror, Close-Mirror, Get-LastFieldVerdict
