/* The mock session: a task list that evolves on a timeline, a transcript that
 * streams, and the numbers the meters read.
 *
 * Task objects carry exactly the fields the real store holds
 * (id, subject, description, activeForm, status, owner, blockedBy), because the
 * rail renders those and nothing else.
 */

export type Status = 'pending' | 'in_progress' | 'completed';

export type Task = {
    id: string;
    subject: string;
    activeForm: string;
    description: string;
    status: Status;
    owner?: string;
    blockedBy?: string[];
};

const T: Omit<Task, 'status'>[] = [
    {
        id: '1',
        subject: 'Read the shipped preload for the claude.ai view',
        activeForm: 'Reading the shipped preload',
        description:
            'mainView.js, ~239KB, referenced 5 times — main window, popouts, quick window, 3p setup, device code. One append covers every window.',
        owner: 'patcher',
    },
    {
        id: '2',
        subject: 'Re-point header entries instead of repacking the asar',
        activeForm: 'Re-pointing the asar header entries',
        description:
            'Appending past the data region keeps all 6 unpacked flags and every untouched per-file integrity record byte-identical. Verified: 432 entries compared, 0 mismatches.',
        owner: 'patcher',
    },
    {
        id: '3',
        subject: 'Repoint the integrity hash baked into claude.exe',
        activeForm: 'Repointing the integrity hash in claude.exe',
        description:
            'sha256 of the header JSON bytes only. Skipping this is the boot-time FATAL asar_util.cc:144, written to a stderr nobody reads.',
        owner: 'patcher',
    },
    {
        id: '4',
        subject: 'Bake the two loaders, keep everything else hot',
        activeForm: 'Baking the two loaders',
        description:
            'main-hook and preload-hook own the IPC surface and the file watcher. Nothing else needs a re-patch, ever.',
        owner: 'runtime',
    },
    {
        id: '5',
        subject: 'Watch for the next Squirrel update and patch it early',
        activeForm: 'Watching for the next app-<version>',
        description:
            'A freshly downloaded version is not the running one, so it patches immediately — the mod is present the first time it launches.',
        owner: 'watcher',
        blockedBy: ['3'],
    },
];

// [appears at, becomes active at, completes at] in seconds. A task not yet at
// its appear time is simply not in the store — which is how it really works.
const SCHEDULE: [number, number, number][] = [
    [0.0, 0.0, 4.2],
    [0.0, 4.2, 7.4],
    [3.0, 7.4, 11.6],
    [5.4, 11.6, 1e9],
    [5.9, 1e9, 1e9],
];

export function tasksAt(t: number): Task[] {
    const out: Task[] = [];
    T.forEach((task, i) => {
        const [appear, active, done] = SCHEDULE[i];
        if (t < appear) return;
        const status: Status = t >= done ? 'completed' : t >= active ? 'in_progress' : 'pending';
        out.push({ ...task, status });
    });
    return out;
}

/** When this row's current content came into existence.
 *
 * The rail keys a row on everything it renders, so a status flip is a new row
 * and fades in like any other. That is reproduced here rather than only fading
 * rows that are genuinely new.
 */
export function rowSince(id: string, status: Status): number {
    const i = T.findIndex((x) => x.id === id);
    const [appear, active, done] = SCHEDULE[i];
    if (status === 'completed') return done;
    if (status === 'in_progress') return Math.max(appear, active);
    return appear;
}

export const SESSION_ID = '9f8e7d6c-5b4a-4321-8765-fedcba987654';

// ---------------------------------------------------------------- transcript
export const USER_MSG =
    'The asar rewrite works but the app dies at boot with no log. Find out what actually validates it.';

export const THINKING = `The archive itself is fine — I compared 432 untouched entries byte for byte.
So the failure is not in the data, it is in something that reads the header.
Electron's asar_util has an integrity path. If the expected hash lives outside
the archive, the only place it can live is the binary.`;

export const ASSISTANT = `Electron validates the asar header hash against a value baked into \`claude.exe\`, and the check runs before any logging exists — which is why there is no log and no crash dump.

The expected value is in the binary as plaintext, exactly once, next to the archive path. The hashed input is the header JSON bytes only: \`sha256(JSON.stringify(header))\`. Confirmed by brute force over every plausible range.

Fix is length-preserving, so no PE relocation is involved: rewrite the archive, then overwrite that 64-character field with the new header hash.`;

export const CODE = `const r = asar.repointExeIntegrity(a.exe, newHeaderHash, a.exeBackup);
fs.rmSync(a.asar, { force: true });   // EBUSY if this build is running
fs.renameSync(tmp, a.asar);`;

// ---------------------------------------------------------------- meters
export const CONTEXT_MAX = 1_000_000;
export function contextAt(t: number): number {
    // Climbs as the turn streams, then jumps when the transcript is read in.
    const base = 148_000 + t * 5_600;
    const bump = t > 8.4 ? 96_000 : 0;
    return Math.round(base + bump);
}
export const COMPACT_AT = 967_000;
export const LIMIT_PCT = 67;
export const LIMIT_LABEL = '7d';
export const RESETS = 'Mon, Aug 31, 9:00 AM';
export const LIMIT_SERIES = [41, 44, 44, 48, 52, 51, 55, 58, 57, 60, 63, 62, 65, 67];
