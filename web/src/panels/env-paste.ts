/**
 * The client-side `.env` paste parser for the environment scopes — pure, no React, no imports.
 *
 * Parsing is deliberately strict and client-side only: the parsed rows land in the panel's draft
 * table and are saved through the existing whole-list PUT, whose server-side `parseVars`
 * (server/src/routes/env.ts) stays the sole authority. This module mirrors that authority's rules
 * for early feedback — the constants are copied, not imported, per the driver's precedent for
 * cross-package constants — and refuses the WHOLE paste unless every line parses, because
 * half-applied bulk entry is how a typo becomes a silently wrong runner environment.
 *
 * Accepted syntax: `KEY=value`, `export KEY=value`; blank and `#` comment lines skipped; one pair
 * of surrounding quotes stripped; no escape processing — the value is the literal text after `=`
 * (quotes aside), so `\n` stays a literal backslash-n and an inline `#` is value text.
 */

/** Mirrors MAX_ENV_VARS_PER_SCOPE in server/src/routes/env.ts. */
export const MAX_ENV_VARS_PER_SCOPE = 100;

/** Mirrors RESERVED_ENV_NAMES in server/src/routes/env.ts. */
export const RESERVED_ENV_NAMES: readonly string[] = [
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
];

/** Mirrors VALUE_LIMIT in server/src/routes/env.ts. */
export const VALUE_LIMIT = 32 * 1024;

/** Mirrors NAME_LIMIT in server/src/routes/env.ts. */
export const NAME_LIMIT = 255;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The structural subset of the panel's EnvVarDraft the parser works on. */
export interface EnvVarRow {
    name: string;
    value: string | null;
    isSecret: boolean;
}

export type EnvPasteResult = { ok: true; vars: EnvVarRow[] } | { ok: false; errors: string[] };

/**
 * Parse a pasted `.env` text against the scope's current draft rows.
 *
 * `existing` drives the three scope-aware behaviors: a pasted name that already exists as a
 * secret refuses the paste (never silently overwrite a credential), a pasted name that already
 * exists as a variable replaces that row's value in place (merge-and-overwrite), and the cap
 * counts every existing row plus each genuinely new pasted name. On success `vars` is the
 * COMPLETE new draft — existing secrets and unmentioned variables preserved in order, new names
 * appended in paste order — so applying a paste is one state replacement. On failure `errors`
 * carries one `line N: …` message per offending line and nothing is applied.
 */
export function parseEnvPaste(text: string, existing: readonly EnvVarRow[]): EnvPasteResult {
    const secrets = new Set(existing.filter((row) => row.isSecret).map((row) => row.name));
    const variables = new Set(existing.filter((row) => !row.isSecret).map((row) => row.name));

    const errors: string[] = [];
    const pairs: { name: string; value: string }[] = [];
    const firstSeen = new Map<string, number>();
    let newCount = 0;

    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    for (const [index, rawLine] of lines.entries()) {
        const lineNo = index + 1;
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        const withoutExport = line.replace(/^export\s+/, '').trim();
        const eq = withoutExport.indexOf('=');
        if (eq === -1) {
            errors.push(`line ${lineNo}: expected KEY=value`);
            continue;
        }
        const name = withoutExport.slice(0, eq).trim();
        let value = withoutExport.slice(eq + 1).trim();
        if (name === '') {
            errors.push(`line ${lineNo}: expected KEY=value`);
            continue;
        }
        if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[0] === value[value.length - 1]) {
            value = value.slice(1, -1);
        }
        if (!ENV_NAME.test(name)) {
            errors.push(`line ${lineNo}: "${name}" is not a legal environment variable name`);
            continue;
        }
        if (name.length > NAME_LIMIT) {
            errors.push(`line ${lineNo}: name exceeds ${NAME_LIMIT} characters`);
            continue;
        }
        if (RESERVED_ENV_NAMES.includes(name)) {
            errors.push(`line ${lineNo}: "${name}" is reserved by the runner`);
            continue;
        }
        if (value.includes('\n')) {
            // Structurally unreachable after line-splitting; kept as parity with the server's
            // newline refusal (BAD_ENV_VALUE) in case this parser is ever fed differently.
            errors.push(`line ${lineNo}: value for "${name}" contains a newline`);
            continue;
        }
        if (value.length > VALUE_LIMIT) {
            errors.push(`line ${lineNo}: value for "${name}" exceeds ${VALUE_LIMIT} characters`);
            continue;
        }
        const seenAt = firstSeen.get(name);
        if (seenAt !== undefined) {
            errors.push(`line ${lineNo}: duplicate name "${name}" (first seen on line ${seenAt})`);
            continue;
        }
        firstSeen.set(name, lineNo);
        if (secrets.has(name)) {
            errors.push(`line ${lineNo}: "${name}" is already a secret in this scope — edit it on the Secrets tab`);
            continue;
        }
        if (!variables.has(name)) {
            newCount += 1;
            if (existing.length + newCount > MAX_ENV_VARS_PER_SCOPE) {
                errors.push(
                    `line ${lineNo}: paste would exceed the limit of ${MAX_ENV_VARS_PER_SCOPE} variables per scope`
                );
                continue;
            }
        }
        pairs.push({ name, value });
    }

    if (errors.length > 0) return { ok: false, errors };

    const pasted = new Map(pairs.map((pair) => [pair.name, pair.value]));
    const vars: EnvVarRow[] = [
        ...existing.map((row) =>
            !row.isSecret && pasted.has(row.name) ? { ...row, value: pasted.get(row.name)! } : row
        ),
        ...pairs
            .filter((pair) => !variables.has(pair.name))
            .map((pair) => ({ name: pair.name, value: pair.value, isSecret: false })),
    ];
    return { ok: true, vars };
}
