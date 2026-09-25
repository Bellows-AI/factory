import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import { createAppSlugProvider, installationTokenProvider } from '../src/github/app-token.js';

/*
 * The key is generated HERE, per run, and never committed. A fixture private key in a repository is
 * indistinguishable from a leaked one to anybody scanning, and this suite needs a real RSA key
 * because the whole point of the case below is that the JWT verifies against its public half.
 *
 * 2048 bits rather than 4096: GitHub accepts it, and generating one is fast enough to sit in an
 * offline unit suite.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const API = 'https://api.github.test';
const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;
const MS_PER_SECOND = 1000;

function appConfig(overrides: Partial<Extract<GitHubConfig, { mode: 'app' }>> = {}) {
    return {
        mode: 'app' as const,
        appId: 'Iv23liEXAMPLE',
        privateKeyPem: PEM,
        apiUrl: API,
        ...overrides,
    };
}

/** The provider under test: every mint names an explicit installation since #99. */
const provider = (overrides: {
    installationId?: string;
    fetchFn: typeof fetch;
    now?: () => number;
    mintTimeoutMs?: number;
}) =>
    installationTokenProvider({
        github: appConfig(),
        installationId: overrides.installationId ?? '4242',
        fetchFn: overrides.fetchFn,
        ...(overrides.now ? { now: overrides.now } : {}),
        ...(overrides.mintTimeoutMs ? { mintTimeoutMs: overrides.mintTimeoutMs } : {}),
    });

interface Call {
    url: string;
    method: string;
    authorization: string;
}

/** Records every request and answers the token endpoint. No network, no timers. */
function stubFetch(
    options: { expiresAt?: () => string; token?: () => string; installations?: unknown; app?: unknown } = {}
) {
    const calls: Call[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({
            url,
            method: init?.method ?? 'GET',
            authorization: String((init?.headers as Record<string, string>)?.authorization ?? ''),
        });
        if (url.includes('/access_tokens')) {
            return new Response(
                JSON.stringify({
                    token: options.token?.() ?? 'ghs_installation_token',
                    expires_at: options.expiresAt?.() ?? new Date(Date.now() + HOUR_MS).toISOString(),
                }),
                { status: 201 }
            );
        }
        if (url.includes('/app/installations')) {
            return new Response(JSON.stringify(options.installations ?? [{ id: 99, account: { login: 'acme' } }]), {
                status: 200,
            });
        }
        if (url.endsWith('/app')) {
            return new Response(JSON.stringify(options.app ?? { slug: 'stub-app' }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    return { calls, fetchFn };
}

/** Splits the JWT the provider signed off the Authorization header of the mint request. */
function jwtFrom(calls: Call[]): { header: Record<string, unknown>; payload: Record<string, unknown>; raw: string } {
    const mint = calls.find((call) => call.url.includes('/access_tokens'));
    if (!mint) throw new Error('nothing minted a token');
    const raw = mint.authorization.replace(/^Bearer /, '');
    const [header, payload] = raw.split('.');
    return {
        header: JSON.parse(Buffer.from(header as string, 'base64url').toString()),
        payload: JSON.parse(Buffer.from(payload as string, 'base64url').toString()),
        raw,
    };
}

describe('the App JWT', () => {
    it('is RS256 and verifies against the public half of the key', async () => {
        const { calls, fetchFn } = stubFetch();
        await provider({ fetchFn }).get();

        const { header, raw } = jwtFrom(calls);
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

        const [h, p, signature] = raw.split('.');
        const verified = createVerify('RSA-SHA256')
            .update(`${h}.${p}`)
            .end()
            .verify(
                createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }) as string),
                Buffer.from(signature as string, 'base64url')
            );
        expect(verified).toBe(true);
    });

    it('backdates iat, because GitHub rejects one in its own future', async () => {
        // The two clocks are not the same clock, and a machine running a few seconds fast would
        // otherwise fail every mint with a 401 that reads exactly like a bad key.
        const now = Date.parse('2026-08-21T12:00:00.000Z');
        const { calls, fetchFn } = stubFetch();
        await provider({ fetchFn, now: () => now }).get();

        const IAT_BACKDATE_SECONDS = 60;
        const JWT_LIFETIME_SECONDS = 540;
        const { payload } = jwtFrom(calls);
        expect(payload.iat).toBe(Math.floor(now / MS_PER_SECOND) - IAT_BACKDATE_SECONDS);
        // Under GitHub's 10 minute ceiling, with room for a slow clock at the other end too.
        expect((payload.exp as number) - (payload.iat as number)).toBe(JWT_LIFETIME_SECONDS);
    });

    it('sends the app id as a string, so a client id of the Iv23li… form still works', async () => {
        const { calls, fetchFn } = stubFetch();
        await provider({ fetchFn }).get();
        expect(jwtFrom(calls).payload.iss).toBe('Iv23liEXAMPLE');
    });

    it('refuses a key that is not a usable private key, at construction', async () => {
        // Boot-fatal, where loadConfig's shape check left off: a well-formed PEM header around
        // nothing would otherwise fail at the first fetch, minutes later.
        expect(() =>
            installationTokenProvider({
                github: appConfig({
                    privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----',
                }),
                installationId: '4242',
                fetchFn: stubFetch().fetchFn,
            })
        ).toThrow(/not a usable private key/);
    });
});

describe('the installation token', () => {
    it('is cached until the refresh margin, then re-minted', async () => {
        let now = Date.parse('2026-08-21T12:00:00.000Z');
        const { calls, fetchFn } = stubFetch({ expiresAt: () => new Date(now + HOUR_MS).toISOString() });
        const tokens = provider({ fetchFn, now: () => now });

        await tokens.get();
        const mints = () => calls.filter((call) => call.url.includes('/access_tokens')).length;
        const SINGLE_MINT = 1;
        expect(mints()).toBe(SINGLE_MINT);

        // Inside the hour but outside the five-minute margin: still the cached token.
        const WITHIN_MARGIN_MINUTES = 50;
        now += WITHIN_MARGIN_MINUTES * MINUTE_MS;
        await tokens.get();
        expect(mints()).toBe(SINGLE_MINT);

        // Inside the margin. A full repo walk is minutes of paging, so a token that expires
        // mid-walk fails halfway with a 401 that reads as a rejected credential.
        const INSIDE_MARGIN_MINUTES = 7;
        const DOUBLE_MINT = 2;
        now += INSIDE_MARGIN_MINUTES * MINUTE_MS;
        await tokens.get();
        expect(mints()).toBe(DOUBLE_MINT);
    });

    it('mints once when two callers race a cold cache', async () => {
        // GitHub does not invalidate the loser, so a double mint leaves a live token nothing holds.
        const { calls, fetchFn } = stubFetch();
        const tokens = provider({ fetchFn });

        const [a, b] = await Promise.all([tokens.get(), tokens.get()]);
        expect(a).toBe(b);
        expect(calls.filter((call) => call.url.includes('/access_tokens'))).toHaveLength(1);
    });

    it('abandons a mint that hangs rather than holding the caller forever', async () => {
        /*
         * The claim runs this request inside its transaction, holding a job-row lock and one of the
         * pool's connections across it, so a GitHub that never answers would stall every other
         * claim, heartbeat and completion behind it. The mint has to abort, and the claim's
         * 503/retry path takes over from there. This stub only settles when its signal does.
         */
        const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason));
            })) as typeof fetch;
        const tokens = installationTokenProvider({ github: appConfig(), fetchFn, mintTimeoutMs: 10 });

        await expect(tokens.fresh()).rejects.toMatchObject({ name: 'TimeoutError' });
    });

    it('mints once when two callers race a fresh mint', async () => {
        /*
         * Overlapping claims each ask for fresh, and the loser of a double mint is not invalidated —
         * it stays live for an hour counting against the App. The fresh path must join the same
         * single-flight as get, sharing one request, each caller still getting a full-hour token.
         */
        let serial = 0;
        const { calls, fetchFn } = stubFetch({ token: () => `ghs_${++serial}` });
        const tokens = provider({ fetchFn });

        const [a, b] = await Promise.all([tokens.fresh(), tokens.fresh()]);
        expect(a).toBe(b);
        expect(calls.filter((call) => call.url.includes('/access_tokens'))).toHaveLength(1);
    });

    it("trusts GitHub's expires_at rather than assuming an hour", async () => {
        let now = Date.parse('2026-08-21T12:00:00.000Z');
        // A ten-minute token: entirely inside what an assumed hour would consider fresh.
        const TOKEN_LIFETIME_MINUTES = 10;
        const { calls, fetchFn } = stubFetch({
            expiresAt: () => new Date(now + TOKEN_LIFETIME_MINUTES * MINUTE_MS).toISOString(),
        });
        const tokens = provider({ fetchFn, now: () => now });

        const SECOND_MINT_ADVANCE_MINUTES = 6;
        const EXPECTED_MINTS = 2;
        await tokens.get();
        now += SECOND_MINT_ADVANCE_MINUTES * MINUTE_MS;
        await tokens.get();
        expect(calls.filter((call) => call.url.includes('/access_tokens'))).toHaveLength(EXPECTED_MINTS);
    });

    it('mints fresh on demand, never serving the cache', async () => {
        /*
         * A claim hands the token to a runner whose job outlives the claim, so that credential has
         * to start from full life: served from the cache it can carry the five-minute refresh
         * margin into a run capped at thirty minutes, and the runner has no refresh path.
         */
        let now = Date.parse('2026-08-21T12:00:00.000Z');
        let serial = 0;
        const { calls, fetchFn } = stubFetch({
            token: () => `ghs_${++serial}`,
            expiresAt: () => new Date(now + HOUR_MS).toISOString(),
        });
        const tokens = provider({ fetchFn, now: () => now });
        const mints = () => calls.filter((call) => call.url.includes('/access_tokens')).length;

        const SINGLE_MINT = 1;
        const DOUBLE_MINT = 2;
        const cached = await tokens.get();
        expect(cached).toBe('ghs_1');
        expect(mints()).toBe(SINGLE_MINT);

        // Minutes into the cached token's hour, a claim still mints, and gets a different token.
        const WITHIN_HOUR_ADVANCE_MINUTES = 50;
        now += WITHIN_HOUR_ADVANCE_MINUTES * MINUTE_MS;
        const fresh = await tokens.fresh();
        expect(fresh).toBe('ghs_2');
        expect(mints()).toBe(DOUBLE_MINT);

        // The fresh mint is also what the cache now holds, so ordinary reads ride it.
        await expect(tokens.get()).resolves.toBe('ghs_2');
        expect(mints()).toBe(DOUBLE_MINT);
    });
});

describe('an explicit installation id (#99)', () => {
    it('mints against it and never discovers', async () => {
        /*
         * The per-org mint path: the org registry passes each organization's installation_id, so
         * the provider is told the installation rather than guessing one. Discovery would be
         * fatal here by design — an App with several installations cannot answer "which one".
         */
        const { calls, fetchFn } = stubFetch({ installations: [] });
        const tokens = provider({ installationId: '777', fetchFn });

        await tokens.get();
        expect(calls.some((call) => call.url.includes('/app/installations?'))).toBe(false);
        expect(calls.find((call) => call.url.includes('/access_tokens'))?.url).toBe(
            `${API}/app/installations/777/access_tokens`
        );
    });

    it('answers installationId() without a mint when it was given one', async () => {
        const { calls, fetchFn } = stubFetch();
        const tokens = provider({ installationId: '777', fetchFn });

        await expect(tokens.installationId()).resolves.toBe('777');
        expect(calls).toHaveLength(0);
    });
});

describe('the app slug', () => {
    it('asks GET /app with a JWT and caches the answer', async () => {
        const { calls, fetchFn } = stubFetch({ app: { slug: 'acme-factory' } });
        const slug = createAppSlugProvider({ github: appConfig(), fetchFn });

        await expect(slug.slug()).resolves.toBe('acme-factory');
        await expect(slug.slug()).resolves.toBe('acme-factory');
        expect(calls.filter((call) => call.url.endsWith('/app'))).toHaveLength(1);
        // The App JWT, not an installation token: GET /app has no installation to act on.
        const [header, payload] = calls
            .find((call) => call.url.endsWith('/app'))!
            .authorization.replace(/^Bearer /, '')
            .split('.');
        expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
        expect(JSON.parse(Buffer.from(payload, 'base64url').toString()).iss).toBe('Iv23liEXAMPLE');
    });

    it('does not cache a failure', async () => {
        // Called from the sign-in path (0 installations → install page); a transient miss must
        // not be remembered, or every sign-in for the next process lifetime would fail.
        const { fetchFn } = stubFetch({ app: { slug: 'acme-factory' } });
        let appCalls = 0;
        const failing = (async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith('/app') && appCalls++ === 0) return new Response('nope', { status: 502 });
            return fetchFn(input, init);
        }) as typeof fetch;
        const slug = createAppSlugProvider({ github: appConfig(), fetchFn: failing });

        await expect(slug.slug()).rejects.toThrow(/failed with 502/);
        // The retry succeeds — and the retry having been MADE at all is the no-caching proof.
        await expect(slug.slug()).resolves.toBe('acme-factory');
    });

    it('refuses an answer that carries no slug', async () => {
        const { fetchFn } = stubFetch({ app: {} });
        await expect(createAppSlugProvider({ github: appConfig(), fetchFn }).slug()).rejects.toThrow(/carried no slug/);
    });
});
