import { describe, expect, it } from 'vitest';
import { BASE_WORKFLOW } from '../src/db/workflow-templates.js';
import { validateDefinition } from '../src/db/workflow-schema-validate.js';

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
