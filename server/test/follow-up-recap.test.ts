import { COMMAND_LIMIT } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { type RecapTurn, renderFollowUpRecap } from '../src/db/follow-up-recap.js';

const turn = (over: Partial<RecapTurn> = {}): RecapTurn => ({
    status: 'succeeded',
    command: 'do the thing',
    workflowNode: null,
    summary: null,
    output: null,
    ...over,
});

describe('renderFollowUpRecap', () => {
    it('delivers the command untouched when there is nothing to recap', () => {
        expect(renderFollowUpRecap([], 'again')).toBe('again');
    });

    it('recaps each turn oldest first, preferring the summary to the output, then the new command', () => {
        const text = renderFollowUpRecap(
            [
                turn({ command: 'fix the bug', status: 'failed', summary: 'blocked on a decision', output: 'tail' }),
                turn({ command: 'option B', output: 'opened the PR' }),
            ],
            'tighten the test'
        );

        expect(text).toContain('Turn 1 (failed): fix the bug\nResult: blocked on a decision');
        expect(text).toContain('Turn 2 (succeeded): option B\nResult: opened the PR');
        expect(text.indexOf('Turn 1')).toBeLessThan(text.indexOf('Turn 2'));
        expect(text.endsWith('New instruction:\n\ntighten the test')).toBe(true);
    });

    it('names an engine-written step by its node, never quoting its prompt', () => {
        const text = renderFollowUpRecap(
            [turn({ command: null, workflowNode: 'merge-conflict-autofix--repair', output: 'MERGE-UP-TO-DATE' })],
            'again'
        );

        expect(text).toContain('Turn 1 (succeeded): (workflow step: merge-conflict-autofix--repair)');
        expect(text).toContain('Result: MERGE-UP-TO-DATE');
    });

    it('stays within the command limit, keeping the newest turns and counting the dropped ones', () => {
        const big = 'x'.repeat(5_000);
        const turns = Array.from({ length: 40 }, (_, i) => turn({ command: `turn-${i} ${big}`, output: big }));

        const text = renderFollowUpRecap(turns, 'again');

        expect(text.length - 'again'.length).toBeLessThanOrEqual(COMMAND_LIMIT + 1_000);
        expect(text).toMatch(/\(\d+ earlier turns omitted\)/);
        expect(text).toContain('turn-39 ');
        expect(text).not.toContain('turn-0 ');
    });
});
