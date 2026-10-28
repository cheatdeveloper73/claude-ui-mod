// Launcher for the official cua-repl bin. node.exe runs this file with the bin
// path as argv[2]; the bin runs itself on import, so it must be imported once.
// Force hidden launches for JS-spawned CLI children. The installed native
// runtime retains responsibility for its own sandbox worker launch.
// syncBuiltinESMExports is what makes `import { spawn } from 'node:child_process'`
// inside the runtime see the patched functions rather than the originals.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (typeof entry !== 'string' || !path.isAbsolute(entry)) {
    process.stderr.write('hidden-launch: argv[2] must be the absolute runtime entry path\n');
    process.exit(2);
}
// Present the runtime with the argv it would have had under the direct harness.
process.argv.splice(2, 1);

const isOptions = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Signature shared by spawn/spawnSync/execFile/execFileSync/fork:
// (file, [args], [options], [callback]).
function hideOptions(args) {
    const out = [...args];
    if (out.length === 1) {
        out.push([], { windowsHide: true });
    } else if (Array.isArray(out[1])) {
        if (isOptions(out[2])) out[2] = { ...out[2], windowsHide: true };
        else if (out[2] === undefined || out[2] === null) out[2] = { windowsHide: true };
        else out.splice(2, 0, { windowsHide: true });
    } else if (isOptions(out[1])) {
        out[1] = { ...out[1], windowsHide: true };
    } else if (out[1] === undefined || out[1] === null) {
        out[1] = { windowsHide: true };
    } else {
        out.splice(1, 0, [], { windowsHide: true });
    }
    return out;
}

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    childProcess[name] = (...args) => original(...hideOptions(args));
}
syncBuiltinESMExports();

await import(pathToFileURL(entry).href);
