import type { ReactNode } from 'react';
import { wallClock } from '../format.js';
import { KeyValues } from '../components/KeyValues.js';
import { RelativeTime } from '../components/RelativeTime.js';
import type { AuthorRef, Job } from '../api/useJobs.js';
import {
    closureOf,
    gateCounts,
    isHttpUrl,
    isWaitingForReview,
    issueUrl,
    newestTerminalExit,
    prNumber,
    threadContextTokens,
    threadCostUsd,
    threadIssue,
    threadPublish,
    type Closure,
    type ThreadPublish,
} from '../task-outcome.js';

/** The Result section: status pills, who started it, and how it closed. Split out of
 * `TaskOutcome` so its own ternary chain does not add to the parent's cognitive complexity. */
function ResultSection({
    latest,
    closure,
    exit,
    resultPairs,
    waiting,
}: {
    latest: Job;
    closure: Closure | null;
    exit: number | null;
    resultPairs: [string, ReactNode][];
    /** An open PR-review wait (206) relabels the pill; a terminal one leaves it be. */
    waiting: boolean;
}) {
    return (
        <section>
            <h3 className="task-outcome-label">Result</h3>
            <p className="msg-meta">
                <span className="pill">{waiting ? 'Waiting for review' : latest.status}</span>
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
            {waiting ? (
                <p className="muted">
                    Factory is waiting for review — no executor is occupied while it waits. Waiting since{' '}
                    <RelativeTime at={latest.waitingSince} />.
                </p>
            ) : null}
            {!waiting && latest.waitTerminalReason !== null ? (
                <p className="muted">Review wait ended: {latest.waitTerminalReason}.</p>
            ) : null}
            {resultPairs.length > 0 ? <KeyValues pairs={resultPairs} /> : null}
        </section>
    );
}

/** The Verification section: the gate pill counts and a link to the newest run's own checks.
 * Split out of `TaskOutcome` for the same reason as `ResultSection`. */
function VerificationSection({
    counts,
    runIndex,
}: {
    counts: { passed: number; failed: number; running: number };
    /** The newest run's 1-based position — the anchor `TaskRun` renders its checks under. */
    runIndex: number;
}) {
    return (
        <section>
            <h3 className="task-outcome-label">Verification</h3>
            {/* Words carry the meaning — the pills' tint is never the only signal. The output
                stays on the run that produced it; this is the count. */}
            <p className="msg-meta">
                <span className="pill gate-passed">{counts.passed} passed</span>
                <span className="pill gate-failed">{counts.failed} failed</span>
                <span className="pill gate-running">{counts.running} running</span>
            </p>
            {/* Straight to the newest run's checks — the anchor is a focus target on the run's
                own region, so keyboard and pointer land in the same place. */}
            <a
                href={`#run-${runIndex}-checks`}
                onClick={() => document.getElementById(`run-${runIndex}-checks`)?.focus()}
            >
                View checks in run {runIndex}
            </a>
        </section>
    );
}

/** The Published work section: branch, pull request and issue links. Split out of `TaskOutcome`
 * for the same reason as `ResultSection`. */
function PublishedWorkSection({
    publish,
    issue,
    issueLink,
    prLink,
    prNr,
}: {
    publish: ThreadPublish | null;
    issue: number | null;
    issueLink: string | null;
    prLink: string | null;
    prNr: number | null;
}) {
    const allRows: [string, ReactNode][] = [
        ['Branch', publish !== null ? <code>{publish.branch}</code> : null],
        [
            'Pull request',
            prLink !== null ? (
                // A new window, not a navigation over the dashboard, and rel=noopener/noreferrer
                // so the opened PR cannot reach back into this tab.
                <a href={prLink} target="_blank" rel="noopener noreferrer">
                    {prNr !== null ? `#${prNr}` : 'Pull request'}
                </a>
            ) : null,
        ],
        [
            'Issue',
            issue !== null && issueLink !== null ? (
                <a href={issueLink} target="_blank" rel="noopener noreferrer">
                    #{issue}
                </a>
            ) : issue !== null ? (
                `#${issue}`
            ) : null,
        ],
    ];
    const pairs = allRows.filter(([, value]) => value !== null);
    return (
        <section>
            <h3 className="task-outcome-label">Published work</h3>
            <KeyValues pairs={pairs} />
        </section>
    );
}

/** The task's queuer, resolved server-side from the audit rows. 'unknown' is the honest answer
 * for a pre-accounts row; the avatar renders only when the account carries one. */
function startedByNode(author: AuthorRef | null): ReactNode {
    if (author === null) return 'unknown';
    return (
        <span className="by-user-user">
            {author.avatarUrl !== null ? <img className="task-avatar" src={author.avatarUrl} alt="" /> : null}
            {author.name ?? author.login}
        </span>
    );
}

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');
const COST_DECIMAL_PLACES = 4;
/** The Services section shows only the first few rows; the rest collapse into a count. */
const MAX_VISIBLE_SERVICES = 3;

/** The Services section: the newest attempt's last observed states, capped and counted. Split
 * out of `TaskOutcome` for the same reason as `ResultSection`. */
function ServicesSection({ services }: { services: readonly { name: string; image: string; state: string }[] }) {
    const overflow = services.length - MAX_VISIBLE_SERVICES;
    return (
        <section>
            <h3 className="task-outcome-label">Services</h3>
            {/* The newest attempt's last observed states — the fleet is torn down when the
                attempt ends, so these are its record of it, not a claim about now. */}
            <KeyValues
                pairs={services
                    .slice(0, MAX_VISIBLE_SERVICES)
                    .map((service) => [service.name, service.state] as [string, ReactNode])}
            />
            {overflow > 0 ? <p className="muted">and {overflow} more</p> : null}
        </section>
    );
}

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
    // A run that is not going must not show a ticking clock: only a live attempt gets one.
    const running = latest.status === 'running';
    const closure = closureOf(jobs);
    const publish = threadPublish(jobs);
    const issue = threadIssue(jobs);
    const context = threadContextTokens(jobs);
    const cost = threadCostUsd(jobs);
    const exit = newestTerminalExit(jobs);
    const counts = gateCounts(latest.gates);
    const services = latest.runtime?.services ?? null;
    const issueLink = issueUrl(latest.repo, issue);
    const waiting = isWaitingForReview(latest);
    // A row's link is a reference, not a command: the row's label already says what it is, so
    // the value names only WHICH one — the number.
    const prLink = publish !== null && publish.url !== null && isHttpUrl(publish.url) ? publish.url : null;
    const prNr = prLink !== null ? prNumber(prLink) : null;

    /** A row the board cannot fill is no row: empty values are filtered, not rendered blank. */
    const pairs = (list: [string, ReactNode][]): [string, ReactNode][] => list.filter(([, value]) => value !== null);

    const resultPairs = pairs([
        ['Started by', startedByNode(root.author)],
        // The thread's whole banked clock, plus the newest run's live segment while it goes.
        ['Wall clock', wallClock(latest.taskWallClockMs, running ? latest.startedAt : null)],
    ]);

    const executionPairs = pairs([
        ['Repository', latest.repo],
        ['Worktree', latest.workspacePath],
        ['Executor', latest.executor ?? 'No executor selected'],
        ['Workflow', latest.workflowName],
        ['Workflow node', latest.workflowNode],
        ['Context', context !== null ? `${tokenCount.format(context)} tok` : null],
        ['Cost', cost !== null ? `$${cost.toFixed(COST_DECIMAL_PLACES)}` : null],
    ]);

    return (
        <details className="task-outcome panel" open>
            <summary className="task-outcome-summary">
                <h2>Outcome</h2>
            </summary>
            <div className="task-outcome-body">
                <ResultSection
                    latest={latest}
                    closure={closure}
                    exit={exit}
                    resultPairs={resultPairs}
                    waiting={waiting}
                />
                {executionPairs.length > 0 ? (
                    <section>
                        <h3 className="task-outcome-label">Execution</h3>
                        <KeyValues pairs={executionPairs} />
                    </section>
                ) : null}
                {latest.gates != null && latest.gates.length > 0 ? (
                    <VerificationSection counts={counts} runIndex={jobs.length} />
                ) : null}
                {publish !== null || issue !== null ? (
                    <PublishedWorkSection
                        publish={publish}
                        issue={issue}
                        issueLink={issueLink}
                        prLink={prLink}
                        prNr={prNr}
                    />
                ) : null}
                {services !== null && services.length > 0 ? <ServicesSection services={services} /> : null}
            </div>
        </details>
    );
}
