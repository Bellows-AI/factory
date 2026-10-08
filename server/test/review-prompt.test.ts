import { describe, expect, it } from 'vitest';
import { reviewerPrompts, TASK_COMMAND_LIMIT } from '../src/db/review-prompt.js';
import { REVIEW_BLOCKERS_MARKER, REVIEW_VERDICT_MARKER } from '../src/db/workflow-templates.js';

const SPEC = {
    name: 'security',
    instructions: 'Look for injection and leaked secrets.',
    timeoutMinutes: 5,
    connections: [],
};

describe('reviewerPrompts', () => {
    it('gives the reviewer its profile, a read-only brief and the verdict contract', () => {
        const { masterPrompt, command } = reviewerPrompts(SPEC, 'fix the login bug');
        expect(masterPrompt).toContain('"security"');
        expect(masterPrompt).toContain(SPEC.instructions);
        expect(masterPrompt).toMatch(/do not modify/i);
        expect(masterPrompt).toContain(REVIEW_VERDICT_MARKER);
        expect(masterPrompt).toContain(REVIEW_BLOCKERS_MARKER);
        expect(command).toContain('fix the login bug');
    });

    it('does not tell the reviewer it can publish, ask the member, or run the task’s gates', () => {
        const { masterPrompt } = reviewerPrompts(SPEC, 'x');
        expect(masterPrompt).not.toMatch(/\/publish|pull request|\/question/i);
    });

    it('bounds the task command it quotes', () => {
        const { command } = reviewerPrompts(SPEC, 'a'.repeat(TASK_COMMAND_LIMIT * 3));
        expect(command.length).toBeLessThan(TASK_COMMAND_LIMIT * 2);
    });

    it('is a pure function of its inputs', () => {
        expect(reviewerPrompts(SPEC, 'same')).toEqual(reviewerPrompts(SPEC, 'same'));
    });
});
