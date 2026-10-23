using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class TrayHost {
    [STAThread]
    private static void Main(string[] args) {
        Application.EnableVisualStyles();
        string root = Directory.GetParent(AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar)).FullName;
        string id = Convert.ToBase64String(Encoding.UTF8.GetBytes(root)).Replace('/', '_');
        string stopName = "Local\\RemoteSmartTrackpad-Stop-" + id;
        string restartName = "Local\\RemoteSmartTrackpad-Restart-" + id;
        // "--stop" asks the running tray of this checkout to shut its server down gracefully (used by the launcher);
        // "--restart" to start a fresh server, with the code as it is now (npm restart). Exit code 1: no tray runs.
        if (args.Length > 0 && (args[0] == "--stop" || args[0] == "--restart")) {
            EventWaitHandle running;
            if (EventWaitHandle.TryOpenExisting(args[0] == "--stop" ? stopName : restartName, out running)) using (running) running.Set();
            else Environment.ExitCode = 1;
            return;
        }
        // "--takeover": started by a tray switching modes (HostContext.SwitchMode), which leaves meanwhile.
        bool takeover = args.Length > 0 && args[0] == "--takeover";
        bool elevated = Administrator.Current;
        // Run as administrator is remembered: a tray started with the user's rights (the launcher, Explorer) hands over
        // to one run as administrator, through the scheduled task when there is one (no prompt), else the UAC prompt.
        // Declining the prompt keeps this one.
        if (!elevated && !takeover && Administrator.Remembered(root) && Administrator.StartElevated()) return;
        bool relaunchWithUserRights = false;
        // The user may signal a tray run as administrator (npm restart, the launcher's --stop), whose objects would
        // otherwise be open to administrators only.
        bool created;
        using (var mutex = new Mutex(false, "Local\\RemoteSmartTrackpad-" + id, out created, Administrator.MutexAccess()))
        using (var stop = new EventWaitHandle(false, EventResetMode.AutoReset, stopName, out created, Administrator.EventAccess()))
        using (var restart = new EventWaitHandle(false, EventResetMode.AutoReset, restartName, out created, Administrator.EventAccess())) {
            if (!mutex.WaitOne(takeover ? 15000 : 0)) {
                // Started as administrator while a tray runs (Run as administrator from Explorer): it takes that one's
                // place, which stops gracefully.
                if (!elevated) return;
                stop.Set();
                if (!mutex.WaitOne(15000)) return;
            }
            try {
                using (var context = new HostContext(root, stop, restart)) {
                    Application.Run(context);
                    relaunchWithUserRights = context.RelaunchWithUserRights;
                }
            }
            catch (Exception error) { MessageBox.Show(error.Message, "Remote Smart Trackpad", MessageBoxButtons.OK, MessageBoxIcon.Error); }
            finally { mutex.ReleaseMutex(); }
        }
        // Back to the user's rights: Explorer starts the tray as the signed-in user, once this one is gone.
        if (relaunchWithUserRights) Process.Start(new ProcessStartInfo("explorer.exe", "\"" + Application.ExecutablePath + "\"") { UseShellExecute = false });
    }
}

/*
Run as administrator, remembered across starts: .data/run-as-administrator is there while it is chosen. Starting with
Windows then goes through a scheduled task that runs the tray with the highest privileges at sign-in, without a UAC
prompt, in place of the registry's Run value. Only a tray run as administrator creates or deletes that task.
*/
internal static class Administrator {
    public const string TaskName = "Remote Smart Trackpad (administrator)";
    public static bool Current { get { return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); } }
    static string MarkerPath(string root) {
        string data = Environment.GetEnvironmentVariable("REMOTE_SMART_TRACKPAD_DATA_DIRECTORY") ?? Path.Combine(root, ".data");
        return Path.Combine(data, "run-as-administrator");
    }
    public static bool Remembered(string root) { return File.Exists(MarkerPath(root)); }
    public static void Remember(string root, bool chosen) {
        string marker = MarkerPath(root);
        if (chosen) File.WriteAllText(marker, "The tray runs as administrator; clear Run as administrator in its menu to stop.");
        else if (File.Exists(marker)) File.Delete(marker);
    }
    /// <summary>Starts this tray as administrator; false when that did not happen (the UAC prompt declined).</summary>
    public static bool StartElevated() {
        if (TaskExists() && Schtasks("/Run /TN \"" + TaskName + "\"") == 0) return true;
        try {
            Process.Start(new ProcessStartInfo(Application.ExecutablePath) { UseShellExecute = true, Verb = "runas" });
            return true;
        } catch (System.ComponentModel.Win32Exception) { return false; }
    }
    public static bool TaskExists() { return Schtasks("/Query /TN \"" + TaskName + "\"") == 0; }
    // At the user's sign-in, with no time limit (a task's default stops it after 3 days) and on battery too.
    public static void CreateTask() {
        string user = SecurityElement(WindowsIdentity.GetCurrent().Name);
        string executable = SecurityElement(Application.ExecutablePath);
        string xml =
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n" +
            "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
            "<RegistrationInfo><Description>Starts Remote Smart Trackpad as administrator at sign-in (its tray menu).</Description></RegistrationInfo>" +
            "<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>" + user + "</UserId></LogonTrigger></Triggers>" +
            "<Principals><Principal id=\"Author\"><UserId>" + user + "</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>" +
            "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
            "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority></Settings>" +
            "<Actions Context=\"Author\"><Exec><Command>" + executable + "</Command></Exec></Actions></Task>";
        string file = Path.Combine(Path.GetTempPath(), "remote-smart-trackpad-task.xml");
        File.WriteAllText(file, xml, Encoding.Unicode);
        try {
            if (Schtasks("/Create /TN \"" + TaskName + "\" /XML \"" + file + "\" /F") != 0) throw new InvalidOperationException("Windows did not create the startup task.");
        } finally { File.Delete(file); }
    }
    public static void DeleteTask() { if (TaskExists()) Schtasks("/Delete /TN \"" + TaskName + "\" /F"); }
    static string SecurityElement(string text) { return System.Security.SecurityElement.Escape(text); }
    static int Schtasks(string arguments) {
        using (var process = Process.Start(new ProcessStartInfo("schtasks.exe", arguments) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })) {
            process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            process.WaitForExit();
            return process.ExitCode;
        }
    }
    static SecurityIdentifier User { get { return WindowsIdentity.GetCurrent().User; } }
    public static System.Security.AccessControl.MutexSecurity MutexAccess() {
        var security = new System.Security.AccessControl.MutexSecurity();
        security.AddAccessRule(new System.Security.AccessControl.MutexAccessRule(User, System.Security.AccessControl.MutexRights.FullControl, System.Security.AccessControl.AccessControlType.Allow));
        return security;
    }
    public static System.Security.AccessControl.EventWaitHandleSecurity EventAccess() {
        var security = new System.Security.AccessControl.EventWaitHandleSecurity();
        security.AddAccessRule(new System.Security.AccessControl.EventWaitHandleAccessRule(User, System.Security.AccessControl.EventWaitHandleRights.FullControl, System.Security.AccessControl.AccessControlType.Allow));
        return security;
    }
}

internal sealed class HostContext : ApplicationContext {
    private const string StartupName = "Remote Smart Trackpad";
    private readonly NotifyIcon tray;
    private readonly Control dispatcher = new Control();
    private readonly object logLock = new object();
    private readonly StreamWriter log;
    private readonly string logPath;
    private readonly string node;
    private Process console;
    // The running server; replaced by a fresh one on a restart.
    private Process server;
    private readonly string root;
    private readonly ToolStripMenuItem startup;
    private bool stopping;
    // Running as administrator, Windows lets the remote act on apps run as administrator too (their windows and tray
    // menus). Chosen in the tray menu, or by starting the tray as administrator, and remembered (Administrator).
    private readonly bool elevated = Administrator.Current;
    /// <summary>Set when this tray leaves to start again with the user's rights.</summary>
    public bool RelaunchWithUserRights { get; private set; }

    public HostContext(string projectRoot, WaitHandle stopSignal, WaitHandle restartSignal) {
        root = projectRoot;
        Icon appIcon = Icon.ExtractAssociatedIcon(Path.Combine(root, ".data", "RemoteSmartTrackpad.exe"));
        string data = Environment.GetEnvironmentVariable("REMOTE_SMART_TRACKPAD_DATA_DIRECTORY") ?? Path.Combine(root, ".data");
        Directory.CreateDirectory(data);
        logPath = Path.Combine(data, "server.log");
        log = new StreamWriter(new FileStream(logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)) { AutoFlush = true };
        IntPtr handle = dispatcher.Handle;
        var menu = new ContextMenuStrip();
        menu.Items.Add("Connect a device", null, delegate { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + (Environment.GetEnvironmentVariable("REMOTE_SMART_TRACKPAD_PORT") ?? "8765") + "/setup") { UseShellExecute = true }); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Show console", null, delegate { ShowConsole(); });
        startup = new ToolStripMenuItem("Start with Windows") { CheckOnClick = false };
        startup.Click += delegate { try { SetStartup(!startup.Checked); } catch (Exception error) { MessageBox.Show(error.Message, StartupName); } };
        menu.Items.Add(startup);
        var administrator = new ToolStripMenuItem("Run as administrator (restart server)") { CheckOnClick = false, Checked = elevated };
        administrator.Click += delegate { SwitchMode(!elevated); };
        menu.Items.Add(administrator);
        // The optional USB dongle (dongle/README.md): offered only when dongle/.env sets DONGLE_ENABLED=true.
        string dongleSettings = Path.Combine(root, "dongle", ".env");
        if (File.Exists(dongleSettings) && System.Text.RegularExpressions.Regex.IsMatch(File.ReadAllText(dongleSettings), @"^\s*DONGLE_ENABLED\s*=\s*true\s*$", System.Text.RegularExpressions.RegexOptions.Multiline | System.Text.RegularExpressions.RegexOptions.IgnoreCase)) {
            string dongleOff = Path.Combine(data, "dongle-off");
            var dongle = new ToolStripMenuItem("Use the USB dongle") { CheckOnClick = false, Checked = !File.Exists(dongleOff) };
            dongle.Click += delegate { SetDongle(!dongle.Checked, dongle, dongleOff); };
            menu.Items.Add(dongle);
        }
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Restart server", null, delegate { RestartServer(); });
        menu.Items.Add("Stop server", null, delegate { ExitThread(); });
        tray = new NotifyIcon { Icon = appIcon, Text = Title, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { ShowConsole(); };
        using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) startup.Checked = (key != null && key.GetValue(StartupName) != null) || Administrator.TaskExists();
        // Run as administrator, however it started, is remembered; starting with Windows follows it (SetStartup).
        if (elevated) {
            Administrator.Remember(root, true);
            if (startup.Checked) try { SetStartup(true); } catch (Exception error) { Append("Start with Windows: " + error.Message); }
        }
        string marker = Path.Combine(root, ".data", "tray-initialized");
        if (!File.Exists(marker)) { SetStartup(true); File.WriteAllText(marker, "Startup preference initialized; use the tray menu to change it."); }
        node = File.ReadAllText(Path.Combine(root, ".data", "node-path.txt")).Trim();
        StartServer();
        var signals = new Thread(delegate() {
            var handles = new[] { stopSignal, restartSignal };
            while (true) {
                int signal = WaitHandle.WaitAny(handles);
                if (dispatcher.IsDisposed) return;
                if (signal == 1) { dispatcher.BeginInvoke((Action)RestartServer); continue; }
                dispatcher.BeginInvoke((Action)ExitThread);
                return;
            }
        }) { IsBackground = true };
        signals.Start();
    }

    private void StartServer() {
        var process = new Process { StartInfo = new ProcessStartInfo(node, "\"" + Path.Combine(root, "host", "server.js") + "\"") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 }, EnableRaisingEvents = true };
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Append(e.Data); };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Append(e.Data); };
        // Only the current server stopping on its own is news: one being replaced or shut down is not.
        process.Exited += delegate { if (!stopping && !dispatcher.IsDisposed) dispatcher.BeginInvoke((Action)delegate { if (stopping || process != server) return; tray.Text = "Remote Smart Trackpad - stopped"; Append("Server stopped. Use Restart server in the tray menu to retry."); ShowConsole(); }); };
        process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine();
        server = process;
        tray.Text = Title;
    }
    private string Title { get { return elevated ? StartupName + " (administrator)" : StartupName; } }
    /// <summary>
    /// Starts the tray again in the other mode; this one leaves (its server stops, the new tray starts its own).
    /// Declining the administrator prompt changes nothing.
    /// </summary>
    private void SwitchMode(bool administrator) {
        if (administrator) {
            try { Process.Start(new ProcessStartInfo(Application.ExecutablePath, "--takeover") { UseShellExecute = true, Verb = "runas" }); }
            catch (System.ComponentModel.Win32Exception) { return; }
        } else {
            // Back to the user's rights for good: starting with Windows goes through the Run value again.
            Administrator.Remember(root, false);
            if (startup.Checked) try { SetStartup(true); } catch (Exception error) { Append("Start with Windows: " + error.Message); }
            RelaunchWithUserRights = true;
        }
        Append(administrator ? "Restarting as administrator..." : "Restarting with the user's rights...");
        ExitThread();
    }
    // Gracefully: the server releases held input and closes its connections, or is ended after 5 s.
    private void StopServer() {
        Process process = server;
        server = null;
        if (process == null) return;
        if (!process.HasExited) {
            try { process.StandardInput.WriteLine("shutdown"); process.StandardInput.Flush(); } catch (IOException) { }
            if (!process.WaitForExit(5000)) process.Kill();
        }
        process.Dispose();
    }
    // A fresh server, with the code as it is now (host and bridge changes apply); phones reconnect on their own.
    private void RestartServer() {
        if (stopping) return;
        Append("Restarting the server...");
        StopServer();
        StartServer();
    }

    private void Append(string line) {
        lock (logLock) { if (line != null && !stopping) log.WriteLine(line); }
    }
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    private void ShowConsole() {
        if (console != null && !console.HasExited) {
            console.Refresh();
            ShowWindow(console.MainWindowHandle, 9);
            SetForegroundWindow(console.MainWindowHandle);
            return;
        }
        if (console != null) console.Dispose();
        console = Process.Start(new ProcessStartInfo(node, "\"" + Path.Combine(root, "host", "show-console.js") + "\" \"" + logPath + "\"") { WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = false });
    }
    // Remembered for the next servers (dongleOff), and applied to the running one at once.
    private void SetDongle(bool enabled, ToolStripMenuItem item, string dongleOff) {
        try {
            if (enabled) File.Delete(dongleOff);
            else File.WriteAllText(dongleOff, "The USB dongle is turned off in the tray menu.");
        } catch (Exception error) { MessageBox.Show(error.Message, StartupName); return; }
        item.Checked = enabled;
        Append(enabled ? "USB dongle: turned on in the tray menu" : "USB dongle: turned off in the tray menu");
        try { if (server != null && !server.HasExited) { server.StandardInput.WriteLine(enabled ? "dongle on" : "dongle off"); server.StandardInput.Flush(); } } catch (IOException) { }
    }
    // Through the scheduled task while Run as administrator is remembered (a Run value cannot start an app as
    // administrator), else the registry's Run value. Only a tray run as administrator changes the task.
    private void SetStartup(bool enabled) {
        bool task = enabled && Administrator.Remembered(root);
        if (task) Administrator.CreateTask();
        else if (elevated) Administrator.DeleteTask();
        else if (Administrator.TaskExists()) throw new InvalidOperationException("Run as administrator to change this: Windows starts the tray as administrator.");
        using (var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")) {
            if (enabled && !task) key.SetValue(StartupName, "\"" + Application.ExecutablePath + "\"");
            else key.DeleteValue(StartupName, false);
        }
        startup.Checked = enabled;
    }
    protected override void ExitThreadCore() {
        if (stopping) return;
        stopping = true;
        StopServer();
        tray.Visible = false; tray.Dispose(); dispatcher.Dispose();
        if (console != null) { if (!console.HasExited) console.Kill(); console.Dispose(); }
        lock (logLock) log.Dispose();
        base.ExitThreadCore();
    }
}
