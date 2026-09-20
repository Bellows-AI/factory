import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Workspace section of the settings tree, simplified to what is personal (issue 181): the
 * workspace root, the member's own environment scope, and the orphaned checkouts still on disk.
 *
 * Selecting repositories moved to Settings → Repositories, where the installation list, the
 * checkout statuses and the per-repository configuration live; the page links there instead of
 * hosting a second selection surface. What stays here is the one scope only this member owns.
 */
export function SettingsWorkspacePage() {
    const { workspace, env } = useSettingsPage();
    const { data, loading, error } = workspace;

    // A deliberate configuration, not a failure — hence the sentence rather than an error. It
    // takes the place of the checkout link only: the member's environment scope is unrelated to
    // whether a root is configured and still renders below (issue 150 — on the old Environment
    // page it rendered on every deployment, and this keeps that true).
    const noRoot = data !== null && data.root === null;

    if (loading && !data) {
        return (
            <>
                <PageHeader eyebrow="Settings" title="Workspace" />
                <p className="status">Loading your workspace…</p>
            </>
        );
    }

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Workspace"
                description={
                    noRoot ? (
                        <>
                            This deployment has no workspace root. Tasks cannot run until an operator sets{' '}
                            <code>ORG_WORKSPACE_ROOT</code>.
                        </>
                    ) : data ? (
                        <>
                            Your checkouts live at <code>{data.root}</code>. Agents you start run here.
                        </>
                    ) : undefined
                }
                actions={
                    // The link exists only when there is a workspace to check out into; over a
                    // failed poll there is no root to reason about, so nothing offers management.
                    data && !noRoot ? <Link to="/settings/repos">Manage repository checkouts</Link> : undefined
                }
            />

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

            {/* Deselected repositories are still on disk: nothing prunes, and per-member
                checkouts multiply that by the number of members. Listing them is what makes
                the growth visible on the page rather than only in `df`. Nothing here deletes. */}
            {data && data.orphaned.length ? (
                <section className="panel">
                    <h2>Still on disk</h2>
                    <p className="muted">Nothing removes these automatically — they may hold uncommitted work.</p>
                    <ul>
                        {data.orphaned.map((repo) => (
                            <li key={`${repo.owner}/${repo.name}`}>
                                {repo.owner}/{repo.name} — no longer enabled; its checkout remains on disk.
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {env.error ? <p className="status">{env.error}</p> : null}
            {/* Same data gate as the organization page: the editor mounts only when the scope's
                rows exist, never as an enabled empty draft over a failed read. */}
            {env.loading && !env.data ? (
                <p className="status">Loading environment…</p>
            ) : env.data ? (
                <EnvVarsPanel
                    title="My workspace"
                    hint="Your own defaults, on every task you queue."
                    initialVars={env.data.workspace}
                    onSave={env.saveWorkspace}
                />
            ) : null}
        </>
    );
}
