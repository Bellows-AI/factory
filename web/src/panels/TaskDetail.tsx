import { useEffect, useRef, useState } from 'react';
import { isTerminal, type Job } from '../api/useJobs.js';
import { TaskOutcome } from './TaskOutcome.js';
import { TaskRun } from './TaskRun.js';

/**
 * One task, whole: the follow-up chain rendered as ONE conversation — the root command first,
 * every adjustment after it, each as a `TaskRun` article reading request → response → checks →
 * metadata — and, while the newest run can still take one, the composer to continue it. The
 * thread-level outcome summary (`TaskOutcome`) leads the layout's DOM.
 *
 * Props in, markup out, like every panel: the detail poll lives in the page (`useThread`) and
 * this component owns only the follow-up draft and the live-output tail. The task's title,
 * status, clock, activity and action buttons are the page header's (`TaskHeader`). Follow-ups
 * are new rows on the board (it is an audit record of what ran), but they are NOT new tasks
 * here: the chain renders top to bottom in this one view, and sending an adjustment extends it
 * in place.
 */
export function TaskDetail({
    jobs,
    error,
    actionError,
    sending,
    onFollowUp,
}: {
    /** The task's whole chain, oldest first — null until the thread poll lands. */
    jobs: Job[] | null;
    /** Why there is no task yet. Said in place, never silently. */
    error: string | null;
    /** Why the last follow-up did not queue. Said in place, never silently. */
    actionError: string | null;
    sending: boolean;
    onFollowUp: (command: string) => Promise<string | null>;
}) {
    const [draft, setDraft] = useState('');
    const outputRef = useRef<HTMLPreElement | null>(null);

    // The conversation continues on the newest run: the composer, the live-output tail and the
    // Done verdict all belong to it. Older runs are history — their output never grows again.
    // Computed before the early return, because the scroll effect below needs it on every render.
    const latest = jobs === null || jobs.length === 0 ? null : jobs[jobs.length - 1];

    // The output streams in while the newest run goes (the driver flushes tails to the board, and
    // the thread poll picks them up), and somebody watching a run wants the newest line — so the
    // pane follows the tail while the task can still move. A finished run is history; scrolling
    // it is the reader's.
    const liveStatus = latest?.status;
    const liveOutput = latest?.output;
    useEffect(() => {
        if (liveStatus !== undefined && !isTerminal(liveStatus) && outputRef.current) {
            outputRef.current.scrollTop = outputRef.current.scrollHeight;
        }
    }, [liveStatus, liveOutput]);

    if (jobs === null || jobs.length === 0) {
        return (
            <section className="panel">
                {error !== null ? <p className="muted">{error}</p> : <p className="muted">Loading the task…</p>}
            </section>
        );
    }

    // The run ending is not the task ending: the member can ask for an adjustment or close the
    // task by hand. Neither exists once they have said done. The assertion is sound: the early
    // return above guarantees a non-empty chain, and `latestTask` is its newest member.
    const latestTask = latest as Job;
    // A follow-up continues the newest run's agent session, and the board refuses one for a run
    // that never reported a session — every run whose driver died before reporting — with 409
    // NO_SESSION. Offering the composer there would be a control that can only fail, so the page
    // says so instead.
    const canFollowUp = isTerminal(latestTask.status) && latestTask.doneAt === null && latestTask.sessionId !== null;
    const sessionless = isTerminal(latestTask.status) && latestTask.doneAt === null && latestTask.sessionId === null;

    const send = async () => {
        if (!draft.trim() || sending) return;
        // No executor choice here: the adjustment is bound to the executor that ran the task —
        // the board copies it from the parent, and a conversation switching executors mid-thread
        // is exactly the cross-CLI resume nothing can do.
        if ((await onFollowUp(draft)) === null) setDraft('');
    };

    return (
        <>
            {/* The action/thread error leads the page, above both columns — it is about the
            reader's last ask, not about either panel's content. */}
            {actionError !== null ? <p className="status">{actionError}</p> : null}
            <div className="task-layout">
                {/* The outcome summary: what happened and where, above the conversation in the
                DOM so a narrow screen reads it first (the grid moves it right from 1024px). */}
                <TaskOutcome jobs={jobs} />
                <section className="task-conversation panel">
                    {jobs.map((task, index) => (
                        <TaskRun
                            key={task.id}
                            job={task}
                            index={index + 1}
                            liveRef={task.id === latestTask.id && !isTerminal(task.status) ? outputRef : undefined}
                        />
                    ))}
                    {canFollowUp ? (
                        <div className="composer">
                            <textarea
                                className="composer-input"
                                placeholder="Describe the adjustment…"
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                                }}
                            />
                            <div className="composer-row">
                                <button
                                    type="button"
                                    className="primary"
                                    disabled={!draft.trim() || sending}
                                    onClick={() => void send()}
                                >
                                    Send
                                </button>
                            </div>
                        </div>
                    ) : null}
                    {sessionless ? (
                        <p className="muted">
                            This run has no agent session to continue, so it cannot take a follow-up. Queue a new task
                            instead.
                        </p>
                    ) : null}
                </section>
            </div>
        </>
    );
}
