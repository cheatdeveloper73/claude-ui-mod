#!/usr/bin/env python3
"""Native-hook style test of the auto-compact window on a running claude.exe.

Same disposable-worker discipline as the .mjs probes: one no-persistence worker
in a fresh temp tree, pointed at an in-process loopback stub, never a Desktop
session or any existing claude.exe. This one attaches Frida to the worker's PID
and asks one empirical question:

    does Cb()'s `process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` branch read the
    live native environment on each resolution, or a startup snapshot?

If it reads live (GetEnvironmentVariableW / getenv fire during
get_context_usage), a native hook that answers that key IS a realtime window
control on the same PID, and this proves 400k -> 1M with no respawn. If nothing
native fires, the env lever is a snapshot and the report says so exactly.

Usage:
    CUIMOD_WORKER_PROBE=1 python scripts/auto-compact-env-hook-probe.py [--model <id>]
"""
import json, os, sys, tempfile, threading, time, shutil, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if os.environ.get("CUIMOD_WORKER_PROBE") != "1":
    raise SystemExit("refusing to launch a worker: set CUIMOD_WORKER_PROBE=1")

import frida

MODEL = "claude-opus-5"
if "--model" in sys.argv:
    MODEL = sys.argv[sys.argv.index("--model") + 1]

WORKER = os.environ.get("CUIMOD_WORKER_PROBE_BIN") or os.path.join(
    os.path.expanduser("~"), "AppData", "Roaming", "Claude", "claude-code", "2.1.260", "claude.exe")
if not os.path.exists(WORKER):
    raise SystemExit("Desktop Claude Code 2.1.260 binary not found: " + WORKER)

# ---------------------------------------------------------------- loopback ----
class Stub(BaseHTTPRequestHandler):
    def log_message(self, *a):  # silence
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        if self.path.startswith("/v1/messages/count_tokens"):
            return self._send(200, b'{"input_tokens":4}')
        if self.path.startswith("/v1/messages"):
            msg = {"id": "msg_probe", "type": "message", "role": "assistant", "model": MODEL,
                   "content": [], "stop_reason": None, "usage": {"input_tokens": 4, "output_tokens": 0}}
            events = [
                ("message_start", {"type": "message_start", "message": msg}),
                ("content_block_start", {"type": "content_block_start", "index": 0,
                                         "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0,
                                         "delta": {"type": "text_delta", "text": "ok"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                                   "usage": {"output_tokens": 1}}),
                ("message_stop", {"type": "message_stop"}),
            ]
            body = "".join(f"event: {e}\ndata: {json.dumps(v)}\n\n" for e, v in events).encode()
            return self._send(200, body, "text/event-stream")
        return self._send(200, b"{}")

    def do_GET(self):
        return self._send(200, b"{}")

httpd = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
endpoint = f"http://127.0.0.1:{httpd.server_address[1]}"

# ------------------------------------------------------------------ worker ----
root = tempfile.mkdtemp(prefix="cuimod-env-hook-")
for d in ("home", "appdata", "localappdata", "config"):
    os.makedirs(os.path.join(root, d))

env = {
    "ANTHROPIC_BASE_URL": endpoint,
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL": "1",
    "ANTHROPIC_API_KEY": "cuimod-owned-loopback-probe",
    "CLAUDE_CODE_DONT_INHERIT_ENV": "1",
    "HOME": os.path.join(root, "home"), "USERPROFILE": os.path.join(root, "home"),
    "APPDATA": os.path.join(root, "appdata"), "LOCALAPPDATA": os.path.join(root, "localappdata"),
    "CLAUDE_CONFIG_DIR": os.path.join(root, "config"),
    "PATH": os.environ.get("PATH", ""),
    "SystemRoot": os.environ.get("SystemRoot", r"C:\Windows"),
}
# Deliberately NO CLAUDE_CODE_AUTO_COMPACT_WINDOW: the hook has to introduce it.

args = [WORKER, "--bare", "--print", "--input-format", "stream-json", "--output-format", "stream-json",
        "--verbose", "--model", MODEL, "--autocompact", "auto",
        "--settings", json.dumps({"autoCompactEnabled": True}),
        "--no-session-persistence", "--permission-mode", "dontAsk"]

proc = subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)

pending = {}
init_evt = threading.Event()
stderr_tail = []

def read_stdout():
    buf = b""
    while True:
        chunk = proc.stdout.read(1)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except Exception:
                continue
            if frame.get("type") == "system" and frame.get("subtype") == "init":
                init_evt.set()
            if frame.get("type") == "control_response":
                rid = frame.get("response", {}).get("request_id")
                ev = pending.get(rid)
                if ev:
                    ev["response"] = frame.get("response")
                    ev["evt"].set()

def read_stderr():
    while True:
        chunk = proc.stderr.readline()
        if not chunk:
            break
        stderr_tail.append(chunk.decode(errors="replace").rstrip())
        del stderr_tail[:-8]

threading.Thread(target=read_stdout, daemon=True).start()
threading.Thread(target=read_stderr, daemon=True).start()

def send(frame):
    proc.stdin.write((json.dumps(frame) + "\n").encode())
    proc.stdin.flush()

seq = 0
def usage(timeout=25):
    global seq
    seq += 1
    rid = f"probe-{seq}"
    evt = threading.Event()
    pending[rid] = {"evt": evt, "response": None}
    send({"type": "control_request", "request_id": rid, "request": {"subtype": "get_context_usage"}})
    evt.wait(timeout)
    return pending.pop(rid)["response"]

# The worker initialises on its first input frame, not on spawn.
send({"type": "user", "message": {"role": "user", "content": "reply with exactly ok"}})
if not init_evt.wait(60):
    print(json.dumps({"error": "worker never reported system/init", "stderr": stderr_tail}, indent=2))
    proc.kill(); httpd.shutdown(); shutil.rmtree(root, ignore_errors=True); raise SystemExit(1)

pid = proc.pid

# ------------------------------------------------------------------- frida ----
AGENT = r"""
const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
let override = null;
let hits = {};
const held = [];              // keep injected strings alive
const errors = [];
let anyReads = 0;
function bump(n){ hits[n] = (hits[n]||0)+1; }
function bumpAny(nm){ anyReads++; }

// Frida 17 dropped the two-arg static Module.getExportByName. Resolve through
// the module instance, falling back to a global export search.
function resolve(mod, name){
  try {
    const m = Process.findModuleByName(mod);
    if (m){ const a = m.findExportByName(name); if (a) return a; }
  } catch(e){ errors.push(mod+'!'+name+': '+e.message); }
  try {
    if (typeof Module.getGlobalExportByName === 'function'){
      const a = Module.getGlobalExportByName(name); if (a) return a;
    }
  } catch(e){}
  return null;
}

function hookW(mod, name){
  const addr = resolve(mod, name); if (!addr) return false;
  Interceptor.attach(addr, {
    onEnter(a){ try { this.name = a[0].readUtf16String(); } catch(e){ this.name = null; }
      this.buf = a[1]; this.size = a[2].toInt32(); this.match = this.name === KEY; bumpAny(this.name); },
    onLeave(ret){
      if(!this.match) return;
      bump(name);
      if(override !== null){
        const v = override;
        if(this.size >= v.length + 1){ this.buf.writeUtf16String(v); ret.replace(ptr(v.length)); }
        else ret.replace(ptr(v.length + 1)); // ask caller to retry with a bigger buffer
      }
    }
  });
  return true;
}

function hookA(mod, name){
  const addr = resolve(mod, name); if (!addr) return false;
  Interceptor.attach(addr, {
    onEnter(a){ try { this.name = a[0].readUtf8String(); } catch(e){ this.name = null; }
      this.buf = a[1]; this.size = a[2].toInt32(); this.match = this.name === KEY; bumpAny(this.name); },
    onLeave(ret){
      if(!this.match) return;
      bump(name);
      if(override !== null){
        const v = override;
        if(this.size >= v.length + 1){ this.buf.writeUtf8String(v); ret.replace(ptr(v.length)); }
        else ret.replace(ptr(v.length + 1));
      }
    }
  });
  return true;
}

// char*/wchar_t* getenv family: returned pointer is the whole value.
function hookGet(mod, name, wide){
  const addr = resolve(mod, name); if (!addr) return false;
  Interceptor.attach(addr, {
    onEnter(a){ try { this.name = wide ? a[0].readUtf16String() : a[0].readUtf8String(); }
      catch(e){ this.name = null; } this.match = this.name === KEY; bumpAny(this.name); },
    onLeave(ret){
      if(!this.match) return;
      bump(name);
      if(override !== null){
        const s = wide ? Memory.allocUtf16String(override) : Memory.allocUtf8String(override);
        held.push(s); ret.replace(s);
      }
    }
  });
  return true;
}

const hooked = [];
for (const m of ['kernel32.dll','kernelbase.dll']){
  if (hookW(m, 'GetEnvironmentVariableW')) hooked.push(m+'!GetEnvironmentVariableW');
  if (hookA(m, 'GetEnvironmentVariableA')) hooked.push(m+'!GetEnvironmentVariableA');
}
for (const m of ['ucrtbase.dll','msvcrt.dll','api-ms-win-crt-environment-l1-1-0.dll']){
  if (hookGet(m, 'getenv', false)) hooked.push(m+'!getenv');
  if (hookGet(m, '_wgetenv', true)) hooked.push(m+'!_wgetenv');
  if (hookGet(m, 'getenv_s', false)) hooked.push(m+'!getenv_s');
}

rpc.exports = {
  setOverride(v){ override = v; return true; },
  hits(){ const h = hits; hits = {}; return h; },
  anyReads(){ const a = anyReads; anyReads = 0; return a; },
  hooked(){ return hooked; },
  errors(){ return errors; },
};
"""

session = frida.attach(pid)
script = session.create_script(AGENT)
script_logs = []
script.on("message", lambda m, d: script_logs.append(m))
script.load()
api = script.exports_sync

report = {"worker": os.path.basename(WORKER), "model": MODEL, "pid": pid,
          "hooked": api.hooked(), "hookErrors": api.errors(), "steps": []}

def sample(label):
    u = usage() or {}
    r = u.get("response") if "response" in u else u
    r = r or {}
    return {"step": label, "rawMaxTokens": r.get("rawMaxTokens"), "threshold": r.get("autoCompactThreshold"),
            "source": r.get("autocompactSource"), "model": r.get("model"),
            "keyHits": api.hits(), "anyNativeEnvReads": api.any_reads()}

try:
    api.hits()  # clear
    report["steps"].append(sample("baseline (no env, hook idle)"))

    api.set_override("400000")
    time.sleep(0.2)
    report["steps"].append(sample("override 400000"))

    api.set_override("1000000")
    time.sleep(0.2)
    report["steps"].append(sample("override 1000000"))

    # A real turn, in case a native env read happens on a turn boundary rather
    # than inside get_context_usage.
    send({"type": "user", "message": {"role": "user", "content": "reply with exactly ok"}})
    time.sleep(6)
    report["steps"].append(sample("override 1000000 after a turn"))

    first = report["steps"][1]["rawMaxTokens"]
    second = report["steps"][2]["rawMaxTokens"]
    report["keyReadLive"] = any(s["keyHits"] for s in report["steps"])
    report["anyNativeEnvReadsSeen"] = any(s["anyNativeEnvReads"] for s in report["steps"])
    report["transitioned"] = first == 400000 and second == 1000000
    report["samePid"] = pid
finally:
    try: script.unload()
    except Exception: pass
    try: session.detach()
    except Exception: pass
    try: proc.stdin.close()
    except Exception: pass
    proc.kill()
    httpd.shutdown()
    shutil.rmtree(root, ignore_errors=True)

if stderr_tail:
    report["stderr"] = stderr_tail
print(json.dumps(report, indent=2))
