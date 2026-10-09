import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ConfigurationScope } from '../components/ConfigurationScope.js';
import { DraftReturnBanner } from '../components/DraftReturnBanner.js';
import { OrphanDeleteDialog } from '../components/OrphanDeleteDialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { WorkspaceRootBanner } from '../components/WorkspaceRootBanner.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { JiraConnectionsSection } from '../panels/JiraConnectionsSection.js';
import { USER_CONNECTION_SCOPE } from '../api/connections.js';
import type { UseEnv } from '../api/useEnv.js';
import type { OrphanedRepo, WorkspacePayload } from '../api/useWorkspace.js';
import { bytes } from '../format.js';
import { useSettingsPage } from './SettingsLayout.js';

/** The header's description: the checkout root once a poll has answered, or nothing — while
 * the first poll is unresolved, or when there is no root and the banner below says so. */
function workspaceRootDescription(data: WorkspacePayload | null): ReactNode {
    if (data?.root) {
        return (
            <>
                Your checkouts live at <code>{data.root}</code>. Agents you start run here.
            </>
        );
    }
    return undefined;
}

/** The member's own environment editor: a loading line while the read is in flight, or the
 * panel once it has landed. Split out of `SettingsWorkspacePage` so its own loading/data check
 * does not add to the page's cognitive complexity. */
function WorkspaceEnvEditor({ env }: { env: UseEnv }) {
    if (env.loading && !env.data) return <p className="status">Loading environment…</p>;
    if (!env.data) return null;
    return (
        <EnvVarsPanel
            title="My workspace"
            hint="Your own defaults, on every task you queue."
            initialVars={env.data.workspace}
            onSave={env.saveWorkspace}
            draftId="workspace"
            draftLabel="My workspace"
        />
    );
}

/**
 * One orphaned row's state line: what the member needs to read before they decide anything. A
 * deletion in flight is named ("Deleting…") because the poll can take a minute on a big tree; a
 * failed clone's error is the row's own explanation; a missing measurement is an em dash, never
 * `0 B` — the same null-means-unmeasured contract every size on these pages follows.
 */
function orphanStateLine(orphan: OrphanedRepo): ReactNode {
    if (orphan.status === 'purging') return <span className="muted">Deleting…</span>;
    if (orphan.status === 'failed' && orphan.error) return <span className="muted">{orphan.error}</span>;
    return <span className="muted">no longer enabled; its checkout remains on disk.</span>;
}

/**
 * The Workspace section of the settings tree, simplified to what is personal (issue 181): the
 * workspace root, the member's own environment scope, and the orphaned checkouts still on disk.
 *
 * Selecting repositories moved to Settings → Repositories, where the installation list, the
 * checkout statuses and the per-repository configuration live; the page links there instead of
 * hosting a second selection surface. What stays here is the one scope only this member owns.
 */
export function SettingsWorkspacePage() {
    const { workspace, env, session } = useSettingsPage();
    const { data, loading, error } = workspace;
    const { purge } = workspace;

    // The delete confirmation's state: WHICH orphan was aimed at, the request in flight, and the
    // board's refusal. One dialog for the page, opened by a row's Delete action.
    const [aimedAt, setAimedAt] = useState<OrphanedRepo | null>(null);
    const [purging, setPurging] = useState(false);
    const [purgeError, setPurgeError] = useState<string | null>(null);

    const confirmPurge = async () => {
        if (!aimedAt) return;
        setPurging(true);
        setPurgeError(null);
        const failure = await purge(aimedAt.owner, aimedAt.name);
        setPurging(false);
        if (failure !== null) {
            setPurgeError(failure);
            return;
        }
        setAimedAt(null);
    };

    // A deliberate configuration, not a failure — hence the sentence rather than an error. It
    // takes the place of the checkout link only: the member's environment scope is unrelated to
    // whether a root is configured and still renders below (issue 150 — on the old Environment
    // page it rendered on every deployment, and this keeps that true).
    const noRoot = data !== null && data.root === null;

    if (loading && !data) {
        return (
            <>
                <PageHeader eyebrow="Settings" title="Workspace" />
                <DraftReturnBanner />
                <p className="status">Loading your workspace…</p>
            </>
        );
    }

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Workspace"
                description={workspaceRootDescription(data)}
                actions={
                    // The link exists only when there is a workspace to check out into; over a
                    // failed poll there is no root to reason about, so nothing offers management.
                    data && !noRoot ? <Link to="/settings/repos">Manage repository checkouts</Link> : undefined
                }
            />
            {/* The executor dialog's credentials detour lands here with the composer's return
                forwarded (issue 261); the banner is the way back to the draft. */}
            <DraftReturnBanner />

            {noRoot ? (
                <WorkspaceRootBanner>
                    This deployment has no workspace root. Tasks cannot run until an operator sets{' '}
                    <code>ORG_WORKSPACE_ROOT</code>.
                </WorkspaceRootBanner>
            ) : null}

            {error ? <p className="status">{error}</p> : null}

            {/* Requiring `data` keeps the failed-poll state honest: with no response there is no
                root to reason about, and the empty-checkout sentence beside the error would claim
                "nothing checked out" as a fact about the workspace rather than about the request. */}
            {data && !noRoot && data.repos.length === 0 ? (
                <section className="panel">
                    <p className="muted">
                        Nothing checked out yet. Enable repositories under Settings → Repositories and they are cloned
                        in the background.
                    </p>
                </section>
            ) : null}

            {/* Deselected repositories are still on disk. Listing them with their sizes — and a
                delete for exactly one of them, behind a confirmation that names what is lost —
                is what makes the growth visible and reclaimable on the page rather than only in
                `df`. The total is checkout usage only: the driver's `.worktrees/` and other
                workspace files are not checkouts. Null renders as an em dash, never a partial
                sum posing as the whole. */}
            {data && !noRoot && data.orphaned.length ? (
                <section className="panel">
                    <h2>Still on disk</h2>
                    <p className="muted">
                        Checkout usage: {bytes(data.checkoutTotalBytes)}. Nothing removes these automatically — they may
                        hold uncommitted work.
                    </p>
                    <ul>
                        {data.orphaned.map((orphan) => (
                            <li key={`${orphan.owner}/${orphan.name}`}>
                                {orphan.owner}/{orphan.name}
                                <span className="muted">
                                    {' '}
                                    · {bytes(orphan.sizeBytes)} · {orphanStateLine(orphan)}
                                </span>{' '}
                                {orphan.status !== 'purging' ? (
                                    <button
                                        type="button"
                                        className="chat-remove"
                                        onClick={() => {
                                            setPurgeError(null);
                                            setAimedAt(orphan);
                                        }}
                                    >
                                        Delete from disk
                                    </button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {aimedAt ? (
                <OrphanDeleteDialog
                    open
                    owner={aimedAt.owner}
                    name={aimedAt.name}
                    purging={purging}
                    error={purgeError}
                    onClose={() => setAimedAt(null)}
                    onConfirm={() => void confirmPurge()}
                />
            ) : null}

            <JiraConnectionsSection scope={USER_CONNECTION_SCOPE} session={session} />

            <ConfigurationScope scope="workspace" />

            {env.error ? <p className="status">{env.error}</p> : null}
            {/* Same data gate as the organization page: the editor mounts only when the scope's
                rows exist, never as an enabled empty draft over a failed read. */}
            <WorkspaceEnvEditor env={env} />
        </>
    );
}
