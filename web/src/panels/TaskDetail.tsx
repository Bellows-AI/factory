import { type ReactNode, useEffect, useRef, useState } from 'react';
import { isTerminal, type Job, type ServiceStatus } from '../api/useJobs.js';
import type { JobActivity } from '../api/useJobActivity.js';
import { KeyValues } from '../components/KeyValues.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { endedOnQuestion, type FollowUpViewer, followUpEligibility, threadPublish } from '../task-outcome.js';
import { FOLLOW_UP_INPUT_ID, notAuthorMessage } from './TaskHeader.js';
import { TaskActivity } from './TaskActivity.js';
import { TaskOutcome } from './TaskOutcome.js';
import { type OnAnswer, Publication, TaskRun, Verification } from './TaskRun.js';

/** One recorded fact of the task's life: what happened, and the stamp the board holds for it. */
interface HistoryItem {
    key: string;
    title: string;
    at: string;
}

/**
 * The run history: only facts the board recorded — each run's queued/started/finished stamps, a
 * stop request, the review wait's start and the Done verdict — oldest first. Nothing inferred:
 * no "Implemented changes", no "Published PR", because no stamp says when either happened. The
 * wait and the verdict are the thread's (every member carries the same wait, and only the newest
 * run can be closed), so they are read off the newest run once.
 */
function runHistory(jobs: Job[]): HistoryItem[] {
    const items: HistoryItem[] = [];
    jobs.forEach((job, i) => {
        const run = `Run ${i + 1}`;
        items.push({
            key: `${job.id}-created`,
            title: i === 0 ? 'Task created' : 'Follow-up queued',
            at: job.createdAt,
        });
        if (job.startedAt !== null)
            items.push({ key: `${job.id}-started`, title: `${run} started`, at: job.startedAt });
        if (job.cancelRequestedAt !== null) {
            const by = job.stoppedBy !== null ? ` by ${job.stoppedBy.login}` : '';
            items.push({ key: `${job.id}-stop`, title: `Stop requested${by}`, at: job.cancelRequestedAt });
        }
        if (job.finishedAt !== null && isTerminal(job.status)) {
            // `dead` is the board's word for a run whose worker vanished; the history says so.
            const verdict = job.status === 'dead' ? 'lost its worker' : job.status;
            items.push({ key: `${job.id}-finished`, title: `${run} ${verdict}`, at: job.finishedAt });
        }
    });
    const latest = jobs[jobs.length - 1]!;
    if (latest.waitingSince !== null) {
        items.push({ key: 'waiting', title: 'Waiting for review', at: latest.waitingSince });
    }
    if (latest.doneAt !== null) {
        const by = latest.doneBy !== null ? ` by ${latest.doneBy.login}` : '';
        items.push({ key: 'done', title: `Marked done${by}`, at: latest.doneAt });
    }
    // A stable sort on the ISO stamps: same-instant facts keep the order they were pushed in.
    return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function RunHistory({ jobs }: { jobs: Job[] }) {
    return (
        <section className="panel">
            <details className="run-history">
                <summary>
                    <h2>Run history</h2>
                    <span className="muted">
                        {jobs.length} {jobs.length === 1 ? 'run' : 'runs'}
                    </span>
                </summary>
                <ol className="task-history">
                    {runHistory(jobs).map((item) => (
                        <li key={item.key} className="task-history-item">
                            <span>{item.title}</span>
                            <RelativeTime at={item.at} />
                        </li>
                    ))}
                </ol>
            </details>
        </section>
    );
}

/** The Services panel shows only the first few rows; the rest collapse into a count. */
const MAX_VISIBLE_SERVICES = 3;

/** Why a dead service died: its exit, reason, hint and last log lines; nothing for a live one. */
function ServiceEnding({ service }: { service: ServiceStatus }) {
    const { exitCode, reason, logTail, hint } = service;
    if (exitCode === undefined && !reason && !logTail?.trim()) return null;
    const how = `exit ${exitCode ?? 'unknown'}${reason ? ` (${reason})` : ''}`;
    return (
        <div>
            <p className="muted">
                {service.name} {service.state} — {how}
            </p>
            {hint ? <p className="muted">{hint}</p> : null}
            {logTail?.trim() ? (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <pre className="chat-output" tabIndex={0}>
                    {logTail.trimEnd()}
                </pre>
            ) : null}
        </div>
    );
}

/** The newest attempt's last observed service states, capped and counted. */
function Services({ services }: { services: readonly ServiceStatus[] }) {
    const overflow = services.length - MAX_VISIBLE_SERVICES;
    const visible = services.slice(0, MAX_VISIBLE_SERVICES);
    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Services</h2>
            </div>
            {/* The fleet is torn down when the attempt ends, so these are its record of it, not a
            claim about now. */}
            <KeyValues pairs={visible.map((service) => [service.name, service.state] as [string, ReactNode])} />
            {visible.map((service) => (
                <ServiceEnding key={service.name} service={service} />
            ))}
            {overflow > 0 ? <p className="muted">and {overflow} more</p> : null}
        </section>
    );
}

/**
 * The composer: a visible label and a helper sentence (it continues the task, it does not start
 * a new one), the draft, and the send. A refusal — a 403 FORBIDDEN included — renders inside it,
 * beside the draft it refused, and the draft is kept.
 */
function FollowUpComposer({
    error,
    sending,
    onFollowUp,
}: {
    error: string | null;
    sending: boolean;
    onFollowUp: (command: string) => Promise<string | null>;
}) {
    const [draft, setDraft] = useState('');
    const send = async () => {
        if (!draft.trim() || sending) return;
        // No executor choice here: the adjustment is bound to the executor that ran the task.
        if ((await onFollowUp(draft)) === null) setDraft('');
    };
    return (
        <div className="composer">
            <label className="composer-label" htmlFor={FOLLOW_UP_INPUT_ID}>
                Ask for a follow-up
            </label>
            <p className="composer-label">The agent continues the same task, checkout, executor, and session.</p>
            {error !== null ? <p className="status">{error}</p> : null}
            <textarea
                id={FOLLOW_UP_INPUT_ID}
                className="field composer-input"
                placeholder="Describe the adjustment…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                }}
            />
            <div className="composer-row">
                {/* The shortcut is written down, and it is the same guarded path the button takes. */}
                <span className="composer-label">Ctrl/⌘ + Enter</span>
                <button
                    type="button"
                    className="primary"
                    disabled={!draft.trim() || sending}
                    onClick={() => void send()}
                >
                    {sending ? 'Sending…' : 'Send follow-up'}
                </button>
            </div>
        </div>
    );
}

/** The fallback notice (issue #226): the run ended on a question and nothing could ask it in place. */
const ENDED_ON_QUESTION_REPLY = 'Claude ended with a question. Reply below to continue the same conversation.';
const ENDED_ON_QUESTION_AUTHOR = "Claude ended with a question. The task's author can reply with a follow-up.";

/**
 * The follow-up slot, by `followUpEligibility`: the composer for the task's author; a sentence
 * for a sessionless run or another member's task; nothing while the session loads (so the
 * author's own task never flashes a refusal), while the run moves, or once the task is closed.
 */
function FollowUp({
    latest,
    viewer,
    error,
    sending,
    onFollowUp,
}: {
    latest: Job;
    viewer: FollowUpViewer;
    error: string | null;
    sending: boolean;
    onFollowUp: (command: string) => Promise<string | null>;
}) {
    const eligibility = followUpEligibility(latest, viewer);
    const asked = endedOnQuestion(latest);
    let body: ReactNode = null;
    if (eligibility === 'eligible') {
        body = (
            <>
                {asked ? <p className="status">{ENDED_ON_QUESTION_REPLY}</p> : null}
                <FollowUpComposer error={error} sending={sending} onFollowUp={onFollowUp} />
            </>
        );
    } else if (eligibility === 'not-author') {
        body = (
            <>
                {asked ? <p className="status">{ENDED_ON_QUESTION_AUTHOR}</p> : null}
                <p className="muted">{notAuthorMessage(latest)}</p>
            </>
        );
    }
    if (body === null) return null;
    return (
        <section className="panel task-follow-up">
            <div className="panel-head">
                <h2>Follow up</h2>
            </div>
            {body}
        </section>
    );
}

/**
 * One task, whole: the outcome rail, the main column — the conversation (every run's request
 * and response, the root first) and the follow-up — and the supporting panels: services, run
 * activity, run history, the newest run's verification and the published work. The rail leads
 * the DOM, so a narrow screen reads it first as a summary, then the conversation, then the
 * panels; from 1024px the grid puts the rail and the panels in the right sidebar.
 *
 * Props in, markup out, like every panel: the detail poll lives in the page (`useThread`) and
 * this component owns only the follow-up draft and the live-output tail. Follow-ups are new rows
 * on the board (an audit record of what ran), but they are NOT new tasks here: the chain renders
 * top to bottom in this one view, and sending an adjustment extends it in place.
 */
export function TaskDetail({
    jobs,
    viewer,
    error,
    actionError,
    followUpError,
    sending,
    onFollowUp,
    onAnswer,
    activity = null,
    live = false,
}: {
    /** The task's whole chain, oldest first — null until the thread poll lands. */
    jobs: Job[] | null;
    /** Who is looking — only the task's author is offered the composer. */
    viewer: FollowUpViewer;
    /** Why there is no task yet. Said in place, never silently. */
    error: string | null;
    /** Why the last stop or Mark done did not land. Said above both columns. */
    actionError: string | null;
    /** Why the last follow-up did not queue. Said inside the composer, beside the draft. */
    followUpError: string | null;
    sending: boolean;
    onFollowUp: (command: string) => Promise<string | null>;
    /** Answers a run's question; the page refreshes the thread once it settles. */
    onAnswer: OnAnswer;
    /**
     * The head run's activity payload (issue 339), fetched by the page's hook — the panel
     * draws what it is handed, and null is "nothing (yet) to chart", drawn as a quiet sentence.
     */
    activity?: JobActivity | null;
    /** Whether the head run is still going — hatches the chart's in-progress bucket. */
    live?: boolean;
}) {
    const outputRef = useRef<HTMLPreElement | null>(null);

    // The conversation continues on the newest run: the composer, the live-output tail and the
    // Done verdict all belong to it. Computed before the early return, because the scroll effect
    // below needs it on every render.
    const latest = jobs === null || jobs.length === 0 ? null : jobs[jobs.length - 1];

    // The output streams in while the newest run goes, and somebody watching a run wants the
    // newest line — so the pane follows the tail while the task can still move.
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

    // The early return above guarantees a non-empty chain, and `latestTask` is its newest member.
    const latestTask = latest as Job;
    const gates = latestTask.gates ?? null;
    const services = latestTask.runtime?.services ?? null;
    const publish = threadPublish(jobs);

    return (
        <>
            {/* The action error leads the page, above both columns — it is about the reader's last
            stop or Mark done, not about either panel's content. */}
            {actionError !== null ? <p className="status">{actionError}</p> : null}
            <div className="task-layout">
                <TaskOutcome jobs={jobs} viewer={viewer} />
                <div className="task-main">
                    <section className="task-conversation panel">
                        <div className="panel-head">
                            <h2>Conversation</h2>
                        </div>
                        {jobs.map((task, index) => (
                            <TaskRun
                                key={task.id}
                                job={task}
                                index={index + 1}
                                liveRef={task.id === latestTask.id && !isTerminal(task.status) ? outputRef : undefined}
                                onAnswer={onAnswer}
                            />
                        ))}
                    </section>
                    <FollowUp
                        latest={latestTask}
                        viewer={viewer}
                        error={followUpError}
                        sending={sending}
                        onFollowUp={onFollowUp}
                    />
                </div>
                <div className="task-support">
                    {services !== null && services.length > 0 ? <Services services={services} /> : null}
                    {/* The head run's progress over time (issue 339) — one chart, for the run
                    the reader is looking at, driven by `failure_kind`'s sibling read. */}
                    <TaskActivity payload={activity} live={live} />
                    <RunHistory jobs={jobs} />
                    {gates !== null && gates.length > 0 ? <Verification gates={gates} /> : null}
                    {publish !== null ? <Publication publish={publish} /> : null}
                </div>
            </div>
        </>
    );
}
