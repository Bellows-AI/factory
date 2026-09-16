import { describe, expect, it } from 'vitest';
import {
    MAX_ENV_VARS_PER_SCOPE,
    NAME_LIMIT,
    RESERVED_ENV_NAMES,
    VALUE_LIMIT,
    parseEnvRaw,
    serializeEnv,
    type EnvVarRow,
} from '../src/panels/env-raw.js';

const noSecrets: string[] = [];

const ok = (vars: EnvVarRow[]) => ({ ok: true as const, vars });

const variable = (name: string, value: string): EnvVarRow => ({ name, value, isSecret: false });

describe('the raw .env editor parser', () => {
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
        expect(parseEnvRaw('LOG_LEVEL=debug\nPORT=8080', noSecrets)).toEqual(
            ok([variable('LOG_LEVEL', 'debug'), variable('PORT', '8080')])
        );
    });

    it('strips an export prefix', () => {
        expect(parseEnvRaw('export KEY=value', noSecrets)).toEqual(ok([variable('KEY', 'value')]));
    });

    it('skips blank lines and # comment lines', () => {
        const text = '\n# a comment\nKEY=value\n   \n   # indented comment\n';
        expect(parseEnvRaw(text, noSecrets)).toEqual(ok([variable('KEY', 'value')]));
    });

    it('strips one pair of surrounding double or single quotes', () => {
        const result = parseEnvRaw('A="quoted"\nB=\'single\'\nC="a"b"', noSecrets);
        expect(result).toEqual(ok([variable('A', 'quoted'), variable('B', 'single'), variable('C', 'a"b')]));
    });

    it('does no escape processing: backslash-n stays literal and inline # is value text', () => {
        const result = parseEnvRaw('A=line1\\nline2\nB=#notcomment\nC=a#b', noSecrets);
        expect(result).toEqual(
            ok([variable('A', 'line1\\nline2'), variable('B', '#notcomment'), variable('C', 'a#b')])
        );
    });

    it('accepts an empty value and trims around the = sign', () => {
        const result = parseEnvRaw('EMPTY=\nSPACED =  spaced value  ', noSecrets);
        expect(result).toEqual(ok([variable('EMPTY', ''), variable('SPACED', 'spaced value')]));
    });

    it('keeps spacing inside quotes after stripping the pair', () => {
        expect(parseEnvRaw('A=" v "', noSecrets)).toEqual(ok([variable('A', ' v ')]));
    });

    it('normalizes CR-LF line endings', () => {
        expect(parseEnvRaw('A=1\r\nB=2\rC=3', noSecrets)).toEqual(
            ok([variable('A', '1'), variable('B', '2'), variable('C', '3')])
        );
    });

    it('replaces the draft: the parsed set is the whole new variable list, deletions included', () => {
        // Rows that exist in the draft but not in the text are gone — the text is the truth.
        expect(parseEnvRaw('A=2\nNEW=3', noSecrets)).toEqual(ok([variable('A', '2'), variable('NEW', '3')]));
    });

    it('parses empty text to no variables — the delete-everything edit', () => {
        expect(parseEnvRaw('', noSecrets)).toEqual(ok([]));
    });

    it('refuses a line with no = sign, with its line number', () => {
        const result = parseEnvRaw('A=1\nnot-a-pair\nB=2', noSecrets);
        expect(result).toEqual({ ok: false, errors: ['line 2: expected KEY=value'] });
    });

    it('refuses an empty name, with its line number', () => {
        expect(parseEnvRaw('=x', noSecrets)).toEqual({ ok: false, errors: ['line 1: expected KEY=value'] });
    });

    it('refuses illegal names, with the line number', () => {
        const result = parseEnvRaw('1BAD=x\nA-B=y', noSecrets);
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
        const result = parseEnvRaw(`${name}=x`, noSecrets);
        expect(result).toEqual({ ok: false, errors: [`line 1: name exceeds ${NAME_LIMIT} characters`] });
    });

    it('refuses reserved names, with the line number', () => {
        expect(parseEnvRaw('WORKDIR=/tmp', noSecrets)).toEqual({
            ok: false,
            errors: ['line 1: "WORKDIR" is reserved by the runner'],
        });
    });

    it('refuses a value over the size limit, with the line number', () => {
        const result = parseEnvRaw(`A=${'x'.repeat(VALUE_LIMIT + 1)}`, noSecrets);
        expect(result).toEqual({ ok: false, errors: [`line 1: value for "A" exceeds ${VALUE_LIMIT} characters`] });
    });

    it('refuses a quoted value that runs over the next line, because parsing is line-structured', () => {
        // The real shape of "a value containing a newline": the continuation arrives as its own
        // line, and a line with no = is refused — docker --env-file would have truncated it.
        const result = parseEnvRaw('A="starts\nstill starting"', noSecrets);
        expect(result).toEqual({ ok: false, errors: ['line 2: expected KEY=value'] });
    });

    it('refuses duplicate names within the text, with both line numbers', () => {
        const result = parseEnvRaw('A=1\nB=2\nA=3', noSecrets);
        expect(result).toEqual({ ok: false, errors: ['line 3: duplicate name "A" (first seen on line 1)'] });
    });

    it('refuses a name that collides with a secret in the scope', () => {
        expect(parseEnvRaw('A=1\nS=new', ['S'])).toEqual({
            ok: false,
            errors: ['line 2: "S" is already a secret in this scope — edit it on the Secrets tab'],
        });
    });

    it('counts secrets toward the scope cap, refusing at the tipping line', () => {
        const secretNames = Array.from({ length: 50 }, (_, i) => `S${i}`);
        const lines = Array.from({ length: 51 }, (_, i) => `V${i}=x`).join('\n');
        const result = parseEnvRaw(lines, secretNames);
        expect(result).toEqual({
            ok: false,
            errors: [`line 51: raw text would exceed the limit of ${MAX_ENV_VARS_PER_SCOPE} variables per scope`],
        });
    });

    it('accepts exactly-at-cap text', () => {
        const lines = Array.from({ length: MAX_ENV_VARS_PER_SCOPE }, (_, i) => `V${i}=x`).join('\n');
        const result = parseEnvRaw(lines, noSecrets);
        expect(result.ok).toBe(true);
    });

    it('refuses the whole text when any line is bad — nothing is applied', () => {
        const result = parseEnvRaw('A=1\nBAD NAME=x', noSecrets);
        expect(result.ok).toBe(false);
    });

    it('reports every bad line, not just the first', () => {
        const result = parseEnvRaw('1BAD=x\nA=1\nWORKDIR=/tmp', noSecrets);
        expect(result).toEqual({
            ok: false,
            errors: [
                'line 1: "1BAD" is not a legal environment variable name',
                'line 3: "WORKDIR" is reserved by the runner',
            ],
        });
    });
});

describe('serializeEnv', () => {
    it('writes one NAME=value line per non-secret row and never serializes secrets', () => {
        const rows: EnvVarRow[] = [
            { name: 'A', value: '1', isSecret: false },
            { name: 'S', value: null, isSecret: true },
            { name: 'B', value: '', isSecret: false },
        ];
        expect(serializeEnv(rows)).toBe('A=1\nB=');
    });

    it('round-trips plain, empty and inner-quote values unwrapped', () => {
        const rows: EnvVarRow[] = [variable('A', 'plain'), variable('B', ''), variable('C', 'a"b'), variable('D', 'q')];
        const result = parseEnvRaw(serializeEnv(rows), []);
        expect(result).toEqual(ok(rows));
    });

    it('quotes values with leading or trailing whitespace so the parse round-trips', () => {
        const rows: EnvVarRow[] = [variable('A', ' padded '), variable('B', '\tlead'), variable('C', '  ')];
        expect(serializeEnv(rows)).toBe('A=" padded "\nB="\tlead"\nC="  "');
        const result = parseEnvRaw(serializeEnv(rows), []);
        expect(result).toEqual(ok(rows));
    });

    it('quotes values that are themselves one pair of quotes, so the strip does not eat them', () => {
        const rows: EnvVarRow[] = [variable('A', '"dq"'), variable('B', "'sq'")];
        const text = serializeEnv(rows);
        const result = parseEnvRaw(text, []);
        expect(result).toEqual(ok(rows));
    });
});
