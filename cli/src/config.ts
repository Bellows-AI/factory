/**
 * The CLI's configuration, read from the environment only.
 *
 * No shared config with the server, and no config file: the issue names exactly two variables —
 * `FACTORY_URL` for the board's base URL and `FACTORY_TOKEN` for a personal access token minted
 * from the settings page (docs/auth.md). Against an `AUTH_MODE=none` board the token is simply
 * unset, and every route answers without one. Two optional tuning variables bound the transport:
 * `FACTORY_REQUEST_TIMEOUT_S` and `FACTORY_READ_RETRIES`.
 *
 * Unlike the driver, there is no default board URL: a CLI types at a specific deployment, and
 * guessing `127.0.0.1:8080` would queue real tasks against whichever board happens to be running
 * there. Missing `FACTORY_URL` is a named refusal, not a fallback.
 */

import { DEFAULT_READ_RETRIES, DEFAULT_REQUEST_TIMEOUT_MS } from './transport.js';

/** A configuration problem — the variable is missing, blank, or not a usable URL. */
export class CliConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliConfigError';
    }
}

export interface CliConfig {
    /** The board's base URL, trailing slashes stripped — request paths are appended to it. */
    url: string;
    /** A personal access token (`fat_…`), or '' against an open board. */
    token: string;
    /** One request attempt's deadline, headers and body included (`FACTORY_REQUEST_TIMEOUT_S`). */
    requestTimeoutMs: number;
    /** Re-issues of a failed read after the first attempt (`FACTORY_READ_RETRIES`); 0 turns them off. */
    readRetries: number;
}

const MAX_READ_RETRIES = 10;
const MAX_REQUEST_TIMEOUT_S = 3600;
const MS_PER_SECOND = 1000;

/** A blank variable is unset; anything else must be an integer within bounds, or it is named. */
function intVar(
    env: NodeJS.ProcessEnv,
    name: string,
    { fallback, min, max }: { fallback: number; min: number; max: number }
): number {
    const raw = (env[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new CliConfigError(`${name} must be an integer ${min}..${max}, got "${raw}"`);
    }
    return value;
}

// The protocol is checked, not just the parse: `new URL('dashboard:8080')` succeeds with
// 'dashboard:' as the scheme, and the first symptom would be every request failing against a
// value that reads perfectly well.
function assertHttpUrl(url: string): void {
    const scheme = (() => {
        try {
            return new URL(url).protocol;
        } catch {
            return null;
        }
    })();
    if (scheme !== 'http:' && scheme !== 'https:') {
        throw new CliConfigError(`FACTORY_URL must be an http(s) URL, got "${url}"`);
    }
}

export function loadCliConfig(env: NodeJS.ProcessEnv): CliConfig {
    const url = (env.FACTORY_URL ?? '').trim();
    if (!url) {
        throw new CliConfigError('FACTORY_URL must be set to the board URL, e.g. http://127.0.0.1:8080');
    }
    // Trailing slashes are stripped, because request paths are concatenated onto this string and
    // `…:8080//api/jobs` must not happen.
    const stripped = url.replace(/\/+$/, '');
    assertHttpUrl(stripped);
    return {
        url: stripped,
        // Empty is unset: the auth header is omitted rather than sent empty against an open board.
        token: (env.FACTORY_TOKEN ?? '').trim(),
        requestTimeoutMs:
            intVar(env, 'FACTORY_REQUEST_TIMEOUT_S', {
                fallback: DEFAULT_REQUEST_TIMEOUT_MS / MS_PER_SECOND,
                min: 1,
                max: MAX_REQUEST_TIMEOUT_S,
            }) * MS_PER_SECOND,
        readRetries: intVar(env, 'FACTORY_READ_RETRIES', {
            fallback: DEFAULT_READ_RETRIES,
            min: 0,
            max: MAX_READ_RETRIES,
        }),
    };
}
