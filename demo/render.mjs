/* Render every composition to MP4, then make a GitHub-embeddable GIF of each.
 *
 *   node render.mjs                  everything
 *   node render.mjs tour             one composition
 *   node render.mjs crop-queue ...   several
 *
 * MP4 is the master; the GIF is what a README can play inline. GIFs go through
 * ffmpeg's two-pass palette so the dark UI does not band — a single-pass GIF of
 * this palette looks like a fax of it.
 *
 * GitHub will not inline a GIF much past 5 MB, so each GIF is tried at its
 * preferred width/frame rate/palette and then at progressively cheaper settings
 * until it fits MAX_GIF_BYTES. The MP4 is never touched by that.
 *
 * Nothing here opens a window: every child is spawned with windowsHide, and the
 * Remotion CLI is run through this node binary rather than through cmd.exe.
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
const remotionCli = path.join(here, 'node_modules', '@remotion', 'cli', 'remotion-cli.js');

const MAX_GIF_BYTES = 5 * 1024 * 1024;

/** width and frame rate of the GIF; the MP4 keeps the full resolution.
 *  maxBytes overrides MAX_GIF_BYTES for a GIF that has a smaller budget. */
const JOBS = [
    { id: 'tour', gifWidth: 860, gifFps: 12 },
    { id: 'crop-task-rail', gifWidth: 400, gifFps: 15 },
    { id: 'crop-usage-bar', gifWidth: 900, gifFps: 15 },
    { id: 'crop-dashboard', gifWidth: 900, gifFps: 14 },
    { id: 'crop-transcript', gifWidth: 820, gifFps: 12 },
    { id: 'crop-provider-picker', gifWidth: 800, gifFps: 14 },
    // a title card that sits under the README hero; held tighter than the 5 MB default
    { id: 'plugin-wall', gifWidth: 900, gifFps: 15, maxBytes: 3 * 1024 * 1024 },
    { id: 'crop-subagents', gifWidth: 900, gifFps: 12 },
    { id: 'crop-throughput', gifWidth: 900, gifFps: 12 },
    { id: 'crop-queue', gifWidth: 820, gifFps: 12 },
];

const only = process.argv.slice(2);
const jobs = only.length ? JOBS.filter((j) => only.includes(j.id)) : JOBS;
if (!jobs.length) {
    console.error('unknown composition: ' + only.join(' '));
    process.exit(2);
}

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(media, { recursive: true });

const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) throw new Error(cmd + ' failed (' + r.status + ')');
};

// Always re-extract first: a stale generated-css.js would render the demo
// against CSS the plugins no longer ship, which is the one thing this project
// is supposed to make impossible.
run(process.execPath, [path.join(here, 'gen-css.mjs')]);

function gif(job, mp4, dest) {
    const attempts = [
        [1, 1, 256],
        [1, 1, 128],
        [0.88, 0.85, 128],
        [0.84, 0.67, 96],
        [0.78, 0.67, 96],
        [0.7, 0.6, 64],
    ];
    for (const [wScale, fScale, colors] of attempts) {
        const width = Math.round((job.gifWidth * wScale) / 2) * 2;
        const fps = Math.max(6, Math.round(job.gifFps * fScale));
        const palette = path.join(out, job.id + '-palette.png');
        const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
        run('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', `${filters},palettegen=stats_mode=diff:max_colors=${colors}`, palette]);
        run('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-i', mp4, '-i', palette,
            '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
            dest,
        ]);
        fs.rmSync(palette, { force: true });
        const size = fs.statSync(dest).size;
        console.log(`  ${job.id}.gif ${width}px ${fps}fps ${colors} colours -> ${(size / 1024 / 1024).toFixed(2)} MB`);
        if (size <= (job.maxBytes ?? MAX_GIF_BYTES)) return;
    }
    throw new Error(job.id + '.gif does not fit ' + (job.maxBytes ?? MAX_GIF_BYTES) + ' bytes at the cheapest setting');
}

for (const job of jobs) {
    const mp4 = path.join(out, job.id + '.mp4');
    console.log('\n=== ' + job.id + ' ===');
    run(process.execPath, [remotionCli, 'render', job.id, mp4, '--codec=h264', '--crf=17', '--log=error']);
    gif(job, mp4, path.join(media, job.id + '.gif'));

    // The tour is the one worth keeping at full resolution in the repo.
    if (job.id === 'tour') fs.copyFileSync(mp4, path.join(media, 'tour.mp4'));
}

for (const f of fs.readdirSync(media)) {
    const s = fs.statSync(path.join(media, f));
    console.log(f.padEnd(30) + (s.size / 1024 / 1024).toFixed(2) + ' MB');
}
