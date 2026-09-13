import { describe, expect, it } from 'vitest';
import { EXECUTOR_TYPES } from '@factory-ai/core';
import {
    MAX_CONFIG_BYTES,
    REQUIRED_FIELDS,
    mergeExecutors,
    validateExecutorConfig,
    type ValidExecutor,
} from '../src/workspace/executors.js';

const valid = () => validateExecutorConfig('{ "model": "sonnet" }', 'main', 'claude-code');

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

describe('mergeExecutors', () => {
    const first: ValidExecutor = { name: 'main', type: 'claude-code', config: { model: 'sonnet' } };
    const second: ValidExecutor = { name: 'oc', type: 'opencode', config: { model: 'x' } };

    it('appends a new executor and preserves order', () => {
        const result = mergeExecutors([first], null, second);
        expect(result).toEqual({ ok: true, value: [first, second] });
    });

    it('replaces the edited row, matched by its original name, keeping its position', () => {
        // A rename changes the name the row is saved under; the match is still against the name
        // the row had when the dialog opened.
        const renamed: ValidExecutor = { name: 'renamed', type: 'claude-code', config: {} };
        const result = mergeExecutors([first, second], 'main', renamed);
        expect(result).toEqual({ ok: true, value: [renamed, second] });
    });

    it('allows saving an edit with the name unchanged', () => {
        const changed: ValidExecutor = { name: 'main', type: 'claude-code', config: { model: 'opus' } };
        const result = mergeExecutors([first, second], 'main', changed);
        expect(result).toEqual({ ok: true, value: [changed, second] });
    });

    it('rejects a rename onto another row’s name', () => {
        const result = mergeExecutors([first, second], 'main', { ...first, name: 'oc' });
        expect(result).toEqual({ ok: false, error: 'An executor named "oc" already exists.' });
    });

    it('rejects an add onto an existing name', () => {
        const result = mergeExecutors([first], null, { ...first, config: {} });
        expect(result).toEqual({ ok: false, error: 'An executor named "main" already exists.' });
    });

    it('rejects an edit whose row is no longer there', () => {
        // The row vanished between the panel render and the save — deleted in another tab, say.
        // Merging it back would silently resurrect it; the caller says so instead.
        const result = mergeExecutors([], 'main', first);
        expect(result.ok).toBe(false);
    });
});
