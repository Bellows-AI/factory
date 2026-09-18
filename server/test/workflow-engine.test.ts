import { describe, expect, it } from 'vitest';
import type { GateReport } from '../src/db/job-store.js';
import { type CompletedRun, type EngineRow, nextTransition, primarySessionId } from '../src/db/workflow-engine.js';
import { BASE_WORKFLOW } from '../src/db/workflow-templates.js';
import {
    COMMAND_LIMIT,
    INTERP_TAIL_LIMIT,
    TRUNCATION_MARKER,
    boundedTail,
    checkWorkflowParams,
    interpolate,
    tailMatches,
    validateDefinition,
} from '../src/db/workflow-schema.js';

const snapshot = {
    entry: 'implement',
    nodes: [
        {
            name: 'implement',
            kind: 'agent' as const,
            session: 'resume' as const,
            prompt: 'work {{fetch-issue.output}}',
        },
        { name: 'review', kind: 'agent' as const, session: 'fresh' as const, prompt: 'review', publish: false },
        {
            name: 'fix',
            kind: 'agent' as const,
            session: 'resume' as const,
            prompt: 'fix these: {{review.output}} gate {{gate.name}} said {{gate.output}}',
        },
        { name: 'publish', kind: 'agent' as const, session: 'resume' as const, prompt: 'preflight', publish: true },
    ],
    edges: [
        { from: 'implement', to: 'review', when: 'succeeded' as const, max: 3 },
        { from: 'implement', to: 'fix', when: 'gate-failed' as const },
        { from: 'review', to: 'fix', when: { marker: 'VERDICT: BLOCKERS' } },
        { from: 'review', to: 'publish', when: { marker: 'VERDICT: CLEAN' } },
        { from: 'fix', to: 'review', when: 'succeeded' as const },
    ],
};

const row = (over: Partial<EngineRow> = {}): EngineRow => ({
    id: over.id ?? 'r1',
    node: over.node ?? null,
    status: over.status ?? 'succeeded',
    output: over.output ?? null,
    gates: over.gates ?? null,
    sessionId: over.sessionId ?? null,
});

const done = (over: Partial<CompletedRun> = {}): CompletedRun => ({
    id: 'r1',
    node: 'implement',
    status: 'succeeded',
    output: null,
    gates: null,
    ...over,
});

const gate = (
    name: string,
    status: GateReport['status'],
    exitCode: number | null,
    output: string | null = null
): GateReport => ({
    name,
    status,
    exitCode,
    output,
});

describe('nextTransition', () => {
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
        const long = 'x'.repeat(INTERP_TAIL_LIMIT + 500);
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
        expect(COMMAND_LIMIT).toBe(16_384);
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

describe('the base workflow walkthrough', () => {
    /** Walks the happy path and the loop, inserting as the store would, so every node's template
     * is filled at least once under the walkthrough's rows. */
    const insert = (t: Extract<ReturnType<typeof nextTransition>, { action: 'insert' }>, id: string): EngineRow => ({
        id,
        node: t.node.name,
        status: 'queued',
        output: null,
        gates: null,
        sessionId: null,
    });

    it('walks fetch-issue → implement → review → fix → publish, filling every placeholder', () => {
        const rows: EngineRow[] = [row({ id: 'fetch', node: 'fetch-issue', output: 'ISSUE: the board is dumb' })];
        const steps: string[] = [];

        // fetch-issue succeeded → implement
        let t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'fetch', node: 'fetch-issue' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'implement' } });
        if (t.action !== 'insert') return;
        expect(t.command).toContain('ISSUE: the board is dumb');
        steps.push(t.node.name);
        rows.push(insert(t, 'impl'));

        // implement succeeded → review
        rows[rows.length - 1] = row({ id: 'impl', node: 'implement', output: 'implemented; suite green' });
        t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'impl', node: 'implement' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'review' } });
        if (t.action !== 'insert') return;
        steps.push(t.node.name);
        rows.push(insert(t, 'rev1'));

        // review names blockers → fix, carrying the review's output
        rows[rows.length - 1] = row({ id: 'rev1', node: 'review', output: '1. src/x.ts is wrong\nVERDICT: BLOCKERS' });
        t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'rev1', node: 'review', output: '1. src/x.ts is wrong\nVERDICT: BLOCKERS' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'fix' } });
        if (t.action !== 'insert') return;
        expect(t.command).toContain('1. src/x.ts is wrong');
        steps.push(t.node.name);
        rows.push(insert(t, 'fix1'));

        // fix succeeded → review (round two), then clean → publish
        rows[rows.length - 1] = row({ id: 'fix1', node: 'fix', output: 'fixed' });
        t = nextTransition({ snapshot: BASE_WORKFLOW.definition, rows, completed: done({ id: 'fix1', node: 'fix' }) });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'review' } });
        if (t.action !== 'insert') return;
        steps.push(t.node.name);
        rows.push(insert(t, 'rev2'));
        rows[rows.length - 1] = row({ id: 'rev2', node: 'review', output: 'all good\nVERDICT: CLEAN' });
        t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({ id: 'rev2', node: 'review', output: 'all good\nVERDICT: CLEAN' }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'publish' }, publish: true, session: 'resume' });
        if (t.action !== 'insert') return;
        steps.push(t.node.name);

        expect(steps).toEqual(['implement', 'review', 'fix', 'review', 'publish']);
    });

    it('walks gate-failed into gate-fix, filling both gate placeholders', () => {
        const rows: EngineRow[] = [row({ id: 'impl', node: 'implement', sessionId: 'primary' })];
        const t = nextTransition({
            params: {},
            command: '',
            snapshot: BASE_WORKFLOW.definition,
            rows,
            completed: done({
                id: 'impl',
                node: 'implement',
                status: 'failed',
                gates: [gate('test', 'failed', 1, '3 tests failed')],
            }),
        });
        expect(t).toMatchObject({ action: 'insert', node: { name: 'gate-fix' } });
        if (t.action !== 'insert') return;
        expect(t.command).toContain('--- FAILED GATE: test ---');
        expect(t.command).toContain('3 tests failed');
        // The gate-fix node resumes the thread's primary session.
        expect(t.session).toBe('resume');
    });

    it('carries the publish flag on exactly the publish node and the fresh policy on review', () => {
        for (const node of BASE_WORKFLOW.definition.nodes) {
            expect(node.publish === true).toBe(node.name === 'publish');
            expect(node.session === 'fresh').toBe(node.name === 'review');
        }
    });
});

describe('the seeded issue parameter', () => {
    it('declares a required issue param accepting a bare #number or an issues URL', () => {
        expect(validateDefinition(BASE_WORKFLOW.definition).ok).toBe(true);
        expect(BASE_WORKFLOW.definition.params).toEqual([{ name: 'issue', pattern: expect.any(String) }]);
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: '#127' }).ok).toBe(true);
        expect(
            checkWorkflowParams(BASE_WORKFLOW.definition, { issue: 'https://github.com/acme/widget/issues/44' }).ok
        ).toBe(true);
        // The bare form keeps its '#': the driver's issue parse and the branch/commit issue
        // references read it off the interpolated prompt.
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: '127' }).ok).toBe(false);
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: 'issues 44' }).ok).toBe(false);
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, { issue: 'x#44' }).ok).toBe(false);
        // A param-less launch is refused — the point of the declaration.
        expect(checkWorkflowParams(BASE_WORKFLOW.definition, {}).ok).toBe(false);
    });

    it("fetches the declared param and carries the member's words, with no mining fallback", () => {
        const fetchNode = BASE_WORKFLOW.definition.nodes[0]!;
        expect(fetchNode.name).toBe('fetch-issue');
        expect(fetchNode.prompt).toContain('{{param.issue}}');
        expect(fetchNode.prompt).toContain('{{command}}');
        expect(fetchNode.prompt).not.toContain('if none was given');
        // The command block passes the declared param itself — no placeholder left to re-derive.
        expect(fetchNode.prompt).not.toContain('<url-or-number>');
        expect(fetchNode.prompt).toContain('gh issue view {{param.issue}}');
    });
});

describe('validateDefinition', () => {
    it('accepts a minimal well-formed definition', () => {
        const check = validateDefinition({
            entry: 'a',
            nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
            edges: [],
        });
        expect(check.ok).toBe(true);
    });

    it('accepts the seeded base workflow — the /fix skeleton as a graph', () => {
        const check = validateDefinition(BASE_WORKFLOW.definition);
        expect(check.ok).toBe(true);
    });

    it('refuses unknown top-level keys, node kinds and bound shapes, each by name', () => {
        expect(validateDefinition({ nodes: [], edges: [] }).ok).toBe(false);
        expect(
            validateDefinition({
                nodes: [{ name: 'a', kind: 'gate', session: 'resume', prompt: 'x' }],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
        expect(
            validateDefinition({
                nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
                edges: [{ from: 'a', to: 'a', when: 'succeeded', max: 0 }],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_BOUND' } });
    });

    it('refuses an entry that names no node', () => {
        expect(
            validateDefinition({
                entry: 'ghost',
                nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'UNKNOWN_NODE' } });
    });
});

describe('workflow parameters', () => {
    const parammed = {
        entry: 'a',
        params: [{ name: 'issue', pattern: '#\\d+' }, { name: 'notes' }],
        nodes: [
            {
                name: 'a',
                kind: 'agent' as const,
                session: 'resume' as const,
                prompt: 'issue {{param.issue}} asked {{command}} notes {{param.notes}}',
                publish: true,
            },
        ],
        edges: [],
    };

    it('accepts a definition declaring params, with {{param.*}} anywhere and {{command}} at the entry', () => {
        expect(validateDefinition(parammed)).toMatchObject({
            ok: true,
            definition: { params: [{ name: 'issue', pattern: '#\\d+' }, { name: 'notes' }] },
        });
    });

    it('normalizes an absent params declaration to an empty list', () => {
        const check = validateDefinition({
            entry: 'a',
            nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
            edges: [],
        });
        expect(check).toMatchObject({ ok: true, definition: { params: [] } });
    });

    it('refuses a malformed params declaration, each by name', () => {
        const nodes = [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }];
        expect(validateDefinition({ entry: 'a', nodes, edges: [], params: 'issue' })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS' },
        });
        expect(validateDefinition({ entry: 'a', nodes, edges: [], params: [{}] })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS' },
        });
        expect(validateDefinition({ entry: 'a', nodes, edges: [], params: [{ name: 'Issue' }] })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS' },
        });
        expect(
            validateDefinition({ entry: 'a', nodes, edges: [], params: [{ name: 'issue' }, { name: 'issue' }] })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_PARAMS' } });
        expect(
            validateDefinition({ entry: 'a', nodes, edges: [], params: [{ name: 'issue', pattern: '[' }] })
        ).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS' },
        });
        expect(
            validateDefinition({ entry: 'a', nodes, edges: [], params: [{ name: 'issue' }, 'issue'] })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_PARAMS' } });
        // Unknown keys fail loudly anywhere — a param object is no exception.
        expect(
            validateDefinition({
                entry: 'a',
                nodes,
                edges: [],
                params: [{ name: 'issue', pattern: '#\\d+', extra: 1 }],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'UNKNOWN_KEY' } });
    });

    it('accepts {{command}} in any node — it resolves from the thread root command', () => {
        expect(
            validateDefinition({
                entry: 'a',
                params: [{ name: 'issue', pattern: '#\\d+' }],
                nodes: [
                    { name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true },
                    { name: 'b', kind: 'agent', session: 'resume', prompt: 're-anchor on {{command}}' },
                ],
                edges: [],
            })
        ).toMatchObject({ ok: true });
    });

    it('refuses {{param.undeclared}}, by placeholder', () => {
        expect(
            validateDefinition({
                entry: 'a',
                params: [{ name: 'issue', pattern: '#\\d+' }],
                nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x {{param.nothing}}', publish: true }],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'UNKNOWN_PLACEHOLDER' } });
    });

    it('refuses "param" as a node name — {{param.*}} is the parameter namespace', () => {
        expect(
            validateDefinition({
                entry: 'a',
                nodes: [{ name: 'param', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
                edges: [],
            })
        ).toMatchObject({ ok: false, refusal: { code: 'BAD_NODE' } });
    });
});

describe('the parameter pattern grammar — a safe subset, refused on any doubt', () => {
    const nodes = [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }];
    const withPattern = (pattern: string) =>
        validateDefinition({ entry: 'a', nodes, edges: [], params: [{ name: 'issue', pattern }] });

    it('accepts the shapes honest shapes need: literals, classes, escapes, alternation, bounded runs', () => {
        expect(withPattern('#\\d+').ok).toBe(true);
        expect(withPattern('https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\\d+').ok).toBe(true);
        expect(withPattern('(?:foo|bar)-[0-9]{2,4}').ok).toBe(true);
        expect(withPattern('v\\d+\\.\\d+\\.\\d+').ok).toBe(true);
        // Two chained quantified atoms are within the ambiguity budget — quadratic at worst.
        expect(withPattern('a*a*').ok).toBe(true);
    });

    it('refuses the ambiguous constructs catastrophic backtracking feeds on', () => {
        expect(withPattern('(a+)*').ok).toBe(false); // quantified group
        expect(withPattern('(a|aa)+').ok).toBe(false); // quantified group
        expect(withPattern('a*?').ok).toBe(false); // a quantifier after a quantifier
        expect(withPattern('a*a*a*a*').ok).toBe(false); // ambiguity run over the cap
        expect(withPattern('(a+)(a+)(a+)(a+)').ok).toBe(false); // the same run, through groups
        expect(withPattern('\\d+\\d+\\d+\\d+\\d+').ok).toBe(false); // more than four quantified atoms
    });

    it('refuses alternation-stacked patterns — branch boundaries carry their own budget', () => {
        // `(a|aa)(a|aa)…` composes 2ⁿ match paths without a single quantifier, so unquantified
        // groups may not stack: two branch boundaries, and the pattern is refused.
        expect(withPattern('(a|aa)(a|aa)(a|aa)').ok).toBe(false);
        expect(withPattern('a|aa|aaa|aaaa').ok).toBe(false); // three boundaries at the top level
        // The reported attack: overlap groups repeated to the pattern-size cap.
        expect(withPattern('(a|aa)'.repeat(42)).ok).toBe(false);
    });

    it('refuses syntax outside the subset, even when JavaScript would allow it', () => {
        expect(withPattern('^\\d+$').ok).toBe(false); // anchors are implicit in the full match
        expect(withPattern('(?=a)b').ok).toBe(false); // lookahead
        expect(withPattern('(?!a)b').ok).toBe(false); // negative lookahead
        expect(withPattern('\\1').ok).toBe(false); // backreference
        expect(withPattern('\\u1234').ok).toBe(false); // unicode escape outside the allowlist
        expect(withPattern('a{2,700}').ok).toBe(false); // bound over the cap
        expect(withPattern('a{2,}').ok).toBe(false); // open-ended repetition: write {2,64} or +
        expect(withPattern('a{2,').ok).toBe(false); // malformed quantifier, not a literal brace
        expect(withPattern('a{').ok).toBe(false); // a bare brace must be escaped
        expect(withPattern('[]').ok).toBe(false); // empty class
    });

    it('does not over-refuse: a mandatory atom between quantified atoms breaks the ambiguity run', () => {
        expect(withPattern('x*y*b[c]+d+').ok).toBe(true); // true runs: 2, then 1, then 1
        expect(withPattern('(a|aa)(a|aa)').ok).toBe(true); // two branch boundaries, at the cap
        // The seeded issue pattern: one boundary and four run-broken quantifiers.
        expect(withPattern('#\\d+|https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\\d+').ok).toBe(true);
    });
});

describe('checkWorkflowParams', () => {
    const def = validateDefinition({
        entry: 'a',
        params: [{ name: 'issue', pattern: '#\\d+' }, { name: 'notes' }],
        nodes: [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }],
        edges: [],
    });
    if (!def.ok) throw new Error('fixture definition refused');
    const definition = def.definition;

    it('accepts full matches and trims the stored values', () => {
        expect(checkWorkflowParams(definition, { issue: ' #42 ', notes: 'login page' })).toEqual({
            ok: true,
            values: { issue: '#42', notes: 'login page' },
        });
    });

    it('accepts a param-less definition with no body at all and with an empty one', () => {
        expect(checkWorkflowParams({ ...definition, params: [] }, undefined)).toEqual({ ok: true, values: {} });
        expect(checkWorkflowParams({ ...definition, params: [] }, {})).toEqual({ ok: true, values: {} });
    });

    it('refuses, each by name: non-object, missing declared, unknown key, non-string, empty, over-length, non-matching', () => {
        const refused = (raw: unknown) => checkWorkflowParams(definition, raw);
        expect(refused(undefined)).toMatchObject({ ok: false, refusal: { code: 'BAD_WORKFLOW_PARAMS' } });
        expect(refused('issue')).toMatchObject({ ok: false, refusal: { code: 'BAD_WORKFLOW_PARAMS' } });
        expect(refused({ issue: '#42' })).toMatchObject({ ok: false, refusal: { code: 'BAD_WORKFLOW_PARAMS' } });
        expect(refused({ issue: '#42', notes: 'n', repo: 'x/y' })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_WORKFLOW_PARAMS' },
        });
        expect(refused({ issue: 42, notes: 'n' })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_WORKFLOW_PARAMS' },
        });
        expect(refused({ issue: '   ', notes: 'n' })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_WORKFLOW_PARAMS' },
        });
        expect(refused({ issue: '#42', notes: 'x'.repeat(513) })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_WORKFLOW_PARAMS' },
        });
        expect(refused({ issue: '42', notes: 'n' })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_WORKFLOW_PARAMS' },
        });
    });

    it('accepts a value at the length cap and refuses one over it', () => {
        expect(checkWorkflowParams(definition, { issue: '#42', notes: 'x'.repeat(512) }).ok).toBe(true);
        expect(checkWorkflowParams(definition, { issue: '#42', notes: 'x'.repeat(513) }).ok).toBe(false);
    });
});

describe('parameter interpolation', () => {
    it('fills {{param.*}} and {{command}}', () => {
        const out = interpolate('{{param.issue}} from {{command}}', {
            nodeOutput: () => '',
            gateName: '',
            gateOutput: '',
            param: (name) => (name === 'issue' ? '#42' : ''),
            command: 'fix #42 please',
        });
        expect(out).toBe('#42 from fix #42 please');
    });

    it('bounds a substituted parameter like every other substitution', () => {
        const out = interpolate('{{param.notes}}', {
            nodeOutput: () => '',
            gateName: '',
            gateOutput: '',
            param: () => 'x'.repeat(INTERP_TAIL_LIMIT + 500),
            command: '',
        });
        expect(out).toBe('x'.repeat(INTERP_TAIL_LIMIT) + TRUNCATION_MARKER);
    });
});
