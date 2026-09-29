import { type Ref, useEffect, useRef, useState } from 'react';
import { isTerminal, type GateCheck, type Job, type RuntimeVitals } from '../api/useJobs.js';
import { Icon } from '../components/Icon.js';
import { runDuration, timestamp } from '../format.js';
import { FAILURE_KIND_LABEL, GATE_PILL, gateCounts, isHttpUrl, prNumber, type ThreadPublish } from '../task-outcome.js';

/**
 * One output well: a clipped log a keyboard user can actually reach. The wrapping section names
 * the region; the `pre` carries the focus, because it is the element that scrolls — keyboard
 * scroll chains walk up from the focused element, never down into a descendant. `gate` is a
 * verification gate's variant: sunken, lines kept whole and scrolled.
 */
function OutputWell({
    text,
    label,
    gate = false,
    liveRef,
}: {
    text: string;
    label?: string;
    gate?: boolean;
    liveRef?: Ref<HTMLPreElement> | undefined;
}) {
    return (
        <section className="run-well" aria-label={label}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable */}
            <pre className={gate ? 'chat-output gate-output' : 'chat-output'} tabIndex={0} ref={liveRef}>
                {text}
            </pre>
        </section>
    );
}

/** `90433` reads as one number, not four; the locale is pinned so the suite can pin the markup. */
const tokenCount = new Intl.NumberFormat('en-US');

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
                    <OutputWell text={job.output!} label="Raw output" liveRef={liveRef} />
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
                        <OutputWell text={job.output!} label="Raw output" />
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
                    <OutputWell text={job.output!} label="Raw output" />
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
            {/* The structured terminal reason (issue 339): the one-glance answer to "why did it
                fail", instead of making the reader scan the output tail for the driver's note. */}
            {job.failureKind != null ? (
                <span className="pill pill-bad">{FAILURE_KIND_LABEL[job.failureKind]}</span>
            ) : null}
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
 * agent's response (or its live activity), and a quiet metadata footer last. The stored `summary`
 * is the terminal response; raw output is untrusted text in a labelled, keyboard-scrollable well,
 * collapsed behind a finished run's summary and expanded when it is all there is — never a
 * fabricated response. `liveRef` lands on the newest non-terminal run's output pre, so the page
 * can follow the tail — the ref and its effect live in the page's panel, not here. Verification
 * and published work are the task's, not a run's: `TaskDetail` renders them once, below.
 */
export function TaskRun({
    job,
    index,
    liveRef,
}: {
    /** The run's row. */
    job: Job;
    /** The run's 1-based position in the oldest-first chain — names the request. */
    index: number;
    /** Ref for the newest non-terminal run's output pre; absent everywhere else. */
    liveRef?: Ref<HTMLPreElement> | undefined;
}) {
    const terminal = isTerminal(job.status);
    const parked = job.status === 'queued';
    return (
        <article className="chat-exchange">
            <p className="run-label">{index === 1 ? 'Request' : 'Follow-up'}</p>
            {/* The member's words are prose, not code: normal text with its line breaks kept. */}
            <p className="msg-user">{job.command}</p>
            <p className="run-label">{terminal ? 'Agent response' : 'Agent activity'}</p>
            <RunResponseBody terminal={terminal} job={job} liveRef={liveRef} />
            <RunMetaFooter job={job} parked={parked} />
        </article>
    );
}

/** How long the Copied acknowledgement stays before the button reads Copy again. */
const COPIED_RESET_MS = 2000;

/**
 * Copies `text` to the clipboard. A refused clipboard leaves the button reading Copy — the text
 * is still on screen to select by hand. The accessible name says WHAT it copies. One reset timer
 * at a time, cleared on unmount, so a repeat click or a navigation never lands a stale reset.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (reset.current !== null) clearTimeout(reset.current);
        },
        []
    );
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            if (reset.current !== null) clearTimeout(reset.current);
            reset.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        } catch {
            setCopied(false);
        }
    };
    return (
        <button type="button" className="chat-resume task-copy" aria-label={label} onClick={() => void copy()}>
            <Icon name="copy" size={14} />
            {copied ? 'Copied' : 'Copy'}
        </button>
    );
}

/** The verification panel's id — the outcome rail's "View checks" link lands focus here. */
export const VERIFICATION_ID = 'task-verification';

/** Gate outcomes in reading order: what failed first, then what passed, then what is still going. */
const GATE_ORDER: readonly GateCheck['status'][] = ['failed', 'passed', 'running'];

/**
 * The count pills: one per outcome that happened, words carrying the meaning — the tint is never
 * the only signal, and a zero is never drawn at all ("0 failed" is no news).
 */
export function GateCountPills({ gates }: { gates: GateCheck[] | null | undefined }) {
    const counts = gateCounts(gates);
    return (
        <>
            {GATE_ORDER.filter((status) => counts[status] > 0).map((status) => (
                <span key={status} className={GATE_PILL[status]}>
                    {counts[status]} {status}
                </span>
            ))}
        </>
    );
}

/**
 * The task's verification: the newest run's gates, as the board last reported them — there is no
 * history and no per-test tree, because the board stores neither. Each gate is a native
 * `<details>` (collapsible with no JavaScript, visible to the render-to-string suite); a failed
 * gate starts open, because its output is what the reader came for. The output is the gate's own
 * mono well with its own scroll and a copy button.
 */
export function Verification({ gates }: { gates: GateCheck[] }) {
    return (
        <section className="panel task-verification" id={VERIFICATION_ID} tabIndex={-1}>
            <div className="panel-head">
                <h2>Verification</h2>
                <p className="task-verification-counts">
                    <GateCountPills gates={gates} />
                </p>
            </div>
            <ul className="chat-gate-list">
                {gates.map((gate) => (
                    <li key={gate.name}>
                        <details open={gate.status === 'failed'}>
                            <summary>
                                <span>{gate.name}</span>
                                <span className={GATE_PILL[gate.status]}>{gate.status}</span>
                                {gate.exitCode !== null ? (
                                    <span className="chat-exit">exit {gate.exitCode}</span>
                                ) : null}
                            </summary>
                            {gate.output !== null ? (
                                <div className="gate-output-wrap">
                                    <CopyButton text={gate.output} label={`Copy output of ${gate.name}`} />
                                    <OutputWell text={gate.output} label={`Output of ${gate.name}`} gate />
                                </div>
                            ) : null}
                        </details>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/**
 * The task's published work: the branch as a chip with its copy button, and the PR linked only
 * when its url is one the reader can safely open (`isHttpUrl`) — nothing a run echoed becomes a
 * handler href. The link says what it is — `Pull request #<n>`, a reference, never a CTA.
 */
export function Publication({ publish }: { publish: ThreadPublish }) {
    const url = publish.url !== null && isHttpUrl(publish.url) ? publish.url : null;
    const number = url !== null ? prNumber(url) : null;
    return (
        <section className="panel task-published">
            <div className="panel-head">
                <h2>Published work</h2>
            </div>
            <p className="run-publish">
                <code className="task-branch">
                    <Icon name="git-branch" size={14} />
                    {publish.branch}
                </code>
                <CopyButton text={publish.branch} label="Copy branch name" />
                {url !== null ? (
                    // A new window, not a navigation over the dashboard, and rel=noopener/noreferrer
                    // so the opened PR cannot reach back into this tab.
                    <a href={url} target="_blank" rel="noopener noreferrer">
                        {number !== null ? `Pull request #${number}` : 'Pull request'}
                    </a>
                ) : null}
            </p>
        </section>
    );
}
