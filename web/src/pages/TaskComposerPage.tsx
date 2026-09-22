import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWorkflows } from '../api/useWorkflows.js';
import { PageHeader } from '../components/PageHeader.js';
import { TaskComposer } from '../panels/TaskComposer.js';
import { useTasksPage } from './TasksLayout.js';

/**
 * `/tasks`, the area's index: the big guided composer, open by default, where a task is written
 * and started.
 *
 * The page header names the page ("New task", under the Tasks eyebrow); the composer panel below
 * is the page's one control surface — prompt, execution context, workflow, preflight and the
 * Start action, in the order a member decides (issue 176) — and no action lives outside it. The
 * task list it belongs to is in the sidenav (fed by the shell's poll), and the board answering
 * `201 { id }` is what makes navigation one line: on success the page goes straight to the new
 * task's detail view; a refusal is an alert above the draft, which stays intact.
 *
 * The workflow list is the page's own read (`GET /api/workflows`), re-fetched when the selected
 * repository changes — repo-scoped workflows exist per repository. It rides beside the workspace
 * poll rather than inside it: a board that serves no workflows simply answers an empty list, and
 * the composer's workflow section stays hidden either way.
 */
export function TaskComposerPage() {
    const { tasks, workspace } = useTasksPage();
    const navigate = useNavigate();
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [repo, setRepo] = useState<string | null>(null);
    const workflows = useWorkflows(repo);

    const send = async (
        command: string,
        chosenRepo: string | null,
        executor: string,
        workflow: string | null,
        workflowParams: Record<string, string> | null
    ): Promise<string | null> => {
        setActionError(null);
        setSending(true);
        try {
            const result = await tasks.actions.queue(command, chosenRepo, executor, workflow, workflowParams);
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
                description="The task runs in the selected workspace context."
            />
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            <TaskComposer
                repos={workspace.data?.repos.map(({ owner, name }) => ({ owner, name })) ?? null}
                workspaceError={workspace.error}
                onRetryWorkspace={workspace.refresh}
                executors={workspace.data?.executors ?? []}
                // Passed through as-is: null while the list is pending or from another context,
                // and the composer hides the workflow section for exactly that duration.
                workflows={workflows.workflows}
                actionError={actionError}
                sending={sending}
                onSend={send}
                onRepoChange={setRepo}
            />
        </>
    );
}
