import { describe, expect, it } from 'vitest';
import { isTerminal, type Job, type RuntimeVitals } from '../src/api/useJobs.js';
import { runDuration, taskTime, wallClock } from '../src/format.js';
import {
    closureOf,
    gateCounts,
    issueUrl,
    newestTerminalExit,
    prNumber,
    publicationForRun,
    threadContextTokens,
    threadCostUsd,
    threadIssue,
    threadPublish,
} from '../src/task-outcome.js';
import { job } from './tasks-fixtures.js';

describe('isTerminal', () => {
    // This is what stops the detail poll: a finished job is never going to grow an output.
    it('is true for every status a worker or the board has finished with', () => {
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            expect(isTerminal(status), status).toBe(true);
        }
    });

    it('is false while the task can still move', () => {
        for (const status of ['queued', 'running', 'standby'] as const) {
            expect(isTerminal(status), status).toBe(false);
        }
    });
});

describe('taskTime', () => {
    // A chat's stamp carries the time of day; the date is there to disambiguate older threads.
    it('renders the UTC date and clock, and a dash for anything absent or unparseable', () => {
        expect(taskTime('2026-09-01T12:04:00.000Z')).toBe('2026-09-01 12:04');
        expect(taskTime(null)).toBe('—');
        expect(taskTime('not a date')).toBe('—');
    });
});

describe('runDuration', () => {
    // The sidebar's "running time": the newest attempt's clock. Pure — the caller decides what
    // "now" is, so the tests pin spans instead of sleeping.
    it('renders the span of a finished run at minute granularity', () => {
        expect(runDuration('2026-09-01T12:00:01.000Z', '2026-09-01T12:04:00.000Z')).toBe('4m');
    });

    it('renders a live run up to the now it is handed', () => {
        expect(runDuration('2026-09-01T12:00:00.000Z', null, new Date('2026-09-01T12:30:00.000Z'))).toBe('30m');
    });

    it('renders a dash before the run starts, and for absent or nonsense stamps', () => {
        expect(runDuration(null, null)).toBe('—');
        expect(runDuration('not a date', null)).toBe('—');
        expect(runDuration('2026-09-01T12:04:00.000Z', '2026-09-01T12:00:00.000Z')).toBe('—');
    });
});

describe('wallClock', () => {
    // The task head's clock: everything the board has banked for the task so far, plus the head
    // run's live in-flight segment while it is going. Pure — the caller decides what "now" is.
    it('renders the persisted total', () => {
        const ONE_HOUR_MS = 3_600_000;
        const THIRTY_MINUTES_MS = 1_800_000;
        expect(wallClock(ONE_HOUR_MS, null)).toBe('1h');
        expect(wallClock(THIRTY_MINUTES_MS, null)).toBe('30m');
    });

    it('renders a dash where nothing has been banked and nothing is going', () => {
        expect(wallClock(null, null)).toBe('—');
    });

    it('adds the live run to the banked total, and ticks a live run alone', () => {
        const TEN_MINUTES_MS = 600_000;
        expect(wallClock(TEN_MINUTES_MS, '2026-09-01T12:00:00.000Z', new Date('2026-09-01T12:05:00.000Z'))).toBe('15m');
        expect(wallClock(null, '2026-09-01T12:00:00.000Z', new Date('2026-09-01T12:30:00.000Z'))).toBe('30m');
    });

    it('a finished run adds nothing, and a nonsense or future start is ignored rather than negative', () => {
        const TEN_MINUTES_MS = 600_000;
        expect(wallClock(TEN_MINUTES_MS, null)).toBe('10m');
        expect(wallClock(TEN_MINUTES_MS, 'not a date')).toBe('10m');
        expect(wallClock(null, '2026-09-01T12:00:00.000Z', new Date('2026-09-01T11:00:00.000Z'))).toBe('—');
    });
});

describe('thread derivations', () => {
    const base = job();
    const withCommand = (command: string, over: Partial<Job> = {}): Job => ({ ...base, command, ...over });
    /** A follow-up of `base`: the chain array is oldest first, so this is the newest run. */
    const followUp = (command: string, over: Partial<Job> = {}): Job => ({
        ...base,
        command,
        id: '44444444-4444-4444-8444-444444444444',
        followUpTo: base.id,
        rootJobId: base.id,
        ...over,
    });

    describe('threadIssue', () => {
        // The driver's publishPlan reads the same reference out of the command to name the branch
        // and close the issue from the PR — the sidebar shows the reader what the task is about.
        const ISSUE_NUMBER = 44;
        const FIX_COMMAND_NUMBER = 100;
        const NEWEST_ISSUE_NUMBER = 9;

        it('parses an issues/ URL and a bare #number', () => {
            expect(threadIssue([withCommand('fix https://github.com/o/r/issues/44 please')])).toBe(ISSUE_NUMBER);
            expect(threadIssue([withCommand('fix #44 please')])).toBe(ISSUE_NUMBER);
        });

        it('parses the /fix command forms — bare number, #number, and a full url after /fix', () => {
            expect(threadIssue([withCommand('/fix 100')])).toBe(FIX_COMMAND_NUMBER);
            expect(threadIssue([withCommand('/fix #44')])).toBe(ISSUE_NUMBER);
            expect(threadIssue([withCommand('/fix https://github.com/o/r/issues/44')])).toBe(ISSUE_NUMBER);
        });

        it('does not read an issue from a command that merely looks like /fix', () => {
            expect(threadIssue([withCommand('/fix-a 100')])).toBeNull();
        });

        it('prefers the /fix target over an incidental #mention', () => {
            expect(threadIssue([withCommand('/fix 44 but really #9')])).toBe(ISSUE_NUMBER);
        });

        it('rejects lookalike and impossible issue numbers', () => {
            expect(threadIssue([withCommand('/fix 44oops')])).toBeNull();
            expect(threadIssue([withCommand('see #44oops')])).toBeNull();
            expect(threadIssue([withCommand('/fix 0')])).toBeNull();
            expect(threadIssue([withCommand('/fix 99999999999999999999')])).toBeNull();
            expect(threadIssue([withCommand('fix #44.')])).toBe(ISSUE_NUMBER);
        });

        it('prefers the issues/ form over a bare #, like the driver does', () => {
            expect(threadIssue([withCommand('see #7, from issues/44')])).toBe(ISSUE_NUMBER);
        });

        it('reads the newest run first — the thread is one conversation', () => {
            expect(threadIssue([withCommand('fix #44'), followUp('also mentions #9')])).toBe(NEWEST_ISSUE_NUMBER);
        });

        it('answers null when no command names one', () => {
            expect(threadIssue([withCommand('tighten the retry logic')])).toBeNull();
        });
    });

    describe('threadPublish', () => {
        // The driver appends one line to the output when it publishes — the only place the board
        // carries a PR. The sidebar reads it; a structured field would be a follow-up.
        it('parses the published line into the branch and the PR url', () => {
            expect(
                threadPublish([
                    withCommand('x', { output: 'done\n[driver] published fix/44 — https://github.com/o/r/pull/9' }),
                ])
            ).toEqual({ branch: 'fix/44', url: 'https://github.com/o/r/pull/9' });
        });

        it('carries a null url when the publish pushed a branch without a PR', () => {
            expect(threadPublish([withCommand('x', { output: '[driver] published task/20260910' })])).toEqual({
                branch: 'task/20260910',
                url: null,
            });
        });

        it('reads the newest output first', () => {
            const root = withCommand('x', { output: '[driver] published fix/1 — https://github.com/o/r/pull/1' });
            expect(
                threadPublish([
                    root,
                    followUp('y', { output: '[driver] published fix/2 — https://github.com/o/r/pull/2' }),
                ])?.url
            ).toBe('https://github.com/o/r/pull/2');
        });

        it('answers null when nothing was published', () => {
            expect(threadPublish([withCommand('x', { output: 'no publish here' })])).toBeNull();
            expect(threadPublish([withCommand('x', { output: null })])).toBeNull();
        });

        it('ignores a marker the run echoed mid-line, and never links a non-http url', () => {
            // The agent's output is arbitrary text; only a whole line at a line boundary is the
            // driver's, and only an http(s) url may become a href.
            expect(
                threadPublish([withCommand('x', { output: 'the agent said [driver] published fake/1 — not-a-url' })])
            ).toBeNull();
            expect(
                threadPublish([withCommand('x', { output: '[driver] published fix/5 — javascript:alert(1)' })])
            ).toEqual({ branch: 'fix/5', url: 'javascript:alert(1)' });
        });
    });
});

describe('task outcome derivations', () => {
    // The outcome summary's raw material, as pure data — the panel formats, these decide. All
    // read the thread NEWEST first (the chain arrives oldest first), because the newest run is
    // the conversation's present tense.
    const base = job();
    const followUp = (over: Partial<Job> = {}): Job => ({
        ...base,
        id: '44444444-4444-4444-8444-444444444444',
        followUpTo: base.id,
        rootJobId: base.id,
        ...over,
    });

    describe('publicationForRun', () => {
        it('reads one anchored published line from a single row', () => {
            expect(
                publicationForRun({
                    ...base,
                    output: 'done\n[driver] published fix/44 — https://github.com/o/r/pull/9',
                })
            ).toEqual({
                branch: 'fix/44',
                url: 'https://github.com/o/r/pull/9',
            });
        });

        it('keeps a branch with no url, and answers null for a row without output', () => {
            expect(publicationForRun({ ...base, output: '[driver] published task/20260910' })).toEqual({
                branch: 'task/20260910',
                url: null,
            });
            expect(publicationForRun({ ...base, output: null })).toBeNull();
        });

        it('rejects a marker the run echoed mid-line', () => {
            expect(
                publicationForRun({ ...base, output: 'the agent said [driver] published fake/1 — not-a-url' })
            ).toBeNull();
        });
    });

    describe('prNumber', () => {
        it('reads the number a pull url names', () => {
            const PULL_NUMBER = 9;
            const LARGE_PULL_NUMBER = 177;
            expect(prNumber('https://github.com/o/r/pull/9')).toBe(PULL_NUMBER);
            expect(prNumber('https://github.example.com/acme/widgets/pull/177')).toBe(LARGE_PULL_NUMBER);
        });

        it('answers null for a url that names no pull request, or an impossible one', () => {
            expect(prNumber('https://github.com/o/r/pulls')).toBeNull();
            expect(prNumber('https://example.com/pr/9')).toBeNull();
            expect(prNumber('https://github.com/o/r/pull/0')).toBeNull();
            expect(prNumber('https://github.com/o/r/pull/99999999999999999999')).toBeNull();
        });
    });

    describe('threadContextTokens', () => {
        it('returns the newest closed turn count, never a sum', () => {
            // A follow-up resumes the same session: the last closed turn's count IS the
            // conversation's final context, and summing per-turn counts double-counts the prefix.
            const jobs = [
                { ...base, runtime: { ...(base.runtime as RuntimeVitals), contextTokens: 1000 } },
                followUp({ runtime: { ...(base.runtime as RuntimeVitals), contextTokens: 3000 } }),
            ];
            const NEWEST_TURN_TOKENS = 3000;
            expect(threadContextTokens(jobs)).toBe(NEWEST_TURN_TOKENS);
        });

        it('skips a running newest turn without a scrape and reads the older closed one', () => {
            const jobs = [
                { ...base, runtime: { ...(base.runtime as RuntimeVitals), contextTokens: 1000 } },
                followUp({ status: 'running', runtime: { ...(base.runtime as RuntimeVitals), contextTokens: null } }),
            ];
            const OLDER_TURN_TOKENS = 1000;
            expect(threadContextTokens(jobs)).toBe(OLDER_TURN_TOKENS);
        });

        it('answers null when nothing scraped', () => {
            expect(threadContextTokens([base])).toBeNull();
        });
    });

    describe('threadCostUsd', () => {
        it('sums positive per-turn costs once', () => {
            const jobs = [
                { ...base, runtime: { ...(base.runtime as RuntimeVitals), costUsd: 0.01 } },
                followUp({ runtime: { ...(base.runtime as RuntimeVitals), costUsd: 0.002 } }),
            ];
            const SUMMED_COST_USD = 0.012;
            expect(threadCostUsd(jobs)).toBe(SUMMED_COST_USD);
        });

        it('omits absent and zero costs entirely', () => {
            expect(threadCostUsd([base])).toBeNull();
            expect(
                threadCostUsd([{ ...base, runtime: { ...(base.runtime as RuntimeVitals), costUsd: 0 } }])
            ).toBeNull();
        });
    });
});

describe('task outcome derivations — gates, issues and closure', () => {
    const base = job();
    const followUp = (over: Partial<Job> = {}): Job => ({
        ...base,
        id: '44444444-4444-4444-8444-444444444444',
        followUpTo: base.id,
        rootJobId: base.id,
        ...over,
    });

    describe('gateCounts', () => {
        it('counts passed, failed and running', () => {
            const gates = [
                { name: 'test', status: 'passed' as const, exitCode: 0, output: null },
                { name: 'lint', status: 'failed' as const, exitCode: 1, output: null },
                { name: 'build', status: 'running' as const, exitCode: null, output: null },
            ];
            expect(gateCounts(gates)).toEqual({ passed: 1, failed: 1, running: 1 });
        });

        it('answers all-zero for nothing declared', () => {
            expect(gateCounts(null)).toEqual({ passed: 0, failed: 0, running: 0 });
        });
    });

    describe('issueUrl', () => {
        it('builds only from a repository an owner/name slug can construct', () => {
            const ISSUE_NUMBER = 44;
            expect(issueUrl('acme/web', ISSUE_NUMBER)).toBe('https://github.com/acme/web/issues/44');
            expect(issueUrl(null, ISSUE_NUMBER)).toBeNull();
            expect(issueUrl('web', ISSUE_NUMBER)).toBeNull();
            expect(issueUrl('acme/web', null)).toBeNull();
        });
    });

    describe('closureOf', () => {
        it('reads the newest run done attribution first', () => {
            expect(
                closureOf([base, followUp({ doneBy: { id: 'u', login: 'kim', name: null, avatarUrl: null } })])
            ).toEqual({
                kind: 'done',
                login: 'kim',
            });
        });

        it('reads a stop as stopped or requested by how the run settled', () => {
            expect(
                closureOf([
                    followUp({ status: 'stopped', stoppedBy: { id: 'u', login: 'kim', name: null, avatarUrl: null } }),
                ])
            ).toEqual({
                kind: 'stopped',
                login: 'kim',
            });
            expect(
                closureOf([followUp({ stoppedBy: { id: 'u', login: 'kim', name: null, avatarUrl: null } })])
            ).toEqual({
                kind: 'stop-requested',
                login: 'kim',
            });
        });

        it('answers null while nobody has closed anything', () => {
            expect(closureOf([base])).toBeNull();
        });
    });

    describe('newestTerminalExit', () => {
        it('reads the newest terminal run exit code, skipping runs without one', () => {
            expect(newestTerminalExit([base, followUp({ exitCode: null })])).toBe(0);
            expect(newestTerminalExit([base, followUp({ exitCode: 2 })])).toBe(2);
        });

        it('answers null while no run has settled', () => {
            expect(newestTerminalExit([followUp({ status: 'running' })])).toBeNull();
        });
    });
});
