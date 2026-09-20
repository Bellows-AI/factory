import type { ReactNode } from 'react';
import { wallClock } from '../format.js';
import { KeyValues } from '../components/KeyValues.js';
import type { Job } from '../api/useJobs.js';
import {
    closureOf,
    gateCounts,
    isHttpUrl,
    issueUrl,
    newestTerminalExit,
    threadContextTokens,
    threadCostUsd,
    threadIssue,
    threadPublish,
} from '../task-outcome.js';

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');

/**
 * The task page's outcome summary: one compact answer to "what happened, and where" — the
 * result, the execution's facts, the verification's count, the published work and the declared
 * services — derived from what the board already carries. The derivations live in
 * `task-outcome.ts` (pure, panel-free); this panel only formats and renders them.
 *
 * Everything here is either what the board reports or a blank. A value the board does not carry
 * omits its row entirely (a dash reads as a measurement, and nothing was measured — issue 100),
 * and a whole group with no rows omits its heading. There is deliberately no PR state: the
 * publish line the driver appends carries a branch and maybe a url, and no source records a
 * PR's state, so no row claims one.
 */
export function TaskOutcome({ jobs }: { jobs: Job[] }) {
    const root = jobs[0] as Job;
    const latest = jobs[jobs.length - 1] as Job;
    // A run that is not going must not show a ticking clock: queued has no attempt yet, and a
    // parked one would count wall-clock time while nothing runs.
    const running = latest.status === 'running';
    const parked = latest.status === 'queued' || latest.status === 'standby';
    const closure = closureOf(jobs);
    const publish = threadPublish(jobs);
    const issue = threadIssue(jobs);
    const context = threadContextTokens(jobs);
    const cost = threadCostUsd(jobs);
    const exit = newestTerminalExit(jobs);
    const counts = gateCounts(latest.gates);
    const services = latest.runtime?.services ?? null;
    const issueLink = issueUrl(latest.repo, issue);

    /** A row the board cannot fill is no row: empty values are filtered, not rendered blank. */
    const pairs = (list: [string, ReactNode][]): [string, ReactNode][] => list.filter(([, value]) => value !== null);

    const resultPairs = pairs([
        // Who queued the task, resolved server-side from the audit rows. 'unknown' is the honest
        // answer for a pre-accounts row; the avatar renders only when the account carries one.
        [
            'Started by',
            root.author !== null ? (
                <span className="by-user-user">
                    {root.author.avatarUrl !== null ? (
                        <img className="task-avatar" src={root.author.avatarUrl} alt="" />
                    ) : null}
                    {root.author.name ?? root.author.login}
                </span>
            ) : (
                'unknown'
            ),
        ],
        // The thread's whole banked clock, plus the newest run's live segment while it goes.
        ['Wall clock', wallClock(latest.taskWallClockMs, running && !parked ? latest.startedAt : null)],
    ]);

    const executionPairs = pairs([
        ['Repository', latest.repo],
        ['Worktree', latest.workspacePath],
        // A run without a recorded executor ran the default one — a fact, not an omission.
        ['Executor', latest.executor ?? 'Default executor'],
        ['Workflow', latest.workflowName ?? null],
        ['Workflow node', latest.workflowNode],
        ['Context', context !== null ? `${tokenCount.format(context)} tok` : null],
        ['Cost', cost !== null ? `$${cost.toFixed(4)}` : null],
    ]);

    return (
        <details className="task-outcome panel" open>
            <summary className="task-outcome-summary">
                <h2>Outcome</h2>
            </summary>
            <div className="task-outcome-body">
                <section>
                    <h3 className="task-outcome-label">Result</h3>
                    <p className="msg-meta">
                        <span className="pill">{latest.status}</span>
                        {latest.doneAt !== null ? <span className="pill chat-done">done</span> : null}
                        {closure !== null && closure.kind !== 'done' ? (
                            <span className="pill chat-stop">
                                {closure.kind === 'stopped' ? 'stopped by' : 'stop requested by'} {closure.login}
                            </span>
                        ) : null}
                        {closure !== null && closure.kind === 'done' ? (
                            <span className="pill chat-done">done by {closure.login}</span>
                        ) : null}
                        {exit !== null ? <span className="chat-exit">exit {exit}</span> : null}
                    </p>
                    {resultPairs.length > 0 ? <KeyValues pairs={resultPairs} /> : null}
                </section>
                {executionPairs.length > 0 ? (
                    <section>
                        <h3 className="task-outcome-label">Execution</h3>
                        <KeyValues pairs={executionPairs} />
                    </section>
                ) : null}
                {latest.gates != null && latest.gates.length > 0 ? (
                    <section>
                        <h3 className="task-outcome-label">Verification</h3>
                        {/* Words carry the meaning — the pills' tint is never the only signal.
                            The output stays on the run that produced it; this is the count. */}
                        <p className="msg-meta">
                            <span className="pill gate-passed">{counts.passed} passed</span>
                            <span className="pill gate-failed">{counts.failed} failed</span>
                            <span className="pill gate-running">{counts.running} running</span>
                        </p>
                        {/* Straight to the newest run's checks — the anchor is a focus target on
                        the run's own region, so keyboard and pointer land in the same place. */}
                        <a
                            href={`#run-${jobs.length}-checks`}
                            onClick={() =>
                                (document.getElementById(`run-${jobs.length}-checks`) as HTMLElement | null)?.focus()
                            }
                        >
                            View checks in run {jobs.length}
                        </a>
                    </section>
                ) : null}
                {publish !== null || issue !== null ? (
                    <section>
                        <h3 className="task-outcome-label">Published work</h3>
                        <KeyValues
                            pairs={pairs([
                                ['Branch', publish !== null ? <code>{publish.branch}</code> : null],
                                [
                                    'Pull request',
                                    publish !== null && publish.url !== null && isHttpUrl(publish.url) ? (
                                        // A new window, not a navigation over the dashboard, and
                                        // rel=noopener/noreferrer so the opened PR cannot reach
                                        // back into this tab.
                                        <a href={publish.url} target="_blank" rel="noopener noreferrer">
                                            Open pull request
                                        </a>
                                    ) : null,
                                ],
                                [
                                    'Issue',
                                    issue !== null && issueLink !== null ? (
                                        <a href={issueLink} target="_blank" rel="noopener noreferrer">
                                            Open issue #{issue}
                                        </a>
                                    ) : issue !== null ? (
                                        `#${issue}`
                                    ) : null,
                                ],
                            ])}
                        />
                    </section>
                ) : null}
                {services !== null && services.length > 0 ? (
                    <section>
                        <h3 className="task-outcome-label">Services</h3>
                        {/* The newest attempt's last observed states — the fleet is torn down when
                        the attempt ends, so these are its record of it, not a claim about now. */}
                        <KeyValues
                            pairs={services
                                .slice(0, 3)
                                .map((service) => [service.name, service.state] as [string, ReactNode])}
                        />
                        {services.length > 3 ? <p className="muted">and {services.length - 3} more</p> : null}
                    </section>
                ) : null}
            </div>
        </details>
    );
}
