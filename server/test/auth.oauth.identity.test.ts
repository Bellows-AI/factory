import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { ORG, beginOnboarding, finishOnboarding, setup, signIn } from './auth.oauth-fixtures.js';

const HTTP_NO_CONTENT = 204;

describe('identity is the numeric id, not the login', () => {
    it('follows a rename: the same account keeps its membership under a new login', async () => {
        const { app, auth, identity } = await setup();

        await signIn(app);

        // Same GitHub account, new login: the membership row's label follows, the account does not
        // multiply.
        identity.next = { ...identity.next, login: 'octocat-renamed' };
        await signIn(app);

        expect(auth.sessions()).toHaveLength(2);
    });

    it('does NOT let a new account inherit a membership by taking the freed login', async () => {
        /*
         * A rename frees the login on GitHub's side. Under installation membership the boundary is
         * what the account can SEE, not a name it registered — a different numeric id is a
         * different account, whatever it calls itself, and gets its own sign-in.
         */
        const { app, auth, identity } = await setup();

        await signIn(app);
        expect(auth.sessions()).toHaveLength(1);

        // A DIFFERENT account registers the login the original left behind.
        identity.next = { githubUserId: 9999, login: 'octocat', displayName: 'Impostor', avatarUrl: null };
        await signIn(app);

        // Two accounts, two memberships, two sessions — nobody inherited anything.
        expect(auth.sessions()).toHaveLength(2);
    });
});

describe('membership follows what GitHub last reported', () => {
    it('drops a membership of an org no installation reports', async () => {
        // An org row can exist without an installation (the none-mode local row, a husk in an
        // upgraded database). No sign-in can ever report it, so the sweep — which matches any
        // unreported org, not only installation orgs — is what keeps it from sitting beside the
        // real memberships forever, listing the same account twice.
        const { app, auth } = await setup();
        const cookie = await signIn(app);
        const userId = (
            await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { [SESSION_COOKIE]: cookie } })
        ).json().user.id as string;
        auth.seedOrg('legacy-1', 'Legacy');
        auth.seedMembership('legacy-1', userId);

        await signIn(app);

        expect((await auth.membershipsOf(userId)).map((m) => m.id)).toEqual([ORG]);
    });

    it('drops a membership whose installation is no longer reported', async () => {
        // The security property, one sign-in late: losing access to an installation ends the
        // membership the next time that account signs in — and the session's read goes with it,
        // because findSession joins through the membership.
        const { app, auth, identity } = await setup({
            installations: [
                { id: ORG, account: 'acme' },
                { id: '888888', account: 'other-org' },
            ],
        });

        // The first sign-in goes through the selection step; both orgs are chosen.
        const pending = await beginOnboarding(app);
        const completion = await finishOnboarding(app, pending, { orgs: [ORG, '888888'] });
        const userId = (
            await app.inject({
                method: 'GET',
                url: '/api/auth/me',
                cookies: {
                    [SESSION_COOKIE]: completion.cookies.find((c) => c.name === SESSION_COOKIE)!.value,
                },
            })
        ).json().user.id as string;
        expect((await auth.membershipsOf(userId)).map((m) => m.id)).toEqual(expect.arrayContaining([ORG, '888888']));

        // The account can no longer see the first installation: the reduced answer rides the
        // one-shot queue, consumed by the next sign-in's installations call. The stored selection
        // intersects with the report — ORG is gone from both, so its membership is swept.
        identity.installationsQueue.push([{ id: '888888', account: 'other-org' }]);
        await signIn(app);

        expect((await auth.membershipsOf(userId)).map((m) => m.id)).toEqual(['888888']);
    });
});

describe('sessions end', () => {
    it('logs out, deleting the row and clearing the cookie', async () => {
        const { app, auth } = await setup();
        const cookie = await signIn(app);
        expect(auth.sessions()).toHaveLength(1);

        const response = await app.inject({
            method: 'POST',
            url: '/api/auth/logout',
            cookies: { [SESSION_COOKIE]: cookie },
        });

        expect(response.statusCode).toBe(HTTP_NO_CONTENT);
        expect(auth.sessions()).toEqual([]);
        expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    });

    it('answers 204 for somebody who was never signed in', async () => {
        // "Already signed out" is the desired end state, so reporting it as an error would hand the
        // client something it cannot act on.
        const { app } = await setup();
        const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });
        expect(response.statusCode).toBe(HTTP_NO_CONTENT);
    });
});
