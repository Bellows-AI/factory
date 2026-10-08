import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { QueueTaskInput } from '../api/useTasks.js';
import { useComposerDraftStore } from '../composer-draft.js';
import { PageHeader } from '../components/PageHeader.js';
import { TaskComposer, TaskComposerSkeleton } from '../panels/TaskComposer.js';
import { composerExecutorOptions } from '../workspace/executors.js';
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
 * Workflows are dormant: the page reads no workflow list and hands the composer null, which
 * hides the selector and the workflow details — every task runs in objective mode.
 */
export function TaskComposerPage() {
    const { tasks, workspace, sessionLoading } = useTasksPage();
    const draftStore = useComposerDraftStore();
    const navigate = useNavigate();
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

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
                    repos={workspace.data?.repos.map(({ owner, name, status }) => ({ owner, name, status })) ?? null}
                    workspaceError={workspace.error}
                    onRetryWorkspace={workspace.refresh}
                    executors={composerExecutorOptions(
                        workspace.data?.executors ?? [],
                        workspace.data?.orgExecutors ?? []
                    )}
                    defaultExecutor={workspace.data?.defaultExecutor ?? null}
                    workflows={null}
                    actionError={actionError}
                    sending={sending}
                    onSend={send}
                    draftStore={draftStore}
                />
            )}
        </>
    );
}
