import { useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import {
    buildCompletionPayload,
    firstInvalidOrg,
    identityView,
    initialDrafts,
    needsListing,
    summaryRows,
    withChosen,
    withFailedListing,
    withListing,
    withMode,
    type CompletionPayload,
    type OrgDraft,
    type PendingSignInPayload,
    type RepoListing,
    type RepoMode,
    type SummaryRow,
} from '../onboarding.js';
import { OnboardingOrganization } from '../components/OnboardingOrganization.js';
import { PublicPageHeader } from '../components/PublicPageHeader.js';
import { ThemeSelector } from '../components/ThemeSelector.js';

/** The board's session-expired status — the same recovery (Start again) as everywhere on this
 * screen. */
const HTTP_STATUS_UNAUTHORIZED = 401;

/**
 * The expired-pending state: the one recovery is restarting the OAuth round trip. Rendered
 * whenever the server answers NO_PENDING — before the screen loads, or after the person spent
 * longer choosing than the pending row's TTL — and carrying the return path forward so starting
 * over does not lose where they were headed. Nothing was saved: the pending row is single-use
 * and short-lived, so an expiry leaves no half-materialized choice behind.
 */
export function StartAgainPanel({ returnTo }: { returnTo?: string | undefined }) {
    return (
        <p className="status">
            That sign-in expired. Nothing was saved.{' '}
            <a href={`/api/auth/github?returnTo=${encodeURIComponent(returnTo ?? '/')}`}>Start again</a> to choose the
            organizations this dashboard tracks.
        </p>
    );
}

/** The mount-time pending-sign-in read, pulled out of the effect so its try/catch/status
 * handling does not add to `OnboardingPage`'s cognitive complexity. */
type PendingLoadResult = { kind: 'expired' } | { kind: 'failed' } | { kind: 'ok'; payload: PendingSignInPayload };

async function loadPendingSignIn(): Promise<PendingLoadResult> {
    try {
        const response = await fetch('/api/auth/github/pending');
        if (response.status === HTTP_STATUS_UNAUTHORIZED) return { kind: 'expired' };
        if (!response.ok) return { kind: 'failed' };
        const payload = (await response.json()) as PendingSignInPayload;
        return { kind: 'ok', payload };
    } catch {
        return { kind: 'failed' };
    }
}

/**
 * The UNKNOWN_REPO recovery: the installation's listing changed under the loaded checkboxes, so
 * the refused submission carried at least one name that no longer exists, and re-posting it
 * verbatim would loop forever. Re-fetches what the submission relied on and lets `withListing`
 * re-narrow each choice to the fresh names. Split out of `submit` so its loop and per-org fetch
 * chain do not add to the page's cognitive complexity; a 401 met mid-reconcile stops the loop
 * immediately, the same as the inline version did.
 */
async function reconcileUnknownRepos(
    orgIds: readonly string[],
    setDrafts: (updater: (prev: ReadonlyMap<string, OrgDraft>) => ReadonlyMap<string, OrgDraft>) => void
): Promise<{ expired: boolean; firstReconciled: string | null }> {
    let firstReconciled: string | null = null;
    for (const orgId of orgIds) {
        let response: Response;
        try {
            response = await fetch(`/api/auth/github/pending/installations/${orgId}/repos`);
        } catch {
            continue;
        }
        // An expired pending row is the expiry, not a listing failure — the recovery is the
        // same Start-again panel as everywhere else, so the rest of the reconcile would be
        // doomed requests.
        if (response.status === HTTP_STATUS_UNAUTHORIZED) return { expired: true, firstReconciled };
        if (!response.ok) continue;
        const fresh = (await response.json().catch(() => null)) as RepoListing | null;
        if (!fresh) continue;
        setDrafts((prev) => new Map(prev).set(orgId, withListing(prev.get(orgId)!, fresh)));
        firstReconciled ??= orgId;
    }
    return { expired: false, firstReconciled };
}

/**
 * What a refused submission does: UNKNOWN_REPO reconciles and points at the first affected
 * organization, REPOS_UNAVAILABLE and every other refusal state a message and return focus to
 * the actions region. Split out of `submit` for the same reason as `reconcileUnknownRepos`.
 */
async function handleSubmitFailure(
    response: Response,
    body: CompletionPayload,
    ctx: {
        setDrafts: (updater: (prev: ReadonlyMap<string, OrgDraft>) => ReadonlyMap<string, OrgDraft>) => void;
        setExpired: (value: boolean) => void;
        setError: (message: string) => void;
        focusOrg: (id: string | null) => void;
        focusActions: () => void;
    }
): Promise<void> {
    const problem = (await response.json().catch(() => null)) as { code?: string } | null;
    if (problem?.code === 'UNKNOWN_REPO') {
        const result = await reconcileUnknownRepos(Object.keys(body.repos), ctx.setDrafts);
        if (result.expired) {
            ctx.setExpired(true);
            return;
        }
        ctx.setError(
            'The repositories of an organization changed while you were choosing. The lists were refreshed — review your selection and try again.'
        );
        ctx.focusOrg(result.firstReconciled);
        return;
    }
    if (problem?.code === 'REPOS_UNAVAILABLE') {
        ctx.setError(
            'The repositories of one of the chosen organizations could not be listed, so its narrowing was refused. Try again.'
        );
    } else {
        ctx.setError('The selection could not be saved. Try again.');
    }
    ctx.focusActions();
}

/** The shared chrome every branch of the setup screen renders inside — the appearance control
 * (issue 188) rides the header's actions cell throughout, so the preference is reachable
 * whether the screen is expired, loading, or full. */
function OnboardingShell({ children }: { children: ReactNode }) {
    return (
        <>
            <PublicPageHeader context="Setup · One step" actions={<ThemeSelector />} />
            <main className="onboarding">
                <h1>Choose organizations and repositories</h1>
                <p className="onboarding-purpose">
                    Track agent activity, start work, and keep repository setup visible in one place.
                </p>
                {children}
            </main>
        </>
    );
}

/**
 * The full setup screen's body — signed-in identity, one row per reported organization, the
 * running summary, and the submit action. Split out of `OnboardingPage` so its own render tree
 * and event wiring do not add to the page's line count.
 */
function OnboardingMainContent({
    payload,
    selected,
    drafts,
    rows,
    total,
    error,
    submitting,
    ready,
    actionsRef,
    onToggleOrg,
    onChangeMode,
    onToggleRepo,
    onOpenDetails,
    onRetryListing,
    onOrgRef,
    onAttempt,
}: {
    payload: PendingSignInPayload;
    selected: ReadonlySet<string>;
    drafts: ReadonlyMap<string, OrgDraft>;
    rows: readonly SummaryRow[];
    total: string;
    error: string | null;
    submitting: boolean;
    ready: boolean;
    actionsRef: RefObject<HTMLDivElement | null>;
    onToggleOrg: (id: string) => void;
    onChangeMode: (id: string, mode: RepoMode) => void;
    onToggleRepo: (id: string, repo: string) => void;
    onOpenDetails: (id: string) => void;
    onRetryListing: (id: string) => void;
    onOrgRef: (index: number, element: HTMLElement | null) => void;
    onAttempt: () => void;
}) {
    const identity = identityView(payload.identity);
    return (
        <>
            <div className="onboarding-identity">
                {identity.avatarUrl ? (
                    <img className="avatar" src={identity.avatarUrl} alt="" width={24} height={24} />
                ) : (
                    <span className="avatar avatar-fallback" aria-hidden="true">
                        {identity.initial}
                    </span>
                )}
                <span>Signed in as {identity.name}</span>
            </div>
            <ul className="onboarding-orgs" aria-label="Organizations">
                {payload.installations.map((installation, index) => (
                    <OnboardingOrganization
                        key={installation.id}
                        installation={installation}
                        index={index}
                        draft={drafts.get(installation.id)!}
                        selected={selected.has(installation.id)}
                        requested={payload.org === installation.id}
                        onToggleOrg={() => onToggleOrg(installation.id)}
                        onModeChange={(mode) => onChangeMode(installation.id, mode)}
                        onToggleRepo={(repo) => onToggleRepo(installation.id, repo)}
                        onOpenDetails={() => onOpenDetails(installation.id)}
                        onRetryListing={() => onRetryListing(installation.id)}
                        orgRef={(element) => onOrgRef(index, element)}
                    />
                ))}
            </ul>
            <p className="onboarding-note">
                GitHub sign-in provides your identity and organization membership. Repository names come from the
                installed GitHub App. This choice changes what Factory tracks, not your GitHub permissions.
            </p>
            <section className="onboarding-summary" aria-label="Your selection">
                <h2>Your selection</h2>
                <p className="onboarding-summary-total">{total}</p>
                <ul className="onboarding-summary-rows">
                    {rows.map((row) => (
                        <li key={row.id} className="onboarding-summary-row">
                            <span>{row.account}</span>
                            <span>{row.label}</span>
                            {row.active ? (
                                <span className="muted">You will enter Factory in this organization.</span>
                            ) : null}
                        </li>
                    ))}
                </ul>
                {payload.reselect ? (
                    <p className="muted">
                        This replaces which organizations you enter Factory with. Repository modes change only where
                        shown above.
                    </p>
                ) : null}
            </section>
            <div className="onboarding-actions" ref={actionsRef} tabIndex={-1} aria-busy={submitting}>
                {error ? (
                    <p className="status" role="alert">
                        {error}
                    </p>
                ) : null}
                {selected.size === 0 ? <p className="muted">Choose at least one organization to continue.</p> : null}
                {/* aria-disabled rather than disabled: an attempted action against an unready
                    draft is receivable, and the attempt is what moves focus to the first invalid
                    group. The handler no-ops the network while a draft stands unready. */}
                <button type="button" className="primary" aria-disabled={!ready || submitting} onClick={onAttempt}>
                    {submitting ? 'Setting up Factory…' : 'Continue'}
                </button>
            </div>
        </>
    );
}

/**
 * The pending sign-in and its per-org drafts: the payload/expired/loadFailed state, the
 * selection and draft maps every handler below mutates, and the mount-time fetch (the render-test
 * seam skips it when `initial` is given). Split out of `OnboardingPage` so its own state and
 * effect do not add to the page's line count.
 */
function useOnboardingLoad(
    initial: PendingSignInPayload | undefined,
    initialListings: Record<string, RepoListing | 'loading'> | undefined
) {
    const [payload, setPayload] = useState<PendingSignInPayload | null>(initial ?? null);
    const [expired, setExpired] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    // The organization checkboxes: initialized from the payload's pre-checked ids once it has loaded.
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial?.selected ?? []));
    // Per-org drafts: mode, specific choice, listing state. One entry per reported installation,
    // so a deselected organization's draft survives its deselection for the life of the page.
    const [drafts, setDrafts] = useState<ReadonlyMap<string, OrgDraft>>(() =>
        initialDrafts(initial?.installations ?? [], initialListings)
    );
    const [reload, setReload] = useState(0);

    useEffect(() => {
        // The `payload` prop is the render-test seam; a real mount fetches its own sign-in.
        if (initial) return;
        let cancelled = false;
        void loadPendingSignIn().then((result) => {
            if (cancelled) return;
            if (result.kind === 'expired') {
                setExpired(true);
                return;
            }
            if (result.kind === 'failed') {
                setLoadFailed(true);
                return;
            }
            setPayload(result.payload);
            setSelected(new Set(result.payload.selected));
            setDrafts(initialDrafts(result.payload.installations));
        });
        return () => {
            cancelled = true;
        };
    }, [initial, reload]);

    return {
        payload,
        expired,
        setExpired,
        loadFailed,
        selected,
        setSelected,
        drafts,
        setDrafts,
        // Clearing the failure here is what lets the placeholders back in while the retry runs —
        // otherwise the panel cannot change until the answer lands.
        retry: () => {
            setLoadFailed(false);
            setReload((n) => n + 1);
        },
    };
}

/**
 * The per-org draft mutations: toggling an organization, switching its mode, toggling one
 * repository, retrying a failed listing, and the listing fetch itself. Split out of
 * `OnboardingPage` for the same reason as `useOnboardingLoad`.
 */
function useOrgDraftActions(state: {
    setSelected: Dispatch<SetStateAction<ReadonlySet<string>>>;
    drafts: ReadonlyMap<string, OrgDraft>;
    setDrafts: Dispatch<SetStateAction<ReadonlyMap<string, OrgDraft>>>;
    setExpired: (value: boolean) => void;
}) {
    const { setSelected, drafts, setDrafts, setExpired } = state;

    const fetchListing = async (id: string, force: boolean) => {
        const draft = drafts.get(id);
        if (!draft) return;
        if (!force && !needsListing(draft)) return;
        setDrafts((prev) => new Map(prev).set(id, { ...prev.get(id)!, listing: { kind: 'loading' } }));
        try {
            const response = await fetch(`/api/auth/github/pending/installations/${id}/repos`);
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                setExpired(true);
                return;
            }
            if (!response.ok) {
                setDrafts((prev) => new Map(prev).set(id, withFailedListing(prev.get(id)!)));
                return;
            }
            const listing = (await response.json()) as RepoListing;
            setDrafts((prev) => new Map(prev).set(id, withListing(prev.get(id)!, listing)));
        } catch {
            setDrafts((prev) => new Map(prev).set(id, withFailedListing(prev.get(id)!)));
        }
    };

    const toggleOrg = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const changeMode = (id: string, mode: RepoMode) => {
        setDrafts((prev) => new Map(prev).set(id, withMode(prev.get(id)!, mode)));
        if (mode === 'specific') void fetchListing(id, false);
    };

    const toggleRepo = (id: string, repo: string) => {
        setDrafts((prev) => new Map(prev).set(id, withChosen(prev.get(id)!, repo)));
    };

    const retryListing = (id: string) => {
        setDrafts((prev) => new Map(prev).set(id, { ...prev.get(id)!, listing: { kind: 'idle' } }));
        void fetchListing(id, true);
    };

    return { fetchListing, toggleOrg, changeMode, toggleRepo, retryListing };
}

/**
 * Focus management over the organization list: the ref map every row registers into, and
 * focusing one by installation id (or the first row, for a bare validation failure). Split out
 * of `OnboardingPage` for the same reason as `useOnboardingLoad`.
 */
function useOrgFocus(payload: PendingSignInPayload | null) {
    const orgRefs = useRef(new Map<number, HTMLElement>());

    const focusOrg = (id: string | null) => {
        const index = payload?.installations.findIndex((installation) => installation.id === id) ?? -1;
        (index >= 0 ? orgRefs.current.get(index) : orgRefs.current.get(0))?.focus();
    };

    const registerOrgRef = (index: number, element: HTMLElement | null) => {
        if (element) orgRefs.current.set(index, element);
        else orgRefs.current.delete(index);
    };

    return { focusOrg, registerOrgRef };
}

/**
 * The submission itself: whether the draft is ready, the POST and its failure handling, and the
 * user-triggered attempt (which validates before ever touching the network). Split out of
 * `OnboardingPage` for the same reason as `useOnboardingLoad`.
 */
function useOnboardingSubmit(state: {
    payload: PendingSignInPayload | null;
    selected: ReadonlySet<string>;
    drafts: ReadonlyMap<string, OrgDraft>;
    setDrafts: Dispatch<SetStateAction<ReadonlyMap<string, OrgDraft>>>;
    setExpired: (value: boolean) => void;
    focusOrg: (id: string | null) => void;
}) {
    const { payload, selected, drafts, setDrafts, setExpired, focusOrg } = state;
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const actionsRef = useRef<HTMLDivElement | null>(null);

    const invalidId = payload ? firstInvalidOrg(payload.installations, selected, drafts) : null;
    const ready = payload !== null && selected.size > 0 && invalidId === null;

    const submit = async () => {
        if (!payload) return;
        setSubmitting(true);
        setError(null);
        const body = buildCompletionPayload(payload.installations, selected, drafts);
        try {
            const response = await fetch('/api/auth/github/complete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (response.status === HTTP_STATUS_UNAUTHORIZED) {
                setExpired(true);
                return;
            }
            if (!response.ok) {
                await handleSubmitFailure(response, body, {
                    setDrafts,
                    setExpired,
                    setError,
                    focusOrg,
                    focusActions: () => actionsRef.current?.focus(),
                });
                return;
            }
            const done = (await response.json()) as { returnTo: string };
            window.location.assign(done.returnTo || '/');
        } catch {
            setError('The selection could not be saved. Try again.');
            actionsRef.current?.focus();
        } finally {
            setSubmitting(false);
        }
    };

    const attempt = () => {
        if (submitting || !payload) return;
        // An attempted action against an unready draft is user-triggered validation: move focus
        // to the first thing that needs the person's attention, never the network.
        if (selected.size === 0) {
            focusOrg(null);
            return;
        }
        if (invalidId !== null) {
            focusOrg(invalidId);
            return;
        }
        void submit();
    };

    return { error, submitting, ready, actionsRef, attempt };
}

/** The `!payload` branch: a hard failure with a local Retry, or the loading placeholders while
 * the first read is in flight. Split out of `OnboardingPage` for the same reason as
 * `useOnboardingLoad`. */
function OnboardingLoadState({ loadFailed, onRetry }: { loadFailed: boolean; onRetry: () => void }) {
    if (loadFailed) {
        return (
            <>
                <p className="status" role="alert">
                    Could not load setup. Try again.
                </p>
                <button type="button" onClick={onRetry}>
                    Retry
                </button>
            </>
        );
    }
    return (
        <div className="onboarding-loading">
            <div className="onboarding-loading-line" aria-hidden="true" />
            <div className="onboarding-loading-line" aria-hidden="true" />
            <div className="onboarding-loading-line" aria-hidden="true" />
            <p className="muted">Loading setup…</p>
        </div>
    );
}

/**
 * A payload without any reported installation. Defensive: the callback redirects an
 * installation-less account to the App install page and never parks it here — but a payload
 * without rows must still explain itself.
 */
function NoInstallationsPanel({ returnTo }: { returnTo: string }) {
    return (
        <>
            <p className="status">
                No GitHub App installation is available for your account, so there is nothing to choose yet. Install the
                App for an organization, then start again.
            </p>
            <a className="login-button" href={`/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`}>
                Start again
            </a>
        </>
    );
}

/**
 * The setup screen (issue 125, recomposed by issue 187): the one-page decision between the
 * OAuth round trip and the session. It explains what Factory does, names the signed-in person,
 * and makes each selected organization state its repository mode explicitly — all current and
 * future repositories, or a specific list. The mode is a choice the person makes with the
 * radios; nothing about it is inferred from how many checkboxes happen to read checked, and
 * checking every repository of a specific choice leaves it specific, future repos excluded.
 *
 * Everything arrives pre-checked — the stored choice on a reselect, every reported installation
 * on a first sign-in — so confirming the default is exactly what sign-in did before this screen
 * existed. A deselected organization keeps its in-memory draft for the life of the page but
 * contributes nothing to the submission; a selected one whose listing cannot be read keeps its
 * stored narrowing rather than silently widening it, because a failed read is not a decision.
 * The complete payload is built rule for rule by `buildCompletionPayload` in `../onboarding.js`.
 *
 * The Continue is a fetch, not a navigation — the completion route answers JSON and mints the
 * session cookie itself; the page then assigns the return path as a full load, the same posture
 * as the org switch. A plain `<a>` starts the OAuth round trip wherever the screen needs one,
 * because the CSP keeps `form-action 'none'` and a fetch cannot follow a 302 to github.com.
 */
export function OnboardingPage({
    payload: initial,
    listings: initialListings,
}: {
    payload?: PendingSignInPayload;
    /** The listings seam, beside `payload`: initial per-org listings, so a render test can reach the repo checkboxes. */
    listings?: Record<string, RepoListing | 'loading'>;
}) {
    const load = useOnboardingLoad(initial, initialListings);
    const { payload, expired, setExpired, loadFailed, selected, drafts, setDrafts } = load;
    const { fetchListing, toggleOrg, changeMode, toggleRepo, retryListing } = useOrgDraftActions({
        setSelected: load.setSelected,
        drafts,
        setDrafts,
        setExpired,
    });
    const { focusOrg, registerOrgRef } = useOrgFocus(payload);
    const { error, submitting, ready, actionsRef, attempt } = useOnboardingSubmit({
        payload,
        selected,
        drafts,
        setDrafts,
        setExpired,
        focusOrg,
    });

    const page = (children: ReactNode) => <OnboardingShell>{children}</OnboardingShell>;

    if (expired) {
        return page(<StartAgainPanel returnTo={payload?.returnTo ?? undefined} />);
    }

    if (!payload) {
        return page(<OnboardingLoadState loadFailed={loadFailed} onRetry={load.retry} />);
    }

    if (payload.installations.length === 0) {
        return page(<NoInstallationsPanel returnTo={payload.returnTo} />);
    }

    const rows = summaryRows(payload.installations, selected, drafts, payload.org);
    const total = selected.size === 1 ? '1 organization selected' : `${selected.size} organizations selected`;

    return page(
        <OnboardingMainContent
            payload={payload}
            selected={selected}
            drafts={drafts}
            rows={rows}
            total={total}
            error={error}
            submitting={submitting}
            ready={ready}
            actionsRef={actionsRef}
            onToggleOrg={toggleOrg}
            onChangeMode={changeMode}
            onToggleRepo={toggleRepo}
            onOpenDetails={(id) => void fetchListing(id, false)}
            onRetryListing={retryListing}
            onOrgRef={registerOrgRef}
            onAttempt={attempt}
        />
    );
}
