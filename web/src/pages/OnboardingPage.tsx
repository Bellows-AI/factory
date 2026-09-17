import { useEffect, useState } from 'react';

/** What GET /api/auth/github/pending answers for a parked sign-in (issue 125). */
export interface PendingSignInPayload {
    identity: { login: string; displayName: string | null; avatarUrl: string | null };
    /**
     * One entry per reported installation. `tracked` is the org's stored repo allowlist — null
     * when it tracks everything — so a reselect SHOWS the narrowing it is asking about instead
     * of asserting a false all-checked state.
     */
    installations: { id: string; account: string; tracked: string[] | null }[];
    /** The installation ids that arrive pre-checked: the stored choice on a reselect, all otherwise. */
    selected: string[];
    reselect: boolean;
    org: string | null;
    returnTo: string;
}

/** What GET /api/auth/github/pending/installations/:id/repos answers for one org. */
interface RepoListing {
    repos: string[];
    source: 'app' | 'none';
}

/**
 * The expired-pending state: the one recovery is restarting the OAuth round trip. Rendered
 * whenever the server answers NO_PENDING — before the screen loads, or after the person spent
 * longer choosing than the pending row's TTL — and carrying the return path forward so starting
 * over does not lose where they were headed.
 */
export function StartAgainPanel({ returnTo }: { returnTo?: string | undefined }) {
    return (
        <p className="status">
            That sign-in expired.{' '}
            <a href={`/api/auth/github?returnTo=${encodeURIComponent(returnTo ?? '/')}`}>Start again</a> to choose the
            organizations this dashboard tracks.
        </p>
    );
}

/**
 * The sign-in selection screen (issue 125): the step between the OAuth round trip and the session.
 *
 * Everything arrives pre-checked — the stored choice on a reselect, every reported installation
 * on a first sign-in — so confirming the default is exactly what sign-in did before this screen
 * existed. Per-org repo checkboxes load lazily when an org is expanded, seeded from the org's
 * stored narrowing when it has one. A narrowed org posts its checked set; an org whose checkboxes
 * all read checked posts an empty list, which clears any stored narrowing — that is the widening
 * move. An org nobody narrowed and never touched posts nothing at all, which keeps "track
 * everything, future repos included" distinct from "track today's list".
 *
 * The Continue is a fetch, not a navigation — the completion route answers JSON and mints the
 * session cookie itself; the page then assigns the return path as a full load, the same posture
 * as the org switch.
 */
export function OnboardingPage({ payload: initial }: { payload?: PendingSignInPayload }) {
    const [payload, setPayload] = useState<PendingSignInPayload | null>(initial ?? null);
    const [expired, setExpired] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    // The org checkboxes: initialized from the payload's pre-checked ids once it has loaded.
    const [checked, setChecked] = useState<Set<string>>(new Set(initial?.selected ?? []));
    // Per-org repo listings, fetched lazily on first expand — never for orgs nobody opened.
    const [listings, setListings] = useState<Record<string, RepoListing | 'loading'>>({});
    // Orgs whose repo checkboxes were touched, plus every org with a stored narrowing — only
    // these post a repos key at all.
    const [narrowed, setNarrowed] = useState<Set<string>>(new Set());
    const [repoChecked, setRepoChecked] = useState<Record<string, Set<string>>>({});

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
                    setError(`Could not load the sign-in (${response.status})`);
                    return;
                }
                if (cancelled) return;
                const loaded = (await response.json()) as PendingSignInPayload;
                setPayload(loaded);
                setChecked(new Set(loaded.selected));
            } catch (e) {
                if (!cancelled) setError((e as Error).message);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [initial]);

    if (expired) {
        return (
            <main className="onboarding">
                <section className="panel">
                    <div className="panel-head">
                        <h2>Choose what to track</h2>
                    </div>
                    <StartAgainPanel returnTo={payload?.returnTo ?? undefined} />
                </section>
            </main>
        );
    }

    if (!payload) {
        return (
            <main className="onboarding">
                <section className="panel">
                    <div className="panel-head">
                        <h2>Choose what to track</h2>
                    </div>
                    {error ? <p className="status">{error}</p> : <p className="muted">Loading…</p>}
                </section>
            </main>
        );
    }

    const toggleOrg = (id: string) => {
        setChecked((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const loadRepos = async (id: string) => {
        if (listings[id]) return;
        setListings((prev) => ({ ...prev, [id]: 'loading' }));
        const response = await fetch(`/api/auth/github/pending/installations/${id}/repos`);
        if (response.status === 401) {
            setExpired(true);
            return;
        }
        if (!response.ok) {
            setError('Could not load the repositories for this organization.');
            setListings((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
            });
            return;
        }
        const listing = (await response.json()) as RepoListing;
        setListings((prev) => ({ ...prev, [id]: listing }));
    };

    const toggleRepo = (orgId: string, repo: string) => {
        setNarrowed((prev) => new Set(prev).add(orgId));
        setRepoChecked((prev) => {
            // First touch seeds the set from the org's standing state — its stored narrowing when
            // it has one, everything otherwise.
            const installation = payload.installations.find((i) => i.id === orgId);
            const listing = listings[orgId];
            const seeded =
                prev[orgId] ??
                new Set(installation?.tracked ?? (listing && listing !== 'loading' ? listing.repos : []));
            const next = new Set(seeded);
            if (next.has(repo)) next.delete(repo);
            else next.add(repo);
            return { ...prev, [orgId]: next };
        });
    };

    const submit = async () => {
        setSubmitting(true);
        setError(null);
        const repos: Record<string, string[]> = {};
        // Orgs whose repo set must travel: touched ones that are still selected, and selected
        // ones carrying a stored narrowing. The latter only actually post when their listing has
        // been fetched (a collapsed org was never listed, so its untouched narrowing rides as-is
        // — visible only when the org is expanded).
        const considered = new Set([...narrowed].filter((orgId) => checked.has(orgId)));
        for (const installation of payload.installations) {
            if (installation.tracked && checked.has(installation.id)) considered.add(installation.id);
        }
        for (const orgId of considered) {
            const installation = payload.installations.find((i) => i.id === orgId);
            const listing = listings[orgId];
            if (!installation || !listing || listing === 'loading' || listing.source !== 'app') continue;
            const chosen = [...(repoChecked[orgId] ?? new Set(installation.tracked ?? listing.repos))];
            // Checking nothing is not a state this route can express — tracking no repo of a
            // selected org is what deselecting the org is for. The empty hint below says so.
            if (chosen.length === 0) continue;
            // All-checked means track everything, future repos included: posted as an empty
            // list, which clears any stored narrowing rather than pinning today's list. Mutual
            // set inclusion, not a length compare — a set must not read as "everything" merely
            // because it is as long as the listing.
            const everything =
                listing.repos.every((name) => chosen.includes(name)) &&
                chosen.every((name) => listing.repos.includes(name));
            repos[orgId] = everything ? [] : chosen;
        }
        try {
            const response = await fetch('/api/auth/github/complete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ orgs: [...checked], repos }),
            });
            if (response.status === 401) {
                setExpired(true);
                return;
            }
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as { code?: string } | null;
                if (body?.code === 'UNKNOWN_REPO') {
                    setError('One of the chosen repositories is not offered by its installation. Try again.');
                } else if (body?.code === 'REPOS_UNAVAILABLE') {
                    setError(
                        'The repositories of one of the chosen organizations could not be listed, so its narrowing was refused. Try again.'
                    );
                } else {
                    setError('The selection could not be saved. Try again.');
                }
                return;
            }
            const done = (await response.json()) as { returnTo: string };
            window.location.assign(done.returnTo || '/');
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="onboarding">
            <section className="panel">
                <div className="panel-head">
                    <h2>Choose what to track</h2>
                </div>
                <p className="muted">
                    Signing in as {payload.identity.displayName ?? payload.identity.login}. Choose the organizations —
                    and their repositories — this dashboard tracks.
                    {payload.reselect ? ' Your current choice is pre-checked.' : ''}
                </p>
                <ul className="onboarding-orgs">
                    {payload.installations.map((installation) => {
                        const listing = listings[installation.id];
                        const chosenRepos = repoChecked[installation.id];
                        return (
                            <li key={installation.id} className="onboarding-org">
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={checked.has(installation.id)}
                                        onChange={() => toggleOrg(installation.id)}
                                    />{' '}
                                    {installation.account}
                                    {payload.org === installation.id ? ' (asked for)' : ''}
                                </label>
                                {checked.has(installation.id) ? (
                                    <details
                                        onToggle={(event) => {
                                            if ((event.target as HTMLDetailsElement).open)
                                                void loadRepos(installation.id);
                                        }}
                                    >
                                        <summary className="muted">Repositories</summary>
                                        {listing === undefined || listing === 'loading' ? (
                                            <p className="muted">Loading…</p>
                                        ) : listing.source === 'none' ? (
                                            <p className="muted">
                                                Repository tracking is unavailable for this organization right now —
                                                everything it reports will be tracked.
                                            </p>
                                        ) : (
                                            <div className="onboarding-repos">
                                                {listing.repos.map((name) => (
                                                    <label key={name}>
                                                        <input
                                                            type="checkbox"
                                                            checked={
                                                                chosenRepos
                                                                    ? chosenRepos.has(name)
                                                                    : (installation.tracked ?? listing.repos).includes(
                                                                          name
                                                                      )
                                                            }
                                                            onChange={() => toggleRepo(installation.id, name)}
                                                        />{' '}
                                                        {name}
                                                    </label>
                                                ))}
                                                {chosenRepos && chosenRepos.size === 0 ? (
                                                    <p className="status">
                                                        At least one repository stays tracked. Deselect the organization
                                                        instead to track none of it.
                                                    </p>
                                                ) : null}
                                            </div>
                                        )}
                                    </details>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
                {error ? <p className="status">{error}</p> : null}
                <button
                    type="button"
                    className="primary"
                    disabled={submitting || checked.size === 0}
                    onClick={() => void submit()}
                >
                    {submitting ? 'Signing in…' : 'Continue'}
                </button>
                {checked.size === 0 ? <p className="muted">Choose at least one organization to sign in.</p> : null}
            </section>
        </main>
    );
}
