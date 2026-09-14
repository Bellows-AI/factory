import { randomBytes } from 'node:crypto';

/**
 * A prefix, not decoration: it makes a leaked token greppable in a log or a repository, and it
 * lets the board tell "this is an access token" — and which kind — from "this is something else"
 * without a database lookup. The same reasoning the worker token's `fwt_` carries.
 */
export const PERSONAL_TOKEN_PREFIX = 'fat_';
export const ORG_TOKEN_PREFIX = 'oat_';

export const isAccessToken = (token: string): boolean =>
    token.startsWith(PERSONAL_TOKEN_PREFIX) || token.startsWith(ORG_TOKEN_PREFIX);

/** 32 bytes from the CSPRNG, base64url, prefixed — byte-for-byte the worker-token recipe. */
export const mintAccessToken = (kind: 'personal' | 'org'): string =>
    `${kind === 'personal' ? PERSONAL_TOKEN_PREFIX : ORG_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
