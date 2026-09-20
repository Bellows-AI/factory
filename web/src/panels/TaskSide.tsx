import type { ReactNode } from 'react';
import { runDuration } from '../format.js';
import { KeyValues } from '../components/KeyValues.js';
import type { Job, RuntimeVitals } from '../api/useJobs.js';
import { isHttpUrl, threadCostUsd, threadContextTokens, threadIssue, threadPublish } from '../task-outcome.js';

/**
 * What the thread is about, derived from what the board already carries. The derivations live in
 * `task-outcome.ts` (pure, panel-free); this panel only formats and renders them.
 */

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');

/** The context row's reading: "3,000 tok", or nothing where nothing was measured. */
const formatContext = (tokens: number | null): ReactNode =>
    tokens !== null ? `${tokenCount.format(tokens)} tok` : null;

/** The cost row's reading: four decimals, or nothing where nothing was billed. */
const formatCost = (cost: number | null): ReactNode => (cost !== null ? `$${cost.toFixed(4)}` : null);

/**
 * The task page's right column: one status surface for the whole THREAD — thread-level context
 * and cost, the newest run's activity and services — while per-turn numbers stay on the turns
 * they describe. Older runs are history, and their verdicts stay inline on their own messages.
 *
 * Everything here is either what the board reports or a blank. A value the board does not carry
 * renders nothing rather than a dash (issue 100) — a dash reads as a measurement, and nothing
 * was measured. The one honest gap is deliberate: the PR is read off the publish line the
 * driver appends to the output (the only place the board carries one today; no source records
 * a PR's state, so no row claims one). A structured PR field would be a contract change —
 * route, store, driver — and is a follow-up, not part of this panel.
 */
export function TaskSide({ jobs }: { jobs: Job[] }) {
    const latest = jobs[jobs.length - 1] as Job;
    const runtime = latest.runtime ?? null;
    // A run that is not going must not show a ticking clock: queued has no attempt yet, and a
    // parked one would count wall-clock time while nothing runs.
    const parked = latest.status === 'queued' || latest.status === 'standby';
    const published = threadPublish(jobs);
    const issue = threadIssue(jobs);
    return (
        <aside className="panel task-side">
            <div className="panel-head">
                <h2>Status</h2>
            </div>
            <p className="msg-meta">
                <span className="pill">{latest.status}</span>
                {latest.executor !== null ? <span className="pill">{latest.executor}</span> : null}
                {latest.doneAt !== null ? <span className="pill chat-done">done</span> : null}
                {latest.exitCode !== null ? <span className="chat-exit">exit {latest.exitCode}</span> : null}
            </p>
            <KeyValues
                pairs={[
                    // Who queued the task, resolved server-side from the audit rows. 'unknown' is
                    // the honest answer for a pre-accounts row; the avatar renders only when the
                    // account carries one, so `__local__` and label-less accounts get text alone.
                    [
                        'Queued by',
                        latest.author !== null ? (
                            <span className="task-queued-by">
                                {latest.author.avatarUrl !== null ? (
                                    <img className="task-avatar" src={latest.author.avatarUrl} alt="" />
                                ) : null}
                                {latest.author.name ?? latest.author.login}
                            </span>
                        ) : (
                            'unknown'
                        ),
                    ],
                    ['Workspace', latest.workspacePath],
                    // The derivations answer raw numbers; the panel fixes the reading.
                    ['Context', formatContext(threadContextTokens(jobs))],
                    ['Cost', formatCost(threadCostUsd(jobs))],
                    // The agent's current activity line, while there is one: a stale line beside a
                    // finished verdict lies about a run that is no longer going.
                    ['Task', latest.status === 'running' && runtime?.activity != null ? runtime.activity : null],
                    ['Running time', parked ? null : runDuration(latest.startedAt, latest.finishedAt)],
                ]}
            />
            {latest.runtime?.services?.length ? (
                <>
                    <div className="panel-head">
                        <h2>Services</h2>
                    </div>
                    {/* The newest attempt's last observed states — the fleet is torn down when the
                    attempt ends, so these are its record of it, not a claim about now. */}
                    <KeyValues
                        pairs={latest.runtime.services.map(
                            (service) => [service.name, service.state] as [string, ReactNode]
                        )}
                    />
                </>
            ) : null}
            <div className="panel-head">
                <h2>Connections</h2>
            </div>
            <KeyValues
                pairs={[
                    ['Issue', issue !== null ? `#${issue}` : null],
                    [
                        'PR',
                        published !== null ? (
                            published.url !== null && isHttpUrl(published.url) ? (
                                // A new window, not a navigation over the dashboard, and
                                // rel=noopener/noreferrer so the opened PR cannot reach back
                                // into this tab. The url is the text — the reader sees where
                                // the link goes, not a branch slug.
                                <a href={published.url} target="_blank" rel="noopener noreferrer">
                                    {published.url}
                                </a>
                            ) : (
                                published.branch
                            )
                        ) : null,
                    ],
                ]}
            />
        </aside>
    );
}
