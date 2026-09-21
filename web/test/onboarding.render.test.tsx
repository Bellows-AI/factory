import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '../src/theme.js';
import {
    OnboardingPage,
    StartAgainPanel,
    reconciled,
    standingRepos,
    type PendingSignInPayload,
    type RepoListing,
} from '../src/pages/OnboardingPage.js';

const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/** The page carries the appearance control (issue 188), so every render rides the provider. */
const renderPage = (props: { payload?: PendingSignInPayload; listings?: Record<string, RepoListing | 'loading'> }) =>
    renderToStaticMarkup(
        <ThemeProvider>
            <OnboardingPage {...props} />
        </ThemeProvider>
    );

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
        const html = renderPage({ payload: pending });
        expect(html).toContain('The Octocat');
        expect(html).toContain('other-org');
        expect(html).toContain('acme');
        // Both arrive pre-checked: the default matches what sign-in did before the screen existed.
        expect(html.match(/checked=""/g)?.length).toBe(2);
        expect(html).toContain('Continue');
    });

    it('says the choice is pre-checked on a reselect, and marks the asked-for org', () => {
        const html = renderPage({ payload: { ...pending, selected: ['999999'], reselect: true, org: '999999' } });
        expect(html).toContain('pre-checked');
        expect(html).toContain('(asked for)');
        // Only the stored choice arrives checked.
        expect(html.match(/checked=""/g)?.length).toBe(1);
    });

    it('never emits a placeholder value for an absent display name', () => {
        const html = renderPage({ payload: { ...pending, identity: { ...pending.identity, displayName: null } } });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        expect(html).toContain('octocat');
    });

    it('renders the loading shell while the pending sign-in is being fetched, with no placeholder', () => {
        // No payload and no fetch under react-dom/server: the loading shell is all there is.
        const html = renderPage({});
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

describe('seeding from a stored narrowing (#135 review)', () => {
    const LISTING: RepoListing = { repos: ['acme/web', 'acme/other'], source: 'app' };
    // The payload reports the stored narrowing RAW — including names GitHub stopped reporting.
    const stale: PendingSignInPayload = {
        ...pending,
        installations: [{ id: '999999', account: 'acme', tracked: ['acme/gone', 'acme/web'] }],
        selected: ['999999'],
    };

    it('seeds the standing set from the narrowing intersected with the live listing', () => {
        // A stored name the listing cannot render must neither seed a checkbox nor ride into
        // the POST — the intersection is where the dead entries drop.
        expect(standingRepos(['acme/gone', 'acme/web'], LISTING)).toEqual(new Set(['acme/web']));
        // Fully stale: an untouched org stands at nothing, posts nothing, keeps its rows.
        expect(standingRepos(['acme/gone'], LISTING)).toEqual(new Set());
        // Track-everything stands at the whole listing.
        expect(standingRepos(null, LISTING)).toEqual(new Set(['acme/web', 'acme/other']));
    });

    it('renders a listed stored name checked, a listed unstored name unchecked, and no unlisted name', () => {
        const html = renderPage({ payload: stale, listings: { 999999: LISTING } });
        expect(html).toContain('acme/web');
        expect(html).toContain('acme/other');
        // The stale stored name has no checkbox anywhere — and no checkbox can carry it.
        expect(html).not.toContain('acme/gone');
        // The org (selected) plus its one surviving stored repo; 'acme/other' is listed but
        // unstored, so unchecked.
        expect(html.match(/checked=""/g)?.length).toBe(2);
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('reconciling a rejected submission (#135 review)', () => {
    // The listing the server validated against AFTER the checkboxes loaded: 'acme/gone' was
    // removed, 'acme/new' appeared. The submission that carried 'acme/gone' was refused with
    // UNKNOWN_REPO — the reconcile is what makes "try again" post something submittable instead
    // of the identical rejected body.
    const FRESH: RepoListing = { repos: ['acme/web', 'acme/new'], source: 'app' };

    it('drops the names the fresh listing no longer carries and keeps the rest', () => {
        expect(reconciled(new Set(['acme/web', 'acme/gone']), FRESH)).toEqual(new Set(['acme/web']));
        // Everything gone: the org stands at nothing — deselection territory, posts nothing.
        expect(reconciled(new Set(['acme/gone', 'acme/older']), FRESH)).toEqual(new Set());
    });

    it('seeds and reconcile share one intersection, so a retry cannot carry a stale name', () => {
        // The standing seed of the same org under the fresh listing — the reconciled touch set
        // and a fresh seed must agree, whichever the retry posts.
        expect(reconciled(new Set(['acme/gone', 'acme/web']), FRESH)).toEqual(
            standingRepos(['acme/gone', 'acme/web'], FRESH)
        );
    });
});
