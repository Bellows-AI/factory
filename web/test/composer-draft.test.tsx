import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import {
    type ComposerDraftInput,
    type ComposerDraftStore,
    ComposerDraftProvider,
    composerDraftReducer,
    draftOwner,
    ownedDraft,
    useComposerDraftStore,
} from '../src/composer-draft.js';

/**
 * The draft store's contract, pinned through its pure transitions: the web suite renders with
 * `react-dom/server` and runs no effects, so the reducer and the owner check are what carry the
 * behavior, and the provider is proven to publish them.
 */

const sessionFor = (orgId: string, userId: string): Session => ({
    authenticated: true,
    user: { id: userId, login: 'octocat', name: null, githubUserId: 4242, avatarUrl: null },
    role: 'member',
    membership: { invitedAt: null, claimedAt: null },
    account: { createdAt: null, lastLoginAt: null },
    organization: { id: orgId, name: orgId },
    organizations: [{ id: orgId, name: orgId }],
    workspacePath: null,
    mode: 'github',
});

const next: ComposerDraftInput = {
    draft: 'Fix the flaky test',
    executor: 'main',
    repo: 'acme/app',
    repoTouched: true,
    workflowRepo: 'acme/app',
    workflow: 'w1',
    storedParams: { workflowId: 'w1', values: { issue: '#12' } },
    paramTouched: { issue: true },
    defaultStepOverrides: {},
};

const OWNER = 'org-1:user-1';

describe('composer draft store', () => {
    it('derives the owner from the organization and the user', () => {
        expect(draftOwner(sessionFor('org-1', 'user-1'))).toBe(OWNER);
        expect(draftOwner(null)).toBeNull();
    });

    it('stamps the owner on save', () => {
        expect(composerDraftReducer(null, { type: 'save', next, owner: OWNER })).toEqual({ ...next, owner: OWNER });
    });

    it('hands the draft back to its owner', () => {
        const stamped = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
        expect(ownedDraft(stamped, OWNER)).toBe(stamped);
    });

    it('returns null on an owner mismatch', () => {
        const stamped = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
        expect(ownedDraft(stamped, 'org-1:user-2')).toBeNull();
        expect(ownedDraft(stamped, 'org-2:user-1')).toBeNull();
        expect(ownedDraft(stamped, null)).toBeNull();
    });

    it('clears the draft', () => {
        const stamped = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
        expect(composerDraftReducer(stamped, { type: 'clear' })).toBeNull();
    });

    it('publishes an empty store from the provider', () => {
        let seen: ComposerDraftStore | null = null;
        function Probe() {
            seen = useComposerDraftStore();
            return null;
        }
        renderToStaticMarkup(
            <ComposerDraftProvider session={sessionFor('org-1', 'user-1')}>
                <Probe />
            </ComposerDraftProvider>
        );
        expect(seen).not.toBeNull();
        const store = seen as unknown as ComposerDraftStore;
        expect(store.state).toBeNull();
        expect(typeof store.save).toBe('function');
        expect(typeof store.clear).toBe('function');
    });

    it('refuses to be read outside the provider', () => {
        function Probe() {
            useComposerDraftStore();
            return null;
        }
        expect(() => renderToStaticMarkup(<Probe />)).toThrow(/ComposerDraftProvider/);
    });
});
