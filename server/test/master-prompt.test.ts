import { OBJECTIVE_MODE, WORKFLOW_MODE } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import {
    MASTER_PROMPT_LIMIT,
    MASTER_PROMPT_VERSION,
    type MasterPromptClaimInput,
    resolveMasterPrompt,
    resolveTurnContext,
} from '../src/db/master-prompt.js';
import { COLLECT_HELPER_ID, REPLY_HELPER_ID } from '../src/db/workflow-blocks/github-review-reconcile.js';
import { PROBE_HELPER_ID } from '../src/db/workflow-blocks/merge-conflict-autofix.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';

const OBJECTIVE: MasterPromptClaimInput = {
    mode: OBJECTIVE_MODE,
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

describe('resolveMasterPrompt: objective', () => {
    it('renders the objective mode with no per-turn values', () => {
        const prompt = resolveMasterPrompt(OBJECTIVE);
        expect(MASTER_PROMPT_VERSION).toBe('factory-master-prompt/v4');
        expect(prompt).toBe(
            `Factory execution contract (${MASTER_PROMPT_VERSION})

Factory execution context
- Mode: objective
- Your boundary: complete only the current task and return control.

Rules for this turn
- This is one agent turn inside a Factory-run process, not authority to run that process.
- Factory decides what happens next from this turn's verdict and final output.
- Factory runs every capability this turn's Factory turn context lists; do not emulate any of them.
- Do not push, open, update, merge or close a pull request, enable auto-merge, comment on or reply to GitHub reviews, poll or wait for GitHub activity, or start the next workflow step.
- You may edit files, run tests and other local verification, and commit, as the current task requires; Factory still runs its declared gates afterwards.
- If the current task defines an exact output line or marker, end with exactly that line, then stop.
- If you cannot proceed for a reason outside the repository (missing credentials, no access, an unreachable service), end your final message with the line FACTORY_BLOCKED: <one-line reason>, then stop.`
        );
    });

    it('never contains a brace — the opencode template-substitution vector', () => {
        expect(resolveMasterPrompt(OBJECTIVE)).not.toMatch(/[{}]/);
        expect(resolveMasterPrompt({ ...OBJECTIVE, skills: ['github', 'jira'] })).not.toMatch(/[{}]/);
    });
});

describe('resolveMasterPrompt: selected skills', () => {
    it('names the selection and says a skill grants nothing', () => {
        const prompt = resolveMasterPrompt({ ...OBJECTIVE, skills: ['github', 'jira'] });
        expect(prompt).toContain('- Selected skills: github, jira');
        expect(prompt).toContain('a skill grants no access beyond what this task already has');
    });

    it('renders no skills line when none are selected, absent or empty alike', () => {
        expect(resolveMasterPrompt(OBJECTIVE)).not.toContain('Selected skills');
        expect(resolveMasterPrompt({ ...OBJECTIVE, skills: [] })).toBe(resolveMasterPrompt(OBJECTIVE));
    });

    it('is byte-identical on every claim of a thread', () => {
        const input = { ...OBJECTIVE, skills: ['gates'] };
        expect(resolveMasterPrompt({ ...input })).toBe(resolveMasterPrompt({ ...input }));
    });

    it('stays inside the character cap with every shipped skill selected', () => {
        const prompt = resolveMasterPrompt({ ...OBJECTIVE, skills: ['backend-fix', 'gates', 'github', 'jira'] });
        expect(prompt).not.toBeNull();
    });
});

describe('resolveMasterPrompt: stable across a thread', () => {
    // The prompt rides the system prompt, which precedes the conversation: any byte that differs
    // between two claims of one thread re-writes the resumed session's whole history to cache.
    it('is byte-identical on every claim of one workflow thread', () => {
        const snapshot = defaultSnapshot({ review: true, merge: true });
        const claims: MasterPromptClaimInput[] = [
            { workflowNode: 'task', mode: WORKFLOW_MODE, workflowName: 'default', snapshot, helperPlans: undefined },
            {
                workflowNode: 'merge-conflict-autofix--repair',
                mode: WORKFLOW_MODE,
                workflowName: 'default',
                snapshot,
                helperPlans: [{ helperId: PROBE_HELPER_ID, phase: 'pre', githubWriting: true, input: null }],
            },
            {
                workflowNode: 'review-reconciliation--collect',
                mode: WORKFLOW_MODE,
                workflowName: 'default',
                snapshot,
                helperPlans: undefined,
            },
            { workflowNode: null, mode: WORKFLOW_MODE, workflowName: 'default', snapshot, helperPlans: undefined },
        ];
        const prompts = claims.map(resolveMasterPrompt);
        for (const prompt of prompts) {
            expect(prompt).toBe(prompts[0]);
            expect(prompt).not.toContain('Current node');
            expect(prompt).not.toContain('Factory-managed capabilities');
            expect(prompt).not.toContain('run only the tests');
        }
    });
});

describe('resolveTurnContext: objective', () => {
    it('renders gates and publish always on, with the targeted-test rule', () => {
        expect(resolveTurnContext(OBJECTIVE)).toBe(
            `Factory turn context
- Factory-managed capabilities: declared gates, publish/reuse PR
- The declared gates run the full test suite after your turn; run only the tests that cover what you changed, not the full suite.`
        );
    });
});

describe('resolveTurnContext: targeted-test rule', () => {
    it('tells a gated workflow node the gates run the full suite', () => {
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('The declared gates run the full test suite after your turn');
    });
});

describe('resolveTurnContext: default workflow', () => {
    it('names only the enabled optional blocks — both excluded', () => {
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Current node: task');
        expect(prompt).toContain('- Factory-managed capabilities: declared gates, publish/reuse PR');
        expect(prompt).not.toContain('review reconciliation');
        expect(prompt).not.toContain('merge-conflict repair');
    });

    it('names review reconciliation only when that block is selected', () => {
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot({ review: true }),
            helperPlans: undefined,
        });
        expect(prompt).toContain('review reconciliation');
        expect(prompt).not.toContain('merge-conflict repair');
    });

    it('names merge-conflict repair only when that block is selected', () => {
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot({ merge: true }),
            helperPlans: undefined,
        });
        expect(prompt).toContain('merge-conflict repair');
        expect(prompt).not.toContain('review reconciliation');
    });

    it('names both when both are selected, and names the durable wait the review block declares', () => {
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot({ review: true, merge: true }),
            helperPlans: undefined,
        });
        expect(prompt).toContain('review reconciliation');
        expect(prompt).toContain('merge-conflict repair');
        expect(prompt).toContain('durable GitHub waits');
    });
});

describe('resolveTurnContext: base workflow (fix-issue)', () => {
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
        const prompt = resolveTurnContext({
            workflowNode: 'review',
            mode: WORKFLOW_MODE,
            workflowName: 'fix-issue',
            snapshot,
            helperPlans: undefined,
        });
        expect(prompt).toBe(
            'Factory turn context\n- Current node: review\n- Factory-managed capabilities: publish/reuse PR'
        );
    });
});

describe('resolveTurnContext: pre/post helper phases', () => {
    it('names pre-turn helper steps for this claim only', () => {
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: [{ helperId: 'some-helper', phase: 'pre', githubWriting: false, input: null }],
        });
        expect(prompt).toContain('pre-turn helper steps');
        expect(prompt).not.toContain('post-turn helper steps');
    });

    it('names post-turn helper steps for this claim only', () => {
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
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
        const prompt = resolveTurnContext({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'custom',
            snapshot,
            helperPlans: undefined,
        });
        expect(prompt).toContain('board helper steps');
    });
});

describe('resolveTurnContext: member follow-up', () => {
    it('names the turn as a member follow-up when off-graph inside a workflow thread', () => {
        const prompt = resolveTurnContext({
            workflowNode: null,
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Turn: member follow-up');
        expect(prompt).not.toContain('Current node');
    });
});

describe.each([
    ['resolveMasterPrompt', resolveMasterPrompt],
    ['resolveTurnContext', resolveTurnContext],
])('%s: fail-closed', (_name, resolve) => {
    it('refuses (null) when a node claim carries no snapshot at all', () => {
        expect(
            resolve({
                workflowNode: 'task',
                mode: WORKFLOW_MODE,
                workflowName: 'default',
                snapshot: null,
                helperPlans: undefined,
            })
        ).toBeNull();
    });

    it('refuses (null) when the claimed node is missing from its own snapshot', () => {
        expect(
            resolve({
                workflowNode: 'ghost-node',
                mode: WORKFLOW_MODE,
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
            mode: WORKFLOW_MODE,
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
            mode: WORKFLOW_MODE,
            workflowName: junk,
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Workflow: (custom workflow; name not shown)');
    });

    it('names the mode and workflow on a workflow claim', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Mode: workflow');
        expect(prompt).toContain('- Workflow: default');
    });

    it('renders an ordinary workflow name verbatim', () => {
        const prompt = resolveMasterPrompt({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'fix-issue (v2) #9',
            snapshot: defaultSnapshot(),
            helperPlans: undefined,
        });
        expect(prompt).toContain('- Workflow: fix-issue (v2) #9');
    });
});

describe.each([
    ['resolveMasterPrompt', resolveMasterPrompt],
    ['resolveTurnContext', resolveTurnContext],
])('%s: content boundaries', (_name, resolve) => {
    it('never contains job.command, prior output, or env-shaped content', () => {
        const prompt = resolve({
            workflowNode: 'task',
            mode: WORKFLOW_MODE,
            workflowName: 'default',
            snapshot: defaultSnapshot({ review: true, merge: true }),
            helperPlans: [{ helperId: 'x', phase: 'pre', githubWriting: false, input: { secret: 'nope' } }],
        }) as string;
        expect(prompt).not.toContain('secret');
        expect(prompt).not.toContain('nope');
        expect(prompt.length).toBeLessThanOrEqual(MASTER_PROMPT_LIMIT);
    });
});
