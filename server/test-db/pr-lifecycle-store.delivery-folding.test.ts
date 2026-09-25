import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: PrLifecycleStore;
let otherOrg: PrLifecycleStore;

const ORG = 'test-org';
const ORG_OTHER = 'other-org';
const ROOT = '00000000-0000-4000-8000-00000000f202';
const ROOT_TWO = '00000000-0000-4000-8000-00000000f203';
const REPO = 'Bellows-AI/factory';
const PR = 42;

const db = useTestDb({ orgs: [ORG, ORG_OTHER] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createPrLifecycleStore({ sql, orgId: ORG });
    otherOrg = createPrLifecycleStore({ sql, orgId: ORG_OTHER });
});

describe.skipIf(!enabled)('the pr lifecycle store: delivery folding', () => {
    it('folds a new delivery into every open wait on the PR, and dedupes redeliveries', async () => {
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        await store.enterWait({ root: ROOT_TWO, reason: 'review', repo: REPO, prNumber: PR });

        expect(
            await store.recordDelivery({
                deliveryId: 'delivery-1',
                event: 'pull_request_review',
                action: 'submitted',
                repo: REPO,
                prNumber: PR,
            })
        ).toBe('folded');
        expect(
            await store.recordDelivery({
                deliveryId: 'delivery-1',
                event: 'pull_request_review',
                action: 'submitted',
                repo: REPO,
                prNumber: PR,
            })
        ).toBe('duplicate');

        const both = await sql<{ root_job_id: string; pending: number }[]>`
            select root_job_id, pending from workflow_wait
            where org_id = ${ORG} and repo = ${REPO} and pr_number = ${PR}
            order by root_job_id
        `;
        expect(both).toEqual([
            { root_job_id: ROOT, pending: 1 },
            { root_job_id: ROOT_TWO, pending: 1 },
        ]);
    });

    it('records a delivery with no open wait as unmatched, still deduped by guid', async () => {
        await store.enterWait({ root: ROOT_TWO, reason: 'review', repo: 'Bellows-AI/other', prNumber: 7 });

        expect(
            await store.recordDelivery({
                deliveryId: 'delivery-2',
                event: 'pull_request',
                action: 'synchronize',
                repo: REPO,
                prNumber: PR,
            })
        ).toBe('unmatched');
        expect(
            await store.recordDelivery({
                deliveryId: 'delivery-2',
                event: 'pull_request',
                action: 'synchronize',
                repo: REPO,
                prNumber: PR,
            })
        ).toBe('duplicate');
    });

    it('never folds another repository, another PR, or another org', async () => {
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });

        await store.recordDelivery({
            deliveryId: 'd-other-repo',
            event: 'pull_request',
            action: 'synchronize',
            repo: 'Bellows-AI/other',
            prNumber: PR,
        });
        await store.recordDelivery({
            deliveryId: 'd-other-pr',
            event: 'pull_request',
            action: 'synchronize',
            repo: REPO,
            prNumber: 999,
        });
        await otherOrg.recordDelivery({
            deliveryId: 'd-other-org',
            event: 'pull_request',
            action: 'synchronize',
            repo: REPO,
            prNumber: PR,
        });

        expect((await store.waitOf(ROOT))?.pending).toBe(0);
    });

    it('prunes deliveries recorded before the ledger window', async () => {
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        await store.recordDelivery({
            deliveryId: 'old-delivery',
            event: 'pull_request',
            action: 'synchronize',
            repo: REPO,
            prNumber: PR,
        });
        await sql`update github_delivery set seen_at = now() - interval '8 days' where delivery_id = 'old-delivery'`;

        // A fresh delivery prunes the ledger: the old guid no longer dedupes.
        await store.recordDelivery({
            deliveryId: 'new-delivery',
            event: 'pull_request',
            action: 'synchronize',
            repo: REPO,
            prNumber: PR,
        });
        const [row] = await sql<{ n: number }[]>`select count(*)::int as n from github_delivery`;
        expect(row?.n).toBe(1);

        // And a re-delivery of the old guid folds again, like the first time.
        expect(
            await store.recordDelivery({
                deliveryId: 'old-delivery',
                event: 'pull_request',
                action: 'synchronize',
                repo: REPO,
                prNumber: PR,
            })
        ).toBe('folded');
    });
});
