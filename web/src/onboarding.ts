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
