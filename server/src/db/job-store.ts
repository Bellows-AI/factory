import type { Sql } from 'postgres';

export type JobStatus = 'queued' | 'running' | 'standby' | 'succeeded' | 'failed' | 'dead';
/** What a worker may report. 'dead' is the board's verdict, never a worker's. */
export type JobOutcome = 'succeeded' | 'failed';

export interface Job {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    claimedBy: string | null;
    /**
     * The account that queued this job, or null for one queued before accounts existed.
     *
     * This is the audit trail on a route that runs shell commands, and it is also the seam the
     * per-user Claude credential and per-user workspace work reads: a claim reports it so the driver
     * can resolve them without ever touching the database.
     */
    createdBy: string | null;
    /** The agent session this attempt runs as, once its driver has reported it. */
    sessionId: string | null;
    /**
     * The Remote Control session claude.ai addresses this run by (`cse_…`), once the bridge has
     * connected and the driver has read it back. Null for every headless job.
     */
    remoteSessionId: string | null;
    exitCode: number | null;
    output: string | null;
    /**
     * The repository (`owner/name`) the task was queued against, and the member's executor name it
     * was stamped with. Grouping metadata for the tasks chat, nullable for every job that predates
     * it; neither is validated against the member's configured rows and neither changes what a
     * worker runs. See docs/jobs.md.
     */
    repo: string | null;
    executor: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
}

/** What a worker gets back from a successful claim. The lease token is its proof for later. */
export interface Claim {
    id: string;
    command: string;
    attempts: number;
    leaseToken: string;
    leaseExpiresAt: string;
    /**
     * Who queued the job, so a worker can run it as them. Null for an unattributed job.
     *
     * It was shipped ahead of any consumer so that the per-user work would be a change to the
     * driver alone. `workspacePath` below is the first half of that arriving; the per-user Claude
     * credential is still to come, and this field is what it will read.
     */
    userId: string | null;
    /**
     * Where that person's checkouts are, RELATIVE to the workspace root: `<orgId>/<userId>`.
     *
     * Ready-made rather than a raw id, because each side owns what it knows. The server owns the
     * layout — it is the thing that created the directory — and the driver owns where the volume is
     * mounted, which need not be the same path the server sees. Handing over a uuid would make the
     * driver reimplement a layout it cannot verify.
     *
     * Relative for the same reason: an absolute server-side path is meaningless inside a container
     * that mounts the volume somewhere else.
     *
     * Null when the job has no author, or when this deployment has no workspace root. The driver
     * FAILS such a job rather than falling back — see driver/src/loop.ts.
     */
    workspacePath: string | null;
    /**
     * Set only when this claim is picking a parked job back up, and it is the whole resume protocol:
     * the worker restores that session instead of starting a new one, and the command is not
     * re-delivered — it was delivered on the first run and is in the transcript.
     */
    resumeSessionId: string | null;
}

/**
 * Why a write was refused.
 *
 * - `lost`    the job is no longer running under this token — the lease expired and someone else
 *             has it, or the board gave up on it. The caller must stop working.
 * - `missing` no such job in this organization.
 */
export type LeaseResult = 'ok' | 'lost' | 'missing';

export interface JobStore {
    /**
     * `createdBy` is a parameter rather than something read off the body, and the route passes the
     * authenticated caller's id. A client-supplied one would be impersonation on the audit trail of
     * a route that runs shell commands.
     *
     * `target` carries the optional repo/executor labels the tasks chat groups and displays by.
     */
    create(command: string, createdBy: string | null, target: { repo: string | null; executor: string | null }): Promise<{ id: string }>;
    /** The oldest claimable job, or null when there is none. Never blocks on a live lease. */
    claim(worker: string, leaseSeconds: number): Promise<Claim | null>;
    heartbeat(id: string, leaseToken: string, leaseSeconds: number): Promise<{ result: LeaseResult; leaseExpiresAt: string | null }>;
    /**
     * Records the agent session the running attempt is using, so a reader can open it. Lease-guarded
     * like every other worker write: a superseded worker must not relabel the run that replaced it.
     *
     * Called more than once per attempt: the local id is known before the container starts, and the
     * remote one only after the bridge connects. A null `remoteSessionId` therefore leaves whatever
     * is already stored alone rather than clearing it.
     */
    session(
        id: string,
        leaseToken: string,
        sessionId: string,
        remoteSessionId: string | null,
    ): Promise<LeaseResult>;
    /**
     * Parks a running job: the container is gone, but the job is not finished and its session is
     * kept so it can be restored. Lease-guarded, like every other worker write.
     */
    suspend(id: string, leaseToken: string): Promise<LeaseResult>;
    /**
     * Puts a parked job back in the queue. Not lease-guarded — nobody holds a standby job, which is
     * precisely what makes it resumable by a request from outside.
     */
    resume(id: string): Promise<'ok' | 'missing' | 'conflict'>;
    complete(
        id: string,
        leaseToken: string,
        result: { status: JobOutcome; exitCode: number | null; output: string | null },
    ): Promise<LeaseResult>;
    get(id: string): Promise<Job | null>;
    /** Newest first. `output` is not selected — it is unbounded and no list view shows it. */
    list(filter: { status?: JobStatus | undefined; repo?: string | undefined; limit: number }): Promise<Job[]>;
}

interface JobRow {
    id: string;
    command: string;
    status: JobStatus;
    attempts: number;
    max_attempts: number;
    claimed_by: string | null;
    created_by: string | null;
    session_id: string | null;
    remote_session_id: string | null;
    exit_code: number | null;
    output?: string | null;
    repo: string | null;
    executor: string | null;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const toJob = (row: JobRow): Job => ({
    id: row.id,
    command: row.command,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    claimedBy: row.claimed_by,
    createdBy: row.created_by,
    sessionId: row.session_id,
    remoteSessionId: row.remote_session_id,
    exitCode: row.exit_code,
    output: row.output ?? null,
    repo: row.repo,
    executor: row.executor,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
});

/**
 * The organization is bound at construction, for the reasons given on createPrStore.
 *
 * `hasWorkspaces` is bound the same way, and it decides whether a claim reports a `workspacePath`
 * at all. Without a configured workspace root no directory was ever created, so naming one would
 * hand the driver a path that does not exist — and `docker run -w` silently CREATES a missing
 * workdir, so the runner would start in an empty directory rather than failing the job. That is
 * exactly the case the driver's null check exists to catch, and it only reaches it if the board is
 * honest here.
 */
export function createJobStore({
    sql,
    orgId,
    hasWorkspaces = true,
    ready,
}: {
    sql: Sql;
    hasWorkspaces?: boolean;
    orgId: string;
    ready?: Promise<unknown>;
}): JobStore {
    const gate = async () => {
        if (ready) await ready;
    };

    return {
        async create(command, createdBy, target) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                insert into job (org_id, command, created_by, repo, executor)
                values (${orgId}, ${command}, ${createdBy}, ${target.repo}, ${target.executor})
                returning id
            `;
            return { id: rows[0]!.id };
        },

        async claim(worker, leaseSeconds) {
            await gate();

            // Retire what has burned its attempts, before looking for work. Without this a command
            // that kills its worker is reclaimed every time its lease expires, forever.
            await sql`
                update job set status = 'dead', finished_at = now(), lease_token = null
                where org_id = ${orgId} and status = 'running'
                  and lease_expires_at <= now() and attempts >= max_attempts
            `;

            const rows = await sql<
                {
                    id: string;
                    command: string;
                    attempts: number;
                    lease_token: string;
                    lease_expires_at: Date;
                    created_by: string | null;
                    session_id: string | null;
                }[]
            >`
                update job set
                    status           = 'running',
                    claimed_by       = ${worker},
                    lease_token      = gen_random_uuid(),
                    attempts         = attempts + 1,
                    -- Unconditional, not coalesce(started_at, now()): this must describe the
                    -- attempt that is about to run, or every duration is measured from attempt 1.
                    started_at       = now(),
                    -- Kept only when the job was parked and put back in the queue, which is the one
                    -- case where the previous session IS this attempt. The status read here is the
                    -- row's value BEFORE this update, so 'running' means a lease that expired:
                    -- that attempt's session is not this one, and leaving it would show a link to a
                    -- run whose output was thrown away.
                    session_id       = case when status = 'queued' then session_id else null end,
                    remote_session_id =
                        case when status = 'queued' then remote_session_id else null end,
                    lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
                where org_id = ${orgId} and id = (
                    select id from job
                    where org_id = ${orgId}
                      and status in ('queued','running')
                      and lease_expires_at <= now()
                      and attempts < max_attempts
                    order by created_at, id
                    limit 1
                    -- Below the limit in the plan, so a row another claimer holds is skipped
                    -- rather than counted and then discarded. The bare id = above is safe ONLY
                    -- because this subquery is holding the row lock.
                    for update skip locked
                )
                returning id, command, attempts, lease_token, lease_expires_at, created_by, session_id
            `;

            const row = rows[0];
            if (!row) return null;
            return {
                id: row.id,
                command: row.command,
                attempts: row.attempts,
                leaseToken: row.lease_token,
                leaseExpiresAt: row.lease_expires_at.toISOString(),
                userId: row.created_by,
                // Built here rather than in the route, because this is where the org is bound. Null
                // for an unattributed job — no member, so no workspace — and null when this
                // deployment has no workspace root, where no directory exists to point at.
                workspacePath: hasWorkspaces && row.created_by ? `${orgId}/${row.created_by}` : null,
                // Survived the case above, so this claim is a resume.
                resumeSessionId: row.session_id,
            };
        },

        async heartbeat(id, leaseToken, leaseSeconds) {
            await gate();
            const rows = await sql<{ lease_expires_at: Date }[]>`
                update job
                set lease_expires_at = now() + make_interval(secs => ${leaseSeconds}::int)
                where org_id = ${orgId} and id = ${id}
                  and status = 'running' and lease_token = ${leaseToken}
                returning lease_expires_at
            `;
            const row = rows[0];
            if (row) return { result: 'ok', leaseExpiresAt: row.lease_expires_at.toISOString() };
            return { result: (await exists(sql, orgId, id)) ? 'lost' : 'missing', leaseExpiresAt: null };
        },

        async session(id, leaseToken, sessionId, remoteSessionId) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update job set
                    session_id = ${sessionId},
                    -- coalesce, not assignment: the first report of an attempt carries no remote id
                    -- yet, and it must not wipe one a later report already stored.
                    remote_session_id = coalesce(${remoteSessionId}, remote_session_id)
                where org_id = ${orgId} and id = ${id}
                  and status = 'running' and lease_token = ${leaseToken}
                returning id
            `;
            if (rows[0]) return 'ok';
            return (await exists(sql, orgId, id)) ? 'lost' : 'missing';
        },

        async suspend(id, leaseToken) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update job set
                    status           = 'standby',
                    lease_token      = null,
                    -- Expired on the way in, exactly as insert does it. Standby is not claimable,
                    -- so this changes nothing until the job is resumed — and then it is the
                    -- difference between the next poll picking it up and it sitting in 'queued'
                    -- until the lease the parked worker was holding finally runs out.
                    lease_expires_at = now(),
                    -- Hands back the attempt the claim took. A suspend is not a failed try, so
                    -- parking a job a hundred times must never exhaust max_attempts — while a run
                    -- that keeps killing its worker still does.
                    attempts         = greatest(attempts - 1, 0)
                where org_id = ${orgId} and id = ${id}
                  and status = 'running' and lease_token = ${leaseToken}
                returning id
            `;
            if (rows[0]) return 'ok';
            return (await exists(sql, orgId, id)) ? 'lost' : 'missing';
        },

        async resume(id) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update job set status = 'queued'
                where org_id = ${orgId} and id = ${id} and status = 'standby'
                returning id
            `;
            if (rows[0]) return 'ok';
            // A job that exists but is not parked is a different answer from one that does not:
            // resuming a finished job is a caller mistake, not a missing row.
            return (await exists(sql, orgId, id)) ? 'conflict' : 'missing';
        },

        async complete(id, leaseToken, { status, exitCode, output }) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                update job set
                    status      = ${status},
                    exit_code   = ${exitCode},
                    output      = ${output},
                    finished_at = now(),
                    lease_token = null
                where org_id = ${orgId} and id = ${id}
                  and status = 'running' and lease_token = ${leaseToken}
                returning id
            `;
            if (rows[0]) return 'ok';
            // A report from a worker whose lease was reclaimed is refused, not merged: the job is
            // someone else's now, and the two runs did different work.
            return (await exists(sql, orgId, id)) ? 'lost' : 'missing';
        },

        async get(id) {
            await gate();
            const rows = await sql<JobRow[]>`
                select id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, output, repo, executor,
                       created_at, started_at, finished_at
                from job where org_id = ${orgId} and id = ${id}
            `;
            const row = rows[0];
            return row ? toJob(row) : null;
        },

        async list({ status, repo, limit }) {
            await gate();
            const rows = await sql<JobRow[]>`
                select id, command, status, attempts, max_attempts, claimed_by, created_by,
                       session_id, remote_session_id, exit_code, repo, executor,
                       created_at, started_at, finished_at
                from job
                where org_id = ${orgId} ${status ? sql`and status = ${status}` : sql``}
                  ${repo ? sql`and repo = ${repo}` : sql``}
                order by created_at desc, id
                limit ${limit}
            `;
            return rows.map(toJob);
        },
    };
}

/** Separates "no such job" from "the lease is not yours" once a guarded update matched nothing. */
async function exists(sql: Sql, orgId: string, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
    return rows.length > 0;
}
