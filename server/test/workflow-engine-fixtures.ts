import type { GateReport } from '../src/db/job-store-contract.js';
import type { CompletedRun, EngineRow } from '../src/db/workflow-engine.js';

/**
 * Shared fixtures for the workflow-engine test suite, split across
 * workflow-engine.next-transition.test.ts, workflow-engine.walkthrough.test.ts,
 * workflow-engine.validation.test.ts and workflow-engine.params.test.ts.
 */

export const snapshot = {
    entry: 'implement',
    nodes: [
        {
            name: 'implement',
            kind: 'agent' as const,
            session: 'resume' as const,
            prompt: 'work {{fetch-issue.output}}',
        },
        { name: 'review', kind: 'agent' as const, session: 'fresh' as const, prompt: 'review', publish: false },
        {
            name: 'fix',
            kind: 'agent' as const,
            session: 'resume' as const,
            prompt: 'fix these: {{review.output}} gate {{gate.name}} said {{gate.output}}',
        },
        { name: 'publish', kind: 'agent' as const, session: 'resume' as const, prompt: 'preflight', publish: true },
    ],
    edges: [
        { from: 'implement', to: 'review', when: 'succeeded' as const, max: 3 },
        { from: 'implement', to: 'fix', when: 'gate-failed' as const },
        { from: 'review', to: 'fix', when: { marker: 'VERDICT: BLOCKERS' } },
        { from: 'review', to: 'publish', when: { marker: 'VERDICT: CLEAN' } },
        { from: 'fix', to: 'review', when: 'succeeded' as const },
    ],
};

export const row = (over: Partial<EngineRow> = {}): EngineRow => ({
    id: over.id ?? 'r1',
    node: over.node ?? null,
    status: over.status ?? 'succeeded',
    output: over.output ?? null,
    gates: over.gates ?? null,
    sessionId: over.sessionId ?? null,
});

export const done = (over: Partial<CompletedRun> = {}): CompletedRun => ({
    id: 'r1',
    node: 'implement',
    status: 'succeeded',
    output: null,
    gates: null,
    ...over,
});

export const gate = (
    name: string,
    status: GateReport['status'],
    exitCode: number | null,
    output: string | null = null
): GateReport => ({
    name,
    status,
    exitCode,
    output,
});
