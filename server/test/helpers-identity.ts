import type { GitHubIdentity, GitHubIdentityClient, InstallationAccount } from '../src/auth/github.js';
import { SESSION_COOKIE, hashToken, mintToken, sign } from '../src/auth/session.js';
import type { AuthStore, Caller, InstallationRef } from '../src/auth/store.js';
import { TEST_SESSION_SECRET } from './helpers-config.js';

const SESSION_TTL_MS = 3600_000;

/** Mints a live session for `caller` — in the caller's own org — and returns the Cookie header. */
export async function signedIn(store: AuthStore, caller: Caller, secret = TEST_SESSION_SECRET): Promise<string> {
    const token = mintToken();
    await store.createSession(hashToken(token), caller.user.id, new Date(Date.now() + SESSION_TTL_MS), caller.org.id);
    return `${SESSION_COOKIE}=${sign(token, secret)}`;
}

export interface IdentityStub extends GitHubIdentityClient {
    /** What the next exchange resolves to. Set per test. */
    next: GitHubIdentity;
    exchanges: string[];
    /** The standing `installations()` answer, until a queued one-shot overrides it. */
    installationsAnswer: InstallationAccount[];
    /** One-shot answers, consumed first — for flows whose answer CHANGES between sign-ins. */
    installationsQueue: InstallationAccount[][];
    /** When set, the next `installations()` throws instead — GitHub could not be asked. */
    installationsError?: Error;
    /** Every installations call, so a test can assert it happened (or did not). */
    installationsCalls: string[];
}

export function stubIdentityClient(identity?: Partial<GitHubIdentity>): IdentityStub {
    const stub: IdentityStub = {
        next: {
            githubUserId: 4242,
            login: 'octocat',
            displayName: 'The Octocat',
            avatarUrl: null,
            ...identity,
        },
        exchanges: [],
        installationsAnswer: [],
        installationsQueue: [],
        installationsCalls: [],
        authorizeUrl: (state) => `https://github.test/login/oauth/authorize?state=${state}`,
        async exchange(code) {
            stub.exchanges.push(code);
            return `access-for-${code}`;
        },
        async identity() {
            return stub.next;
        },
        async installations() {
            stub.installationsCalls.push('installations');
            if (stub.installationsError) throw stub.installationsError;
            return stub.installationsQueue.shift() ?? stub.installationsAnswer;
        },
    };
    return stub;
}

/** Shorthand: one installation, the common case. */
export const oneInstallation = (id: string, account = 'acme'): InstallationAccount[] => [{ id, account }];

/** Installation refs as the store's signIn takes them. */
export const refsOf = (installations: readonly InstallationAccount[]): InstallationRef[] =>
    installations.map((i) => ({ id: i.id, name: i.account ?? i.id }));
