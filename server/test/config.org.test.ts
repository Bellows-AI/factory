import { describe, expect, it } from 'vitest';
import { LOCAL_ORG_ID, loadConfig } from '../src/config.js';

/** All required now, and none of these cases is about any of them. */
const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const env = (extra: NodeJS.ProcessEnv = {}) => ({
    DATABASE_URL: DB,
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
    ...extra,
});

describe('the organization', () => {
    it('has no configured org at all: the orgs are the App installations (#99)', () => {
        const config = loadConfig(env());
        expect('orgId' in config).toBe(false);
        expect('orgName' in config).toBe(false);
        expect('repos' in config).toBe(false);
    });

    it('names the single local org AUTH_MODE=none lives in', () => {
        // Not config — a constant. There is nothing to configure it from: no sign-in, no
        // installation, so the offline tooling shares one literal partition.
        expect(LOCAL_ORG_ID).toBe('default');
    });

    it('refuses ORG_ID: the orgs are the installations now', () => {
        // A variable that worked yesterday must not silently no-op — the ORG_REPOS precedent.
        expect(() => loadConfig(env({ ORG_ID: 'acme' }))).toThrow(/ORG_ID is no longer supported/);
        // An empty value is not an override, here as everywhere: compose passes these empty.
        expect(() => loadConfig(env({ ORG_ID: '' }))).not.toThrow();
        expect(() => loadConfig(env({ ORG_ID: '  ' }))).not.toThrow();
    });

    it('refuses ORG_NAME: the name is the installation account login, reported at sign-in', () => {
        expect(() => loadConfig(env({ ORG_NAME: 'Bellows AI' }))).toThrow(/ORG_NAME is no longer supported/);
        expect(() => loadConfig(env({ ORG_NAME: '' }))).not.toThrow();
    });

    it('refuses GITHUB_APP_INSTALLATION_ID: tokens mint per org from organization.installation_id', () => {
        expect(() => loadConfig(env({ GITHUB_APP_INSTALLATION_ID: '4242' }))).toThrow(
            /GITHUB_APP_INSTALLATION_ID is no longer supported/
        );
        expect(() => loadConfig(env({ GITHUB_APP_INSTALLATION_ID: '' }))).not.toThrow();
    });

    it('carries no repo list at all: the App installation reports it', () => {
        // The property is gone rather than empty. A configured list beside an installation would be
        // a second roster to keep in step, and the installation is also the credential.
        expect('repos' in loadConfig(env())).toBe(false);
    });

    it('refuses ORG_REPOS and GITHUB_REPOS, naming what replaced them', () => {
        // The deliberate exception to "an unknown environment variable is ignored". A variable that
        // WAS meaningful and is now dropped reverts a two-repo dashboard to a different set and
        // still renders, indistinguishable from a repo genuinely removed.
        expect(() => loadConfig(env({ ORG_REPOS: 'a,b' }))).toThrow(/ORG_REPOS is no longer supported/);
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
