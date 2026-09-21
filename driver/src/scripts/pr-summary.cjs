'use strict';

/*
 * The PR summary: one JSON line {title, body} describing what the task branch did, for the
 * publish flow to open the pull request with. The driver never sees the commits — they live
 * only in the task worktree — and the job command is a prompt, not a summary (issue #82: a PR
 * titled "try again?" is the failure this replaces).
 *
 * Environment:
 *   BASE  the upstream ref the branch is measured against, e.g. origin/main. Required; without
 *         it (or when git cannot read the branch) the answer is nulls and the caller falls
 *         back — a summary is decoration, never worth failing a publish that already pushed.
 *
 * The title is the branch's first commit subject — the commit that started the work names it —
 * truncated to 144 characters (twice the git subject convention: a commit that runs a little
 * long must not lose its last word's final letters, PR #191). The body lists the subjects (capped) and the shortstat of the
 * whole branch diff. Every git read is execFileSync with an argv array: no shell, no
 * interpolation.
 */

const { execFileSync } = require('node:child_process');

const TITLE_MAX = 144;
const BODY_COMMIT_CAP = 30;

function git(args) {
    return execFileSync('git', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 10 * 1024 * 1024,
    });
}

function summarize() {
    const base = (process.env.BASE ?? '').trim();
    if (!base) return { title: null, body: null };

    let subjects;
    let shortstat;
    try {
        subjects = git(['log', '--format=%s', `${base}..HEAD`])
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .reverse();
        shortstat = git(['diff', '--shortstat', `${base}...HEAD`]).trim();
    } catch {
        return { title: null, body: null };
    }

    // Code-point truncation, not UTF-16 units — a multi-byte character at the boundary must
    // not become a lone surrogate in a PR title.
    const title = subjects.length ? [...subjects[0]].slice(0, TITLE_MAX).join('') : null;

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
