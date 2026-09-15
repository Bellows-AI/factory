import { describe, expect, it } from 'vitest';
import { planRosterSync, runRosterSync } from '../src/auth/reconcile.js';
import { memoryAuthStore } from './helpers.js';

const ORG = 'test-org';

describe('planRosterSync', () => {
    it('removes auto-joined logins the GitHub org no longer lists', () => {
        const plan = planRosterSync([{ login: 'gone', role: 'member' }], new Map([['kept', 'member']]));
        expect(plan).toEqual({ remove: ['gone'], setRole: [] });
    });

    it('re-roles an auto-joined login whose org role changed', () => {
        const plan = planRosterSync([{ login: 'promoted', role: 'member' }], new Map([['promoted', 'admin']]));
        expect(plan).toEqual({ remove: [], setRole: [{ login: 'promoted', role: 'admin' }] });
    });

    it('does nothing when the rosters already agree', () => {
        const members = [
            { login: 'octocat', role: 'member' as const },
            { login: 'hubot', role: 'admin' as const },
        ];
        const org = new Map([
            ['octocat', 'member' as const],
            ['hubot', 'admin' as const],
        ]);
        expect(planRosterSync(members, org)).toEqual({ remove: [], setRole: [] });
    });

    it('removes everyone when GitHub lists nobody — the org is the source of truth', () => {
        const plan = planRosterSync([{ login: 'octocat', role: 'member' }], new Map());
        expect(plan.remove).toEqual(['octocat']);
    });
});

describe('runRosterSync', () => {
    it('removes and re-roles only the rows auto-join created', async () => {
        const store = memoryAuthStore();
        store.seedMember(ORG, 'octocat', 'member', true);
        store.seedMember(ORG, 'hubot', 'admin', true);
        store.seedMember(ORG, 'invited', 'admin'); // invite-born: GitHub is never consulted
        const org = new Map([
            ['octocat', 'admin' as const],
            ['invited', 'member' as const],
        ]);

        const result = await runRosterSync(store, ORG, org);

        expect(result.removed).toEqual(['hubot']);
        expect(result.roled).toEqual(['octocat']);
        // The memory store keeps insertion order: octocat first, then the invited row.
        expect(await store.listMembers(ORG)).toEqual([
            { login: 'octocat', role: 'admin', claimed: true },
            { login: 'invited', role: 'admin', claimed: true },
        ]);
    });

    it("ends the removed member's sessions, through removeMember's own semantics", async () => {
        const store = memoryAuthStore();
        const caller = store.seedMember(ORG, 'octocat', 'member', true);
        await store.createSession(Buffer.alloc(32, 7), caller.user.id, new Date(Date.now() + 60_000));

        await runRosterSync(store, ORG, new Map());

        expect(store.sessions()).toEqual([]);
        expect(await store.listMembers(ORG)).toEqual([]);
    });
});
