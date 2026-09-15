import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The turn terminology rule, pinned to the two docs that define it (docs/metrics.md's block of
 * record and docs/jobs.md's cross-reference): both documents must name BOTH terms, and the
 * never-bare-"turns" rule must be stated where the definitions live. The dashboard's figures are
 * only as trustworthy as the words that label them, and a definition that quietly disappears
 * from the docs is how "turns" becomes a shorthand again.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const metrics = read('../../docs/metrics.md');
const jobs = read('../../docs/jobs.md');

describe('turn terminology in the docs', () => {
    it('defines both terms in docs/metrics.md, the block of record', () => {
        expect(metrics).toContain('**job turn**');
        expect(metrics).toContain('**agent turn**');
        expect(metrics).toContain('never zero');
    });

    it('cross-references the terminology from docs/jobs.md, where runs live', () => {
        expect(jobs).toContain('agent turn');
        expect(jobs).toContain('docs/metrics.md');
    });

    it('states the never-bare-"turns" rule where the definitions live', () => {
        expect(metrics).toContain('a bare "turns"');
    });

    it('states the close-time read and its null contract in docs/jobs.md', () => {
        expect(jobs).toContain('close-time agent-turn read');
        expect(jobs).toContain('Null is the contract for unmeasured');
    });
});
