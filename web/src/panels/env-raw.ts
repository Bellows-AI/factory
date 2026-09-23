/**
 * The client-side parser and serializer for the environment scopes' raw editor — pure, no React.
 *
 * Parsing is deliberately strict and client-side only: the parsed rows replace the panel's draft
 * variable table and are saved through the existing whole-list PUT, whose server-side `parseVars`
 * (server/src/routes/env.ts) stays the sole authority. This module applies that authority's rules
 * (core/src/env.ts, shared with the server) for early feedback, and refuses the WHOLE text unless
 * every line parses, because half-applied bulk edits are how a typo becomes a silently wrong
 * runner environment.
 *
 * Accepted syntax: `KEY=value`, `export KEY=value`; blank and `#` comment lines skipped; one pair
 * of surrounding quotes stripped; no escape processing — the value is the literal text after `=`
 * (quotes aside), so `\n` stays a literal backslash-n and an inline `#` is value text.
 *
 * Unlike a paste-merge, the text is the WHOLE truth: every parsed name becomes a row and every
 * variable absent from the text is deleted — which is why only the scope's secret names are
 * consulted here (they cannot round-trip through text, so they pass around the editor, and a text
 * name matching one is refused).
 */

import {
    ENV_NAME,
    ENV_NAME_LIMIT,
    ENV_VALUE_LIMIT,
    MAX_ENV_VARS_PER_SCOPE,
    RESERVED_ENV_NAMES,
} from '@factory-ai/core';

/** The structural subset of the panel's EnvVarDraft the editor works on. */
export interface EnvVarRow {
    name: string;
    value: string | null;
    isSecret: boolean;
}

export type EnvRawResult = { ok: true; vars: EnvVarRow[] } | { ok: false; errors: string[] };

/** Whether the value is itself one matched pair of quotes, which the parser would strip. */
function isQuotePair(value: string): boolean {
    return value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[0] === value[value.length - 1];
}

/** One line's parse: `null` for a skipped blank/comment line, otherwise the pair or the error. */
type LineParseResult = { ok: true; name: string; value: string } | { ok: false; error: string };

/**
 * One line of the raw editor's text, checked in the server's own order: shape, name, value,
 * duplicate, secret collision, scope cap. Split out of `parseEnvRaw` so its own line count and
 * complexity stay under the limit — every check here is a flat early return, never nested.
 */
function parseEnvLine(
    rawLine: string,
    lineNo: number,
    context: { secrets: ReadonlySet<string>; firstSeen: ReadonlyMap<string, number>; activeCount: number }
): LineParseResult | null {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) return null;
    const withoutExport = line.replace(/^export\s+/, '').trim();
    const eq = withoutExport.indexOf('=');
    if (eq === -1) return { ok: false, error: `line ${lineNo}: expected KEY=value` };
    const name = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (name === '') return { ok: false, error: `line ${lineNo}: expected KEY=value` };
    if (isQuotePair(value)) value = value.slice(1, -1);
    if (!ENV_NAME.test(name)) {
        return { ok: false, error: `line ${lineNo}: "${name}" is not a legal environment variable name` };
    }
    if (name.length > ENV_NAME_LIMIT)
        return { ok: false, error: `line ${lineNo}: name exceeds ${ENV_NAME_LIMIT} characters` };
    if (RESERVED_ENV_NAMES.includes(name)) {
        return { ok: false, error: `line ${lineNo}: "${name}" is reserved by the runner` };
    }
    if (value.includes('\n')) {
        // Structurally unreachable after line-splitting; kept as parity with the server's
        // newline refusal (BAD_ENV_VALUE) in case this parser is ever fed differently.
        return { ok: false, error: `line ${lineNo}: value for "${name}" contains a newline` };
    }
    if (value.length > ENV_VALUE_LIMIT) {
        return { ok: false, error: `line ${lineNo}: value for "${name}" exceeds ${ENV_VALUE_LIMIT} characters` };
    }
    const seenAt = context.firstSeen.get(name);
    if (seenAt !== undefined) {
        return { ok: false, error: `line ${lineNo}: duplicate name "${name}" (first seen on line ${seenAt})` };
    }
    if (context.secrets.has(name)) {
        return {
            ok: false,
            error: `line ${lineNo}: "${name}" is already a secret in this scope — edit it on the Secrets tab`,
        };
    }
    if (context.secrets.size + context.activeCount >= MAX_ENV_VARS_PER_SCOPE) {
        return {
            ok: false,
            error: `line ${lineNo}: raw text would exceed the limit of ${MAX_ENV_VARS_PER_SCOPE} variables per scope`,
        };
    }
    return { ok: true, name, value };
}

/**
 * Parse the raw editor's text against the scope's secret names.
 *
 * On success `vars` is the COMPLETE new variable set — exactly the parsed pairs in text order, so
 * applying it is one state replacement of the draft's non-secret rows. On failure `errors` carries
 * one `line N: …` message per offending line and nothing is applied. The cap counts the scope's
 * secrets plus every parsed name.
 */
export function parseEnvRaw(text: string, secretNames: readonly string[]): EnvRawResult {
    const secrets = new Set(secretNames);

    const errors: string[] = [];
    const pairs: { name: string; value: string }[] = [];
    const firstSeen = new Map<string, number>();

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (const [index, rawLine] of lines.entries()) {
        const lineNo = index + 1;
        const result = parseEnvLine(rawLine, lineNo, { secrets, firstSeen, activeCount: pairs.length });
        if (result === null) continue;
        if (!result.ok) {
            errors.push(result.error);
            continue;
        }
        firstSeen.set(result.name, lineNo);
        pairs.push({ name: result.name, value: result.value });
    }

    if (errors.length > 0) return { ok: false, errors };

    const vars: EnvVarRow[] = pairs.map((pair) => ({ name: pair.name, value: pair.value, isSecret: false }));
    return { ok: true, vars };
}

/**
 * Serialize the draft's non-secret rows into the raw editor's text — one `NAME=value` per line.
 * A value with leading or trailing whitespace, or one that is itself a matched pair of quotes
 * (which the parser would strip), is wrapped in double quotes so the parse round-trips.
 */
export function serializeEnv(rows: readonly EnvVarRow[]): string {
    return rows
        .filter((row) => !row.isSecret)
        .map((row) => {
            const value = row.value ?? '';
            const needsQuotes = value !== value.trim() || isQuotePair(value);
            return `${row.name}=${needsQuotes ? `"${value}"` : value}`;
        })
        .join('\n');
}
