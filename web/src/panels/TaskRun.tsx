import type { Ref } from 'react';
import { isTerminal, type GateCheck, type Job, type RuntimeVitals } from '../api/useJobs.js';
import { runDuration, timestamp } from '../format.js';
import { isHttpUrl, publicationForRun } from '../task-outcome.js';

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
                            {gate.output !== null ? <pre className="chat-output">{gate.output}</pre> : null}
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
    const parked = job.status === 'queued' || job.status === 'standby';
    const hasOutput = job.output !== null;
    const gates = job.gates ?? null;
    const publish = publicationForRun(job);
    return (
        <article className="chat-exchange" key={job.id}>
            <p className="run-label">{index === 1 ? 'Request' : 'Follow-up'}</p>
            {/* The member's words are prose, not code: normal text with its line breaks kept. */}
            <p className="msg-user">{job.command}</p>
            <p className="run-label">{terminal ? 'Agent response' : 'Agent activity'}</p>
            {terminal ? (
                job.summary !== null ? (
                    <>
                        {/* The agent's own last words, flowing text — never a log wall. */}
                        <p className="run-summary">{job.summary}</p>
                        {hasOutput ? (
                            <details className="run-output">
                                <summary>View raw output</summary>
                                <pre className="chat-output">{job.output}</pre>
                            </details>
                        ) : null}
                    </>
                ) : hasOutput ? (
                    <>
                        <p className="muted">No agent summary was captured.</p>
                        <details className="run-output" open>
                            <summary>View raw output</summary>
                            <pre className="chat-output">{job.output}</pre>
                        </details>
                    </>
                ) : (
                    <p className="muted">
                        This run finished without a captured agent response. Check its exit status and checks below.
                    </p>
                )
            ) : (
                <>
                    {job.status === 'running' && job.runtime ? <Runtime runtime={job.runtime} /> : null}
                    {job.status === 'running' && job.runtime?.activity != null ? (
                        <p className="chat-activity">{job.runtime.activity}</p>
                    ) : null}
                    {hasOutput ? (
                        <pre ref={liveRef} className="chat-output">
                            {job.output}
                        </pre>
                    ) : (
                        <p className="muted">Waiting for the executor…</p>
                    )}
                </>
            )}
            {gates !== null && gates.length > 0 ? (
                <div className="run-work" id={`run-${index}-checks`} tabIndex={-1}>
                    <p className="run-label">Checks and published work</p>
                    <Checks gates={gates} />
                    {publish !== null ? <Publication publish={publish} /> : null}
                </div>
            ) : publish !== null ? (
                <div className="run-work" id={`run-${index}-checks`} tabIndex={-1}>
                    <p className="run-label">Checks and published work</p>
                    <Publication publish={publish} />
                </div>
            ) : null}
            <p className="msg-meta">
                {/* The quiet footer: metadata follows the work it describes, in reading order —
                status first, attribution last. Nothing here leads the article. */}
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
                            ? ` · $${job.runtime.costUsd.toFixed(4)}`
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
                {job.status === 'standby' ? <span className="pill">parked</span> : null}
            </p>
        </article>
    );
}

/** One run's publish line: the branch code-styled, the PR linked only when its url is safe. */
function Publication({ publish }: { publish: { branch: string; url: string | null } }) {
    return (
        <p className="run-publish">
            <code>{publish.branch}</code>
            {publish.url !== null && isHttpUrl(publish.url) ? (
                // A new window, not a navigation over the dashboard, and rel=noopener/noreferrer
                // so the opened PR cannot reach back into this tab.
                <a href={publish.url} target="_blank" rel="noopener noreferrer">
                    Open pull request
                </a>
            ) : null}
        </p>
    );
}
