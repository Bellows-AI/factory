import { describe, expect, it } from 'vitest';
import { STILL_ACTIVE_AFTER_MS, formatAge, timeoutNote } from '../src/timeout-note.js';
import type { GateRunNote, TimeoutActivity } from '../src/timeout-note.js';

/**
 * The kill note a timed-out run leaves in the output tail. It must let a reader tell — without
 * raw SQL against three sources (issue #339) — a run that hung from one that was still working
 * when the wall clock ran out: the age of the last output, the ad-hoc gates' latest verdicts,
 * and the agent's last activity line.
 */

describe('formatAge', () => {
    it('reports seconds under a minute', () => {
        expect(formatAge(34_500)).toBe('34s');
        expect(formatAge(2_000)).toBe('2s');
    });

    it('reports whole minutes under an hour', () => {
        expect(formatAge(34 * 60_000 + 12_000)).toBe('34m');
    });

    it('reports hours with zero-padded minutes', () => {
        expect(formatAge(7_410_000)).toBe('2h03m');
    });
});

describe('timeoutNote', () => {
    const TWO_HOURS = 7_200_000;

    it('says the run was still active, with the last gate verdicts and activity line', () => {
        const activity: TimeoutActivity = {
            lastOutputAt: Date.parse('2026-09-22T22:46:14.000Z'),
            activity: 'Now the two wording fixes:',
        };
        const gateRuns: GateRunNote[] = [
            { name: 'test', exitCode: 0, at: '2026-09-22T22:45:02.000Z' },
            { name: 'lint', exitCode: 0, at: '2026-09-22T22:44:10.000Z' },
        ];
        expect(timeoutNote(TWO_HOURS, activity, gateRuns, Date.parse('2026-09-22T22:46:16.000Z'))).toBe(
            '[driver] killed after 7200000ms — still active: last output 2s ago, ' +
                'gates test+lint passed at 22:45:02, last activity "Now the two wording fixes:"'
        );
    });

    it('says the run was idle when the last output is older than the threshold', () => {
        const activity: TimeoutActivity = {
            lastOutputAt: Date.parse('2026-09-22T22:12:16.000Z'),
            activity: '…',
        };
        expect(timeoutNote(TWO_HOURS, activity, [], Date.parse('2026-09-22T22:46:16.000Z'))).toBe(
            '[driver] killed after 7200000ms — idle: no output for 34m, last activity "…"'
        );
    });

    it('says no output ever arrived when there was none', () => {
        const activity: TimeoutActivity = { lastOutputAt: null, activity: null };
        expect(timeoutNote(TWO_HOURS, activity, [], Date.parse('2026-09-22T22:46:16.000Z'))).toBe(
            '[driver] killed after 7200000ms — idle: no output'
        );
    });

    it('treats an age of exactly the threshold as idle, and one millisecond less as active', () => {
        const now = Date.parse('2026-09-22T22:46:16.000Z');
        const atThreshold: TimeoutActivity = { lastOutputAt: now - STILL_ACTIVE_AFTER_MS, activity: null };
        const justUnder: TimeoutActivity = { lastOutputAt: now - STILL_ACTIVE_AFTER_MS + 1, activity: null };
        expect(timeoutNote(TWO_HOURS, atThreshold, [], now)).toContain(' — idle: ');
        expect(timeoutNote(TWO_HOURS, justUnder, [], now)).toContain(' — still active: ');
    });

    it('names each gate individually when the latest verdicts are mixed', () => {
        const activity: TimeoutActivity = { lastOutputAt: Date.parse('2026-09-22T22:46:14.000Z'), activity: null };
        const gateRuns: GateRunNote[] = [
            { name: 'test', exitCode: 3, at: '2026-09-22T22:45:02.000Z' },
            { name: 'lint', exitCode: 0, at: '2026-09-22T22:44:10.000Z' },
        ];
        const note = timeoutNote(TWO_HOURS, activity, gateRuns, Date.parse('2026-09-22T22:46:16.000Z'));
        expect(note).toBe(
            '[driver] killed after 7200000ms — still active: last output 2s ago, ' +
                'gates test failed (exit 3), lint passed at 22:44:10'
        );
    });

    it('omits the gate clause when the ad-hoc gates never ran, and the activity clause when there is none', () => {
        const activity: TimeoutActivity = { lastOutputAt: Date.parse('2026-09-22T22:46:14.000Z'), activity: null };
        expect(timeoutNote(TWO_HOURS, activity, [], Date.parse('2026-09-22T22:46:16.000Z'))).toBe(
            '[driver] killed after 7200000ms — still active: last output 2s ago'
        );
    });

    it('keeps only the latest run per gate, and stamps the clause with the newest of those', () => {
        const activity: TimeoutActivity = { lastOutputAt: Date.parse('2026-09-22T22:46:14.000Z'), activity: null };
        const gateRuns: GateRunNote[] = [
            { name: 'test', exitCode: 0, at: '2026-09-22T22:30:00.000Z' },
            { name: 'test', exitCode: 0, at: '2026-09-22T22:40:00.000Z' },
            { name: 'lint', exitCode: 0, at: '2026-09-22T22:35:00.000Z' },
        ];
        expect(timeoutNote(TWO_HOURS, activity, gateRuns, Date.parse('2026-09-22T22:46:16.000Z'))).toBe(
            '[driver] killed after 7200000ms — still active: last output 2s ago, gates test+lint passed at 22:40:00'
        );
    });
});
