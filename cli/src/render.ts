import type { BoardJobRecord, ConnectionView, JobDone, JobRemoved, JobStopped, SkillView } from './board.js';
import type { ExecutorRow, RepoDiscovery } from './discovery.js';

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

/** Repo discovery: one row per repo, visible and synced marked, a note when the list may be thin. */
export function renderRepos(discovery: RepoDiscovery): string {
    const lines = discovery.repos.map((row) => {
        const visibility = row.private === null ? DASH : row.private ? 'private' : 'public';
        return [
            row.repo,
            row.visible ? 'visible' : 'not-visible',
            row.synced ? `synced(${row.syncStatus ?? DASH})` : 'not-synced',
            visibility,
            row.defaultBranch ?? DASH,
        ].join('  ');
    });
    if (discovery.error) lines.push(`note: the repository list may be stale — ${discovery.error}`);
    if (!discovery.workspaceEnabled) lines.push('note: this board has no workspace root, so nothing can be synced');
    return lines.length === 0 ? 'no repositories visible' : lines.join('\n');
}

/** Executor discovery: scope, name, type, and the flags a selection cares about. */
export function renderExecutors(executors: readonly ExecutorRow[]): string {
    if (executors.length === 0) return 'no executors';
    return executors
        .map((row) =>
            [
                row.scope,
                row.name,
                row.type,
                row.suspended ? 'suspended' : 'active',
                ...(row.default ? ['default'] : []),
            ].join('  ')
        )
        .join('\n');
}

/** Installed skills with what each requires — env NAMES and managed-connection selectors only. */
export function renderSkills(skills: readonly SkillView[]): string {
    if (skills.length === 0) return 'no skills installed';
    return skills
        .map((skill) => {
            const needs = [
                ...skill.requires.tools.map((tool) => `tool:${tool}`),
                ...skill.requires.connections.map(
                    (connection) =>
                        `connection:${connection.name}${connection.selectedBy ? ` (select ${connection.selectedBy})` : ''}`
                ),
            ];
            return `${skill.name}  ${skill.description}${needs.length > 0 ? `  [requires ${needs.join(', ')}]` : ''}`;
        })
        .join('\n');
}

/** Selectable managed connections: the id is what `--jira-connection` takes. */
export function renderConnections(connections: readonly ConnectionView[]): string {
    if (connections.length === 0) return 'no connections available';
    return connections
        .map((c) => [c.id, c.kind, c.scope, c.access, c.site, c.email, c.createdAt].join('  '))
        .join('\n');
}
