import { describe, expect, it } from 'vitest';
import { createRepoAccessScope } from '../src/github/access-scope.js';
import { createRepoSource, staticRepoSource } from '../src/github/repo-source.js';
import { memoryUserRepoAccessStore, stubAppClient } from './helpers.js';

const ORG = 'acme';

const INSTALLATION = [
    { owner: 'acme', name: 'api' },
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'other' },
];

function setup(repos = INSTALLATION) {
    const listing = {
        repos: repos.map((repo) => ({ ...repo, private: false, defaultBranch: 'main', pushedAt: null })),
        installation: { id: '4242', account: ORG, repositorySelection: 'selected' as const },
    };
    const base = { listRepositories: async () => structuredClone(listing) };
    const appClient = stubAppClient(base);
    const access = memoryUserRepoAccessStore();
    const reposSource = staticRepoSource(repos);
    const scope = createRepoAccessScope({ appClient, repos: reposSource, org: ORG, access });
    return { appClient, access, repos: reposSource, scope };
}

describe('refreshUser', () => {
    it('stores the union of team grants and direct collaborations, inside the installation', async () => {
        const { appClient, access, scope } = setup();
        appClient.teamRepoLists.set('core', [{ owner: 'acme', name: 'api' }]);
        appClient.teamMembers.add('core/octocat');
        appClient.collaborations.add('acme/web/octocat');
        // A team grant to a repo the installation cannot see: it must not leak into the set.
        appClient.teamRepoLists.set('side', [{ owner: 'acme', name: 'secret' }]);

        await scope.refreshUser('user-1', 'octocat');

        expect(await access.repos('user-1')).toEqual(['acme/api', 'acme/web']);
    });

    it('stores an empty set when GitHub grants the account nothing — a real answer, not an absence', async () => {
        const { access, scope } = setup();

        await scope.refreshUser('user-1', 'octocat');

        expect(await access.repos('user-1')).toEqual([]);
    });

    it('leaves the previous set standing when GitHub cannot be asked', async () => {
        const { appClient, access, scope } = setup();
        appClient.teamRepoLists.set('core', [{ owner: 'acme', name: 'api' }]);
        appClient.teamMembers.add('core/octocat');
        await scope.refreshUser('user-1', 'octocat');

        appClient.fail = new Error('GitHub is down');
        await expect(scope.refreshUser('user-1', 'octocat')).rejects.toThrow('GitHub is down');

        expect(await access.repos('user-1')).toEqual(['acme/api']);
    });

    it('reuses the org-wide team answers across users, but probes membership per user', async () => {
        const { appClient, scope } = setup();
        appClient.teamRepoLists.set('core', [{ owner: 'acme', name: 'api' }]);
        appClient.teamMembers.add('core/octocat');
        appClient.teamMembers.add('core/hubot');

        await scope.refreshUser('user-1', 'octocat');
        await scope.refreshUser('user-2', 'hubot');

        expect(appClient.calls.teams).toBe(1);
        expect(appClient.calls.teamRepos.get('core')).toBe(1);
        // Two members, two probes: whose membership it is can never be cached org-wide.
        expect(appClient.calls.memberships).toBe(2);
    });
});

describe('scopedNames', () => {
    it('answers null before the first computation, and the installed intersection after', async () => {
        const { appClient, scope } = setup();
        expect(await scope.scopedNames('user-1')).toBeNull();

        appClient.teamRepoLists.set('core', [{ owner: 'acme', name: 'api' }]);
        appClient.teamMembers.add('core/octocat');
        await scope.refreshUser('user-1', 'octocat');

        expect(await scope.scopedNames('user-1')).toEqual(['acme/api']);
    });

    it('drops a stored repo the installation no longer reports, without waiting for a refresh', async () => {
        const { appClient, scope } = setup();
        appClient.teamRepoLists.set('core', [
            { owner: 'acme', name: 'api' },
            { owner: 'acme', name: 'web' },
        ]);
        appClient.teamMembers.add('core/octocat');
        await scope.refreshUser('user-1', 'octocat');

        // The App was pulled from acme/web — the intersection shrinks on the next read.
        const shrunken = staticRepoSource([{ owner: 'acme', name: 'api' }]);
        const narrow = createRepoAccessScope({
            appClient,
            repos: shrunken,
            org: ORG,
            access: { setRepos: async () => {}, repos: async () => ['acme/api', 'acme/web'] },
        });
        expect(await narrow.scopedNames('user-1')).toEqual(['acme/api']);
    });
});

describe('roster', () => {
    it('maps the org roster onto roles, lowercased', async () => {
        const { appClient, scope } = setup();
        appClient.members.add('OctoCat');
        appClient.members.add('hubot');
        appClient.admins.add('HUBOT');

        expect(await scope.roster()).toEqual(
            new Map([
                ['octocat', 'member'],
                ['hubot', 'admin'],
            ])
        );
    });
});

describe('refreshUser against a live repo source', () => {
    it('warms a cold installation cache instead of intersecting against an empty list', async () => {
        const listing = {
            repos: [{ owner: 'acme', name: 'api', private: false, defaultBranch: 'main', pushedAt: null }],
            installation: null,
        };
        const base = { listRepositories: async () => listing };
        const appClient = stubAppClient(base);
        appClient.collaborations.add('acme/api/octocat');
        const access = memoryUserRepoAccessStore();
        const repos = createRepoSource({ client: base });
        const scope = createRepoAccessScope({ appClient, repos, org: ORG, access });

        // staticRepoSource pre-warms; createRepoSource does not — the scope must list() first.
        await scope.refreshUser('user-1', 'octocat');

        expect(await access.repos('user-1')).toEqual(['acme/api']);
    });
});
