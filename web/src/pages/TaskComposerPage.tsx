import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDefaultWorkflowSettings } from '../api/useDefaultWorkflowSettings.js';
import type { QueueTaskInput } from '../api/useTasks.js';
import { useWorkflows } from '../api/useWorkflows.js';
import { useComposerDraftStore } from '../composer-draft.js';
import { PageHeader } from '../components/PageHeader.js';
import { TaskComposer, TaskComposerSkeleton } from '../panels/TaskComposer.js';
import { useTasksPage } from './TasksLayout.js';

/**
 * `/tasks/new`: the big guided composer, open by default, where a task is written and started.
 *
 * The page header names the page ("New task", under the Tasks eyebrow); the composer below is the
 * page's one control surface — request, execution context, workflow details, readiness and the
 * Start action, in the order a member decides (issue 176) — and no action lives outside it. The
 * task list it belongs to is in the sidenav (fed by the shell's poll), and the board answering
 * `201 { id }` is what makes navigation one line: on success the page goes straight to the new
 * task's detail view; a refusal is an alert above the draft, which stays intact.
 *
 * The draft outlives the page (F1): the shell holds it, so a trip to Settings to add an executor
 * comes back to the words, choices and workflow details the member left. It belongs to a session,
 * so the composer waits for the session check before it restores anything.
 *
 * The workflow list is the page's own read (`GET /api/workflows`), re-fetched when the selected
 * repository changes — repo-scoped workflows exist per repository. It rides beside the workspace
 * poll rather than inside it: a board that serves no workflows simply answers an empty list, and
 * the composer's workflow selector stays hidden either way.
 */
export function TaskComposerPage() {
    const { tasks, workspace, sessionLoading } = useTasksPage();
    const draftStore = useComposerDraftStore();
    const navigate = useNavigate();
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    // `undefined` until the composer reports its repository. Before that, the list is fetched for
    // the held draft's repository — the one the composer is about to restore — so a restored
    // repo-scoped workflow is never judged against the no-repository list and clamped away.
    const [reportedRepo, setReportedRepo] = useState<string | null | undefined>(undefined);
    const repo = reportedRepo === undefined ? draftStore.state?.repo || null : reportedRepo;
    const workflows = useWorkflows(repo);
    const defaultWorkflowSettings = useDefaultWorkflowSettings();

    const send = async (input: QueueTaskInput): Promise<string | null> => {
        setActionError(null);
        setSending(true);
        try {
            const result = await tasks.actions.queue(input);
            if (result.error !== null) {
                setActionError(result.error);
                return result.error;
            }
            await navigate(`/tasks/${result.id}`);
            return null;
        } finally {
            setSending(false);
        }
    };

    return (
        <>
            <PageHeader
                eyebrow="Tasks"
                title="New task"
                description="Describe what you want done, choose where it runs, and check readiness before starting."
            />
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            {sessionLoading ? (
                <TaskComposerSkeleton />
            ) : (
                <TaskComposer
                    repos={workspace.data?.repos.map(({ owner, name }) => ({ owner, name })) ?? null}
                    workspaceError={workspace.error}
                    onRetryWorkspace={workspace.refresh}
                    executors={workspace.data?.executors ?? []}
                    // Passed through as-is: null while the list is pending or from another context,
                    // and the composer hides the workflow selector for exactly that duration.
                    workflows={workflows.workflows}
                    defaultWorkflowSettings={defaultWorkflowSettings.data}
                    actionError={actionError}
                    sending={sending}
                    onSend={send}
                    onRepoChange={setReportedRepo}
                    draftStore={draftStore}
                />
            )}
        </>
    );
}
