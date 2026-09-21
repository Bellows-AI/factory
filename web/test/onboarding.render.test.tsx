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
import { OnboardingPage, StartAgainPanel } from '../src/pages/OnboardingPage.js';

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
        const html = renderToStaticMarkup(<OnboardingPage payload={stale} listings={{ 999999: LISTING }} />);
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
        expect(buildCompletionPayload([INSTALLATIONS[1]!], new Set(['999999']), new Map([['999999', widened]])).repos[
            '999999'
        ]).toEqual([]);
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
        expect(buildCompletionPayload(INSTALLATIONS, new Set(['888888']), new Map([
            ['888888', one(INSTALLATIONS[0]!)],
            ['999999', widened],
        ]))).toEqual({ orgs: ['888888'], repos: {} });
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
        const readyEmpty = withChosen(one({ id: '999999', account: 'acme', tracked: ['acme/web'] }, LISTING), 'acme/web');
        expect(readyEmpty.chosen.size).toBe(0);
        expect(firstInvalidOrg(INSTALLATIONS, new Set(['888888', '999999']), new Map([
            ['888888', one(INSTALLATIONS[0]!)],
            ['999999', readyEmpty],
        ]))).toBe('999999');
        // Unselected: the group is invisible to validation.
        expect(firstInvalidOrg(INSTALLATIONS, new Set(['888888']), new Map([
            ['888888', one(INSTALLATIONS[0]!)],
            ['999999', readyEmpty],
        ]))).toBeNull();
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
        const unavailable = one({ id: '888888', account: 'other-org', tracked: ['a/b'] }, { repos: [], source: 'none' });
        expect(summaryRows([INSTALLATIONS[0]!], new Set(['888888']), new Map([['888888', unavailable]]), null)[0]!
            .label).toBe('Specific repositories (not reviewable right now)');
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
