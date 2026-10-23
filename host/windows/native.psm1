# The Windows APIs the bridge calls, as C# types loaded once for the whole process: input (SendInput), the pointer
# glide, the clipboard, the speaker's mute state, and what a focused web field holds (field-content.ps1). Types only:
# nothing to export.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeInput {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
    [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int Dx, Dy; public uint MouseData, Flags, Time; public IntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort VirtualKey, ScanCode; public uint Flags, Time; public IntPtr ExtraInfo; }
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    public static int InputSize { get { return Marshal.SizeOf(typeof(Input)); } }
    public static int LastError { get { return Marshal.GetLastWin32Error(); } }
    // Every method falls back on the USB dongle when Windows rejects the injected input (see Dongle).
    public static bool Key(int code, bool down) {
        bool extended = (code >= 0x21 && code <= 0x28) || code == 0x2C || code == 0x2D || code == 0x2E ||
            code == 0x5B || code == 0x5C || code == 0x5D || code == 0xA3 || code == 0xA5;
        uint flags = (down ? 0u : 2u) | (extended ? 1u : 0u);
        Input input = new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = (ushort)code, Flags = flags } } };
        if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(Input))) != 1) return Dongle.Key(code, down);
        if (!down) Dongle.LetGoKey(code);
        return true;
    }
    // Text containing line breaks goes through ClipboardText.Paste instead: Enter can send a message.
    public static bool Text(string text) {
        foreach (char character in text) {
            if (character == '\t') {
                if (!Key(0x09, true) || !Key(0x09, false)) return false;
                continue;
            }
            Input down = new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { ScanCode = character, Flags = 4 } } };
            Input up = down; up.Data.Keyboard.Flags = 6;
            if (SendInput(2, new [] { down, up }, Marshal.SizeOf(typeof(Input))) != 2 && !Dongle.Type(character)) return false;
        }
        return true;
    }
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    // Real mouse input, unlike SetCursorPos, so apps update the cursor shape (text, link, resize) and hover state.
    // Absolute coordinates keep Windows' pointer acceleration out; SetCursorPos then corrects any rounding pixel.
    // The dongle's moves are relative: Windows' pointer speed applies to them.
    public static bool MoveBy(int dx, int dy) {
        Point point;
        if (!GetCursorPos(out point)) return Dongle.Move(dx, dy);
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        int x = Math.Max(left, Math.Min(left + width - 1, point.X + dx));
        int y = Math.Max(top, Math.Min(top + height - 1, point.Y + dy));
        Input input = new Input { Type = 0, Data = new InputUnion { Mouse = new MouseInput {
            Dx = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1)),
            Dy = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1)),
            Flags = 0x0001 | 0x4000 | 0x8000 } } };
        if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(Input))) != 1) return Dongle.Move(dx, dy) || SetCursorPos(x, y);
        Point landed;
        if (GetCursorPos(out landed) && (landed.X != x || landed.Y != y)) return SetCursorPos(x, y);
        return true;
    }
    public static bool Mouse(uint flags, int data = 0) {
        Input input = new Input { Type = 0, Data = new InputUnion { Mouse = new MouseInput { Flags = flags, MouseData = unchecked((uint)data) } } };
        if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(Input))) != 1) return Dongle.Mouse(flags, data);
        Dongle.LetGoButtons(flags);
        return true;
    }
}

/*
The USB dongle (dongle/): a LilyGO T-Dongle-S3 plugged into this PC, which Windows sees as a real keyboard and mouse.
Input goes through it only where Windows rejects injected input: the secure desktop (sign-in, lock screen, UAC
prompts) and an app run as administrator in front. Without it, nothing changes.
The dongle takes one text command per line on its USB serial port (dongle/src/main.cpp lists them). A watcher looks
for it every 2 s among the serial ports of Espressif USB devices, and keeps the first one that answers "?" with its
name. A key or button that Windows lets go is let go on the dongle too, so a key never stays down there.
*/
public static class Dongle {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanEx(char character, IntPtr layout);
    [DllImport("user32.dll")] static extern short GetKeyState(int key);
    const string Identity = "remote-smart-trackpad-dongle";
    static readonly object gate = new object();
    static System.IO.Ports.SerialPort port;
    static System.Threading.Thread watcher;
    // Ports that did not answer as the dongle, with their number of tries (an Espressif board of another project).
    static readonly System.Collections.Generic.Dictionary<string, int> refused = new System.Collections.Generic.Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
    // What the dongle holds down: HID keyboard usages, consumer usages (+0x10000) and mouse buttons (1 left, 2 right, 4 middle).
    static readonly System.Collections.Generic.HashSet<int> keys = new System.Collections.Generic.HashSet<int>();
    static int buttons;

    public static bool Connected { get { lock (gate) return port != null; } }
    // Whether the dongle is wanted (dongle/.env and the tray menu): the search runs, and the dongle is used, only then.
    static bool wanted;
    public static void Start() {
        lock (gate) {
            wanted = true;
            if (watcher != null) return;
            watcher = new System.Threading.Thread(Watch) { IsBackground = true };
            watcher.Start();
        }
    }
    public static void Stop() {
        lock (gate) {
            wanted = false;
            if (port == null) return;
            Send("r");
            try { port.Close(); } catch {}
            port = null;
            Console.Error.WriteLine("USB dongle: turned off");
        }
    }
    static void Watch() {
        while (true) {
            lock (gate) {
                if (!wanted) {
                    watcher = null;
                    return;
                }
            }
            if (!Connected) {
                try { Find(); } catch (Exception error) { Console.Error.WriteLine("USB dongle: search failed: " + error.Message); }
            }
            System.Threading.Thread.Sleep(2000);
        }
    }
    // The serial ports of plugged-in Espressif devices (USB vendor 303A).
    static System.Collections.Generic.List<string> EspressifPorts() {
        var present = new System.Collections.Generic.HashSet<string>(System.IO.Ports.SerialPort.GetPortNames(), StringComparer.OrdinalIgnoreCase);
        var found = new System.Collections.Generic.List<string>();
        using (var usb = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\USB")) {
            if (usb == null) return found;
            foreach (string device in usb.GetSubKeyNames()) {
                if (!device.StartsWith("VID_303A", StringComparison.OrdinalIgnoreCase)) continue;
                using (var instances = usb.OpenSubKey(device)) {
                    if (instances == null) continue;
                    foreach (string instance in instances.GetSubKeyNames()) {
                        using (var parameters = instances.OpenSubKey(instance + @"\Device Parameters")) {
                            string name = parameters == null ? null : parameters.GetValue("PortName") as string;
                            if (name != null && present.Contains(name) && !found.Contains(name)) found.Add(name);
                        }
                    }
                }
            }
        }
        return found;
    }
    static void Find() {
        var names = EspressifPorts();
        foreach (string gone in new System.Collections.Generic.List<string>(refused.Keys)) if (!names.Contains(gone)) refused.Remove(gone);
        foreach (string name in names) {
            int tries;
            if (refused.TryGetValue(name, out tries) && tries >= 3) continue;
            var candidate = new System.IO.Ports.SerialPort(name, 115200) {
                DtrEnable = true, NewLine = "\n", ReadTimeout = 500, WriteTimeout = 2000, Encoding = System.Text.Encoding.ASCII,
            };
            try {
                candidate.Open();
                candidate.DiscardInBuffer();
                candidate.Write("?\n");
                if (candidate.ReadLine().Trim().StartsWith(Identity)) {
                    lock (gate) {
                        if (!wanted) {
                            candidate.Close();
                            return;
                        }
                        port = candidate;
                        keys.Clear();
                        buttons = 0;
                    }
                    refused.Remove(name);
                    Console.Error.WriteLine("USB dongle: connected on " + name + "; it types where Windows rejects the remote's input");
                    return;
                }
            } catch {}
            try { candidate.Close(); } catch {}
            refused[name] = (tries) + 1;
        }
    }
    static bool Send(string command) {
        lock (gate) {
            if (port == null) return false;
            try {
                port.Write(command + "\n");
                return true;
            } catch (Exception error) {
                try { port.Close(); } catch {}
                port = null;
                keys.Clear();
                buttons = 0;
                Console.Error.WriteLine("USB dongle: disconnected (" + error.Message + ")");
                return false;
            }
        }
    }

    public static IntPtr ForegroundLayout() {
        return GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero));
    }
    static readonly System.Collections.Generic.Dictionary<int, int> consumerUsages = new System.Collections.Generic.Dictionary<int, int> {
        { 0xAD, 0xE2 }, { 0xAE, 0xEA }, { 0xAF, 0xE9 }, { 0xB0, 0xB5 }, { 0xB1, 0xB6 }, { 0xB2, 0xB7 }, { 0xB3, 0xCD },
    };
    // Scan code set 1 to HID keyboard usage, for codes without the E0 prefix (index) and with it (extended).
    static readonly byte[] plainUsages = BuildPlainUsages();
    static readonly System.Collections.Generic.Dictionary<int, int> extendedUsages = new System.Collections.Generic.Dictionary<int, int> {
        { 0x1C, 0x58 }, { 0x1D, 0xE4 }, { 0x35, 0x54 }, { 0x37, 0x46 }, { 0x38, 0xE6 }, { 0x47, 0x4A }, { 0x48, 0x52 },
        { 0x49, 0x4B }, { 0x4B, 0x50 }, { 0x4D, 0x4F }, { 0x4F, 0x4D }, { 0x50, 0x51 }, { 0x51, 0x4E }, { 0x52, 0x49 },
        { 0x53, 0x4C }, { 0x5B, 0xE3 }, { 0x5C, 0xE7 }, { 0x5D, 0x65 },
    };
    static byte[] BuildPlainUsages() {
        var usages = new byte[0x80];
        byte[] row = {
            0x00, 0x29, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2D, 0x2E, 0x2A, 0x2B,
            0x14, 0x1A, 0x08, 0x15, 0x17, 0x1C, 0x18, 0x0C, 0x12, 0x13, 0x2F, 0x30, 0x28, 0xE0, 0x04, 0x16,
            0x07, 0x09, 0x0A, 0x0B, 0x0D, 0x0E, 0x0F, 0x33, 0x34, 0x35, 0xE1, 0x31, 0x1D, 0x1B, 0x06, 0x19,
            0x05, 0x11, 0x10, 0x36, 0x37, 0x38, 0xE5, 0x55, 0xE2, 0x2C, 0x39, 0x3A, 0x3B, 0x3C, 0x3D, 0x3E,
            0x3F, 0x40, 0x41, 0x42, 0x43, 0x53, 0x47, 0x5F, 0x60, 0x61, 0x56, 0x5C, 0x5D, 0x5E, 0x57, 0x59,
            0x5A, 0x5B, 0x62, 0x63, 0x00, 0x00, 0x64, 0x44, 0x45, 0x67,
        };
        Array.Copy(row, usages, row.Length);
        for (int code = 0x64; code <= 0x6E; code++) usages[code] = (byte)(0x68 + code - 0x64); // F13 to F23
        usages[0x76] = 0x73; // F24
        usages[0x70] = 0x88; usages[0x73] = 0x87; usages[0x79] = 0x8A; usages[0x7B] = 0x8B; usages[0x7D] = 0x89;
        return usages;
    }
    /// <summary>The HID usage of a virtual key on this layout (consumer usages + 0x10000), or 0.</summary>
    public static int Usage(int virtualKey, IntPtr layout) {
        int consumer;
        if (consumerUsages.TryGetValue(virtualKey, out consumer)) return 0x10000 + consumer;
        if (virtualKey == 0x13) return 0x48; // Pause
        if (virtualKey == 0x2C) return 0x46; // Print Screen
        uint scan = MapVirtualKeyEx((uint)virtualKey, 4, layout);
        // Windows leaves the E0 prefix off the navigation keys, which would land on the number pad.
        bool extended = (virtualKey >= 0x21 && virtualKey <= 0x28) || virtualKey == 0x2D || virtualKey == 0x2E || virtualKey == 0x6F;
        if (extended || (scan & 0xFF00) == 0xE000) {
            int usage;
            return extendedUsages.TryGetValue((int)(scan & 0xFF), out usage) ? usage : 0;
        }
        return scan < 0x80 ? plainUsages[scan] : 0;
    }
    /// <summary>The command typing this character on this layout ("t usage modifiers"), or null when no key types it
    /// (a dead key's letter, an emoji).</summary>
    public static string TypeCommand(char character, IntPtr layout, bool capsLock) {
        if (character < 0x20) return null;
        short found = VkKeyScanEx(character, layout);
        if (found == -1) return null;
        int shiftState = (found >> 8) & 0xFF;
        if ((shiftState & ~7) != 0) return null;
        int usage = Usage(found & 0xFF, layout);
        if (usage == 0 || usage >= 0x10000) return null;
        bool shift = (shiftState & 1) != 0, control = (shiftState & 2) != 0, alt = (shiftState & 4) != 0;
        // Caps Lock flips Shift on letters (the dongle's keys go through it like a keyboard's).
        if (capsLock && ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z'))) shift = !shift;
        // Left Control with Right Alt is AltGr.
        int modifiers = (shift ? 0x02 : 0) | (control && alt ? 0x41 : (control ? 0x01 : 0) | (alt ? 0x04 : 0));
        return "t " + usage + " " + modifiers;
    }

    public static bool Key(int virtualKey, bool down) {
        int usage = Usage(virtualKey, ForegroundLayout());
        if (usage == 0) return false;
        lock (gate) {
            if (!Send((usage >= 0x10000 ? "c " + (usage - 0x10000) : "k " + usage) + (down ? " 1" : " 0"))) return false;
            if (down) keys.Add(usage); else keys.Remove(usage);
            return true;
        }
    }
    public static void LetGoKey(int virtualKey) {
        lock (gate) {
            if (keys.Count == 0) return;
            int usage = Usage(virtualKey, ForegroundLayout());
            if (keys.Contains(usage)) Key(virtualKey, false);
        }
    }
    public static bool Type(char character) {
        string command = TypeCommand(character, ForegroundLayout(), (GetKeyState(0x14) & 1) != 0);
        return command != null && Send(command);
    }
    public static bool Move(int dx, int dy) { return Send("m " + dx + " " + dy); }
    static int ButtonsAfter(int held, uint flags) {
        if ((flags & 0x0002) != 0) held |= 1;
        if ((flags & 0x0004) != 0) held &= ~1;
        if ((flags & 0x0008) != 0) held |= 2;
        if ((flags & 0x0010) != 0) held &= ~2;
        if ((flags & 0x0020) != 0) held |= 4;
        if ((flags & 0x0040) != 0) held &= ~4;
        return held;
    }
    public static bool Mouse(uint flags, int data) {
        lock (gate) {
            int held = ButtonsAfter(buttons, flags);
            if (held != buttons) {
                if (!Send("b " + held)) return false;
                buttons = held;
            }
            if ((flags & 0x0800) != 0) return Send("w " + data + " 0");
            if ((flags & 0x1000) != 0) return Send("w 0 " + data);
            return port != null;
        }
    }
    public static void LetGoButtons(uint flags) {
        lock (gate) {
            int held = buttons & ButtonsAfter(buttons, flags);
            if (held != buttons && Send("b " + held)) buttons = held;
        }
    }
    public static void Release() {
        lock (gate) {
            if (port == null) return;
            Send("r");
            keys.Clear();
            buttons = 0;
        }
    }
}

// Inserts text by pasting it, so line breaks become real paragraph breaks and never press Enter. The user's
// clipboard is saved first and restored by Restore once the paste has landed.
// Edge motion: the phone sends a velocity and the pointer glides here, on a ~8 ms timer, so the motion is smooth
// whatever the network latency. The phone renews the velocity every 100 ms; without news for 300 ms the glide
// stops on its own, so a dropped connection never leaves the pointer moving.
public static class Glider {
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
    static readonly object gate = new object();
    static System.Threading.Thread worker;
    static readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();
    static double velocityX, velocityY, deadline;
    public static long Moved;

    /** Velocity in pixels per millisecond; zero stops. */
    public static void Set(double x, double y) {
        lock (gate) {
            velocityX = x; velocityY = y;
            deadline = clock.Elapsed.TotalMilliseconds + 300;
            if ((x == 0 && y == 0) || worker != null) return;
            worker = new System.Threading.Thread(Run) { IsBackground = true, Priority = System.Threading.ThreadPriority.AboveNormal };
            worker.Start();
        }
    }
    public static void Stop() { lock (gate) { velocityX = velocityY = 0; deadline = 0; } }
    // A steady 8 ms cadence (the finer system timer makes Sleep(1) precise), with sub-pixel remainders carried over.
    static void Run() {
        timeBeginPeriod(1);
        try {
            double carryX = 0, carryY = 0, last = clock.Elapsed.TotalMilliseconds, next = last + 8;
            while (true) {
                double now = clock.Elapsed.TotalMilliseconds;
                if (now < next) { System.Threading.Thread.Sleep(1); continue; }
                next += 8;
                if (next < now) next = now + 8;
                double vx, vy;
                lock (gate) {
                    if (now > deadline || (velocityX == 0 && velocityY == 0)) { worker = null; return; }
                    vx = velocityX; vy = velocityY;
                }
                double elapsed = Math.Min(50, now - last);
                last = now;
                carryX += vx * elapsed; carryY += vy * elapsed;
                int dx = (int)Math.Round(carryX), dy = (int)Math.Round(carryY);
                carryX -= dx; carryY -= dy;
                if ((dx != 0 || dy != 0) && NativeInput.MoveBy(dx, dy)) Moved += Math.Abs(dx) + Math.Abs(dy);
            }
        } finally { timeEndPeriod(1); }
    }
}

public static class ClipboardText {
    [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] static extern bool CloseClipboard();
    [DllImport("user32.dll")] static extern bool EmptyClipboard();
    [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string className, string name, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr memory);
    static IntPtr owner;
    static System.Collections.Generic.List<Tuple<uint, byte[]>> saved;

    static bool Open() {
        // SetClipboardData fails without an owner window; a message-only window serves.
        if (owner == IntPtr.Zero) owner = CreateWindowEx(0, "STATIC", "", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        for (int attempt = 0; attempt < 25; attempt++) {
            if (OpenClipboard(owner)) return true;
            System.Threading.Thread.Sleep(10);
        }
        return false;
    }
    static void Put(uint format, byte[] bytes) {
        IntPtr memory = GlobalAlloc(0x0002, (UIntPtr)bytes.Length);
        IntPtr target = GlobalLock(memory);
        Marshal.Copy(bytes, 0, target, bytes.Length);
        GlobalUnlock(memory);
        SetClipboardData(format, memory);
    }
    // Keeps the pasted text out of Windows clipboard history and cloud sync.
    static void PutPrivacyMarkers() {
        Put(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), new byte[4]);
        Put(RegisterClipboardFormat("CanIncludeInClipboardHistory"), new byte[4]);
        Put(RegisterClipboardFormat("CanUploadToCloudClipboard"), new byte[4]);
    }
    static bool Copyable(uint format) {
        // GDI handles cannot be copied as memory; bitmaps survive through their CF_DIB form.
        return format != 2 && format != 3 && format != 9 && format != 14 && !(format >= 0x80 && format <= 0x8E) && !(format >= 0x300 && format <= 0x3FF);
    }
    public static bool Set(string text) {
        if (!Open()) return false;
        try {
            if (saved == null) {
                saved = new System.Collections.Generic.List<Tuple<uint, byte[]>>();
                for (uint format = EnumClipboardFormats(0); format != 0; format = EnumClipboardFormats(format)) {
                    if (!Copyable(format)) continue;
                    IntPtr memory = GetClipboardData(format);
                    if (memory == IntPtr.Zero) continue;
                    int size = (int)GlobalSize(memory);
                    IntPtr source = GlobalLock(memory);
                    if (source == IntPtr.Zero) continue;
                    byte[] bytes = new byte[size];
                    Marshal.Copy(source, bytes, 0, size);
                    GlobalUnlock(memory);
                    saved.Add(Tuple.Create(format, bytes));
                }
            }
            EmptyClipboard();
            Put(13, System.Text.Encoding.Unicode.GetBytes(text.Replace("\n", "\r\n") + "\0"));
            PutPrivacyMarkers();
            return true;
        } finally { CloseClipboard(); }
    }
    public static void Restore() {
        if (saved == null || !Open()) return;
        try {
            EmptyClipboard();
            foreach (var entry in saved) Put(entry.Item1, entry.Item2);
            PutPrivacyMarkers();
        } finally {
            saved = null;
            CloseClipboard();
        }
    }
}

// Core Audio: only the vtable slots up to GetMute are declared.
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr notify); int UnregisterControlChangeNotify(IntPtr notify); int GetChannelCount(out uint count);
    int SetMasterVolumeLevel(float level, IntPtr context); int SetMasterVolumeLevelScalar(float level, IntPtr context);
    int GetMasterVolumeLevel(out float level); int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint channel, float level, IntPtr context); int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr context);
    int GetChannelVolumeLevel(uint channel, out float level); int GetChannelVolumeLevelScalar(uint channel, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice { int Activate(ref Guid id, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object value); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int state, out IntPtr devices); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumerator {}

// Windows keeps the input of an app with the user's rights (the remote) off the windows of an app run as administrator
// (UIPI): while one is in front (a tray icon's menu, PowerToys), every injected move, click and key fails. Giving the
// focus to the taskbar is allowed, and closes such a menu as a click outside it would.
public static class Foreground {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string className, string title);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr window, bool altTab);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int id);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int written);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    /// <summary>The name of the app in front when it runs as administrator, else null.</summary>
    public static string Elevated() {
        int id;
        GetWindowThreadProcessId(GetForegroundWindow(), out id);
        if (id == 0) return null;
        const int QueryLimited = 0x1000, Query = 0x8, TokenElevation = 20;
        IntPtr process = OpenProcess(QueryLimited, false, id);
        if (process == IntPtr.Zero) return null;
        try {
            IntPtr token;
            if (!OpenProcessToken(process, Query, out token)) return null;
            try {
                int elevated, written;
                if (!GetTokenInformation(token, TokenElevation, out elevated, 4, out written) || elevated == 0) return null;
            } finally { CloseHandle(token); }
        } finally { CloseHandle(process); }
        try { return System.Diagnostics.Process.GetProcessById(id).ProcessName; } catch { return "An app"; }
    }
    /// <summary>Gives the focus to the taskbar when an app run as administrator is in front; true when it moved.</summary>
    public static bool LeaveElevated() {
        if (Elevated() == null) return false;
        IntPtr taskbar = FindWindow("Shell_TrayWnd", null);
        if (taskbar == IntPtr.Zero) return false;
        if (!SetForegroundWindow(taskbar)) SwitchToThisWindow(taskbar, true);
        System.Threading.Thread.Sleep(50);
        return Elevated() == null;
    }
}

public static class SpeakerVolume {
    public static bool Muted() {
        IMMDevice device;
        Marshal.ThrowExceptionForHR(((IMMDeviceEnumerator)new MMDeviceEnumerator()).GetDefaultAudioEndpoint(0, 1, out device));
        Guid id = typeof(IAudioEndpointVolume).GUID;
        object volume;
        Marshal.ThrowExceptionForHR(device.Activate(ref id, 23, IntPtr.Zero, out volume));
        bool muted;
        Marshal.ThrowExceptionForHR(((IAudioEndpointVolume)volume).GetMute(out muted));
        return muted;
    }
}
'@

. (Join-Path $PSScriptRoot 'field-content.ps1')
Export-ModuleMember -Function @()
