import { isTerminal, type GateCheck, type Job } from './api/useJobs.js';

/**
 * The outcome summary's raw material, as pure data — the panel formats, these decide. Everything
 * here reads the thread NEWEST first (the chain arrives oldest first), because the newest run is
 * the conversation's present tense. Data, not React nodes: a derivation that answers a number
 * stays honest in a test, and the panel decides how it reads.
 *
 * Moved here from the old `TaskSide` panel (issue 177), which could not stay a side column and a
 * data module at once; the derivations themselves keep the contracts their tests pinned.
 */

/**
 * The issue a command names, in the driver's `publishPlan` precedence order (below) — copied,
 * not imported: web is an independent workspace, the same rule the driver follows toward the
 * server. A match counts only when the digits end the token (a trailing word character means
 * they were a prefix) and the number is one GitHub could have issued: positive, within the
 * safe-integer range.
 */
const commandIssue = (command: string): number | null => {
    for (const pattern of [/issues\/(\d+)/, /\/fix\s+#?(\d+)/, /#(\d+)/]) {
        const match = pattern.exec(command);
        if (!match || /[\w]/.test(command[match.index + match[0].length] ?? '')) continue;
        const issue = Number(match[1]);
        if (Number.isSafeInteger(issue) && issue > 0) return issue;
    }
    return null;
};

/**
 * The issue the task names, with the driver's `publishPlan` precedence (`issues/\d+` before a
 * `/fix <n>` command, before a bare `#\d+`) — the validation lives in `commandIssue` above, the
 * driver reads this same reference to name the task branch and close the issue from the PR, so
 * the outcome shows the reader what the run is about.
 */
export function threadIssue(jobs: Job[]): number | null {
    for (let i = jobs.length - 1; i >= 0; i--) {
        const issue = commandIssue(jobs[i]!.command);
        if (issue !== null) return issue;
    }
    return null;
}

/** The PR the driver's publish step created, as far as the board knows it: a branch, maybe a url. */
export interface ThreadPublish {
    branch: string;
    url: string | null;
}

/**
 * The publish the driver appended to ONE run's output — `[driver] published <branch> — <prUrl>` —
 * the only place the board carries a PR today. Parsed here rather than made structured, which is
 * honest about being a convention read: a structured field would be a contract change (route,
 * store, driver) and is a deliberate follow-up. Anchored to a line start, because the driver
 * appends whole lines and the agent's own output is arbitrary text that may mention the marker;
 * the url is carried as-is and the PANEL only links `isHttpUrl` ones, so nothing a run echoed can
 * become a handler href. Null when this run published nothing.
 */
export function publicationForRun(job: Job): ThreadPublish | null {
    if (job.output === null) return null;
    const match = /(?:^|\n)\[driver\] published (\S+)(?: — (\S+))?/.exec(job.output);
    if (!match) return null;
    return { branch: match[1]!, url: match[2] ?? null };
}

/**
 * The thread's publication: the newest run that published one — the conversation's present
 * tense again. Null when nothing in the thread was published.
 */
export function threadPublish(jobs: Job[]): ThreadPublish | null {
    for (let i = jobs.length - 1; i >= 0; i--) {
        const publish = publicationForRun(jobs[i]!);
        if (publish !== null) return publish;
    }
    return null;
}

/** A publish line's url becomes a link only when it is one the reader can safely open. */
export const isHttpUrl = (url: string): boolean => url.startsWith('https://') || url.startsWith('http://');

/**
 * The pull request a publish url names — `.../pull/<n>`, the shape `gh pr view/create` prints —
 * read back out because the board carries no structured PR field, only the url. Null when the
 * url names no number; the panel then links it by name alone. The same bound as an issue
 * reference: positive and within the safe-integer range.
 */
export const prNumber = (url: string): number | null => {
    const match = /\/pull\/(\d+)/.exec(url);
    if (match === null) return null;
    const number = Number(match[1]);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
};

/**
 * The thread's context: the newest CLOSED turn's scrape — a follow-up resumes the same session,
 * so the last closed turn's count IS the conversation's final context, and summing per-turn
 * counts would double-count the shared prefix. A running turn carries no scrape, so scanning
 * newest-first for the first non-null is exactly "the newest terminal turn's". Raw tokens, not a
 * formatted string — `null` is unmeasured, never zero.
 */
export function threadContextTokens(jobs: Job[]): number | null {
    for (let i = jobs.length - 1; i >= 0; i--) {
        const tokens = jobs[i]!.runtime?.contextTokens;
        if (tokens != null) return tokens;
    }
    return null;
}

/**
 * The thread's cost: every turn's scraped cost summed. Zero-dollar turns contribute nothing (a
 * zero-dollar run is not billed, and $0.0000 is noise), and a chain where nothing scraped a cost
 * answers null — the honest blank, a claude-code thread's ordinary answer today. Raw dollars;
 * the panel fixes the decimals.
 */
export function threadCostUsd(jobs: Job[]): number | null {
    let sum = 0;
    for (const job of jobs) {
        const cost = job.runtime?.costUsd;
        if (cost != null && cost > 0) sum += cost;
    }
    return sum > 0 ? sum : null;
}

/** The one glance at a run's verification: how many gates passed, failed, are still running. */
export function gateCounts(gates: GateCheck[] | null | undefined): { passed: number; failed: number; running: number } {
    const list = gates ?? [];
    return {
        passed: list.filter((gate) => gate.status === 'passed').length,
        failed: list.filter((gate) => gate.status === 'failed').length,
        running: list.filter((gate) => gate.status === 'running').length,
    };
}

/**
 * The issue reference's URL, constructible only when the repository is one an owner/name slug
 * can build a github.com path from. Null otherwise — a bare repo name or no repository at all
 * leaves the reference a plain fact, not a dead link.
 */
export function issueUrl(repo: string | null, issue: number | null): string | null {
    if (repo === null || issue === null || !repo.includes('/')) return null;
    return `https://github.com/${repo}/issues/${issue}`;
}

/** How the task was closed, by whom — read off the NEWEST run's verdict stamps. */
export interface Closure {
    kind: 'done' | 'stopped' | 'stop-requested';
    login: string;
}

/**
 * The task's closure attribution: a done verdict outranks a stop (both can be stamped by the
 * time the reader arrives), and a stop reads as "stopped" only on a run that settled stopped —
 * the request is stamped at REQUEST time and outlives the settle. Null while nobody has closed
 * anything.
 */
export function closureOf(jobs: Job[]): Closure | null {
    const latest = jobs[jobs.length - 1];
    if (latest === undefined) return null;
    if (latest.doneBy !== null) return { kind: 'done', login: latest.doneBy.login };
    if (latest.stoppedBy !== null) {
        return { kind: latest.status === 'stopped' ? 'stopped' : 'stop-requested', login: latest.stoppedBy.login };
    }
    return null;
}

/**
 * The newest terminal run's exit code, skipping runs that settled without one — a follow-up's
 * verdict is the conversation's ending, not the root's. Null while nothing terminal carries a
 * code.
 */
export function newestTerminalExit(jobs: Job[]): number | null {
    for (let i = jobs.length - 1; i >= 0; i--) {
        const job = jobs[i]!;
        if (isTerminal(job.status) && job.exitCode !== null) return job.exitCode;
    }
    return null;
}

/** An open PR-review wait (206) — never inferred from output text or a workflow node name. */
export function isWaitingForReview(job: Job): boolean {
    return job.waitReason !== null && job.waitTerminalReason === null;
}
