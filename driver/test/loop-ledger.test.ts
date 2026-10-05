import { describe, expect, it } from 'vitest';
import type { FailureKind } from '../src/board.js';
import type { HelperFailureReport } from '../src/helpers.js';
import {
    agentFaults,
    gatesEligible,
    kindOf,
    ledgerOf,
    outputOf,
    publishEligible,
    RANK,
    skipWhyOf,
    statusOf,
    type LedgerParts,
} from '../src/loop-ledger.js';
import type { DeadService, RunOutcome } from '../src/runner.js';

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
    exitCode: 0,
    output: 'done',
    timedOut: false,
    started: true,
    ...over,
});

const dead: DeadService = { name: 'db', image: 'mongo', state: 'failed', exitCode: 1, reason: null, logTail: '' };
const helper = { helperId: 'h', result: { reason: 'boom', message: 'm' } } as unknown as HelperFailureReport;

const parts = (over: Partial<LedgerParts> = {}): LedgerParts => ({
    outcome: outcome(),
    failure: null,
    deadServices: [],
    helperFailure: null,
    published: null,
    ...over,
});

/**
 * One fault each, by the kind it must name — the table the pairwise test crosses with itself.
 * `config` is a pre-run refusal (loop-run.ts), never a ledger fault, so it is not ranked.
 */
const SINGLE: Record<Exclude<FailureKind, 'config'>, LedgerParts> = {
    timeout: parts({ outcome: outcome({ timedOut: true }) }),
    cache_lost: parts({ outcome: outcome({ cacheLost: 'c' }) }),
    blocked: parts({ outcome: outcome({ blockedLine: 'x' }) }),
    services: parts({ deadServices: [dead] }),
    gate: parts({ failure: { name: 't', exitCode: 1, output: '' } }),
    helper: parts({ helperFailure: helper }),
    publish: parts({ published: { ok: false, published: false, reason: 'r' } as never }),
    runner_error: parts({ outcome: outcome({ exitCode: 2 }) }),
};

const single = (kind: FailureKind): LedgerParts => SINGLE[kind as keyof typeof SINGLE];

const merge = (a: LedgerParts, b: LedgerParts): LedgerParts => ({
    outcome: {
        ...a.outcome,
        ...b.outcome,
        timedOut: a.outcome.timedOut || b.outcome.timedOut,
        exitCode: a.outcome.exitCode === 0 ? b.outcome.exitCode : a.outcome.exitCode,
    },
    failure: a.failure ?? b.failure,
    deadServices: [...a.deadServices, ...b.deadServices],
    helperFailure: a.helperFailure ?? b.helperFailure,
    published: a.published ?? b.published,
});

describe('the fault ledger', () => {
    it('is empty, succeeded and fully eligible for a clean run', () => {
        const ledger = ledgerOf(parts());
        expect(ledger).toEqual([]);
        expect(statusOf(ledger)).toBe('succeeded');
        expect(kindOf(ledger)).toBeNull();
        expect(gatesEligible(ledger) && publishEligible(ledger)).toBe(true);
        expect(skipWhyOf(ledger)).toBeNull();
    });

    it('ranks every pair of faults by RANK, and every single fault names its own kind', () => {
        for (const kind of RANK) expect(kindOf(ledgerOf(single(kind)))).toBe(kind);
        for (const [i, a] of RANK.entries()) {
            for (const b of RANK.slice(i + 1)) {
                const ledger = ledgerOf(merge(single(a), single(b)));
                expect(statusOf(ledger)).toBe('failed');
                expect(kindOf(ledger), `${a} + ${b}`).toBe(a);
                expect(publishEligible(ledger)).toBe(false);
            }
        }
    });

    it('lets only a timeout, a gate, services, a helper or a publish leave the gates running', () => {
        const runs = (kind: FailureKind): boolean => gatesEligible(ledgerOf(single(kind)));
        expect(RANK.filter(runs)).toEqual(['timeout', 'services', 'gate', 'helper', 'publish']);
        // A non-zero exit that is the timeout's own kill still leaves the work to judge.
        expect(gatesEligible(agentFaults(outcome({ timedOut: true, exitCode: 137 })))).toBe(true);
    });

    it('names the most decisive blocking fault as the skip reason', () => {
        expect(skipWhyOf(agentFaults(outcome({ exitCode: null })))).toBe("the agent's run exited without an exit code");
        expect(skipWhyOf(agentFaults(outcome({ finishReason: 'length' })))).toBe(
            "the agent's run ended before it finished"
        );
        expect(skipWhyOf(agentFaults(outcome({ exitCode: 1, blockedLine: 'x' })))).toBe(
            'the agent reported it is blocked'
        );
        // A cache-killed run's finish reason is not a second premature stop.
        expect(agentFaults(outcome({ cacheLost: 'c', finishReason: 'length' }))).toHaveLength(1);
    });

    it('reads the blocked marker from the close-time line, else the output tail', () => {
        expect(agentFaults(outcome({ output: 'a\nFACTORY_BLOCKED: no access' }))[0]?.note).toBe(
            'the agent reported it is blocked: no access'
        );
        expect(agentFaults(outcome({ output: 'FACTORY_BLOCKED: x', summary: 's' }))).toEqual([]);
        expect(agentFaults(outcome({ blockedLine: '   ' }))[0]?.note).toContain('no reason given');
    });

    it('places the gates-skipped line after the last skipping fault', () => {
        const ledger = ledgerOf(merge(SINGLE.blocked, SINGLE.helper));
        const lines = outputOf(ledger, 'the agent reported it is blocked').split('\n[driver] ').slice(1);
        expect(lines.map((line) => line.split(' ')[0])).toEqual(['the', 'gates', 'helper']);
    });
});
