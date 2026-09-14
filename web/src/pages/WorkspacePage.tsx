import { useEffect, useState } from 'react';
import { useWorkspace, type WorkspaceExecutorFull } from '../api/useWorkspace.js';
import { ExecutorDialog } from '../components/ExecutorDialog.js';
import { RepoPickerDialog } from '../components/RepoPickerDialog.js';
import { WorkspaceExecutorsPanel } from '../panels/WorkspaceExecutorsPanel.js';
import { WorkspaceReposPanel } from '../panels/WorkspaceReposPanel.js';

/** The executor dialog's state: adding, or editing the row that had this name when it opened. */
type ExecutorDialogState = { mode: 'add' } | { mode: 'edit'; name: string };

export function WorkspacePage() {
    const { data, loading, error, saving, save, saveExecutors, listExecutorConfigs } = useWorkspace();
    const [picking, setPicking] = useState(false);
    const [executorDialog, setExecutorDialog] = useState<ExecutorDialogState | null>(null);
    const [executorList, setExecutorList] = useState<WorkspaceExecutorFull[]>([]);
    const [executorDialogError, setExecutorDialogError] = useState<string | null>(null);
    /**
     * Dismissal is remembered for this page view only, so "Not now" is not a decision somebody has
     * to undo later. The persistent way back in is the button below and the empty state.
     */
    const [dismissed, setDismissed] = useState(false);

    /*
     * Offered automatically the first time, and only then.
     *
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

    /**
     * The dialog opens only with the whole list in hand — configs included, one on-demand read —
     * because its save is a whole-list PUT and an edit cannot pre-fill without the row's config.
     * The poll never carries configs, so it cannot serve either half.
     */
    const openExecutorDialog = async (editing: string | null) => {
        setExecutorDialogError(null);
        const result = await listExecutorConfigs();
        if (!result.ok) {
            setExecutorDialogError(result.error);
            return;
        }
        if (editing !== null && !result.executors.some((executor) => executor.name === editing)) {
            // The row vanished between the panel's render and this click — removed in another tab,
            // most likely. Saving over the fetched list would silently confirm that delete; a
            // sentence says so instead.
            setExecutorDialogError(`"${editing}" no longer exists — refresh the page.`);
            return;
        }
        setExecutorList(result.executors);
        setExecutorDialog(editing === null ? { mode: 'add' } : { mode: 'edit', name: editing });
    };

    if (loading && !data) {
        return (
            <main>
                <p className="status">Loading your workspace…</p>
            </main>
        );
    }

    // A deliberate configuration, not a failure — hence the sentence rather than an error.
    if (data && data.root === null) {
        return (
            <main>
                <section className="panel">
                    <h2>Workspace</h2>
                    <p className="muted">
                        This deployment has no workspace root configured, so no repositories are checked out. Set{' '}
                        <code>ORG_WORKSPACE_ROOT</code> to turn it on.
                    </p>
                </section>
            </main>
        );
    }

    return (
        <main>
            {error ? <p className="status">{error}</p> : null}

            <section className="panel">
                <div className="panel-head">
                    <h2>Workspace</h2>
                    <button type="button" className="primary" onClick={() => setPicking(true)}>
                        Select repositories
                    </button>
                </div>
                <p className="muted">
                    Your checkouts live at <code>{data?.root}</code>. Agents you start run here.
                </p>
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

            {/* Deselected repositories are still on disk: nothing prunes, and per-member checkouts
                multiply that by the number of members. Listing them is what makes the growth
                visible on the page rather than only in `df`. */}
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

            <WorkspaceExecutorsPanel
                executors={data?.executors ?? []}
                onAdd={() => void openExecutorDialog(null)}
                onEdit={(name) => void openExecutorDialog(name)}
            />

            <RepoPickerDialog
                open={picking}
                selected={data?.repos ?? []}
                onClose={close}
                onSave={save}
                saving={saving}
            />
            {executorDialogError ? <p className="status">{executorDialogError}</p> : null}
            <ExecutorDialog
                open={executorDialog !== null}
                existing={executorList}
                editing={executorDialog?.mode === 'edit' ? executorDialog.name : null}
                onClose={() => setExecutorDialog(null)}
                onSave={saveExecutors}
                saving={saving}
            />
        </main>
    );
}
