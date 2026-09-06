// A user-requested local snapshot of the provider prompt surface before and
// after the active router policy. Keeping both prevents a replacement policy
// from erasing the only editable copy of the incoming system prompt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = 2;
const MAX_ENTRIES = 24;

function file()
{
    const dir = process.env.MODEL_ROUTER_STATE_DIR || path.join(process.env.USERPROFILE || os.homedir(), '.claude', 'gemini-bridge');
    return path.join(dir, 'prompt-policy-capture-v2.json');
}

// The capture file is 5.5 MB after a day of sessions, and this used to run
// synchronously on every provider request: read, parse, re-serialize, write,
// rename. Measured at 47 ms of blocked event loop per Gemini request at idle,
// more under disk contention, on the same thread that streams every Claude
// response. Two facts make nearly all of that wasted: a session's prompt
// surface almost never changes between one request and the next, and this
// worker is the only writer between its own writes. So the entries stay in
// memory, an unchanged surface is one hash comparison and no I/O, and the
// file is re-read only when something else has replaced it, which the
// prompt-policy helper and the tests do.
let cached = null;             // { entries, mtimeMs, size } as this worker last saw the file
const lastHash = new Map();    // provider\0session -> hash of the surface last written

function stat()
{
    try { const s = fs.statSync(file()); return { mtimeMs: s.mtimeMs, size: s.size }; }
    catch (_) { return { mtimeMs: -1, size: -1 }; }
}

function load()
{
    const seen = stat();
    if (cached && cached.mtimeMs === seen.mtimeMs && cached.size === seen.size) return cached.entries;
    let entries = [];
    if (seen.size >= 0) {
        try {
            const value = JSON.parse(fs.readFileSync(file(), 'utf8'));
            entries = value?.version === VERSION && Array.isArray(value.entries) ? value.entries : [];
        }
        catch (_) { entries = []; }
    }
    cached = { entries, ...seen };
    // An external replacement invalidates every skip decision made against the
    // old contents: the surface may be unchanged but the file no longer has it.
    lastHash.clear();
    return entries;
}

export function capturePrompt({ provider, sessionId, model, selection, system, tools, effectiveSystem, effectiveTools })
{
    if (selection?.requestKind === 'control') return;
    const next = {
        provider,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        model: typeof model === 'string' ? model : null,
        capturedAt: new Date().toISOString(),
        policy: { id: selection.id, generation: selection.generation },
        system: system ?? null,
        tools: Array.isArray(tools) ? tools : [],
        effectiveSystem: effectiveSystem ?? null,
        effectiveTools: Array.isArray(effectiveTools) ? effectiveTools : [],
    };
    const entries = load();
    const key = `${next.provider}\u0000${next.sessionId}`;
    const hash = crypto.createHash('sha1')
        .update(JSON.stringify([next.model, next.policy, next.system, next.tools, next.effectiveSystem, next.effectiveTools]))
        .digest('hex');
    if (lastHash.get(key) === hash) return;

    const same = entries.findIndex((entry) => entry.provider === next.provider && entry.sessionId === next.sessionId);
    if (same !== -1) entries.splice(same, 1);
    entries.unshift(next);
    if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
    const tmp = file() + '.tmp';
    try {
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 2));
        fs.renameSync(tmp, file());
        cached = { entries, ...stat() };
        lastHash.set(key, hash);
    }
    catch (_) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        // Whatever is on disk now is not what memory says; re-read next time.
        cached = null;
        lastHash.delete(key);
    }
}

export function promptCaptureFile()
{
    return file();
}
