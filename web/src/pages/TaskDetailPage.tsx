import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useThread } from '../api/useJobs.js';
import { TaskDetail } from '../panels/TaskDetail.js';
import { useTasksPage } from './TasksLayout.js';

/**
 * `/tasks/:id`, one task — the WHOLE follow-up chain, from the root command to the newest
 * adjustment, as one conversation. Any member's id resolves to the same view, and a follow-up
 * does NOT navigate away: the board records it as a new row (an audit record of what ran), the
 * thread refetches, and the adjustment appears as the newest message of the task it continues.
 *
 * The composer and the Done verdict act on the NEWEST run — the only one that is finished and
 * not yet closed — so the page reads it off the polled chain rather than off the URL.
 */
export function TaskDetailPage() {
    const { tasks } = useTasksPage();
    const params = useParams();
    const id = params.id ?? null;
    const detail = useThread(id);
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    // One page instance serves every /tasks/:id, so a refusal earned on task A would sit above
    // task B after a sidenav jump. A different id is a different conversation: forget the error.
    // `key` on the panel does the same for the composer's own draft.
    useEffect(() => {
        setActionError(null);
    }, [id]);

    const latest =
        detail.jobs !== null && detail.jobs.length > 0
            ? (detail.jobs[detail.jobs.length - 1] ?? null)
            : null;

    const followUp = async (command: string): Promise<string | null> => {
        if (latest === null) return 'No task to follow up on';
        setActionError(null);
        setSending(true);
        try {
            // The adjustment continues the NEWEST run — it is the one that is finished and
            // carries the session the child inherits. No executor on the body: the board binds
            // the follow-up to the executor that ran the task.
            const result = await tasks.followUp(latest.id, command);
            if (result.error !== null) {
                setActionError(result.error);
                return result.error;
            }
            // Same task, one message longer: the thread poll stopped when every run in it was
            // terminal, so it re-arms here to bring the queued adjustment in.
            detail.refresh();
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
        // The thread poll stopped the moment every run went terminal — nothing in a finished
        // chain changes by itself — so the user's own verdict arrives only through a re-armed
        // poll. Without this the page would keep offering Done and the follow-up composer the
        // click just closed off.
        detail.refresh();
    };

    return (
        <main>
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            <TaskDetail
                key={id ?? 'none'}
                jobs={detail.jobs}
                error={detail.error}
                actionError={actionError}
                sending={sending}
                onFollowUp={followUp}
                onResume={resumeTask}
                onDone={doneTask}
            />
        </main>
    );
}
