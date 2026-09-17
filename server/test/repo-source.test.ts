import { describe, expect, it } from 'vitest';
import { createRepoSource, staticRepoSource } from '../src/github/repo-source.js';
import type { GitHubAppClient, InstallationRepo } from '../src/github/app-client.js';

const repo = (name: string): InstallationRepo =>
    Object.freeze({
        owner: name.split('/')[0]!,
        name: name.split('/')[1]!,
        private: false,
        defaultBranch: null,
        pushedAt: null,
    });

/** A client whose listing is fixed — the App arm of the source, without the network. */
function clientWith(...names: string[]): GitHubAppClient {
    return {
        async listRepositories() {
            return {
                repos: names.map(repo),
                installation: { id: '123', account: 'acme', repositorySelection: 'all' as const },
            };
        },
    };
}

describe('the tracked-repo allowlist (#125)', () => {
    it('narrows the client listing to the allowlist', async () => {
        const source = createRepoSource({
            client: clientWith('acme/web', 'acme/other'),
            allowlist: async () => ['acme/web'],
        });
        // The snapshot never fetches: empty until the first list.
        expect(source.snapshotNames()).toEqual([]);

        const listing = await source.list();
        expect(listing.map((r) => `${r.owner}/${r.name}`)).toEqual(['acme/web']);
        // Every accessor carries the narrowed list: the figures a page renders are interpretable
        // exactly when the list that produced them is named.
        expect(source.snapshotNames()).toEqual(['acme/web']);
        expect((await source.detail()).repos.map((r) => `${r.owner}/${r.name}`)).toEqual(['acme/web']);
    });

    it('treats an empty allowlist as no narrowing — everything the installation reports', async () => {
        // The default confirmation writes no rows; the deployment then tracks what it always
        // tracked. Empty must never read as "track nothing".
        const source = createRepoSource({
            client: clientWith('acme/web', 'acme/other'),
            allowlist: async () => [],
        });

        expect((await source.list()).map((r) => `${r.owner}/${r.name}`)).toEqual(['acme/web', 'acme/other']);
    });

    it('narrows the stored fallback the same way', async () => {
        const source = createRepoSource({
            stored: async () => ['acme/web', 'acme/other'],
            allowlist: async () => ['acme/other'],
        });

        expect((await source.list()).map((r) => `${r.owner}/${r.name}`)).toEqual(['acme/other']);
    });

    it('narrows against the fresh list, not a stale one, across a cached refresh', async () => {
        let clock = 1_000;
        const names = ['acme/web', 'acme/other'];
        const source = createRepoSource({
            client: {
                async listRepositories() {
                    return {
                        repos: names.map(repo),
                        installation: { id: '123', account: 'acme', repositorySelection: null },
                    };
                },
            },
            allowlist: async () => ['acme/web'],
            ttlMs: 1_000,
            now: () => clock,
        });

        expect((await source.list()).map((r) => `${r.owner}/${r.name}`)).toEqual(['acme/web']);
        // The App gains a repo; the allowlist still names only acme/web, so the refresh narrows
        // again rather than leaking the new repo into the tracked set.
        names.push('acme/new');
        clock += 2_000;
        expect((await source.list()).map((r) => `${r.owner}/${r.name}`)).toEqual(['acme/web']);
    });

    it('leaves a source without an allowlist untouched', async () => {
        const source = createRepoSource({ client: clientWith('acme/web', 'acme/other') });
        expect((await source.list()).map((r) => `${r.owner}/${r.name}`)).toEqual(['acme/web', 'acme/other']);

        // The route tests' static source is the same shape: no allowlist, no narrowing.
        expect(
            (await staticRepoSource([{ owner: 'acme', name: 'web' }]).list()).map((r) => `${r.owner}/${r.name}`)
        ).toEqual(['acme/web']);
    });
});
