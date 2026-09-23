import type { Ref } from 'react';
import { needsListing, type OrgDraft, type RepoMode } from '../onboarding.js';

/** What the disclosure reads while collapsed: the org's repository mode, and the count only once
 * a listing is there to count. */
function collapsedSummary(draft: OrgDraft): string {
    if (draft.mode === 'all') return 'All current and future repositories';
    if (draft.listing.kind === 'ready') {
        return `${draft.chosen.size} specific ${draft.chosen.size === 1 ? 'repository' : 'repositories'}`;
    }
    if (draft.listing.kind === 'idle' || draft.listing.kind === 'loading') return 'Specific repositories';
    return 'Specific repositories (not reviewable right now)';
}

/**
 * The repository listing's body, by the listing's own state: loading, failed, temporarily
 * unavailable, or the ready checklist. Split out of `OnboardingOrganization` so its own 4-way
 * branch does not add to the parent's cognitive complexity.
 */
function RepositoryListingBody({
    draft,
    countId,
    reasonId,
    empty,
    onRetryListing,
    onToggleRepo,
}: {
    draft: OrgDraft;
    countId: string;
    reasonId: string;
    empty: boolean;
    onRetryListing: () => void;
    onToggleRepo: (repo: string) => void;
}) {
    if (draft.listing.kind === 'loading') return <p className="muted">Loading repositories…</p>;
    if (draft.listing.kind === 'failed') {
        return (
            <>
                <p className="status" role="alert">
                    Could not load the repositories for this organization.
                </p>
                <button type="button" onClick={onRetryListing}>
                    Retry
                </button>
            </>
        );
    }
    if (draft.listing.kind === 'unavailable') {
        return (
            <>
                <p className="status">
                    {draft.mode === 'all'
                        ? 'Repository choices are temporarily unavailable. Factory will track repositories this installation reports.'
                        : 'Your existing specific selection is preserved, but it cannot be reviewed right now. Try again before changing repository scope.'}
                </p>
                <button type="button" onClick={onRetryListing}>
                    Retry
                </button>
            </>
        );
    }
    if (draft.listing.kind === 'ready') {
        return (
            <>
                <p className="onboarding-repo-count" id={countId}>
                    {draft.chosen.size} of {draft.listing.repos.length} repositories selected
                </p>
                <div className="onboarding-repos">
                    {draft.listing.repos.map((name) => (
                        <label key={name} className="onboarding-repo">
                            <input
                                type="checkbox"
                                checked={draft.chosen.has(name)}
                                onChange={() => onToggleRepo(name)}
                                aria-describedby={empty ? `${countId} ${reasonId}` : countId}
                            />
                            {name}
                        </label>
                    ))}
                </div>
            </>
        );
    }
    return null;
}

/**
 * One reported installation on the selection screen: the organization choice, and — once the
 * organization is selected — its explicit repository mode with the checklist that backs the
 * specific one. Presentational only: every state change arrives as a callback, every piece of
 * listing copy derives from the draft it is handed. The card is not a click target; only the
 * checkbox whose label names the organization toggles it, so radios, the disclosure, Retry and
 * the repository checkboxes never double as an organization switch.
 *
 * Ids are keyed by the row's installation-order index, never by installation id: the DOM
 * carries no numeric installation identifiers, and the render suite holds that line.
 */
export function OnboardingOrganization({
    installation,
    index,
    draft,
    selected,
    requested,
    onToggleOrg,
    onModeChange,
    onToggleRepo,
    onOpenDetails,
    onRetryListing,
    orgRef,
}: {
    installation: { account: string };
    index: number;
    draft: OrgDraft;
    selected: boolean;
    requested: boolean;
    onToggleOrg: () => void;
    onModeChange: (mode: RepoMode) => void;
    onToggleRepo: (repo: string) => void;
    onOpenDetails: () => void;
    onRetryListing: () => void;
    orgRef: Ref<HTMLLIElement>;
}) {
    const countId = `onboarding-repo-count-${index}`;
    const reasonId = `onboarding-repo-reason-${index}`;
    const empty = draft.mode === 'specific' && draft.listing.kind === 'ready' && draft.chosen.size === 0;

    return (
        <li className="onboarding-org" ref={orgRef} tabIndex={-1}>
            <div className="onboarding-org-head">
                <label className="onboarding-org-name">
                    <input type="checkbox" checked={selected} onChange={onToggleOrg} />
                    <span className="onboarding-org-mark" aria-hidden="true">
                        {installation.account.charAt(0).toUpperCase()}
                    </span>
                    {installation.account}
                </label>
                {requested ? <span className="onboarding-requested">Requested for this sign-in</span> : null}
            </div>
            {selected ? (
                <>
                    <details
                        className="onboarding-org-details"
                        onToggle={(event) => {
                            if ((event.target as HTMLDetailsElement).open && needsListing(draft)) onOpenDetails();
                        }}
                    >
                        <summary className="onboarding-org-summary">{collapsedSummary(draft)}</summary>
                        <fieldset className="onboarding-mode">
                            <legend>Repository tracking</legend>
                            <div className="onboarding-mode-option">
                                <input
                                    type="radio"
                                    id={`onboarding-mode-all-${index}`}
                                    name={`onboarding-mode-${index}`}
                                    checked={draft.mode === 'all'}
                                    onChange={() => onModeChange('all')}
                                />
                                <label htmlFor={`onboarding-mode-all-${index}`}>
                                    All current and future repositories
                                </label>
                                <p className="onboarding-mode-help" id={`onboarding-mode-all-help-${index}`}>
                                    Automatically include repositories this GitHub App installation reports later.
                                </p>
                            </div>
                            <div className="onboarding-mode-option">
                                <input
                                    type="radio"
                                    id={`onboarding-mode-specific-${index}`}
                                    name={`onboarding-mode-${index}`}
                                    checked={draft.mode === 'specific'}
                                    onChange={() => onModeChange('specific')}
                                    aria-describedby={`onboarding-mode-specific-help-${index}`}
                                />
                                <label htmlFor={`onboarding-mode-specific-${index}`}>
                                    Choose specific repositories
                                </label>
                                <p className="onboarding-mode-help" id={`onboarding-mode-specific-help-${index}`}>
                                    Only the repositories selected below are tracked; new repositories are not added
                                    automatically.
                                </p>
                            </div>
                        </fieldset>
                        <RepositoryListingBody
                            draft={draft}
                            countId={countId}
                            reasonId={reasonId}
                            empty={empty}
                            onRetryListing={onRetryListing}
                            onToggleRepo={onToggleRepo}
                        />
                    </details>
                    {/* Outside the disclosure, so the reason stays visible with it collapsed —
                        the state table's "per-group reason remains visible". */}
                    {empty ? (
                        <p className="status" id={reasonId}>
                            Select at least one repository, switch to all repositories, or deselect this organization.
                        </p>
                    ) : null}
                </>
            ) : null}
        </li>
    );
}
