import { describe, expect, it } from 'vitest';
import {
    countActive,
    envPayload,
    isDirty,
    nextTabIndex,
    payloadEquals,
    rowErrors,
    scopeError,
    SECRET_STATE_LABEL,
    secretState,
    seedRows,
    advancedUnapplied,
    type EnvRowState,
} from '../src/panels/env-draft.js';
import { serializeEnv } from '../src/panels/env-raw.js';

const storedVar = (name: string, value: string, id = name): EnvRowState => ({
    id,
    name,
    value,
    isSecret: false,
    isNew: false,
    pendingRemove: false,
});

const storedSecret = (name: string, id = name): EnvRowState => ({
    id,
    name,
    value: null,
    isSecret: true,
    isNew: false,
    pendingRemove: false,
});

describe('canonical dirty comparison', () => {
    it('reads clean after seeding and re-seeding the same rows — an echo round-trip', () => {
        const rows = seedRows([
            { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
            { name: 'TOKEN', value: null, isSecret: true },
        ]);
        expect(
            isDirty(
                rows,
                rows.map((row) => ({ ...row }))
            )
        ).toBe(false);
    });

    it('stays clean when the draft is reordered — the store reads back ordered by name', () => {
        const rows = [storedVar('A', '1'), storedVar('B', '2')];
        expect(isDirty(rows, [rows[1], rows[0]])).toBe(false);
    });

    it('goes dirty on an edited value, an addition, and a blank-name row nobody finished', () => {
        const rows = [storedVar('A', '1')];
        expect(isDirty(rows, [storedVar('A', '2')])).toBe(true);
        expect(isDirty(rows, [rows[0], storedVar('NEW', '', 'r9')])).toBe(true);
        expect(isDirty(rows, [rows[0], { ...storedVar('', '', 'r10'), isNew: true }])).toBe(true);
    });

    it('reads a cleared secret input as keep — the wire has one blank form, null', () => {
        const rows = [storedSecret('TOKEN')];
        // A typed-then-cleared input (value '') PUTs the same keep marker as an untouched one, so
        // undoing a replacement returns the editor to clean. The null/'' distinction the row
        // contract needs lives in secretState and the new-row validation, not on the wire.
        expect(payloadEquals(envPayload(rows), envPayload([{ ...rows[0], value: '' }]))).toBe(true);
        expect(envPayload(rows)).toEqual([{ name: 'TOKEN', value: null, isSecret: true }]);
        // A typed replacement is the one distinct payload.
        expect(payloadEquals(envPayload(rows), envPayload([{ ...rows[0], value: 'next' }]))).toBe(false);
    });

    it('excludes a pending-removed row from the payload, which makes the draft dirty', () => {
        const rows = [storedVar('A', '1'), storedVar('B', '2')];
        const draft = [rows[0], { ...rows[1], pendingRemove: true }];
        expect(envPayload(draft)).toEqual([{ name: 'A', value: '1', isSecret: false }]);
        expect(isDirty(rows, draft)).toBe(true);
    });

    it('trims names in the payload — a stray space is not a change', () => {
        const rows = [storedVar('A', '1')];
        expect(payloadEquals(envPayload(rows), envPayload([{ ...rows[0], name: ' A ' }]))).toBe(true);
    });
});

describe('row validation — the server rules, mirrored for early feedback', () => {
    it('requires a non-empty legal name', () => {
        const errors = rowErrors([{ ...storedVar('', '', 'r1'), isNew: true }]);
        expect(errors.get('r1')).toContain('Name is required.');
        const bad = rowErrors([storedVar('has space')]);
        expect(bad.get('has space')?.[0]).toMatch(/not a legal environment variable name/);
    });

    it('refuses over-limit and reserved names', () => {
        const OVER_NAME_LIMIT = 256;
        const long = rowErrors([storedVar('A'.repeat(OVER_NAME_LIMIT))]);
        expect(long.get('A'.repeat(OVER_NAME_LIMIT))?.[0]).toMatch(/255 characters/);
        const reserved = rowErrors([storedVar('WORKDIR')]);
        expect(reserved.get('WORKDIR')?.[0]).toMatch(/reserved by the runner/);
    });

    it('flags every member of a duplicate pair, on the trimmed name', () => {
        const errors = rowErrors([storedVar('A', '1', 'r1'), storedVar('A', '2', 'r2')]);
        expect(errors.get('r1')?.[0]).toMatch(/Duplicate name "A"/);
        expect(errors.get('r2')?.[0]).toMatch(/Duplicate name "A"/);
    });

    it('refuses a value with a newline or past the value limit', () => {
        expect(rowErrors([storedVar('A', 'one\ntwo')]).get('A')?.[0]).toMatch(/newline/);
        const OVER_VALUE_LIMIT = 32_769;
        expect(rowErrors([storedVar('A', 'x'.repeat(OVER_VALUE_LIMIT))]).get('A')?.[0]).toMatch(/32.*768 characters/);
    });

    it('marks a new secret with no value Not set, and a stored blank secret is the keep marker', () => {
        const fresh = rowErrors([{ ...storedSecret('NEW', 'r1'), isNew: true, value: '' }]);
        expect(fresh.get('r1')?.[0]).toMatch(/Enter a value or remove the row/);
        expect(rowErrors([storedSecret('OLD', 'r2')]).get('r2')).toBeUndefined();
    });

    it('never flags a pending-removed row, whatever its name', () => {
        const errors = rowErrors([{ ...storedVar('has space', 'x', 'r1'), pendingRemove: true }]);
        expect(errors.get('r1')).toBeUndefined();
    });

    it('caps the scope at one hundred active rows, counting pending-removed rows as gone', () => {
        const hundred = Array.from({ length: 100 }, (_, i) => storedVar(`V${i}`, 'x'));
        expect(scopeError(hundred)).toBeNull();
        expect(scopeError([...hundred, storedVar('V100', 'x')])).toMatch(/at most 100/i);
        const overButOnePending = [...hundred, { ...storedVar('V100', 'x'), pendingRemove: true }];
        expect(scopeError(overButOnePending)).toBeNull();
    });
});

describe('secret state', () => {
    it('is Set for a stored secret whose input is blank, and stays Set when the input is cleared', () => {
        expect(secretState(storedSecret('TOKEN'))).toBe('set');
        expect(secretState({ ...storedSecret('TOKEN'), value: '' })).toBe('set');
    });

    it('is Will replace when saved once a value is typed', () => {
        expect(secretState({ ...storedSecret('TOKEN'), value: 'next' })).toBe('replace');
        expect(secretState({ ...storedSecret('TOKEN', 'r1'), isNew: true, value: 'next' })).toBe('replace');
    });

    it('is Not set for a new secret row that has no value yet', () => {
        expect(secretState({ ...storedSecret('NEW'), isNew: true, value: '' })).toBe('not-set');
    });

    it('carries the row labels the tab renders', () => {
        expect(SECRET_STATE_LABEL.set).toBe('Set');
        expect(SECRET_STATE_LABEL.replace).toBe('Will replace when saved');
        expect(SECRET_STATE_LABEL['not-set']).toBe('Not set');
    });
});

describe('the advanced .env disclosure', () => {
    it('holds nothing unapplied while the text matches the active variable rows', () => {
        const rows = [storedVar('A', '1'), storedSecret('TOKEN')];
        expect(advancedUnapplied(serializeEnv(rows), rows)).toBe(false);
    });

    it('holds unapplied text once the textarea differs from the draft', () => {
        const rows = [storedVar('A', '1'), storedSecret('TOKEN')];
        expect(advancedUnapplied('A=2', rows)).toBe(true);
        // A pending-removed variable is not in the seed text: applying the untouched text twice
        // must not resurrect it, and the untouched text counts as applied.
        const pending = [storedVar('A', '1'), { ...storedVar('B', '2', 'r2'), pendingRemove: true }];
        expect(advancedUnapplied(serializeEnv([pending[0]]), pending)).toBe(false);
    });
});

describe('tab roving focus', () => {
    const key = (current: number, k: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End') => nextTabIndex(current, 2, k);

    it('wraps in both directions', () => {
        expect(key(0, 'ArrowRight')).toBe(1);
        expect(key(1, 'ArrowRight')).toBe(0);
        expect(key(0, 'ArrowLeft')).toBe(1);
        expect(key(1, 'ArrowLeft')).toBe(0);
    });

    it('jumps Home to the first tab and End to the last', () => {
        expect(key(1, 'Home')).toBe(0);
        expect(key(0, 'End')).toBe(1);
    });

    it('answers null for any other key, and for a count of zero', () => {
        expect(nextTabIndex(0, 2, 'Enter')).toBeNull();
        expect(nextTabIndex(0, 0, 'ArrowRight')).toBeNull();
    });
});

describe('tab counts', () => {
    it('include additions and exclude pending removals', () => {
        const rows = [
            storedVar('A', '1'),
            { ...storedVar('B', '2'), pendingRemove: true },
            { ...storedSecret('TOKEN') },
            { ...storedSecret('NEW', 'r9'), isNew: true, value: '' },
        ];
        expect(countActive(rows, false)).toBe(1);
        expect(countActive(rows, true)).toBe(2);
    });
});
