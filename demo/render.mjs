/* Render every composition to MP4, then make a GitHub-embeddable GIF of each.
 *
 *   node render.mjs            everything
 *   node render.mjs tour       one composition
 *
 * MP4 is the master; the GIF is what a README can play inline. GIFs go through
 * ffmpeg's two-pass palette so the dark UI does not band — a single-pass GIF of
 * this palette looks like a fax of it.
 *
 * Needs ffmpeg on PATH.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const media = path.join(here, '..', 'docs', 'media');

/** width and frame rate of the GIF; the MP4 keeps the full resolution */
const JOBS = [
    { id: 'tour', gifWidth: 860, gifFps: 12 },
    { id: 'crop-task-rail', gifWidth: 400, gifFps: 15 },
    { id: 'crop-usage-bar', gifWidth: 900, gifFps: 15 },
    { id: 'crop-dashboard', gifWidth: 900, gifFps: 14 },
    { id: 'crop-transcript', gifWidth: 820, gifFps: 12 },
];

const only = process.argv[2];
const jobs = only ? JOBS.filter((j) => j.id === only) : JOBS;
if (!jobs.length) {
    console.error('unknown composition: ' + only);
    process.exit(2);
}

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(media, { recursive: true });

// Always re-extract first: a stale generated-css.js would render the demo
// against CSS the plugins no longer ship, which is the one thing this project
// is supposed to make impossible.
spawnSync(process.execPath, [path.join(here, 'gen-css.mjs')], { stdio: 'inherit' });

const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error(cmd + ' failed (' + r.status + ')');
};

for (const job of jobs) {
    const mp4 = path.join(out, job.id + '.mp4');
    console.log('\n=== ' + job.id + ' ===');
    run('npx', ['remotion', 'render', job.id, mp4, '--codec=h264', '--crf=17', '--log=error']);

    const palette = path.join(out, job.id + '-palette.png');
    const filters = `fps=${job.gifFps},scale=${job.gifWidth}:-1:flags=lanczos`;
    run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
    run('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-i', mp4, '-i', palette,
        '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
        path.join(media, job.id + '.gif'),
    ]);
    fs.rmSync(palette, { force: true });

    // The tour is the one worth keeping at full resolution in the repo.
    if (job.id === 'tour') fs.copyFileSync(mp4, path.join(media, 'tour.mp4'));
}

for (const f of fs.readdirSync(media)) {
    const s = fs.statSync(path.join(media, f));
    console.log(f.padEnd(26) + (s.size / 1024 / 1024).toFixed(2) + ' MB');
}
