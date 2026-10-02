import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Immutable gzip archives sit beside the active JSONL tail. Readers replay the
// archives oldest-first and then the tail, so rotation changes storage only;
// deduplicating ledgers retain exactly the same logical history.
export function jsonlSources(file)
{
    const dir = path.dirname(file);
    const name = path.basename(file, '.jsonl');
    const archive = new RegExp(`^${escapeRegExp(name)}\\.archive-[0-9TZ.-]+\\.jsonl\\.gz$`);
    let files = [];
    try { files = fs.readdirSync(dir).filter(value => archive.test(value)).sort().map(value => path.join(dir, value)); }
    catch (_) {}
    if (fs.existsSync(file)) files.push(file);
    return files;
}

export function replayJsonl(file, visit)
{
    for (const source of jsonlSources(file))
    {
        let text;
        try
        {
            const bytes = fs.readFileSync(source);
            text = source.endsWith('.gz') ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
        }
        catch (_) { continue; }
        for (const line of text.split('\n'))
        {
            if (!line.trim()) continue;
            try { visit(JSON.parse(line)); } catch (_) {}
        }
    }
}
