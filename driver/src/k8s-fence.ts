import type { BoardJob } from './board.js';
import { runnerClaimEnv } from './claim.js';
import {
    claimBody,
    claimPath,
    configmapsPath,
    jobPath,
    jobsSelectorPath,
    podsPath,
    podsSelectorPath,
    secretsPath,
    servicesPath,
    servicesSelectorPath,
} from './k8s-auxspec.js';
import { jobsPath, runnerName, secretBody, secretName, type RunnerJobSpec } from './k8s-podspec.js';
import { readVerdict } from './k8s-poll.js';
import {
    CLAIM_ROUNDS,
    expectOk,
    HTTP_CONFLICT,
    HTTP_ERROR_STATUS,
    HTTP_NOT_FOUND,
    HTTP_OK_STATUS,
    parse,
    POLL_MS,
    refusal,
    REPLACE_MAX_POLLS,
} from './k8s-transport.js';
import type { K8sClaim, K8sDeps, K8sResponse } from './k8s-transport.js';

/**
 * The re-claim fence: taking the checkout claim, sweeping a superseded attempt's leftovers, and
 * the pre/post-create claim verifies that bracket the runner Job POST. See docs/kubernetes.md's
 * "Re-claims fence by claiming the checkout, atomically" for the full protocol; this file is its
 * implementation, shared by the runner's `prepare`/`launch` and by `syncCheckout`/`reclaimWorktree`
 * (`k8s-runner.ts`), which run the same `acquireClaim`/`releaseClaim` pair under their own Jobs.
 */

/** True once a post-create stand-down could not prove its own Job deleted — see `k8s-runner.ts`'s `RunCleanup`. */
export interface RunCleanup {
    holdClaim: boolean;
}

/**
 * The Secret's contents: the claim env, the loop's minted gate credentials, and the runner's own
 * attempt pair — the branch-ingest credential, always present, because it is how the reporter
 * authenticates at all.
 */
const runnerEnv = (job: BoardJob): Record<string, string> => ({
    ...runnerClaimEnv(job),
    ...(job.gateEnv ?? {}),
    RUNNER_JOB_ID: job.id,
    RUNNER_LEASE_TOKEN: job.leaseToken,
});

/**
 * Best-effort delete of THIS attempt's own Job — by its own attempt-scoped name, which is what
 * keeps it from ever reaching another attempt's objects. The ANSWER is the delete's verdict, and
 * callers act on it: true when the Job is provably going away (2xx) or provably already gone
 * (404); false for any other non-2xx status or a transport rejection, where the Job may survive
 * to the kubelet's deadline — the caller then HOLDS the checkout claim instead of releasing it.
 */
const deleteOwnJob = (deps: K8sDeps, job: BoardJob): Promise<boolean> =>
    deps.request('DELETE', `${jobPath(deps.config.k8sNamespace, runnerName(job))}?propagationPolicy=Foreground`).then(
        (response) => response.status < HTTP_ERROR_STATUS || response.status === HTTP_NOT_FOUND,
        () => false
    );

/**
 * Reads the claim a 409 answered, and either recognizes it as already ours or takes it over —
 * pulled out of `acquireClaim` purely to keep that function's complexity readable. `'ours'` stops
 * the round; `'retry'` (a vanished claim, or a stale one just released) sends the caller back to
 * `acquireClaim` for another POST.
 */
async function takeOverStaleClaim(deps: K8sDeps, job: BoardJob, path: string): Promise<'ours' | 'retry'> {
    const get = await deps.request('GET', path);
    // Gone between our 409 and the read — the holder released it; race for it again.
    if (get.status === HTTP_NOT_FOUND) return 'retry';
    expectOk(get, 'reading the checkout claim');
    const claim = parse<K8sClaim>(get.body);
    if (claim.data?.holder === job.leaseToken) return 'ours';
    const attempt = Number(claim.data?.attempt);
    if (Number.isFinite(attempt) && attempt >= job.attempts) {
        throw new Error(
            `job ${job.id} stands down: the checkout claim is held by a newer attempt ` +
                `(${claim.data?.attempt} >= ${job.attempts})`
        );
    }
    const uid = claim.metadata?.uid;
    if (!uid) {
        // A read that cannot name the incarnation it read is a bad read, and garbage is never
        // proof of an older holder: an UNCONDITIONED delete here could reach a newer claim and
        // reopen both races through this one branch. Fail loud; the job goes back to its lease.
        throw new Error(`the checkout claim of job ${job.id} could not be identified: no uid on the object`);
    }
    const release = await deps.request('DELETE', path, {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        preconditions: { uid },
    });
    // 404: the holder released it first. 409: the claim we read was replaced in the meantime —
    // the next round's GET reads the new holder and orders us against it.
    const refusedRelease = refusal(release, 'releasing the checkout claim', HTTP_NOT_FOUND, HTTP_CONFLICT);
    if (refusedRelease) throw new Error(refusedRelease);
    return 'retry';
}

/**
 * Take the checkout claim, atomically. The POST is the whole mutex: the apiserver grants the name
 * to exactly one creator, so there is no window in which two attempts both hold the checkout — the
 * GET-then-POST race the label fence had is closed by construction. A `409` reads the holder: an
 * attempt number at or ahead of ours is our own replacement, and we stand down; behind ours is a
 * leftover from a driver that died holding the claim, released conditionally on the exact
 * incarnation we read.
 */
export async function acquireClaim(deps: K8sDeps, job: BoardJob, round = 1): Promise<void> {
    const path = claimPath(deps.config.k8sNamespace, job);
    if (round > CLAIM_ROUNDS) {
        throw new Error(`the checkout claim of job ${job.id} was never acquired after ${CLAIM_ROUNDS} rounds`);
    }
    const post = await deps.request('POST', configmapsPath(deps.config.k8sNamespace), claimBody(job));
    if (post.status < HTTP_ERROR_STATUS) return;
    const refused = refusal(post, 'claiming the checkout', HTTP_CONFLICT);
    if (refused) throw new Error(refused);
    if ((await takeOverStaleClaim(deps, job, path)) === 'ours') return;
    return acquireClaim(deps, job, round + 1);
}

/**
 * Give the checkout claim back — conditionally, because the only claim this attempt may ever
 * release is the exact incarnation it still holds. A claim that answers gone or held by another
 * attempt is left entirely alone: the first shape means nobody holds the checkout, the second
 * means a newer attempt took it over, and both leave nothing for this attempt to undo.
 */
export async function releaseClaim(deps: K8sDeps, job: BoardJob): Promise<void> {
    const path = claimPath(deps.config.k8sNamespace, job);
    let get: K8sResponse;
    try {
        get = await deps.request('GET', path);
    } catch {
        return; // Nothing provable; a leaked claim is taken over by the next claimant.
    }
    if (get.status === HTTP_NOT_FOUND || get.status >= HTTP_ERROR_STATUS) return;
    const claim = parse<K8sClaim>(get.body);
    const uid = claim.metadata?.uid;
    if (claim.data?.holder !== job.leaseToken || !uid) return;
    try {
        await deps.request('DELETE', path, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } });
    } catch {
        // Best effort: the leak's cost is one takeover by the next claimant, nothing worse.
    }
}

/** Whether a claim read's status/body prove the checkout still belongs to this attempt. */
function claimReadIsOurs(read: K8sResponse, job: BoardJob): boolean {
    const claim = parse<K8sClaim>(read.body);
    const readOk = read.status >= HTTP_OK_STATUS && read.status < HTTP_ERROR_STATUS;
    return readOk && claim.data?.holder === job.leaseToken;
}

/** Whether a claim read proves the checkout was taken over — gone, or held by someone else. */
function claimReadIsTakenOver(read: K8sResponse, job: BoardJob): boolean {
    const claim = parse<K8sClaim>(read.body);
    const readOk = read.status >= HTTP_OK_STATUS && read.status < HTTP_ERROR_STATUS;
    return (
        read.status === HTTP_NOT_FOUND || (readOk && claim.data?.holder !== undefined && !claimReadIsOurs(read, job))
    );
}

/** One kind's leftover objects — a job, a pod or a service — the sweep found by label. */
interface SweepFleet {
    kind: string;
    basePath: string;
    names: string[];
}

/** The named objects a label-selector list response carries — empty for anything unparseable. */
function namedItemsOf(body: string): string[] {
    const items = parse<{ items?: { metadata?: { name?: string } }[] }>(body).items ?? [];
    const names: string[] = [];
    for (const item of items) {
        if (item.metadata?.name) names.push(item.metadata.name);
    }
    return names;
}

/**
 * One label selector's leftover objects, or `null` for a kind that answered nothing of this job's
 * — `inconclusive` true the instant the kind could not be read at all, since a transport failure
 * or 429/5xx says nothing about whether its objects are gone.
 */
async function probeOneFleetKind(
    deps: K8sDeps,
    kind: string,
    selectorPath: string,
    basePath: string
): Promise<{ fleet: SweepFleet | null; inconclusive: boolean }> {
    let probe: K8sResponse;
    try {
        probe = await deps.request('GET', selectorPath);
    } catch {
        // A transport failure says nothing about whether the objects are gone.
        probe = { status: 0, body: '' };
    }
    // A kind answering nothing at all has nothing of this job in it.
    if (probe.status === HTTP_NOT_FOUND) return { fleet: null, inconclusive: false };
    if (probe.status >= HTTP_OK_STATUS && probe.status < HTTP_ERROR_STATUS) {
        const names = namedItemsOf(probe.body);
        return { fleet: names.length > 0 ? { kind, basePath, names } : null, inconclusive: false };
    }
    // 429/5xx/transport: inconclusive — the round cannot free the checkout.
    return { fleet: null, inconclusive: true };
}

/**
 * One pass over the three label selectors a leftover attempt can answer on. `conclusive` is false
 * the instant any kind could not be read at all — a transport failure or 429/5xx says nothing
 * about whether the objects are gone, so the caller must not read an empty `fleets` as a free
 * checkout on an inconclusive pass.
 */
async function probeLeftoverFleets(
    deps: K8sDeps,
    job: BoardJob
): Promise<{ fleets: SweepFleet[]; conclusive: boolean }> {
    const fleets: SweepFleet[] = [];
    let conclusive = true;
    for (const [kind, selectorPath, basePath] of [
        ['job', jobsSelectorPath(deps.config.k8sNamespace, job), jobsPath(deps.config.k8sNamespace)],
        ['pod', podsSelectorPath(deps.config.k8sNamespace, job), podsPath(deps.config.k8sNamespace)],
        ['service', servicesSelectorPath(deps.config.k8sNamespace, job), servicesPath(deps.config.k8sNamespace)],
    ] as const) {
        const { fleet, inconclusive } = await probeOneFleetKind(deps, kind, selectorPath, basePath);
        if (fleet) fleets.push(fleet);
        if (inconclusive) conclusive = false;
    }
    return { fleets, conclusive };
}

/** Whether this attempt still (provably) holds the claim the sweep is clearing leftovers for. */
async function verifyClaimHeldForSweep(deps: K8sDeps, job: BoardJob): Promise<'ours' | 'lost' | 'unknown'> {
    try {
        const held = await deps.request('GET', claimPath(deps.config.k8sNamespace, job));
        if (held.status === HTTP_NOT_FOUND) return 'lost';
        if (held.status >= HTTP_OK_STATUS && held.status < HTTP_ERROR_STATUS) {
            // A 2xx that cannot name its holder also reads as lost, deliberately asymmetric with
            // step six: standing down deletes nothing, so garbage is safe to act on HERE — while
            // step six deletes the Job, so there the same evidence fails loud without acting.
            return parse<K8sClaim>(held.body).data?.holder === job.leaseToken ? 'ours' : 'lost';
        }
        // 429/5xx: unconfirmed — neither delete nor stand down on a maybe.
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/** Deletes every named leftover of one sweep pass, answering how many deletes actually landed. */
async function deleteSweepFleets(deps: K8sDeps, fleets: SweepFleet[]): Promise<number> {
    let deleted = 0;
    for (const fleet of fleets) {
        for (const leftover of fleet.names) {
            const response = await deps.request('DELETE', `${fleet.basePath}/${leftover}?propagationPolicy=Foreground`);
            // A 404 is the ordinary end of an object another fence got to first; a 409 is a
            // concurrent replacement's fence deleting the same object. Both mean the object is
            // being removed. Anything else fails loud, as ever.
            const refused = refusal(response, `deleting the leftover ${fleet.kind}s`, HTTP_NOT_FOUND, HTTP_CONFLICT);
            if (refused) throw new Error(refused);
            if (response.status < HTTP_ERROR_STATUS) deleted += 1;
        }
    }
    return deleted;
}

/**
 * The sweep — the janitor that enforces the takeover. Every object the `factory.job=<id>`
 * selector answers is a leftover of the attempts this claim was taken FROM: deleted BY NAME, per
 * object, with Foreground propagation, until the selector answers nothing and this attempt's Job
 * is the only possible writer on the checkout. No timestamps, no cutoffs, no clocks: an age filter
 * was unsound in both directions, so the sweep classifies nothing. The claim is re-read before
 * every deleting round: a stale attempt whose claim was taken over mid-sweep STANDS DOWN having
 * deleted nothing.
 */
async function sweepClaimedFleets(deps: K8sDeps, job: BoardJob, waits = 0): Promise<void> {
    const nextRound = async (giveUpMessage: string): Promise<void> => {
        if (waits + 1 > REPLACE_MAX_POLLS) {
            throw new Error(`${giveUpMessage} (${REPLACE_MAX_POLLS} polls)`);
        }
        await deps.sleep(POLL_MS);
        return sweepClaimedFleets(deps, job, waits + 1);
    };

    const { fleets, conclusive } = await probeLeftoverFleets(deps, job);
    // Every kind answered and none has anything of this job's — the checkout is free.
    if (fleets.length === 0) {
        if (conclusive) return;
        // Inconclusive: keep polling within the same bound instead of creating alongside what
        // may still be there.
        return nextRound(`the fence of job ${job.id} could not confirm the checkout empty`);
    }
    const verified = await verifyClaimHeldForSweep(deps, job);
    if (verified === 'lost') {
        throw new Error(
            `job ${job.id} stands down: the checkout claim was taken over while the job label still answered`
        );
    }
    if (verified === 'unknown') {
        return nextRound(`the checkout claim of job ${job.id} could not be confirmed before fencing`);
    }
    const deleted = await deleteSweepFleets(deps, fleets);
    // Every delete came back 404/409 — another fence removed them already.
    if (deleted === 0) return;
    return nextRound(`the leftover objects of job ${job.id} never disappeared after their delete`);
}

/**
 * A failed delete leaves the Job to the kubelet's deadline: hold the claim — the checkout is never
 * handed over while this attempt's runner may still be on it.
 */
async function standDownOwnJob(deps: K8sDeps, job: BoardJob, cleanup: RunCleanup): Promise<void> {
    const deleted = await deleteOwnJob(deps, job);
    if (!deleted) cleanup.holdClaim = true;
}

/**
 * The runner's arrival, split so the loop's auxiliary services can start BETWEEN the fence and
 * the runner: `prepare` takes the checkout claim, sweeps the label's leftovers, creates the env
 * Secret and runs the pre-create claim verify; `launch` POSTs the Job and runs the post-create
 * verify.
 */
export async function prepare(deps: K8sDeps, job: BoardJob, _cleanup: RunCleanup): Promise<void> {
    const env = runnerEnv(job);

    // Step one: TAKE THE CHECKOUT.
    await acquireClaim(deps, job);

    // Step two: the sweep. See sweepClaimedFleets for the invariants it upholds.
    await sweepClaimedFleets(deps, job);

    // Step three: the env Secret, AFTER the claim and the sweep. Before the Job, as ever: a pod
    // that references a Secret that is not there yet is a CreateContainerConfigError and a
    // burned attempt.
    if (Object.keys(env).length) {
        const secretResponse = await deps.request(
            'POST',
            secretsPath(deps.config.k8sNamespace),
            secretBody(job, secretName(job), env)
        );
        expectOk(secretResponse, 'creating the runner secret');
    }

    // Step four: the claim must STILL be ours immediately before the Job POST — the first half
    // of the bracket that fences the POST from both sides.
    const pre = await readVerdict(deps, claimPath(deps.config.k8sNamespace, job), 'reading the checkout claim');
    if (claimReadIsTakenOver(pre, job)) {
        throw new Error(
            `job ${job.id} stands down: the checkout claim was taken over before the runner job was created`
        );
    }
    if (!claimReadIsOurs(pre, job)) {
        throw new Error(
            `the checkout claim of job ${job.id} could not be confirmed before creating the runner job ` +
                `(answered ${pre.status})`
        );
    }
}

// Step five: this attempt's Job, under its own attempt-scoped name.
export async function launch(deps: K8sDeps, job: BoardJob, spec: RunnerJobSpec, cleanup: RunCleanup): Promise<void> {
    const response = await deps.request('POST', jobsPath(deps.config.k8sNamespace), spec);
    expectOk(response, 'creating the runner job');

    // Step six: the claim must STILL be ours once the Job exists — the second half of the
    // bracket the pre-create verify opened. See docs/kubernetes.md for the full race analysis.
    let held: K8sResponse;
    try {
        held = await readVerdict(deps, claimPath(deps.config.k8sNamespace, job), 'reading the checkout claim');
    } catch (e) {
        await standDownOwnJob(deps, job, cleanup);
        throw e;
    }
    if (claimReadIsTakenOver(held, job)) {
        await standDownOwnJob(deps, job, cleanup);
        throw new Error(`job ${job.id} stands down: the checkout claim was taken over before the runner could start`);
    }
    if (!claimReadIsOurs(held, job)) {
        // Neither provably ours nor provably gone — and after the full patience, no runner stays
        // on a checkout its driver cannot verify.
        await standDownOwnJob(deps, job, cleanup);
        throw new Error(
            `the checkout claim of job ${job.id} could not be confirmed after creating the runner job ` +
                `(answered ${held.status})`
        );
    }
}
