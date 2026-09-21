/**
 * The onboarding screen's pure core: the payload shapes the auth routes answer, and the
 * stateless transforms the screen renders and submits through. No React, no `fetch`, no
 * browser state — everything here is testable without a DOM and returns fresh objects
 * rather than mutating caller-owned sets or maps.
 */

/** What GET /api/auth/github/pending answers for a parked sign-in (issue 125). */
export interface PendingSignInPayload {
    identity: { login: string; displayName: string | null; avatarUrl: string | null };
    /**
     * One entry per reported installation. `tracked` is the org's stored repo allowlist — null
     * when it tracks everything — reported as stored, so a reselect SHOWS the narrowing it is
     * asking about. It may name repos the installation no longer reports: the screen intersects
     * with the live listing when seeding and before posting, so a name the listing cannot
     * render is never shown as a checkbox and never submitted.
     */
    installations: { id: string; account: string; tracked: string[] | null }[];
    /** The installation ids that arrive pre-checked: the stored choice on a reselect, all otherwise. */
    selected: string[];
    reselect: boolean;
    org: string | null;
    returnTo: string;
}

/** What GET /api/auth/github/pending/installations/:id/repos answers for one org. */
export interface RepoListing {
    repos: string[];
    source: 'app' | 'none';
}

/**
 * `chosen` narrowed to what the listing still carries — the one intersection the screen acts
 * through. Seeding uses it (a stored name the listing cannot render must neither display nor
 * ride into the POST) and so does the UNKNOWN_REPO recovery: the submission was refused because
 * the installation's listing changed under the loaded checkboxes, and this is what makes the
 * retry post only names that still exist instead of the identical rejected body.
 */
export const reconciled = (chosen: ReadonlySet<string>, listing: RepoListing): Set<string> =>
    new Set([...chosen].filter((name) => listing.repos.includes(name)));

/**
 * The org's standing checked set under a listing: its stored narrowing intersected with the
 * live names — or the whole listing when the org tracks everything. The one seed the
 * checkboxes display, a first touch expands, and the submit posts, so the three cannot
 * drift apart.
 */
export const standingRepos = (tracked: string[] | null, listing: RepoListing): Set<string> =>
    tracked === null ? new Set(listing.repos) : reconciled(new Set(tracked), listing);

/** How one organization's repositories are tracked. The mode is a person's explicit choice —
 * never inferred from how many checkboxes happen to read checked (issue 187). */
export type RepoMode = 'all' | 'specific';

/**
 * One organization's repository read, as a small state machine. `idle` means nobody has asked
 * for the listing yet; `ready` is a `source: 'app'` answer; `unavailable` is `source: 'none'`
 * — the installation reports no repository list; `failed` is a refused or dead fetch, which
 * keeps the whole draft and offers a local Retry.
 */
export type ListingState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ready'; repos: string[] }
    | { kind: 'unavailable' }
    | { kind: 'failed' };

/** One organization's in-memory draft: mode, specific-mode choice, listing state, and whether
 * the person actively widened to all (the only move that posts an empty list). */
export interface OrgDraft {
    /** The stored narrowing as the payload reported it — raw, so the draft can show what would change. */
    readonly tracked: string[] | null;
    readonly mode: RepoMode;
    readonly chosen: ReadonlySet<string>;
    readonly listing: ListingState;
    readonly widenedToAll: boolean;
}

/**
 * The screen's per-org drafts, one entry per reported installation. Mode derives from the
 * stored narrowing alone — `tracked: null` is all mode, an array is specific — and the
 * pre-checked `selected` ids do not touch it: which orgs are chosen and how each tracks are
 * two independent decisions. A listing that is already in hand (the render-test seam, or a
 * listing carried across a re-render) seeds the intersection immediately; one still missing
 * leaves the draft at `idle`.
 */
export const initialDrafts = (
    installations: ReadonlyArray<{ id: string; tracked: string[] | null }>,
    listings?: Record<string, RepoListing | 'loading'>
): Map<string, OrgDraft> => {
    const drafts = new Map<string, OrgDraft>();
    for (const installation of installations) {
        let draft: OrgDraft = {
            tracked: installation.tracked,
            mode: installation.tracked === null ? 'all' : 'specific',
            chosen: new Set(installation.tracked ?? []),
            listing: { kind: 'idle' },
            widenedToAll: false,
        };
        const seam = listings?.[installation.id];
        if (seam === 'loading') draft = { ...draft, listing: { kind: 'loading' } };
        else if (seam) draft = withListing(draft, seam);
        drafts.set(installation.id, draft);
    }
    return drafts;
};

/**
 * A listing landing on a draft. A `source: 'none'` answer is not an empty list — it is no
 * readable list at all, so the draft goes to `unavailable` with its choice preserved (a stored
 * specific selection survives, not reviewable, never widened). A ready list intersects a
 * specific choice with the live names — a stored name the listing cannot render neither
 * displays nor rides into the POST — while all mode has no choice to intersect and simply
 * carries the names for the checklist ahead.
 */
export const withListing = (draft: OrgDraft, listing: RepoListing): OrgDraft =>
    listing.source === 'none'
        ? { ...draft, listing: { kind: 'unavailable' } }
        : {
              ...draft,
              listing: { kind: 'ready', repos: listing.repos },
              chosen: draft.mode === 'specific' ? reconciled(draft.chosen, listing) : new Set<string>(),
          };

/** A refused or dead listing fetch: the draft stands untouched, the row offers a local Retry. */
export const withFailedListing = (draft: OrgDraft): OrgDraft => ({ ...draft, listing: { kind: 'failed' } });

/**
 * An explicit mode choice. Choosing all is the widening move — it posts an empty list, which
 * clears any stored narrowing. Choosing specific seeds the choice from the org's standing
 * set (its stored narrowing intersected with a ready listing) so the checklist opens showing
 * what the org already tracks; with no readable listing it seeds the raw stored narrowing,
 * preserved but not reviewable.
 */
export const withMode = (draft: OrgDraft, mode: RepoMode): OrgDraft => {
    if (mode === draft.mode) return draft;
    if (mode === 'all') return { ...draft, mode, chosen: new Set<string>(), widenedToAll: true };
    const listing = draft.listing;
    const chosen =
        listing.kind === 'ready'
            ? standingRepos(draft.tracked, { repos: listing.repos, source: 'app' })
            : new Set(draft.tracked ?? []);
    return { ...draft, mode, chosen, widenedToAll: false };
};

/** One repository checkbox in specific mode: toggle a name in the draft's choice. */
export const withChosen = (draft: OrgDraft, repo: string): OrgDraft => {
    const chosen = new Set(draft.chosen);
    if (chosen.has(repo)) chosen.delete(repo);
    else chosen.add(repo);
    return { ...draft, chosen };
};

/** Re-narrow an already-touched choice to a listing's live names — the UNKNOWN_REPO recovery. */
export const withReconciled = (draft: OrgDraft): OrgDraft =>
    draft.listing.kind === 'ready'
        ? { ...draft, chosen: reconciled(draft.chosen, { repos: draft.listing.repos, source: 'app' }) }
        : draft;

/** Whether the org's listing still has to be fetched — asked on details-open and mode-switch. */
export const needsListing = (draft: OrgDraft): boolean => draft.listing.kind === 'idle';

/** Exactly what POST /api/auth/github/complete receives. */
export interface CompletionPayload {
    orgs: string[];
    repos: Record<string, string[]>;
}

/**
 * The submission, built rule for rule from the issue's state table. A deselected org rides
 * nowhere; an untouched all mode omits its key (tracking everything is the absence of a
 * narrowing); the explicit widening posts `[]`; a ready specific group posts its non-empty
 * names — all-checked-in-specific included, which is why the mode is explicit — and a group
 * whose listing could not be read omits its key too, preserving the stored narrowing rather
 * than silently widening it because a read failed.
 */
export const buildCompletionPayload = (
    installations: ReadonlyArray<{ id: string }>,
    selected: ReadonlySet<string>,
    drafts: ReadonlyMap<string, OrgDraft>
): CompletionPayload => {
    const orgs: string[] = [];
    const repos: Record<string, string[]> = {};
    for (const installation of installations) {
        if (!selected.has(installation.id)) continue;
        const draft = drafts.get(installation.id);
        if (!draft) continue;
        orgs.push(installation.id);
        if (draft.mode === 'all') {
            if (draft.widenedToAll) repos[installation.id] = [];
        } else if (draft.listing.kind === 'ready' && draft.chosen.size > 0) {
            repos[installation.id] = [...draft.chosen];
        }
    }
    return { orgs, repos };
};

/**
 * The first — in payload order — selected org standing at a specific choice of nothing with
 * its listing in hand. That is the only blocking emptiness: a group whose listing never
 * loaded is preserved-not-reviewable, and validation has nothing to say about it.
 */
export const firstInvalidOrg = (
    installations: ReadonlyArray<{ id: string }>,
    selected: ReadonlySet<string>,
    drafts: ReadonlyMap<string, OrgDraft>
): string | null => {
    for (const installation of installations) {
        if (!selected.has(installation.id)) continue;
        const draft = drafts.get(installation.id);
        if (draft?.mode === 'specific' && draft.listing.kind === 'ready' && draft.chosen.size === 0)
            return installation.id;
    }
    return null;
};

/** One line of the final "Your selection" summary. */
export interface SummaryRow {
    id: string;
    account: string;
    label: string;
    active: boolean;
}

/**
 * The summary's rows: one per selected org, payload order, naming its mode — "All current and
 * future repositories", "N specific repositories", or the not-reviewable mark for a specific
 * choice under no readable listing. The active org is the requested one when it is selected,
 * otherwise the first selected org; nothing selected means nothing to summarize.
 */
export const summaryRows = (
    installations: ReadonlyArray<{ id: string; account: string }>,
    selected: ReadonlySet<string>,
    drafts: ReadonlyMap<string, OrgDraft>,
    requestedOrgId: string | null
): SummaryRow[] => {
    const rows: SummaryRow[] = [];
    for (const installation of installations) {
        if (!selected.has(installation.id)) continue;
        const draft = drafts.get(installation.id);
        if (!draft) continue;
        const label =
            draft.mode === 'all'
                ? 'All current and future repositories'
                : draft.listing.kind === 'ready'
                  ? `${draft.chosen.size} specific ${draft.chosen.size === 1 ? 'repository' : 'repositories'}`
                  : 'Specific repositories (not reviewable right now)';
        rows.push({ id: installation.id, account: installation.account, label, active: false });
    }
    const active = rows.find((row) => row.id === requestedOrgId) ?? rows[0];
    if (active) rows[rows.indexOf(active)]!.active = true;
    return rows;
};

/** How the screen names the signed-in person — display name plus login, or the login alone —
 * and the initial its avatar fallback shows. No email, no numeric id, no token. */
export interface IdentityView {
    name: string;
    initial: string;
    avatarUrl: string | null;
}

export const identityView = (identity: PendingSignInPayload['identity']): IdentityView => {
    const name = identity.displayName ? `${identity.displayName} (@${identity.login})` : identity.login;
    return {
        name,
        initial: (identity.displayName ?? identity.login).charAt(0).toUpperCase(),
        avatarUrl: identity.avatarUrl,
    };
};
