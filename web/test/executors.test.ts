import { describe, expect, it } from 'vitest';
import { EXECUTOR_TYPES } from '@factory-ai/core';
import {
    EXECUTOR_TYPE_META,
    MAX_CONFIG_BYTES,
    REQUIRED_FIELDS,
    defaultExecutorName,
    executorTypeLabel,
    mergeExecutors,
    validateExecutorConfig,
    validateExecutorPayload,
    withDefault,
    type ExecutorRow,
    type ValidExecutor,
} from '../src/workspace/executors.js';

const valid = () => validateExecutorConfig('{ "model": "sonnet" }', 'main', 'claude-code');

describe('validateExecutorPayload', () => {
    // The dialog's live textarea error is the payload's — parse, object, per-type fields, size —
    // and never the name's: a blank name must not arrive as the config field's problem.
    it('accepts a JSON object regardless of the name', () => {
        expect(validateExecutorPayload('{ "model": "sonnet" }', 'claude-code')).toEqual({
            ok: true,
            value: { model: 'sonnet' },
        });
    });

    it('rejects paste that is not JSON, an empty paste, or a non-object', () => {
        expect(validateExecutorPayload('{ model: }', 'claude-code').ok).toBe(false);
        expect(validateExecutorPayload('   ', 'claude-code').ok).toBe(false);
        expect(validateExecutorPayload('[]', 'opencode').ok).toBe(false);
        expect(validateExecutorPayload('null', 'opencode').ok).toBe(false);
    });

    it('rejects a payload over the size limit', () => {
        const big = JSON.stringify({ padding: 'x'.repeat(MAX_CONFIG_BYTES) });
        expect(validateExecutorPayload(big, 'claude-code').ok).toBe(false);
    });

    it('stays name-agnostic: "{}" with no name anywhere is a valid payload', () => {
        const result = validateExecutorPayload('{}', 'opencode');
        expect(result).toEqual({ ok: true, value: {} });
    });
});

describe('validateExecutorConfig', () => {
    it('accepts a plain object with a name and a known type', () => {
        expect(valid()).toEqual({
            ok: true,
            value: { name: 'main', type: 'claude-code', config: { model: 'sonnet' } },
        });
    });

    it('trims the name it keeps', () => {
        const result = validateExecutorConfig('{}', '  main  ', 'claude-code');
        expect(result.ok && result.value.name).toBe('main');
    });

    it('rejects paste that is not JSON, with the parser said so', () => {
        const result = validateExecutorConfig('{ model: sonnet }', 'main', 'claude-code');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/Not valid JSON/);
    });

    it('rejects an empty paste', () => {
        expect(validateExecutorConfig('   ', 'main', 'claude-code').ok).toBe(false);
    });

    it('rejects a JSON array or scalar as the config', () => {
        // An object is the contract; an array would pass a naive `typeof === 'object'` check.
        expect(validateExecutorConfig('[]', 'main', 'claude-code').ok).toBe(false);
        expect(validateExecutorConfig('7', 'main', 'claude-code').ok).toBe(false);
        expect(validateExecutorConfig('"text"', 'main', 'claude-code').ok).toBe(false);
        expect(validateExecutorConfig('null', 'main', 'claude-code').ok).toBe(false);
    });

    it('rejects a blank, slashed, or dash-leading name', () => {
        for (const name of ['', '  ', 'a/b', 'a\\b', '-x', '.hidden']) {
            const result = validateExecutorConfig('{}', name, 'claude-code');
            expect(result.ok, name).toBe(false);
        }
    });

    it('enforces the per-type required fields', () => {
        // Empty today — the contract is raw JSON until a consumer defines the fields — but the
        // mechanism is asserted so adding a requirement actually bites.
        expect(REQUIRED_FIELDS['claude-code']).toEqual([]);
    });

    it('rejects a config over the size limit', () => {
        const big = JSON.stringify({ padding: 'x'.repeat(MAX_CONFIG_BYTES) });
        expect(validateExecutorConfig(big, 'main', 'claude-code').ok).toBe(false);
    });

    it('covers every executor type in REQUIRED_FIELDS', () => {
        // The exhaustiveness guard: a new EXECUTOR_TYPES entry must declare its requirements,
        // even if the answer is "none", or this record stops compiling.
        for (const type of EXECUTOR_TYPES) expect(type in REQUIRED_FIELDS).toBe(true);
    });

    it('accepts an opencode executor with a plain object config', () => {
        const result = validateExecutorConfig('{ "model": "x" }', 'main', 'opencode');
        expect(result).toEqual({
            ok: true,
            value: { name: 'main', type: 'opencode', config: { model: 'x' } },
        });
    });

    it('requires no config fields for opencode either', () => {
        // Same raw-JSON contract as claude-code: field rules wait for a consumer that can be
        // wrong about them.
        expect(REQUIRED_FIELDS['opencode']).toEqual([]);
    });
});

describe('EXECUTOR_TYPE_META', () => {
    // The exhaustiveness guard, same shape as the REQUIRED_FIELDS one: a new EXECUTOR_TYPES entry
    // must declare its label, help and example, or this record stops compiling.
    it('covers every executor type', () => {
        for (const type of EXECUTOR_TYPES) expect(type in EXECUTOR_TYPE_META).toBe(true);
    });

    it('tells the claude-code truth: the config is merged, with the guard/plugin keys stripped', () => {
        const meta = EXECUTOR_TYPE_META['claude-code'];
        expect(meta.label).toBe('Claude Code');
        expect(meta.configHelp).toMatch(/merged into the runner/);
        expect(meta.configHelp).toMatch(/hooks.*enabledPlugins.*extraKnownMarketplaces/);
        expect(meta.configHelp).toMatch(/CLAUDE_CODE_ENABLE_TELEMETRY.*OTEL_.*always wins/);
        expect(JSON.parse(meta.example)).toEqual({});
    });

    it('tells the opencode truth: the profile selects OpenCode and permission is ignored', () => {
        const meta = EXECUTOR_TYPE_META.opencode;
        expect(meta.label).toBe('OpenCode');
        expect(meta.configHelp).toMatch(/Tasks using this executor run OpenCode/);
        expect(meta.configHelp).toMatch(/merged over its baked configuration/);
        expect(meta.configHelp).toMatch(/permission rules are ignored/);
        // The example illustrates the keys that do apply, and carries nothing that looks like a
        // live credential.
        const example = JSON.parse(meta.example) as Record<string, unknown>;
        expect(example).toHaveProperty('model');
        expect(example).toHaveProperty('provider');
        expect(meta.example).not.toMatch(/sk-[a-zA-Z0-9]{8,}/);
    });

    it('maps wire types to human labels and never undefined for an unknown one', () => {
        expect(executorTypeLabel('claude-code')).toBe('Claude Code');
        expect(executorTypeLabel('opencode')).toBe('OpenCode');
        expect(executorTypeLabel('weird')).toBe('weird');
    });
});

describe('mergeExecutors', () => {
    const first: ValidExecutor = { name: 'main', type: 'claude-code', config: { model: 'sonnet' } };
    const second: ValidExecutor = { name: 'oc', type: 'opencode', config: { model: 'x' } };
    const firstRow: ExecutorRow = { ...first, isDefault: false };
    const secondRow: ExecutorRow = { ...second, isDefault: false };

    it('appends a new executor and preserves order', () => {
        const result = mergeExecutors([firstRow], null, second);
        expect(result).toEqual({ ok: true, value: [firstRow, secondRow] });
    });

    it('replaces the edited row, matched by its original name, keeping its position', () => {
        // A rename changes the name the row is saved under; the match is still against the name
        // the row had when the dialog opened.
        const renamed: ValidExecutor = { name: 'renamed', type: 'claude-code', config: {} };
        const result = mergeExecutors([firstRow, secondRow], 'main', renamed);
        expect(result).toEqual({ ok: true, value: [{ ...renamed, isDefault: false }, secondRow] });
    });

    it('allows saving an edit with the name unchanged', () => {
        const changed: ValidExecutor = { name: 'main', type: 'claude-code', config: { model: 'opus' } };
        const result = mergeExecutors([firstRow, secondRow], 'main', changed);
        expect(result).toEqual({ ok: true, value: [{ ...changed, isDefault: false }, secondRow] });
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

    it('keeps the default flag across a rename', () => {
        const defaultRow: ExecutorRow = { ...firstRow, isDefault: true };
        const renamed: ValidExecutor = { name: 'renamed', type: 'claude-code', config: {} };
        const result = mergeExecutors([defaultRow, secondRow], 'main', renamed);
        expect(result).toEqual({ ok: true, value: [{ ...renamed, isDefault: true }, secondRow] });
    });

    it('never makes an added row the default', () => {
        const defaultRow: ExecutorRow = { ...firstRow, isDefault: true };
        const result = mergeExecutors([defaultRow], null, second);
        expect(result).toEqual({ ok: true, value: [defaultRow, secondRow] });
    });
});

describe('withDefault', () => {
    const first: ExecutorRow = { name: 'main', type: 'claude-code', config: {}, isDefault: false };
    const second: ExecutorRow = { name: 'oc', type: 'opencode', config: {}, isDefault: true };

    it('flags exactly the named row and clears every other', () => {
        const result = withDefault([first, second], 'main');
        expect(result).toEqual({
            ok: true,
            value: [
                { ...first, isDefault: true },
                { ...second, isDefault: false },
            ],
        });
    });

    it('is a no-op when the named row is already the default', () => {
        const result = withDefault([first, second], 'oc');
        expect(result).toEqual({ ok: true, value: [first, second] });
    });

    it('refuses a name that no longer exists', () => {
        const result = withDefault([first, second], 'gone');
        expect(result).toEqual({ ok: false, error: '"gone" no longer exists — refresh and try again.' });
    });
});

describe('defaultExecutorName', () => {
    it('answers the flagged row even when it is not first', () => {
        const rows = [
            { name: 'main', isDefault: false },
            { name: 'heavy', isDefault: true },
        ];
        expect(defaultExecutorName(rows)).toBe('heavy');
    });

    it('falls back to the first row when none is flagged', () => {
        const rows = [{ name: 'main', isDefault: false }, { name: 'heavy' }];
        expect(defaultExecutorName(rows)).toBe('main');
    });

    it('answers an empty string for an empty list', () => {
        expect(defaultExecutorName([])).toBe('');
    });
});
