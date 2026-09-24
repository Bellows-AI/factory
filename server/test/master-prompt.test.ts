import { describe, expect, it } from 'vitest';
import {
    MASTER_PROMPT_LIMIT,
    MASTER_PROMPT_VERSION,
    type MasterPromptClaimInput,
    resolveMasterPrompt,
} from '../src/db/master-prompt.js';
import { COLLECT_HELPER_ID, REPLY_HELPER_ID } from '../src/db/workflow-blocks/github-review-reconcile.js';
import { PROBE_HELPER_ID } from '../src/db/workflow-blocks/merge-conflict-autofix.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';

const STANDALONE: MasterPromptClaimInput = {
    workflowNode: null,
    workflowName: null,
    snapshot: null,
    helperPlans: undefined,
};

const defaultSnapshot = (options: { review?: boolean; merge?: boolean } = {}): WorkflowDefinition => {
    const nodes: WorkflowDefinition['nodes'] = [
        { name: 'task', kind: 'agent', session: 'resume', publish: true, prompt: '{{command}}' },
    ];
    if (options.review) {
        nodes.push({
            name: 'review-reconciliation--collect',
            kind: 'agent',
            session: 'resume',
            gates: false,
            prompt: 'x',
            helperPlans: [{ helperId: COLLECT_HELPER_ID, phase: 'pre', githubWriting: true }],
        });
        nodes.push({
            name: 'review-reconciliation--wait',
            kind: 'agent',
            session: 'resume',
            gates: false,
            prompt: 'x',
            helperPlans: [{ helperId: COLLECT_HELPER_ID, phase: 'pre', githubWriting: true }],
            runtime: { runtime: 'pr-delivery-wait', block: 'builtin/github-review-reconcile', params: {} },
        });
        nodes.push({
            name: 'review-reconciliation--reply',
            kind: 'agent',
            session: 'resume',
            gates: false,
            prompt: 'x',
            helperPlans: [{ helperId: REPLY_HELPER_ID, phase: 'pre', githubWriting: true }],
        });
    }
    if (options.merge) {
        nodes.push({
            name: 'merge-conflict-autofix--repair',
            kind: 'agent',
            session: 'resume',
            gates: false,
            prompt: 'x',
            helperPlans: [{ helperId: PROBE_HELPER_ID, phase: 'pre', githubWriting: true }],
        });
    }
    return { entry: 'task', nodes, edges: [], params: [] };
};

describe('resolveMasterPrompt: standalone', () => {
    it('renders the standalone mode with gates and publish always on', () => {
        const prompt = resolveMasterPrompt(STANDALONE);
        expect(prompt).toBe(
            `Factory execution contract (${MASTER_PROMPT_VERSION})

Factory execution context
- Mode: standalone
- Factory-managed capabilities: declared gates, publish/reuse PR
- Your boundary: complete only the current task and return control.

Rules for this turn
- This is one agent turn inside a Factory-run process, not authority to run that process.
- Factory decides what happens next from this turn's verdict and final output.
- Factory runs every capability listed above; do not emulate any of them.
- Do not push, open, update, merge or close a pull request, enable auto-merge, comment on or reply to GitHub reviews, poll or wait for GitHub activity, or start the next workflow step.
- You may edit files, run tests and other local verification, and commit, as the current task requires; Factory still runs its declared gates afterwards.
- If the current task defines an exact output line or marker, end with exactly that line, then stop.`
        );
    });

    // A standalone thread's follow-up carries no signal that distinguishes it from the thread's
    // first run at all — workflow_name stays null on every row of a non-workflow thread, which is
    // the only thing MasterPromptClaimInput has to go on. There is nothing left to assert here
    // beyond what the render test above already pins.

    it('never contains a brace — the opencode template-substitution vector', () => {
        expect(resolveMasterPrompt(STANDALONE)).not.toMatch(/[{}]/);
    });
});

describe('resolveMasterPrompt: default workflow', () => {
    it('names only the enabled optional blocks — both excluded', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Mode: workflow');
        expect(prompt).toContain('- Workflow: default');
        expect(prompt).toContain('- Current node: task');
        expect(prompt).toContain('- Factory-managed capabilities: declared gates, publish/reuse PR');
        expect(prompt).not.toContain('review reconciliation');
        expect(prompt).not.toContain('merge-conflict repair');
    });

    it('names review reconciliation only when that block is selected', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'default',
            snapshot: defaultSnapshot({ review: true }),
            helperPlans: undefined,
        });
        expect(prompt).toContain('review reconciliation');
        expect(prompt).not.toContain('merge-conflict repair');
    });

    it('names merge-conflict repair only when that block is selected', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'default',
            snapshot: defaultSnapshot({ merge: true }),
            helperPlans: undefined,
        });
        expect(prompt).toContain('merge-conflict repair');
        expect(prompt).not.toContain('review reconciliation');
    });

    it('names both when both are selected, and names the durable wait the review block declares', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'default',
            snapshot: defaultSnapshot({ review: true, merge: true }),
            helperPlans: undefined,
        });
        expect(prompt).toContain('review reconciliation');
        expect(prompt).toContain('merge-conflict repair');
        expect(prompt).toContain('durable GitHub waits');
    });
});

describe('resolveMasterPrompt: base workflow (fix-issue)', () => {
    it('omits declared gates on a node that opts out (fetch-issue, review both carry gates: false)', () => {
        const snapshot: WorkflowDefinition = {
            entry: 'review',
            nodes: [
                { name: 'review', kind: 'agent', session: 'fresh', gates: false, prompt: 'x' },
                { name: 'publish', kind: 'agent', session: 'resume', publish: true, prompt: 'x' },
            ],
            edges: [],
            params: [],
        };
        const prompt = resolveMasterPrompt({
            workflowNode: 'review',
            workflowName: 'fix-issue',
            snapshot,
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Current node: review');
        // The fixed rules text below always mentions "declared gates" in prose ("Factory still
        // runs its declared gates afterwards") — the capability LINE is the thing under test.
        expect(prompt).toContain('- Factory-managed capabilities: publish/reuse PR\n');
    });
});

describe('resolveMasterPrompt: pre/post helper phases', () => {
    it('names pre-turn helper steps for this claim only', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: [{ helperId: 'some-helper', phase: 'pre', githubWriting: false, input: null }],
        });
        expect(prompt).toContain('pre-turn helper steps');
        expect(prompt).not.toContain('post-turn helper steps');
    });

    it('names post-turn helper steps for this claim only', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: [{ helperId: 'some-helper', phase: 'post', githubWriting: false, input: null }],
        });
        expect(prompt).toContain('post-turn helper steps');
        expect(prompt).not.toContain('pre-turn helper steps');
    });

    it('names an unrecognized helper id generically as board helper steps', () => {
        const snapshot: WorkflowDefinition = {
            entry: 'task',
            nodes: [
                {
                    name: 'task',
                    kind: 'agent',
                    session: 'resume',
                    prompt: 'x',
                    helperPlans: [{ helperId: 'a-future-block-helper', phase: 'pre', githubWriting: false }],
                },
            ],
            edges: [],
            params: [],
        };
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'custom',
            snapshot,
            helperPlans: undefined,
        });
        expect(prompt).toContain('board helper steps');
    });
});

describe('resolveMasterPrompt: member follow-up', () => {
    it('names the turn as a member follow-up when off-graph inside a workflow thread', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: null,
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Mode: workflow');
        expect(prompt).toContain('- Workflow: default');
        expect(prompt).toContain('- Turn: member follow-up');
        expect(prompt).not.toContain('Current node');
    });
});

describe('resolveMasterPrompt: fail-closed', () => {
    it('refuses (null) when a node claim carries no snapshot at all', () => {
        expect(
            resolveMasterPrompt({
                workflowNode: 'task',
                workflowName: 'default',
                snapshot: null,
                helperPlans: undefined,
            })
        ).toBeNull();
    });

    it('refuses (null) when the claimed node is missing from its own snapshot', () => {
        expect(
            resolveMasterPrompt({
                workflowNode: 'ghost-node',
                workflowName: 'default',
                snapshot: defaultSnapshot(),
                helperPlans: undefined,
            })
        ).toBeNull();
    });
});

describe('resolveMasterPrompt: workflow name safety', () => {
    it('withholds a workflow name that could inject opencode template syntax', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: '{env:GITHUB_TOKEN}',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Workflow: (custom workflow; name not shown)');
        expect(prompt).not.toMatch(/[{}]/);
    });

    it('withholds a 100-character junk name past the safe display shape', () => {
        const junk = `ok-but-then-${'*'.repeat(90)}`;
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: junk,
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Workflow: (custom workflow; name not shown)');
    });

    it('renders an ordinary workflow name verbatim', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'fix-issue (v2) #9',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Workflow: fix-issue (v2) #9');
    });
});

describe('resolveMasterPrompt: content boundaries', () => {
    it('never contains job.command, prior output, or env-shaped content', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            workflowName: 'default',
            snapshot: defaultSnapshot({ review: true, merge: true }),
            helperPlans: [{ helperId: 'x', phase: 'pre', githubWriting: false, input: { secret: 'nope' } }],
        }) as string;
        expect(prompt).not.toContain('secret');
        expect(prompt).not.toContain('nope');
        expect(prompt.length).toBeLessThanOrEqual(MASTER_PROMPT_LIMIT);
    });
});
