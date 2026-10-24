# The mirror's rules (docs/adr/0002): pure decisions on facts read from the PC, no UI Automation, no input. The
# mirror (text-mirror.psm1) gathers the facts and acts on the answers; tests/unit/host-rules.test.mjs feeds them recorded
# facts.
$ErrorActionPreference = 'Stop'

function Normalize-LineEndings([string]$text) { return $text.Replace("`r`n", "`n").Replace("`r", "`n") }

# The text as the phone gets it: one kind of line break, and plain spaces. Rich-text fields keep a space typed at the
# end of a line as a no-break space until more text follows; the user typed a space, and an edit checked against
# its own text must find one there.
function Normalize-MirrorText([string]$text) { return (Normalize-LineEndings $text).Replace([string][char]0xA0, ' ') }

# Zero-width anchors editors keep in empty lines, and the embedded-object marker, show nothing.
$invisible = '\uFEFF\u200B-\u200D\u2060\uFFFC'
function Test-VisibleCharacter([string]$text) { return $text -match "[^\s$invisible]" }
function Test-OnlyAnchors([string]$text) { return $text -notmatch "[^$invisible]" }

# The index of the text element (grapheme) starting at $position; the end of the text counts as one past the last.
function Get-ElementIndex([int[]]$starts, [int]$position, [int]$textLength) {
    if ($position -eq $textLength) { return $starts.Length }
    $index = [Array]::BinarySearch($starts, $position)
    if ($index -lt 0) { throw 'Text operation splits a character' }
    return $index
}

<#
What a focused field's text really is (CONTEXT.md: Readable, Placeholder). Facts: framework, className, windowClass
(see Get-FieldKind), name (accessible name), text, caret (selection start in that text), boxWidth, boxHeight,
win32SingleLine (a classic edit box without the multi-line style), content (what IAccessible2 tells, null without it: dom, native, valueLength, editableText,
editableObject, leafless, singleLine). Answers unreadable (the content lives elsewhere: type blind), empty (only a
placeholder, or nothing), native (an <input>/<textarea>) and singleLine.
#>
function Get-FieldVerdict($facts) {
    # A terminal's text is its whole screen and history, not the command being typed (the console reads it so): the
    # phone types blind.
    if ((Get-FieldKind $facts) -eq 'terminal') { return @{ unreadable=$true; empty=$true } }
    $content = $facts.content
    if ($null -eq $content) {
        # Without IAccessible2, an input that hides its content exposes its accessible name as text instead. A
        # classic Windows edit box tells single-line from multi-line by its window style.
        return @{ unreadable=($facts.text.Length -and $facts.text -ceq $facts.name); empty=$false; singleLine=($facts.win32SingleLine -eq $true) }
    }
    # An editor built on the EditContext API (VS Code's, Monaco's) draws its document itself: the element holds its
    # accessible name ("The editor is not accessible at this time"), or for a moment the few characters the editor
    # hands the keyboard, never the document. Mirroring that would show the phone an empty field: it types blind.
    if ($facts.framework -eq 'Chrome' -and $facts.className -ceq 'native-edit-context') { return @{ unreadable=$true; empty=$true } }
    # Chrome's own text fields (its address bar): their text is the user's, except that empty they read as their name.
    if (-not $content.dom -and $facts.framework -eq 'Chrome') {
        return @{ unreadable=$false; empty=($facts.text -ceq $facts.name); singleLine=($content.singleLine -eq $true) }
    }
    if ($content.native) {
        # A field too small to show any text is the hidden input of an editor drawn elsewhere (VS Code's editor and
        # terminal): unreadable, the phone types blind. Whatever it holds: such an editor leaves each typed character
        # in it for a moment, and mirroring that would echo the character back on the phone, typed a second time.
        if ($facts.boxWidth -lt 20 -or $facts.boxHeight -lt 8) { return @{ unreadable=$true; empty=$true; native=$true } }
        # <input>/<textarea>: the value is the content. Empty, UI Automation reads the placeholder as an embedded
        # object (U+FFFC) or the accessible name instead.
        return @{ unreadable=$false; empty=(-not $content.valueLength); native=$true; singleLine=($content.singleLine -eq $true) }
    }
    # Rich text (contenteditable): without editable content, any visible text is drawn by the page (a placeholder:
    # CSS generated content, contenteditable=false), and zero-width anchors alone show nothing. Line breaks typed
    # into an empty field are content and stay.
    # Rich text always takes new lines (Enter would send a chat message), even where it calls itself single-line:
    # Firefox does so for a role=textbox without aria-multiline.
    if ($content.editableText -or $content.editableObject) { return @{ unreadable=$false; empty=$false } }
    # Firefox hides the text nodes of role=textbox fields, so nothing tells their text from a generated placeholder;
    # its caret follows the document though, and generated text is out of its reach: a caret past the start can
    # only stand after real text.
    if ($facts.framework -eq 'Gecko' -and $content.leafless -and $facts.caret -gt 0) { return @{ unreadable=$false; empty=$false } }
    return @{ unreadable=$false; empty=((Test-VisibleCharacter $facts.text) -or (Test-OnlyAnchors $facts.text)) }
}

<#
The text and caret a readable field holds once the parts it reports but nobody typed are taken away. Facts:
framework, className, native (from the verdict), text, start, end, phantomBreak (Chromium reports a final line break
the caret can never reach; the mirror asks only when the text ends with one), valueBreak (a native field's value is
its text without the final line break).
#>
function Repair-MirrorText($facts) {
    $text = [string]$facts.text; $start = [int]$facts.start; $end = [int]$facts.end
    $rich = $facts.framework -in @('Chrome', 'Gecko') -and -not $facts.native
    # An emptied rich-text field keeps one <br>, displayed as a single empty line.
    if ($rich -and $text -ceq "`n") { return @{ text=''; start=0; end=0 } }
    $trimmed = $false
    if ($rich -and $facts.framework -eq 'Chrome' -and $text.EndsWith("`n") -and $facts.phantomBreak) { $trimmed = $true }
    # A Chromium textarea ending with a line break reports one more, which its value has not.
    if ($facts.framework -eq 'Chrome' -and $facts.native -and $text.EndsWith("`n") -and $facts.valueBreak) { $trimmed = $true }
    # A Windows rich edit box (RichEdit, WinForms' RichTextBox) ends with a paragraph mark the caret never passes.
    if ($facts.framework -in @('Win32', 'WinForm') -and $facts.className -like '*RichEdit*' -and $text.EndsWith("`n")) { $trimmed = $true }
    if ($trimmed) {
        $text = $text.Substring(0, $text.Length - 1)
        $start = [Math]::Min($start, $text.Length); $end = [Math]::Min($end, $text.Length)
    }
    return @{ text=$text; start=$start; end=$end }
}

<#
What the phone shows for an inline emoji image, from its name: the emoji itself when the name is one (Discord's alt
for a standard emoji) or names a known one, by its shortcode (":joy:", Discord's alt) or by Slack's label ("joy
emoji", "rolling on the floor laughing emoji": the shortcode in words); a custom emoji as its shortcode (":party:");
a dotted square without a name that reads as one. emoji-names.json (scripts/generate-emoji-names.mjs) holds the known
shortcodes, loaded at the first emoji.
#>
$emojiNames = $null
function Get-ObjectDisplay([string]$name) {
    $square = [string][char]0x2B1A
    $name = $name.Trim()
    if (-not $name -or $name.Length -gt 64) { return $square }
    # No letter, digit or colon: the emoji itself.
    if ($name -notmatch '[\p{L}\p{N}:_]') { return $name }
    $shortcode = [regex]::Match($name, '^:([^:\s]+):$')
    $code = if ($shortcode.Success) { $shortcode.Groups[1].Value } else { ($name -replace '\s+emoji$', '') -replace '\s+', '_' }
    # Read as a shortcode, unknown: only from a shortcode, Slack's label or a single word (not "a photo of Bob").
    $coded = $shortcode.Success -or $name -match '\semoji$' -or $name -notmatch '\s'
    if ($null -eq $script:emojiNames) {
        $script:emojiNames = @{}
        $table = ConvertFrom-Json ([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'emoji-names.json'), [System.Text.Encoding]::UTF8))
        foreach ($entry in $table.PSObject.Properties) { $script:emojiNames[$entry.Name] = [string]$entry.Value }
    }
    $emoji = $script:emojiNames[$code.ToLowerInvariant()]
    if ($emoji) { return $emoji }
    if ($coded -and $code -match '^[\w+-]+$') { return ":${code}:" }
    return $square
}

<#
Inline objects in Chromium rich text: an emoji image in Discord's message box, any inline element a Slate editor keeps
uneditable. Chromium reports each on lines of its own, none of which the field shows: a line break, the
embedded-object marker (U+FFFC), a line break, the image's alt text and a line break when it has one (":sweat_smile:"),
then the editor's zero-width anchor and a line break. The phone gets each object as Get-ObjectDisplay shows it, which
counts as one character, as on the PC: its caret stops only at the object's edges. Facts: text, start, end (the caret
and selection in it), names (each object's name, from its element; else its alt line counts). Answers text, start and end as the phone gets them; objects, the
[start, end] of each object in that text; and rawAt: rawAt[i] is where the phone's position i stands in the reported
text, an object's start for a position inside it (null when the text holds no such object). A caret inside an
object's lines stands after it. The editor's zero-width anchors (U+FEFF: Slate's in an empty line, and beside an
object at a line's start or end) are no text the field shows: the phone gets none, so a blank line is empty there and
typing after an emoji types nothing but what was typed.
#>
# The line break after the anchor shows only when nothing follows on its line (a space between two emojis does); an
# object right after another shares that one's break instead of opening its own.
$inlineObject = '(?:\n|(?<=\uFEFF\n))\uFFFC\n(?:([^\n\uFFFC]*)\n)??\uFEFF\n?'
function Get-InlineObjectView($facts) {
    $text = [string]$facts.text
    $found = [regex]::Matches($text, $inlineObject)
    if (-not $found.Count -and $text.IndexOf([char]0xFEFF) -lt 0) { return @{ text=$text; start=[int]$facts.start; end=[int]$facts.end; objects=@(); rawAt=$null } }
    $view = New-Object System.Text.StringBuilder
    $rawAt = New-Object 'System.Collections.Generic.List[int]'
    $objects = New-Object 'System.Collections.Generic.List[object]'
    # The objects' own names, when there is one for each (their image elements, in order); else their alt lines.
    $names = $null
    if ($null -ne $facts.names -and @($facts.names).Count -eq $found.Count) { $names = @($facts.names) }
    $from = 0
    foreach ($object in $found) {
        for ($index = $from; $index -lt $object.Index; $index++) { if ($text[$index] -ne [char]0xFEFF) { $rawAt.Add($index); [void]$view.Append($text[$index]) } }
        $name = Get-ObjectDisplay $(if ($null -ne $names) { [string]$names[$objects.Count] } else { $object.Groups[1].Value })
        $objects.Add(@($view.Length, ($view.Length + $name.Length)))
        foreach ($character in $name.ToCharArray()) { $rawAt.Add($object.Index); [void]$view.Append($character) }
        $from = $object.Index + $object.Length
    }
    for ($index = $from; $index -lt $text.Length; $index++) { if ($text[$index] -ne [char]0xFEFF) { $rawAt.Add($index); [void]$view.Append($text[$index]) } }
    $rawAt.Add($text.Length)
    $at = $rawAt.ToArray()
    # The first position of the view at or after a reported one: an object's start, or past it.
    $position = { param([int]$raw) for ($index = 0; $index -lt $at.Length; $index++) { if ($at[$index] -ge $raw) { return $index } }; return $at.Length - 1 }
    return @{ text=$view.ToString(); start=(& $position $facts.start); end=(& $position $facts.end); objects=$objects.ToArray(); rawAt=$at }
}

<#
Blank lines in ProseMirror and Quill fields (Claude Desktop, tiptap, Slack): Chromium's text of the field drops or keeps its empty
paragraphs depending on where they stand and how many follow each other, though each stays an element of its own. The
text is rebuilt from the paragraphs instead, each on its line, whatever the field's text says. Facts: text (the
field's), start, end, paragraphs (each paragraph's text, a lone line break for an empty one), and for each end of the
selection the paragraph holding it and how far into it (startParagraph and startOffset, endParagraph and endOffset;
caretParagraph names the paragraph of both, -1 or missing when unknown). Answers text, start and end as the phone gets
them; lines, where each paragraph's line starts in that text; and rawAt as Get-InlineObjectView does when the
field's text lines up with the paragraphs (null otherwise, and the text left as it is when no paragraph is empty). An
end without its paragraph falls back on the field's text: the first position at or after it there, when they line up,
else the text's start.
#>
# An inline object in a paragraph's text, with the line breaks Chromium sets around it (see Get-ParagraphView).
$paragraphObject = "`n?" + [char]0xFFFC + "`n?"
function Get-ParagraphView($facts) {
    $raw = [string]$facts.text
    $texts = @(@($facts.paragraphs) | ForEach-Object { if ([string]$_ -ceq "`n") { '' } else { [string]$_ } })
    # Inline objects (Slack's emoji images), each shown as Get-ObjectDisplay does, from its name (names: one per
    # object of the field, in order; else none). Chromium sets each between line breaks of its own, one between two
    # objects, none at the paragraph's edges. offsets[p][i]: where position i of paragraph p's line stands in that
    # paragraph's text (UI Automation steps through each of its characters); objects: [start, end] of each in the text.
    $marks = @($texts | ForEach-Object { [regex]::Matches($_, $paragraphObject).Count })
    $markCount = ($marks | Measure-Object -Sum).Sum
    $names = $null
    if ($null -ne $facts.names -and @($facts.names).Count -eq $markCount) { $names = @($facts.names) }
    $offsets = New-Object 'System.Collections.Generic.List[object]'
    $localObjects = New-Object 'System.Collections.Generic.List[object]'
    $named = 0
    for ($index = 0; $index -lt $texts.Count; $index++) {
        $source = $texts[$index]
        $found = [regex]::Matches($source, $paragraphObject)
        if (-not $found.Count) { $offsets.Add($null); $localObjects.Add(@()); continue }
        $view = New-Object System.Text.StringBuilder
        $at = New-Object 'System.Collections.Generic.List[int]'
        $ranges = New-Object 'System.Collections.Generic.List[object]'
        $from = 0; $after = -1
        foreach ($object in $found) {
            for ($position = $from; $position -lt $object.Index; $position++) {
                $at.Add($(if ($after -ge 0) { $after } else { $position })); $after = -1
                [void]$view.Append($source[$position])
            }
            $shown = Get-ObjectDisplay $(if ($null -ne $names) { [string]$names[$named] } else { '' })
            $named++
            $ranges.Add(@($view.Length, ($view.Length + $shown.Length)))
            # Before the object: before its first line break; inside it, the same; after it: past its line breaks
            # (a caret right after the marker, Chromium places before the image).
            $at.Add($(if ($after -ge 0) { $after } else { $object.Index }))
            for ($step = 1; $step -lt $shown.Length; $step++) { $at.Add($object.Index) }
            [void]$view.Append($shown)
            $after = $object.Index + $object.Length
            $from = $object.Index + $object.Length
        }
        for ($position = $from; $position -lt $source.Length; $position++) {
            $at.Add($(if ($after -ge 0) { $after } else { $position })); $after = -1
            [void]$view.Append($source[$position])
        }
        $at.Add($(if ($after -ge 0) { $after } else { $source.Length }))
        $texts[$index] = $view.ToString()
        $offsets.Add($at.ToArray()); $localObjects.Add($ranges.ToArray())
    }
    # A paragraph's offset (its text before a selection's end) as a position of its line: within an object's line
    # breaks, before or after it, whichever side of its marker.
    $inLine = {
        param([int]$paragraph, $offset)
        if ($null -eq $offset -or $paragraph -lt 0 -or $paragraph -ge $offsets.Count -or $null -eq $offsets[$paragraph]) { return $offset }
        $at = $offsets[$paragraph]; $wanted = [int]$offset
        foreach ($object in [regex]::Matches([string]$facts.paragraphs[$paragraph], $paragraphObject)) {
            $marker = $object.Index + $object.Value.IndexOf([char]0xFFFC)
            if ($wanted -gt $object.Index -and $wanted -le $marker) { $wanted = $object.Index }
            elseif ($wanted -gt $marker -and $wanted -lt $object.Index + $object.Length) { $wanted = $object.Index + $object.Length }
        }
        for ($position = 0; $position -lt $at.Length; $position++) { if ($at[$position] -ge $wanted) { return $position } }
        return $at.Length - 1
    }
    $startOffset = & $inLine ([int]$(if ($null -ne $facts.startParagraph) { $facts.startParagraph } else { -1 })) $facts.startOffset
    $endOffset = & $inLine ([int]$(if ($null -ne $facts.endParagraph) { $facts.endParagraph } else { -1 })) $facts.endOffset
    $filled = @($texts | Where-Object { $_.Length })
    if ($filled.Count -eq $texts.Count -and -not $markCount) { return @{ text=$raw; start=[int]$facts.start; end=[int]$facts.end; rawAt=$null; lines=$null } }
    # How the field's text lines up with the paragraphs, when it does: Chromium writes no line break for an empty
    # paragraph in the middle, and one for each at the end (once a final one is off, the mirror taking it away).
    $joined = $filled -join "`n"
    $lastFilled = -1
    for ($index = 0; $index -lt $texts.Count; $index++) { if ($texts[$index].Length) { $lastFilled = $index } }
    $tail = $raw.Length - $joined.Length
    $fits = $tail -ge 0 -and $raw.StartsWith($joined, [StringComparison]::Ordinal) -and
        $raw.Substring($joined.Length) -ceq ("`n" * $tail) -and $tail -le $texts.Count - 1 - $lastFilled
    $view = New-Object System.Text.StringBuilder
    $rawAt = New-Object 'System.Collections.Generic.List[int]'
    $lineStarts = New-Object 'System.Collections.Generic.List[int]'
    $rawStarts = New-Object 'System.Collections.Generic.List[int]'
    $at = 0; $seenFilled = $false
    for ($index = 0; $index -lt $texts.Count; $index++) {
        if ($index) {
            $rawAt.Add($at); [void]$view.Append("`n")
            if ($seenFilled -and $texts[$index].Length) { $at++ }
            elseif ($index -gt $lastFilled -and $tail -gt 0) { $at++; $tail-- }
        }
        $lineStarts.Add($view.Length); $rawStarts.Add($at)
        foreach ($character in $texts[$index].ToCharArray()) { $rawAt.Add($at); [void]$view.Append($character); $at++ }
        if ($texts[$index].Length) { $seenFilled = $true }
    }
    $rawAt.Add($at)
    $map = $rawAt.ToArray()
    $known = { param($value) if ($null -ne $value) { [int]$value } else { -1 } }
    $startParagraph = & $known $facts.startParagraph
    $endParagraph = & $known $facts.endParagraph
    if ($startParagraph -lt 0 -and $endParagraph -lt 0) { $startParagraph = $endParagraph = & $known $facts.caretParagraph }
    $position = {
        param([int]$raw, [int]$paragraph, $offset)
        if ($paragraph -ge 0 -and $paragraph -lt $texts.Count) {
            # Measured in its paragraph; without it, from where the paragraph starts in the field's text.
            $into = if ($null -ne $offset) { [int]$offset } elseif ($fits) { $raw - $rawStarts[$paragraph] } else { 0 }
            return $lineStarts[$paragraph] + [Math]::Max(0, [Math]::Min($texts[$paragraph].Length, $into))
        }
        if (-not $fits) { return 0 }
        for ($index = 0; $index -lt $map.Length; $index++) { if ($map[$index] -ge $raw) { return $index } }
        return $map.Length - 1
    }
    return @{
        text=$view.ToString()
        start=(& $position $facts.start $startParagraph $startOffset)
        end=(& $position $facts.end $endParagraph $endOffset)
        rawAt=$(if ($fits) { $map } else { $null })
        lines=$lineStarts.ToArray()
        offsets=$offsets.ToArray()
        objects=$(
            $all = New-Object 'System.Collections.Generic.List[object]'
            for ($index = 0; $index -lt $texts.Count; $index++) {
                foreach ($range in $localObjects[$index]) { $all.Add(@(($lineStarts[$index] + $range[0]), ($lineStarts[$index] + $range[1]))) }
            }
            ,$all.ToArray()
        )
    }
}

<#
An edit from the phone that cuts into an inline object (Backspace on the end of an emoji's name) takes the whole
object, as one key does on the PC. Facts: start, end, objects (from Get-InlineObjectView). Answers start and end. An
edit that removes nothing (a caret moved, text typed) stays as it is: it never erases an object it falls in.
#>
function Expand-ObjectEdit($facts) {
    $start = [int]$facts.start; $end = [int]$facts.end
    if ($end -eq $start) { return @{ start=$start; end=$end } }
    foreach ($object in @($facts.objects | Where-Object { $null -ne $_ })) {
        if ($start -gt $object[0] -and $start -lt $object[1]) { $start = [int]$object[0] }
        if ($end -gt $object[0] -and $end -lt $object[1]) { $end = [int]$object[1] }
    }
    return @{ start=$start; end=$end }
}

<#
How many characters the PC's caret crosses over text[start..end] of the view: its text elements, each inline object
counting one. Facts: text, start, end, objects.
#>
function Get-CaretSteps($facts) {
    $text = [string]$facts.text; $start = [int]$facts.start; $end = [int]$facts.end
    $steps = (New-Object System.Globalization.StringInfo $text.Substring($start, $end - $start)).LengthInTextElements
    foreach ($object in @($facts.objects | Where-Object { $null -ne $_ })) {
        if ($object[0] -ge $start -and $object[1] -le $end) {
            $steps -= (New-Object System.Globalization.StringInfo $text.Substring($object[0], $object[1] - $object[0])).LengthInTextElements - 1
        }
    }
    return $steps
}

# Inline completion (an address bar, a search box): the field shows what was typed followed by a suggestion it
# selected, so typing on replaces it. That is the typing applied, not a different text.
function Test-InlineCompletion($updated, [string]$next, [int]$landed) {
    $added = $updated.text.Length - $next.Length
    return $updated.readable -and $added -gt 0 -and $updated.selectionStart -eq $landed -and
        $updated.selectionEnd -eq $landed + $added -and $updated.text.StartsWith($next.Substring(0, $landed), [StringComparison]::Ordinal) -and
        $updated.text.EndsWith($next.Substring($landed), [StringComparison]::Ordinal)
}

<#
Where an edit the PC typed stands, from one read of the field. Facts: old and next (the text before, and the text
the edit makes), landed (the caret right after the typing), session (the field typed into), read (the mirror read
now), stableMs (how long its text has stayed the same). Answers:
- moved: the focus left the field;
- applied: the field holds the expected text;
- completed: it holds it with a suggestion it selected after the caret (inline completion);
- reshaped: it made something else of it (an input mask, a case change, a length limit) and stays so;
- pending: not there yet (UI Automation publishes late, a paste lands later still).
#>
function Get-EditOutcome($facts) {
    $read = $facts.read
    if ($read.session -cne $facts.session) { return 'moved' }
    if ($read.text -ceq $facts.next) { return 'applied' }
    if (Test-InlineCompletion $read $facts.next $facts.landed) { return 'completed' }
    if ($read.text -cne $facts.old -and $facts.stableMs -ge 120) { return 'reshaped' }
    return 'pending'
}

<#
What a field takes, for the phone's keyboard to match it: email, tel, url, search, number (a number, signs and
decimals included), digits (digits only), terminal (commands: no capital letter to start with) or text. Facts:
className, windowClass (the class of the window holding the keyboard focus), content.inputType (an <input>'s type,
from IAccessible2) and win32Digits (a classic edit box with the digits-only style).
#>
function Get-FieldKind($facts) {
    # xterm.js (VS Code's terminal and most web terminals) takes its keys in a hidden textarea; Windows Terminal draws
    # its own; the console, Git Bash's mintty, PuTTY and ConEmu are windows of their own.
    if ($facts.className -cin @('xterm-helper-textarea', 'TermControl') -or
        $facts.windowClass -cin @('ConsoleWindowClass', 'mintty', 'PuTTY', 'VirtualConsoleClass')) { return 'terminal' }
    if ($facts.win32Digits -eq $true) { return 'digits' }
    $type = [string]$facts.content.inputType
    if ($type -in @('email', 'tel', 'url', 'search', 'number')) { return $type }
    return 'text'
}

Export-ModuleMember -Function Normalize-LineEndings, Normalize-MirrorText, Get-ElementIndex, Get-FieldVerdict, Get-FieldKind, Repair-MirrorText, Get-ParagraphView, Get-ObjectDisplay, Get-InlineObjectView, Expand-ObjectEdit, Get-CaretSteps, Test-InlineCompletion, Get-EditOutcome
