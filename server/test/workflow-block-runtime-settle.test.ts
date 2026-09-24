import { describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';
import { entersBlockHelperNode, settleBlockWaits } from '../src/db/workflow-blocks/runtime-settle.js';
import type { JobStorePrs } from '../src/db/job-store-types.js';
import type { Transition } from '../src/db/workflow-engine.js';
import type { WorkflowDefinition, WorkflowNode } from '../src/db/workflow-schema.js';

/**
 * The generic settle rule (issue #133's resolution of the "who calls finishWait" question): a
 * pure-ish unit suite against a fake `JobStorePrs`, no database involved.
 * `job-store.block-wait.test.ts` (issue #231) and this block's own DB suite cover the same rule
 * wired into a real transaction; this file pins the SCOPE arithmetic and the transition-branch
 * decisions in isolation.
 */

const TX = {} as TransactionSql;

const node = (name: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
    name,
    kind: 'agent',
    session: 'resume',
    prompt: 'x',
    ...overrides,
});

/** A snapshot with one block's four internal nodes (collect/wait/repair/reply), `wait` carrying
 *  the runtime boundary — the exact shape github-review-reconcile.ts's expand() produces. */
const SNAPSHOT: WorkflowDefinition = {
    entry: 'review--collect',
    nodes: [
        node('review--collect', {
            helperPlans: [{ helperId: 'review-collect-probe', phase: 'pre', githubWriting: true }],
        }),
        node('review--wait', {
            runtime: { runtime: 'pr-delivery-wait', block: 'builtin/github-review-reconcile', params: {} },
            helperPlans: [{ helperId: 'review-collect-probe', phase: 'pre', githubWriting: true }],
        }),
        node('review--repair'),
        node('review--reply'),
        node('ship', { publish: true }),
        node('other--collect', {
            helperPlans: [{ helperId: 'review-collect-probe', phase: 'pre', githubWriting: true }],
        }),
    ],
    edges: [],
};

function fakePrs(): JobStorePrs & {
    calls: Array<{ root: string; reason: string; terminalReason: string | undefined }>;
} {
    const calls: Array<{ root: string; reason: string; terminalReason: string | undefined }> = [];
    return {
        calls,
        async recordPublication() {},
        async publicationOf() {
            return null;
        },
        async finishWait(root, reason, terminalReason) {
            calls.push({ root, reason, terminalReason });
            return true;
        },
        async cancelWaitsForRoot() {
            return 0;
        },
        async enterWait() {
            throw new Error('not exercised');
        },
        async claimReview() {
            throw new Error('not exercised');
        },
    };
}

const REST: Transition = { action: 'rest', reason: 'no_edge' };
const INSERT_TO = (name: string): Transition => ({
    action: 'insert',
    node: SNAPSHOT.nodes.find((n) => n.name === name)!,
    command: 'x',
    session: 'resume',
    publish: false,
});

describe('settleBlockWaits', () => {
    it('is a no-op with no prs configured', async () => {
        await settleBlockWaits(TX, undefined, {
            rootJobId: 'r1',
            snapshot: SNAPSHOT,
            from: 'review--wait',
            transition: REST,
        });
    });

    it('is a no-op when the halted node is not inside any block (a bare, non-namespaced node)', async () => {
        const prs = fakePrs();
        await settleBlockWaits(TX, prs, { rootJobId: 'r1', snapshot: SNAPSHOT, from: 'ship', transition: REST });
        expect(prs.calls).toEqual([]);
    });

    it('is a no-op for an insert that stays inside the same block (repair -> reply)', async () => {
        const prs = fakePrs();
        await settleBlockWaits(TX, prs, {
            rootJobId: 'r1',
            snapshot: SNAPSHOT,
            from: 'review--repair',
            transition: INSERT_TO('review--reply'),
        });
        expect(prs.calls).toEqual([]);
    });

    it('is a no-op for re-parking into the wait node itself (same scope, still inside)', async () => {
        const prs = fakePrs();
        await settleBlockWaits(TX, prs, {
            rootJobId: 'r1',
            snapshot: SNAPSHOT,
            from: 'review--collect',
            transition: INSERT_TO('review--wait'),
        });
        expect(prs.calls).toEqual([]);
    });

    it('finishes the wait when the thread rests inside the block, naming the reason', async () => {
        const prs = fakePrs();
        await settleBlockWaits(TX, prs, {
            rootJobId: 'r1',
            snapshot: SNAPSHOT,
            from: 'review--collect',
            transition: { action: 'rest', reason: 'loop_bound' },
        });
        expect(prs.calls).toEqual([{ root: 'r1', reason: 'review--wait', terminalReason: 'rested (loop_bound)' }]);
    });

    it('finishes the wait when a transition leaves the block for an outer node', async () => {
        const prs = fakePrs();
        await settleBlockWaits(TX, prs, {
            rootJobId: 'r1',
            snapshot: SNAPSHOT,
            from: 'review--collect',
            transition: INSERT_TO('ship'),
        });
        expect(prs.calls).toEqual([{ root: 'r1', reason: 'review--wait', terminalReason: 'block exited' }]);
    });

    it('only finishes waits belonging to the SAME scope as the halted node', async () => {
        const other: WorkflowDefinition = {
            entry: 'a--collect',
            nodes: [
                ...SNAPSHOT.nodes,
                node('other--wait', {
                    runtime: { runtime: 'pr-delivery-wait', block: 'builtin/github-review-reconcile', params: {} },
                }),
            ],
            edges: [],
        };
        const prs = fakePrs();
        await settleBlockWaits(TX, prs, {
            rootJobId: 'r1',
            snapshot: other,
            from: 'review--collect',
            transition: INSERT_TO('ship'),
        });
        expect(prs.calls).toEqual([{ root: 'r1', reason: 'review--wait', terminalReason: 'block exited' }]);
    });

    it('is idempotent from the caller’s perspective — finishWait itself is a no-op on an already-terminal wait', async () => {
        const prs = fakePrs();
        const spy = vi.spyOn(prs, 'finishWait');
        await settleBlockWaits(TX, prs, {
            rootJobId: 'r1',
            snapshot: SNAPSHOT,
            from: 'review--collect',
            transition: REST,
        });
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe('entersBlockHelperNode', () => {
    it('is true entering a helper-plan node from a bare (non-block) node', () => {
        expect(entersBlockHelperNode('ship', INSERT_TO('review--collect'))).toBe(true);
    });

    it("is true entering a helper-plan node from a DIFFERENT block's scope", () => {
        expect(entersBlockHelperNode('other--collect', INSERT_TO('review--collect'))).toBe(true);
    });

    it("is true for the graph entry itself (from: null), a fresh thread's first row", () => {
        expect(entersBlockHelperNode(null, INSERT_TO('review--collect'))).toBe(true);
    });

    it('is false for a move that stays inside the same block (collect -> wait)', () => {
        expect(entersBlockHelperNode('review--collect', INSERT_TO('review--wait'))).toBe(false);
    });

    it('is false entering a node with no declared helperPlans', () => {
        expect(entersBlockHelperNode('ship', INSERT_TO('review--repair'))).toBe(false);
    });

    it('is false for a rest — nothing is being entered', () => {
        expect(entersBlockHelperNode('ship', REST)).toBe(false);
    });

    it('is false entering a bare node with helperPlans-free shape from another bare node', () => {
        expect(entersBlockHelperNode('review--repair', INSERT_TO('ship'))).toBe(false);
    });
});
