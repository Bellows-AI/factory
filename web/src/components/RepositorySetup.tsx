import type { ReactNode, RefObject } from 'react';
import { Link } from 'react-router-dom';
import type { InstallationRepo } from '../api/useRepos.js';
import type { WorkspaceRepo } from '../api/useWorkspace.js';
import { bytes, commitDate } from '../format.js';
import { canSelect, checkoutCell, checkoutText, MAX_SELECTED_REPOS, repoKey } from './repository-setup.js';
import type { SelectionCounts, SelectionSaveState, WorkspaceState } from './repository-setup.js';

/**
 * The three presentational halves of the repository setup page (issue 181): the availability and
 * selection summary, the searchable list, and the per-repository configuration detail.
 *
 * All three are hooks-free and fetch-free by the PageHeader contract, so a static render is a
 * complete render. Every decision they draw — what is selected, what may save, what a checkout
 * cell says — arrives as props computed by repository-setup.ts, where the offline suite pins the
 * rules. The sentences the issue mandates verbatim are rendered here and pinned in
 * repository-setup.render.test.tsx.
 */

export interface RepositorySetupSummaryProps {
    /** Null while either the installation list or the workspace poll is still unresolved. */
    counts: SelectionCounts | null;
    installation: { account: string | null; repositorySelection: 'all' | 'selected' | null } | null;
    cachedError: string | null;
    /** When the cached list was fetched — shown beside the cached warning, never faked. */
    fetchedAt?: string | null;
    /**
     * The installation list's transient posture — loading in flight, or a hard failure with no
     * rows in hand. Stated here because an absent list is not an empty one.
     */
    listNotice: string | null;
    rootNull: boolean;
    dirty: boolean;
    saveState: SelectionSaveState;
    saving: boolean;
    savedNote: boolean;
    failure: string | null;
    /** A later workspace poll failed over last-good rows: the facts stay, marked stale. */
    staleError: string | null;
    onSave: () => void;
}

export function RepositorySetupSummary({
    counts,
    installation,
    cachedError,
    fetchedAt,
    listNotice,
    rootNull,
    dirty,
    saveState,
    saving,
    savedNote,
    failure,
    staleError,
    onSave,
}: RepositorySetupSummaryProps) {
    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Availability</h2>
            </div>
            {listNotice ? <p className="status">{listNotice}</p> : null}
            {counts ? (
                <p>
                    {counts.enabled} of {counts.available} repositories enabled · {counts.ready} ready ·{' '}
                    {counts.settingUp} setting up · {counts.failed} failed
                </p>
            ) : null}
            {installation ? (
                <p className="muted">
                    Installation: {installation.account ?? 'GitHub App'}
                    {installation.repositorySelection
                        ? ` — access to ${installation.repositorySelection} repositories`
                        : ''}
                    .
                </p>
            ) : null}
            {cachedError ? (
                <p className="status">
                    Showing a cached list{fetchedAt ? ` from ${commitDate(fetchedAt)}` : ''}: {cachedError}
                </p>
            ) : null}
            {rootNull ? (
                <p className="status">
                    This deployment has no workspace root, so repositories are not checked out. An operator must set{' '}
                    <code>ORG_WORKSPACE_ROOT</code> — see <Link to="/settings/workspace">Workspace</Link>.
                </p>
            ) : null}
            {staleError ? <p className="status">Checkout status is stale — {staleError}</p> : null}
            {dirty ? <p className="status">Selection changed — save to update your workspace</p> : null}
            {saveState.reason ? (
                <p className="status" id="repo-save-reason">
                    {saveState.reason}
                </p>
            ) : null}
            {failure ? <p className="status">{failure}</p> : null}
            {savedNote ? <p className="muted">Selection saved. Checkouts are being prepared.</p> : null}
            <button
                type="button"
                className="primary"
                onClick={onSave}
                disabled={saveState.disabled}
                aria-describedby={saveState.reason ? 'repo-save-reason' : undefined}
            >
                {saving ? 'Saving selection…' : 'Save repository selection'}
            </button>
        </section>
    );
}

export interface RepositorySetupListProps {
    /** The installation's full, recency-ordered list — the ceiling line counts against it. */
    repos: readonly InstallationRepo[];
    /** The searched subset, already filtered and ordered by the page. */
    shown: readonly InstallationRepo[];
    search: string;
    onSearch: (query: string) => void;
    chosen: ReadonlySet<string>;
    onToggle: (key: string) => void;
    workspaceState: WorkspaceState;
    rows: ReadonlyMap<string, WorkspaceRepo | undefined>;
    configured: string | null;
    onConfigure: (key: string) => void;
    /** The workspace poll has not answered: no checkbox may state a selection as fact. */
    loadingCheckouts: boolean;
    /** No workspace root: checkouts cannot run, so no checkbox offers one. */
    rootNull: boolean;
    saving: boolean;
    /** Selected keys GitHub stopped reporting — deselectable, never silently dropped. */
    absent: readonly string[];
    onDeselectAbsent: (key: string) => void;
    /** A successful response arrived: only then may "no match" be stated. */
    loaded: boolean;
}

export function RepositorySetupList({
    repos,
    shown,
    search,
    onSearch,
    chosen,
    onToggle,
    workspaceState,
    rows,
    configured,
    onConfigure,
    loadingCheckouts,
    rootNull,
    saving,
    absent,
    onDeselectAbsent,
    loaded,
}: RepositorySetupListProps) {
    const atCeiling = !canSelect(chosen);
    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Repository list</h2>
            </div>
            <div className="repo-search">
                <label htmlFor="repo-setup-search">Search repositories</label>
                <input
                    id="repo-setup-search"
                    type="text"
                    placeholder="owner/name"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                />
                {search ? (
                    <button type="button" onClick={() => onSearch('')}>
                        Clear search
                    </button>
                ) : null}
            </div>
            <p className="muted">Selections are limited to {MAX_SELECTED_REPOS} repositories.</p>
            {shown.length ? (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <section className="table-wrap" aria-label="Repositories" tabIndex={0}>
                    <table className="data">
                        <thead>
                            <tr>
                                <th scope="col">Enabled</th>
                                <th scope="col">Repository</th>
                                <th scope="col">Checkout status</th>
                                <th scope="col">Branch</th>
                                <th scope="col">Last commit</th>
                                <th scope="col">Size</th>
                                <th scope="col">
                                    <span className="visually-hidden">Configure</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((repo) => {
                                const key = repoKey(repo);
                                const selected = chosen.has(key);
                                const text = checkoutText(checkoutCell(selected, rows.get(key), workspaceState));
                                const row = rows.get(key);
                                return (
                                    <tr key={key}>
                                        <td>
                                            {/* While the workspace poll is unresolved the box is not
                                                shown at all: a disabled unchecked box would still
                                                read as a selection fact, and there is none yet. */}
                                            {loadingCheckouts ? (
                                                '—'
                                            ) : (
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Enable ${key} in my workspace`}
                                                    checked={selected}
                                                    disabled={rootNull || saving || (!selected && atCeiling)}
                                                    onChange={() => onToggle(key)}
                                                />
                                            )}
                                        </td>
                                        <td>
                                            {key}
                                            {repo.private ? <span className="pill">private</span> : null}
                                        </td>
                                        <td>{text}</td>
                                        <td>{row?.branch ?? repo.defaultBranch ?? '—'}</td>
                                        <td>{row?.lastCommit ? commitDate(row.lastCommit.at) : '—'}</td>
                                        <td>{bytes(row?.sizeBytes ?? null)}</td>
                                        <td>
                                            <button
                                                type="button"
                                                aria-current={configured === key}
                                                onClick={() => onConfigure(key)}
                                            >
                                                Configure
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </section>
            ) : loaded && repos.length ? (
                <p className="status">No repositories match “{search}”</p>
            ) : loaded ? (
                <p className="status">
                    This GitHub App is not installed on any repositories yet. Ask an administrator to update the
                    installation on GitHub.
                </p>
            ) : null}
            {absent.length ? (
                <>
                    <h3>No longer reported by GitHub</h3>
                    <p className="muted">
                        These repositories stay selected until you remove them — the save will not drop them silently.
                    </p>
                    <ul>
                        {absent.map((key) => (
                            <li key={key}>
                                {key}{' '}
                                {/* A mid-save click would mutate the draft the request in flight no
                                    longer reflects — the same lock the rows above honor. */}
                                <button
                                    type="button"
                                    aria-label={`Deselect ${key}`}
                                    disabled={saving}
                                    onClick={() => onDeselectAbsent(key)}
                                >
                                    Deselect
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            ) : null}
        </section>
    );
}

export interface RepositoryConfigDetailProps {
    /** The configured repository, or null — nothing renders before a choice. */
    repo: { owner: string; name: string } | null;
    /** The repository's checkout status, as sentence text. */
    checkout: string;
    /** Focus target for the narrow-widths handoff; the page moves focus, never the component. */
    headingRef?: RefObject<HTMLHeadingElement | null>;
    children?: ReactNode;
}

/**
 * The configuration detail: the repository's environment scope opened on the same page. It states
 * the scope the way Slice D words it — organization-wide impact, member editability, and the
 * precedence order — and renders the mounted editor as its children, so a save's echoed rows and
 * its confirmation survive. Configuration does not require personal checkout enablement; the
 * checkout status is context, not a gate.
 */
export function RepositoryConfigDetail({ repo, checkout, headingRef, children }: RepositoryConfigDetailProps) {
    if (!repo) return null;
    const key = repoKey(repo);
    return (
        <section className="panel">
            <h2 ref={headingRef} tabIndex={-1}>
                Environment for {key}
            </h2>
            <p className="muted">Repository · {key}</p>
            <p className="muted">
                Applies to every task using the repository in the organization; any member can edit.
            </p>
            <p className="muted">
                Environment values combine in order: organization, then workspace, then repository — a more specific
                scope overrides a broader one.
            </p>
            <p className="muted">Checkout status: {checkout}</p>
            {children}
        </section>
    );
}
