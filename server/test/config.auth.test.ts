import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

// The App credentials are spelled out because they are required now — the environment has no
// no-fetch state left — and none of these cases is about the repo-read credential.
const BASE = {
    DATABASE_URL: 'postgres://factory:factory@127.0.0.1:5432/factory_dev',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
};
const SECRET = 'a-secret-that-is-at-least-32-characters';

const load = (env: NodeJS.ProcessEnv) => loadConfig({ ...BASE, ...env });

const github = (env: NodeJS.ProcessEnv = {}) =>
    load({
        AUTH_MODE: 'github',
        GITHUB_OAUTH_CLIENT_ID: 'client-id',
        GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
        SESSION_SECRET: SECRET,
        ...env,
    });

describe('AUTH_MODE', () => {
    it('defaults to none, so every existing deployment keeps booting', () => {
        // A newly required variable that fails every existing case is the signal not to require it.
        expect(load({}).auth.mode).toBe('none');
    });

    it('is an explicit enum, never inferred from whether a client id happens to be set', () => {
        /*
         * The important half of this test is the SECOND assertion. A mode inferred from "is there a
         * client id?" is a mode reached by typo — set GITHUB_OAUTH_CLIENT_IDD and the deployment
         * silently serves every route to everyone. So a client id with no AUTH_MODE stays `none`,
         * loudly, rather than half-enabling anything.
         */
        expect(github().auth.mode).toBe('github');
        expect(load({ GITHUB_OAUTH_CLIENT_ID: 'client-id' }).auth.mode).toBe('none');
    });

    it('refuses a mode it does not recognise', () => {
        expect(() => load({ AUTH_MODE: 'oidc' })).toThrow(/AUTH_MODE must be "github" or "none"/);
    });
});

describe('github mode is all-or-nothing', () => {
    it.each(['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'SESSION_SECRET'])(
        'is fatal when %s is missing, and names it',
        (key) => {
            // Named individually: the operator has one key to fix and should not have to diff the
            // example file to work out which.
            expect(() => github({ [key]: '' })).toThrow(new RegExp(key));
        },
    );

    it('never degrades to an open deployment when half-configured', () => {
        // The one failure nobody notices, so it is a refusal rather than a warning.
        expect(() => github({ SESSION_SECRET: '' })).toThrow();
    });

    it('refuses a session secret short enough to be guessed', () => {
        expect(() => github({ SESSION_SECRET: 'short' })).toThrow(/at least 32 characters/);
    });
});

describe('the public bind refusal', () => {
    it('refuses AUTH_MODE=none on a host reachable from off the machine', () => {
        // Stronger than a warning: it makes "open to the network" inexpressible, which is more than
        // the bind address ever guaranteed on its own.
        expect(() => load({ HOST: '0.0.0.0' })).toThrow(/AUTH_MODE is "none" but HOST is "0.0.0.0"/);
    });

    it('allows it through one explicit hatch', () => {
        // Required in practice: docker/Dockerfile sets HOST=0.0.0.0, and the isolation there is
        // compose's 127.0.0.1 publish — something loadConfig cannot see and must not guess at.
        expect(load({ HOST: '0.0.0.0', AUTH_ALLOW_PUBLIC_BIND: '1' }).auth.mode).toBe('none');
    });

    it.each(['127.0.0.1', '::1', 'localhost'])('allows loopback %s with no hatch', (host) => {
        expect(load({ HOST: host }).auth.mode).toBe('none');
    });

    it('does not apply to github mode, where the port is not the access control', () => {
        expect(github({ HOST: '0.0.0.0', PUBLIC_URL: 'https://factory.example.com' }).auth.mode).toBe('github');
    });
});

describe('PUBLIC_URL', () => {
    it('defaults for a loopback bind, where the origin is unambiguous', () => {
        const auth = github({ HOST: '127.0.0.1', PORT: '8080' });
        expect(auth.auth.mode === 'github' && auth.auth.publicUrl).toBe('http://127.0.0.1:8080');
    });

    it('is required once the host is not loopback', () => {
        // `http://0.0.0.0:8080` is not somewhere a browser is ever redirected back to, and guessing
        // it fails at GitHub with an opaque error.
        expect(() => github({ HOST: '0.0.0.0' })).toThrow(/PUBLIC_URL must be set/);
    });

    it('must be an absolute http(s) URL', () => {
        expect(() => github({ PUBLIC_URL: '/callback' })).toThrow(/absolute URL/);
        expect(() => github({ PUBLIC_URL: 'ftp://example.com' })).toThrow(/http or https/);
    });

    it('keeps only the origin, so a stray path cannot end up in the redirect_uri', () => {
        const auth = github({ PUBLIC_URL: 'https://factory.example.com/some/path' });
        expect(auth.auth.mode === 'github' && auth.auth.publicUrl).toBe('https://factory.example.com');
    });
});

describe('the rest of [auth]', () => {
    it('takes booleans in either spelling and refuses anything else', () => {
        expect(github({ COOKIE_SECURE: '1' }).auth.mode === 'github').toBe(true);
        expect((github({ COOKIE_SECURE: 'true' }).auth as { cookieSecure: boolean }).cookieSecure).toBe(true);
        expect((github({ COOKIE_SECURE: '0' }).auth as { cookieSecure: boolean }).cookieSecure).toBe(false);
        expect(() => github({ COOKIE_SECURE: 'yes please' })).toThrow(/must be a boolean/);
    });

    it('defaults the session to a fortnight', () => {
        expect((github().auth as { sessionTtlMs: number }).sessionTtlMs).toBe(14 * 24 * 3600 * 1000);
    });

    it('lowercases the bootstrap admin, because GitHub logins are case-insensitive', () => {
        expect((github({ AUTH_BOOTSTRAP_ADMIN: 'OctoCat' }).auth as { bootstrapAdmin: string }).bootstrapAdmin).toBe(
            'octocat',
        );
    });

    it('leaves auto-join off unless an organization is named', () => {
        const auth = (env: NodeJS.ProcessEnv = {}) =>
            github(env).auth as { autoJoinGithubOrg: string | null };
        // Off is invite-only membership, which is the state every existing deployment is in.
        expect(auth().autoJoinGithubOrg).toBeNull();
        expect(auth({ AUTH_AUTO_JOIN_GITHUB_ORG: '  ' }).autoJoinGithubOrg).toBeNull();
        // NOT lowercased, unlike the bootstrap admin: this is a path segment sent to GitHub's API,
        // which is case-insensitive about it, and the value is echoed back in the log and the
        // consent screen where the operator's own spelling is what they will recognise.
        expect(auth({ AUTH_AUTO_JOIN_GITHUB_ORG: 'Bellows-AI' }).autoJoinGithubOrg).toBe('Bellows-AI');
    });

    it('carries the ingest token in both modes', () => {
        expect(load({ INGEST_TOKEN: 'secret' }).auth.ingestToken).toBe('secret');
        expect(github({ INGEST_TOKEN: 'secret' }).auth.ingestToken).toBe('secret');
    });

    it('points at github.com unless the environment overrides it', () => {
        expect((github().auth as { authorizeUrl: string }).authorizeUrl).toBe(
            'https://github.com/login/oauth/authorize',
        );
    });
});

describe('loadConfig stays a pure function of its argument', () => {
    it('still accepts a bare environment with a database url and nothing else', () => {
        // The whole describe('loadConfig') block depends on this, and so does `git clone && npm run
        // dev`: there is no offline way to obtain an OAuth client id.
        expect(() => load({})).not.toThrow();
    });
});
