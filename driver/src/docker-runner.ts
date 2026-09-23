import { JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import type { BoardJob } from './board.js';
import { executorImage, type DriverConfig } from './config.js';
import { HELPER_TIMEOUT_MS, helperInputValue, lookupHelper, parseHelperOutput } from './helpers.js';
import type { HelperPlan, HelperResult } from './helpers.js';
import {
    gitWorktreeRemoveScript,
    parseLastJsonLine,
    publishCheckout,
    publishFailed,
    reclaimUnreadable,
    repoPath,
    syncUnreadable,
    withPublishToken,
    worktreeDir,
    type PublishResult,
    type ReclaimResult,
    type SyncResult,
} from './publish.js';
import { networkName } from './services.js';
import {
    containerName,
    dockerArgs,
    envFilePath,
    parseDockerServicePs,
    parseDockerStats,
    workspacesMountArgs,
} from './docker.js';
import { claimContinuesSession, envFileBody, workspacePath } from './claim.js';
import {
    composeRuntimeSample,
    reportTail,
    type RunOutcome,
    type Runner,
    type RunSession,
    type RuntimeSample,
} from './runner.js';
import { applyCloseTimeReadout, tickCacheWatch } from './docker-close-read.js';
import {
    ERROR_DETAIL_MAX_CHARS,
    assertJobNotKilled,
    assertNotKilledAfterEnvWrite,
    dockerErrorDetail,
    dockerRunVerdict,
    linesOf,
    listByLabelOrThrow,
    removeEachTolerantly,
    run,
    setupJobServices,
    syncCheckoutArgs,
    type RunnerFiles,
    type Spawn,
    type ExecDocker,
} from './docker-runner-support.js';
import { OPENCODE } from './executors.js';

/**
 * The docker executor's stateful `RunnerDeps` methods and `createDockerRunner` itself — the
 * per-attempt fences and teardowns, the spawn and event wiring. The daemon plumbing and per-step
 * helpers live in `docker-runner-support.ts`, the close-time reads in `docker-close-read.ts`.
 */

/** Everything a docker-runner method needs: the daemon transport, the config, and the per-attempt kill set. */
interface RunnerDeps {
    config: DriverConfig;
    execDocker: ExecDocker;
    files: RunnerFiles;
    spawnFn: Spawn;
    /**
     * Lease tokens whose kill() fired while that attempt may still be awaiting the daemon in its
     * services setup. Keyed by LEASE TOKEN, not job id: the token is the per-attempt identity —
     * one driver process can hold two attempts of the same id at once (the poll loop re-claims an
     * expired-lease job while the first attempt's setup is still in flight), and the loop's kill
     * names the one attempt it killed. Keyed by id, the two attempts would share one marker: the
     * sibling claim would either be aborted by a kill meant for the other, or — wiping the marker
     * on entry, as this once did — revive the killed attempt to compete for the same network and
     * containers. Tokens never repeat, so the set only ever grows, by one entry per lost lease.
     *
     * This set is EFFICIENCY and early abort, not correctness: every daemon call any path issues
     * is scoped to its own attempt — by the lease label in its filters and the token in its
     * names — so a dying setup could issue every call it has and still never touch a sibling
     * attempt's resources. What the checks buy is that a dying setup stops CREATING: it does not
     * go on building a network, starting services and spawning a runner over a lease that is
     * already gone.
     */
    killed: Set<BoardJob['leaseToken']>;
}

/**
 * Tears down THIS attempt's services and network — and, by construction, nothing else. The `ps`
 * filters carry this attempt's lease token beside the job id, and the network it removes is named
 * after the token too, so every call here resolves only to resources this attempt created. That
 * is what makes it safe to run UNCONDITIONALLY, from every closing path: a close that lands late,
 * a kill that lands after a replacement claim stood its own fleet up, a spawn error racing a newer
 * attempt's setup — none of them can NAME anything but this attempt's own fleet, so none of them
 * needs an ownership gate. Daemon calls are arbitrarily slow and attempts can supersede each other
 * mid-call; attempt scoping is what holds at execution time, because it is not a snapshot but a
 * property of the argv itself.
 *
 * Every removal tolerates the thing already being gone, which makes the whole teardown
 * idempotent — it runs twice per attempt by design, as the fence's service half before the run
 * and as the teardown after it.
 */
async function dockerServiceTeardown(deps: RunnerDeps, job: BoardJob): Promise<void> {
    if (!deps.config.servicesEnabled) return;
    const found = await deps
        .execDocker([
            'ps',
            '-aq',
            '--filter',
            `label=${JOB_LABEL}=${job.id}`,
            '--filter',
            `label=${LEASE_LABEL}=${job.leaseToken}`,
            '--filter',
            `label=${SERVICE_LABEL}`,
        ])
        .catch(() => ({ stdout: '' }));
    for (const id of linesOf(found.stdout)) {
        await deps.execDocker(['rm', '-f', id]).catch(() => undefined);
    }
    await deps.execDocker(['network', 'rm', networkName(job)]).catch(() => undefined);
}

async function dockerKill(deps: RunnerDeps, job: BoardJob): Promise<void> {
    // Recorded before anything is torn down: this attempt, sitting in its services setup,
    // reads this between awaited steps and aborts instead of creating more resources or
    // spawning the runner over a lease that is already gone. The token, not the id, is what
    // is recorded — a sibling attempt of the same job carries a different token and must
    // not read this one's cancellation.
    deps.killed.add(job.leaseToken);
    // Killing the `docker run` process would only detach the CLI; the container keeps running
    // and the workspace keeps being written to. The daemon has to be told — by ID, resolved
    // through this attempt's own lease label, never by name: a kill that resolved a
    // job-derived name would address whatever owns that name at daemon-execution time, and
    // names are attempt-scoped now precisely so no such ambiguity exists. The label pair
    // (job, lease) resolves to this attempt's containers alone; a stale kill that finds
    // nothing has nothing of its own left to kill.
    const found = await deps
        .execDocker([
            'ps',
            '-aq',
            '--filter',
            `label=${JOB_LABEL}=${job.id}`,
            '--filter',
            `label=${LEASE_LABEL}=${job.leaseToken}`,
        ])
        .catch(() => ({ stdout: '' }));
    for (const id of linesOf(found.stdout)) {
        await deps.execDocker(['kill', id]).catch(() => undefined);
    }
    // The declared services go with the runner: a killed job's database has no reason to
    // outlive the job, and the close handler's teardown would catch them anyway — this is so
    // a kill while nothing is reading the outcome (lost lease, shutdown) still reclaims them.
    // Attempt-scoped, like every teardown: whatever a replacement attempt is running is
    // invisible to these filters.
    await dockerServiceTeardown(deps, job);
}

/*
 * The re-claim fence — the only JOB-scoped sweep this runner performs, and the one component
 * allowed to be job-scoped: it runs BEFORE this attempt creates anything, so whatever it finds is
 * by construction a previous attempt's leftover. Names are attempt-scoped now, so no name can
 * find a previous attempt's leftovers — the `factory.job` label is the one identifier every
 * attempt of the job shares, and the sweep is by label: every leftover container (runners and
 * services alike), then every leftover network. This claim exists only because those attempts'
 * leases are gone, so removing them delivers the same verdict their heartbeats would have, had
 * the driver survived to receive it — and the alternative to leaving a live leftover runner
 * running is two writers on one checkout, which is the thing actually worth preventing.
 *
 * It runs TWICE per attempt by design: once in syncCheckout — the loop calls the sync before
 * run(), and the sync is the first writer on the task worktree, so the previous attempt's runner
 * must be off the daemon before the worktree script starts, not only before the runner does — and
 * once in run(), which keeps its own call so the guarantee never depends on the loop's ordering.
 * The sweep is idempotent; removing twice what was removed once removes nothing.
 *
 * Failures PROPAGATE, and for one reason: a swallowed daemon refusal would be indistinguishable
 * from "nothing left", and the sync would start while the leftover runner still writes the
 * worktree. A refusal here is INFRASTRUCTURE — syncCheckout lets it throw (the loop leaves the
 * job to its lease), and run()'s own call propagates the same way — never the command's verdict.
 * The one tolerated shape is docker's already-gone answer on a removal: a container exiting
 * between the ps and its rm is the fence succeeding, not failing. The transitional
 * unlabelled-network rm below keeps tolerating absent outright — it removes by a NAME that may
 * never have existed.
 */
async function dockerReclaimFence(deps: RunnerDeps, job: BoardJob): Promise<void> {
    const containerIds = await listByLabelOrThrow(
        deps.execDocker,
        ['ps', '-aq', '--filter', `label=${JOB_LABEL}=${job.id}`],
        `the re-claim fence could not list the leftover containers of job ${job.id}`
    );
    await removeEachTolerantly(
        deps.execDocker,
        containerIds,
        (id) => ['rm', '-f', id],
        (id) => `the re-claim fence could not remove the leftover container ${id} of job ${job.id}`
    );

    const staleNetworks = await listByLabelOrThrow(
        deps.execDocker,
        ['network', 'ls', '--filter', `label=${JOB_LABEL}=${job.id}`, '--format', '{{.Name}}'],
        `the re-claim fence could not list the leftover networks of job ${job.id}`
    );
    await removeEachTolerantly(
        deps.execDocker,
        staleNetworks,
        (name) => ['network', 'rm', name],
        (name) => `the re-claim fence could not remove the leftover network ${name} of job ${job.id}`
    );

    // TRANSITIONAL: networks created before the lease token joined the name carry no
    // labels at all, so the sweep above cannot see them. Remove the pre-redesign name
    // outright; tolerated absent. This line may be dropped once no pre-redesign leftover
    // can exist any more.
    await deps.execDocker(['network', 'rm', `factory-job-${job.id}-services`]).catch(() => undefined);
}

/*
 * The startup sync (or, for a claim that continues a session, the restore): one container, one
 * script. A starting claim gets fetch + create-or-rebase; a continuing claim gets RESTORE=1 — no
 * fetch, no rebase, nothing that touches the remote (issue #58) — so its env file is not written
 * at all and the credential helper is absent even when the claim carries a token. The env names
 * the three paths the script needs — the clone (where origin lives), the worktree, the branch —
 * literal values, not credentials. A conflicting rebase aborts itself in the script and answers
 * { ok: false } with the reason — the loop fails the run before it starts rather than leaving the
 * worktree mid-rebase for every later turn to trip over.
 */
async function dockerSyncCheckout(deps: RunnerDeps, job: BoardJob): Promise<SyncResult> {
    const { config, execDocker, files } = deps;
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) return { ok: true, reason: null }; // nothing synced, nothing to fail either

    /*
     * The fence BEFORE the sync: the loop calls syncCheckout before run(), so without
     * this the worktree script would start while a previous attempt's runner was still
     * writing the same shared task worktree — mixed edits, or a rebase conflict nobody
     * is awake to resolve. The sweep is idempotent, and run() keeps its own: twice per
     * attempt is already the fence's documented shape, the same way the service
     * teardown half runs twice.
     */
    await dockerReclaimFence(deps, job);
    const restore = claimContinuesSession(job);
    let file: string | null = null;
    if (!restore) {
        try {
            file = envFilePath(job);
            await files.writeFile(file, envFileBody(job), { mode: 0o600 });
        } catch (e) {
            return { ok: false, reason: `could not write the sync env file: ${(e as Error).message}` };
        }
    }
    try {
        // 'run' and '--rm' INCLUDED — every execDocker argv here is a full `docker run`:
        // this exact call once shipped as `docker -v ... -w ...`, which is not a command
        // docker knows, and the sync failed on every job while the compile and the flow
        // tests (which match argv by shape, not by head) stayed green.
        const out = await execDocker(syncCheckoutArgs(config, job, { clone, worktree, restore, envFile: file }));
        return parseLastJsonLine<SyncResult>(out.stdout, () => syncUnreadable);
    } catch (e) {
        const detail = dockerErrorDetail(e);
        return {
            ok: false,
            reason: `the worktree sync container failed: ${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}`,
        };
    } finally {
        if (file) await files.rm(file).catch(() => undefined);
    }
}

/*
 * The terminal reclaim, one container one script like the sync it undoes: the clone (whose
 * admin dir registers the worktree) and the worktree, by env, nothing else — no env file, no
 * credential. Removing the tree needs nothing the claim held; a `docker run` with no --env-file
 * is simpler and leaves nothing to clean on either side. A job that names no repository never
 * had a tree, so the answer is "reclaimed, nothing was there".
 */
async function dockerReclaimWorktree(deps: RunnerDeps, job: BoardJob): Promise<ReclaimResult> {
    const { config, execDocker } = deps;
    const clone = repoPath(config, job);
    const worktree = worktreeDir(config, job);
    if (!clone || !worktree) return { ok: true, removed: false, reason: null };
    try {
        const out = await execDocker([
            'run',
            '--rm',
            ...workspacesMountArgs(config, workspacePath(job)),
            '-e',
            `REPO=${clone}`,
            '-e',
            `WORKTREE=${worktree}`,
            '--entrypoint',
            'node',
            executorImage(config, job.executorType),
            '-e',
            gitWorktreeRemoveScript,
        ]);
        return parseLastJsonLine<ReclaimResult>(out.stdout, () => reclaimUnreadable);
    } catch (e) {
        const detail = dockerErrorDetail(e);
        return {
            ok: false,
            removed: false,
            reason: `the worktree reclaim container failed: ${detail.slice(0, ERROR_DETAIL_MAX_CHARS)}`,
        };
    }
}

/**
 * Publishing is attempt-scoped like everything else here: the env file is named after the lease
 * token, and the credential travels by --env-file — GITHUB_TOKEN from the claim env is in no
 * argv anywhere, only inside the container's environment where the credential helper reads it.
 * The steps themselves — probe, branch, commit, push, PR — live in publishCheckout (publish.ts),
 * shared with the kubernetes runner so the two executors cannot drift on what a publish decides;
 * this is only the docker transport: one `docker run --rm` per step, entrypoint swapped for the
 * tool, over the workspaces volume (this process has no host path into it).
 *
 * Every step runs in the task worktree (issue #35) — the tree the run actually edited.
 */
async function dockerPublishGit(deps: RunnerDeps, job: BoardJob, publishToken?: string): Promise<PublishResult> {
    const { config, execDocker, files } = deps;
    let file: string | null = null;
    try {
        file = envFilePath(job);
        await files.writeFile(file, envFileBody(withPublishToken(job, publishToken)), { mode: 0o600 });
    } catch (e) {
        return publishFailed(`could not write the publish env file: ${(e as Error).message}`);
    }
    const envFile = file;
    const repo = worktreeDir(config, job);
    try {
        return await publishCheckout(config, job, async (publish) => {
            const args = ['run', '--rm', ...workspacesMountArgs(config, workspacePath(job))];
            if (publish.inRepo && repo) args.push('-w', repo);
            // Literal env values are paths and code (the probe's REPO) — the same class
            // as the sync's three path literals, never a credential.
            for (const [name, value] of Object.entries(publish.envLiterals ?? {})) {
                args.push('-e', `${name}=${value}`);
            }
            if (publish.env) args.push('--env-file', envFile);
            args.push('--entrypoint', publish.entrypoint, executorImage(config, job.executorType), ...publish.args);
            try {
                return await execDocker(args);
            } catch (e) {
                // The tool's own output, never the echoed command (dockerErrorDetail):
                // the execFile message is "Command failed: <the whole docker run argv>",
                // which is exactly how a credential problem once shipped as an unreadable
                // verdict. The step's name is added by the workflow; this is the detail
                // under it.
                throw new Error(dockerErrorDetail(e));
            }
        });
    } finally {
        if (file) await files.rm(file).catch(() => undefined);
    }
}

/**
 * The docker transport for one block-helper step (issue #207): the same shape as
 * `dockerPublishGit` — an attempt-scoped env file when the helper writes to GitHub, one
 * `docker run` over the task worktree with the entrypoint swapped for `node`, the script passed
 * by CONTENT (never a path), and the bounded input as one literal `-e` value (never a credential —
 * the same class as the sync's `REPO`/`WORKTREE` literals). Unknown helper ids fail BEFORE any
 * container starts, matching the k8s transport's own first check.
 *
 * NOT `--rm`, on purpose — the same reason `dockerRun`'s own runner container skips it: `--rm`
 * removes the container only when the DAEMON sees it exit, and `execDocker`'s `timeout` option
 * kills the `docker run` CLIENT process, not the container the daemon is still running. A killed
 * client whose container keeps going would otherwise leak it forever — the job that timed out has
 * no guaranteed later attempt to sweep it up (a pre-helper timeout fails the attempt terminally).
 * The container gets its own attempt-scoped, per-call name instead, and the `finally` below
 * removes it explicitly and unconditionally, tolerating one already gone — the exact idiom
 * `dockerRunVerdict` uses for the runner container itself.
 */
async function dockerRunHelper(
    deps: RunnerDeps,
    job: BoardJob,
    plan: HelperPlan,
    token?: string
): Promise<HelperResult> {
    const descriptor = lookupHelper(plan.helperId);
    if (!descriptor) {
        return {
            ok: false,
            reason: 'unknown_helper',
            message: `no allowlisted helper is registered as "${plan.helperId}"`,
        };
    }
    const { config, execDocker, files } = deps;
    // A per-call name, not the shared attempt name: a real future producer could declare more
    // than one plan of a phase, and this must never collide with a sibling call, or with the
    // runner/service containers this same attempt starts under its own name/labels.
    const helperContainerName = `factory-helper-${job.id}-${job.leaseToken}-${randomUUID()}`;
    let file: string | null = null;
    try {
        if (plan.githubWriting) {
            file = envFilePath(job);
            await files.writeFile(file, envFileBody(withPublishToken(job, token)), { mode: 0o600 });
        }
        const worktree = worktreeDir(config, job);
        const args = ['run', '--name', helperContainerName, ...workspacesMountArgs(config, workspacePath(job))];
        if (worktree) args.push('-w', worktree);
        args.push(
            '--label',
            `${JOB_LABEL}=${job.id}`,
            '--label',
            `${LEASE_LABEL}=${job.leaseToken}`,
            '-e',
            `HELPER_INPUT=${helperInputValue(plan)}`
        );
        if (file) args.push('--env-file', file);
        args.push('--entrypoint', 'node', executorImage(config, job.executorType), '-e', descriptor.scriptBody);
        let out: { stdout: string };
        try {
            out = await execDocker(args, { timeout: HELPER_TIMEOUT_MS });
        } catch (e) {
            const timedOut = (e as { killed?: boolean }).killed === true;
            return {
                ok: false,
                reason: timedOut ? 'timeout' : 'runner_error',
                message: timedOut
                    ? `the helper exceeded its ${HELPER_TIMEOUT_MS}ms bound`
                    : dockerErrorDetail(e).slice(0, ERROR_DETAIL_MAX_CHARS),
            };
        }
        return parseHelperOutput(descriptor, out.stdout);
    } finally {
        if (file) await files.rm(file).catch(() => undefined);
        await execDocker(['rm', '-f', helperContainerName]).catch(() => undefined);
    }
}

// The container is named by this attempt's lease token, so a sample can only ever resolve
// its own attempt's runner — the same attempt-scoping every per-attempt operation here
// leans on. A refused read (the container exited between the ask and the stats round-trip,
// the daemon is busy) answers null, which the loop reads as "report no vitals this round".
// The service fleet is read in the same sampling round, scoped by the same label pair the
// teardown tears down with and requiring the `factory.service` key, so the runner and
// gate containers never answer it; a failed read costs the fleet, not the sample.
async function dockerSampleRuntime(deps: RunnerDeps, job: BoardJob): Promise<Omit<RuntimeSample, 'sampledAt'> | null> {
    const { config, execDocker } = deps;
    const read = await execDocker(['stats', '--no-stream', '--format', '{{json .}}', containerName(job)]).catch(
        () => null
    );
    const vitals = read ? parseDockerStats(read.stdout) : null;
    const services = config.servicesEnabled
        ? await execDocker([
              'ps',
              '-a',
              '--filter',
              `label=${JOB_LABEL}=${job.id}`,
              '--filter',
              `label=${LEASE_LABEL}=${job.leaseToken}`,
              '--filter',
              `label=${SERVICE_LABEL}`,
              '--format',
              '{{json .}}',
          ])
              .then((found) => parseDockerServicePs(found.stdout))
              .catch(() => null)
        : undefined;
    return composeRuntimeSample(vitals, services);
}

async function dockerRun(
    deps: RunnerDeps,
    job: BoardJob,
    session: RunSession | null,
    onOutput?: (tail: string) => void
): Promise<RunOutcome> {
    const { config, execDocker, files, spawnFn, killed } = deps;
    // No entry-time clearing of the killed set: a fresh claim carries a fresh lease
    // token that was never recorded, so nothing recorded for an earlier attempt can
    // reach this one — and clearing by id would revive exactly the dead attempt the
    // token keying exists to keep down. See RunnerDeps for the killed set's own comment.

    /*
     * The fence before anything this attempt creates — the job-scoped sweep documented
     * on dockerReclaimFence above. It already ran once, in syncCheckout; run() keeps its own
     * call so the guarantee never depends on the loop's ordering.
     */
    await dockerReclaimFence(deps, job);

    /*
     * Auxiliary services (issue #6) — see setupJobServices. A refusal there is the
     * AUTHOR's (a bad .bellows.yaml), so it comes back as a failed run rather than
     * thrown — retrying a file that cannot change would burn attempts on an error no
     * retry fixes. (`started: true` there means "this verdict is final", not "a
     * container ran"; the loop reads it only to decide between reporting and leaving
     * the job to its lease.) Every other refusal there is INFRASTRUCTURE and propagates.
     *
     * A kill that lands while this setup is awaiting the daemon must stop the attempt —
     * setupJobServices checks after every awaited step, teardown-free by design: kill()
     * ran the attempt-scoped teardown already, and anything created after that point is
     * a leftover for the NEXT attempt's fence, not this dying one's business. The same
     * check runs once more here, after the claim-env file write below — the last await
     * before the spawn — so the gap between that final check and spawnFn is synchronous.
     */
    const { servicesNetwork, refusal } = await setupJobServices(job, config, {
        execDocker,
        killed,
        serviceTeardown: (j) => dockerServiceTeardown(deps, j),
    });
    if (refusal !== null) {
        return { exitCode: null, output: refusal, timedOut: false, started: true };
    }

    // The runner container is the last resource this attempt creates, and the spawn is
    // what a killed setup must never reach — see assertJobNotKilled for why a throw is
    // the right verdict here.
    assertJobNotKilled(killed, job);

    /*
     * The env file's ride: a 0600 file in the OS temp directory, written just before the spawn
     * and removed as soon as the run is over — a crash leaves it in tmpdir at worst, never
     * in argv and never in this process's environment. The body is the claim env PLUS the
     * loop's minted gate credentials PLUS the runner's own attempt pair, so a gated job whose
     * claim resolves to nothing still carries its BELLOWS_GATE_URL/TOKEN and the credential
     * its attribution reports authenticate with.
     */
    const body = envFileBody(job, config);
    const file = body ? envFilePath(job) : null;
    if (file) await files.writeFile(file, body, { mode: 0o600 });
    // The write above is an await, so the kill-check must run once more: see
    // assertNotKilledAfterEnvWrite for why a lease lost while it was pending must not
    // reach spawnFn.
    await assertNotKilledAfterEnvWrite({ killed, job, files }, file);

    const outcome = new Promise<RunOutcome>((resolve, reject) => {
        // See dockerRunVerdict for what a close decides and why. Bound to this attempt's
        // own mutable state, read at call time (the close handler, well after all of it
        // has settled).
        const verdict = (code: number | null): Promise<RunOutcome> =>
            dockerRunVerdict(code, {
                execDocker,
                job,
                serviceTeardown: (j) => dockerServiceTeardown(deps, j),
                output,
                timedOut,
                cacheLost: cacheState.cacheLost,
            });

        // The run's start instant, captured here because both close-time turn reads key
        // on it: a follow-up resumes its session's conversation, so the delta each read
        // reports is bounded to what THIS run wrote.
        const startedAt = new Date().toISOString();
        const child = spawnFn(
            'docker',
            dockerArgs(config, job, session, { servicesNetwork, ...(file ? { envFile: file } : {}) }),
            {
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        let timedOut = false;
        const cacheState: { cacheLost: string | null } = { cacheLost: null };

        let output = '';
        const collect = (chunk: Buffer | string) => {
            output += String(chunk);
            // Keep the tail: a run that fails says why at the end, and the head is banner.
            // Byte-true, because the report has to fit the board's body limit whatever the
            // log contained — see reportTail.
            output = reportTail(output);
            // The same tail a complete report would carry, handed over as it grows. Every
            // chunk calls back; throttling is the loop's business, not this runner's.
            onOutput?.(output);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);

        const timer = setTimeout(() => {
            timedOut = true;
            void dockerKill(deps, job);
        }, config.jobTimeoutMs);

        /*
         * The cache watch polls on a period while the run is live. Each tick is one
         * throwaway probe container; a probe that fails once (the daemon is busy, the
         * session is not there yet) just waits for the next tick, and the trigger itself
         * needs three consecutive damning turns, so no single answer — or no single fluke —
         * kills anything. The kill is this attempt's own, label-scoped like every other;
         * the task-type check below keeps it on opencode, and config keeps it docker-only.
         */
        let cacheTimer: NodeJS.Timeout | null = null;
        if (config.cacheWatch && job.executorType === OPENCODE) {
            cacheTimer = setInterval(() => {
                void tickCacheWatch({ execDocker, config, job, kill: (j) => dockerKill(deps, j) }, cacheState);
            }, config.cacheWatchPollMs);
        }

        const done = () => {
            clearTimeout(timer);
            if (cacheTimer) clearInterval(cacheTimer);
        };

        /*
         * A spawn failure makes Node deliver 'error' and then 'close' with a null code.
         * The flag keeps the two apart: once it is set, close must not settle the
         * promise, because verdict(null) would read as a started run with no exit code —
         * terminally reported as a failed job — when the truth is infrastructure the
         * loop should leave to its lease for retry.
         */
        let spawnFailed = false;
        child.on('error', (error) => {
            spawnFailed = true;
            done();
            // The spawn itself failed (docker missing, exec blew up). Whatever services
            // were started before it are torn down BEFORE the rejection lands — teardown
            // tolerates absence, so either way a rejection means cleanup is as done as
            // it gets, and the rejection waits for the teardown's verdict. The teardown
            // is attempt-scoped, so no supersession check is needed: even if a
            // replacement claim landed while this attempt was failing, the filters carry
            // this attempt's lease and the network is named after it — the teardown
            // cannot reach the replacement's fleet.
            dockerServiceTeardown(deps, job).then(
                () => reject(error),
                () => reject(error)
            );
        });
        child.on('close', (code) => {
            // The error handler owns this failure and its rejection is already deferred
            // behind the service teardown; a close here carries only the null code of a
            // process that never ran, and settling verdict(null) over the pending
            // rejection would turn infrastructure into a terminal verdict.
            if (spawnFailed) return;
            done();
            // Every close-time read this runner performs — opencode's session scrape,
            // then claude-code's agent-turn count — lives in applyCloseTimeReadout:
            // best-effort throughout, so a failed read costs the task its follow-ups or
            // its turn figure, never its verdict.
            void verdict(code)
                .then((outcome) => applyCloseTimeReadout(outcome, { execDocker, config, job, startedAt }, session))
                .then(resolve, reject);
        });
    });

    // The file dies with the run — verdict read or not, resolved or thrown. The CLI has
    // long since read it; the daemon has the values in the container's config.
    try {
        return await outcome;
    } finally {
        if (file) await files.rm(file).catch(() => undefined);
    }
}

/**
 * Builds the docker executor's runner: one instance per driver process, holding this attempt's
 * kill set across every method call. Each method below is a thin dispatch onto its standalone
 * `dockerX` function, over the shared `deps` — the split that keeps every one of them under the
 * function-length budget while still sharing the one piece of state (`killed`) that must survive
 * between calls.
 */
export function createDockerRunner(
    config: DriverConfig,
    spawnFn: Spawn = spawn,
    execDocker: ExecDocker = (args, options) => run('docker', args, { ...options, encoding: 'utf8' }),
    files: RunnerFiles = { writeFile, rm }
): Runner {
    const deps: RunnerDeps = { config, execDocker, files, spawnFn, killed: new Set() };
    return {
        kill: (job) => dockerKill(deps, job),
        syncCheckout: (job) => dockerSyncCheckout(deps, job),
        reclaimWorktree: (job) => dockerReclaimWorktree(deps, job),
        publishGit: (job, publishToken) => dockerPublishGit(deps, job, publishToken),
        runHelper: (job, plan, token) => dockerRunHelper(deps, job, plan, token),
        sampleRuntime: (job) => dockerSampleRuntime(deps, job),
        run: (job, session, onOutput) => dockerRun(deps, job, session, onOutput),
    };
}
