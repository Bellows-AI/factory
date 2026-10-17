import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { expect } from 'vitest';
import { INTERRUPTION_BUDGET } from '../src/db/job-store.js';
import type { TestUser } from './harness.js';

/**
 * Helpers the db suites used to copy file by file. Each is the verbatim body those copies shared;
 * a suite with a genuinely different shape keeps its own.
 */

/** Unwraps a create that must succeed — a refusal (`'purging'`) is a broken fixture, not a case. */
export const mustCreate = (p: Promise<{ id: string } | 'purging'>): Promise<{ id: string }> =>
    p.then((ref) => {
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        return ref;
    });

/**
 * Turns a slice of a uuid into a plausible github id — hex digits, parsed as base 16 — never one
 * already handed out in this process: a 32-bit draw can repeat, and a repeat is a duplicate key.
 */
const HEX_RADIX = 16;
const UUID_HEX_SLICE_LENGTH = 8;
const issuedGithubIds = new Set<number>();
export const randomGithubId = (): number => {
    let id: number;
    do {
        id = Number.parseInt(randomUUID().slice(0, UUID_HEX_SLICE_LENGTH), HEX_RADIX);
    } while (issuedGithubIds.has(id));
    issuedGithubIds.add(id);
    return id;
};

/**
 * A generated identity for `useTestDb({ users })`, never a literal: integration tests do not
 * hardcode ids, and a random one cannot collide with a real backfilled user the way a memorable
 * constant eventually would.
 */
export const testUser = (login: string): TestUser => ({ id: randomUUID(), githubUserId: randomGithubId(), login });

/** A generated org id for `useTestDb({ orgs })` — numeric, because a real org id is an installation id. */
export const testOrg = (): string => String(randomGithubId());

/** Upserts an account by github id and answers its row id. */
export const account = async (sql: Sql, githubUserId: number, login: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
        on conflict (github_user_id) do update set github_login = excluded.github_login
        returning id
    `;
    return row!.id;
};

/** Lets the job's lease lapse, so the next claim may take it over. */
export const expireLease = (sql: Sql, id: string) =>
    sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

/**
 * Fills the job's interruption record to the budget, so its next lease expiry spends an attempt
 * the way it did before recovery accounting (issue #822). Negative claim sequences never match a
 * real claim's.
 */
export const spendInterruptionBudget = (sql: Sql, id: string) =>
    sql`
        update job set interruptions = (
            select jsonb_agg(jsonb_build_object('reason', 'spent by the fixture', 'at', now(), 'claimSeq', -n))
            from generate_series(1, ${INTERRUPTION_BUDGET}) as n
        )
        where id = ${id}
    `;

/**
 * Holds a lock on `id` in another transaction until `release()` — the per-thread advisory lock
 * (claim, remove, reopen, done all take it) or the job row's own lock. `beforeCommit` runs inside
 * that transaction after the release, for a racing write that commits with the lock.
 */
export const holdLock = async (
    sql: Sql,
    lock: 'thread' | 'row',
    id: string,
    beforeCommit?: (tx: TransactionSql) => Promise<unknown>
): Promise<{ release: () => Promise<void> }> => {
    let lockTaken: (() => void) | null = null;
    const locked = new Promise<void>((resolve) => {
        lockTaken = resolve;
    });
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const blocker = sql.begin(async (tx) => {
        if (lock === 'thread') await tx`select pg_advisory_xact_lock(hashtextextended(${id}::text, 0))`;
        else await tx`select id from job where id = ${id} for update`;
        lockTaken!();
        await held;
        await beforeCommit?.(tx);
    });
    blocker.catch(() => {});
    await locked;
    return {
        release: async () => {
            release!();
            await blocker;
        },
    };
};

/** Lapses the claim reservation a failed or abandoned preparation left (issue #822), as waiting it out would. */
export const lapseDeferral = (sql: Sql, id: string) =>
    sql`update job set claim_deferred_until = now() - interval '1 second' where id = ${id}`;

/**
 * The inverse of `expectStillLocked`: the write must land while another claim is still preparing,
 * because nothing it waits on is held. Answers what the write answered.
 */
export const expectUnblocked = async <T>(pending: Promise<T>): Promise<T> => {
    const UNBLOCKED_TIMEOUT_MS = 2000;
    const blocked = Symbol('blocked');
    const outcome = await Promise.race([
        pending,
        new Promise<typeof blocked>((resolve) => setTimeout(() => resolve(blocked), UNBLOCKED_TIMEOUT_MS)),
    ]);
    expect(outcome).not.toBe(blocked);
    return outcome as T;
};

/**
 * The timer is the assertion device: the write must still be waiting when it fires, not deciding
 * against a snapshot taken before the lock was even taken.
 */
export const expectStillLocked = async (pending: Promise<unknown>): Promise<void> => {
    const STILL_LOCKED_TIMEOUT_MS = 450;
    const outcome = await Promise.race([
        pending,
        new Promise<string>((resolve) => setTimeout(() => resolve('still_locked'), STILL_LOCKED_TIMEOUT_MS)),
    ]);
    expect(outcome).toBe('still_locked');
};

/** Asserts a banked wall clock of `minutes` whole minutes, with a second's slack below and a minute above. */
export const expectMinutes = (wall: number | null, minutes: number): void => {
    const MS_PER_MINUTE = 60_000;
    const SLACK_MS = 1000;
    expect(wall).toBeGreaterThanOrEqual(minutes * MS_PER_MINUTE - SLACK_MS);
    expect(wall).toBeLessThan((minutes + 1) * MS_PER_MINUTE);
};

/** An ISO stamp verbatim, or `minutes` before now, or null when neither is given. */
export const stampOrMinutesAgo = (sql: Sql, iso: string | undefined, minutes: number | undefined) =>
    iso ?? (minutes === undefined ? null : sql`now() - (${minutes} * interval '1 minute')`);

export interface CraftShape {
    /** Overrides the thread root for rows whose parent is not the root itself. */
    root?: string;
    /** Chains a follow-up. */
    parent?: string | null;
    status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'stopped';
    command?: string;
    createdMinutesAgo?: number;
    startedMinutesAgo?: number;
    finishedMinutesAgo?: number;
    /** Stamps done_at (and done_by, the row's author). */
    doneMinutesAgo?: number;
    /** Exact stamps; each wins over its `*MinutesAgo` twin. */
    at?: { created?: string; started?: string; finished?: string; done?: string };
    wallClockMs?: number;
    summary?: string;
    /** Stamps stopped_by with the row's author. */
    stoppedBy?: boolean;
    runtime?: Record<string, unknown>;
    /** Defaults to `acme/widgets`; null writes a repo-less row. */
    repo?: string | null;
    /** Defaults to the suite's author; null writes an authorless row. */
    author?: string | null;
    /** Defaults to expired, so a queued row is claimable at once. */
    lease?: 'live' | 'expired';
}

/**
 * Writes a job row in whatever state the case needs, straight SQL — every column a case can ask
 * for, each null (or its column default) unless asked.
 */
export const craftJob = async (
    ctx: { sql: Sql; org: string; author: string },
    shape: CraftShape = {}
): Promise<string> => {
    const { sql } = ctx;
    const id = randomUUID();
    const author = shape.author === undefined ? ctx.author : shape.author;
    const done = shape.at?.done !== undefined || shape.doneMinutesAgo !== undefined;
    await sql`
        insert into job (org_id, id, command, status, parent_job_id, root_job_id, created_by, repo, stopped_by,
                         lease_expires_at, created_at, started_at, finished_at, wall_clock_ms, summary,
                         done_at, done_by, runtime)
        values (
            ${ctx.org}, ${id}, ${shape.command ?? 'crafted'},
            ${shape.status ?? 'queued'},
            ${shape.parent ?? null},
            ${shape.root ?? shape.parent ?? id},
            ${author},
            ${shape.repo === undefined ? 'acme/widgets' : shape.repo},
            ${shape.stoppedBy === true ? author : null},
            ${shape.lease === 'live' ? sql`now() + interval '5 minutes'` : sql`now() - interval '1 second'`},
            ${shape.at?.created ?? sql`now() - (${shape.createdMinutesAgo ?? 0} * interval '1 minute')`},
            ${stampOrMinutesAgo(sql, shape.at?.started, shape.startedMinutesAgo)},
            ${stampOrMinutesAgo(sql, shape.at?.finished, shape.finishedMinutesAgo)},
            ${shape.wallClockMs ?? null},
            ${shape.summary ?? null},
            ${stampOrMinutesAgo(sql, shape.at?.done, shape.doneMinutesAgo)},
            ${done ? author : null},
            ${shape.runtime === undefined ? null : sql.json(shape.runtime as never)}
        )
    `;
    return id;
};
