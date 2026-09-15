/**
 * A synthetic dataset, shaped like a real one.
 *
 * This exists because the database is now the only source a running dashboard reads from, so
 * "run it without touching GitHub" has to mean "run it against a database somebody filled in"
 * rather than "run it against a replayed HTTP payload". Sessions are written in exactly the shape
 * the ingest pipeline stores — `session_branch` rows and delta `metric_point` rows — so the seeded
 * database agrees with a real one about its own schema.
 *
 * DETERMINISTIC ON PURPOSE. A fresh random dataset per run would make the browser check's
 * assertions unstable and every screenshot diff meaningless, so the PRNG is seeded and the output
 * is a pure function of `SeedOptions`. Change anything here and the numbers move — which is why
 * the browser spec asserts on structure and on a couple of pinned landmarks, never on a figure
 * that this file is free to change.
 *
 * This data is SYNTHETIC and must never be mistaken for measurement. Nothing here is a real
 * session or a real token count. The seeding CLI refuses any database whose name does not mark it
 * disposable, which is the mechanical half of that promise.
 */

export interface SeedOptions {
    /** "owner/name". Every generated session is stamped with it. */
    readonly repo: string;
    /** The dataset ends here. Everything is generated backwards from it. */
    readonly now: Date;
    /** How far back to generate. 26 weeks gives the weekly charts a real shape. */
    readonly weeks?: number;
    /** Sessions per week. The generator varies the real count around this. */
    readonly perWeek?: number;
    /** Changing this reshuffles the whole dataset while keeping it reproducible. */
    readonly seed?: number;
}

export interface SyntheticData {
    readonly sessions: SyntheticSession[];
    /**
     * The board side of the dataset: job rows that attribute a subset of the sessions to
     * synthetic members, so the attribution join, the per-task statistics and both scopes all
     * have something real-shaped to resolve. Sessions with no matching job row stay
     * unattributed — that state is part of what the seed must represent.
     */
    readonly jobs: SyntheticJob[];
}

export interface SyntheticJob {
    readonly id: string;
    /** The thread root. A follow-up carries its parent's root and adds a job turn. */
    readonly rootJobId: string;
    readonly parentJobId: string | null;
    /** The synthetic member who queued the run, by login. */
    readonly createdBy: string;
    readonly sessionId: string;
    readonly createdAt: string;
    /**
     * Agent turns counted at close. Null for some runs on purpose: unmeasured is a real state
     * (a killed run, a failed read), and the task statistics must show a task excluded from the
     * turn distribution beside tasks that measured.
     */
    readonly agentTurns: number | null;
}

/** The synthetic members the board rows attribute to. Stable ids keep the dataset reproducible. */
export const SYNTHETIC_MEMBERS = [
    { githubUserId: 990_001, login: 'seed-alice', displayName: 'Seed Alice' },
    { githubUserId: 990_002, login: 'seed-bob', displayName: 'Seed Bob' },
] as const;

/**
 * One agent session, in the shape the two telemetry tables want.
 *
 * Not `TelemetryInput`: that is the *read* model, assembled by SQL views out of raw datapoints.
 * Seeding has to write what the views read, or the seeded database would disagree with a real one
 * about its own schema.
 */
export interface SyntheticSession {
    readonly sessionId: string;
    readonly repo: string;
    readonly branch: string;
    readonly firstSeen: string;
    readonly lastSeen: string;
    readonly samples: number;
    /** field -> value, already summed. Written as delta datapoints. */
    readonly fields: Readonly<Record<string, number>>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const AREAS = ['auth', 'billing', 'search', 'ingest', 'ui', 'api', 'metrics', 'cache'] as const;

/**
 * mulberry32. Small, fast, and — the only property that matters here — identical across Node
 * versions and platforms, which `Math.random()` seeded by anything is not.
 */
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

export function generate(options: SeedOptions): SyntheticData {
    const { repo, now } = options;
    const weeks = options.weeks ?? 26;
    const perWeek = options.perWeek ?? 6;
    const random = rng(options.seed ?? 20_260_824);

    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const chance = (p: number) => random() < p;

    const start = new Date(now.getTime() - weeks * 7 * DAY);
    const sessions: SyntheticSession[] = [];
    const jobs: SyntheticJob[] = [];
    let number = 100;

    for (let week = 0; week < weeks; week += 1) {
        // Varied per week, or every bar on the weekly chart is the same height and the trend is
        // indistinguishable from a constant.
        //
        // The occasional dead week is deliberate: the aggregation seeds every week in the window
        // including the empty ones, and a dataset where every single week is busy never exercises
        // that.
        const count = chance(0.08) ? 0 : Math.max(1, perWeek + between(-2, 2));

        for (let i = 0; i < count; i += 1) {
            number += 1;
            const createdAt = new Date(start.getTime() + week * 7 * DAY + between(0, 6) * DAY + between(9, 18) * HOUR);
            if (createdAt >= now) continue;

            const area = pick(AREAS);
            const branch = `${pick(['feat', 'fix', 'chore'])}/${area}-${number}`;
            const s = session(repo, branch, createdAt, between(1, 40), random, now);
            sessions.push(s);
            attribute(jobs, s, random);
        }
    }

    // A few sessions on scratch branches — work that reached no shared branch, which is a real
    // state and reads as a bug when it is always empty. None of these get board rows: sessions
    // nobody queued are the unattributed figure the dashboard must keep honest.
    for (let i = 0; i < 6; i += 1) {
        const at = new Date(now.getTime() - between(1, weeks * 7) * DAY);
        sessions.push(session(repo, `spike/${pick(AREAS)}-${i}`, at, between(2, 20), random, now));
    }

    return { sessions, jobs };
}

/**
 * Gives a session a board thread some of the time: a root job row attributed to a synthetic
 * member, occasionally with a follow-up beside it. Three states land in the dataset on purpose —
 * attributed sessions, unattributed ones, and threads whose turn count is partly unmeasured.
 */
function attribute(jobs: SyntheticJob[], s: SyntheticSession, random: () => number): void {
    const chance = (p: number) => random() < p;
    if (!chance(0.75)) return;

    const member = SYNTHETIC_MEMBERS[Math.floor(random() * SYNTHETIC_MEMBERS.length)]!;
    const rootId = sha(`job:${s.sessionId}`).slice(0, 32);
    const turns = () => (chance(0.7) ? Math.floor(random() * 60) + 1 : null);
    jobs.push({
        id: rootId,
        rootJobId: rootId,
        parentJobId: null,
        createdBy: member.login,
        sessionId: s.sessionId,
        createdAt: s.firstSeen,
        agentTurns: turns(),
    });
    // The occasional follow-up: one more job turn on the same thread and session, its own
    // measurement — sometimes missing where the root's was not.
    if (chance(0.25)) {
        jobs.push({
            id: sha(`job:${s.sessionId}:follow-up`).slice(0, 32),
            rootJobId: rootId,
            parentJobId: rootId,
            createdBy: member.login,
            sessionId: s.sessionId,
            createdAt: s.lastSeen,
            agentTurns: turns(),
        });
    }
}

function session(
    repo: string,
    branch: string,
    createdAt: Date,
    spanHours: number,
    random: () => number,
    now: Date
): SyntheticSession {
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const from = new Date(createdAt.getTime() - between(1, 6) * HOUR);
    const activeSeconds = between(600, 9000);
    // Capped at `now`: a session that claims to be still running after the dataset's cutoff
    // would hand its follow-up rows a future created_at, which every range filter then
    // rightly excludes — the task would keep its session but lose its job turns.
    const to = new Date(
        Math.min(from.getTime() + Math.min(spanHours * HOUR, activeSeconds * 1000 * between(2, 5)), now.getTime())
    );
    const input = between(4_000, 60_000);

    return {
        sessionId: sha(`${repo}:${branch}:${createdAt.toISOString()}`).slice(0, 32),
        repo,
        branch,
        firstSeen: from.toISOString(),
        lastSeen: to.toISOString(),
        // Sampled roughly every 20s, so the count follows the span rather than being invented.
        samples: Math.max(1, Math.round((to.getTime() - from.getTime()) / 20_000)),
        fields: {
            tokens_input: input,
            tokens_output: between(1_000, 18_000),
            // Cache reads dwarf fresh input on a long conversation, which is what makes the token
            // panel's split worth drawing at all.
            tokens_cacheRead: input * between(8, 30),
            tokens_cacheCreation: between(2_000, 40_000),
            lines_added: between(10, 700),
            lines_removed: between(2, 300),
            edits_accept: between(2, 60),
            edits_reject: between(0, 12),
            active_seconds: activeSeconds,
        },
    };
}

/** Not cryptographic and never claims to be — it only has to be stable and look like a sha. */
function sha(input: string): string {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < input.length; i += 1) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2_654_435_761);
        h2 = Math.imul(h2 ^ ch, 1_597_334_677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
    const a = (h2 >>> 0).toString(16).padStart(8, '0');
    const b = (h1 >>> 0).toString(16).padStart(8, '0');
    return `${a}${b}${a}${b}${a}`.slice(0, 40);
}
