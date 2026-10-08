import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { EvidencePolicy, RecordedEvidence } from '../src/db/evidence-policy.js';
import { createJobStore } from '../src/db/job-store.js';
import { reviewRefOf } from '../src/db/job-store-reviews.js';
import type { Claim, JobStore, ReviewerSpec } from '../src/db/job-store-types.js';
import { REVIEW_BLOCKERS_MARKER, REVIEW_VERDICT_MARKER } from '../src/db/workflow-templates.js';
import { useTestDb } from './harness.js';

/** Independent reviewer invocation (issue #549) on a real database: the SQL is what is under test. */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
const ORG = 'test-org';
const LEASE_SECONDS = 300;
const GITHUB_ID_BASE = 7300;
const REVIEWED = 'h:2';

const db = useTestDb({ max: 4 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
});

let accounts = 0;
const account = async (): Promise<string> => {
    accounts += 1;
    const [row] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login)
        values (${GITHUB_ID_BASE + accounts}, ${`reviews-${accounts}`})
        on conflict (github_user_id) do update set github_login = excluded.github_login
        returning id
    `;
    return row!.id;
};

const SECURITY: ReviewerSpec = {
    name: 'security',
    instructions: 'Look for injection and leaked secrets.',
    timeoutMinutes: 7,
    connections: ['JIRA_TOKEN'],
};

const MEMBER_ENV = { JIRA_TOKEN: 'jira', AWS_SECRET: 'aws', GITHUB_TOKEN: 'member-pat' };

/** A store whose gates reader answers the repository's policy and profiles from memory. */
const storeWith = (declared: { policy?: EvidencePolicy; reviewers?: ReviewerSpec[] } = {}): JobStore =>
    createJobStore({
        sql,
        orgId: ORG,
        gates: {
            readFor: async () => ({
                config: null,
                error: null,
                source: 'clone',
                ...(declared.policy ? { policy: declared.policy } : {}),
                ...(declared.reviewers ? { reviewers: declared.reviewers } : {}),
            }),
        },
        env: { resolveFor: async () => MEMBER_ENV },
        githubToken: { fresh: async () => 'minted-token' },
    });

const rowOf = async (id: string) => {
    const [row] = await sql<
        {
            id: string;
            root_job_id: string;
            status: string;
            failure_kind: string | null;
            output: string | null;
            cancel_requested_at: Date | null;
            review_of: string | null;
            review_revision: string | null;
            reviewers: unknown;
        }[]
    >`select id, root_job_id, status, failure_kind, output, cancel_requested_at, review_of, review_revision, reviewers
      from job where org_id = ${ORG} and id = ${id}`;
    return row!;
};

const reviewRows = (callerId: string) =>
    sql<{ id: string; status: string }[]>`
        select id, status from job where org_id = ${ORG} and review_of = ${callerId} order by created_at, id
    `;

/** Creates and claims one objective job, returning the lease. */
async function claimed(store: JobStore): Promise<Claim> {
    const created = await store.create('ship it', await account(), { repo: 'acme/web', executor: null });
    if (typeof created === 'string') throw new Error(`create refused: ${created}`);
    const claim = await store.claim('driver-1', LEASE_SECONDS);
    expect(claim?.id).toBe(created.id);
    return claim!;
}

const ask = (caller: Claim, key = 'sec-1', over: Partial<{ profile: string; ref: string }> = {}) =>
    storeWith({ reviewers: [SECURITY] }).requestReview(caller.id, caller.leaseToken, {
        key,
        profile: over.profile ?? 'security',
        revision: REVIEWED,
        ref: over.ref ?? reviewRefOf(caller.id, key),
    });

/** Claims the review's row the way a driver would, and settles it with `output`. */
async function reviewRuns(store: JobStore, output: string, status: 'succeeded' | 'failed' = 'succeeded') {
    const claim = await store.claim('driver-2', LEASE_SECONDS);
    expect(claim?.reviewRun).toBeDefined();
    await store.complete(claim!.id, claim!.leaseToken, { status, exitCode: status === 'succeeded' ? 0 : 1, output });
    return claim!;
}

const completeCaller = (store: JobStore, caller: Claim, treeAfter: string) =>
    store.complete(caller.id, caller.leaseToken, {
        status: 'succeeded',
        exitCode: 0,
        output: 'done',
        evidence: { treeBefore: 'h:1', treeAfter, gates: 'none' } as RecordedEvidence,
    });

describe.runIf(enabled)('named reviewer invocation on the job store', () => {
    it('stamps the declared profiles on the caller’s row at every claim, and none when none are declared', async () => {
        const declared = await claimed(storeWith({ reviewers: [SECURITY] }));
        expect((await rowOf(declared.id)).reviewers).toEqual([SECURITY]);
        const bare = await claimed(storeWith());
        expect((await rowOf(bare.id)).reviewers).toBeNull();
    });

    it('creates a queued review as a thread of its own, linked to its caller and bound to the revision', async () => {
        const caller = await claimed(storeWith({ reviewers: [SECURITY] }));
        const asked = await ask(caller);
        expect(asked.result).toBe('created');
        if (!('review' in asked)) throw new Error('no review');
        expect(asked.review).toMatchObject({
            key: 'sec-1',
            profile: 'security',
            status: 'queued',
            verdict: 'none',
            revision: REVIEWED,
        });
        const row = await rowOf(asked.review.id);
        expect(row).toMatchObject({ review_of: caller.id, review_revision: REVIEWED, status: 'queued' });
        expect(row.root_job_id).toBe(row.id);
        expect(row.root_job_id).not.toBe(caller.rootJobId);
    });

    it('answers the stored review for a repeated key — a retried or reclaimed caller never starts a second', async () => {
        const caller = await claimed(storeWith({ reviewers: [SECURITY] }));
        const first = await ask(caller);
        const again = await ask(caller);
        expect(again.result).toBe('existing');
        if (!('review' in first) || !('review' in again)) throw new Error('no review');
        expect(again.review.id).toBe(first.review.id);
        expect(await reviewRows(caller.id)).toHaveLength(1);
        await ask(caller, 'sec-2');
        expect(await reviewRows(caller.id)).toHaveLength(2);
    });

    it('refuses an undeclared profile, a ref outside the thread’s snapshot namespace, and a lost lease', async () => {
        const caller = await claimed(storeWith({ reviewers: [SECURITY] }));
        expect(await ask(caller, 'k', { profile: 'style' })).toEqual({ result: 'unknown_profile' });
        expect(await ask(caller, 'k', { ref: 'refs/heads/main' })).toEqual({ result: 'invalid_ref' });
        const lost = await storeWith({ reviewers: [SECURITY] }).requestReview(
            caller.id,
            '99999999-9999-4999-8999-999999999999',
            { key: 'k', profile: 'security', revision: REVIEWED, ref: reviewRefOf(caller.id, 'k') }
        );
        expect(lost).toEqual({ result: 'lost' });
        expect(await reviewRows(caller.id)).toHaveLength(0);
    });

    it('is claimable while its caller is still running, and carries only what the profile grants', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        expect(caller.env).toMatchObject({ GITHUB_TOKEN: 'member-pat', AWS_SECRET: 'aws', JIRA_TOKEN: 'jira' });
        const asked = await ask(caller);
        if (!('review' in asked)) throw new Error('no review');

        const review = await store.claim('driver-2', LEASE_SECONDS);
        expect(review).toMatchObject({
            id: asked.review.id,
            publish: false,
            reviewRun: { profile: 'security', ref: reviewRefOf(caller.id, 'sec-1'), timeoutMinutes: 7 },
        });
        // The caller's access does not follow: only the granted connection, no token of any kind.
        expect(review!.env).toEqual({ JIRA_TOKEN: 'jira' });
        expect(review!.gates).toBeUndefined();
        expect(review!.policy).toBeUndefined();
        expect(review!.helperPlans).toBeUndefined();
        expect(review!.masterPrompt).toContain('independent reviewer');
        expect(review!.masterPrompt).toContain(SECURITY.instructions);
        expect((await rowOf(caller.id)).status).toBe('running');
    });

    it('lets two reviews of one caller run together, each in its own thread', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller, 'a');
        await ask(caller, 'b');
        const first = await store.claim('driver-2', LEASE_SECONDS);
        const second = await store.claim('driver-3', LEASE_SECONDS);
        expect(first?.reviewRun).toBeDefined();
        expect(second?.reviewRun).toBeDefined();
        expect(second!.id).not.toBe(first!.id);
    });

    it('reads the verdict by key with the thread’s review evidence: queued is incomplete, clean at the revision approves', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller);
        const queued = await store.readReview(caller.id, caller.leaseToken, 'sec-1');
        expect(queued).toMatchObject({
            result: 'ok',
            review: { status: 'queued', verdict: 'none', evidence: { state: 'incomplete' } },
        });

        await reviewRuns(store, `no issues\n${REVIEW_VERDICT_MARKER}`);
        expect(await store.readReview(caller.id, caller.leaseToken, 'sec-1')).toMatchObject({
            result: 'ok',
            review: {
                status: 'succeeded',
                verdict: 'clean',
                findings: `no issues\n${REVIEW_VERDICT_MARKER}`,
                evidence: { state: 'approved', revision: REVIEWED },
            },
        });
        expect(await store.readReview(caller.id, caller.leaseToken, 'nope')).toEqual({ result: 'unknown' });
    });

    it('orders the reclaim of a settled review’s worktree on its own verdict, and not of its caller’s', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller);
        const claim = await store.claim('driver-2', LEASE_SECONDS);
        const done = await store.complete(claim!.id, claim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: `ok\n${REVIEW_VERDICT_MARKER}`,
        });
        expect(done).toEqual({ result: 'ok', threadDone: true });
        const [row] = await sql<{ worktree_reclaimed_at: Date | null }[]>`
            select worktree_reclaimed_at from job where org_id = ${ORG} and id = ${claim!.id}
        `;
        expect(row!.worktree_reclaimed_at).not.toBeNull();
        // The caller's own thread is still moving: its tree is not ordered away.
        expect((await rowOf(caller.id)).status).toBe('running');
    });

    it('reads blockers as a rejection, and a failed run as no verdict at all', async () => {
        const store = storeWith({ reviewers: [SECURITY] });
        const caller = await claimed(store);
        await ask(caller);
        await reviewRuns(store, `1. a.ts: injection\n${REVIEW_BLOCKERS_MARKER}`);
        expect(await store.readReview(caller.id, caller.leaseToken, 'sec-1')).toMatchObject({
            review: { verdict: 'blockers', evidence: { state: 'rejected' } },
        });
        await ask(caller, 'sec-2');
        await reviewRuns(store, `crashed\n${REVIEW_VERDICT_MARKER}`, 'failed');
        expect(await store.readReview(caller.id, caller.leaseToken, 'sec-2')).toMatchObject({
            review: { status: 'failed', verdict: 'none', evidence: { state: 'incomplete' } },
        });
    });

    describe('a required review', () => {
        const required = { policy: { review: true } as EvidencePolicy, reviewers: [SECURITY] };

        it('lets the caller complete once the review approved the revision the work ends on', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await ask(caller);
            await reviewRuns(store, `fine\n${REVIEW_VERDICT_MARKER}`);
            await completeCaller(store, caller, REVIEWED);
            expect(await rowOf(caller.id)).toMatchObject({ status: 'succeeded', failure_kind: null });
        });

        it('refuses the completion while the review is unfinished — the verdict stops it, and a stopped review never approves', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await ask(caller);
            await completeCaller(store, caller, REVIEWED);
            const row = await rowOf(caller.id);
            expect(row).toMatchObject({ status: 'failed', failure_kind: 'policy' });
            expect(row.output).toContain('unfinished, failed or cancelled');
        });

        it('refuses an approval of a revision the work moved past', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await ask(caller);
            await reviewRuns(store, `fine\n${REVIEW_VERDICT_MARKER}`);
            await completeCaller(store, caller, 'h:3-edited-after-review');
            const row = await rowOf(caller.id);
            expect(row).toMatchObject({ status: 'failed', failure_kind: 'policy' });
            expect(row.output).toContain('assessed a different revision');
        });

        it('refuses when profiles are declared and none was ever asked for, with the missing-review reason', async () => {
            const store = storeWith(required);
            const caller = await claimed(store);
            await completeCaller(store, caller, REVIEWED);
            expect((await rowOf(caller.id)).output).toContain('a review is required and none has run');
        });
    });

    describe('cancellation and cleanup', () => {
        it('stops its queued reviews with the caller’s Stop, and stamps a running one for the heartbeat to deliver', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            const queued = await ask(caller, 'queued');
            const running = await ask(caller, 'running');
            if (!('review' in queued) || !('review' in running)) throw new Error('no review');
            // The oldest queued review is the one a driver claims first.
            const claim = await store.claim('driver-2', LEASE_SECONDS);
            expect(claim?.id).toBe(queued.review.id);

            expect(await store.stop(caller.id, null)).toMatchObject({ result: 'requested' });
            expect((await rowOf(queued.review.id)).cancel_requested_at).not.toBeNull();
            expect(await rowOf(running.review.id)).toMatchObject({ status: 'stopped', cancel_requested_at: null });
        });

        it('stops the reviews still open when the caller’s verdict lands', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            await ask(caller);
            await completeCaller(store, caller, REVIEWED);
            expect(await reviewRows(caller.id)).toEqual([expect.objectContaining({ status: 'stopped' })]);
        });

        it('stops them when the caller is retired dead, so none is orphaned', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            await ask(caller);
            await sql`
                update job set lease_expires_at = now() - interval '1 minute', attempts = max_attempts
                where org_id = ${ORG} and id = ${caller.id}
            `;
            await store.claim('driver-9', LEASE_SECONDS);
            expect((await rowOf(caller.id)).status).toBe('dead');
            expect(await reviewRows(caller.id)).toEqual([expect.objectContaining({ status: 'stopped' })]);
        });

        it('keeps a review across a caller reclaim, and the re-asked key finds it', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            const first = await ask(caller);
            await sql`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${ORG} and id = ${caller.id}`;
            const reclaimed = await store.claim('driver-2', LEASE_SECONDS);
            expect(reclaimed?.id).toBe(caller.id);
            const again = await ask(reclaimed!);
            if (!('review' in first) || !('review' in again)) throw new Error('no review');
            expect(again.review.id).toBe(first.review.id);
            expect(await reviewRows(caller.id)).toHaveLength(1);
        });

        it('is not a task once settled: out of the terminal list, and no follow-up or retry runs it as an ordinary job', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            await ask(caller);
            const review = await reviewRuns(store, `fine\n${REVIEW_VERDICT_MARKER}`);
            const [row] = await sql<{ created_by: string }[]>`
                select created_by from job where org_id = ${ORG} and id = ${review.id}
            `;
            await completeCaller(store, caller, REVIEWED);

            const settled = await store.list({ status: 'terminal', limit: 50 });
            expect(settled.map((job) => job.id)).not.toContain(review.id);
            expect(settled.map((job) => job.rootJobId)).toContain(caller.rootJobId);

            expect(await store.createFollowUp(review.id, 'again', row!.created_by)).not.toHaveProperty('id');
            expect(await store.createRetry(review.id, row!.created_by)).not.toHaveProperty('id');
            const [members] = await sql<{ count: number }[]>`
                select count(*)::int as count from job where org_id = ${ORG} and root_job_id = ${review.id}
            `;
            expect(members?.count).toBe(1);
        });

        it('keeps reviews out of the task list, and removes them with their thread', async () => {
            const store = storeWith({ reviewers: [SECURITY] });
            const caller = await claimed(store);
            const asked = await ask(caller);
            if (!('review' in asked)) throw new Error('no review');
            const { page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 10 });
            expect(page.items.map((task) => task.id)).toEqual([caller.rootJobId]);

            await completeCaller(store, caller, REVIEWED);
            expect(await store.removeThread(caller.id, null)).toMatchObject({ result: 'ok' });
            expect(await reviewRows(caller.id)).toEqual([]);
            const reclaims = await sql<{ root_job_id: string }[]>`
                select root_job_id from task_reclaim where org_id = ${ORG} order by created_at, id
            `;
            expect(reclaims.map((row) => row.root_job_id).sort()).toEqual([caller.rootJobId, asked.review.id].sort());
        });
    });
});
