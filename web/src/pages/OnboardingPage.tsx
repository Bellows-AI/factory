import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
    type OrgDraft,
    type PendingSignInPayload,
    type RepoListing,
    type RepoMode,
} from '../onboarding.js';
import { OnboardingOrganization } from '../components/OnboardingOrganization.js';
import { PublicPageHeader } from '../components/PublicPageHeader.js';
import { ThemeSelector } from '../components/ThemeSelector.js';

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
    const [payload, setPayload] = useState<PendingSignInPayload | null>(initial ?? null);
    const [expired, setExpired] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    // The organization checkboxes: initialized from the payload's pre-checked ids once it has loaded.
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial?.selected ?? []));
    // Per-org drafts: mode, specific choice, listing state. One entry per reported installation,
    // so a deselected organization's draft survives its deselection for the life of the page.
    const [drafts, setDrafts] = useState<ReadonlyMap<string, OrgDraft>>(() =>
        initialDrafts(initial?.installations ?? [], initialListings)
    );
    const [reload, setReload] = useState(0);
    const orgRefs = useRef(new Map<number, HTMLElement>());
    const actionsRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        // The `payload` prop is the render-test seam; a real mount fetches its own sign-in.
        if (initial) return;
        let cancelled = false;
        void (async () => {
            try {
                const response = await fetch('/api/auth/github/pending');
                if (!cancelled && response.status === 401) {
                    setExpired(true);
                    return;
                }
                if (!cancelled && !response.ok) {
                    setLoadFailed(true);
                    return;
                }
                if (cancelled) return;
                const loaded = (await response.json()) as PendingSignInPayload;
                setPayload(loaded);
                setSelected(new Set(loaded.selected));
                setDrafts(initialDrafts(loaded.installations));
            } catch {
                if (!cancelled) setLoadFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [initial, reload]);

    const fetchListing = async (id: string, force: boolean) => {
        const draft = drafts.get(id);
        if (!draft) return;
        if (!force && !needsListing(draft)) return;
        setDrafts((prev) => new Map(prev).set(id, { ...prev.get(id)!, listing: { kind: 'loading' } }));
        try {
            const response = await fetch(`/api/auth/github/pending/installations/${id}/repos`);
            if (response.status === 401) {
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

    const focusOrg = (id: string | null) => {
        const index = payload?.installations.findIndex((installation) => installation.id === id) ?? -1;
        (index >= 0 ? orgRefs.current.get(index) : orgRefs.current.get(0))?.focus();
    };

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
            if (response.status === 401) {
                setExpired(true);
                return;
            }
            if (!response.ok) {
                const problem = (await response.json().catch(() => null)) as { code?: string } | null;
                if (problem?.code === 'UNKNOWN_REPO') {
                    // The installation's listing changed under the loaded checkboxes: the refused
                    // body carried at least one name that no longer exists, and re-posting it
                    // verbatim would loop forever. Re-fetch what this submission relied on, let
                    // `withListing` re-narrow each choice to the fresh names, and point the
                    // person at the first reconciled organization — there, not at the action
                    // region: the refocused row is the thing that needs reviewing.
                    let firstReconciled: string | null = null;
                    let expiredDuringReconcile = false;
                    for (const orgId of Object.keys(body.repos)) {
                        const fresh = await fetch(`/api/auth/github/pending/installations/${orgId}/repos`)
                            .then((r) => {
                                // An expired pending row is the expiry, not a listing failure —
                                // the recovery is the same Start-again panel as everywhere else,
                                // so the rest of the reconcile would be doomed requests.
                                if (r.status === 401) {
                                    expiredDuringReconcile = true;
                                    setExpired(true);
                                    return null;
                                }
                                return r.ok ? (r.json() as Promise<RepoListing>) : null;
                            })
                            .catch(() => null);
                        if (!fresh) {
                            if (expiredDuringReconcile) break;
                            continue;
                        }
                        setDrafts((prev) => new Map(prev).set(orgId, withListing(prev.get(orgId)!, fresh)));
                        firstReconciled ??= orgId;
                    }
                    if (expiredDuringReconcile) return;
                    setError(
                        'The repositories of an organization changed while you were choosing. The lists were refreshed — review your selection and try again.'
                    );
                    focusOrg(firstReconciled);
                    return;
                }
                if (problem?.code === 'REPOS_UNAVAILABLE') {
                    setError(
                        'The repositories of one of the chosen organizations could not be listed, so its narrowing was refused. Try again.'
                    );
                } else {
                    setError('The selection could not be saved. Try again.');
                }
                actionsRef.current?.focus();
                return;
            }
            const done = (await response.json()) as { returnTo: string };
            window.location.assign(done.returnTo || '/');
        } catch (e) {
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

    const page = (children: ReactNode) => (
        <>
            {/* The appearance control (issue 188) rides the header's actions cell on every branch
                of this page — expired, loading, and full — so the preference is reachable
                throughout. This is the placement the shared header was built to hold. */}
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

    if (expired) {
        return page(<StartAgainPanel returnTo={payload?.returnTo ?? undefined} />);
    }

    if (!payload) {
        return page(
            loadFailed ? (
                <>
                    <p className="status" role="alert">
                        Could not load setup. Try again.
                    </p>
                    <button type="button" onClick={() => setReload((n) => n + 1)}>
                        Retry
                    </button>
                </>
            ) : (
                <div className="onboarding-loading">
                    <div className="onboarding-loading-line" aria-hidden="true" />
                    <div className="onboarding-loading-line" aria-hidden="true" />
                    <div className="onboarding-loading-line" aria-hidden="true" />
                    <p className="muted">Loading setup…</p>
                </div>
            )
        );
    }

    if (payload.installations.length === 0) {
        // Defensive: the callback redirects an installation-less account to the App install page
        // and never parks it here — but a payload without rows must still explain itself.
        return page(
            <>
                <p className="status">
                    No GitHub App installation is available for your account, so there is nothing to choose yet. Install
                    the App for an organization, then start again.
                </p>
                <a className="login-button" href={`/api/auth/github?returnTo=${encodeURIComponent(payload.returnTo)}`}>
                    Start again
                </a>
            </>
        );
    }

    const identity = identityView(payload.identity);
    const rows = summaryRows(payload.installations, selected, drafts, payload.org);
    const total = selected.size === 1 ? '1 organization selected' : `${selected.size} organizations selected`;

    return page(
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
                        onToggleOrg={() => toggleOrg(installation.id)}
                        onModeChange={(mode) => changeMode(installation.id, mode)}
                        onToggleRepo={(repo) => toggleRepo(installation.id, repo)}
                        onOpenDetails={() => void fetchListing(installation.id, false)}
                        onRetryListing={() => retryListing(installation.id)}
                        orgRef={(element) => {
                            if (element) orgRefs.current.set(index, element);
                            else orgRefs.current.delete(index);
                        }}
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
                <button type="button" className="primary" aria-disabled={!ready || submitting} onClick={attempt}>
                    {submitting ? 'Setting up Factory…' : 'Continue'}
                </button>
            </div>
        </>
    );
}
