import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useThread } from '../api/useJobs.js';
import { TaskHeader } from '../panels/TaskHeader.js';
import { TaskDetail } from '../panels/TaskDetail.js';
import { useTasksPage } from './TasksLayout.js';

/**
 * `/tasks/:id`, one task — the WHOLE follow-up chain, from the root command to the newest
 * adjustment, as one conversation. Any member's id resolves to the same view, and a follow-up
 * does NOT navigate away: the board records it as a new row (an audit record of what ran), the
 * thread refetches, and the adjustment appears as the newest message of the task it continues.
 *
 * The page header (status, wall clock, activity, the task's actions) and the conversation panel
 * both read the same polled chain. The composer and the Done verdict act on the NEWEST run — the
 * only one that is finished and not yet closed — so the page reads it off the polled chain
 * rather than off the URL.
 */
export function TaskDetailPage() {
    const { tasks } = useTasksPage();
    const navigate = useNavigate();
    const params = useParams();
    const id = params.id ?? null;
    const detail = useThread(id);
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    // The actions' in-flight guards — one mark at a time — live here, beside the mutations they
    // guard; the header renders them as disabled buttons, the panel none at all.
    const [stoppingId, setStoppingId] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [doneId, setDoneId] = useState<string | null>(null);

    // One page instance serves every /tasks/:id, so a refusal earned on task A would sit above
    // task B after a sidenav jump. A different id is a different conversation: forget the error
    // and any in-flight mark. `key` on the panel does the same for the composer's own draft.
    useEffect(() => {
        setActionError(null);
        setStoppingId(null);
        setRemovingId(null);
        setDoneId(null);
    }, [id]);

    const latest =
        detail.jobs !== null && detail.jobs.length > 0 ? (detail.jobs[detail.jobs.length - 1] ?? null) : null;

    const followUp = async (command: string): Promise<string | null> => {
        if (latest === null) return 'No task to follow up on';
        setActionError(null);
        setSending(true);
        try {
            // The adjustment continues the NEWEST run — it is the one that is finished and
            // carries the session the child inherits. No executor on the body: the board binds
            // the follow-up to the executor that ran the task.
            const result = await tasks.actions.followUp(latest.id, command);
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
    const doneTask = async (taskId: string) => {
        if (doneId !== null) return;
        setDoneId(taskId);
        try {
            setActionError(null);
            const message = await tasks.actions.markDone(taskId);
            if (message !== null) {
                setActionError(message);
                return;
            }
            // The thread poll stopped the moment every run went terminal — nothing in a finished
            // chain changes by itself — so the user's own verdict arrives only through a re-armed
            // poll. Without this the page would keep offering Done and the follow-up composer the
            // click just closed off.
            detail.refresh();
        } finally {
            setDoneId(null);
        }
    };

    // The board settles the run at the worker's next heartbeat, so the button says "Stop" while
    // the request is in flight and "Stopping…" once the flag has landed but the run has not gone
    // yet — the polls repaint the header the moment the driver has parked it, and the row comes
    // back `stopped`: the turn ended, the composer below is open again.
    const stopTask = async (taskId: string) => {
        if (stoppingId !== null) return;
        setStoppingId(taskId);
        try {
            setActionError(null);
            const message = await tasks.actions.stop(taskId);
            if (message !== null) setActionError(message);
            // Success needs no navigation: the polls repaint the parked run in place.
        } finally {
            setStoppingId(null);
        }
    };

    // The confirm lives here, with the navigation it owns: deleting a thread is not an accident
    // the sidebar should be able to make, and once the board has deleted the rows this page has
    // nothing left to render — the header falls back to the plain Tasks heading only until the
    // navigation lands. The refusal needs no confirm, so a TASK_RUNNING state slid past the
    // button just errors in place like every other refusal.
    const removeTask = async (taskId: string) => {
        if (removingId !== null) return;
        setRemovingId(taskId);
        try {
            setActionError(null);
            if (!window.confirm('Remove this task? Every run of the thread and its worktree are deleted.')) return;
            const message = await tasks.actions.remove(taskId);
            if (message !== null) {
                setActionError(message);
                return;
            }
            navigate('/tasks');
        } finally {
            setRemovingId(null);
        }
    };

    return (
        <>
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            <TaskHeader
                jobs={detail.jobs}
                stoppingId={stoppingId}
                removingId={removingId}
                doneId={doneId}
                onStop={stopTask}
                onRemove={removeTask}
                onDone={doneTask}
            />
            <TaskDetail
                key={id ?? 'none'}
                jobs={detail.jobs}
                error={detail.error}
                actionError={actionError}
                sending={sending}
                onFollowUp={followUp}
            />
        </>
    );
}
