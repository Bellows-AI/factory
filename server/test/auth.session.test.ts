import { describe, expect, it } from 'vitest';
import {
    OAUTH_COOKIE,
    SESSION_COOKIE,
    decodeState,
    encodeState,
    hashToken,
    mintToken,
    oauthCookieOptions,
    safeReturnPath,
    sessionCookieOptions,
    sign,
    statesMatch,
    unsign,
} from '../src/auth/session.js';

const SECRET = 'a-secret-that-is-at-least-32-characters';

describe('session tokens', () => {
    it('stores the hash and never the token', () => {
        const token = mintToken();
        const hash = hashToken(token);
        expect(hash.length).toBe(32);
        expect(hash.toString('hex')).not.toContain(token);
        // Same token, same hash — the lookup is by hash, so this is what makes it work at all.
        expect(hashToken(token).equals(hash)).toBe(true);
    });

    it('mints a different token every time', () => {
        expect(new Set(Array.from({ length: 50 }, mintToken)).size).toBe(50);
    });

    it('round-trips a signed value', () => {
        expect(unsign(sign('hello', SECRET), SECRET)).toBe('hello');
    });

    it('refuses a value whose signature was tampered with', () => {
        const signed = sign('hello', SECRET);
        expect(unsign(`${signed}x`, SECRET)).toBeNull();
        expect(unsign(signed.replace('hello', 'hellp'), SECRET)).toBeNull();
    });

    it('refuses a value signed with a different secret, which is what makes rotation a logout', () => {
        expect(unsign(sign('hello', SECRET), `${SECRET}-rotated`)).toBeNull();
    });

    it('refuses a cookie with no signature at all rather than throwing', () => {
        expect(unsign(undefined, SECRET)).toBeNull();
        expect(unsign('', SECRET)).toBeNull();
        expect(unsign('nodot', SECRET)).toBeNull();
        expect(unsign('.onlyamac', SECRET)).toBeNull();
    });
});

describe('cookie attributes', () => {
    /*
     * Pinned literally, because every one of these is a decision and the failure modes are all
     * silent. SameSite in particular: 'strict' is what somebody reaching for "the most secure
     * option" picks, and it breaks login 100% of the time — the OAuth callback is a top-level
     * navigation from github.com, so the state cookie would simply not be sent.
     */
    it('is httpOnly, lax, root-scoped and host-only', () => {
        const options = sessionCookieOptions(false, 1209600);
        expect(options).toEqual({
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
            maxAge: 1209600,
        });
        // No `domain`, ever: it would widen the cookie to every subdomain of the deployment.
        expect(options).not.toHaveProperty('domain');
    });

    it('carries Secure only when it is configured to', () => {
        expect(sessionCookieOptions(true, 60).secure).toBe(true);
        expect(sessionCookieOptions(false, 60).secure).toBe(false);
    });

    it('scopes the oauth cookie to the auth routes and expires it in ten minutes', () => {
        expect(oauthCookieOptions(false)).toEqual({
            path: '/api/auth',
            httpOnly: true,
            sameSite: 'lax',
            secure: false,
            maxAge: 600,
        });
    });

    it('names the cookies stably, because the name is part of the deployment contract', () => {
        expect(SESSION_COOKIE).toBe('factory_session');
        expect(OAUTH_COOKIE).toBe('factory_oauth');
    });
});

describe('oauth state', () => {
    it('round-trips the return path inside the signed value', () => {
        expect(decodeState(encodeState('/reports', SECRET), SECRET)).toEqual({
            returnTo: '/reports',
            org: null,
            reselect: false,
        });
    });

    it('carries the reselect flag through the signature (#125)', () => {
        expect(decodeState(encodeState('/', SECRET, undefined, true), SECRET)).toEqual({
            returnTo: '/',
            org: null,
            reselect: true,
        });
    });

    it('is different every time, so one state cannot complete another browser flow', () => {
        expect(encodeState('/', SECRET)).not.toBe(encodeState('/', SECRET));
    });

    it('refuses a state that was not signed by this server', () => {
        expect(decodeState(encodeState('/', SECRET), 'another-secret-at-least-32-characters')).toBeNull();
        expect(decodeState(undefined, SECRET)).toBeNull();
        expect(decodeState('garbage.garbage', SECRET)).toBeNull();
    });

    it('compares states in constant time and rejects any absence', () => {
        expect(statesMatch('abc', 'abc')).toBe(true);
        expect(statesMatch('abc', 'abd')).toBe(false);
        // Different lengths must not reach timingSafeEqual, which throws on them.
        expect(statesMatch('abc', 'abcd')).toBe(false);
        expect(statesMatch(undefined, 'abc')).toBe(false);
        expect(statesMatch('abc', undefined)).toBe(false);
    });
});

describe('return paths', () => {
    it('keeps an ordinary same-origin path', () => {
        expect(safeReturnPath('/reports?range=week')).toBe('/reports?range=week');
    });

    it('refuses anything that leaves this origin', () => {
        // The whole open-redirect surface. `//evil.test` is the subtle one: it is a URL to another
        // origin that merely looks like a path.
        expect(safeReturnPath('//evil.test/phish')).toBe('/');
        expect(safeReturnPath('https://evil.test')).toBe('/');
        expect(safeReturnPath('javascript:alert(1)')).toBe('/');
        expect(safeReturnPath('')).toBe('/');
        expect(safeReturnPath(null)).toBe('/');
        expect(safeReturnPath(undefined)).toBe('/');
    });

    it('survives a return path smuggled through the state', () => {
        expect(decodeState(encodeState('//evil.test', SECRET), SECRET)).toEqual({
            returnTo: '/',
            org: null,
            reselect: false,
        });
    });

    it('carries a requested organization through the signature, and only a decimal id at that', () => {
        expect(decodeState(encodeState('/', SECRET, '999999'), SECRET)).toEqual({
            returnTo: '/',
            org: '999999',
            reselect: false,
        });
        // Anything else decodes as "no preference" — the shape is the installation id's, or nothing.
        expect(decodeState(encodeState('/', SECRET, 'other-org'), SECRET)).toEqual({
            returnTo: '/',
            org: null,
            reselect: false,
        });
    });
});
