import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: PrLifecycleStore;

const ORG = 'test-org';
const ROOT = '00000000-0000-4000-8000-00000000f202';
const REPO = 'Bellows-AI/factory';
const PR = 42;

const db = useTestDb({ orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createPrLifecycleStore({ sql, orgId: ORG });
});

describe.skipIf(!enabled)('the pr lifecycle store: claiming reviews', () => {
    it('claims the folded deliveries once and leaves the coalesce for the next claim', async () => {
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        await store.recordDelivery({
            deliveryId: 'delivery-1',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PR,
        });
        await store.recordDelivery({
            deliveryId: 'delivery-2',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PR,
        });

        expect(await store.claimReview(ROOT, 'review')).toEqual({
            pending: 2,
            lastDeliveryId: 'delivery-2',
        });
        expect(await store.claimReview(ROOT, 'review')).toEqual({
            pending: 0,
            lastDeliveryId: 'delivery-2',
        });

        // A delivery that lands during the claim folds on the reset zero — the next claim sees it.
        await store.recordDelivery({
            deliveryId: 'delivery-3',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PR,
        });
        expect((await store.claimReview(ROOT, 'review')).pending).toBe(1);
    });

    it('claims nothing for a wait that is missing or terminal', async () => {
        expect(await store.claimReview(ROOT, 'review')).toEqual({ pending: 0, lastDeliveryId: null });

        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        await store.finishWait(ROOT, 'review');
        expect(await store.claimReview(ROOT, 'review')).toEqual({ pending: 0, lastDeliveryId: null });
    });

    it('prefers the open wait and otherwise the newest terminal one', async () => {
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        await store.finishWait(ROOT, 'review');
        await store.enterWait({ root: ROOT, reason: 'fixes', repo: REPO, prNumber: PR });

        const wait = await store.waitOf(ROOT);
        expect(wait?.reason).toBe('fixes');
        expect(wait?.completedAt).toBeNull();

        await store.finishWait(ROOT, 'fixes');
        expect((await store.waitOf(ROOT))?.reason).toBe('fixes');
        expect((await store.waitOf(ROOT))?.completedAt).not.toBeNull();
    });

    it('runs through a caller transaction like the verdict does', async () => {
        const sql2 = sql;
        await sql2
            .begin(async (tx) => {
                await store.recordPublication(
                    {
                        root: ROOT,
                        repo: REPO,
                        prNumber: PR,
                        prUrl: `https://github.com/${REPO}/pull/${PR}`,
                        headBranch: 'pr/42',
                        baseBranch: 'main',
                    },
                    tx
                );
                await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR }, tx);
                throw new Error('roll back');
            })
            .catch(() => {});

        // Both statements rolled back together.
        expect(await store.publicationOf(ROOT)).toBeNull();
        expect(await store.waitOf(ROOT)).toBeNull();
    });
});
