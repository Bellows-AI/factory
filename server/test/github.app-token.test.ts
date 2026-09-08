import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import { installationTokenProvider } from '../src/github/app-token.js';

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

function appConfig(overrides: Partial<Extract<GitHubConfig, { mode: 'app' }>> = {}) {
    return {
        mode: 'app' as const,
        appId: 'Iv23liEXAMPLE',
        installationId: '4242',
        privateKeyPem: PEM,
        apiUrl: API,
        ...overrides,
    };
}

interface Call {
    url: string;
    method: string;
    authorization: string;
}

/** Records every request and answers the token endpoint. No network, no timers. */
function stubFetch(options: { expiresAt?: () => string; token?: () => string; installations?: unknown } = {}) {
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
                    expires_at: options.expiresAt?.() ?? new Date(Date.now() + 3600_000).toISOString(),
                }),
                { status: 201 },
            );
        }
        if (url.includes('/app/installations')) {
            return new Response(JSON.stringify(options.installations ?? [{ id: 99, account: { login: 'acme' } }]), {
                status: 200,
            });
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
        await installationTokenProvider({ github: appConfig(), fetchFn }).get();

        const { header, raw } = jwtFrom(calls);
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

        const [h, p, signature] = raw.split('.');
        const verified = createVerify('RSA-SHA256')
            .update(`${h}.${p}`)
            .end()
            .verify(createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }) as string), Buffer.from(signature as string, 'base64url'));
        expect(verified).toBe(true);
    });

    it('backdates iat, because GitHub rejects one in its own future', async () => {
        // The two clocks are not the same clock, and a machine running a few seconds fast would
        // otherwise fail every mint with a 401 that reads exactly like a bad key.
        const now = Date.parse('2026-08-21T12:00:00.000Z');
        const { calls, fetchFn } = stubFetch();
        await installationTokenProvider({ github: appConfig(), fetchFn, now: () => now }).get();

        const { payload } = jwtFrom(calls);
        expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
        // Under GitHub's 10 minute ceiling, with room for a slow clock at the other end too.
        expect((payload.exp as number) - (payload.iat as number)).toBe(540);
    });

    it('sends the app id as a string, so a client id of the Iv23li… form still works', async () => {
        const { calls, fetchFn } = stubFetch();
        await installationTokenProvider({ github: appConfig(), fetchFn }).get();
        expect(jwtFrom(calls).payload.iss).toBe('Iv23liEXAMPLE');
    });

    it('refuses a key that is not a usable private key, at construction', async () => {
        // Boot-fatal, where loadConfig's shape check left off: a well-formed PEM header around
        // nothing would otherwise fail at the first fetch, minutes later.
        expect(() =>
            installationTokenProvider({
                github: appConfig({ privateKeyPem: '-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----' }),
                fetchFn: stubFetch().fetchFn,
            }),
        ).toThrow(/not a usable private key/);
    });
});

describe('the installation token', () => {
    it('is cached until the refresh margin, then re-minted', async () => {
        let now = Date.parse('2026-08-21T12:00:00.000Z');
        const { calls, fetchFn } = stubFetch({ expiresAt: () => new Date(now + 3600_000).toISOString() });
        const tokens = installationTokenProvider({ github: appConfig(), fetchFn, now: () => now });

        await tokens.get();
        const mints = () => calls.filter((call) => call.url.includes('/access_tokens')).length;
        expect(mints()).toBe(1);

        // Inside the hour but outside the five-minute margin: still the cached token.
        now += 50 * 60 * 1000;
        await tokens.get();
        expect(mints()).toBe(1);

        // Inside the margin. A full repo walk is minutes of paging, so a token that expires
        // mid-walk fails halfway with a 401 that reads as a rejected credential.
        now += 7 * 60 * 1000;
        await tokens.get();
        expect(mints()).toBe(2);
    });

    it('mints once when two callers race a cold cache', async () => {
        // GitHub does not invalidate the loser, so a double mint leaves a live token nothing holds.
        const { calls, fetchFn } = stubFetch();
        const tokens = installationTokenProvider({ github: appConfig(), fetchFn });

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
        const tokens = installationTokenProvider({ github: appConfig(), fetchFn });

        const [a, b] = await Promise.all([tokens.fresh(), tokens.fresh()]);
        expect(a).toBe(b);
        expect(calls.filter((call) => call.url.includes('/access_tokens'))).toHaveLength(1);
    });

    it('trusts GitHub\'s expires_at rather than assuming an hour', async () => {
        let now = Date.parse('2026-08-21T12:00:00.000Z');
        // A ten-minute token: entirely inside what an assumed hour would consider fresh.
        const { calls, fetchFn } = stubFetch({ expiresAt: () => new Date(now + 10 * 60 * 1000).toISOString() });
        const tokens = installationTokenProvider({ github: appConfig(), fetchFn, now: () => now });

        await tokens.get();
        now += 6 * 60 * 1000;
        await tokens.get();
        expect(calls.filter((call) => call.url.includes('/access_tokens'))).toHaveLength(2);
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
            expiresAt: () => new Date(now + 3600_000).toISOString(),
        });
        const tokens = installationTokenProvider({ github: appConfig(), fetchFn, now: () => now });
        const mints = () => calls.filter((call) => call.url.includes('/access_tokens')).length;

        const cached = await tokens.get();
        expect(cached).toBe('ghs_1');
        expect(mints()).toBe(1);

        // Minutes into the cached token's hour, a claim still mints, and gets a different token.
        now += 50 * 60 * 1000;
        const fresh = await tokens.fresh();
        expect(fresh).toBe('ghs_2');
        expect(mints()).toBe(2);

        // The fresh mint is also what the cache now holds, so ordinary reads ride it.
        await expect(tokens.get()).resolves.toBe('ghs_2');
        expect(mints()).toBe(2);
    });
});

describe('discovering the installation', () => {
    it('uses the configured id without asking', async () => {
        const { calls, fetchFn } = stubFetch();
        await installationTokenProvider({ github: appConfig(), fetchFn }).get();
        expect(calls.some((call) => call.url.endsWith('/app/installations?per_page=100'))).toBe(false);
        expect(calls[0]?.url).toBe(`${API}/app/installations/4242/access_tokens`);
    });

    it('discovers it when exactly one installation exists', async () => {
        const { calls, fetchFn } = stubFetch();
        const tokens = installationTokenProvider({ github: appConfig({ installationId: null }), fetchFn });
        await tokens.get();
        expect(calls[1]?.url).toBe(`${API}/app/installations/99/access_tokens`);
        await expect(tokens.installationId()).resolves.toBe('99');
    });

    it('refuses to guess when the App is installed nowhere', async () => {
        // The single most likely first-run state, and it needs saying out loud rather than
        // presenting as an empty dashboard.
        const { fetchFn } = stubFetch({ installations: [] });
        await expect(
            installationTokenProvider({ github: appConfig({ installationId: null }), fetchFn }).get(),
        ).rejects.toThrow(/not installed anywhere/);
    });

    it('refuses to guess between several, and names them', async () => {
        // Guessing would silently measure somebody else's organization.
        const { fetchFn } = stubFetch({
            installations: [
                { id: 1, account: { login: 'acme' } },
                { id: 2, account: { login: 'other' } },
            ],
        });
        await expect(
            installationTokenProvider({ github: appConfig({ installationId: null }), fetchFn }).get(),
        ).rejects.toThrow(/installed on 2 accounts \(acme, other\)[\s\S]*GITHUB_APP_INSTALLATION_ID/);
    });

    it('abandons a discovery that hangs rather than holding the caller forever', async () => {
        /*
         * With no configured id, discovery is the FIRST request a claim makes, and it runs inside
         * the claim's transaction — so a hung lookup holds the job-row lock and a pool connection
         * exactly as a hung mint would, and it has to abort on the same clock. This stub only
         * settles when its signal does.
         */
        const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init?.signal?.reason));
            })) as typeof fetch;
        const tokens = installationTokenProvider({ github: appConfig({ installationId: null }), fetchFn, mintTimeoutMs: 10 });

        await expect(tokens.fresh()).rejects.toMatchObject({ name: 'TimeoutError' });
    });
});
