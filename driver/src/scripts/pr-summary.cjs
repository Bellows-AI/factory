'use strict';

/*
 * The PR summary: one JSON line {title, body} describing what the task branch did, for the
 * publish flow to open the pull request with. The driver never sees the commits — they live
 * only in the task worktree — and the job command is a prompt, not a summary (issue #82: a PR
 * titled "try again?" is the failure this replaces; issue #389: a title copied from the
 * branch's FIRST commit names its setup, not its outcome).
 *
 * Environment:
 *   BASE  the upstream ref the branch is measured against, e.g. origin/main. Required; without
 *         it (or when git cannot read the branch) the answer is nulls and the caller falls
 *         back — a summary is decoration, never worth failing a publish that already pushed.
 *   BACKSTOP_TITLE  the driver's plan.title — the subject of the commit the publish itself just
 *         created from the uncommitted leftovers. Commits with that subject are excluded from
 *         the title selection: the prompt is never authoritative (issue #389).
 *
 * The title is SELECTED, not copied (issue #389): every commit is scored by how much of its
 * churn survives in the branch's final diff against BASE — a commit whose changes were
 * reverted or superseded scores nothing — and the heaviest survivor names the PR, the earliest
 * winning a tie (so a branch whose commits all tie reads exactly as the old first-subject
 * rule did). Commits touching only test files cannot win while any source-touching commit
 * survives: the fix, not the regression test that opened the branch, is the outcome. A commit
 * subject is reused whenever it does summarize the change; what the rule cannot do is coin a
 * title no subject approximates — that is the documented limit, and the command-derived plan
 * title stays the driver-side floor. Single-commit branches resolve to their only subject.
 * The body lists the subjects (capped) and the shortstat of the whole branch diff.
 *
 * No model call, deliberately: this step runs credential-free and offline in a throwaway
 * container on both executors, and a generator needing a credential, egress or quota would
 * put that decoration at risk. docs/jobs.md carries the full rationale.
 *
 * Every git read is execFileSync with an argv array: no shell, no interpolation, a max buffer
 * and a timeout on each — bounded input, bounded time.
 */

const { execFileSync } = require('node:child_process');

const TITLE_MAX = 144;
const BODY_COMMIT_CAP = 30;
const GIT_OUTPUT_MAX_BUFFER_BYTES = 10485760;
const GIT_TIMEOUT_MS = 10000;
/** git log's record/field separators: subjects and paths can hold anything else. */
const RECORD_SEPARATOR = '\u001e';
const FIELD_SEPARATOR = '\u001f';
/** numstat spells a binary row with dashes: churn a binary change cannot contribute. */
const NUMSTAT_BINARY = '-';
/**
 * A test file: a `tests?`/`__tests__` path segment, a `.test.`/`.spec.` double extension, or
 * a `test_*` basename. The two dominant conventions, deliberately not a per-language matrix
 * (issue #389): a misclassified layout only tilts which surviving commit names the PR.
 */
const TEST_FILE = /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]*$/i;

function git(args) {
    return execFileSync('git', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: GIT_OUTPUT_MAX_BUFFER_BYTES,
        timeout: GIT_TIMEOUT_MS,
    });
}

/** `adds\tdels\tpath` rows (binary rows spell `-\t-\t`); churn is adds+dels, path is the rest. */
function churnRows(numstat) {
    const files = [];
    for (const row of numstat.split('\n')) {
        const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(row);
        if (!match) continue;
        const adds = match[1] === NUMSTAT_BINARY ? 0 : Number(match[1]);
        const dels = match[2] === NUMSTAT_BINARY ? 0 : Number(match[2]);
        files.push([match[3], adds + dels]);
    }
    return files;
}

/**
 * Splits `git log --numstat --format=%x1e%H%x1f%s` output into one entry per commit: the
 * subject and its per-file churn, newest first as git prints them. A merge shows no numstat
 * (weight zero downstream); a subject with embedded newlines contributes its first line, the
 * same line `--format=%s` alone would have shown.
 */
function parseCommits(logOutput) {
    const commits = [];
    for (const record of logOutput.split(RECORD_SEPARATOR)) {
        const lines = record.split('\n').filter((line) => line.trim());
        const head = lines[0] ?? '';
        const sep = head.indexOf(FIELD_SEPARATOR);
        if (sep < 0) continue;
        const subject = head.slice(sep + FIELD_SEPARATOR.length).trim();
        if (!subject) continue;
        commits.push({ subject, files: churnRows(lines.slice(1).join('\n')) });
    }
    return commits;
}

/**
 * How much of a commit's churn survives into the final diff: per file it touched that the
 * final diff still changes, the smaller of the two churns. The min is what keeps reverted or
 * superseded work from advertising itself, and keeps a commit from outscoring the final diff
 * it actually left behind. Split by test-ness: the source half earns the source tier.
 */
function survivingSplit(files, finalChurn) {
    let source = 0;
    let tests = 0;
    for (const [path, churn] of files) {
        const final = finalChurn.get(path);
        if (final === undefined) continue;
        const survived = Math.min(churn, final);
        if (survived <= 0) continue;
        if (TEST_FILE.test(path)) tests += survived;
        else source += survived;
    }
    return { source, tests };
}

/**
 * The title rule (issue #389): among commits whose surviving weight is positive, prefer those
 * that changed source in the final diff; the heaviest survivor names the PR, earliest on a
 * tie. An all-test branch falls back to its test commits; a branch with no measurable churn
 * at all (empty commits, merges only) falls back to every commit — the old first-subject
 * behavior. Single-commit branches always resolve to their only subject.
 *
 * BACKSTOP_TITLE (set by the driver to plan.title) names the publish's OWN just-created
 * commit — its subject is the command's first line, and the prompt is never authoritative
 * (issue #389): commits whose subject normalizes to it are excluded from every pool. When it
 * is the branch's only commit the selection answers null and the driver's plan.title fallback
 * lands anyway — the same string it would have been. The commit itself keeps its place in the
 * body's commit list.
 */
function selectTitle(commits, finalChurn, backstop) {
    const eligible = backstop ? commits.filter((commit) => normalizeTitle(commit.subject) !== backstop) : commits;
    const scored = eligible
        .map((commit) => {
            const { source, tests } = survivingSplit(commit.files, finalChurn);
            // Normalized here, once: a subject that carries no title text (control characters
            // only) is not a candidate — a lighter usable subject names the PR instead, and a
            // branch with none answers null for the driver's per-half fallback.
            return { title: normalizeTitle(commit.subject), weight: source + tests, changedSource: source > 0 };
        })
        .filter((entry) => entry.title !== null);
    let pool = scored.filter((entry) => entry.changedSource);
    if (pool.length === 0) pool = scored.filter((entry) => entry.weight > 0);
    if (pool.length === 0) pool = scored;
    let best = pool[0];
    for (const entry of pool) if (entry.weight > best.weight) best = entry;
    return best ? best.title : null;
}

/** C0/C1 control boundaries: printable text starts past C0, DEL sits alone, C1 follows. */
const CONTROL_DELETE = 0x7f;
const CONTROL_C0_END = 0x20;
const CONTROL_C1_START = 0x80;
const CONTROL_C1_END = 0x9f;

/**
 * Control characters stripped (a subject can carry a \r), trimmed, then truncated on CODE
 * POINTS — a multi-byte character at the boundary must not become a lone surrogate in a PR
 * title. Empty after cleaning means no title: the caller falls back per half.
 */
function normalizeTitle(subject) {
    const cleaned = [...subject]
        .filter((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return (
                code >= CONTROL_C0_END &&
                code !== CONTROL_DELETE &&
                !(code >= CONTROL_C1_START && code <= CONTROL_C1_END)
            );
        })
        .join('')
        .trim();
    if (!cleaned) return null;
    return [...cleaned].slice(0, TITLE_MAX).join('');
}

function summarize() {
    const base = (process.env.BASE ?? '').trim();
    if (!base) return { title: null, body: null };

    let commits;
    let shortstat;
    let title = null;
    try {
        const log = git(['log', '--numstat', '--format=%x1e%H%x1f%s', `${base}..HEAD`]);
        const finalDiff = git(['diff', '--numstat', `${base}...HEAD`]);
        shortstat = git(['diff', '--shortstat', `${base}...HEAD`]).trim();
        commits = parseCommits(log).reverse();
        const backstop = normalizeTitle(process.env.BACKSTOP_TITLE ?? '');
        title = selectTitle(commits, new Map(churnRows(finalDiff)), backstop);
    } catch {
        return { title: null, body: null };
    }

    const subjects = commits.map((commit) => commit.subject);
    const lines = [];
    if (subjects.length) {
        lines.push('## Commits', '');
        for (const s of subjects.slice(0, BODY_COMMIT_CAP)) lines.push(`- ${s}`);
        if (subjects.length > BODY_COMMIT_CAP) lines.push(`- ... and ${subjects.length - BODY_COMMIT_CAP} more`);
    }
    if (shortstat) {
        if (lines.length) lines.push('');
        lines.push(shortstat);
    }
    return { title, body: lines.length ? lines.join('\n') : null };
}

process.stdout.write(`${JSON.stringify(summarize())}\n`);
