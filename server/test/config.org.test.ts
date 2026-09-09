import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** All required now, and none of these cases is about any of them. */
const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const env = (extra: NodeJS.ProcessEnv = {}) => (
    {
        DATABASE_URL: DB,
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
        ...extra,
    }
);

describe('the organization', () => {
    it('defaults the id to a literal, never to anything derived', () => {
        // Deriving the id would silently re-key every persisted row the day the thing it was
        // derived from changed: the dashboard comes back empty and reads as data loss, not as a
        // config change.
        expect(loadConfig(env()).orgId).toBe('default');
    });

    it('labels the organization with its id when no name is given', () => {
        // This used to fall back to GITHUB_OWNER. There is no owner to fall back to now — a GitHub
        // App installation reports each repository with its own — so the id is the only other name
        // the process has.
        expect(loadConfig(env()).orgName).toBe('default');
        expect(loadConfig(env({ ORG_ID: 'acme' })).orgName).toBe('acme');
        expect(loadConfig(env({ ORG_NAME: 'Bellows AI' })).orgName).toBe('Bellows AI');
    });

    it('treats an empty ORG_NAME as unset, so the selector is never blank', () => {
        expect(loadConfig(env({ ORG_NAME: '   ' })).orgName).toBe('default');
    });

    it('treats an empty ORG_ID as unset, consistent with every other empty value', () => {
        expect(loadConfig(env({ ORG_ID: '' })).orgId).toBe('default');
        expect(loadConfig(env({ ORG_ID: '  ' })).orgId).toBe('default');
    });

    it('rejects an id that cannot be a database key or a URL parameter', () => {
        // Rejected rather than normalised. A case-insensitive collision in a key is invisible:
        // "Bellows" and "bellows" would be two partitions that read as one.
        for (const id of [
            'Bellows AI',
            'BELLOWS',
            'Bellows',
            'bellows/front',
            'bellows.ai',
            '-bellows',
            '_bellows',
            'a'.repeat(40),
        ]) {
            expect(() => loadConfig(env({ ORG_ID: id })), id).toThrow(/ORG_ID must be/);
        }
    });

    it('refuses an id inside the reserved namespace the migration parks rows in', () => {
        // 005_organizations.sql backfills pre-organization rows to '__unclaimed__' and adopts them
        // once. A configured id in that namespace would make the adoption a no-op that looks like
        // it worked.
        expect(() => loadConfig(env({ ORG_ID: '__unclaimed__' }))).toThrow(/ORG_ID must be/);
        expect(() => loadConfig(env({ ORG_ID: '__anything' }))).toThrow(/ORG_ID must be/);
    });

    it('accepts the ids it should', () => {
        for (const id of ['bellows', 'a', 'bellows-ai', 'bellows_ai', '9to5', 'a'.repeat(39)]) {
            expect(loadConfig(env({ ORG_ID: id })).orgId, id).toBe(id);
        }
    });

    it('carries no repo list at all: the App installation reports it', () => {
        // The property is gone rather than empty. A configured list beside an installation would be
        // a second roster to keep in step, and the installation is also the credential — so a repo
        // in one and not the other used to fail every sync with a 404 that read as a deleted repo.
        expect('repos' in loadConfig(env())).toBe(false);
        expect('repoNames' in loadConfig(env())).toBe(false);
    });

    it('refuses ORG_REPOS and GITHUB_REPOS, naming what replaced them', () => {
        // The deliberate exception to "an unknown environment variable is ignored". A variable that
        // WAS meaningful and is now dropped reverts a two-repo dashboard to a different set and
        // still renders, indistinguishable from a repo genuinely removed.
        expect(() => loadConfig(env({ ORG_REPOS: 'a,b' }))).toThrow(/ORG_REPOS is no longer supported/);
        expect(() => loadConfig(env({ ORG_REPOS: 'a,b' }))).toThrow(/GitHub App installation reports/);
        expect(() => loadConfig(env({ GITHUB_REPOS: 'a,b' }))).toThrow(/GITHUB_REPOS is no longer supported/);
    });

    it('refuses GITHUB_OWNER, because a bare repo name no longer exists', () => {
        expect(() => loadConfig(env({ GITHUB_OWNER: 'acme' }))).toThrow(/GITHUB_OWNER is no longer supported/);
    });

    it('treats an empty retired variable as unset, so a stale .env line still boots', () => {
        // docker-compose passes several of these empty whenever the host has not set them, so an
        // empty value must not be an override here any more than anywhere else.
        expect(() => loadConfig(env({ GITHUB_REPOS: '', ORG_REPOS: '', GITHUB_OWNER: '' }))).not.toThrow();
    });
});
