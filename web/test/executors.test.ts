import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE, EXECUTOR_TYPES, OPENCODE, RUNNER_MANAGED_KEYS } from '@factory-ai/core';
import {
    EXECUTOR_TYPE_META,
    GATE_FIX_ROUNDS_HELP,
    MAX_CONFIG_BYTES,
    MAX_GATE_FIX_ROUNDS,
    NO_CHANGES_REASON,
    REQUIRED_FIELDS,
    SAVE_HINTS,
    composerExecutorOptions,
    executorChoiceId,
    executorChoiceOf,
    executorDraftChanges,
    executorEditorView,
    executorSavedMessage,
    executorTypeLabel,
    formatConfig,
    initialExecutorDraft,
    locateJsonError,
    mergeExecutors,
    parseExecutorConfig,
    readModel,
    runnerManagedSettings,
    saveUnavailableReason,
    tokenizeJson,
    validateExecutorDraft,
    validateExecutorName,
    validateGateFixRounds,
    withModel,
    type ExecutorDraft,
    type ExecutorRow,
    type ValidExecutor,
} from '../src/workspace/executors.js';

const validRow = (): ExecutorRow => ({
    name: 'main',
    type: 'claude-code',
    config: {},
    gateFixRounds: 3,
});

describe('parseExecutorConfig', () => {
    it('reads blank text as the inherited configuration, {}', () => {
        // Name and agent alone are enough to save: the member never has to type {} (#261).
        expect(parseExecutorConfig('')).toEqual({ ok: true, value: {} });
        expect(parseExecutorConfig('  \n ')).toEqual({ ok: true, value: {} });
    });

    it('accepts a JSON object and keeps every key', () => {
        expect(parseExecutorConfig('{ "model": "sonnet", "custom": { "a": [1] } }')).toEqual({
            ok: true,
            value: { model: 'sonnet', custom: { a: [1] } },
        });
    });

    it('rejects a JSON array or scalar — an object is the contract', () => {
        for (const raw of ['[]', '7', '"text"', 'null']) {
            const result = parseExecutorConfig(raw);
            expect(result.ok, raw).toBe(false);
            if (!result.ok) expect(result.error).toMatch(/must be a JSON object/);
        }
    });

    it('rejects a config over the size limit, and accepts one exactly at it', () => {
        const wrap = (length: number) => `{"p":"${'x'.repeat(length)}"}`;
        const overhead = wrap(0).length;
        expect(parseExecutorConfig(wrap(MAX_CONFIG_BYTES - overhead)).ok).toBe(true);
        const over = parseExecutorConfig(wrap(MAX_CONFIG_BYTES - overhead + 1));
        expect(over.ok).toBe(false);
        if (!over.ok) expect(over.error).toMatch(/32 KiB/);
    });

    it('says where the JSON broke when the engine reports it', () => {
        const result = parseExecutorConfig('{\n  "a": 1,\n}');
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.line).toBe(3);
            expect(result.column).toBe(1);
            expect(result.error).toMatch(/^Not valid JSON at line 3, column 1: /);
            // The engine noise is stripped from the reason: no repeated position in the sentence.
            expect(result.error).not.toMatch(/position/);
        }
    });

    it('still explains a parse failure that carries no location', () => {
        const result = parseExecutorConfig('{ "a":');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/^Not valid JSON/);
    });
});

describe('locateJsonError', () => {
    it('reads the V8 line/column suffix', () => {
        expect(locateJsonError('x', 'Unexpected token } in JSON at position 9 (line 2 column 5)')).toEqual({
            line: 2,
            column: 5,
        });
    });

    it('converts a bare V8 position against the text', () => {
        expect(locateJsonError('{\n "a" x', 'Unexpected token x in JSON at position 7')).toEqual({
            line: 2,
            column: 6,
        });
    });

    it('reads the Firefox wording', () => {
        expect(locateJsonError('x', 'JSON.parse: expected property name at line 1 column 3 of the JSON data')).toEqual({
            line: 1,
            column: 3,
        });
    });

    it('answers null when the message carries no location', () => {
        expect(locateJsonError('x', "JSON Parse error: Expected '}'")).toBeNull();
    });
});

describe('readModel / withModel', () => {
    it('reads a missing model as the runner default, a string as custom, anything else as unsupported', () => {
        expect(readModel({})).toEqual({ kind: 'default' });
        expect(readModel({ model: 'sonnet' })).toEqual({ kind: 'custom', model: 'sonnet' });
        expect(readModel({ model: 5 })).toEqual({ kind: 'unsupported' });
        expect(readModel({ model: {} })).toEqual({ kind: 'unsupported' });
    });

    it('sets a model, replacing it in place and keeping every other key and its order', () => {
        expect(withModel({}, 'sonnet')).toEqual({ model: 'sonnet' });
        const next = withModel({ a: 1, model: 'x', b: { deep: [true] } }, 'y');
        expect(Object.keys(next)).toEqual(['a', 'model', 'b']);
        expect(next).toEqual({ a: 1, model: 'y', b: { deep: [true] } });
    });

    it('deletes the model for the runner default, never touching the rest', () => {
        expect(withModel({ a: 1, model: 'x' }, null)).toEqual({ a: 1 });
    });
});

describe('formatConfig', () => {
    it('pretty-prints valid text without losing unknown keys', () => {
        expect(formatConfig('{"a":1,"nested":{"b":[2]}}')).toBe(
            '{\n  "a": 1,\n  "nested": {\n    "b": [\n      2\n    ]\n  }\n}'
        );
    });

    it('answers null for text that does not parse', () => {
        expect(formatConfig('{ a: }')).toBeNull();
    });
});

describe('runnerManagedSettings', () => {
    it('names the Claude Code keys the board strips and the telemetry env the runner overrides', () => {
        const config = {
            model: 'sonnet',
            hooks: {},
            enabledPlugins: {},
            extraKnownMarketplaces: {},
            env: { FOO: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '0', OTEL_EXPORTER_OTLP_ENDPOINT: 'x' },
        };
        expect(runnerManagedSettings(CLAUDE_CODE, config)).toEqual([
            'hooks',
            'enabledPlugins',
            'extraKnownMarketplaces',
            'env.CLAUDE_CODE_ENABLE_TELEMETRY',
            'env.OTEL_EXPORTER_OTLP_ENDPOINT',
        ]);
    });

    it('names only permission for OpenCode', () => {
        expect(runnerManagedSettings(OPENCODE, { permission: {}, hooks: {}, env: { OTEL_X: '1' } })).toEqual([
            'permission',
        ]);
    });

    it('is the same list the claim strips', () => {
        for (const type of EXECUTOR_TYPES) {
            const config = Object.fromEntries(RUNNER_MANAGED_KEYS[type].map((key) => [key, {}]));
            expect(runnerManagedSettings(type, config)).toEqual([...RUNNER_MANAGED_KEYS[type]]);
        }
    });

    it('names key paths only — a credential value never appears', () => {
        const secret = 'sk-live-planted-secret';
        const found = runnerManagedSettings(CLAUDE_CODE, { hooks: secret, env: { OTEL_TOKEN: secret } });
        expect(found.join(' ')).not.toContain(secret);
    });
});

describe('validateExecutorName', () => {
    const existing = [validRow(), { ...validRow(), name: 'review' }];

    it('rejects a blank, slashed, or dash/dot-leading name', () => {
        for (const name of ['', '  ', 'a/b', 'a\\b', '-x', '.hidden']) {
            expect(validateExecutorName(name, [], null), name).not.toBeNull();
        }
    });

    it('rejects a duplicate of another row, but not the row being edited', () => {
        expect(validateExecutorName('review', existing, null)).toMatch(/already exists/);
        expect(validateExecutorName(' review ', existing, 'main')).toMatch(/already exists/);
        expect(validateExecutorName('main', existing, 'main')).toBeNull();
        expect(validateExecutorName('Code review', existing, null)).toBeNull();
    });
});

describe('initialExecutorDraft', () => {
    it('opens an add blank, on the first agent, with every agent inheriting', () => {
        const draft = initialExecutorDraft(undefined);
        expect(draft.name).toBe('');
        expect(draft.type).toBe(EXECUTOR_TYPES[0]);
        for (const type of EXECUTOR_TYPES) {
            expect(draft.configs[type]).toBe('{}');
            expect(draft.customModel[type]).toBe(false);
        }
        expect(draft.gateFixRounds).toBe('');
    });

    it('seeds an edit from the row, on its own agent only', () => {
        const row: ExecutorRow = {
            name: 'oc',
            type: OPENCODE,
            config: { model: 'anthropic/x', extra: 1 },
            isDefault: true,
            gateFixRounds: 2,
        };
        const draft = initialExecutorDraft(row);
        expect(draft.type).toBe(OPENCODE);
        expect(JSON.parse(draft.configs[OPENCODE])).toEqual(row.config);
        expect(draft.configs[CLAUDE_CODE]).toBe('{}');
        expect(draft.customModel[OPENCODE]).toBe(true);
        expect(draft.customModel[CLAUDE_CODE]).toBe(false);
        expect(draft.gateFixRounds).toBe('2');
    });
});

describe('validateExecutorDraft', () => {
    const draft = (patch: Partial<ExecutorDraft> = {}): ExecutorDraft => ({
        ...initialExecutorDraft(undefined),
        name: 'Code review',
        ...patch,
    });

    it('saves a name and an agent alone as the inherited configuration', () => {
        expect(validateExecutorDraft(draft(), [], null)).toEqual({
            ok: true,
            value: { name: 'Code review', type: CLAUDE_CODE, config: {}, gateFixRounds: 3 },
        });
    });

    it('carries only the active agent’s configuration', () => {
        const base = draft();
        const result = validateExecutorDraft(
            { ...base, type: OPENCODE, configs: { [CLAUDE_CODE]: '{"a":1}', [OPENCODE]: '{"b":2}' } },
            [],
            null
        );
        expect(result.ok && result.value.config).toEqual({ b: 2 });
    });

    it('attributes each failure to its field', () => {
        const cases: [ExecutorDraft, string][] = [
            [draft({ name: '' }), 'name'],
            [draft({ name: 'main' }), 'name'],
            [draft({ configs: { [CLAUDE_CODE]: '{ a: }', [OPENCODE]: '{}' } }), 'config'],
            [draft({ configs: { [CLAUDE_CODE]: '{"model":5}', [OPENCODE]: '{}' } }), 'model'],
            [draft({ customModel: { [CLAUDE_CODE]: true, [OPENCODE]: false } }), 'model'],
            [draft({ gateFixRounds: '11' }), 'rounds'],
        ];
        for (const [input, field] of cases) {
            const result = validateExecutorDraft(input, [validRow()], null);
            expect(result.ok, field).toBe(false);
            if (!result.ok) expect(result.field).toBe(field);
        }
    });

    it('covers every executor type in REQUIRED_FIELDS, requiring nothing today', () => {
        // The exhaustiveness guard: a new EXECUTOR_TYPES entry must declare its requirements,
        // even if the answer is "none", or this record stops compiling.
        for (const type of EXECUTOR_TYPES) expect(REQUIRED_FIELDS[type]).toEqual([]);
    });

    it('trims the name it keeps and carries the parsed round limit', () => {
        const result = validateExecutorDraft(draft({ name: '  main  ', gateFixRounds: '7' }), [], null);
        expect(result.ok && result.value.name).toBe('main');
        expect(result.ok && result.value.gateFixRounds).toBe(7);
    });
});

describe('executorDraftChanges', () => {
    const row: ExecutorRow = { ...validRow(), config: { model: 'sonnet', keep: 1 } };
    const baseline = initialExecutorDraft(row);

    it('reports an untouched edit as unchanged', () => {
        expect(executorDraftChanges(baseline, baseline)).toEqual({ payloadChanged: false, anyChanged: false });
    });

    it('does not count formatting alone as a saveable change', () => {
        const next = { ...baseline, configs: { ...baseline.configs, [CLAUDE_CODE]: '{"keep":1,"model":"sonnet"}' } };
        expect(executorDraftChanges(baseline, next).payloadChanged).toBe(false);
        expect(executorDraftChanges(baseline, next).anyChanged).toBe(true);
    });

    it('counts a rename, a type switch and a rounds edit as saveable', () => {
        expect(executorDraftChanges(baseline, { ...baseline, name: 'other' }).payloadChanged).toBe(true);
        expect(executorDraftChanges(baseline, { ...baseline, type: OPENCODE }).payloadChanged).toBe(true);
        expect(executorDraftChanges(baseline, { ...baseline, gateFixRounds: '4' }).payloadChanged).toBe(true);
    });

    it('counts an edit to the other agent’s draft as unsaved work, not a saveable change', () => {
        const next = { ...baseline, configs: { ...baseline.configs, [OPENCODE]: '{"model":"a/b"}' } };
        expect(executorDraftChanges(baseline, next)).toEqual({ payloadChanged: false, anyChanged: true });
    });

    it('treats an invalid draft as changed', () => {
        const next = { ...baseline, configs: { ...baseline.configs, [CLAUDE_CODE]: '{' } };
        expect(executorDraftChanges(baseline, next).payloadChanged).toBe(true);
    });
});

describe('executorEditorView', () => {
    const view = (draft: ExecutorDraft, nameTouched = false) =>
        executorEditorView({
            draft,
            baseline: initialExecutorDraft(undefined),
            existing: [validRow()],
            editing: null,
            nameTouched,
        });

    it('holds a blank name back until the field has been left, but still explains the disabled save', () => {
        const blank = initialExecutorDraft(undefined);
        expect(view(blank).nameError).toBeNull();
        expect(view(blank).unavailable).toBe(SAVE_HINTS.name);
        expect(view(blank, true).nameError).toBe('Give the executor a name.');
    });

    it('shows a duplicate beside the name before any save', () => {
        expect(view({ ...initialExecutorDraft(undefined), name: 'main' }).nameError).toMatch(/already exists/);
    });

    it('reports an unparseable configuration as the JSON’s error, never the model’s', () => {
        const draft = {
            ...initialExecutorDraft(undefined),
            name: 'x',
            configs: { [CLAUDE_CODE]: '{', [OPENCODE]: '{}' },
        };
        const result = view(draft);
        expect(result.parsed.ok).toBe(false);
        expect(result.jsonError).toMatch(/^Not valid JSON/);
        expect(result.modelError).toBeNull();
        expect(result.managed).toEqual([]);
    });

    it('reads a non-text model as unsupported, and names runner-managed keys', () => {
        const draft = {
            ...initialExecutorDraft(undefined),
            name: 'x',
            configs: { [CLAUDE_CODE]: '{"model":5,"hooks":{}}', [OPENCODE]: '{}' },
        };
        const result = view(draft);
        expect(result.modelUnsupported).toBe(true);
        expect(result.modelError).toBeNull();
        expect(result.managed).toEqual(['hooks']);
        expect(result.unavailable).toBe(SAVE_HINTS.model);
    });
});

describe('saveUnavailableReason', () => {
    const ok = { ok: true as const, value: { name: 'x', type: CLAUDE_CODE, config: {}, gateFixRounds: 3 } };

    it('points an invalid draft at its field, without repeating the error shown beside it', () => {
        for (const field of ['name', 'model', 'config', 'rounds'] as const) {
            const hint = saveUnavailableReason({ ok: false, error: 'the field’s own error', field }, true, false);
            expect(hint, field).toBe(SAVE_HINTS[field]);
            expect(hint, field).not.toBe('the field’s own error');
        }
        // What lives in the collapsed Advanced section says so, or the reader would not find it.
        expect(SAVE_HINTS.config).toMatch(/Advanced configuration/);
        expect(SAVE_HINTS.rounds).toMatch(/Advanced configuration/);
    });

    it('says an unchanged edit has nothing to save', () => {
        expect(saveUnavailableReason(ok, false, true)).toBe(NO_CHANGES_REASON);
    });

    it('answers null when the draft can be saved', () => {
        expect(saveUnavailableReason(ok, true, true)).toBeNull();
        // An add is always a change: the list does not have the row yet.
        expect(saveUnavailableReason(ok, false, false)).toBeNull();
    });
});

describe('tokenizeJson', () => {
    it('is lossless on valid, invalid and empty text', () => {
        for (const text of ['', '{\n  "a": [1, true, null]\n}', '{ a: "unterminated', '  \t\n']) {
            expect(
                tokenizeJson(text)
                    .map((token) => token.text)
                    .join('')
            ).toBe(text);
        }
    });

    it('tells a key from a string value, and classifies numbers, literals and punctuation', () => {
        const kinds = tokenizeJson('{"k": "v", "n": -1.5e3, "t": true, "z": null}')
            .filter((token) => token.kind !== 'space')
            .map((token) => `${token.kind}:${token.text}`);
        expect(kinds).toEqual([
            'punct:{',
            'key:"k"',
            'punct::',
            'string:"v"',
            'punct:,',
            'key:"n"',
            'punct::',
            'number:-1.5e3',
            'punct:,',
            'key:"t"',
            'punct::',
            'literal:true',
            'punct:,',
            'key:"z"',
            'punct::',
            'literal:null',
            'punct:}',
        ]);
    });

    it('keeps an escaped quote inside its string', () => {
        expect(tokenizeJson('"a\\"b"')).toEqual([{ kind: 'string', text: '"a\\"b"' }]);
    });

    it('marks what JSON cannot contain as invalid rather than dropping it', () => {
        expect(tokenizeJson('{ a }').some((token) => token.kind === 'invalid' && token.text === 'a')).toBe(true);
    });
});

describe('executorSavedMessage', () => {
    it('announces an add and an edit differently', () => {
        expect(executorSavedMessage('Code review', false)).toBe('Added executor “Code review”.');
        expect(executorSavedMessage('Code review', true)).toBe('Saved changes to “Code review”.');
    });
});

describe('validateGateFixRounds', () => {
    it('parses a bounded nonnegative integer and defaults a blank field to 3', () => {
        expect(validateGateFixRounds('')).toEqual({ ok: true, value: 3 });
        expect(validateGateFixRounds('   ')).toEqual({ ok: true, value: 3 });
        expect(validateGateFixRounds('0')).toEqual({ ok: true, value: 0 });
        expect(validateGateFixRounds('3')).toEqual({ ok: true, value: 3 });
        expect(validateGateFixRounds(' 10 ')).toEqual({ ok: true, value: 10 });
    });

    it('rejects out-of-range, fractional, and non-numeric input', () => {
        for (const raw of ['11', `${MAX_GATE_FIX_ROUNDS + 1}`, '-1', '2.5', 'three', '1e2']) {
            expect(validateGateFixRounds(raw).ok, raw).toBe(false);
        }
    });

    it('carries help copy that says what the setting does', () => {
        expect(GATE_FIX_ROUNDS_HELP).toMatch(/gate/i);
        expect(GATE_FIX_ROUNDS_HELP).toMatch(/0.*off|off.*0/i);
    });
});

describe('EXECUTOR_TYPE_META', () => {
    // The exhaustiveness guard, same shape as the REQUIRED_FIELDS one: a new EXECUTOR_TYPES entry
    // must declare its label, helps and model example, or this record stops compiling.
    it('covers every executor type', () => {
        for (const type of EXECUTOR_TYPES) expect(type in EXECUTOR_TYPE_META).toBe(true);
    });

    it('tells the claude-code truth: the config is merged, with the guard/plugin keys stripped', () => {
        const meta = EXECUTOR_TYPE_META['claude-code'];
        expect(meta.label).toBe('Claude Code');
        expect(meta.configHelp).toMatch(/merged into the runner/);
        expect(meta.configHelp).toMatch(/hooks.*enabledPlugins.*extraKnownMarketplaces/);
        expect(meta.configHelp).toMatch(/CLAUDE_CODE_ENABLE_TELEMETRY.*OTEL_.*always wins/);
        expect(meta.modelExample).toBe('claude-sonnet-4-5');
        expect(meta.modelHelp).toMatch(/alias/);
    });

    it('tells the opencode truth: the profile selects OpenCode and permission is ignored', () => {
        const meta = EXECUTOR_TYPE_META.opencode;
        expect(meta.label).toBe('OpenCode');
        expect(meta.configHelp).toMatch(/Tasks using this executor run OpenCode/);
        expect(meta.configHelp).toMatch(/merged over its baked configuration/);
        expect(meta.configHelp).toMatch(/permission rules are ignored/);
        // OpenCode names a model by provider and model id; the example carries that shape and
        // nothing that looks like a live credential.
        expect(meta.modelExample).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/);
        expect(meta.modelHelp).toMatch(/provider/);
    });

    it('maps wire types to human labels and never undefined for an unknown one', () => {
        expect(executorTypeLabel('claude-code')).toBe('Claude Code');
        expect(executorTypeLabel('opencode')).toBe('OpenCode');
        expect(executorTypeLabel('weird')).toBe('weird');
    });
});

describe('mergeExecutors', () => {
    const first: ValidExecutor = { name: 'main', type: 'claude-code', config: { model: 'sonnet' }, gateFixRounds: 3 };
    const second: ValidExecutor = { name: 'oc', type: 'opencode', config: { model: 'x' }, gateFixRounds: 1 };
    const firstRow: ExecutorRow = { ...first };
    const secondRow: ExecutorRow = { ...second };

    it('appends a new executor and preserves order', () => {
        const result = mergeExecutors([firstRow], null, second);
        expect(result).toEqual({ ok: true, value: [firstRow, secondRow] });
    });

    it('replaces the edited row, matched by its original name, keeping its position', () => {
        // A rename changes the name the row is saved under; the match is still against the name
        // the row had when the dialog opened.
        const renamed: ValidExecutor = { name: 'renamed', type: 'claude-code', config: {}, gateFixRounds: 3 };
        const result = mergeExecutors([firstRow, secondRow], 'main', renamed);
        expect(result).toEqual({ ok: true, value: [{ ...renamed }, secondRow] });
    });

    it('keeps the round limit the dialog saved on the edited row', () => {
        const changed: ValidExecutor = {
            name: 'main',
            type: 'claude-code',
            config: { model: 'opus' },
            gateFixRounds: 5,
        };
        const result = mergeExecutors([firstRow, secondRow], 'main', changed);
        expect(result.ok && result.value[0]?.gateFixRounds).toBe(5);
    });

    it('allows saving an edit with the name unchanged', () => {
        const changed: ValidExecutor = {
            name: 'main',
            type: 'claude-code',
            config: { model: 'opus' },
            gateFixRounds: 3,
        };
        const result = mergeExecutors([firstRow, secondRow], 'main', changed);
        expect(result).toEqual({ ok: true, value: [{ ...changed }, secondRow] });
    });

    it('rejects a rename onto another row’s name', () => {
        const result = mergeExecutors([firstRow, secondRow], 'main', { ...first, name: 'oc' });
        expect(result).toEqual({ ok: false, error: 'An executor named "oc" already exists.' });
    });

    it('rejects an add onto an existing name', () => {
        const result = mergeExecutors([firstRow], null, { ...first, config: {} });
        expect(result).toEqual({ ok: false, error: 'An executor named "main" already exists.' });
    });

    it('rejects an edit whose row is no longer there', () => {
        // The row vanished between the panel render and the save — deleted in another tab, say.
        // Merging it back would silently resurrect it; the caller says so instead.
        const result = mergeExecutors([], 'main', first);
        expect(result.ok).toBe(false);
    });
});

describe('executor choices — the scope-qualified selection identity (issue 391)', () => {
    it('round-trips a choice through its select identity', () => {
        const id = executorChoiceId({ scope: 'org', name: 'team-runner' });
        expect(executorChoiceOf(id)).toEqual({ scope: 'org', name: 'team-runner' });
        expect(executorChoiceOf(executorChoiceId({ scope: 'user', name: 'main' }))).toEqual({
            scope: 'user',
            name: 'main',
        });
    });

    it('keeps a personal and an org profile with the same name distinguishable', () => {
        // The whole point of qualifying the identity: the same name in both scopes is TWO rows,
        // and the select value — never the name alone — is what disambiguates them.
        const personal = executorChoiceId({ scope: 'user', name: 'main' });
        const org = executorChoiceId({ scope: 'org', name: 'main' });
        expect(personal).not.toBe(org);
        expect(executorChoiceOf(personal)).toEqual({ scope: 'user', name: 'main' });
        expect(executorChoiceOf(org)).toEqual({ scope: 'org', name: 'main' });
    });

    it('answers null for a value that is not a choice', () => {
        expect(executorChoiceOf('')).toBeNull();
        expect(executorChoiceOf('main')).toBeNull();
        expect(executorChoiceOf('repo:main')).toBeNull();
    });
});

describe('composerExecutorOptions — the composer lists both scopes (issue 391)', () => {
    it('offers the organization profiles beside the personal ones, personal first', () => {
        const personal = [{ name: 'mine', type: 'opencode' }];
        const org = [{ name: 'shared', type: 'claude-code' }];
        expect(composerExecutorOptions(personal, org)).toEqual([
            { scope: 'user', name: 'mine', type: 'opencode' },
            { scope: 'org', name: 'shared', type: 'claude-code' },
        ]);
    });

    it('still offers the organization profiles when the member has no personal ones', () => {
        expect(composerExecutorOptions([], [{ name: 'shared', type: 'claude-code' }])).toEqual([
            { scope: 'org', name: 'shared', type: 'claude-code' },
        ]);
        expect(composerExecutorOptions([], [])).toEqual([]);
    });

    it('leaves a suspended profile out of either scope, keeping a same-named active one in the other (issue 440)', () => {
        const personal = [
            { name: 'same', type: 'opencode', suspended: true },
            { name: 'live', type: 'opencode', suspended: false },
        ];
        const org = [
            { name: 'same', type: 'claude-code', suspended: false },
            { name: 'paused', type: 'claude-code', suspended: true },
        ];
        expect(composerExecutorOptions(personal, org)).toEqual([
            { scope: 'user', name: 'live', type: 'opencode' },
            { scope: 'org', name: 'same', type: 'claude-code' },
        ]);
    });

    it('offers nothing once the last active profile is suspended — the empty state', () => {
        expect(composerExecutorOptions([{ name: 'only', type: 'opencode', suspended: true }], [])).toEqual([]);
    });
});

describe('mergeExecutors — suspension (issue 440)', () => {
    const suspendedRow: ExecutorRow = {
        name: 'main',
        type: 'claude-code',
        config: {},
        gateFixRounds: 3,
        suspended: true,
    };
    const edited: ValidExecutor = { name: 'renamed', type: 'claude-code', config: { model: 'x' }, gateFixRounds: 3 };

    it('keeps a suspended row suspended through an edit and a rename', () => {
        const result = mergeExecutors([suspendedRow], 'main', edited);
        expect(result).toEqual({ ok: true, value: [{ ...edited, suspended: true }] });
    });

    it('does not add a suspension to a row that had none', () => {
        const active: ExecutorRow = { name: 'main', type: 'claude-code', config: {}, gateFixRounds: 3 };
        const result = mergeExecutors([active], 'main', edited);
        expect(result.ok && result.value[0]).not.toHaveProperty('suspended');
    });
});
