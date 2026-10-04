// Voice companion supervisor: the scheduled task's action.
//
// Waits on the companion's process handle and relaunches it the moment it
// exits, for as long as the scheduled task is enabled. It is a native winexe
// rather than Python so a sweep that kills pythonw.exe does not take the
// supervisor down with the companion. A companion that is already running
// (the supervisor itself was killed and restarted by the task's every-minute
// trigger) is adopted instead of duplicated.
//
// Built by install-workstation.ps1 with the .NET Framework csc (C# 5).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Threading;

static class VoiceGuard
{
    const int QuickExitSeconds = 30;
    const int MaxBackoffSeconds = 60;
    const long LogLimitBytes = 1 << 20;

    static string logPath;

    static int Main(string[] args)
    {
        if (args.Length != 2) return 2;
        string repo = Path.GetFullPath(args[0]);
        string taskName = args[1];
        string state = Path.Combine(repo, @".state\voice-agent");
        string pythonw = Path.Combine(state, @"venv\Scripts\pythonw.exe");
        string script = Path.Combine(repo, @"voice-agent\workstation.py");
        string arguments = Quote(script) + " --state-root " + Quote(state)
            + " --config " + Quote(Path.Combine(state, "workstation.json"))
            + " --log " + Quote(Path.Combine(state, "companion.log"));
        logPath = Path.Combine(state, "guard.log");

        bool owned;
        using (var mutex = new Mutex(true, @"Local\ClaudeUiMod-VoiceGuard", out owned))
        {
            if (!owned) { Log("another guard is running; exiting"); return 0; }
            Log("guard started pid=" + Process.GetCurrentProcess().Id);
            int quickExits = 0;
            while (true)
            {
                List<Process> companion = FindCompanion(script);
                if (companion.Count > 0)
                {
                    Log("adopted running companion pids=" + Pids(companion));
                }
                else
                {
                    if (!TaskEnabled(taskName)) { Log("task disabled; guard exiting"); return 0; }
                    if (quickExits > 1)
                    {
                        // A companion that keeps dying during startup would otherwise
                        // spin. One quick exit is a kill, not a loop: relaunch at once.
                        int delay = Math.Min(1 << Math.Min(quickExits - 2, 6), MaxBackoffSeconds);
                        Log("quick exit #" + quickExits + "; waiting " + delay + "s");
                        Thread.Sleep(delay * 1000);
                        if (!TaskEnabled(taskName)) { Log("task disabled; guard exiting"); return 0; }
                    }
                    var start = new ProcessStartInfo(pythonw, arguments);
                    start.UseShellExecute = false;
                    start.CreateNoWindow = true;
                    start.WorkingDirectory = repo;
                    try
                    {
                        companion.Add(Process.Start(start));
                    }
                    catch (Exception error)
                    {
                        Log("launch failed: " + error.Message);
                        quickExits++;
                        continue;
                    }
                    Log("launched companion pid=" + companion[0].Id);
                }

                DateTime started = DateTime.UtcNow;
                var codes = new List<string>();
                foreach (Process process in companion)
                {
                    try
                    {
                        process.WaitForExit();
                        codes.Add(process.Id + ":0x" + process.ExitCode.ToString("x"));
                    }
                    catch (Exception)
                    {
                        codes.Add(process.Id + ":?");
                    }
                }
                double uptime = (DateTime.UtcNow - started).TotalSeconds;
                Log("companion exited after " + uptime.ToString("0.0") + "s codes=" + string.Join(",", codes));
                quickExits = uptime < QuickExitSeconds ? quickExits + 1 : 0;
            }
        }
    }

    // The venv pythonw is a launcher that runs the base interpreter as a child,
    // so one companion is two processes; all of them must be gone before a
    // relaunch, or the new one would fail to bind the API port.
    static List<Process> FindCompanion(string script)
    {
        var found = new List<Process>();
        try
        {
            using (var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='pythonw.exe' OR Name='python.exe'"))
            {
                foreach (ManagementObject row in searcher.Get())
                {
                    string commandLine = row["CommandLine"] as string;
                    if (commandLine == null) continue;
                    if (commandLine.IndexOf(script, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (commandLine.IndexOf("--state-root", StringComparison.Ordinal) < 0) continue;
                    try { found.Add(Process.GetProcessById(Convert.ToInt32(row["ProcessId"]))); }
                    catch (ArgumentException) { }
                }
            }
        }
        catch (Exception error)
        {
            Log("process scan failed: " + error.Message);
        }
        return found;
    }

    // Disabling the task is the deliberate off switch; the installer disables
    // before it shuts the companion down. A scheduler that cannot be queried
    // counts as enabled, so a service hiccup never leaves voice down.
    static bool TaskEnabled(string taskName)
    {
        try
        {
            dynamic service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            service.Connect();
            dynamic task = service.GetFolder(@"\").GetTask(taskName);
            return (bool)task.Enabled;
        }
        catch (COMException error)
        {
            const int FileNotFound = unchecked((int)0x80070002);
            if (error.ErrorCode == FileNotFound) return false;
            Log("task query failed: " + error.Message);
            return true;
        }
        catch (Exception error)
        {
            Log("task query failed: " + error.Message);
            return true;
        }
    }

    static string Pids(List<Process> processes)
    {
        var ids = new List<string>();
        foreach (Process process in processes) ids.Add(process.Id.ToString());
        return string.Join(",", ids);
    }

    static string Quote(string value)
    {
        return "\"" + value + "\"";
    }

    static void Log(string message)
    {
        try
        {
            var info = new FileInfo(logPath);
            if (info.Exists && info.Length > LogLimitBytes)
            {
                File.Copy(logPath, logPath + ".1", true);
                File.WriteAllText(logPath, "");
            }
            File.AppendAllText(logPath, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + " " + message + "\r\n");
        }
        catch (Exception) { }
    }
}
