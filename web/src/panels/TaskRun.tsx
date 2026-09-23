import type { Ref } from 'react';
import { isTerminal, type GateCheck, type Job, type RuntimeVitals } from '../api/useJobs.js';
import { runDuration, timestamp } from '../format.js';
import { isHttpUrl, prNumber, publicationForRun } from '../task-outcome.js';

/**
 * One output well: a clipped log a keyboard user can actually reach. The wrapping section names
 * the region; the `pre` carries the focus, because it is the element that scrolls — keyboard
 * scroll chains walk up from the focused element, never down into a descendant.
 */
function OutputWell({
    text,
    labelled = false,
    liveRef,
}: {
    text: string;
    labelled?: boolean;
    liveRef?: Ref<HTMLPreElement> | undefined;
}) {
    return (
        <section className="run-well" aria-label={labelled ? 'Raw output' : undefined}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable */}
            <pre className="chat-output" tabIndex={0} ref={liveRef}>
                {text}
            </pre>
        </section>
    );
}

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');

/**
 * One run's verification gates, as the reader meets them: a collapsible "Checks" list, one row
 * per gate with its status, each row expanding to the gate's output.
 *
 * Native `<details>`, deliberately: collapsible with zero JavaScript, and visible to the
 * render-to-string suite. There is deliberately no history control — the board stores the
 * current/last state only, so the list is exactly what this run last reported.
 */
function Checks({ gates }: { gates: GateCheck[] }) {
    return (
        <details className="chat-gates">
            <summary>
                Checks{' '}
                <span className="pill gate-passed">{gates.filter((g) => g.status === 'passed').length} passed</span>
                <span className="pill gate-failed">{gates.filter((g) => g.status === 'failed').length} failed</span>
                <span className="pill gate-running">{gates.filter((g) => g.status === 'running').length} running</span>
            </summary>
            <ul className="chat-gate-list">
                {gates.map((gate) => (
                    <li key={gate.name}>
                        <details>
                            <summary>
                                <span>{gate.name}</span>
                                <span className={`pill gate-${gate.status}`}>{gate.status}</span>
                                {gate.exitCode !== null ? (
                                    <span className="chat-exit">exit {gate.exitCode}</span>
                                ) : null}
                            </summary>
                            {gate.output !== null ? <OutputWell text={gate.output} /> : null}
                        </details>
                    </li>
                ))}
            </ul>
        </details>
    );
}

/**
 * The running attempt's sampled container vitals — CPU and memory — rendered while the run goes
 * only. A finished run's last sample is a post-mortem detail; the verdict and the exit code are
 * what the reader wants there, and a stale "cpu 167%" beside them lies about a run that is no
 * longer going. Null — or absent — numbers mean the sample could not read them this round: no
 * pills rather than pills that lie with zeros.
 */
function Runtime({ runtime }: { runtime: RuntimeVitals }) {
    if (runtime.cpuPercent == null && runtime.memUsedMb == null) return null;
    return (
        <p className="chat-runtime">
            {runtime.cpuPercent != null ? <span className="pill">cpu {Math.round(runtime.cpuPercent)}%</span> : null}
            {runtime.memUsedMb != null ? (
                <span className="pill">
                    mem {Math.round(runtime.memUsedMb)} MiB
                    {runtime.memPercent != null ? ` (${Math.round(runtime.memPercent)}%)` : ''}
                </span>
            ) : null}
        </p>
    );
}

/**
 * The agent response/activity body: a terminal run's summary and raw output, or a live run's
 * vitals, activity line and output tail. Split out of `TaskRun` — the nested "which branch of the
 * run's life is this" choice was the bulk of its cognitive complexity.
 */
function RunResponseBody({
    terminal,
    job,
    liveRef,
}: {
    terminal: boolean;
    job: Job;
    liveRef?: Ref<HTMLPreElement> | undefined;
}) {
    const hasOutput = job.output !== null;
    if (!terminal) {
        return (
            <>
                {job.status === 'running' && job.runtime ? <Runtime runtime={job.runtime} /> : null}
                {job.status === 'running' && job.runtime?.activity != null ? (
                    <p className="chat-activity">{job.runtime.activity}</p>
                ) : null}
                {hasOutput ? (
                    <OutputWell text={job.output!} labelled liveRef={liveRef} />
                ) : (
                    <p className="muted">Waiting for the executor…</p>
                )}
            </>
        );
    }
    if (job.summary !== null) {
        return (
            <>
                {/* The agent's own last words, flowing text — never a log wall. */}
                <p className="run-summary">{job.summary}</p>
                {hasOutput ? (
                    <details className="run-output">
                        <summary>View raw output</summary>
                        <OutputWell text={job.output!} labelled />
                    </details>
                ) : null}
            </>
        );
    }
    if (hasOutput) {
        return (
            <>
                <p className="muted">No agent summary was captured.</p>
                <details className="run-output" open>
                    <summary>View raw output</summary>
                    <OutputWell text={job.output!} labelled />
                </details>
            </>
        );
    }
    return (
        <p className="muted">
            This run finished without a captured agent response. Check its exit status and checks below.
        </p>
    );
}

/**
 * The run's checks-and-published-work block: present when there are gates, a publication, or
 * both; absent otherwise. Split out of `TaskRun` for the same reason as `RunResponseBody`.
 */
function RunChecksAndPublish({
    index,
    gates,
    publish,
}: {
    index: number;
    gates: GateCheck[] | null;
    publish: { branch: string; url: string | null } | null;
}) {
    const hasGates = gates !== null && gates.length > 0;
    if (!hasGates && publish === null) return null;
    return (
        <div className="run-work" id={`run-${index}-checks`} tabIndex={-1}>
            <p className="run-label">Checks and published work</p>
            {hasGates ? <Checks gates={gates} /> : null}
            {publish !== null ? <Publication publish={publish} /> : null}
        </div>
    );
}

const COST_DECIMAL_PLACES = 4;

/**
 * The run's quiet metadata footer: status, timestamps, attribution — everything that follows the
 * work it describes rather than leading the article. Split out of `TaskRun` because its many
 * independent fields were the rest of its cognitive complexity.
 */
function RunMetaFooter({ job, parked }: { job: Job; parked: boolean }) {
    return (
        <p className="msg-meta">
            <span className="pill">{job.status}</span>
            <span className="muted">{timestamp(job.createdAt)}</span>
            {job.executor !== null ? <span className="muted">{job.executor}</span> : null}
            {job.workflowName != null ? <span className="muted">workflow {job.workflowName}</span> : null}
            {job.workflowNode !== null ? <span className="muted">node {job.workflowNode}</span> : null}
            {!parked ? <span className="muted">{runDuration(job.startedAt, job.finishedAt)}</span> : null}
            {job.exitCode !== null ? <span className="chat-exit">exit {job.exitCode}</span> : null}
            {job.runtime?.contextTokens != null ? (
                <span className="chat-activity">
                    ctx {tokenCount.format(job.runtime.contextTokens)} tok
                    {job.runtime.costUsd != null && job.runtime.costUsd > 0
                        ? ` · $${job.runtime.costUsd.toFixed(COST_DECIMAL_PLACES)}`
                        : ''}
                </span>
            ) : null}
            {job.stoppedBy !== null ? (
                <span className="pill chat-stop">
                    {job.status === 'stopped' ? 'stopped by' : 'stop requested by'} {job.stoppedBy.login}
                </span>
            ) : null}
            {job.doneAt !== null ? <span className="pill chat-done">done</span> : null}
            {job.doneBy !== null ? <span className="pill chat-done">done by {job.doneBy.login}</span> : null}
        </p>
    );
}

/**
 * One run of the conversation, as one article with a fixed reading order: the request, the
 * agent's response (or its live activity), the checks and published work this run produced, and
 * a quiet metadata footer last. The stored `summary` is the terminal response; raw output is
 * untrusted text in a labelled, keyboard-scrollable well, collapsed behind a finished run's
 * summary and expanded when it is all there is. `liveRef` lands on the newest non-terminal
 * run's output pre, so the page can follow the tail — the ref and its effect live in the page's
 * panel, not here.
 */
export function TaskRun({
    job,
    index,
    liveRef,
}: {
    /** The run's row. */
    job: Job;
    /** The run's 1-based position in the oldest-first chain — names the request and the anchor. */
    index: number;
    /** Ref for the newest non-terminal run's output pre; absent everywhere else. */
    liveRef?: Ref<HTMLPreElement> | undefined;
}) {
    const terminal = isTerminal(job.status);
    const parked = job.status === 'queued';
    const gates = job.gates ?? null;
    const publish = publicationForRun(job);
    return (
        <article className="chat-exchange">
            <p className="run-label">{index === 1 ? 'Request' : 'Follow-up'}</p>
            {/* The member's words are prose, not code: normal text with its line breaks kept. */}
            <p className="msg-user">{job.command}</p>
            <p className="run-label">{terminal ? 'Agent response' : 'Agent activity'}</p>
            <RunResponseBody terminal={terminal} job={job} liveRef={liveRef} />
            <RunChecksAndPublish index={index} gates={gates} publish={publish} />
            <RunMetaFooter job={job} parked={parked} />
        </article>
    );
}

/**
 * One run's publish line: the branch code-styled, the PR linked only when its url is safe. The
 * line carries no label of its own, so the link says what it is — `Pull request #<n>`, a
 * reference, never a CTA verbatim.
 */
function Publication({ publish }: { publish: { branch: string; url: string | null } }) {
    const url = publish.url !== null && isHttpUrl(publish.url) ? publish.url : null;
    const number = url !== null ? prNumber(url) : null;
    return (
        <p className="run-publish">
            <code>{publish.branch}</code>
            {url !== null ? (
                // A new window, not a navigation over the dashboard, and rel=noopener/noreferrer
                // so the opened PR cannot reach back into this tab.
                <a href={url} target="_blank" rel="noopener noreferrer">
                    {number !== null ? `Pull request #${number}` : 'Pull request'}
                </a>
            ) : null}
        </p>
    );
}
