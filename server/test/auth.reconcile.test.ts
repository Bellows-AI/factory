import { describe, expect, it } from 'vitest';
import type { Role } from '../src/auth/store.js';
import { planRosterSync, runRosterSync } from '../src/auth/reconcile.js';
import { memoryAuthStore } from './helpers.js';

const ORG = 'test-org';
/** Numeric GitHub ids for the plan fixtures — the identity the roster is keyed on. */
const IDS = { octocat: 4242, hubot: 4243, promoted: 4244, gone: 4245 };

const member = (login: keyof typeof IDS, role: Role) => ({
    login,
    role,
    userId: `00000000-0000-4000-8000-${String(IDS[login]).padStart(12, '0')}`,
    githubUserId: IDS[login],
});

describe('planRosterSync', () => {
    it('removes members the GitHub org no longer lists, by id', () => {
        const plan = planRosterSync(
            [member('gone', 'member'), member('octocat', 'member')],
            new Map([[IDS.octocat, { login: 'octocat', role: 'member' }]])
        );
        expect(plan.remove).toEqual([{ userId: member('gone', 'member').userId, login: 'gone' }]);
        expect(plan.setRole).toEqual([]);
    });

    it('re-roles a member whose org role changed, even if they renamed', () => {
        const plan = planRosterSync(
            [member('octocat', 'member')],
            new Map([[IDS.octocat, { login: 'octocat-renamed', role: 'admin' }]])
        );
        expect(plan.setRole).toEqual([{ userId: member('octocat', 'member').userId, login: 'octocat', role: 'admin' }]);
    });

    it('does nothing when the rosters already agree', () => {
        const members = [member('octocat', 'member'), member('hubot', 'admin')];
        const org = new Map([
            [IDS.octocat, { login: 'octocat', role: 'member' as const }],
            [IDS.hubot, { login: 'hubot', role: 'admin' as const }],
        ]);
        expect(planRosterSync(members, org)).toEqual({ remove: [], setRole: [] });
    });

    it('removes everyone when GitHub lists nobody — the org is the source of truth', () => {
        const plan = planRosterSync([member('octocat', 'member')], new Map());
        expect(plan.remove).toEqual([{ userId: member('octocat', 'member').userId, login: 'octocat' }]);
    });
});

describe('runRosterSync', () => {
    it('removes and re-roles only the rows auto-join created', async () => {
        const store = memoryAuthStore();
        const octocat = store.seedMember(ORG, 'octocat', 'member', true);
        store.seedMember(ORG, 'hubot', 'admin', true);
        store.seedMember(ORG, 'invited', 'admin'); // invite-born: GitHub is never consulted
        // The org lists octocat (promoted to admin) and the invited login — but only the
        // auto-joined row keyed by octocat's id is maintained.
        const org = new Map([
            [octocat.user.githubUserId, { login: 'octocat', role: 'admin' as const }],
            [911, { login: 'invited', role: 'member' as const }],
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

    it('matches on the numeric id, so a member who renamed is maintained, not removed', async () => {
        const store = memoryAuthStore();
        const renamed = store.seedMember(ORG, 'octocat', 'member', true);
        // GitHub still lists them — under the NEW login, same numeric id. The row's stored login
        // is the stale label; matching on it would remove a member who never left.
        const org = new Map([[renamed.user.githubUserId, { login: 'octocat-renamed', role: 'member' as const }]]);

        const result = await runRosterSync(store, ORG, org);

        expect(result.removed).toEqual([]);
        expect(result.roled).toEqual([]);
        expect(await store.listMembers(ORG)).toEqual([{ login: 'octocat', role: 'member', claimed: true }]);
    });

    it('re-roles a renamed member by id too', async () => {
        const store = memoryAuthStore();
        const promoted = store.seedMember(ORG, 'octocat', 'member', true);
        const org = new Map([[promoted.user.githubUserId, { login: 'octocat-renamed', role: 'admin' as const }]]);

        const result = await runRosterSync(store, ORG, org);

        expect(result.roled).toEqual(['octocat']);
        expect(await store.listMembers(ORG)).toEqual([{ login: 'octocat', role: 'admin', claimed: true }]);
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
