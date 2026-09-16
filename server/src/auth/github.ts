import type { AuthConfig } from '../config.js';

/** What GitHub is asked for, and all it is asked for. */
export interface GitHubIdentity {
    /** The identity. Stable across renames, which is why nothing keys on the login. */
    githubUserId: number;
    login: string;
    displayName: string | null;
    avatarUrl: string | null;
}

/**
 * What GitHub says about an account's place in one organization.
 *
 * `role` is the org-level role from `GET /user/memberships/orgs/{org}` — `admin` or plain `member`.
 * When `state` is not `active` there is no membership to have a role in, and it is `member`.
 */
export interface OrgMembership {
    state: 'active' | 'pending' | 'none';
    role: 'admin' | 'member';
}

/**
 * One GitHub App installation the signing-in account can see.
 *
 * `id` is the installation id as a decimal string, because it becomes the organization id —
 * which is a `^[a-z0-9][a-z0-9_-]{0,38}$` database key and URL parameter, not a number.
 */
export interface InstallationAccount {
    id: string;
    /** The account (organization or user) the App is installed on, by login. A label. */
    account: string | null;
}

/**
 * The two calls the OAuth exchange needs, behind a seam.
 *
 * An interface rather than direct `fetch` calls because it is what keeps `npm test` offline: the
 * route tests drive a stub and never reach the network. Hand-rolled rather than delegated to an
 * OAuth library because the state and CSRF handling is the part of this flow most worth being able
 * to read here, and a library would own it — the same argument docs/organizations.md makes for not
 * introducing an interface that ships one implementation.
 */
export interface GitHubIdentityClient {
    authorizeUrl(state: string): string;
    exchange(code: string): Promise<string>;
    identity(accessToken: string): Promise<GitHubIdentity>;
    /**
     * This account's membership of `org`, asked with the signing-in person's own token.
     *
     * `pending` is its own answer rather than folded into `active`: an unaccepted GitHub invitation
     * means somebody was offered a seat, not that they hold one, and admitting them would let an
     * org admin add a login to Factory without that person ever agreeing to it.
     *
     * Called when auth.auto_join_github_org is set — for an account with no row yet, and again on
     * every sign-in of a row auto-join created, which is how removals and role changes in the org
     * reach Factory. Requires `read:org`, which is requested whenever auto-join is configured — an
     * unscoped token sees no organizations and would report every account `none`.
     */
    orgMembership(accessToken: string, org: string): Promise<OrgMembership>;
    /**
     * The GitHub App installations this account can see, asked with the signing-in person's own
     * token. This IS the membership decision under multi-org sign-in (#99): one installation is
     * one organization, so what this returns is exactly the orgs the caller may sign into.
     * Requires `read:org`, which the authorize URL requests unconditionally in github mode — an
     * unscoped token reports no installations and would send everybody to the install page.
     */
    installations(accessToken: string): Promise<InstallationAccount[]>;
}

/** Where GitHub sends the browser back. Derived from the configured origin, never from a header. */
export const callbackPath = '/api/auth/github/callback';

export class GitHubAuthError extends Error {}

export function createGitHubIdentityClient(
    auth: Extract<AuthConfig, { mode: 'github' }>,
    fetchFn: typeof fetch = fetch
): GitHubIdentityClient {
    const redirectUri = `${auth.publicUrl}${callbackPath}`;

    return {
        authorizeUrl(state) {
            const url = new URL(auth.authorizeUrl);
            url.searchParams.set('client_id', auth.clientId);
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('state', state);
            // No `scope` unless auto-join is configured. Under invite-only membership `read:org`
            // buys nothing — membership is Factory's, not GitHub's — and the numeric id and login
            // this flow needs come back from /user on an unscoped token. The visible cost of asking
            // for nothing is that GitHub's consent screen says the app "will not be able to access
            // your data", which reads as broken to some people; that is the honest description of a
            // login that reads nothing.
            //
            // With auto-join on, the org check IS the membership decision, and it is unanswerable
            // without this scope: an unscoped token reports every organization absent, so every
            // sign-in would be refused with no_membership and nothing would say why.
            if (auth.autoJoinGithubOrg) url.searchParams.set('scope', 'read:org');
            return url.toString();
        },

        async exchange(code) {
            const response = await fetchFn(auth.tokenUrl, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify({
                    client_id: auth.clientId,
                    client_secret: auth.clientSecret,
                    code,
                    redirect_uri: redirectUri,
                }),
            });
            if (!response.ok) {
                throw new GitHubAuthError(`token exchange failed with ${response.status}`);
            }
            const body = (await response.json()) as {
                access_token?: string;
                error_description?: string;
                error?: string;
            };
            if (!body.access_token) {
                // GitHub reports a bad or reused code with a 200 and an `error` field, so the status
                // check above does not cover it.
                throw new GitHubAuthError(body.error_description ?? body.error ?? 'no access token returned');
            }
            return body.access_token;
        },

        async identity(accessToken) {
            const response = await fetchFn(auth.userUrl, {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: 'application/vnd.github+json',
                    // GitHub rejects an API request with no User-Agent outright.
                    'user-agent': 'factory-ai',
                },
            });
            if (!response.ok) throw new GitHubAuthError(`identity lookup failed with ${response.status}`);
            const body = (await response.json()) as {
                id?: number;
                login?: string;
                name?: string | null;
                avatar_url?: string | null;
            };
            if (typeof body.id !== 'number' || !body.login) {
                throw new GitHubAuthError('identity response carried no id or login');
            }
            return {
                githubUserId: body.id,
                login: body.login,
                displayName: body.name ?? null,
                avatarUrl: body.avatar_url ?? null,
            };
        },

        async orgMembership(accessToken, org) {
            // Derived from userUrl rather than configured separately, so the one environment seam
            // that already redirects /user redirects this too and the stub IdP needs no second knob.
            const response = await fetchFn(`${auth.userUrl}/memberships/orgs/${encodeURIComponent(org)}`, {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: 'application/vnd.github+json',
                    'user-agent': 'factory-ai',
                },
            });
            // 404 is the ordinary "not a member" answer. A 403 used to fold into it too, back when
            // the answer only refused a sign-in; the same answer now REMOVES a returning member,
            // so "GitHub could not be asked" (a missing scope, a secondary rate limit — both 403)
            // must fail the sign-in loudly instead of masquerading as a departure. Only GitHub
            // answering 404 counts as `none`.
            if (response.status === 404) return { state: 'none', role: 'member' };
            if (!response.ok) throw new GitHubAuthError(`org membership lookup failed with ${response.status}`);
            const body = (await response.json()) as { state?: string; role?: string };
            const state = body.state === 'active' ? 'active' : body.state === 'pending' ? 'pending' : 'none';
            // The org role maps onto Factory's two roles directly: an org admin may maintain
            // membership, an ordinary member may not. Anything else GitHub might report is a member.
            return { state, role: body.role === 'admin' && state === 'active' ? 'admin' : 'member' };
        },

        async installations(accessToken) {
            // Derived from userUrl rather than configured separately, so the one environment seam
            // that already redirects /user redirects this too and the stub IdP needs no second knob.
            const response = await fetchFn(`${auth.userUrl}/installations`, {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: 'application/vnd.github+json',
                    'user-agent': 'factory-ai',
                },
            });
            if (!response.ok) throw new GitHubAuthError(`installation lookup failed with ${response.status}`);
            const body = (await response.json()) as {
                installations?: { id?: number; account?: { login?: string } | null }[];
            };
            // A well-formed but meaningless entry (no numeric id) is skipped, not fatal: GitHub
            // owns the payload, and one malformed row must not lock everybody out.
            return (body.installations ?? [])
                .filter((install) => typeof install.id === 'number')
                .map((install) => ({ id: String(install.id), account: install.account?.login ?? null }));
        },
    };
}
