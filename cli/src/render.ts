import type { BoardJobRecord, JobDone, JobRemoved, JobStopped } from './board.js';

/**
 * Human renderers for the lifecycle commands. Pure text in, text out — no board access, no console:
 * `run.ts` routes every string through the writers it was handed, so tests can read what would
 * have been printed. `--json` bypasses all of this and prints the payloads as JSON instead.
 */

/** Where a list row cuts the command off — a preview, not the record. */
const COMMAND_PREVIEW_LIMIT = 80;
/** How many trailing lines of a run's output tail one block prints. */
const OUTPUT_TAIL_LINES = 40;
/** What every absent field renders as — null is "not there", and that is worth saying. */
const DASH = '-';
/** The column every detail field label is padded to, so the values line up. */
const LABEL_WIDTH = 10;

/** The one-line answer to a create: the 201 body is exactly these two fields. */
export function renderCreated(created: { id: string; status: string }): string {
    return `${created.status} ${created.id}`;
}

/**
 * The answer to a stop, and the two fates it has. A 202 leaves the run alive under its worker,
 * so "stopped" would be a lie: the stamp is what happened, and the settle lands moments later.
 */
export function renderStopped(stopped: JobStopped): string {
    if (stopped.cancelRequestedAt) {
        return `stop requested ${stopped.cancelRequestedAt} ${stopped.id} — the worker settles it at its next heartbeat`;
    }
    return `${stopped.status} ${stopped.id}`;
}

/** The answer to a done: the user's stamp, beside the run's own untouched verdict. */
export function renderDone(done: JobDone): string {
    return `done ${done.doneAt ?? DASH} ${done.id} (run ${done.status})`;
}

/** The answer to a remove. The thread is gone, so the id is all there is left to name. */
export function renderRemoved(removed: JobRemoved): string {
    return `removed ${removed.id}`;
}

function commandPreview(command: string): string {
    if (command.length <= COMMAND_PREVIEW_LIMIT) return command;
    return `${command.slice(0, COMMAND_PREVIEW_LIMIT)}…`;
}

/** One list row: id, status, created, repo, command preview — the board listing, one line each. */
export function renderJobLine(job: BoardJobRecord): string {
    return [job.id, job.status, job.createdAt, job.repo ?? DASH, commandPreview(job.command)].join('  ');
}

function field(label: string, value: string | number | null): string {
    return `${label.padEnd(LABEL_WIDTH)}${value ?? DASH}`;
}

function outputTail(output: string | null): string[] {
    if (!output) return [];
    return output.split('\n').slice(-OUTPUT_TAIL_LINES);
}

function outputBlock(output: string | null): string[] {
    const tail = outputTail(output);
    if (tail.length === 0) return [field('output:', DASH)];
    return ['output:', ...tail.map((line) => `  ${line}`)];
}

/** The detail read's block: status, command, authorship, timing, session, gates and the tail. */
export function renderJobDetail(job: BoardJobRecord): string {
    const lines = [
        field('id:', job.id),
        field('status:', job.status),
        field('command:', job.command),
        field('repo:', job.repo),
        field('executor:', job.executor),
        field('scope:', job.executorScope ?? null),
        field('mode:', job.mode),
        field('author:', job.author?.login ?? null),
        field('created:', job.createdAt),
        field('started:', job.startedAt),
        field('finished:', job.finishedAt),
        field('session:', job.sessionId),
        field('exit:', job.exitCode),
        // Why a FAILED run failed (issue #339) — the verdict's structured half.
        field('failure:', job.failureKind),
        // The run's last words: what was done, beside the command that asked for it.
        field('summary:', job.summary),
    ];
    const gates = job.gates ?? [];
    if (gates.length === 0) lines.push(field('gates:', DASH));
    for (const gate of gates) lines.push(field('gates:', `${gate.name} ${gate.status}`));
    lines.push(...outputBlock(job.output));
    return lines.join('\n');
}

/** One thread member: the conversation's every command, verdict, session id and output tail. */
export function renderThreadMember(job: BoardJobRecord, index: number): string {
    return [
        `#${index + 1} ${job.id}`,
        field('status:', job.status),
        field('command:', job.command),
        field('session:', job.sessionId),
        field('summary:', job.summary),
        ...outputBlock(job.output),
    ].join('\n');
}

/** The thread read's block, oldest first — the order the board already answers with. */
export function renderThread(jobs: readonly BoardJobRecord[]): string {
    const lines = [`thread (${jobs.length}):`];
    for (const [index, job] of jobs.entries()) {
        if (index > 0) lines.push('');
        lines.push(renderThreadMember(job, index));
    }
    return lines.join('\n');
}
