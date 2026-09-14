import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';

export const SESSION_COOKIE = 'factory_session';
export const OAUTH_COOKIE = 'factory_oauth';

/** How long the OAuth round trip is allowed to take. Long enough to read a consent screen. */
export const OAUTH_TTL_SECONDS = 600;

const b64url = (buffer: Buffer): string => buffer.toString('base64url');

/**
 * 32 bytes from the CSPRNG. The token is opaque and carries no claims: what a session means is a
 * row, so a stolen cookie can be revoked rather than merely waited out.
 */
export const mintToken = (): string => b64url(randomBytes(32));

/**
 * What is stored. The session table holds this, never the token itself — the row is a bearer
 * credential at rest, and anyone with a read on the table would otherwise hold every live session.
 */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

const mac = (value: string, secret: string): string => b64url(createHmac('sha256', secret).update(value).digest());

/** `<value>.<hmac>`. */
export const sign = (value: string, secret: string): string => `${value}.${mac(value, secret)}`;

/**
 * The signed value, or null.
 *
 * The signature exists even though the token is already unguessable, and buys two things: a forged
 * or truncated cookie is rejected without a database round trip, so an unauthenticated flood does
 * not cost a query per request; and rotating the secret invalidates every cookie at once, which is
 * the only lever an operator has when something has leaked.
 */
export function unsign(signed: string | undefined, secret: string): string | null {
    if (!signed) return null;
    const cut = signed.lastIndexOf('.');
    if (cut <= 0) return null;
    const value = signed.slice(0, cut);
    const provided = Buffer.from(signed.slice(cut + 1));
    const expected = Buffer.from(mac(value, secret));
    // timingSafeEqual throws on a length mismatch, so the lengths are compared first — and an
    // unequal length is itself a rejection, not something to compare byte by byte.
    if (provided.length !== expected.length) return null;
    return timingSafeEqual(provided, expected) ? value : null;
}

/**
 * A path this server will redirect a browser to after login.
 *
 * Anything that is not plainly a same-origin absolute path becomes `/`. A protocol-relative `//evil`
 * is a URL to another origin that merely looks like a path, and a full URL is one outright — either
 * would turn the callback into an open redirect for anyone who can craft a login link.
 */
export function safeReturnPath(raw: string | undefined | null): string {
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/';
    return raw;
}

interface StatePayload {
    n: string;
    r: string;
}

/**
 * The CSRF state, with the post-login destination travelling inside it.
 *
 * One signed value rather than a state cookie plus a separate return-path cookie: one signature then
 * covers both, so the destination cannot be swapped for another while the state still verifies.
 *
 * Held in a short-lived cookie rather than a row, which means no table, no reaper, and — the reason
 * that matters — the login entry point keeps working while migrations are still retrying, the same
 * instinct that keeps /api/health off the database.
 */
export function encodeState(returnTo: string, secret: string): string {
    const payload: StatePayload = { n: b64url(randomBytes(16)), r: safeReturnPath(returnTo) };
    return sign(b64url(Buffer.from(JSON.stringify(payload))), secret);
}

export function decodeState(signed: string | undefined, secret: string): { returnTo: string } | null {
    const value = unsign(signed, secret);
    if (!value) return null;
    try {
        const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as StatePayload;
        return { returnTo: safeReturnPath(payload.r) };
    } catch {
        return null;
    }
}

/** Constant-time comparison of the state returned by GitHub against the one in the cookie. */
export function statesMatch(fromQuery: string | undefined, fromCookie: string | undefined): boolean {
    if (!fromQuery || !fromCookie) return false;
    const a = Buffer.from(fromQuery);
    const b = Buffer.from(fromCookie);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * The session cookie's attributes, in one place because each one is a decision.
 *
 * - `sameSite: 'lax'`, and NEVER 'strict'. The OAuth callback is a top-level GET arriving from
 *   github.com; 'strict' withholds cookies on a cross-site top-level navigation, so the state cookie
 *   would be absent at the callback and login would fail every single time — with a state-mismatch
 *   error that reads exactly like an attack. 'lax' sends on top-level GET and nothing else. Not
 *   'none', which requires Secure and permits cross-site POST.
 * - `path: '/'`, not '/api'. There is one origin here, and a path-scoped cookie is a trap the first
 *   time a page wants to know it is signed in without issuing a fetch.
 * - `httpOnly`, so script cannot read it. This is the whole reason the token is not in localStorage.
 * - no `domain`, so the cookie is host-only. `domain=.example.com` would widen it to every
 *   subdomain, including ones this deployment does not control.
 * - `secure` is passed in rather than decided here — see AuthConfig.cookieSecure for why it is
 *   configured rather than derived from the request.
 */
export function sessionCookieOptions(secure: boolean, maxAgeSeconds: number): CookieSerializeOptions {
    return { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: maxAgeSeconds };
}

/**
 * The OAuth state cookie. Scoped to the auth routes, because nothing else ever reads it, and
 * short-lived because it is single-use — the callback clears it either way.
 */
export function oauthCookieOptions(secure: boolean): CookieSerializeOptions {
    return { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure, maxAge: OAUTH_TTL_SECONDS };
}
