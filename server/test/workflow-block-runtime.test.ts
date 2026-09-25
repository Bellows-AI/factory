import { describe, expect, it } from 'vitest';
import { isBlockRuntimeId, parseRuntimeParams, runtimeIsValid } from '../src/db/workflow-blocks/runtime.js';
import type { WorkflowNode } from '../src/db/workflow-schema.js';

/**
 * The runtime dispatcher's pure half (issue #231): the allowlist and the params parser, exercised
 * with no database and no compiler in the loop. `workflow-block-compiler.test.ts` covers how a
 * block's expansion attaches this onto a node; `job-store.block-wait.test.ts` covers the
 * transactional park/wake behavior against a real database.
 */

const agentNode = (overrides: Partial<WorkflowNode> = {}): WorkflowNode => ({
    name: 'wait',
    kind: 'agent',
    session: 'resume',
    prompt: 'x',
    ...overrides,
});

describe('isBlockRuntimeId', () => {
    it('accepts the one shipped runtime id', () => {
        expect(isBlockRuntimeId('pr-delivery-wait')).toBe(true);
    });

    it('refuses an unregistered id', () => {
        expect(isBlockRuntimeId('some-other-runtime')).toBe(false);
        expect(isBlockRuntimeId('')).toBe(false);
    });
});

describe('parseRuntimeParams', () => {
    it('accepts pr-delivery-wait with no params', () => {
        expect(parseRuntimeParams('pr-delivery-wait', {})).toEqual({});
    });

    it('refuses pr-delivery-wait with any declared param — it takes none', () => {
        expect(parseRuntimeParams('pr-delivery-wait', { reason: 'review' })).toBeNull();
    });

    it('refuses an unknown runtime id outright', () => {
        expect(parseRuntimeParams('not-a-real-runtime', {})).toBeNull();
    });
});

describe('runtimeIsValid', () => {
    it('is false for an ordinary node with no runtime at all', () => {
        expect(runtimeIsValid(agentNode())).toBe(false);
    });

    it('is true for a node carrying the one valid runtime descriptor', () => {
        const node = agentNode({ runtime: { runtime: 'pr-delivery-wait', block: 'fake/echo', params: {} } });
        expect(runtimeIsValid(node)).toBe(true);
    });

    it('is false for a node naming an unknown runtime id — never falls back to treating it as ordinary', () => {
        const node = agentNode({ runtime: { runtime: 'not-a-real-runtime', block: 'fake/echo', params: {} } });
        expect(runtimeIsValid(node)).toBe(false);
    });

    it('is false when the declared params do not match the runtime’s own shape', () => {
        const node = agentNode({
            runtime: { runtime: 'pr-delivery-wait', block: 'fake/echo', params: { extra: 'nope' } },
        });
        expect(runtimeIsValid(node)).toBe(false);
    });
});
