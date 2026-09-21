import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    buildCompletionPayload,
    firstInvalidOrg,
    identityView,
    initialDrafts,
    needsListing,
    reconciled,
    standingRepos,
    summaryRows,
    withChosen,
    withFailedListing,
    withListing,
    withMode,
    withReconciled,
    type PendingSignInPayload,
    type RepoListing,
} from '../src/onboarding.js';
import { ThemeProvider } from '../src/theme.js';
import { OnboardingPage, StartAgainPanel } from '../src/pages/OnboardingPage.js';

/**
 * The page carries the appearance control (issue 188) in the public header's actions cell, and
 * the selector reads the theme context — so every page render rides the provider.
 */
const renderPage = (props: { payload?: PendingSignInPayload; listings?: Record<string, RepoListing | 'loading'> }) =>
    renderToStaticMarkup(
        <ThemeProvider>
            <OnboardingPage {...props} />
        </ThemeProvider>
    );

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

/** Checked org checkboxes — org selection is a checkbox; mode choices are radios, counted apart. */
const checkedBoxes = (html: string) => html.match(/type="checkbox"[^>]*checked=""/g)?.length ?? 0;
const checkedRadios = (html: string) => html.match(/type="radio"[^>]*checked=""/g)?.length ?? 0;

describe('OnboardingPage', () => {
    it('renders the setup decision: brand, context, one h1, purpose, identity, and the orgs', () => {
        const html = renderPage({ payload: pending });
        expect(html).toContain('public-brand');
        expect(html).toContain('Factory');
        expect(html).toContain('Setup · One step');
        // Exactly one h1 in the loaded state, and it is the pinned one.
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('Choose organizations and repositories');
        expect(html).toContain('Track agent activity, start work, and keep repository setup visible in one place.');
        expect(html).toContain('The Octocat (@octocat)');
        expect(html).toContain('other-org');
        expect(html).toContain('acme');
        // Both arrive pre-checked: the default matches what sign-in did before the screen existed.
        expect(checkedBoxes(html)).toBe(2);
        expect(html).toContain('Continue');
    });

    it('marks the requested organization and renders the reselect context line', () => {
        const html = renderPage({ payload: { ...pending, selected: ['999999'], reselect: true, org: '999999' } });
        expect(html).toContain('Requested for this sign-in');
        expect(html).toContain(
            'This replaces which organizations you enter Factory with. Repository modes change only where shown above.'
        );
        // Only the stored choice arrives checked.
        expect(checkedBoxes(html)).toBe(1);
    });

    it('never emits a placeholder value for an absent display name', () => {
        const html = renderPage({ payload: { ...pending, identity: { ...pending.identity, displayName: null } } });
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        expect(html).toContain('octocat');
    });

    it('renders the loading shell while the pending sign-in is being fetched', () => {
        // No payload and no fetch under react-dom/server: the loading shell is all there is.
        const html = renderPage({});
        expect(html).toContain('Choose organizations and repositories');
        expect(html).toContain('onboarding-loading');
        // A placeholder enables no action and invents no rows.
        expect(html).not.toContain('Continue');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });
});

describe('OnboardingPage state recovery (issue 187)', () => {
    it('the expired state keeps the page shape and states that nothing was saved', () => {
        const html = renderToStaticMarkup(<StartAgainPanel returnTo="/settings" />);
        expect(html).toContain('That sign-in expired.');
        expect(html).toContain('Nothing was saved.');
        expect(html).toContain('href="/api/auth/github?returnTo=%2Fsettings"');
    });

    it('the restart link falls back to the root when no return path survived', () => {
        const html = renderToStaticMarkup(<StartAgainPanel />);
        expect(html).toContain('href="/api/auth/github?returnTo=%2F"');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('a defensive zero-installation payload explains itself and offers Start again', () => {
        const html = renderPage({ payload: { ...pending, installations: [], selected: [] } });
        expect(html).toContain('No GitHub App installation');
        expect(html).toContain('Start again');
        expect(html).toContain('href="/api/auth/github?returnTo=%2F"');
        expect(html).not.toContain('Continue');
    });
});

describe('OnboardingPage explicit repository mode (issue 187)', () => {
    it('renders the mode radios with their pinned helpers inside every selected organization', () => {
        const html = renderPage({ payload: pending });
        expect(html).toContain('Repository tracking');
        expect(html).toContain('All current and future repositories');
        expect(html).toContain('Automatically include repositories this GitHub App installation reports later.');
        expect(html).toContain('Choose specific repositories');
        expect(html).toContain(
            'Only the repositories selected below are tracked; new repositories are not added automatically.'
        );
        // Two selected orgs, each arriving all-mode: the all radio is the checked one.
        expect(checkedRadios(html)).toBe(2);
    });

    it('a deselected organization reveals no mode radios', () => {
        const html = renderPage({ payload: { ...pending, selected: ['999999'], org: '999999' } });
        expect(checkedRadios(html)).toBe(1);
        expect(html.match(/type="radio"/g)?.length).toBe(2);
    });

    it('carries no installation id in the markup and never renders a form', () => {
        const html = renderPage({ payload: pending });
        expect(html).not.toContain('888888');
        expect(html).not.toContain('999999');
        expect(html).not.toContain('<form');
    });

    it('renders the access note and the selection summary between the orgs and the action', () => {
        const html = renderPage({ payload: pending });
        // DOM order: access note before summary before the action region.
        const note = html.indexOf('GitHub sign-in provides your identity and organization membership.');
        const summary = html.indexOf('Your selection');
        const action = html.indexOf('onboarding-actions');
        expect(note).toBeGreaterThan(-1);
        expect(summary).toBeGreaterThan(note);
        expect(action).toBeGreaterThan(summary);
        expect(html).toContain('This choice changes what Factory tracks, not your GitHub permissions.');
        // Every org is accounted for, by name and mode, and the requested org is the active one.
        expect(html).toContain('2 organizations selected');
        expect(html).toContain('All current and future repositories');
    });

    it('the zero-organizations state disables Continue with its visible reason', () => {
        const html = renderPage({ payload: { ...pending, selected: [] } });
        expect(html).toContain('Choose at least one organization to continue.');
        expect(html).toContain('aria-disabled="true"');
        expect(html).toContain('Continue');
    });

    it('the ready state enables Continue and the summary names the exact payload', () => {
        const html = renderPage({ payload: pending });
        expect(html).not.toContain('aria-disabled="true"');
        expect(html).toContain('Continue');
    });
});

describe('OnboardingPage listings (issue 187)', () => {
    const LISTING: RepoListing = { repos: ['acme/web', 'acme/other'], source: 'app' };

    it('seeds a stored narrowing intersected with the live listing, specific and counted', () => {
        const stale: PendingSignInPayload = {
            ...pending,
            installations: [{ id: '999999', account: 'acme', tracked: ['acme/gone', 'acme/web'] }],
            selected: ['999999'],
        };
        const html = renderPage({ payload: stale, listings: { 999999: LISTING } });
        expect(html).toContain('acme/web');
        expect(html).toContain('acme/other');
        // The stale stored name has no checkbox anywhere — and no checkbox can carry it.
        expect(html).not.toContain('acme/gone');
        // The org (selected) plus its one surviving stored repo arrive checked; the specific
        // radio is the org's checked mode choice.
        expect(checkedBoxes(html)).toBe(2);
        expect(checkedRadios(html)).toBe(1);
        expect(html).toContain('1 of 2 repositories selected');
        expect(html).toContain('1 specific repository');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('a fully-stale specific selection stands at nothing and says what to do about it', () => {
        const stale: PendingSignInPayload = {
            ...pending,
            installations: [{ id: '999999', account: 'acme', tracked: ['acme/gone'] }],
            selected: ['999999'],
        };
        const html = renderPage({ payload: stale, listings: { 999999: LISTING } });
        expect(html).not.toContain('acme/gone');
        expect(html).toContain('Select at least one repository, switch to all repositories, or deselect');
        expect(html).toContain('aria-disabled="true"');
    });

    it('an unavailable listing never renders an empty checklist, in either mode', () => {
        const NONE: RepoListing = { repos: [], source: 'none' };
        const html = renderPage({
            payload: {
                ...pending,
                installations: [
                    { id: '888888', account: 'other-org', tracked: null },
                    { id: '999999', account: 'acme', tracked: ['acme/web'] },
                ],
                selected: ['888888', '999999'],
            },
            listings: { 888888: NONE, 999999: NONE },
        });
        expect(html).toContain(
            'Repository choices are temporarily unavailable. Factory will track repositories this installation reports.'
        );
        expect(html).toContain(
            'Your existing specific selection is preserved, but it cannot be reviewed right now. Try again before changing repository scope.'
        );
        expect(html.match(/type="checkbox"/g)?.length).toBe(2); // org checkboxes only
        expect(html).toContain('Retry');
        // Nothing reviewable → nothing invalid: the payload still completes.
        expect(html).not.toContain('aria-disabled="true"');
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
        expect(checkedBoxes(html)).toBe(2);
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

describe('explicit repository mode (issue 187)', () => {
    const LISTING: RepoListing = { repos: ['acme/web', 'acme/other'], source: 'app' };
    const INSTALLATIONS = [
        { id: '888888', account: 'other-org', tracked: null },
        { id: '999999', account: 'acme', tracked: ['acme/gone', 'acme/web'] },
    ];
    const one = (installation: { id: string; account: string; tracked: string[] | null }, listing?: RepoListing) =>
        initialDrafts([installation], listing ? { [installation.id]: listing } : undefined).get(installation.id)!;

    it('null tracking initializes all mode; a stored array initializes specific with its raw set', () => {
        const all = one({ id: '888888', account: 'other-org', tracked: null });
        expect(all.mode).toBe('all');
        expect(all.chosen.size).toBe(0);
        expect(all.listing).toEqual({ kind: 'idle' });
        expect(all.widenedToAll).toBe(false);
        expect(needsListing(all)).toBe(true);
        // Raw, not intersected: the stale stored name still rides in the draft until a listing
        // arrives to drop it.
        const specific = one(INSTALLATIONS[1]!);
        expect(specific.mode).toBe('specific');
        expect(specific.chosen).toEqual(new Set(['acme/gone', 'acme/web']));
    });

    it('a stored specific selection intersects with the live listing once it arrives', () => {
        const seeded = one(INSTALLATIONS[1]!, LISTING);
        expect(seeded.listing).toEqual({ kind: 'ready', repos: [...LISTING.repos] });
        expect(seeded.chosen).toEqual(new Set(['acme/web']));
        expect(needsListing(seeded)).toBe(false);
        // The listings seam can also carry an in-flight fetch or an unavailable read.
        expect(one({ id: '9', account: 'a', tracked: null }, undefined).listing).toEqual({ kind: 'idle' });
        expect(one({ id: '9', account: 'a', tracked: null }, { repos: [], source: 'none' }).listing).toEqual({
            kind: 'unavailable',
        });
    });

    it('an explicit all choice sends [] and clears a prior narrowing; an untouched all state omits the key', () => {
        // Widening: the stored narrowing arrives specific, the person explicitly chooses all.
        const widened = withMode(one({ id: '999999', account: 'acme', tracked: ['acme/web'] }, LISTING), 'all');
        expect(widened.widenedToAll).toBe(true);
        expect(
            buildCompletionPayload([INSTALLATIONS[1]!], new Set(['999999']), new Map([['999999', widened]])).repos[
                '999999'
            ]
        ).toEqual([]);
        // Untouched all mode: no key — "track everything, future included" is the absence of a
        // narrowing, not today's list pinned as one.
        const fresh = one({ id: '888888', account: 'other-org', tracked: null });
        expect(
            buildCompletionPayload([INSTALLATIONS[0]!], new Set(['888888']), new Map([['888888', fresh]])).repos
        ).toEqual({});
    });

    it('all checked in specific stays specific — the full name list is sent, never []', () => {
        // Tombstone for the deleted implicit heuristic: a specific draft whose chosen set covers
        // every listed repo is still specific, and future repositories stay excluded.
        let draft = one({ id: '999999', account: 'acme', tracked: ['acme/web', 'acme/other'] }, LISTING);
        draft = withChosen(withChosen(draft, 'acme/other'), 'acme/other');
        expect(draft.mode).toBe('specific');
        const sent = buildCompletionPayload([INSTALLATIONS[1]!], new Set(['999999']), new Map([['999999', draft]]))
            .repos['999999'];
        expect(sent).toHaveLength(2);
        expect(new Set(sent)).toEqual(new Set(['acme/web', 'acme/other']));
    });

    it('a ready specific group sends its non-empty selected names', () => {
        const draft = one({ id: '999999', account: 'acme', tracked: null }, LISTING);
        const specific = withMode(draft, 'specific');
        // Switching to specific seeds the standing set — track-everything checked, ready to narrow.
        expect(specific.chosen).toEqual(new Set(['acme/web', 'acme/other']));
        const narrowed = withChosen(specific, 'acme/other');
        expect(
            buildCompletionPayload([INSTALLATIONS[1]!], new Set(['999999']), new Map([['999999', narrowed]])).repos[
                '999999'
            ]
        ).toEqual(['acme/web']);
    });

    it('a specific choice made before the listing resolves seeds the standing set when it lands', () => {
        // The radios are visible while the listing is in flight. Choosing specific then must land
        // in the same place as choosing it after — the standing set — not in an empty checklist
        // that reads as "track nothing" (#197 review).
        const early = withMode(one({ id: '999999', account: 'acme', tracked: null }), 'specific');
        expect(early.chosen.size).toBe(0);
        const landed = withListing(early, LISTING);
        expect(landed.mode).toBe('specific');
        expect(landed.chosen).toEqual(new Set(['acme/web', 'acme/other']));
        // A touch makes the choice the person's own: a later listing narrows it, never reseeds it.
        const touched = withChosen(early, 'acme/web');
        expect(withListing(touched, LISTING).chosen).toEqual(new Set(['acme/web']));
    });

    it('an unavailable listing preserves a stored specific selection and never widens it', () => {
        const draft = one({ id: '999999', account: 'acme', tracked: ['acme/web'] }, { repos: [], source: 'none' });
        expect(draft.mode).toBe('specific');
        expect(draft.chosen).toEqual(new Set(['acme/web']));
        expect(
            buildCompletionPayload([INSTALLATIONS[1]!], new Set(['999999']), new Map([['999999', draft]])).repos
        ).toEqual({});
        // Same for an all-mode org whose listing cannot be read: all mode stands, no key.
        const all = one({ id: '888888', account: 'other-org', tracked: null }, { repos: [], source: 'none' });
        expect(all.mode).toBe('all');
        expect(
            buildCompletionPayload([INSTALLATIONS[0]!], new Set(['888888']), new Map([['888888', all]])).repos
        ).toEqual({});
    });

    it('a deselected organization contributes no org and no repo key, whatever its draft says', () => {
        const widened = withMode(one(INSTALLATIONS[1]!, LISTING), 'all');
        expect(
            buildCompletionPayload(
                INSTALLATIONS,
                new Set(['888888']),
                new Map([
                    ['888888', one(INSTALLATIONS[0]!)],
                    ['999999', widened],
                ])
            )
        ).toEqual({ orgs: ['888888'], repos: {} });
    });

    it('a failed listing keeps the draft and posts no key', () => {
        const failed = withFailedListing(one({ id: '999999', account: 'acme', tracked: ['acme/web'] }, LISTING));
        expect(failed.listing).toEqual({ kind: 'failed' });
        expect(failed.mode).toBe('specific');
        expect(failed.chosen).toEqual(new Set(['acme/web']));
        expect(
            buildCompletionPayload([INSTALLATIONS[1]!], new Set(['999999']), new Map([['999999', failed]])).repos
        ).toEqual({});
    });

    it('reconciliation on a refreshed listing drops stale names but never the mode', () => {
        const FRESH: RepoListing = { repos: ['acme/web', 'acme/new'], source: 'app' };
        const draft = withListing(one(INSTALLATIONS[1]!), FRESH);
        expect(draft.mode).toBe('specific');
        expect(draft.chosen).toEqual(new Set(['acme/web']));
        // And an explicit re-reconcile of an already-reconciled draft is idempotent.
        expect(withReconciled(draft).chosen).toEqual(new Set(['acme/web']));
    });

    it('the first invalid group is a selected, ready, zero-chosen specific org — nothing else', () => {
        const readyEmpty = withChosen(
            one({ id: '999999', account: 'acme', tracked: ['acme/web'] }, LISTING),
            'acme/web'
        );
        expect(readyEmpty.chosen.size).toBe(0);
        expect(
            firstInvalidOrg(
                INSTALLATIONS,
                new Set(['888888', '999999']),
                new Map([
                    ['888888', one(INSTALLATIONS[0]!)],
                    ['999999', readyEmpty],
                ])
            )
        ).toBe('999999');
        // Unselected: the group is invisible to validation.
        expect(
            firstInvalidOrg(
                INSTALLATIONS,
                new Set(['888888']),
                new Map([
                    ['888888', one(INSTALLATIONS[0]!)],
                    ['999999', readyEmpty],
                ])
            )
        ).toBeNull();
        // Preserved-not-reviewable: a specific group without a listing is never "empty".
        const idleEmpty = one({ id: '999999', account: 'acme', tracked: [] });
        expect(idleEmpty.chosen.size).toBe(0);
        expect(firstInvalidOrg(INSTALLATIONS, new Set(['999999']), new Map([['999999', idleEmpty]]))).toBeNull();
    });

    it('summary rows name each selected org, its mode, and the active organization', () => {
        const drafts = new Map([
            ['888888', one(INSTALLATIONS[0]!)],
            ['999999', one(INSTALLATIONS[1]!, LISTING)],
        ]);
        // The requested org is selected: it is the one the person enters Factory through.
        expect(summaryRows(INSTALLATIONS, new Set(['888888', '999999']), drafts, '888888')).toEqual([
            { id: '888888', account: 'other-org', label: 'All current and future repositories', active: true },
            { id: '999999', account: 'acme', label: '1 specific repository', active: false },
        ]);
        // The requested org is NOT among the selected: the first selected row stands in.
        expect(summaryRows(INSTALLATIONS, new Set(['999999']), drafts, '888888')).toEqual([
            { id: '999999', account: 'acme', label: '1 specific repository', active: true },
        ]);
        // Singular/plural and the not-reviewable label.
        const two = withChosen(one(INSTALLATIONS[1]!, LISTING), 'acme/other');
        expect(summaryRows(INSTALLATIONS, new Set(['999999']), new Map([['999999', two]]), null)[0]!.label).toBe(
            '2 specific repositories'
        );
        const unavailable = one(
            { id: '888888', account: 'other-org', tracked: ['a/b'] },
            { repos: [], source: 'none' }
        );
        expect(
            summaryRows([INSTALLATIONS[0]!], new Set(['888888']), new Map([['888888', unavailable]]), null)[0]!.label
        ).toBe('Specific repositories (not reviewable right now)');
        // Nothing selected: no rows at all.
        expect(summaryRows(INSTALLATIONS, new Set(), drafts, null)).toEqual([]);
    });

    it('the identity view names the person without any internal identifier', () => {
        expect(identityView({ login: 'octocat', displayName: 'The Octocat', avatarUrl: null })).toEqual({
            name: 'The Octocat (@octocat)',
            initial: 'T',
            avatarUrl: null,
        });
        expect(identityView({ login: 'octocat', displayName: null, avatarUrl: 'https://example/x.png' })).toEqual({
            name: 'octocat',
            initial: 'O',
            avatarUrl: 'https://example/x.png',
        });
    });
});
