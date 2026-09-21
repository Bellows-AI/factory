import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorkspace, type WorkspaceExecutorFull } from '../api/useWorkspace.js';
import { ExecutorDialog } from '../components/ExecutorDialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { EXECUTOR_GUIDANCE, WorkspaceExecutorsPanel } from '../panels/WorkspaceExecutorsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Executors section of the settings tree: the member's configured executors and the add/edit
 * dialog (issue 150), moved off the workspace page — executors configure what a runner runs with
 * and have nothing to do with checkouts. The page header owns the section's one action, "Add
 * executor"; the panel below is the list itself. Issue 183 adds the honest framing: what the
 * page's sentence says an executor controls (label and config) versus what the deployment
 * controls (runner CLI and image).
 */

/** The executor dialog's state: adding, or editing the row that had this name when it opened. */
type ExecutorDialogState = { mode: 'add' } | { mode: 'edit'; name: string };

export function SettingsExecutorsPage() {
    const { workspace } = useSettingsPage();
    const { data, loading, error, saving, saveExecutors, listExecutorConfigs } = workspace;
    const [executorDialog, setExecutorDialog] = useState<ExecutorDialogState | null>(null);
    const [executorList, setExecutorList] = useState<WorkspaceExecutorFull[]>([]);
    const [executorDialogError, setExecutorDialogError] = useState<string | null>(null);

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

    // A deliberate configuration, not a failure (same posture as the workspace page): with no
    // root the executor routes answer 409 WORKSPACE_DISABLED, so the page refuses before any
    // dialog — the action simply never renders, and the sentence points at workspace setup.
    const noRoot = data !== null && data.root === null;

    if (loading && !data) {
        return (
            <>
                <PageHeader
                    eyebrow="Settings"
                    title="Executors"
                    description="Name the personal runner configuration offered when you start a task."
                />
                <p className="status">Loading your workspace…</p>
            </>
        );
    }

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Executors"
                description="Name the personal runner configuration offered when you start a task."
                actions={
                    data && !noRoot ? (
                        <button type="button" className="primary" onClick={() => void openExecutorDialog(null)}>
                            Add executor
                        </button>
                    ) : undefined
                }
            />
            {error ? <p className="status">{error}</p> : null}

            {/* Requiring `data` keeps the failed-poll state honest: with no response there is no
                list to reason about, and the empty sentence beside the error would claim
                "nothing configured" as a fact about the workspace rather than the request. */}
            {data && noRoot ? (
                <section className="panel">
                    <h2>My workspace</h2>
                    <p className="muted">{EXECUTOR_GUIDANCE}</p>
                    <p className="status">
                        Personal executors are unavailable because this deployment has no workspace root. Tasks cannot
                        run until <Link to="/settings/workspace">workspace setup</Link> is complete.
                    </p>
                </section>
            ) : data ? (
                <WorkspaceExecutorsPanel executors={data.executors} onEdit={(name) => void openExecutorDialog(name)} />
            ) : null}

            {executorDialogError ? <p className="status">{executorDialogError}</p> : null}
            <ExecutorDialog
                open={executorDialog !== null}
                existing={executorList}
                editing={executorDialog?.mode === 'edit' ? executorDialog.name : null}
                onClose={() => setExecutorDialog(null)}
                onSave={saveExecutors}
                saving={saving}
            />
        </>
    );
}
