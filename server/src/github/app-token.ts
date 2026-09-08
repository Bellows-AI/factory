import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import type { GitHubConfig } from '../config.js';
import type { TokenProvider } from './token.js';

/**
 * Mints installation access tokens for a GitHub App, which is what the repo-read path authenticates
 * with now that GITHUB_TOKEN is gone.
 *
 * Two credentials, one derived from the other. The App's private key signs a short-lived JWT that
 * proves "I am this App"; that JWT buys an *installation* token that says "I am this App, acting on
 * this installation", and only the second one can read a repository. The first never leaves this
 * file.
 *
 * Hand-rolled rather than @octokit/auth-app for the reason auth/github.ts gives for hand-rolling the
 * OAuth exchange: the signing and the refresh window are the parts worth being able to read here,
 * and a library would own them while bringing a dependency tree for the rest.
 */

/** GitHub's ceiling on a App JWT is 10 minutes. Nine leaves room for a slow clock. */
const JWT_TTL_SECONDS = 540;

/**
 * How early the JWT claims to have been issued.
 *
 * GitHub rejects an `iat` in its own future, and the two clocks are not the same clock. Backdating
 * by a minute is the documented remedy; without it a machine running a few seconds fast fails every
 * mint with a 401 that reads exactly like a bad key.
 */
const JWT_CLOCK_SKEW_SECONDS = 60;

/**
 * How long before expiry a cached installation token is replaced.
 *
 * Installation tokens last an hour, and a full repo walk is minutes of sequential paging. Refreshing
 * only on expiry means a walk that starts at minute 58 dies halfway through with a 401 — which
 * surfaces as a rejected credential rather than as an expired one, and sends the reader to the App's
 * settings page instead of to this constant.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * How long a mint request may run before it is abandoned.
 *
 * A claim runs these requests inside its transaction, so GitHub answering slowly holds that claim's
 * job-row lock and one of the pool's connections for the duration — and unrelated claims,
 * heartbeats and completions all stall behind a remote request. Both of them — the installation
 * lookup, when no id is configured, and the token POST — abort on this clock; the claim surfaces
 * the failure and its 503/retry path takes over.
 */
const MINT_TIMEOUT_MS = 5000;

const base64url = (value: string | Buffer): string =>
    Buffer.from(value).toString('base64url');

/**
 * An RS256 JWT, which is the only signature GitHub accepts for an App.
 *
 * `iss` is the App id as a string. GitHub now issues client ids of the form `Iv23li…` alongside the
 * numeric form and accepts either here, so this must not coerce to a number.
 */
function appJwt(appId: string, key: KeyObject, nowMs: number): string {
    const issued = Math.floor(nowMs / 1000) - JWT_CLOCK_SKEW_SECONDS;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
        JSON.stringify({ iat: issued, exp: issued + JWT_TTL_SECONDS, iss: appId }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).end().sign(key);
    return `${header}.${payload}.${base64url(signature)}`;
}

export interface AppTokenOptions {
    readonly github: Extract<GitHubConfig, { mode: 'app' }>;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => number;
    readonly mintTimeoutMs?: number;
}

export class GitHubAppError extends Error {}

async function json(response: Response, what: string): Promise<unknown> {
    if (!response.ok) {
        // The body carries GitHub's own reason ("integration not found", "expired") and is the
        // difference between a fixable error and a mystery. Bounded, because it is a remote body.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        throw new GitHubAppError(`${what} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.json();
}

/**
 * The installation the App is on, when the operator did not name one.
 *
 * Fatal on zero and on more than one, rather than picking. Zero means the App exists but nobody has
 * installed it, which is the single most likely first-run state and needs saying out loud. More than
 * one means the choice is real and guessing it would silently measure somebody else's organization.
 */
async function discoverInstallation(
    apiUrl: string,
    jwt: string,
    fetchFn: typeof fetch,
    timeoutMs: number,
): Promise<string> {
    const response = await fetchFn(`${apiUrl}/app/installations?per_page=100`, {
        headers: {
            authorization: `Bearer ${jwt}`,
            accept: 'application/vnd.github+json',
            // GitHub rejects an API request with no User-Agent outright.
            'user-agent': 'factory-ai',
        },
        // The same hold MINT_TIMEOUT_MS puts on the token POST below: with no configured id this
        // lookup is the first request a claim makes, and a hung one pins the transaction all the same.
        signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await json(response, 'installation lookup')) as {
        id?: number;
        account?: { login?: string };
    }[];

    if (!Array.isArray(body) || body.length === 0) {
        throw new GitHubAppError(
            'this GitHub App is not installed anywhere. Install it on the organization or account whose repositories you want measured, then restart.',
        );
    }
    if (body.length > 1) {
        const where = body.map((i) => i.account?.login ?? String(i.id)).join(', ');
        throw new GitHubAppError(
            `this GitHub App is installed on ${body.length} accounts (${where}). Set GITHUB_APP_INSTALLATION_ID to say which one this deployment reports on — guessing would silently measure the wrong organization.`,
        );
    }
    const [only] = body;
    if (typeof only?.id !== 'number') throw new GitHubAppError('installation lookup returned no id');
    return String(only.id);
}

export interface InstallationTokenProvider extends TokenProvider {
    /** The installation these tokens are for, discovered on first use if it was not configured. */
    installationId(): Promise<string>;
    /**
     * A token minted NOW, never served from the cache — for a credential that has to outlive the
     * instant it is handed out. The claim path uses this: a runner's env is written once and the
     * job outlives the claim, so a cached token's remaining five minutes would die mid-run. A
     * fresh mint joins any other mint in flight — concurrent claims share the one request and each
     * still gets a full-hour token — and the mint refreshes what `get` caches; GitHub does not
     * invalidate the tokens it replaced.
     */
    fresh(): Promise<string>;
}

export function installationTokenProvider(options: AppTokenOptions): InstallationTokenProvider {
    const { github, fetchFn = fetch, now = Date.now, mintTimeoutMs = MINT_TIMEOUT_MS } = options;

    // Parsed once, at construction. A well-shaped but invalid PEM then fails at boot, where
    // loadConfig's shape check left off, rather than at the first fetch minutes later.
    let key: KeyObject;
    try {
        key = createPrivateKey(github.privateKeyPem);
    } catch (error) {
        throw new GitHubAppError(
            `GITHUB_APP_PRIVATE_KEY is not a usable private key: ${(error as Error).message}`,
        );
    }

    let installation = github.installationId;
    let cached: { token: string; expiresAt: number } | null = null;
    // Single-flight. Two concurrent callers past a stale cache would otherwise mint two tokens and
    // race to store one; GitHub does not invalidate the loser, but it counts against the App and the
    // discarded token stays live for an hour.
    let pending: Promise<string> | null = null;

    const mint = async (): Promise<string> => {
        const jwt = appJwt(github.appId, key, now());
        installation ??= await discoverInstallation(github.apiUrl, jwt, fetchFn, mintTimeoutMs);

        const response = await fetchFn(`${github.apiUrl}/app/installations/${installation}/access_tokens`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${jwt}`,
                accept: 'application/vnd.github+json',
                'user-agent': 'factory-ai',
            },
            // The hold MINT_TIMEOUT_MS bounds: a hung GitHub aborts here instead of pinning the
            // caller's transaction open.
            signal: AbortSignal.timeout(mintTimeoutMs),
        });
        const body = (await json(response, 'installation token request')) as {
            token?: string;
            expires_at?: string;
        };
        if (!body.token) throw new GitHubAppError('installation token response carried no token');

        // GitHub's own expiry, not now()+1h. The document says an hour; trusting the field means a
        // change on their side shortens the window here rather than producing a token this process
        // believes in for longer than it is valid.
        const expiresAt = body.expires_at ? Date.parse(body.expires_at) : NaN;
        cached = {
            token: body.token,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : now() + 3600 * 1000,
        };
        return body.token;
    };

    return {
        async get() {
            if (cached && now() < cached.expiresAt - REFRESH_MARGIN_MS) return cached.token;
            pending ??= mint().finally(() => {
                pending = null;
            });
            return pending;
        },

        async fresh() {
            // `get` without the cache check: the same single-flight, since a mint bypassing it
            // would leave the loser live for an hour, counting against the App.
            pending ??= mint().finally(() => {
                pending = null;
            });
            return pending;
        },

        async installationId() {
            if (installation) return installation;
            await this.get();
            // `mint` sets it, and throws if it could not.
            return installation as unknown as string;
        },
    };
}
