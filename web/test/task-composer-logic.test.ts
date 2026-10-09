import { COMMAND_LIMIT } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import type { ComposerDraftInput } from '../src/composer-draft.js';
import {
    type WorkflowParamChoice,
    blockerTone,
    commandCount,
    commandTooLong,
    draftIsFresh,
    initialComposerState,
    restoredDraftNotices,
    effectiveWorkflows,
    freshWorkflowDraft,
    humanizeParamName,
    markTouched,
    paramFieldVerdict,
    paramsComplete,
    repoReadiness,
    startBlocker,
    touchAll,
    valuesForWorkflow,
} from '../src/task-composer.js';
import { queuedTask } from '../src/use-composer-draft.js';

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

    it('resets to the mount shape — unchosen workflow, no stored values, no touched fields — so the mount run is a no-op', () => {
        expect(freshWorkflowDraft()).toEqual({
            workflow: '',
            storedParams: { workflowId: null, values: {} },
            paramTouched: {},
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

describe('repoReadiness — only a selected, ready repository can run a task (issue 263)', () => {
    const web = { owner: 'acme', name: 'web' };
    const api = { owner: 'acme', name: 'api' };

    it('is none-synced when no selected repository is ready, whatever is chosen', () => {
        expect(repoReadiness('', [])).toBe('none-synced');
        for (const status of ['queued', 'cloning', 'failed', 'purging'] as const) {
            expect(repoReadiness('acme/web', [{ ...web, status }])).toBe('none-synced');
        }
    });

    it('requires a choice when synced repositories exist but none is chosen', () => {
        expect(repoReadiness('', [{ ...web, status: 'ready' }])).toBe('unselected');
    });

    it('never lets another ready repository satisfy a chosen one that is not ready', () => {
        const repos = [
            { ...web, status: 'ready' as const },
            { ...api, status: 'cloning' as const },
        ];
        expect(repoReadiness('acme/api', repos)).toBe('not-ready');
        expect(repoReadiness('acme/web', repos)).toBe('ready');
    });

    it('treats a chosen repository that is no longer selected as unselected', () => {
        expect(repoReadiness('acme/gone', [{ ...web, status: 'ready' }])).toBe('unselected');
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

    it('judges the repository after the prompt and before the workflow list (issue 263)', () => {
        const base = { sending: false, executorMissing: false, promptEmpty: false, paramsInvalid: true };
        expect(startBlocker({ ...base, promptEmpty: true, repoReadiness: 'none-synced' })).toBe('empty-prompt');
        expect(startBlocker({ ...base, repoReadiness: 'none-synced', workflowUnresolved: true })).toBe(
            'no-synced-repos'
        );
        expect(startBlocker({ ...base, repoReadiness: 'unselected' })).toBe('repo-required');
        expect(startBlocker({ ...base, repoReadiness: 'not-ready' })).toBe('repo-not-ready');
        expect(startBlocker({ ...base, repoReadiness: 'ready' })).toBe('invalid-params');
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

describe('queuedTask — the POST /api/jobs body, pure (#543)', () => {
    const held: ComposerDraftInput = {
        draft: 'fix the bug',
        executor: 'main',
        executorScope: 'user',
        repo: 'acme/web',
        repoTouched: false,
        workflowRepo: 'acme/web',
        ...freshWorkflowDraft(),
    };

    it('names no workflow and no params in objective mode, and carries no defaultWorkflow key', () => {
        const body = queuedTask(held, [], {});
        expect(body).toEqual({
            command: 'fix the bug',
            repo: 'acme/web',
            executor: 'main',
            executorScope: 'user',
            workflow: null,
            workflowParams: null,
        });
        expect('defaultWorkflow' in body).toBe(false);
    });

    it('carries the named workflow, its trimmed params and the stamped scope', () => {
        const body = queuedTask(
            { ...held, executor: 'team-runner', executorScope: 'org', workflow: 'fix-issue' },
            [{ name: 'issue' }],
            { issue: ' #12 ' }
        );
        expect(body).toEqual({
            command: 'fix the bug',
            repo: 'acme/web',
            executor: 'team-runner',
            executorScope: 'org',
            workflow: 'fix-issue',
            workflowParams: { issue: '#12' },
        });
        expect('defaultWorkflow' in body).toBe(false);
    });
});

describe('startBlocker — the over-limit request (#280)', () => {
    const base = { sending: false, executorMissing: false, promptEmpty: false, paramsInvalid: false };

    it('blocks a request over the command limit, after the prompt and before the workflow checks', () => {
        expect(startBlocker({ ...base, promptTooLong: true })).toBe('too-long');
        expect(startBlocker({ ...base, promptTooLong: true, paramsInvalid: true })).toBe('too-long');
        expect(startBlocker({ ...base, promptTooLong: true, executorMissing: true })).toBe('missing-executor');
    });

    it('waits for a chosen workflow whose list has not answered, after the length and before its params', () => {
        expect(startBlocker({ ...base, workflowUnresolved: true })).toBe('workflow-loading');
        expect(startBlocker({ ...base, workflowUnresolved: true, paramsInvalid: true })).toBe('workflow-loading');
        expect(startBlocker({ ...base, workflowUnresolved: true, promptTooLong: true })).toBe('too-long');
        expect(blockerTone('workflow-loading')).toBe('info');
    });

    it('turns red only for the blockers a member must act on — a fresh composer never opens red', () => {
        expect(blockerTone('missing-executor')).toBe('bad');
        expect(blockerTone('invalid-params')).toBe('bad');
        expect(blockerTone('too-long')).toBe('bad');
        expect(blockerTone('empty-prompt')).toBe('quiet');
        expect(blockerTone('in-flight')).toBe('quiet');
        expect(blockerTone(null)).toBeNull();
    });
});

describe('the request counter (#280)', () => {
    it('counts UTF-16 units against the board limit, grouped for reading', () => {
        expect(COMMAND_LIMIT).toBe(16_384);
        expect(commandCount('')).toBe('0 / 16,384');
        expect(commandCount('x'.repeat(1234))).toBe('1,234 / 16,384');
        expect(commandTooLong('x'.repeat(COMMAND_LIMIT))).toBe(false);
        expect(commandTooLong('x'.repeat(COMMAND_LIMIT + 1))).toBe(true);
    });
});

describe('the composer draft — its fresh shape, a restore, and the dirty check (#280)', () => {
    const repos = [
        { owner: 'acme', name: 'web' },
        { owner: 'acme', name: 'api' },
    ];
    // The combined list as the page builds it from the poll (issue 391): personal first, org
    // after, each row carrying its scope.
    const executors: readonly (ExecutorChoice & { type: string })[] = [
        { name: 'main', type: 'claude-code', scope: 'user' },
        { name: 'team-runner', type: 'claude-code', scope: 'org' },
    ];
    // The poll's resolved default — the server's fallback chain, handed over whole.
    const defaultExecutor: ExecutorChoice = { name: 'team-runner', scope: 'org' };
    const restored: ComposerDraftInput = {
        draft: 'fix the login crash',
        executor: 'main',
        executorScope: 'user',
        repo: 'acme/api',
        repoTouched: true,
        workflowRepo: 'acme/api',
        workflow: 'fix-issue',
        storedParams: { workflowId: 'wf-1', values: { issue: '#12' } },
        paramTouched: { issue: true },
    };

    it('starts fresh from the lists: the resolved default executor, first repository, no workflow', () => {
        expect(initialComposerState(null, { repos, executors, defaultExecutor })).toEqual({
            draft: '',
            executor: 'team-runner',
            executorScope: 'org',
            repo: 'acme/web',
            repoTouched: false,
            workflowRepo: 'acme/web',
            ...freshWorkflowDraft(),
        });
        // No resolved default (no preference, no rows at all): the fresh composer holds nothing,
        // the missing-executor blocker's own state.
        expect(initialComposerState(null, { repos: null, executors: [], defaultExecutor: null }).executor).toBe('');
        expect(initialComposerState(null, { repos: null, executors: [], defaultExecutor: null }).executorScope).toBe(
            'user'
        );
        // The workflow was chosen under the repository the composer mounts with, so the
        // repo-reset has nothing to reset on mount.
        expect(initialComposerState(null, { repos: null, executors: [], defaultExecutor: null }).workflowRepo).toBe('');
    });

    it('restores every field exactly as it was saved, whatever the lists say now', () => {
        expect(initialComposerState(restored, { repos, executors, defaultExecutor })).toEqual(restored);
    });

    it('reads a fresh composer as clean, and any member input as a draft worth keeping', () => {
        const lists = { repos, executors, defaultExecutor };
        const fresh = initialComposerState(null, lists);
        expect(draftIsFresh(fresh, lists)).toBe(true);
        expect(draftIsFresh({ ...fresh, draft: 'x' }, lists)).toBe(false);
        // The scope is part of the choice: switching it alone is member input.
        expect(draftIsFresh({ ...fresh, executorScope: 'user' }, lists)).toBe(false);
        expect(draftIsFresh({ ...fresh, executor: 'main' }, lists)).toBe(false);
        expect(draftIsFresh({ ...fresh, repo: '', repoTouched: true, workflowRepo: '' }, lists)).toBe(false);
        expect(draftIsFresh({ ...fresh, workflow: 'fix-issue' }, lists)).toBe(false);
        expect(draftIsFresh(restored, lists)).toBe(false);
    });
});

describe('restoredDraftNotices — what changed while the member was away (#280)', () => {
    const restored: ComposerDraftInput = {
        draft: 'fix the login crash',
        executor: 'main',
        executorScope: 'user',
        repo: 'acme/web',
        repoTouched: false,
        workflowRepo: 'acme/web',
        workflow: 'fix-issue',
        storedParams: { workflowId: 'wf-1', values: { issue: '#12' } },
        paramTouched: {},
    };
    const repos = [{ owner: 'acme', name: 'web' }];
    const executors: readonly (ExecutorChoice & { type: string })[] = [
        { name: 'main', type: 'claude-code', scope: 'user' },
    ];
    const defaultExecutor: ExecutorChoice = { name: 'main', scope: 'user' };
    const workflows = [{ name: 'fix-issue' }];

    it('says nothing when everything the draft chose still exists', () => {
        expect(restoredDraftNotices(restored, { repos, executors, workflows, defaultExecutor })).toEqual([]);
    });

    it('says nothing for a choice the draft never made', () => {
        const bare = {
            ...restored,
            executor: '',
            executorScope: 'user' as const,
            repo: '',
            workflowRepo: '',
            workflow: '',
        };
        expect(restoredDraftNotices(bare, { repos: [], executors: [], workflows: [], defaultExecutor: null })).toEqual(
            []
        );
    });

    it('never matches across scopes — a same-named org profile is not the draft’s personal one', () => {
        // The organization now offers its own "main". The draft chose the PERSONAL main; switching
        // it silently would run the member's task on the shared configuration.
        const bothScopes: readonly (ExecutorChoice & { type: string })[] = [
            ...executors,
            { name: 'main', type: 'claude-code', scope: 'org' },
        ];
        expect(restoredDraftNotices(restored, { repos, executors: bothScopes, workflows, defaultExecutor })).toEqual(
            []
        );
        const orgDraft = { ...restored, executorScope: 'org' as const };
        expect(restoredDraftNotices(orgDraft, { repos, executors: bothScopes, workflows, defaultExecutor })).toEqual(
            []
        );
        // The org row gone: the personal same-name row does NOT stand in for it.
        expect(restoredDraftNotices(orgDraft, { repos, executors, workflows, defaultExecutor })).not.toEqual([]);
    });

    it('names a deleted executor and the one selected instead', () => {
        const others: readonly (ExecutorChoice & { type: string })[] = [
            { name: 'heavy', type: 'claude-code', scope: 'user' },
            { name: 'light', type: 'claude-code', scope: 'org' },
        ];
        expect(
            restoredDraftNotices(restored, {
                repos,
                executors: others,
                workflows,
                defaultExecutor: { name: 'light', scope: 'org' },
            })
        ).toEqual(['Executor ‘main’ is no longer available — light selected.']);
    });

    it('asks for a new executor when the deleted one was the last', () => {
        expect(restoredDraftNotices(restored, { repos, executors: [], workflows, defaultExecutor: null })).toEqual([
            'Executor ‘main’ is no longer available — add one to continue.',
        ]);
    });

    it('names a deselected repository, and leaves the workflow to the reset it causes', () => {
        const others = [{ owner: 'acme', name: 'api' }];
        expect(restoredDraftNotices(restored, { repos: others, executors, workflows: [] })).toEqual([
            'Repository ‘acme/web’ is no longer selected — acme/api selected.',
        ]);
        expect(restoredDraftNotices(restored, { repos: [], executors, workflows: [] })).toEqual([
            'Repository ‘acme/web’ is no longer selected — the task will run without a repository.',
        ]);
    });

    it('names a workflow the repository no longer offers', () => {
        expect(restoredDraftNotices(restored, { repos, executors, workflows: [{ name: 'triage' }] })).toEqual([
            'Workflow ‘fix-issue’ is no longer offered — no workflow selected.',
        ]);
    });

    it('holds every verdict (null) while the workflow it must judge has no answered list', () => {
        expect(restoredDraftNotices(restored, { repos, executors, workflows: null })).toBeNull();
        // Nothing to judge — no workflow was chosen, or its repository is gone — so no wait.
        expect(restoredDraftNotices({ ...restored, workflow: '' }, { repos, executors, workflows: null })).toEqual([]);
        expect(restoredDraftNotices(restored, { repos: [], executors, workflows: null })).toEqual([
            'Repository ‘acme/web’ is no longer selected — the task will run without a repository.',
        ]);
    });
});
