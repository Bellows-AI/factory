import { useEffect, useState } from 'react';
import { RepoPickerDialog } from '../components/RepoPickerDialog.js';
import { WorkspaceReposPanel } from '../panels/WorkspaceReposPanel.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Workspace section of the settings tree: the workspace's info and controls, the repositories
 * checked out into it and the picker that selects them, and the member's own environment scope
 * (issue 150).
 *
 * The picker is offered automatically the first time the page is seen with nothing selected, and
 * only then — the dismissal is remembered for this page view, the persistent ways back in are the
 * button and the empty state.
 */
export function SettingsWorkspacePage() {
    const { workspace, env } = useSettingsPage();
    const { data, loading, error, saving, save } = workspace;
    const [picking, setPicking] = useState(false);
    /**
     * Dismissal is remembered for this page view only, so "Not now" is not a decision somebody has
     * to undo later. The persistent way back in is the button below and the empty state.
     */
    const [dismissed, setDismissed] = useState(false);

    /*
     * `root !== null` is not optional: local development and the `chromium` browser check both run
     * with no workspace root, and a dialog appearing there would break a suite that is about the
     * dashboard. Same posture as `data.telemetry ? … : null` — nothing renders for a feature this
     * deployment does not have.
     */
    useEffect(() => {
        if (!data || dismissed) return;
        if (data.root !== null && data.repos.length === 0) setPicking(true);
    }, [data, dismissed]);

    const close = () => {
        setPicking(false);
        setDismissed(true);
    };

    if (loading && !data) {
        return (
            <>
                <p className="status">Loading your workspace…</p>
            </>
        );
    }

    // A deliberate configuration, not a failure — hence the sentence rather than an error. It
    // takes the place of the checkout panels only: the member's environment scope is unrelated
    // to whether a root is configured and still renders below (issue 150 — on the old Environment
    // page it rendered on every deployment, and this keeps that true).
    const noRoot = data !== null && data.root === null;

    return (
        <>
            {error ? <p className="status">{error}</p> : null}

            {noRoot ? (
                <section className="panel">
                    <h2>Workspace</h2>
                    <p className="muted">
                        This deployment has no workspace root configured, so no repositories are checked out. Set{' '}
                        <code>ORG_WORKSPACE_ROOT</code> to turn it on.
                    </p>
                </section>
            ) : (
                <>
                    <section className="panel">
                        <div className="panel-head">
                            <h2>Workspace</h2>
                            {/* The picker seeds itself from the workspace selection, so it exists
                                only when that selection is in hand — opened over a failed poll it
                                would read "nothing selected" and its whole-list save would
                                deselect every checkout. */}
                            {data ? (
                                <button type="button" className="primary" onClick={() => setPicking(true)}>
                                    Select repositories
                                </button>
                            ) : null}
                        </div>
                        {data ? (
                            <p className="muted">
                                Your checkouts live at <code>{data.root}</code>. Agents you start run here.
                            </p>
                        ) : null}
                    </section>

                    {data && data.repos.length ? (
                        <WorkspaceReposPanel repos={data.repos} />
                    ) : (
                        <section className="panel">
                            <p className="muted">
                                Nothing checked out yet. Choose repositories and they are cloned in the background.
                            </p>
                        </section>
                    )}

                    {/* Deselected repositories are still on disk: nothing prunes, and per-member
                        checkouts multiply that by the number of members. Listing them is what makes
                        the growth visible on the page rather than only in `df`. */}
                    {data && data.orphaned.length ? (
                        <section className="panel">
                            <h2>Still on disk</h2>
                            <p className="muted">
                                These are no longer selected, but their checkouts have not been removed — they may hold
                                uncommitted work, so nothing deletes them automatically.
                            </p>
                            <ul>
                                {data.orphaned.map((repo) => (
                                    <li key={`${repo.owner}/${repo.name}`}>
                                        {repo.owner}/{repo.name}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : null}

                    <RepoPickerDialog
                        open={picking}
                        selected={data?.repos ?? []}
                        onClose={close}
                        onSave={save}
                        saving={saving}
                    />
                </>
            )}

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
