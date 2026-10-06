import type { ReactNode } from 'react';
import { wallClock } from '../format.js';
import { PRODUCT_NAME } from '../brand.js';
import { KeyValues } from '../components/KeyValues.js';
import { RelativeTime } from '../components/RelativeTime.js';
import type { AuthorRef, GateCheck, Job } from '../api/useJobs.js';
import {
    closureOf,
    type FollowUpViewer,
    followUpEligibility,
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
import { focusFollowUp, needsAnotherPass, notAuthorMessage, TaskStatePill } from './TaskHeader.js';
import { GateCountPills, VERIFICATION_ID } from './TaskRun.js';

/**
 * A failure's next step, in the rail a narrow screen reads first: Ask for another pass when the
 * viewer may send one, else why not — in the follow-up slot's own words. Nothing while the
 * session loads, and nothing on a task that is not a failure the member can answer.
 */
function NextActionSection({ latest, viewer }: { latest: Job; viewer: FollowUpViewer }) {
    if (!needsAnotherPass(latest)) return null;
    const eligibility = followUpEligibility(latest, viewer);
    let body: ReactNode = null;
    if (eligibility === 'eligible') {
        body = (
            <button type="button" className="primary" onClick={focusFollowUp}>
                Ask for another pass
            </button>
        );
    } else if (eligibility === 'not-author') {
        body = <p className="muted">{notAuthorMessage(latest)}</p>;
    }
    if (body === null) return null;
    return (
        <section>
            <h3 className="task-outcome-label">Next action</h3>
            {body}
        </section>
    );
}

/** The Result section: status pills, who started it, and how it closed. Split out of
 * `TaskOutcome` so its own ternary chain does not add to the parent's cognitive complexity. */
function ResultSection({
    jobs,
    closure,
    exit,
    resultPairs,
    waiting,
}: {
    /** The whole thread: the pill reads a question on any run, the rest reads the newest. */
    jobs: Job[];
    closure: Closure | null;
    exit: number | null;
    resultPairs: [string, ReactNode][];
    /** An open PR-review wait (206) says what it waits for; a terminal one says why it ended. */
    waiting: boolean;
}) {
    const latest = jobs[jobs.length - 1] as Job;
    return (
        <section>
            <h3 className="task-outcome-label">Result</h3>
            <p className="msg-meta">
                <TaskStatePill jobs={jobs} />
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
                    {PRODUCT_NAME} is waiting for review — no executor is occupied while it waits. Waiting since{' '}
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

/** The Verification section: the newest run's gate counts — only what happened — and a link to
 * the verification panel in the main column, which carries each gate's output. Split out of
 * `TaskOutcome` for the same reason as `ResultSection`. */
function VerificationSection({ gates }: { gates: GateCheck[] }) {
    return (
        <section>
            <h3 className="task-outcome-label">Verification</h3>
            <p className="msg-meta">
                <GateCountPills gates={gates} />
            </p>
            {/* The anchor is a focus target on the panel itself, so keyboard and pointer land in
                the same place. */}
            <a href={`#${VERIFICATION_ID}`} onClick={() => document.getElementById(VERIFICATION_ID)?.focus()}>
                View checks
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
    // Keyed even though this is a label/value tuple list rather than a render list: the nodes
    // reach the DOM through `KeyValues`' own map, and an unkeyed element in an array is the
    // reconciliation bug React warns about whichever array it was built in.
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
export function TaskOutcome({ jobs, viewer }: { jobs: Job[]; viewer: FollowUpViewer }) {
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
        // The default workflow's gate-repair budget (issue #49): the frozen limit beside the
        // rounds the thread has already spent, so a rested thread shows why. Null (any
        // non-default workflow) and zero (repair off) render no row at all.
        [
            'Gate repair',
            latest.defaultGateFixRounds != null && latest.defaultGateFixRounds > 0
                ? `${jobs.filter((row) => row.workflowNode === 'gate-fix').length}/${latest.defaultGateFixRounds}`
                : null,
        ],
        ['Context', context !== null ? `${tokenCount.format(context)} tok` : null],
        ['Cost', cost !== null ? `$${cost.toFixed(COST_DECIMAL_PLACES)}` : null],
    ]);

    return (
        <details className="task-outcome panel" open>
            <summary className="task-outcome-summary">
                <h2>Outcome</h2>
            </summary>
            <div className="task-outcome-body">
                <ResultSection jobs={jobs} closure={closure} exit={exit} resultPairs={resultPairs} waiting={waiting} />
                <NextActionSection latest={latest} viewer={viewer} />
                {executionPairs.length > 0 ? (
                    <section>
                        <h3 className="task-outcome-label">Execution</h3>
                        <KeyValues pairs={executionPairs} />
                    </section>
                ) : null}
                {latest.gates != null && latest.gates.length > 0 ? <VerificationSection gates={latest.gates} /> : null}
                {publish !== null || issue !== null ? (
                    <PublishedWorkSection
                        publish={publish}
                        issue={issue}
                        issueLink={issueLink}
                        prLink={prLink}
                        prNr={prNr}
                    />
                ) : null}
            </div>
        </details>
    );
}
