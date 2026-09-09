export interface BoardJob {
    id: string;
    command: string;
    attempts: number;
    leaseToken: string;
    leaseExpiresAt: string;
    /**
     * Set when this claim is picking a parked job back up: the runner restores that session rather
     * than starting one, and the command is not re-delivered — it is already in the transcript.
     * Absent on a board that predates standby, which is why it is read as `?? null`.
     */
    resumeSessionId: string | null;
    /**
     * True when this claim resumes a session AND should still deliver the command into it — a
     * follow-up on a finished task, whose restored transcript is the parent conversation and whose
     * command is the new adjustment. False on a parked resume, where the delivered-once rule holds.
     * Read defensively like everything else here: a board that predates follow-ups omits it.
     */
    followUp: boolean;
    /**
     * The account that queued the job, or null for an unattributed one.
     *
     * Still not read here — the per-user Claude credential is what will read it. `workspacePath`
     * below is what the workspace half turned into. Read defensively, like `resumeSessionId`,
     * because a board that predates the field omits it.
     */
    userId: string | null;
    /**
     * Where that person's checkouts live, relative to the mounted workspace volume.
     *
     * `<org>/<user id>`, built by the board. A ready-made path rather than the raw `userId` because
     * the board owns the layout — it is what created the directory — and this process owns only the
     * mount point. Reimplementing `<org>/<uuid>` here would be a second copy of a rule this side
     * cannot verify.
     *
     * Null when the job has no author or the board has no workspace root, and a null is FAILED
     * rather than fallen back from. See dockerArgs.
     */
    workspacePath: string | null;
    /**
     * The environment the board resolved for this job — org < workspace < repo, secrets included.
     * Read defensively (`?? {}` at claim): a board that predates the field omits it, and the
     * runner's environment is then exactly what this process's own configuration forwards.
     */
    env?: Record<string, string>;
    /**
     * The job's `owner/name` label — the checkout the job's gates are declared in, and the key the
     * gate environment container is filed under. Read defensively: a board that predates gates
     * omits it.
     */
    repo?: string | null;
    /**
     * The gates the job's checkout declares in `.bellows.yaml`, read by the board at claim time:
     * the environment image they run in and the named commands. Null when the repository declares
     * none — the ordinary case. Absent on a board that predates gates, read as "no gates".
     */
    gates?: { image: string; gates: readonly { name: string; command: string }[] } | null;
    /**
     * Why the gates file exists but could not be honoured. The loop fails such a job outright —
     * running the work while pretending its gates do not exist is the one outcome worse than the
     * failure.
     */
    gateError?: string | null;
    /**
     * The ad-hoc gate credentials the LOOP mints for this attempt (`BELLOWS_GATE_URL` /
     * `BELLOWS_GATE_TOKEN`) — set just before spawn, never by the board, which is why it sits
     * beside `env` rather than inside it: the reserved-name filter that keeps a member's claim
     * env from spoofing these names must not strip the driver's own.
     */
    gateEnv?: Record<string, string>;
}

/** Whether the board still recognises this worker as the holder of the job. */
export type LeaseState = 'held' | 'lost';

/**
 * The runner container's vitals at one sample, plus the agent's current activity line — what the
 * board stores beside the output tail and the task view renders as the "is it working" answer.
 * Shapes the board's own validation; the driver sends only samples it took.
 */
export interface RuntimeReport {
    cpuPercent: number;
    memUsedMb: number;
    memPercent: number | null;
    activity: string | null;
    sampledAt: string;
}

export interface Board {
    /** Null means the queue is empty, which is the ordinary case, not an error. */
    claim(worker: string): Promise<BoardJob | null>;
    heartbeat(job: BoardJob): Promise<LeaseState>;
    /**
     * Streams a rolling tail of the runner's output while the job runs, so the dashboard shows the
     * work instead of a spinner. `runtime` rides beside it when the driver has a fresh sample of
     * the container's vitals; absent means none this round, and the board keeps the last one.
     * Best-effort by contract: a failure here costs freshness, never the run — the complete report
     * carries the final tail.
     */
    progress(job: BoardJob, output: string, runtime?: RuntimeReport): Promise<LeaseState>;
    /**
     * Replaces the job's gate state — what is running, what passed, what failed — so the task view
     * can show the checks while they happen. Best-effort by contract, like `progress`: a failure
     * costs freshness, never the run, and a `409` here is not a kill order.
     */
    gates(
        job: BoardJob,
        results: readonly { name: string; status: 'running' | 'passed' | 'failed'; exitCode: number | null; output: string | null }[],
    ): Promise<LeaseState>;
    /**
     * Tells the board which agent session this attempt runs as. Called twice under Remote Control:
     * once at spawn with the local id alone, and again once the bridge has reported the remote one
     * the Claude UI addresses the session by.
     */
    session(job: BoardJob, sessionId: string, remoteSessionId: string | null): Promise<LeaseState>;
    /** Parks the job: its container is gone, but it is not finished and keeps its session. */
    suspend(job: BoardJob): Promise<LeaseState>;
    /**
     * Reports the verdict. `contextTokens` / `contextCostUsd` ride beside it when the runner
     * scraped them out of the session database — the context the run reached and what it cost,
     * stored beside the attempt's vitals on the board.
     */
    complete(
        job: BoardJob,
        result: {
            status: 'succeeded' | 'failed';
            exitCode: number | null;
            output: string;
            contextTokens?: number | null;
            contextCostUsd?: number | null;
        },
    ): Promise<LeaseState>;
}

type Fetch = typeof globalThis.fetch;

export function createBoard({
    url,
    leaseSeconds,
    token,
    fetch = globalThis.fetch,
}: {
    url: string;
    leaseSeconds: number;
    /**
     * The worker token, when the board requires one. Empty against a board with AUTH_MODE=none.
     *
     * This is the driver's entire share of authentication: one header. It stays that way on purpose
     * — this process depends on nothing, `core` included, because it is a client of an HTTP board
     * and giving it the server's types would hand a process that needs only `fetch` and `docker` the
     * whole server dependency tree.
     */
    token?: string | undefined;
    fetch?: Fetch;
}): Board {
    const post = async (path: string, body: unknown): Promise<Response> => {
        const response = await fetch(`${url}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                // Omitted rather than sent empty: a board with no auth would otherwise see a Bearer
                // header with nothing in it, which is a credential that failed rather than one that
                // was never offered.
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
        });
        // 409 is a verdict, not a failure; everything else outside 2xx is the board being broken or
        // the driver being wrong, and neither should be swallowed into a silent no-op.
        if (!response.ok && response.status !== 409) {
            throw new Error(`${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
        }
        return response;
    };

    return {
        async claim(worker) {
            const response = await post('/api/jobs/claim', { worker, leaseSeconds });
            if (response.status === 204) return null;
            const claimed = (await response.json()) as Partial<BoardJob>;
            return {
                ...(claimed as BoardJob),
                resumeSessionId: claimed.resumeSessionId ?? null,
                followUp: claimed.followUp ?? false,
                userId: claimed.userId ?? null,
                workspacePath: claimed.workspacePath ?? null,
                env: claimed.env ?? {},
            };
        },

        async heartbeat(job) {
            const response = await post(`/api/jobs/${job.id}/heartbeat`, {
                leaseToken: job.leaseToken,
                leaseSeconds,
            });
            return response.status === 409 ? 'lost' : 'held';
        },

        async progress(job, output, runtime) {
            const response = await post(`/api/jobs/${job.id}/output`, {
                leaseToken: job.leaseToken,
                output,
                ...(runtime ? { runtime } : {}),
            });
            return response.status === 409 ? 'lost' : 'held';
        },

        async gates(job, results) {
            const response = await post(`/api/jobs/${job.id}/gates`, {
                leaseToken: job.leaseToken,
                gates: results,
            });
            return response.status === 409 ? 'lost' : 'held';
        },

        async session(job, sessionId, remoteSessionId) {
            const response = await post(`/api/jobs/${job.id}/session`, {
                leaseToken: job.leaseToken,
                sessionId,
                remoteSessionId,
            });
            return response.status === 409 ? 'lost' : 'held';
        },

        async suspend(job) {
            const response = await post(`/api/jobs/${job.id}/suspend`, { leaseToken: job.leaseToken });
            return response.status === 409 ? 'lost' : 'held';
        },

        async complete(job, { status, exitCode, output, contextTokens, contextCostUsd }) {
            const response = await post(`/api/jobs/${job.id}/complete`, {
                leaseToken: job.leaseToken,
                status,
                exitCode,
                output,
                ...(typeof contextTokens === 'number' ? { contextTokens } : {}),
                ...(typeof contextCostUsd === 'number' ? { contextCostUsd } : {}),
            });
            return response.status === 409 ? 'lost' : 'held';
        },
    };
}
