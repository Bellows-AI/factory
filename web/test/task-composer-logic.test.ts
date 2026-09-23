import { describe, expect, it } from 'vitest';
import {
    type WorkflowParamChoice,
    defaultWorkflowPayload,
    defaultWorkflowStepSummary,
    effectiveDefaultSteps,
    effectiveWorkflows,
    freshWorkflowDraft,
    humanizeParamName,
    markTouched,
    paramFieldVerdict,
    paramsComplete,
    preflightSentence,
    queueBody,
    startBlocker,
    toggleDefaultStep,
    touchAll,
    valuesForWorkflow,
} from '../src/task-composer.js';

describe('composer params are scoped to the chosen workflow identity', () => {
    // The review's leak: `#12` typed for one workflow stays valid when a repo switch refetches
    // the list and a DIFFERENT same-named definition resolves — zero select interactions — and
    // Send launches the other process with the first one's issue. Values are stored against the
    // identity of the workflow they were typed for, and read back only while it is still chosen.
    const issue: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };

    it('hands values back only while the workflow they were typed for is still chosen', () => {
        const stored = { workflowId: 'wf-repo-a', values: { issue: '#12' } };
        expect(valuesForWorkflow(stored, 'wf-repo-a')).toEqual({ issue: '#12' });
        // Repo B's same-named definition is a DIFFERENT row: the typed value must vanish from
        // the inputs and from the Send gate alike.
        expect(valuesForWorkflow(stored, 'wf-repo-b')).toEqual({});
        expect(paramsComplete([issue], valuesForWorkflow(stored, 'wf-repo-b'))).toBe(false);
    });

    it('answers empty when nothing is chosen, and stores nothing before any workflow is', () => {
        const stored = { workflowId: 'wf-1', values: { issue: '#12' } };
        expect(valuesForWorkflow(stored, null)).toEqual({});
        // The mount state: no workflow has ever been chosen, so nothing can leak anywhere.
        expect(valuesForWorkflow({ workflowId: null, values: {} }, 'wf-1')).toEqual({});
    });
});

describe('composer workflow draft resets on a repository change', () => {
    // The review's window: `useWorkflows` keeps the previous list while the new repository's
    // request is pending, the page hands that stale list straight through, and the chosen
    // workflow and its typed values survive the switch — Send can put repo A's workflow name and
    // A-typed values into a task stamped with repo B. The reset is keyed to the composer's own
    // repo state, so it covers every path a change arrives by: the member's select, the
    // autoselect, the clamp. Effects never run under renderToStaticMarkup, so what pins offline
    // is the exact state the reset leaves behind — the state Send reads through, with the stale
    // list's default still effective, which is exactly what is effective while the window is open.
    const issue: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };

    it('resets to the mount shape — unchosen workflow, no stored values, no touched fields, no default-step overrides — so the mount run is a no-op', () => {
        expect(freshWorkflowDraft()).toEqual({
            workflow: '',
            storedParams: { workflowId: null, values: {} },
            paramTouched: {},
            defaultStepOverrides: {},
        });
    });

    it('sends no workflow name and hands no values back for whatever the stale list still declares', () => {
        const reset = freshWorkflowDraft();
        // An empty choice travels as null: the board resolves its default for the NEW repository.
        expect(reset.workflow).toBe('');
        // The values typed against the old list are gone for ANY effective id; with them gone, a
        // workflow that declares params leaves Send dark — the member picks again and retypes.
        expect(valuesForWorkflow(reset.storedParams, 'wf-stale-default')).toEqual({});
        expect(paramsComplete([issue], valuesForWorkflow(reset.storedParams, 'wf-stale-default'))).toBe(false);
    });
});

describe('effectiveWorkflows', () => {
    // A name is unique per SCOPE only, so the visible list can hold the same name at several
    // scopes. The Listbox row a member clicks must be the definition the launch resolves, and
    // `chosenWorkflow` resolves a name with the board's repo-over-user-over-org precedence — so
    // the options carry one row per effective name, at the winning scope.
    const choice = (id: string, scope: 'org' | 'user' | 'repo') => ({ id, name: 'fix-issue', scope });

    it('collapses a name offered at several scopes to its repo-scoped definition', () => {
        const list = [choice('w-org', 'org'), choice('w-user', 'user'), choice('w-repo', 'repo')];
        expect(effectiveWorkflows(list)).toEqual([choice('w-repo', 'repo')]);
    });

    it('keeps each name at its own scope when the scopes differ', () => {
        const list = [
            { id: 'w1', name: 'fix-issue', scope: 'repo' as const },
            { id: 'w2', name: 'triage', scope: 'org' as const },
        ];
        expect(effectiveWorkflows(list)).toEqual(list);
    });

    it('falls through to user, then org, when no higher scope offers the name', () => {
        expect(effectiveWorkflows([choice('w-org', 'org'), choice('w-user', 'user')])).toEqual([
            choice('w-user', 'user'),
        ]);
        expect(effectiveWorkflows([choice('w-org', 'org'), choice('w-org2', 'org')])).toEqual([choice('w-org', 'org')]);
    });

    it('emits the winners in the order the list offered their names', () => {
        const list = [
            { id: 'w1', name: 'triage', scope: 'org' as const },
            { id: 'w2', name: 'fix-issue', scope: 'org' as const },
            { id: 'w3', name: 'fix-issue', scope: 'repo' as const },
        ];
        expect(effectiveWorkflows(list).map((c) => c.id)).toEqual(['w1', 'w3']);
    });
});

describe('humanizeParamName', () => {
    // The fallback label: an identifier a prompt author wrote for the machine, said in words the
    // composer can show a member.
    it('splits on separators and capitalizes each word', () => {
        expect(humanizeParamName('issue')).toBe('Issue');
        expect(humanizeParamName('issue_number')).toBe('Issue number');
        expect(humanizeParamName('bug-url')).toBe('Bug url');
        expect(humanizeParamName('pr_title_prefix')).toBe('Pr title prefix');
    });
});

describe('paramFieldVerdict — the per-field plain-language state', () => {
    const issue: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+' };
    const guided: WorkflowParamChoice = { name: 'issue', pattern: '#\\d+', description: 'Reference the issue.' };

    it('answers ok with no message for a value the board would accept', () => {
        expect(paramFieldVerdict(issue, ' #12 ', true)).toEqual({ kind: 'ok', message: null });
        expect(paramFieldVerdict({ name: 'notes' }, 'anything', false)).toEqual({ kind: 'ok', message: null });
    });

    it('says Required on an untouched empty field — a hint, not a failure', () => {
        expect(paramFieldVerdict(issue, undefined, false)).toEqual({ kind: 'untouched', message: null });
        expect(paramFieldVerdict(issue, '   ', false)).toEqual({ kind: 'untouched', message: null });
    });

    it('names a touched empty field as required, by its humanized label', () => {
        expect(paramFieldVerdict(issue, undefined, true)).toEqual({ kind: 'required', message: 'Issue is required.' });
        expect(paramFieldVerdict({ name: 'pr_title' }, '', true)).toEqual({
            kind: 'required',
            message: 'Pr title is required.',
        });
    });

    it('bounds the value at the length the board enforces', () => {
        const OVER_LIMIT_LENGTH = 513;
        const MAX_ALLOWED_LENGTH = 512;
        expect(paramFieldVerdict(issue, 'x'.repeat(OVER_LIMIT_LENGTH), false).kind).toBe('too-long');
        expect(paramFieldVerdict(issue, 'x'.repeat(OVER_LIMIT_LENGTH), false).message).toBe(
            'Issue must be 512 characters or fewer.'
        );
        expect(paramFieldVerdict(issue, 'x'.repeat(MAX_ALLOWED_LENGTH), false).kind).not.toBe('too-long');
    });

    it('reuses the author guidance as the mismatch error when the author wrote any', () => {
        expect(paramFieldVerdict(guided, 'nope', true)).toEqual({ kind: 'mismatch', message: 'Reference the issue.' });
    });

    it('falls back to plain-language mismatch copy that names the Format details', () => {
        expect(paramFieldVerdict(issue, 'nope', true)).toEqual({
            kind: 'mismatch',
            message: 'Issue does not match the required format. Open Format details for the technical rule.',
        });
    });

    it('blames the stored rule when the pattern itself cannot compile', () => {
        const verdict = paramFieldVerdict({ name: 'issue', pattern: '[' }, 'x', true);
        expect(verdict.kind).toBe('uncompilable');
        expect(verdict.message).toBe(
            "This workflow's format rule could not be checked. Ask an administrator to fix the workflow."
        );
    });

    it('never shows regex syntax in a message', () => {
        const OVER_LIMIT_LENGTH = 513;
        for (const value of [undefined, '', 'x'.repeat(OVER_LIMIT_LENGTH), 'nope']) {
            for (const touched of [false, true]) {
                const { message } = paramFieldVerdict(issue, value, touched);
                expect(message ?? '').not.toMatch(/\\d|\(\?:/);
            }
        }
    });

    it('agrees with the Send gate: every non-ok, non-untouched verdict is a value paramsComplete refuses', () => {
        const params = [issue, { name: 'notes' }];
        const values: Record<string, string> = { issue: '#12', notes: 'ok' };
        expect(paramsComplete(params, values)).toBe(true);
        const OVER_LIMIT_LENGTH = 513;
        for (const name of ['issue', 'notes'] as const) {
            for (const value of [undefined, '', '   ', 'x'.repeat(OVER_LIMIT_LENGTH), 'not matching']) {
                const verdict = paramFieldVerdict(params.find((param) => param.name === name)!, value, true);
                const broken = { ...values, [name]: value ?? '' };
                expect(verdict.kind === 'ok' || verdict.kind === 'untouched').toBe(paramsComplete(params, broken));
            }
        }
    });
});

describe('preflightSentence — what will actually run, before it runs', () => {
    it('says the repository, the executor and the workflow by their actual names', () => {
        expect(preflightSentence({ repo: 'acme/web', executor: 'main', workflow: 'fix-issue' })).toBe(
            'Will run in acme/web using main executor, with the fix-issue workflow.'
        );
    });

    it('says the prompt runs as written when no workflow is chosen', () => {
        expect(preflightSentence({ repo: 'acme/web', executor: 'main', workflow: null })).toBe(
            'Will run in acme/web using main executor. Your prompt will run as written.'
        );
    });

    it('states when execution is blocked on configuring an executor', () => {
        expect(preflightSentence({ repo: null, executor: null, workflow: null })).toBe(
            'Will run without a repository after you configure an executor. Your prompt will run as written.'
        );
        expect(preflightSentence({ repo: null, executor: 'heavy', workflow: 'triage' })).toBe(
            'Will run without a repository using heavy executor, with the triage workflow.'
        );
    });

    it('lists the final default-workflow step set once the saved settings have answered (#208)', () => {
        expect(
            preflightSentence({
                repo: 'acme/web',
                executor: 'main',
                workflow: null,
                defaultSteps: { reviewReconciliation: true, mergeConflictAutofix: false },
            })
        ).toBe(
            'Will run in acme/web using main executor. Default workflow selected: prompt, gates, publish, plus iterate on PR review comments.'
        );
    });

    it('keeps the old raw-prompt sentence while the default-workflow settings have not answered yet', () => {
        // defaultSteps omitted entirely — the option existed before #208 and stays true today:
        // an unresolved default-workflow choice still runs the raw prompt at the wire.
        expect(preflightSentence({ repo: 'acme/web', executor: 'main', workflow: null })).toBe(
            'Will run in acme/web using main executor. Your prompt will run as written.'
        );
    });
});

describe('DefaultWorkflowSteps — the effective set, its toggle, and its summary (#208)', () => {
    const bothOn = { reviewReconciliation: true, mergeConflictAutofix: true };
    const bothOff = { reviewReconciliation: false, mergeConflictAutofix: false };

    it('answers null before the saved settings have loaded', () => {
        expect(effectiveDefaultSteps(null, {})).toBeNull();
    });

    it('reads the saved value straight through with no override', () => {
        expect(effectiveDefaultSteps(bothOn, {})).toEqual(bothOn);
        expect(effectiveDefaultSteps(bothOff, {})).toEqual(bothOff);
    });

    it('lets an explicit override invert either field independently, in either direction', () => {
        expect(effectiveDefaultSteps(bothOn, { reviewReconciliation: false })).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
        });
        expect(effectiveDefaultSteps(bothOff, { mergeConflictAutofix: true })).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
        });
    });

    it('toggles one field from its EFFECTIVE value, landing back on an explicit choice, not absence', () => {
        let overrides = toggleDefaultStep({}, 'reviewReconciliation', bothOn);
        expect(effectiveDefaultSteps(bothOn, overrides)).toEqual({
            reviewReconciliation: false,
            mergeConflictAutofix: true,
        });
        overrides = toggleDefaultStep(overrides, 'reviewReconciliation', bothOn);
        expect(effectiveDefaultSteps(bothOn, overrides)).toEqual(bothOn);
    });

    it('leaves the untouched field alone when the other toggles', () => {
        const overrides = toggleDefaultStep({}, 'mergeConflictAutofix', bothOn);
        expect(overrides).toEqual({ mergeConflictAutofix: false });
    });

    it('sends the default-workflow pair only when Default workflow is chosen', () => {
        expect(defaultWorkflowPayload('', bothOn)).toEqual(bothOn);
        expect(defaultWorkflowPayload('fix-issue', bothOn)).toBeNull();
        expect(defaultWorkflowPayload('', null)).toBeNull();
    });

    it('summarizes the final step set, omitting steps that are off', () => {
        expect(defaultWorkflowStepSummary(bothOn)).toBe(
            'prompt, gates, publish, plus iterate on PR review comments and repair merge conflicts'
        );
        expect(defaultWorkflowStepSummary(bothOff)).toBe('prompt, gates, publish');
        expect(defaultWorkflowStepSummary({ reviewReconciliation: true, mergeConflictAutofix: false })).toBe(
            'prompt, gates, publish, plus iterate on PR review comments'
        );
        expect(defaultWorkflowStepSummary({ reviewReconciliation: false, mergeConflictAutofix: true })).toBe(
            'prompt, gates, publish, plus repair merge conflicts'
        );
    });
});

describe('startBlocker — the one reason Start is dark, in precedence order', () => {
    it('answers null only when nothing blocks the launch', () => {
        expect(
            startBlocker({ sending: false, executorMissing: false, promptEmpty: false, paramsInvalid: false })
        ).toBeNull();
    });

    it('puts the in-flight queue first, so a second click cannot double-send', () => {
        expect(startBlocker({ sending: true, executorMissing: true, promptEmpty: true, paramsInvalid: true })).toBe(
            'in-flight'
        );
    });

    it('requires an executor before the prompt and workflow details', () => {
        expect(startBlocker({ sending: false, executorMissing: true, promptEmpty: true, paramsInvalid: true })).toBe(
            'missing-executor'
        );
        expect(startBlocker({ sending: false, executorMissing: false, promptEmpty: true, paramsInvalid: true })).toBe(
            'empty-prompt'
        );
        expect(startBlocker({ sending: false, executorMissing: false, promptEmpty: false, paramsInvalid: true })).toBe(
            'invalid-params'
        );
    });

    it('blocks Start while Default workflow is chosen and the saved settings have not answered yet (#208 review)', () => {
        // A member must not be able to launch a Default-workflow task before the saved step
        // settings load — that silently omits the member's saved pair from the submitted JSON,
        // a real report from the PR review, not a hypothetical.
        expect(
            startBlocker({
                sending: false,
                executorMissing: false,
                promptEmpty: false,
                defaultsUnresolved: true,
                paramsInvalid: false,
            })
        ).toBe('defaults-unresolved');
        // Ranks after the prompt (an empty prompt is the missing task itself) and before a named
        // workflow's own field validation — the two can never actually co-occur (one requires the
        // unchosen '' workflow, the other a chosen one), but the order is still deterministic.
        expect(
            startBlocker({
                sending: false,
                executorMissing: false,
                promptEmpty: true,
                defaultsUnresolved: true,
                paramsInvalid: false,
            })
        ).toBe('empty-prompt');
    });

    it('omitting defaultsUnresolved answers exactly as before (#208 review) — no change for a named workflow', () => {
        expect(startBlocker({ sending: false, executorMissing: false, promptEmpty: false, paramsInvalid: true })).toBe(
            'invalid-params'
        );
    });
});

describe('the parameter touched-state model', () => {
    it('marks one field touched without disturbing the others', () => {
        expect(markTouched({}, 'issue')).toEqual({ issue: true });
        expect(markTouched({ notes: true }, 'issue')).toEqual({ notes: true, issue: true });
    });

    it('marks every field touched at once, for an invalid keyboard submission', () => {
        expect(touchAll(['issue', 'notes'])).toEqual({ issue: true, notes: true });
        expect(touchAll([])).toEqual({});
    });
});

describe('queueBody — the POST /api/jobs body, pure (#208)', () => {
    // The wire contract the issue's acceptance criteria name: "Preflight and submitted JSON
    // agree" and "Custom workflow selection sends no defaultWorkflow object" — pinned here so the
    // omission is a property of the body builder, not something a fetch mock has to observe.
    it('carries no defaultWorkflow key beside a named custom workflow', () => {
        const body = queueBody(
            {
                command: 'fix the bug',
                repo: 'acme/web',
                executor: 'main',
                workflow: 'fix-issue',
                workflowParams: { issue: '#12' },
            },
            null
        );
        expect(body).toEqual({
            command: 'fix the bug',
            repo: 'acme/web',
            executor: 'main',
            workflow: 'fix-issue',
            workflowParams: { issue: '#12' },
        });
        expect('defaultWorkflow' in body).toBe(false);
    });

    it('carries the effective step pair beside Default workflow', () => {
        const body = queueBody(
            { command: 'fix the bug', repo: 'acme/web', executor: 'main', workflow: null, workflowParams: null },
            { reviewReconciliation: true, mergeConflictAutofix: false }
        );
        expect(body).toEqual({
            command: 'fix the bug',
            repo: 'acme/web',
            executor: 'main',
            workflow: null,
            workflowParams: null,
            defaultWorkflow: { reviewReconciliation: true, mergeConflictAutofix: false },
        });
    });
});
