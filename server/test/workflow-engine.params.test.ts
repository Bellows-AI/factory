import { describe, expect, it } from 'vitest';
import { checkWorkflowParams, interpolate, INTERP_TAIL_LIMIT, TRUNCATION_MARKER } from '../src/db/workflow-schema.js';
import { validateDefinition } from '../src/db/workflow-schema-validate.js';

describe('parameter guidance metadata', () => {
    const nodes = [{ name: 'a', kind: 'agent', session: 'resume', prompt: 'x', publish: true }];
    const withParams = (params: unknown) => validateDefinition({ entry: 'a', nodes, edges: [], params });

    it('accepts guidance and keeps the trimmed values on the normalized definition', () => {
        expect(
            withParams([
                {
                    name: 'issue',
                    pattern: '#\\d+',
                    description: '  An issue reference, like #123.  ',
                    example: ' #123 ',
                },
                { name: 'notes' },
            ])
        ).toMatchObject({
            ok: true,
            definition: {
                params: [
                    { name: 'issue', pattern: '#\\d+', description: 'An issue reference, like #123.', example: '#123' },
                    { name: 'notes' },
                ],
            },
        });
        // A param without guidance stays exactly the two-key shape it always was — no
        // `description: undefined` luggage on the normalized value.
        expect(withParams([{ name: 'notes' }])).toMatchObject({
            ok: true,
            definition: { params: [{ name: 'notes' }] },
        });
    });

    it('refuses blank, over-limit and non-string guidance, each by name', () => {
        const OVER_DESCRIPTION_LIMIT = 161;
        const OVER_EXAMPLE_LIMIT = 121;
        expect(withParams([{ name: 'issue', description: '' }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS', message: expect.stringContaining('description') },
        });
        expect(withParams([{ name: 'issue', description: '   ' }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS' },
        });
        expect(withParams([{ name: 'issue', description: 'x'.repeat(OVER_DESCRIPTION_LIMIT) }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS', message: expect.stringContaining('description') },
        });
        expect(withParams([{ name: 'issue', description: 42 }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS' },
        });
        expect(withParams([{ name: 'issue', example: '' }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS', message: expect.stringContaining('example') },
        });
        expect(withParams([{ name: 'issue', example: 'x'.repeat(OVER_EXAMPLE_LIMIT) }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS', message: expect.stringContaining('example') },
        });
        expect(withParams([{ name: 'issue', example: ['#123'] }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS' },
        });
    });

    it('guidance does not reopen the grammar — an unknown key beside it still refuses', () => {
        expect(withParams([{ name: 'issue', description: 'ref', example: '#1', extra: 1 }])).toMatchObject({
            ok: false,
            refusal: { code: 'UNKNOWN_KEY' },
        });
    });

    it('guidance is presentation only: launch validation never reads it', () => {
        const def = withParams([{ name: 'issue', pattern: '#\\d+', description: 'like #123', example: '#123' }]);
        expect(def).toMatchObject({ ok: true });
        if (!def.ok) throw new Error('fixture refused');
        // The description names an accepted shape, but the value must still match the PATTERN:
        // guidance never substitutes for validation.
        expect(checkWorkflowParams(def.definition, { issue: 'abc' }).ok).toBe(false);
        expect(checkWorkflowParams(def.definition, { issue: '#9' }).ok).toBe(true);
    });

    it('an example must be valid: one the declared pattern would refuse at launch is refused at create', () => {
        // The composer may pre-fill or hint with the example — an example the launch validation
        // would then reject is exactly the dishonest guidance this metadata exists to replace.
        expect(withParams([{ name: 'issue', pattern: '#\\d+', example: 'issue 42' }])).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_PARAMS', message: expect.stringContaining('example') },
        });
        expect(withParams([{ name: 'issue', pattern: '#\\d+', example: '#42' }]).ok).toBe(true);
        // The trimmed example is the one validated — the raw form may carry padding.
        expect(withParams([{ name: 'issue', pattern: '#\\d+', example: ' #42 ' }]).ok).toBe(true);
        // No pattern declared: any bounded example is valid by construction.
        expect(withParams([{ name: 'notes', example: 'anything at all' }]).ok).toBe(true);
    });

    it('guidance counts toward the unchanged definition-size gate', () => {
        // 120 valid params, each carrying the maximum 160-character description: every key inside
        // its own bound, the definition as a whole past 16 KiB.
        const MAX_DESCRIPTION_LENGTH = 160;
        const PARAM_COUNT = 120;
        const padded = Array.from({ length: PARAM_COUNT }, (_, i) => ({
            name: `p${i}`,
            description: 'x'.repeat(MAX_DESCRIPTION_LENGTH),
        }));
        expect(withParams(padded)).toMatchObject({ ok: false, refusal: { code: 'TOO_LARGE' } });
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
        const OVERLAP_GROUP_REPEATS = 42;
        expect(withPattern('(a|aa)'.repeat(OVERLAP_GROUP_REPEATS)).ok).toBe(false);
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
        const OVER_NOTES_LIMIT = 513;
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
        expect(refused({ issue: '#42', notes: 'x'.repeat(OVER_NOTES_LIMIT) })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_WORKFLOW_PARAMS' },
        });
        expect(refused({ issue: '42', notes: 'n' })).toMatchObject({
            ok: false,
            refusal: { code: 'BAD_WORKFLOW_PARAMS' },
        });
    });

    it('accepts a value at the length cap and refuses one over it', () => {
        const MAX_NOTES_LENGTH = 512;
        const OVER_NOTES_LIMIT = 513;
        expect(checkWorkflowParams(definition, { issue: '#42', notes: 'x'.repeat(MAX_NOTES_LENGTH) }).ok).toBe(true);
        expect(checkWorkflowParams(definition, { issue: '#42', notes: 'x'.repeat(OVER_NOTES_LIMIT) }).ok).toBe(false);
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
        const TAIL_OVERFLOW = 500;
        const out = interpolate('{{param.notes}}', {
            nodeOutput: () => '',
            gateName: '',
            gateOutput: '',
            param: () => 'x'.repeat(INTERP_TAIL_LIMIT + TAIL_OVERFLOW),
            command: '',
        });
        expect(out).toBe('x'.repeat(INTERP_TAIL_LIMIT) + TRUNCATION_MARKER);
    });
});
