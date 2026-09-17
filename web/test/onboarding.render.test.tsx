import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnboardingPage, StartAgainPanel, type PendingSignInPayload } from '../src/pages/OnboardingPage.js';

const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const pending: PendingSignInPayload = {
    identity: { login: 'octocat', displayName: 'The Octocat', avatarUrl: null },
    installations: [
        { id: '888888', account: 'other-org', tracked: null },
        { id: '999999', account: 'acme', tracked: null },
    ],
    selected: ['888888', '999999'],
    reselect: false,
    org: null,
    returnTo: '/',
};

describe('OnboardingPage', () => {
    it('renders one pre-checked checkbox per reported installation, and the continue button', () => {
        const html = renderToStaticMarkup(<OnboardingPage payload={pending} />);
        expect(html).toContain('The Octocat');
        expect(html).toContain('other-org');
        expect(html).toContain('acme');
        // Both arrive pre-checked: the default matches what sign-in did before the screen existed.
        expect(html.match(/checked=""/g)?.length).toBe(2);
        expect(html).toContain('Continue');
    });

    it('says the choice is pre-checked on a reselect, and marks the asked-for org', () => {
        const html = renderToStaticMarkup(
            <OnboardingPage payload={{ ...pending, selected: ['999999'], reselect: true, org: '999999' }} />
        );
        expect(html).toContain('pre-checked');
        expect(html).toContain('(asked for)');
        // Only the stored choice arrives checked.
        expect(html.match(/checked=""/g)?.length).toBe(1);
    });

    it('never emits a placeholder value for an absent display name', () => {
        const html = renderToStaticMarkup(
            <OnboardingPage payload={{ ...pending, identity: { ...pending.identity, displayName: null } }} />
        );
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        expect(html).toContain('octocat');
    });

    it('renders the loading shell while the pending sign-in is being fetched, with no placeholder', () => {
        // No payload and no fetch under react-dom/server: the loading shell is all there is.
        const html = renderToStaticMarkup(<OnboardingPage />);
        expect(html).toContain('Choose what to track');
        expect(html).toContain('Loading…');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('StartAgainPanel', () => {
    it('offers the restart link, carrying the return path through the new round trip', () => {
        const html = renderToStaticMarkup(<StartAgainPanel returnTo="/settings" />);
        expect(html).toContain('That sign-in expired.');
        expect(html).toContain('href="/api/auth/github?returnTo=%2Fsettings"');
    });

    it('falls back to the root when no return path survived', () => {
        const html = renderToStaticMarkup(<StartAgainPanel />);
        expect(html).toContain('href="/api/auth/github?returnTo=%2F"');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});
