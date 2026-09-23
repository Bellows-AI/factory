import { describe, expect, it } from 'vitest';
import { nextTransition, primarySessionId } from '../src/db/workflow-engine.js';
import {
    COMMAND_LIMIT,
    INTERP_TAIL_LIMIT,
    TRUNCATION_MARKER,
    boundedTail,
    interpolate,
    tailMatches,
} from '../src/db/workflow-schema.js';
import { done, gate, row, snapshot } from './workflow-engine-fixtures.js';

describe('nextTransition: marker and gate matching', () => {
    it('inserts the next row with an interpolated command when a marker edge matches', () => {
        const t = nextTransition({
            params: {},
            command: '',
            snapshot,
            rows: [row({ id: 'r1', node: 'review', output: 'findings...\nVERDICT: BLOCKERS' })],
            completed: done({ id: 'r1', node: 'review', output: 'findings...\nVERDICT: BLOCKERS' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'fix' }, session: 'resume', publish: false });
        if (t.action !== 'insert') return;
        expect(t.command).toBe('fix these: findings...\nVERDICT: BLOCKERS gate  said ');
    });

    it('rests when no rule matches — marker absence is a first-class outcome', () => {
        const t = nextTransition({
            params: {},
            command: '',
            snapshot,
            rows: [row({ id: 'r1', node: 'review', output: 'looks fine, no marker emitted' })],
            completed: done({ id: 'r1', node: 'review', output: 'looks fine, no marker emitted' }),
        });
        expect(t).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it('matches the marker only as the final non-empty line', () => {
        expect(tailMatches('VERDICT: CLEAN\nVERDICT: BLOCKERS', 'VERDICT: BLOCKERS')).toBe(true);
        expect(tailMatches('VERDICT: CLEAN', 'VERDICT: BLOCKERS')).toBe(false);
        expect(tailMatches(null, 'VERDICT: CLEAN')).toBe(false);
        expect(tailMatches('one\ntwo\n\nVERDICT: CLEAN  \n', 'VERDICT: CLEAN')).toBe(true);
    });

    it('derives gate-failed from the stored gates jsonb, distinguishable from an agent failure', () => {
        const gates = [gate('test', 'passed', 0), gate('lint', 'failed', 1, 'eslint output')];
        const t = nextTransition({
            params: {},
            command: '',
            snapshot,
            rows: [row({ id: 'r1', node: 'implement' })],
            completed: done({ id: 'r1', status: 'failed', gates }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'fix' } });
        if (t.action !== 'insert') return;
        expect(t.command).toBe('fix these:  gate lint said eslint output');
    });

    it('keeps agent-exit failure and gate failure distinguishable by declared order', () => {
        // A failed verdict with GREEN gates falls past gate-failed edges to a plain failure match.
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: {
                ...snapshot,
                edges: [
                    { from: 'implement', to: 'fix', when: 'gate-failed' },
                    { from: 'implement', to: 'review', when: 'succeeded' },
                ],
            },
            rows: [row({ id: 'r1', node: 'implement' })],
            completed: done({ id: 'r1', status: 'failed', gates: [gate('test', 'passed', 0)] }),
        });
        expect(t).toEqual({ action: 'rest', reason: 'no_edge' });
    });

    it('evaluates rules in declared order, first match wins', () => {
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: {
                ...snapshot,
                edges: [
                    { from: 'implement', to: 'review', when: 'succeeded' },
                    { from: 'implement', to: 'publish', when: 'succeeded' },
                ],
            },
            rows: [row({ id: 'r1', node: 'implement' })],
            completed: done({ id: 'r1' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'review' } });
    });
});

describe('nextTransition: loop bounds', () => {
    it('refuses the fourth round of a loop bounded at three, resting the thread', () => {
        const rows = [
            row({ id: 'a', node: 'implement' }),
            row({ id: 'b', node: 'review' }),
            row({ id: 'c', node: 'fix' }),
            row({ id: 'd', node: 'review' }),
            row({ id: 'e', node: 'fix' }),
            row({ id: 'f', node: 'review' }),
        ];
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: {
                ...snapshot,
                // The bound lives on the MATCHING edge; the count is rows for the TARGET node, so
                // every edge into review sharing max 3 is how "review x3" is declared.
                edges: [{ from: 'fix', to: 'review', when: 'succeeded', max: 3 }],
            },
            rows: [...rows, row({ id: 'g', node: 'fix', output: 'x\nVERDICT: BLOCKERS' })],
            completed: done({ id: 'g', node: 'fix' }),
        });
        // Three review rows exist and the bounded edge matched a fourth time: no fourth row.
        expect(t).toEqual({ action: 'rest', reason: 'loop_bound' });
    });

    it('counts a dead row as a round — attempts are retries, rounds are rows', () => {
        const rows = [
            row({ id: 'a', node: 'implement' }),
            row({ id: 'b', node: 'review', status: 'dead' }),
            row({ id: 'c', node: 'fix' }),
            row({ id: 'd', node: 'review', status: 'succeeded' }),
            row({ id: 'e', node: 'fix' }),
        ];
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: {
                ...snapshot,
                edges: [{ from: 'fix', to: 'review', when: 'succeeded', max: 2 }],
            },
            rows,
            completed: done({ id: 'e', node: 'fix' }),
        });
        // Two review rows already exist, one of them dead — both are rounds.
        expect(t).toEqual({ action: 'rest', reason: 'loop_bound' });
    });

    it('re-enters the graph at the halted node when an off-graph follow-up completes', () => {
        const t = nextTransition({
            params: {},
            command: '',
            snapshot,
            rows: [
                row({ id: 'a', node: 'implement' }),
                row({ id: 'b', node: 'review', output: 'blockers listed\nVERDICT: BLOCKERS' }),
                row({ id: 'c', node: null, output: 'human follow-up work\nVERDICT: BLOCKERS' }),
            ],
            completed: done({ id: 'c', node: null, output: 'human follow-up work\nVERDICT: BLOCKERS' }),
        });
        // The follow-up carries no node; the thread's newest carried node is `review`, whose
        // outgoing edges are evaluated against the follow-up's own verdict and output.
        expect(t).toMatchObject({ action: 'insert', node: { name: 'fix' } });
    });
});

describe('nextTransition: off-graph and parameter interpolation', () => {
    it('rests off_graph when neither the row nor the thread carries a node', () => {
        const t = nextTransition({
            params: {},
            command: '',
            snapshot,
            rows: [row({ id: 'r1' })],
            completed: done({ id: 'r1', node: null }),
        });
        expect(t).toEqual({ action: 'rest', reason: 'off_graph' });
    });

    it('carries the publish flag only from the target node', () => {
        const t = nextTransition({
            params: {},
            command: '',
            snapshot,
            rows: [row({ id: 'r1', node: 'review', output: 'all good\nVERDICT: CLEAN' })],
            completed: done({ id: 'r1', node: 'review', output: 'all good\nVERDICT: CLEAN' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'publish' }, publish: true });
    });

    it('fills {{param.*}} from the frozen values and {{command}} from the root command in a successor prompt', () => {
        const parammed = {
            entry: 'fetch',
            params: [{ name: 'issue', pattern: '#\\d+' }],
            nodes: [
                { name: 'fetch', kind: 'agent' as const, session: 'resume' as const, prompt: 'fetch {{param.issue}}' },
                {
                    name: 'work',
                    kind: 'agent' as const,
                    session: 'resume' as const,
                    prompt: 'issue {{param.issue}}; asked: {{command}}',
                    publish: true,
                },
            ],
            edges: [{ from: 'fetch', to: 'work', when: 'succeeded' as const }],
        };
        const t = nextTransition({
            snapshot: parammed,
            params: { issue: '#42' },
            command: 'fetch #42 — the entry prompt the member launched',
            rows: [row({ id: 'r1', node: 'fetch', output: 'the issue body' })],
            completed: done({ id: 'r1', node: 'fetch' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'work' } });
        if (t.action !== 'insert') return;
        expect(t.command).toBe('issue #42; asked: fetch #42 — the entry prompt the member launched');
    });
});

describe('bounded interpolation', () => {
    const TAIL_OVERFLOW = 500;

    it('substitutes the most recent stored output of the named node', () => {
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: {
                ...snapshot,
                edges: [{ from: 'fetch-issue', to: 'implement', when: 'succeeded' }],
            },
            rows: [
                row({ id: 'a', node: 'fetch-issue', output: 'first issue text' }),
                row({ id: 'b', node: 'fetch-issue', output: 'newer issue text' }),
            ],
            completed: done({ id: 'c', node: 'fetch-issue' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'implement' } });
        if (t.action !== 'insert') return;
        expect(t.command).toBe('work newer issue text');
    });

    it('hard-truncates a substituted tail to its share, with a visible marker', () => {
        const long = 'x'.repeat(INTERP_TAIL_LIMIT + TAIL_OVERFLOW);
        const command = interpolate('{{a.output}}', {
            nodeOutput: () => long,
            gateName: '',
            gateOutput: '',
            param: () => '',
            command: '',
        });
        expect(command).toBe('x'.repeat(INTERP_TAIL_LIMIT) + TRUNCATION_MARKER);
        expect(command.length).toBeLessThanOrEqual(INTERP_TAIL_LIMIT + TRUNCATION_MARKER.length);
    });

    it('leaves a short tail byte-identical', () => {
        expect(boundedTail('short')).toBe('short');
        expect(boundedTail('x'.repeat(INTERP_TAIL_LIMIT))).toBe('x'.repeat(INTERP_TAIL_LIMIT));
    });

    it('refuses the insert with command_too_large when the filled prompt still exceeds the cap', () => {
        const wide: typeof snapshot = {
            ...snapshot,
            nodes: snapshot.nodes.map((n) =>
                n.name === 'review'
                    ? { ...n, prompt: `{{a.output}} {{b.output}} {{c.output}} {{d.output}} {{e.output}}` }
                    : n
            ),
        };
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: wide,
            rows: ['a', 'b', 'c', 'd', 'e'].map((node, i) =>
                row({ id: `r${i}`, node, output: 'y'.repeat(INTERP_TAIL_LIMIT) })
            ),
            completed: done({ id: 'rz', node: 'implement' }),
        });
        expect(t).toEqual({ action: 'rest', reason: 'command_too_large' });
        const EXPECTED_COMMAND_LIMIT = 16_384;
        expect(COMMAND_LIMIT).toBe(EXPECTED_COMMAND_LIMIT);
    });
});

describe('primarySessionId', () => {
    it('follows the first resume-policy run, skipping fresh branches', () => {
        const rows = [
            row({ id: 'a', node: 'implement', sessionId: 'primary' }),
            row({ id: 'b', node: 'review', sessionId: 'side-branch' }),
        ];
        expect(primarySessionId(snapshot, rows)).toBe('primary');
    });

    it('returns null until a resume run has reported a session, then adopts its mint', () => {
        const rows = [
            row({ id: 'a', node: 'review', sessionId: 'fresh-eyes' }),
            row({ id: 'b', node: 'fix', sessionId: null }),
        ];
        expect(primarySessionId(snapshot, rows)).toBeNull();
        expect(primarySessionId(snapshot, [...rows, row({ id: 'c', node: 'fix', sessionId: 'minted' })])).toBe(
            'minted'
        );
    });

    it('treats every row of a pre-workflow thread as resume-equivalent', () => {
        const rows = [row({ id: 'a', node: null, sessionId: 's1' }), row({ id: 'b', node: null, sessionId: 's2' })];
        expect(primarySessionId(null, rows)).toBe('s1');
    });
});
