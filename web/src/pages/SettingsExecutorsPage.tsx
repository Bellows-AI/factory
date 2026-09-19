import { useState } from 'react';
import { useWorkspace, type WorkspaceExecutorFull } from '../api/useWorkspace.js';
import { ExecutorDialog } from '../components/ExecutorDialog.js';
import { WorkspaceExecutorsPanel } from '../panels/WorkspaceExecutorsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Executors section of the settings tree: the member's configured executors and the add/edit
 * dialog (issue 150), moved off the workspace page — executors configure what a runner runs with and
 * have nothing to do with checkouts.
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

    if (loading && !data) {
        return (
            <main>
                <p className="status">Loading your workspace…</p>
            </main>
        );
    }

    return (
        <main>
            {error ? <p className="status">{error}</p> : null}

            <WorkspaceExecutorsPanel
                executors={data?.executors ?? []}
                onAdd={() => void openExecutorDialog(null)}
                onEdit={(name) => void openExecutorDialog(name)}
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
