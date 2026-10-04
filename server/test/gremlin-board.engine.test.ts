import { describe, expect, it } from 'vitest';
import { compileDefaultWorkflow, DEFAULT_ENTRY_NODE, DEFAULT_GATE_FIX_NODE } from '../src/db/default-workflow.js';
import { nextTransition, type EngineRow } from '../src/db/workflow-engine.js';
import { validateCompleteFields } from '../src/routes/job-field-validation.js';

/**
 * Gremlin (board) repros: each `it` asserts the CORRECT behaviour and fails against aae311d.
 */
const BOTH = { reviewReconciliation: true, mergeConflictAutofix: true };
const failedGate = (output: string): EngineRow['gates'] => [{ name: 'test', status: 'failed', exitCode: 1, output }];

describe('gremlin board — engine', () => {
    // G1: gate-failed ignores the verdict's failureKind. The stored `gates` column can hold a
    // PREVIOUS attempt's failed report (claim never clears it, the driver never reports when it
    // skips gates), so a `services`/`timeout`/`runner_error` verdict still queues a gate-fix.
    it.each(['services', 'timeout', 'runner_error', 'cache_lost'] as const)(
        'a %s verdict carrying a failed gate report does not queue gate-fix',
        (failureKind) => {
            const definition = compileDefaultWorkflow(BOTH, 3);
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
                snapshot: definition,
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

    // G4: a dead service on the review-repair node spends a repair round through the `failed`
    // self-edge — exactly the waste the PR's `services` verdict exists to prevent on gate-fix.
    it('a services verdict on review repair does not spend a repair round', () => {
        const definition = compileDefaultWorkflow(BOTH, 3);
        const repair = 'review-reconciliation--repair';
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
            { id: 'c', node: repair, status: 'failed', output: null, gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do it',
            rows,
            completed: {
                id: 'c',
                node: repair,
                status: 'failed',
                output: 'svc dead',
                gates: null,
                failureKind: 'services',
            },
        });
        expect(transition.action).toBe('rest');
    });

    // G3 (engine half): an off-graph follow-up completing while the thread's newest carried row is
    // a QUEUED, never-run graph row halts "at" that row and inserts another one — a fork.
    it('a follow-up completing while a gate-fix row is still queued does not queue a second gate-fix', () => {
        const definition = compileDefaultWorkflow(BOTH, 3);
        const rows: EngineRow[] = [
            {
                id: 'a',
                node: DEFAULT_ENTRY_NODE,
                status: 'failed',
                output: null,
                gates: failedGate('1'),
                sessionId: 's',
            },
            { id: 'g1', node: DEFAULT_GATE_FIX_NODE, status: 'queued', output: null, gates: null, sessionId: 's' },
            { id: 'f', node: null, status: 'failed', output: null, gates: failedGate('2'), sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do it',
            rows,
            completed: {
                id: 'f',
                node: null,
                status: 'failed',
                output: null,
                gates: failedGate('2'),
                failureKind: 'gate',
                treeChanged: true,
            },
        });
        expect(transition.action).toBe('rest');
    });

    // G5: a marker edge matches a FAILED run — a merge repair that printed MERGE-RESOLVED and
    // then exited non-zero (runner_error appends no driver note) advances to verify.
    it('a failed runner_error run whose tail is a marker does not advance on the marker edge', () => {
        const definition = compileDefaultWorkflow({ reviewReconciliation: false, mergeConflictAutofix: true }, 3);
        const repair = 'merge-conflict-autofix--repair';
        const rows: EngineRow[] = [
            { id: 'a', node: DEFAULT_ENTRY_NODE, status: 'succeeded', output: 'ok', gates: null, sessionId: 's' },
            { id: 'b', node: repair, status: 'failed', output: null, gates: null, sessionId: 's' },
        ];
        const transition = nextTransition({
            snapshot: definition,
            params: {},
            command: 'do it',
            rows,
            completed: {
                id: 'b',
                node: repair,
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

describe('gremlin board — complete payload', () => {
    // G6: status and failureKind are never cross-checked: a `succeeded` verdict may carry
    // `blocked` (resting the thread) or `gate`.
    it.each(['blocked', 'gate', 'services'])('refuses status succeeded with failureKind %s', (failureKind) => {
        expect(validateCompleteFields({ status: 'succeeded', exitCode: 0, failureKind }).ok).toBe(false);
    });
});
