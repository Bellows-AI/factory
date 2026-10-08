import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { EvidencePolicy, RecordedEvidence } from '../src/db/evidence-policy.js';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
const ORG = 'test-org';
const LEASE_SECONDS = 300;
const GITHUB_ID_BASE = 7100;

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
        values (${GITHUB_ID_BASE + accounts}, ${`evidence-${accounts}`})
        on conflict (github_user_id) do update set github_login = excluded.github_login
        returning id
    `;
    return row!.id;
};

/** A store whose gates reader answers the repository's policy from memory — the SQL is under test. */
const storeWith = (policy: EvidencePolicy | undefined): JobStore =>
    createJobStore({
        sql,
        orgId: ORG,
        gates: { readFor: async () => ({ config: null, error: null, source: 'clone', ...(policy ? { policy } : {}) }) },
    });

const PASSED: RecordedEvidence = { treeBefore: 'h:1', treeAfter: 'h:2', gates: 'passed' };

const rowOf = async (id: string) => {
    const [row] = await sql<
        { status: string; failure_kind: string | null; output: string | null; evidence: unknown; policy: unknown }[]
    >`select status, failure_kind, output, evidence, policy from job where org_id = ${ORG} and id = ${id}`;
    return row!;
};

/** Creates and claims one objective job, returning the lease. */
async function claimed(store: JobStore) {
    const created = await store.create('ship it', await account(), { repo: 'acme/web', executor: null });
    if (typeof created === 'string') throw new Error(`create refused: ${created}`);
    const claim = await store.claim('driver-1', LEASE_SECONDS);
    expect(claim?.id).toBe(created.id);
    return claim!;
}

describe.runIf(enabled)('revision-bound evidence on the job store', () => {
    it('stamps the repository policy on the claim and on the row, and none when none is declared', async () => {
        const store = storeWith({ gates: true });
        const claim = await claimed(store);
        expect(claim.policy).toEqual({ gates: true });
        expect((await rowOf(claim.id)).policy).toEqual({ gates: true });

        const bare = await claimed(storeWith(undefined));
        expect(bare.policy).toBeUndefined();
        expect((await rowOf(bare.id)).policy).toBeNull();
    });

    it('carries no review evidence unless a review is required, and "unavailable" for an objective task', async () => {
        expect((await claimed(storeWith({ gates: true }))).review).toBeUndefined();
        expect((await claimed(storeWith({ review: true }))).review).toEqual({ state: 'unavailable' });
    });

    it('persists the verdict’s evidence record on the row', async () => {
        const store = storeWith(undefined);
        const claim = await claimed(store);
        await store.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'ok',
            evidence: PASSED,
        });
        expect((await rowOf(claim.id)).evidence).toEqual(PASSED);
    });

    it('lets a succeeded verdict with passed gates stand under a gates policy', async () => {
        const store = storeWith({ gates: true });
        const claim = await claimed(store);
        await store.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'ok',
            evidence: PASSED,
        });
        expect(await rowOf(claim.id)).toMatchObject({ status: 'succeeded', failure_kind: null });
    });

    it.each([
        ['no evidence', null],
        ['gates that never ran', { treeBefore: 'h:1', treeAfter: 'h:1', gates: 'none' } as const],
        ['gates that failed', { treeBefore: 'h:1', treeAfter: 'h:1', gates: 'failed' } as const],
    ])('rewrites a succeeded verdict carrying %s to a failed policy one', async (_name, evidence) => {
        const store = storeWith({ gates: true });
        const claim = await claimed(store);
        await store.complete(claim.id, claim.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok', evidence });
        const row = await rowOf(claim.id);
        expect(row).toMatchObject({ status: 'failed', failure_kind: 'policy' });
        expect(row.output).toContain('[board] completion refused — declared gates are required');
    });

    it('refuses a required review on an objective task with the no-reviewer reason', async () => {
        const store = storeWith({ review: true });
        const claim = await claimed(store);
        await store.complete(claim.id, claim.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'ok',
            evidence: PASSED,
        });
        const row = await rowOf(claim.id);
        expect(row).toMatchObject({ status: 'failed', failure_kind: 'policy' });
        expect(row.output).toContain('this task has no reviewer');
    });

    it('records nothing for a stale attempt: a verdict on a reclaimed lease is refused', async () => {
        const store = storeWith({ gates: true });
        const claim = await claimed(store);
        const answer = await store.complete(claim.id, '99999999-9999-4999-8999-999999999999', {
            status: 'succeeded',
            exitCode: 0,
            output: 'ok',
            evidence: PASSED,
        });
        expect(answer.result).toBe('lost');
        expect(await rowOf(claim.id)).toMatchObject({ status: 'running', evidence: null });
    });

    it('re-stamps the policy on a reclaim and refuses the superseded attempt’s verdict', async () => {
        const first = await claimed(storeWith({ gates: true }));
        await sql`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${ORG} and id = ${first.id}`;

        // The repository's policy changed while the first attempt was away: the reclaim carries the new one.
        const second = await storeWith({ review: true }).claim('driver-2', LEASE_SECONDS);
        expect(second).toMatchObject({ id: first.id, policy: { review: true } });
        expect((await rowOf(first.id)).policy).toEqual({ review: true });

        const stale = await storeWith({ gates: true }).complete(first.id, first.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'ok',
            evidence: PASSED,
        });
        expect(stale.result).toBe('lost');
        expect(await rowOf(first.id)).toMatchObject({ status: 'running', evidence: null });
    });
});
