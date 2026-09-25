import type { DeliveryOutcome, PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';

/**
 * An in-memory PrLifecycleStore for the webhook route tests: it keeps the offline suite a
 * no-database suite while still exercising the fold/cancel routing and the delivery-GUID dedupe —
 * the whole of what a webhook does. Bound to the org runtime like the SQL store, seeded with the
 * waits a test wants the delivery addressed to; the SQL behind it is covered by server/test-db.
 */
export interface MemoryPrLifecycleStore extends PrLifecycleStore {
    seedWait(repo: string, prNumber: number): void;
    /** The seeded waits that still answer — the asserts the webhook's writes land on. */
    waits(): { repo: string; prNumber: number; pending: number }[];
    deliveries(): {
        deliveryId: string;
        event: string;
        action: string;
        repo: string;
        prNumber: number;
        outcome: DeliveryOutcome;
    }[];
    cancellations(): { repo: string; prNumber: number; terminalReason: string }[];
}

export function memoryPrLifecycleStore(): MemoryPrLifecycleStore {
    interface Wait {
        repo: string;
        prNumber: number;
        pending: number;
        cancelled: boolean;
    }
    interface Delivery {
        deliveryId: string;
        event: string;
        action: string;
        repo: string;
        prNumber: number;
        outcome: DeliveryOutcome;
    }
    const waits: Wait[] = [];
    const deliveries: Delivery[] = [];
    const cancellations: { repo: string; prNumber: number; terminalReason: string }[] = [];
    const at = (): string => new Date().toISOString();
    const openWaits = (repo: string, prNumber: number): Wait[] =>
        waits.filter((w) => !w.cancelled && w.repo === repo && w.prNumber === prNumber);

    return {
        seedWait(repo, prNumber) {
            waits.push({ repo, prNumber, pending: 0, cancelled: false });
        },

        waits: () => waits.map((w) => ({ repo: w.repo, prNumber: w.prNumber, pending: w.pending })),

        deliveries: () => deliveries.map((d) => ({ ...d })),

        cancellations: () => cancellations.map((c) => ({ ...c })),

        async recordPublication() {
            throw new Error('memory pr lifecycle: recordPublication is not exercised by route tests');
        },
        async publicationOf() {
            throw new Error('memory pr lifecycle: publicationOf is not exercised by route tests');
        },
        async enterWait(input) {
            if (openWaits(input.repo, input.prNumber).length === 0) {
                waits.push({ repo: input.repo, prNumber: input.prNumber, pending: 0, cancelled: false });
            }
            return {
                reason: input.reason,
                repo: input.repo,
                prNumber: input.prNumber,
                pending: 0,
                lastDeliveryId: null,
                activeAt: at(),
                completedAt: null,
                cancelledAt: null,
                terminalReason: null,
                lastEventAt: null,
            };
        },
        async finishWait() {
            // This fake tracks waits by (repo, prNumber) only, never (root, reason) — it was built
            // for the webhook route suite, which never opens a root/reason-keyed wait. Answering
            // `false` (no matching wait) is what the real store would say for the same input here,
            // rather than a throw: issue #133's `settleBlockWaits` calls this generically on every
            // workflow-transition completion that departs a block scope, so a future test that
            // reuses this fake alongside `runWorkflowTransition` must see a harmless "did nothing"
            // instead of an unrelated crash.
            return false;
        },
        async cancelWait() {
            throw new Error('memory pr lifecycle: cancelWait is not exercised by route tests');
        },
        async cancelWaitsForRoot() {
            throw new Error('memory pr lifecycle: cancelWaitsForRoot is not exercised by route tests');
        },
        async cancelForRepoPr(repo, prNumber, terminalReason = 'pr closed') {
            const hit = openWaits(repo, prNumber);
            for (const wait of hit) wait.cancelled = true;
            cancellations.push({ repo, prNumber, terminalReason });
            return hit.length;
        },
        async recordDelivery(delivery) {
            if (deliveries.some((d) => d.deliveryId === delivery.deliveryId)) return 'duplicate';
            const hit = openWaits(delivery.repo, delivery.prNumber);
            for (const wait of hit) wait.pending += 1;
            const outcome: DeliveryOutcome = hit.length > 0 ? 'folded' : 'unmatched';
            deliveries.push({ ...delivery, outcome });
            return outcome;
        },
        async claimReview() {
            throw new Error('memory pr lifecycle: claimReview is not exercised by route tests');
        },
        async waitOf() {
            throw new Error('memory pr lifecycle: waitOf is not exercised by route tests');
        },
    };
}
