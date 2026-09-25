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
const DAYS_PER_WEEK = 7;
const DAY = 24 * HOUR;

const AREAS = ['auth', 'billing', 'search', 'ingest', 'ui', 'api', 'metrics', 'cache'] as const;

/**
 * mulberry32. Small, fast, and — the only property that matters here — identical across Node
 * versions and platforms, which `Math.random()` seeded by anything is not.
 */
const MULBERRY32_INCREMENT = 0x6d2b79f5;
const MULBERRY32_SHIFT_A = 15;
const MULBERRY32_SHIFT_B = 7;
const MULBERRY32_OR_MASK = 61;
const MULBERRY32_SHIFT_C = 14;
/** 2**32 — the normalization divisor that turns the mixed uint32 into a [0, 1) float. */
const UINT32_SPACE = 4_294_967_296;

function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + MULBERRY32_INCREMENT) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> MULBERRY32_SHIFT_A), t | 1);
        t ^= t + Math.imul(t ^ (t >>> MULBERRY32_SHIFT_B), t | MULBERRY32_OR_MASK);
        return ((t ^ (t >>> MULBERRY32_SHIFT_C)) >>> 0) / UINT32_SPACE;
    };
}

const WEEKS_DEFAULT = 26;
const PER_WEEK_DEFAULT = 6;
/** Any fixed value works; this one just happens to be the day the generator was written. */
const SEED_DEFAULT = 20_260_824;

/** How often a week generates no sessions at all — see the comment at its one call site. */
const DEAD_WEEK_CHANCE = 0.08;
/** The per-week count wobbles by up to this many sessions either way of `perWeek`. */
const PER_WEEK_VARIANCE = 2;
const WEEKDAY_MAX = 6;
/** Sessions start during a working day, 09:00..18:00. */
const WORKDAY_START_HOUR = 9;
const WORKDAY_END_HOUR = 18;
const SESSION_SPAN_HOURS_MIN = 1;
const SESSION_SPAN_HOURS_MAX = 40;
const SCRATCH_SESSION_COUNT = 6;
const SCRATCH_SESSION_SPAN_MIN = 2;
const SCRATCH_SESSION_SPAN_MAX = 20;

export function generate(options: SeedOptions): SyntheticData {
    const { repo, now } = options;
    const weeks = options.weeks ?? WEEKS_DEFAULT;
    const perWeek = options.perWeek ?? PER_WEEK_DEFAULT;
    const random = rng(options.seed ?? SEED_DEFAULT);

    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const chance = (p: number) => random() < p;

    const start = new Date(now.getTime() - weeks * DAYS_PER_WEEK * DAY);
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
        const count = chance(DEAD_WEEK_CHANCE)
            ? 0
            : Math.max(1, perWeek + between(-PER_WEEK_VARIANCE, PER_WEEK_VARIANCE));

        for (let i = 0; i < count; i += 1) {
            number += 1;
            const createdAt = new Date(
                start.getTime() +
                    week * DAYS_PER_WEEK * DAY +
                    between(0, WEEKDAY_MAX) * DAY +
                    between(WORKDAY_START_HOUR, WORKDAY_END_HOUR) * HOUR
            );
            if (createdAt >= now) continue;

            const area = pick(AREAS);
            const branch = `${pick(['feat', 'fix', 'chore'])}/${area}-${number}`;
            const spanHours = between(SESSION_SPAN_HOURS_MIN, SESSION_SPAN_HOURS_MAX);
            const s = session({ repo, branch, createdAt, spanHours, random, now });
            sessions.push(s);
            attribute(jobs, s, random);
        }
    }

    // A few sessions on scratch branches — work that reached no shared branch, which is a real
    // state and reads as a bug when it is always empty. None of these get board rows: sessions
    // nobody queued are the unattributed figure the dashboard must keep honest.
    for (let i = 0; i < SCRATCH_SESSION_COUNT; i += 1) {
        const at = new Date(now.getTime() - between(1, weeks * DAYS_PER_WEEK) * DAY);
        const spanHours = between(SCRATCH_SESSION_SPAN_MIN, SCRATCH_SESSION_SPAN_MAX);
        sessions.push(session({ repo, branch: `spike/${pick(AREAS)}-${i}`, createdAt: at, spanHours, random, now }));
    }

    return { sessions, jobs };
}

/** How often a generated session gets a board thread at all. */
const ATTRIBUTION_CHANCE = 0.75;
/** How often a job turn came back measured, versus a killed run or a failed read. */
const TURNS_MEASURED_CHANCE = 0.7;
const TURNS_MAX = 60;
/** How often an attributed session also gets a follow-up turn on the same thread. */
const FOLLOW_UP_CHANCE = 0.25;
/** The synthetic sha is truncated to this length everywhere a job/session id is built from it. */
const ID_LENGTH = 32;

/**
 * Gives a session a board thread some of the time: a root job row attributed to a synthetic
 * member, occasionally with a follow-up beside it. Three states land in the dataset on purpose —
 * attributed sessions, unattributed ones, and threads whose turn count is partly unmeasured.
 */
function attribute(jobs: SyntheticJob[], s: SyntheticSession, random: () => number): void {
    const chance = (p: number) => random() < p;
    if (!chance(ATTRIBUTION_CHANCE)) return;

    const member = SYNTHETIC_MEMBERS[Math.floor(random() * SYNTHETIC_MEMBERS.length)]!;
    const rootId = sha(`job:${s.sessionId}`).slice(0, ID_LENGTH);
    const turns = () => (chance(TURNS_MEASURED_CHANCE) ? Math.floor(random() * TURNS_MAX) + 1 : null);
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
    if (chance(FOLLOW_UP_CHANCE)) {
        jobs.push({
            id: sha(`job:${s.sessionId}:follow-up`).slice(0, ID_LENGTH),
            rootJobId: rootId,
            parentJobId: rootId,
            createdBy: member.login,
            sessionId: s.sessionId,
            createdAt: s.lastSeen,
            agentTurns: turns(),
        });
    }
}

interface SessionOptions {
    readonly repo: string;
    readonly branch: string;
    readonly createdAt: Date;
    readonly spanHours: number;
    readonly random: () => number;
    readonly now: Date;
}

const LOOKBACK_HOURS_MIN = 1;
const LOOKBACK_HOURS_MAX = 6;
const ACTIVE_SECONDS_MIN = 600;
const ACTIVE_SECONDS_MAX = 9000;
const ACTIVE_MULTIPLIER_MIN = 2;
const ACTIVE_MULTIPLIER_MAX = 5;
const MS_PER_SECOND = 1000;
const INPUT_TOKENS_MIN = 4_000;
const INPUT_TOKENS_MAX = 60_000;
const OUTPUT_TOKENS_MIN = 1_000;
const OUTPUT_TOKENS_MAX = 18_000;
/** Cache reads dwarf fresh input on a long conversation — this is the multiplier that does it. */
const CACHE_READ_MULTIPLIER_MIN = 8;
const CACHE_READ_MULTIPLIER_MAX = 30;
const CACHE_CREATION_MIN = 2_000;
const CACHE_CREATION_MAX = 40_000;
const LINES_ADDED_MIN = 10;
const LINES_ADDED_MAX = 700;
const LINES_REMOVED_MIN = 2;
const LINES_REMOVED_MAX = 300;
const EDITS_ACCEPT_MIN = 2;
const EDITS_ACCEPT_MAX = 60;
const EDITS_REJECT_MIN = 0;
const EDITS_REJECT_MAX = 12;
/** Sampled roughly every 20s, so the count follows the span rather than being invented. */
const SAMPLE_INTERVAL_MS = 20_000;

function session(options: SessionOptions): SyntheticSession {
    const { repo, branch, createdAt, spanHours, random, now } = options;
    const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const from = new Date(createdAt.getTime() - between(LOOKBACK_HOURS_MIN, LOOKBACK_HOURS_MAX) * HOUR);
    const activeSeconds = between(ACTIVE_SECONDS_MIN, ACTIVE_SECONDS_MAX);
    // Capped at `now`: a session that claims to be still running after the dataset's cutoff
    // would hand its follow-up rows a future created_at, which every range filter then
    // rightly excludes — the task would keep its session but lose its job turns.
    const to = new Date(
        Math.min(
            from.getTime() +
                Math.min(
                    spanHours * HOUR,
                    activeSeconds * MS_PER_SECOND * between(ACTIVE_MULTIPLIER_MIN, ACTIVE_MULTIPLIER_MAX)
                ),
            now.getTime()
        )
    );
    const input = between(INPUT_TOKENS_MIN, INPUT_TOKENS_MAX);

    return {
        sessionId: sha(`${repo}:${branch}:${createdAt.toISOString()}`).slice(0, ID_LENGTH),
        repo,
        branch,
        firstSeen: from.toISOString(),
        lastSeen: to.toISOString(),
        samples: Math.max(1, Math.round((to.getTime() - from.getTime()) / SAMPLE_INTERVAL_MS)),
        fields: {
            tokens_input: input,
            tokens_output: between(OUTPUT_TOKENS_MIN, OUTPUT_TOKENS_MAX),
            tokens_cacheRead: input * between(CACHE_READ_MULTIPLIER_MIN, CACHE_READ_MULTIPLIER_MAX),
            tokens_cacheCreation: between(CACHE_CREATION_MIN, CACHE_CREATION_MAX),
            lines_added: between(LINES_ADDED_MIN, LINES_ADDED_MAX),
            lines_removed: between(LINES_REMOVED_MIN, LINES_REMOVED_MAX),
            edits_accept: between(EDITS_ACCEPT_MIN, EDITS_ACCEPT_MAX),
            edits_reject: between(EDITS_REJECT_MIN, EDITS_REJECT_MAX),
            active_seconds: activeSeconds,
        },
    };
}

const SHA_SEED_H1 = 0xdeadbeef;
const SHA_SEED_H2 = 0x41c6ce57;
const SHA_MIX_H1 = 2_654_435_761;
const SHA_MIX_H2 = 1_597_334_677;
const SHA_FINAL_MIX_1 = 2_246_822_507;
const SHA_FINAL_MIX_2 = 3_266_489_909;
const SHA_FINAL_SHIFT_16 = 16;
const SHA_FINAL_SHIFT_13 = 13;
const HEX_RADIX = 16;
const HEX_WIDTH = 8;
const SHA_OUTPUT_LENGTH = 40;

/** Not cryptographic and never claims to be — it only has to be stable and look like a sha. */
function sha(input: string): string {
    let h1 = SHA_SEED_H1;
    let h2 = SHA_SEED_H2;
    for (let i = 0; i < input.length; i += 1) {
        const ch = input.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, SHA_MIX_H1);
        h2 = Math.imul(h2 ^ ch, SHA_MIX_H2);
    }
    h1 =
        Math.imul(h1 ^ (h1 >>> SHA_FINAL_SHIFT_16), SHA_FINAL_MIX_1) ^
        Math.imul(h2 ^ (h2 >>> SHA_FINAL_SHIFT_13), SHA_FINAL_MIX_2);
    h2 =
        Math.imul(h2 ^ (h2 >>> SHA_FINAL_SHIFT_16), SHA_FINAL_MIX_1) ^
        Math.imul(h1 ^ (h1 >>> SHA_FINAL_SHIFT_13), SHA_FINAL_MIX_2);
    const a = (h2 >>> 0).toString(HEX_RADIX).padStart(HEX_WIDTH, '0');
    const b = (h1 >>> 0).toString(HEX_RADIX).padStart(HEX_WIDTH, '0');
    return `${a}${b}${a}${b}${a}`.slice(0, SHA_OUTPUT_LENGTH);
}
