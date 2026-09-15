import { describe, expect, it } from 'vitest';
import {
    MAX_ENV_VARS_PER_SCOPE,
    NAME_LIMIT,
    RESERVED_ENV_NAMES,
    VALUE_LIMIT,
    parseEnvPaste,
    type EnvVarRow,
} from '../src/panels/env-paste.js';

const noExisting: EnvVarRow[] = [];

const ok = (vars: EnvVarRow[]) => ({ ok: true as const, vars });

describe('the .env paste parser', () => {
    it('mirrors the server rules it duplicates', () => {
        // Copied, not imported, from server/src/routes/env.ts — this pin makes drift loud.
        expect(MAX_ENV_VARS_PER_SCOPE).toBe(100);
        expect(VALUE_LIMIT).toBe(32 * 1024);
        expect(NAME_LIMIT).toBe(255);
        expect(RESERVED_ENV_NAMES).toEqual([
            'WORKDIR',
            'TRUST_WORKDIR',
            'BELLOWS_GATE_URL',
            'BELLOWS_GATE_TOKEN',
            'CRED_HELPER',
            'RESTORE',
            'FACTORY_TRANSCRIPT_DIR',
            'FACTORY_STATS_URL',
            'INGEST_TOKEN',
            'BELLOWS_SESSION_ID',
            'OPENCODE_CONFIG_CONTENT',
        ]);
    });

    it('parses KEY=value pairs', () => {
        expect(parseEnvPaste('LOG_LEVEL=debug\nPORT=8080', noExisting)).toEqual(
            ok([
                { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
                { name: 'PORT', value: '8080', isSecret: false },
            ])
        );
    });

    it('strips an export prefix', () => {
        expect(parseEnvPaste('export KEY=value', noExisting)).toEqual(
            ok([{ name: 'KEY', value: 'value', isSecret: false }])
        );
    });

    it('skips blank lines and # comment lines', () => {
        const text = '\n# a comment\nKEY=value\n   \n   # indented comment\n';
        expect(parseEnvPaste(text, noExisting)).toEqual(ok([{ name: 'KEY', value: 'value', isSecret: false }]));
    });

    it('strips one pair of surrounding double or single quotes', () => {
        const result = parseEnvPaste('A="quoted"\nB=\'single\'\nC="a"b"', noExisting);
        expect(result).toEqual(
            ok([
                { name: 'A', value: 'quoted', isSecret: false },
                { name: 'B', value: 'single', isSecret: false },
                { name: 'C', value: 'a"b', isSecret: false },
            ])
        );
    });

    it('does no escape processing: backslash-n stays literal and inline # is value text', () => {
        const result = parseEnvPaste('A=line1\\nline2\nB=#notcomment\nC=a#b', noExisting);
        expect(result).toEqual(
            ok([
                { name: 'A', value: 'line1\\nline2', isSecret: false },
                { name: 'B', value: '#notcomment', isSecret: false },
                { name: 'C', value: 'a#b', isSecret: false },
            ])
        );
    });

    it('accepts an empty value and trims around the = sign', () => {
        const result = parseEnvPaste('EMPTY=\nSPACED =  spaced value  ', noExisting);
        expect(result).toEqual(
            ok([
                { name: 'EMPTY', value: '', isSecret: false },
                { name: 'SPACED', value: 'spaced value', isSecret: false },
            ])
        );
    });

    it('keeps spacing inside quotes after stripping the pair', () => {
        expect(parseEnvPaste('A=" v "', noExisting)).toEqual(ok([{ name: 'A', value: ' v ', isSecret: false }]));
    });

    it('normalizes CR-LF line endings', () => {
        expect(parseEnvPaste('A=1\r\nB=2\rC=3', noExisting)).toEqual(
            ok([
                { name: 'A', value: '1', isSecret: false },
                { name: 'B', value: '2', isSecret: false },
                { name: 'C', value: '3', isSecret: false },
            ])
        );
    });

    it('merges over existing variables and appends new names, leaving secrets alone', () => {
        const existing: EnvVarRow[] = [
            { name: 'A', value: '1', isSecret: false },
            { name: 'S', value: null, isSecret: true },
            { name: 'B', value: 'old', isSecret: false },
        ];
        const result = parseEnvPaste('A=2\nNEW=3', existing);
        expect(result).toEqual(
            ok([
                { name: 'A', value: '2', isSecret: false },
                { name: 'S', value: null, isSecret: true },
                { name: 'B', value: 'old', isSecret: false },
                { name: 'NEW', value: '3', isSecret: false },
            ])
        );
    });

    it('refuses a line with no = sign, with its line number', () => {
        const result = parseEnvPaste('A=1\nnot-a-pair\nB=2', noExisting);
        expect(result).toEqual({ ok: false, errors: ['line 2: expected KEY=value'] });
    });

    it('refuses an empty name, with its line number', () => {
        expect(parseEnvPaste('=x', noExisting)).toEqual({ ok: false, errors: ['line 1: expected KEY=value'] });
    });

    it('refuses illegal names, with the line number', () => {
        const result = parseEnvPaste('1BAD=x\nA-B=y', noExisting);
        expect(result).toEqual({
            ok: false,
            errors: [
                'line 1: "1BAD" is not a legal environment variable name',
                'line 2: "A-B" is not a legal environment variable name',
            ],
        });
    });

    it('refuses a name over the length limit, with the line number', () => {
        const name = 'A'.repeat(NAME_LIMIT + 1);
        const result = parseEnvPaste(`${name}=x`, noExisting);
        expect(result).toEqual({ ok: false, errors: [`line 1: name exceeds ${NAME_LIMIT} characters`] });
    });

    it('refuses reserved names, with the line number', () => {
        expect(parseEnvPaste('WORKDIR=/tmp', noExisting)).toEqual({
            ok: false,
            errors: ['line 1: "WORKDIR" is reserved by the runner'],
        });
    });

    it('refuses a value over the size limit, with the line number', () => {
        const result = parseEnvPaste(`A=${'x'.repeat(VALUE_LIMIT + 1)}`, noExisting);
        expect(result).toEqual({ ok: false, errors: [`line 1: value for "A" exceeds ${VALUE_LIMIT} characters`] });
    });

    it('refuses a quoted value that runs over the next line, because parsing is line-structured', () => {
        // The real shape of "a value containing a newline": the continuation arrives as its own
        // line, and a line with no = is refused — docker --env-file would have truncated it.
        const result = parseEnvPaste('A="starts\nstill starting"', noExisting);
        expect(result).toEqual({ ok: false, errors: ['line 2: expected KEY=value'] });
    });

    it('refuses duplicate names within the paste, with both line numbers', () => {
        const result = parseEnvPaste('A=1\nB=2\nA=3', noExisting);
        expect(result).toEqual({ ok: false, errors: ['line 3: duplicate name "A" (first seen on line 1)'] });
    });

    it('refuses a name that collides with an existing secret in the scope', () => {
        const existing: EnvVarRow[] = [{ name: 'S', value: null, isSecret: true }];
        expect(parseEnvPaste('A=1\nS=new', existing)).toEqual({
            ok: false,
            errors: ['line 2: "S" is already a secret in this scope — edit it on the Secrets tab'],
        });
    });

    it('refuses a paste that would push the scope past its cap, at the tipping line', () => {
        const existing: EnvVarRow[] = Array.from({ length: MAX_ENV_VARS_PER_SCOPE }, (_, i) => ({
            name: `V${i}`,
            value: 'x',
            isSecret: false,
        }));
        expect(parseEnvPaste('V0=updated\nNEW=2', existing)).toEqual({
            ok: false,
            errors: [`line 2: paste would exceed the limit of ${MAX_ENV_VARS_PER_SCOPE} variables per scope`],
        });
    });

    it('allows re-pasting existing variable names at the cap — a merge adds no row', () => {
        const existing: EnvVarRow[] = Array.from({ length: MAX_ENV_VARS_PER_SCOPE }, (_, i) => ({
            name: `V${i}`,
            value: 'x',
            isSecret: false,
        }));
        expect(parseEnvPaste('V0=updated', existing)).toEqual(
            ok(existing.map((row) => (row.name === 'V0' ? { ...row, value: 'updated' } : row)))
        );
    });

    it('refuses the whole paste when any line is bad — nothing is applied', () => {
        const result = parseEnvPaste('A=1\nBAD NAME=x', noExisting);
        expect(result.ok).toBe(false);
    });

    it('reports every bad line, not just the first', () => {
        const result = parseEnvPaste('1BAD=x\nA=1\nWORKDIR=/tmp', noExisting);
        expect(result).toEqual({
            ok: false,
            errors: [
                'line 1: "1BAD" is not a legal environment variable name',
                'line 3: "WORKDIR" is reserved by the runner',
            ],
        });
    });
});
