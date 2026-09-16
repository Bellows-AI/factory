import type { StatsPayload } from '../api/useStats.js';
import type { Session } from '../api/useSession.js';
import { OrgSelector } from './OrgSelector.js';
import { UserMenu } from './UserMenu.js';

/**
 * Names every repo rather than reporting a count. "3 repositories combined" hides which three,
 * and the figures below are only interpretable if you know what went into them.
 */
function describeRepos(repos: { owner: string; name: string }[]): string {
    if (!repos.length) return 'no repositories configured';
    const owners = new Set(repos.map((r) => r.owner));
    // One owner is the common case, so repeating it on every entry is noise.
    if (owners.size === 1 && repos.length > 1) {
        return `${[...owners][0]}/{${repos.map((r) => r.name).join(', ')}}`;
    }
    return repos.map((r) => `${r.owner}/${r.name}`).join(', ');
}

export function TopBar({
    data,
    refreshing,
    onRefresh,
    session,
}: {
    data: StatsPayload | null;
    refreshing: boolean;
    onRefresh: () => void;
    /** Null only before the session check lands; the menu waits rather than flashing empty. */
    session: Session | null;
}) {
    const meta = data?.meta;
    return (
        <header className="topbar">
            <div>
                <h1>Factory stats</h1>
                <p className="muted">{meta ? `${describeRepos(meta.repos)} — AI usage telemetry` : 'loading…'}</p>
            </div>
            <div className="topbar-actions">
                {/*
                 * Leftmost of the group, because it is *scope*: beside the "data as of" caption it
                 * reads as "what you are looking at" against the button's "do something". Refresh
                 * stays in the far corner — it is the only action, and moving it costs muscle
                 * memory for nothing.
                 *
                 * Nothing renders before the first payload. A placeholder select with no options
                 * would flash an empty control, and the subtitle already says "loading…".
                 *
                 * The organization name does NOT replace describeRepos() above. That comment says
                 * the repo list is named rather than counted because the figures are only
                 * interpretable if you know what went into them — an organization name does not
                 * tell you that, and repos living under [organization] in the config file does not
                 * make its name a summary of the list.
                 */}
                {meta ? (
                    <OrgSelector
                        organization={meta.organization}
                        onSwitch={(orgId) => {
                            // The switch is a server-side session change; on success the reload
                            // makes every org-scoped read re-probe from scratch. A refusal
                            // (403/400 — the membership moved under the selector) leaves the
                            // page untouched: the select's value is bound to the payload, so
                            // the next poll renders it back on the org the session still holds.
                            void fetch('/api/auth/org', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ orgId }),
                            })
                                .then((response) => {
                                    if (response.ok) window.location.reload();
                                })
                                .catch(() => {});
                        }}
                    />
                ) : null}
                <span className="muted">{meta ? `data as of ${new Date(meta.fetchedAt).toLocaleString()}` : ''}</span>
                <button type="button" onClick={onRefresh} disabled={refreshing}>
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
                {/* The corner account affordance. Until the session check answers there is nothing
                    to show — an empty chip would flash on every load. */}
                {session ? <UserMenu session={session} /> : null}
            </div>
        </header>
    );
}
