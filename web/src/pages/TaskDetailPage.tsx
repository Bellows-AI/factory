import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useJob } from '../api/useJobs.js';
import { TaskDetail } from '../panels/TaskDetail.js';
import { useTasksPage } from './TasksLayout.js';

/**
 * `/tasks/:id`, one task: its command, its run's verdict and output, and — while the task is
 * finished and not yet closed — the composer whose Send queues a follow-up.
 *
 * A follow-up is a NEW row that continues the conversation, and the board answers with the child's
 * id: navigating there is what makes the adjustment read as a reply rather than losing the member
 * in the parent's page. Resume and done come from the same shared poll instance as everywhere else
 * in the area.
 */
export function TaskDetailPage() {
    const { tasks, workspace } = useTasksPage();
    const params = useParams();
    const id = params.id ?? null;
    const detail = useJob(id);
    const navigate = useNavigate();
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    // One page instance serves every /tasks/:id, so a refusal earned on task A would sit above
    // task B after a sidenav jump. A different id is a different conversation: forget the error.
    // `key` on the panel does the same for the composer's own draft.
    useEffect(() => {
        setActionError(null);
    }, [id]);

    const followUp = async (command: string, executor: string | null): Promise<string | null> => {
        if (id === null) return 'No task to follow up on';
        setActionError(null);
        setSending(true);
        try {
            const result = await tasks.followUp(id, command, executor);
            if (result.error !== null) return result.error;
            await navigate(`/tasks/${result.id}`);
            return null;
        } finally {
            setSending(false);
        }
    };

    const resumeTask = async (taskId: string) => {
        setActionError(null);
        const message = await tasks.resume(taskId);
        if (message !== null) setActionError(message);
    };

    const doneTask = async (taskId: string) => {
        setActionError(null);
        const message = await tasks.markDone(taskId);
        if (message !== null) {
            setActionError(message);
            return;
        }
        // The detail poll stopped the moment the run went terminal — a run never changes after
        // that — so the user's own verdict arrives only through a re-armed poll. Without this the
        // page would keep offering Done and the follow-up composer the click just closed off.
        detail.refresh();
    };

    return (
        <main>
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            <TaskDetail
                key={id ?? 'none'}
                task={detail.job}
                error={detail.error}
                executors={workspace.data?.executors ?? []}
                actionError={actionError}
                sending={sending}
                onFollowUp={followUp}
                onResume={resumeTask}
                onDone={doneTask}
            />
        </main>
    );
}
