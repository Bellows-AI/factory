import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createPrLifecycleStore, type PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: PrLifecycleStore;

const ORG = 'test-org';
const ROOT = '00000000-0000-4000-8000-00000000f202';
const ROOT_TWO = '00000000-0000-4000-8000-00000000f203';
const REPO = 'Bellows-AI/factory';
const PR = 42;

const db = useTestDb({ orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createPrLifecycleStore({ sql, orgId: ORG });
});

describe.skipIf(!enabled)('the pr lifecycle store', () => {
    it('records a publication and replaces it on a re-publish', async () => {
        expect(await store.publicationOf(ROOT)).toBeNull();

        await store.recordPublication({
            root: ROOT,
            repo: REPO,
            prNumber: PR,
            prUrl: `https://github.com/${REPO}/pull/${PR}`,
            headBranch: 'pr/42',
            baseBranch: 'main',
        });
        await store.recordPublication({
            root: ROOT,
            repo: REPO,
            prNumber: 43,
            prUrl: `https://github.com/${REPO}/pull/43`,
            headBranch: 'pr/43',
            baseBranch: 'main',
        });

        expect(await store.publicationOf(ROOT)).toEqual({
            repo: REPO,
            prNumber: 43,
            prUrl: `https://github.com/${REPO}/pull/43`,
            headBranch: 'pr/43',
            baseBranch: 'main',
        });
    });

    it('enters a wait and keeps an active wait intact on re-entry', async () => {
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        await store.recordDelivery({
            deliveryId: 'delivery-1',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PR,
        });
        expect((await store.waitOf(ROOT))?.pending).toBe(1);

        // Re-entering an ACTIVE wait is a no-op: its folded delivery is not thrown away.
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        const wait = await store.waitOf(ROOT);
        expect(wait?.pending).toBe(1);
        expect(wait?.completedAt).toBeNull();
        expect(wait?.cancelledAt).toBeNull();
    });

    it('starts a fresh cycle when a terminal wait is re-entered', async () => {
        await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        await store.recordDelivery({
            deliveryId: 'delivery-1',
            event: 'pull_request_review',
            action: 'submitted',
            repo: REPO,
            prNumber: PR,
        });
        await store.finishWait(ROOT, 'review');

        const reentered = await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
        expect(reentered.pending).toBe(0);
        expect(reentered.lastDeliveryId).toBeNull();
        expect(reentered.completedAt).toBeNull();

        // One row total — the cycle replaced the terminal one.
        const [row] = await sql`select count(*)::int as n from workflow_wait`;
        expect(row?.n).toBe(1);
    });

    describe('finish and cancel', () => {
        it('finishes a wait once and is idempotent thereafter', async () => {
            await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
            expect(await store.finishWait(ROOT, 'review', 'exhausted')).toBe(true);
            expect(await store.finishWait(ROOT, 'review')).toBe(false);

            const wait = await store.waitOf(ROOT);
            expect(wait?.completedAt).not.toBeNull();
            expect(wait?.cancelledAt).toBeNull();
            expect(wait?.terminalReason).toBe('exhausted');
        });

        it('cancels a wait once, and cancelWait does not touch a completed one', async () => {
            await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
            await store.enterWait({ root: ROOT, reason: 'fixes', repo: REPO, prNumber: PR });
            await store.finishWait(ROOT, 'review');

            expect(await store.cancelWait(ROOT, 'review', 'task stopped')).toBe(false);
            expect(await store.cancelWait(ROOT, 'fixes', 'task stopped')).toBe(true);

            const [fixes, review] = await sql<
                { completed_at: Date | null; cancelled_at: Date | null; terminal_reason: string | null }[]
            >`
                select completed_at, cancelled_at, terminal_reason from workflow_wait
                where org_id = ${ORG} and root_job_id = ${ROOT} order by reason
            `;
            expect(review?.completed_at).not.toBeNull();
            expect(review?.cancelled_at).toBeNull();
            expect(fixes?.completed_at).toBeNull();
            expect(fixes?.cancelled_at).not.toBeNull();
        });

        it('cancels every open wait of a root and returns the count', async () => {
            await store.enterWait({ root: ROOT, reason: 'review', repo: REPO, prNumber: PR });
            await store.enterWait({ root: ROOT, reason: 'fixes', repo: REPO, prNumber: PR });
            await store.enterWait({ root: ROOT_TWO, reason: 'review', repo: REPO, prNumber: PR });

            expect(await store.cancelWaitsForRoot(ROOT, 'task stopped')).toBe(2);
            expect(await store.cancelWaitsForRoot(ROOT, 'task stopped')).toBe(0);
            expect((await store.waitOf(ROOT_TWO))?.cancelledAt).toBeNull();
        });
    });
});
