/* Render a handful of single frames to PNG, for looking at a composition
 * without paying for a full render.
 *
 *   node stills.mjs <outDir> <composition>@<seconds> [<composition>@<seconds> ...]
 *
 * Seconds are composition-local, so `tour@33.5` is the frame 33.5s into the
 * tour. The bundle is built once for the whole batch.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderStill } from '@remotion/renderer';

const here = path.dirname(fileURLToPath(import.meta.url));
const [outDir, ...specs] = process.argv.slice(2);
if (!outDir || !specs.length) {
    console.error('usage: node stills.mjs <outDir> <composition>@<seconds> ...');
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const serveUrl = await bundle({ entryPoint: path.join(here, 'src', 'index.ts') });
for (const spec of specs) {
    const [id, at] = spec.split('@');
    const composition = await selectComposition({ serveUrl, id });
    const frame = Math.min(composition.durationInFrames - 1, Math.round(Number(at) * composition.fps));
    const output = path.join(outDir, `${id}-${String(Number(at)).replace('.', '_')}.png`);
    await renderStill({ composition, serveUrl, output, frame, logLevel: 'error' });
    console.log(output);
}
