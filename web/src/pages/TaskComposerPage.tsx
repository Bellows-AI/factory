import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TaskComposer } from '../panels/TaskComposer.js';
import { useTasksPage } from './TasksLayout.js';

/**
 * `/tasks`, the area's index: the big composer, open by default, where a task is typed and started.
 *
 * The task list it belongs to is in the sidenav (fed by the shell's poll), and the board answering
 * `201 { id }` is what makes the issue's third bullet one line: on success the page navigates
 * straight to the new task's detail view — output, status, and the composer for follow-ups.
 */
export function TaskComposerPage() {
    const { tasks, workspace } = useTasksPage();
    const navigate = useNavigate();
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const send = async (command: string, repo: string | null, executor: string | null): Promise<string | null> => {
        setActionError(null);
        setSending(true);
        try {
            const result = await tasks.queue(command, repo, executor);
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
        <main>
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            <TaskComposer
                repos={workspace.data?.repos.map(({ owner, name }) => ({ owner, name })) ?? null}
                workspaceError={workspace.error}
                onRetryWorkspace={workspace.refresh}
                executors={workspace.data?.executors ?? []}
                actionError={actionError}
                sending={sending}
                onSend={send}
            />
        </main>
    );
}
