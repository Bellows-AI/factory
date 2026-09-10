import type { ReactNode } from 'react';
import { runDuration } from '../format.js';
import { KeyValues } from '../components/KeyValues.js';
import type { Job, RuntimeVitals } from '../api/useJobs.js';

/**
 * What the thread is about, derived from what the board already carries — the sidebar's raw
 * material. These read the thread NEWEST first (the chain arrives oldest first), because the
 * newest run is the conversation's present tense.
 */

/**
 * The issue the task names, with the driver's `publishPlan` precedence (`issues/\d+` before a
 * bare `#\d+`) — copied, not imported: web is an independent workspace, the same rule the driver
 * follows toward the server. The driver reads this same reference to name the task branch and
 * close the issue from the PR, so the sidebar shows the reader what the run is about.
 */
export function threadIssue(jobs: Job[]): number | null {
    for (let i = jobs.length - 1; i >= 0; i--) {
        const command = jobs[i]!.command;
        const issue = /issues\/(\d+)/.exec(command)?.[1] ?? /#(\d+)/.exec(command)?.[1] ?? null;
        if (issue !== null) return Number(issue);
    }
    return null;
}

/** The PR the driver's publish step created, as far as the board knows it: a branch, maybe a url. */
export interface ThreadPublish {
    branch: string;
    url: string | null;
}

/**
 * The publish the driver appended to a run's output — `[driver] published <branch> — <prUrl>` —
 * the only place the board carries a PR today. Parsed here rather than made structured, which is
 * honest about being a convention read: a structured field would be a contract change (route,
 * store, driver) and is a deliberate follow-up. Anchored to a line start, because the driver
 * appends whole lines and the agent's own output is arbitrary text that may mention the marker;
 * a url is only linked when it is `https://`, so nothing a run echoed can become a handler href.
 * Null when nothing in the thread was published.
 */
export function threadPublish(jobs: Job[]): ThreadPublish | null {
    for (let i = jobs.length - 1; i >= 0; i--) {
        const output = jobs[i]!.output;
        if (output === null) continue;
        const match = /(?:^|\n)\[driver\] published (\S+)(?: — (\S+))?/.exec(output);
        if (match) return { branch: match[1]!, url: match[2] ?? null };
    }
    return null;
}

/** A publish line's url becomes a link only when it is one the reader can safely open. */
const isHttpUrl = (url: string): boolean => url.startsWith('https://') || url.startsWith('http://');

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');

/** How a context stat renders, or the honest dash when the runner scraped none. */
const context = (runtime: RuntimeVitals | null): ReactNode =>
    runtime?.contextTokens != null ? `${tokenCount.format(runtime.contextTokens)} tok` : '—';

/** Cost renders only once it is money — a zero-dollar run is not billed, and $0.0000 is noise. */
const cost = (runtime: RuntimeVitals | null): ReactNode =>
    runtime?.costUsd != null && runtime.costUsd > 0 ? `$${runtime.costUsd.toFixed(4)}` : '—';

/**
 * The task page's right column: one status surface for the whole view, fed by the NEWEST run —
 * the same run the composer and the Done verdict belong to. Older runs are history, and their
 * verdicts stay inline on their own messages.
 *
 * Everything here is either what the board reports or an explicit dash. The two honest gaps are
 * deliberate: the PR is read off the publish line the driver appends to the output (the only
 * place the board carries one today), and no source at all records a PR's state, so that row
 * always says '—' rather than inventing one. A structured PR field would be a contract change —
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
                    ['Workspace', latest.workspacePath ?? '—'],
                    ['Context', context(runtime)],
                    ['Cost', cost(runtime)],
                    // The agent's current activity line, while there is one: a stale line beside a
                    // finished verdict lies about a run that is no longer going.
                    ['Task', latest.status === 'running' && runtime?.activity != null ? runtime.activity : '—'],
                    ['Running time', parked ? '—' : runDuration(latest.startedAt, latest.finishedAt)],
                ]}
            />
            <div className="panel-head">
                <h2>Connections</h2>
            </div>
            <KeyValues
                pairs={[
                    ['Issue', issue !== null ? `#${issue}` : '—'],
                    [
                        'PR',
                        published !== null ? (
                            published.url !== null && isHttpUrl(published.url) ? (
                                <a href={published.url}>{published.branch}</a>
                            ) : (
                                published.branch
                            )
                        ) : (
                            '—'
                        ),
                    ],
                    ['PR state', '—'],
                ]}
            />
        </aside>
    );
}
