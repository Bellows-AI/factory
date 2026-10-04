import { describe, expect, it } from 'vitest';
import { compileDefaultWorkflow, DEFAULT_ENTRY_NODE } from '../src/db/default-workflow.js';
import { nextTransition, type EngineRow } from '../src/db/workflow-engine.js';

/** Edges fire on the run's own verdict, never on stale gates, a failed run's marker, or a dead service (#428). */
const BOTH = { reviewReconciliation: true, mergeConflictAutofix: true };
const failedGate = (output: string): EngineRow['gates'] => [{ name: 'test', status: 'failed', exitCode: 1, output }];
const REPAIR = 'review-reconciliation--repair';
const MERGE_REPAIR = 'merge-conflict-autofix--repair';

describe('nextTransition: edge evidence', () => {
    it.each(['services', 'timeout', 'runner_error', 'cache_lost'] as const)(
        'a %s verdict carrying a failed gate report does not queue gate-fix',
        (failureKind) => {
            const rows: EngineRow[] = [
                {
                    id: 'a',
                    node: DEFAULT_ENTRY_NODE,
                    status: 'failed',
                    output: null,
                    gates: failedGate('stale'),
                    sessionId: 's',
                },
            ];
            const transition = nextTransition({
                snapshot: compileDefaultWorkflow(BOTH, 3),
                params: {},
                command: 'do it',
                rows,
                completed: {
                    id: 'a',
                    node: DEFAULT_ENTRY_NODE,
                    status: 'failed',
                    output: 'x',
                    gates: failedGate('stale'),
                    failureKind,
                    treeChanged: null,
                },
            });
            expect(transition.action).toBe('rest');
        }
    );

    it.each(['services', 'publish'] as const)(
        'a %s verdict on review repair rests without spending a round',
        (kind) => {
            const rows: EngineRow[] = [
                { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'ok', gates: null, sessionId: 's' },
                {
                    id: 'b',
                    node: 'review-reconciliation--collect',
                    status: 'succeeded',
                    output: 'REVIEW-ACTIONABLE',
                    gates: null,
                    sessionId: 's',
                },
                { id: 'c', node: REPAIR, status: 'failed', output: null, gates: null, sessionId: 's' },
            ];
            const transition = nextTransition({
                snapshot: compileDefaultWorkflow(BOTH, 3),
                params: {},
                command: 'do it',
                rows,
                completed: { id: 'c', node: REPAIR, status: 'failed', output: 'dead', gates: null, failureKind: kind },
            });
            expect(transition).toEqual({ action: 'rest', reason: kind });
        }
    );

    it('a failed run whose tail is a marker does not advance on the marker edge', () => {
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'ok', gates: null, sessionId: 's' },
            { id: 'b', node: MERGE_REPAIR, status: 'failed', output: null, gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true }, 3),
            params: {},
            command: 'do it',
            rows,
            completed: {
                id: 'b',
                node: MERGE_REPAIR,
                status: 'failed',
                output: 'half done\nMERGE-RESOLVED',
                gates: null,
                failureKind: 'runner_error',
            },
        });
        expect(transition.action === 'insert' ? transition.node.name : 'rest').not.toBe(
            'merge-conflict-autofix--verify'
        );
    });
});
