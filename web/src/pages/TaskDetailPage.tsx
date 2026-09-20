import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useThread } from '../api/useJobs.js';
import { TaskRemoveDialog } from '../components/TaskRemoveDialog.js';
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
    // guard; the header relabels them as in-flight, the panel none at all.
    const [stoppingId, setStoppingId] = useState<string | null>(null);
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [doneId, setDoneId] = useState<string | null>(null);
    // The remove confirmation's own state: the header's menu item only opens the dialog, the
    // dialog's Remove task is the one thing that mutates, and a refusal stays inside it.
    const [removeOpen, setRemoveOpen] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);

    // One page instance serves every /tasks/:id, so a refusal earned on task A would sit above
    // task B after a sidenav jump. A different id is a different conversation: forget the error,
    // any in-flight mark, and a dialog left open. `key` on the panel does the same for the
    // composer's own draft.
    //
    // The generation is what keeps a RETIRED request from haunting the new task: every action
    // captures it at start, and after each await its tail (error, refresh, navigation, mark
    // clearing) acts only while its own generation is still current — task A's completion can
    // otherwise clear task B's in-flight mark or yank the reader off task B. Monotonic, so
    // navigating back to A still counts as a new question.
    const generation = useRef(0);
    useEffect(() => {
        generation.current += 1;
        setActionError(null);
        setSending(false);
        setStoppingId(null);
        setRemovingId(null);
        setDoneId(null);
        setRemoveOpen(false);
        setRemoveError(null);
        // Leaving the route invalidates every in-flight action too: without this, a late
        // remove could pass the generation check after unmount and redirect a page the reader
        // has already left (React runs this cleanup before the next id's effect, so a route
        // change invalidates twice — harmless; the counter is only compared, never read).
        return () => {
            generation.current += 1;
        };
    }, [id]);

    const latest =
        detail.jobs !== null && detail.jobs.length > 0 ? (detail.jobs[detail.jobs.length - 1] ?? null) : null;

    const followUp = async (command: string): Promise<string | null> => {
        if (latest === null) return 'No task to follow up on';
        const atStart = generation.current;
        setActionError(null);
        setSending(true);
        try {
            // The adjustment continues the NEWEST run — it is the one that is finished and
            // carries the session the child inherits. No executor on the body: the board binds
            // the follow-up to the executor that ran the task.
            const result = await tasks.actions.followUp(latest.id, command);
            if (generation.current !== atStart) return result.error;
            if (result.error !== null) {
                setActionError(result.error);
                return result.error;
            }
            // Same task, one message longer: the thread poll stopped when every run in it was
            // terminal, so it re-arms here to bring the queued adjustment in.
            detail.refresh();
            return null;
        } finally {
            // Only the current question releases the composer: a retired follow-up's settle
            // must not release task B's own in-flight send mid-request.
            if (generation.current === atStart) setSending(false);
        }
    };
    const doneTask = async (taskId: string) => {
        if (doneId !== null) return;
        const atStart = generation.current;
        setDoneId(taskId);
        try {
            setActionError(null);
            const message = await tasks.actions.markDone(taskId);
            if (generation.current !== atStart) return;
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
            if (generation.current === atStart) setDoneId(null);
        }
    };

    // The board settles the run at the worker's next heartbeat, so the button says "Stop" while
    // the request is in flight and "Stopping…" once the flag has landed but the run has not gone
    // yet — the polls repaint the header the moment the driver has parked it, and the row comes
    // back `stopped`: the turn ended, the composer below is open again.
    const stopTask = async (taskId: string) => {
        if (stoppingId !== null) return;
        const atStart = generation.current;
        setStoppingId(taskId);
        try {
            setActionError(null);
            const message = await tasks.actions.stop(taskId);
            if (generation.current !== atStart) return;
            if (message !== null) setActionError(message);
            // Success needs no navigation: re-arm the thread poll so the stamped run repaints
            // the header at once — otherwise the cleared guard would flash the clickable button
            // back on for up to one 2s tick before the poll carried the stamp in.
            else detail.refresh();
        } finally {
            if (generation.current === atStart) setStoppingId(null);
        }
    };

    // The confirmation lives in the dialog, and so does the refusal: Remove task confirms
    // there, the request carries the in-flight mark the dialog disables itself with, and a
    // refusal stays inside the open dialog as an alert instead of erroring somewhere the
    // decision is no longer visible. Success is the one navigation — the rows are gone, this
    // page has nothing left to render, and the inbox is where the task list lives.
    const removeTask = async () => {
        if (latest === null || removingId !== null) return;
        const taskId = latest.id;
        const atStart = generation.current;
        setRemovingId(taskId);
        try {
            setRemoveError(null);
            const message = await tasks.actions.remove(taskId);
            // A retired remove must not yank the reader off the task they navigated to.
            if (generation.current !== atStart) return;
            if (message !== null) {
                setRemoveError(message);
                return;
            }
            navigate('/tasks');
        } finally {
            if (generation.current === atStart) setRemovingId(null);
        }
    };

    return (
        <>
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            <TaskHeader
                jobs={detail.jobs}
                stoppingId={stoppingId}
                doneId={doneId}
                onStop={stopTask}
                onDone={doneTask}
                onRemoveRequest={() => {
                    setRemoveError(null);
                    setRemoveOpen(true);
                }}
            />
            <TaskDetail
                key={id ?? 'none'}
                jobs={detail.jobs}
                error={detail.error}
                actionError={actionError}
                sending={sending}
                onFollowUp={followUp}
            />
            {detail.jobs !== null && detail.jobs.length > 0 ? (
                <TaskRemoveDialog
                    open={removeOpen}
                    command={detail.jobs[0]!.command}
                    runCount={detail.jobs.length}
                    removing={removingId !== null}
                    error={removeError}
                    onClose={() => setRemoveOpen(false)}
                    onConfirm={() => void removeTask()}
                />
            ) : null}
        </>
    );
}
