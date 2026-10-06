import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { WorkspaceExecutorFull } from '../api/useWorkspace.js';
import { DraftReturnBanner } from '../components/DraftReturnBanner.js';
import { ExecutorDialog } from '../components/ExecutorDialog.js';
import { PageHeader } from '../components/PageHeader.js';
import { WorkspaceRootBanner } from '../components/WorkspaceRootBanner.js';
import type { ConfirmRequest } from '../panels/org-executor-confirm.js';
import { OrgExecutorsSection } from '../panels/OrgExecutorsSection.js';
import { PersonalExecutorRemoval } from '../panels/PersonalExecutorRemoval.js';
import { WorkspaceExecutorsPanel } from '../panels/WorkspaceExecutorsPanel.js';
import { ADD_LABEL, EXECUTOR_SCOPE, mergeExecutors } from '../workspace/executors.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Executors section of the settings tree (issue 150, org scope by 391): the member's personal
 * executors and the organization's profiles — managed by admins, selectable by every member —
 * beside the add/edit dialog each opens. The personal surface's save is the whole-list PUT; the
 * organization's state and CRUD live in `OrgExecutorsSection`. The profile type and config
 * together define the runner selected by a task.
 */

/** The personal dialog's state: adding, or editing the row that had this name when it opened. */
type ExecutorDialogState = { mode: 'add' } | { mode: 'edit'; name: string };

export function SettingsExecutorsPage() {
    const { workspace, session } = useSettingsPage();
    const {
        data,
        loading,
        error,
        saving,
        saveExecutors,
        removeExecutor,
        suspendExecutor,
        setDefaultExecutor,
        listExecutorConfigs,
        refresh,
    } = workspace;
    const [executorDialog, setExecutorDialog] = useState<ExecutorDialogState | null>(null);
    /** The personal row awaiting its removal confirmation, or null: no confirmation, no delete. */
    const [removing, setRemoving] = useState<ConfirmRequest | null>(null);
    const [executorList, setExecutorList] = useState<WorkspaceExecutorFull[]>([]);
    const [executorDialogError, setExecutorDialogError] = useState<string | null>(null);
    // The save announcement (issue 261): one always-mounted status region, so a screen reader hears the
    // sentence the moment it changes, and the next dialog open clears it.
    const [savedMessage, setSavedMessage] = useState('');

    /**
     * The personal dialog opens only with the whole list in hand — configs included, one on-demand
     * read — because its save is a whole-list PUT and an edit cannot pre-fill without the row's
     * config. The poll never carries configs, so it cannot serve either half.
     */
    const openExecutorDialog = async (editing: string | null) => {
        setExecutorDialogError(null);
        setSavedMessage('');
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

    /** The personal dialog's save: the validated row folded back into the whole-list PUT. */
    const savePersonal = async (next: Parameters<typeof mergeExecutors>[2], editing: string | null) => {
        const merged = mergeExecutors(executorList, editing, next);
        if (!merged.ok) return merged.error;
        return saveExecutors(merged.value);
    };

    /**
     * The Make default action (issue 391): a per-member preference naming this row's scope — the
     * whole-list PUT the old flag rode is gone. Either scope routes through this one writer.
     */
    const makeDefault = async (scope: 'user' | 'org', name: string): Promise<string | null> => {
        setExecutorDialogError(null);
        return setDefaultExecutor(scope, name);
    };

    /** The personal panel's write, with the failure surfaced on the page's shared error line. */
    const makePersonalDefault = (name: string) =>
        void makeDefault('user', name).then((m) => m && setExecutorDialogError(m));

    /** Suspend or resume one personal row; a failure leaves the row as the poll last said. */
    const suspendPersonal = (id: string, suspended: boolean) => {
        setExecutorDialogError(null);
        void suspendExecutor(id, suspended).then((m) => m && setExecutorDialogError(m));
    };

    // A deliberate configuration, not a failure (same posture as the workspace page): with no
    // root the personal executor routes answer 409 WORKSPACE_DISABLED, so the page refuses before
    // any dialog — the action simply never renders, and the sentence points at workspace setup.
    const noRoot = data !== null && data.root === null;

    if (loading && !data) {
        return (
            <>
                <PageHeader eyebrow="Settings" title="Executors" description={EXECUTOR_SCOPE} />
                <DraftReturnBanner />
                <p className="status">Loading your workspace…</p>
            </>
        );
    }

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Executors"
                description={EXECUTOR_SCOPE}
                actions={
                    data && !noRoot ? (
                        <button type="button" className="primary" onClick={() => void openExecutorDialog(null)}>
                            {ADD_LABEL}
                        </button>
                    ) : undefined
                }
            />
            <DraftReturnBanner />
            <p className="muted" role="status">
                {savedMessage}
            </p>
            {error ? <p className="status">{error}</p> : null}

            {/* Requiring `data` keeps the failed-poll state honest: with no response there is no
                list to reason about, and the empty sentence beside the error would claim
                "nothing configured" as a fact about the workspace rather than the request. */}
            {data ? (
                <>
                    {noRoot ? (
                        <WorkspaceRootBanner>
                            Personal executors are unavailable because this deployment has no workspace root. Tasks
                            cannot run until <Link to="/settings/workspace">workspace setup</Link> is complete.
                        </WorkspaceRootBanner>
                    ) : (
                        <WorkspaceExecutorsPanel
                            executors={data.executors}
                            defaultExecutor={data.defaultExecutor ?? null}
                            onEdit={(name) => void openExecutorDialog(name)}
                            onMakeDefault={makePersonalDefault}
                            onSuspend={suspendPersonal}
                            onRemove={(name) => setRemoving({ action: 'remove', name })}
                            saving={saving}
                        />
                    )}
                    <OrgExecutorsSection
                        executors={data.orgExecutors ?? []}
                        session={session}
                        saving={saving}
                        onError={setExecutorDialogError}
                        onSaved={setSavedMessage}
                        onRefresh={refresh}
                        defaultExecutor={data.defaultExecutor ?? null}
                        onMakeDefault={makeDefault}
                    />
                </>
            ) : null}

            {executorDialogError ? <p className="status">{executorDialogError}</p> : null}
            <PersonalExecutorRemoval
                request={removing}
                executors={data?.executors ?? []}
                removeExecutor={removeExecutor}
                onClose={() => setRemoving(null)}
                onResult={setExecutorDialogError}
            />
            <ExecutorDialog
                open={executorDialog !== null}
                existing={executorList}
                editing={executorDialog?.mode === 'edit' ? executorDialog.name : null}
                onClose={() => setExecutorDialog(null)}
                onSave={savePersonal}
                onSaved={setSavedMessage}
                saving={saving}
            />
        </>
    );
}
