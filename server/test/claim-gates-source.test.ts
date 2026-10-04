import { describe, expect, it } from 'vitest';
import { resolveClaimPublish } from '../src/db/job-store-claim.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';

const definition: WorkflowDefinition = {
    entry: 'review',
    params: [],
    nodes: [
        { name: 'review', kind: 'agent', session: 'fresh', gates: false, prompt: 'review' },
        { name: 'fix', kind: 'agent', session: 'resume', publish: true, prompt: 'fix' },
    ],
    edges: [{ from: 'review', to: 'fix', when: { marker: 'CHANGES' } }],
};

const read = {
    claimGates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
    gateError: null,
    gatesSource: 'clone' as const,
};

// Issue #444: the gates source rides with the gates — a node that opts out of the gates carries
// neither, so the driver never refuses a gate-less run over a stale gates read.
describe('resolveClaimPublish: the gates source', () => {
    it('drops the source with the gates on a node that opts out of them', () => {
        expect(resolveClaimPublish(definition, 'review', read)).toEqual({
            publish: false,
            claimGates: null,
            gateError: null,
            gatesSource: null,
        });
    });

    it('keeps the source on a gated node and on a workflow-less claim', () => {
        expect(resolveClaimPublish(definition, 'fix', read).gatesSource).toBe('clone');
        expect(resolveClaimPublish(null, null, read).gatesSource).toBe('clone');
    });
});
