import { describe, expect, it } from 'vitest';
import {
    completionRefusal,
    type EvidenceRow,
    type RecordedEvidence,
    REFUSAL_GATES_NONE,
    REFUSAL_GATES_NOT_PASSED,
    REFUSAL_GATES_UNMEASURED,
    REFUSAL_REVIEW_INCOMPLETE,
    REFUSAL_REVIEW_MISSING,
    REFUSAL_REVIEW_REJECTED,
    REFUSAL_REVIEW_UNAVAILABLE,
    REFUSAL_STALE,
    reviewEvidenceOf,
} from '../src/db/evidence-policy.js';
import {
    REVIEW_BLOCKERS_MARKER,
    REVIEW_VERDICT_MARKER,
    type WorkflowDefinition,
} from '../src/db/workflow-templates.js';
import * as driverPolicy from '../../driver/src/evidence-policy.js';

const graph = (reviewer: boolean): WorkflowDefinition =>
    ({
        entry: 'work',
        nodes: [
            { name: 'work', kind: 'agent', session: 'resume', prompt: 'p' },
            { name: 'review', kind: 'agent', session: 'fresh', prompt: 'p', ...(reviewer ? { review: true } : {}) },
            { name: 'publish', kind: 'agent', session: 'resume', prompt: 'p', publish: true },
        ],
        edges: [],
    }) as unknown as WorkflowDefinition;

const evidence = (over: Partial<RecordedEvidence> = {}): RecordedEvidence => ({
    treeBefore: 'r1',
    treeAfter: 'r1',
    gates: 'passed',
    ...over,
});

const reviewRow = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
    node: 'review',
    status: 'succeeded',
    output: `looks fine\n${REVIEW_VERDICT_MARKER}`,
    evidence: evidence(),
    ...over,
});

describe('reviewEvidenceOf', () => {
    it('is unavailable — distinct from missing — when the graph has no reviewer, or no graph at all', () => {
        expect(reviewEvidenceOf(graph(false), [reviewRow()])).toEqual({ state: 'unavailable' });
        expect(reviewEvidenceOf(null, [])).toEqual({ state: 'unavailable' });
    });

    it('is missing when a reviewer exists and none has run', () => {
        expect(reviewEvidenceOf(graph(true), [{ ...reviewRow(), node: 'work' }])).toEqual({ state: 'missing' });
    });

    it('approves only a succeeded clean row, bound to the tree it started from', () => {
        const rows = [reviewRow({ evidence: evidence({ treeBefore: 'r9' }) })];
        expect(reviewEvidenceOf(graph(true), rows)).toEqual({ state: 'approved', revision: 'r9' });
    });

    it.each(['queued', 'running', 'failed', 'dead', 'stopped'])('never approves a %s review', (status) => {
        expect(reviewEvidenceOf(graph(true), [reviewRow({ status })])).toEqual({ state: 'incomplete' });
    });

    it('treats a clean row without the marker, or without a recorded tree, as incomplete', () => {
        expect(reviewEvidenceOf(graph(true), [reviewRow({ output: 'all good' })])).toEqual({ state: 'incomplete' });
        expect(reviewEvidenceOf(graph(true), [reviewRow({ evidence: null })])).toEqual({ state: 'incomplete' });
    });

    it('rejects a review that found blockers', () => {
        const output = `bad\n${REVIEW_BLOCKERS_MARKER}`;
        expect(reviewEvidenceOf(graph(true), [reviewRow({ output })])).toEqual({ state: 'rejected' });
    });

    it('lets the LATEST review row decide', () => {
        const later = reviewRow({ status: 'running', output: null });
        expect(reviewEvidenceOf(graph(true), [reviewRow(), later])).toEqual({ state: 'incomplete' });
        const rejected = reviewRow({ output: `x\n${REVIEW_BLOCKERS_MARKER}` });
        expect(reviewEvidenceOf(graph(true), [rejected, reviewRow()])).toEqual({ state: 'approved', revision: 'r1' });
    });
});

/** A row of a named-profile review (issue #549): bound to the revision the caller asked about. */
const profileRow = (over: Partial<EvidenceRow> = {}): EvidenceRow => ({
    node: null,
    status: 'succeeded',
    output: `all clear\n${REVIEW_VERDICT_MARKER}`,
    evidence: null,
    reviewProfile: true,
    reviewRevision: 'r1',
    ...over,
});

describe('reviewEvidenceOf with named reviewer profiles', () => {
    it('stays unavailable with no graph reviewer, no declared profile and no profile row', () => {
        expect(reviewEvidenceOf(null, [], false)).toEqual({ state: 'unavailable' });
    });

    it('is missing when profiles are declared and none has run, even on a thread with no graph', () => {
        expect(reviewEvidenceOf(null, [], true)).toEqual({ state: 'missing' });
    });

    it('approves a clean profile row at the revision it was asked about, not the reviewer’s own tree', () => {
        const row = profileRow({ evidence: evidence({ treeBefore: 'snapshot-head' }), reviewRevision: 'r7' });
        expect(reviewEvidenceOf(null, [row], true)).toEqual({ state: 'approved', revision: 'r7' });
    });

    it.each(['queued', 'running', 'failed', 'dead', 'stopped'])('never approves a %s profile review', (status) => {
        expect(reviewEvidenceOf(null, [profileRow({ status })], true)).toEqual({ state: 'incomplete' });
    });

    it('treats a marker-less row, or one with no revision, as incomplete, and blockers as rejected', () => {
        expect(reviewEvidenceOf(null, [profileRow({ output: 'fine' })], true)).toEqual({ state: 'incomplete' });
        expect(reviewEvidenceOf(null, [profileRow({ reviewRevision: null })], true)).toEqual({ state: 'incomplete' });
        const output = `bad\n${REVIEW_BLOCKERS_MARKER}`;
        expect(reviewEvidenceOf(null, [profileRow({ output })], true)).toEqual({ state: 'rejected' });
    });

    it('lets the latest review row decide across graph and profile rows alike', () => {
        const running = profileRow({ status: 'running', output: null });
        expect(reviewEvidenceOf(null, [profileRow(), running], true)).toEqual({ state: 'incomplete' });
        expect(reviewEvidenceOf(null, [running, profileRow()], true)).toEqual({ state: 'approved', revision: 'r1' });
    });

    it('cannot satisfy a required review once the work moved past the reviewed revision', () => {
        const review = reviewEvidenceOf(null, [profileRow({ reviewRevision: 'old' })], true);
        expect(completionRefusal({ review: true }, evidence({ treeAfter: 'new' }), review)).toBe(REFUSAL_STALE);
    });
});

describe('completionRefusal', () => {
    const approved = { state: 'approved', revision: 'r1' } as const;

    it('requires nothing without a policy', () => {
        expect(completionRefusal(null, null, { state: 'unavailable' })).toBeNull();
        expect(completionRefusal({}, null, { state: 'unavailable' })).toBeNull();
    });

    it.each([
        ['no record', null, REFUSAL_GATES_NONE],
        ['no gates ran', evidence({ gates: 'none' }), REFUSAL_GATES_NONE],
        ['a failed gate', evidence({ gates: 'failed' }), REFUSAL_GATES_NOT_PASSED],
        ['an incomplete gate run', evidence({ gates: 'incomplete' }), REFUSAL_GATES_NOT_PASSED],
        ['an unmeasured tree', evidence({ treeAfter: null }), REFUSAL_GATES_UNMEASURED],
    ])('refuses required gates over %s', (_name, recorded, reason) => {
        expect(completionRefusal({ gates: true }, recorded, approved)).toBe(reason);
    });

    it('accepts passed gates', () => {
        expect(completionRefusal({ gates: true }, evidence(), approved)).toBeNull();
    });

    it.each([
        ['unavailable', REFUSAL_REVIEW_UNAVAILABLE],
        ['missing', REFUSAL_REVIEW_MISSING],
        ['incomplete', REFUSAL_REVIEW_INCOMPLETE],
        ['rejected', REFUSAL_REVIEW_REJECTED],
    ] as const)('refuses a required review that is %s', (state, reason) => {
        expect(completionRefusal({ review: true }, evidence(), { state })).toBe(reason);
    });

    it('refuses an approval of a revision the work has moved past', () => {
        const moved = evidence({ treeBefore: 'r2', treeAfter: 'r2' });
        expect(completionRefusal({ gates: true, review: true }, moved, approved)).toBe(REFUSAL_STALE);
        expect(completionRefusal({ review: true }, evidence({ treeAfter: null, treeBefore: 'r2' }), approved)).toBe(
            REFUSAL_STALE
        );
    });

    it('accepts gates and a review over the same revision', () => {
        expect(completionRefusal({ gates: true, review: true }, evidence(), approved)).toBeNull();
    });
});

describe('the driver copy of the rules', () => {
    it('spells every refusal the same way', () => {
        expect(driverPolicy.REFUSAL_GATES_NONE).toBe(REFUSAL_GATES_NONE);
        expect(driverPolicy.REFUSAL_GATES_NOT_PASSED).toBe(REFUSAL_GATES_NOT_PASSED);
        expect(driverPolicy.REFUSAL_GATES_UNMEASURED).toBe(REFUSAL_GATES_UNMEASURED);
        expect(driverPolicy.REFUSAL_REVIEW_UNAVAILABLE).toBe(REFUSAL_REVIEW_UNAVAILABLE);
        expect(driverPolicy.REFUSAL_REVIEW_MISSING).toBe(REFUSAL_REVIEW_MISSING);
        expect(driverPolicy.REFUSAL_REVIEW_INCOMPLETE).toBe(REFUSAL_REVIEW_INCOMPLETE);
        expect(driverPolicy.REFUSAL_REVIEW_REJECTED).toBe(REFUSAL_REVIEW_REJECTED);
        expect(driverPolicy.REFUSAL_STALE).toBe(REFUSAL_STALE);
    });
});
