import { ADMIN_ROLE } from '@factory-ai/core';
import { useState } from 'react';
import {
    changeOrgExecutorScope,
    createOrgExecutor,
    deleteOrgExecutor,
    listOrgExecutorConfigs,
    suspendOrgExecutor,
    updateOrgExecutor,
    type OrgExecutorFull,
} from '../api/orgExecutors.js';
import type { DefaultExecutor, OrgExecutor } from '../api/useWorkspace.js';
import { ExecutorDialog } from '../components/ExecutorDialog.js';
import { OrgExecutorConfirmDialog } from '../components/OrgExecutorConfirmDialog.js';
import type { Session } from '../api/useSession.js';
import { confirmedWrite, type OrgRowConfirm } from './org-executor-confirm.js';
import { OrgExecutorsPanel } from './OrgExecutorsPanel.js';

/**
 * The organization executors' interactive half (issue 391): the panel (read-only metadata for a
 * member, management actions for an admin) and the add/edit dialog it opens, with the admin CRUD
 * those actions call. Split out of `SettingsExecutorsPage` so the page stays the two sections'
 * composition; the org surface owns its state because its writes are id-based CRUD, not the
 * personal list's whole-list PUT.
 */

/** The dialog's state, id-keyed like the org CRUD routes. */
type OrgDialogState = { mode: 'add' } | { mode: 'edit'; id: string };

export function OrgExecutorsSection({
    executors,
    session,
    saving,
    onError,
    onSaved,
    onRefresh,
    defaultExecutor,
    onMakeDefault,
}: {
    executors: readonly OrgExecutor[];
    /** The role decides the management actions; null (no session) reads as member. */
    session: Session | null;
    saving: boolean;
    /** The page's one error line, shared with the personal surface's failures. */
    onError: (message: string | null) => void;
    /** The page's save announcement. */
    onSaved: (message: string) => void;
    /**
     * The workspace poll's re-arm (`workspace.refresh`): the poll stops once it returns a settled
     * answer, so a successful org write must re-arm it or `data.orgExecutors` — this table's rows
     * — stays stale until the page reloads.
     */
    onRefresh: () => void;
    defaultExecutor: DefaultExecutor | null;
    /** Stores the member's default preference; the same hook the personal panel's action calls. */
    onMakeDefault: (scope: 'user' | 'org', name: string) => Promise<string | null>;
}) {
    const isAdmin = session?.role === ADMIN_ROLE;
    const [dialog, setDialog] = useState<OrgDialogState | null>(null);
    const [list, setList] = useState<OrgExecutorFull[]>([]);
    /** The pending ownership-changing action, or null: no confirmation, no write (issue 411). */
    const [confirm, setConfirm] = useState<OrgRowConfirm | null>(null);
    const [confirming, setConfirming] = useState(false);

    /** The dialog opens with the org list — configs included for an admin, one on-demand read. */
    const openDialog = async (editing: string | null) => {
        onError(null);
        onSaved('');
        const result = await listOrgExecutorConfigs();
        if (!result.ok) {
            onError(result.error);
            return;
        }
        if (editing !== null && !result.executors.some((executor) => executor.name === editing)) {
            onError(`"${editing}" no longer exists — refresh the page.`);
            return;
        }
        setList(result.executors);
        setDialog(
            editing === null
                ? { mode: 'add' }
                : { mode: 'edit', id: result.executors.find((executor) => executor.name === editing)!.id }
        );
    };

    /** The dialog's save: the validated row written through the org CRUD route it belongs to. */
    const save = async (next: Parameters<typeof createOrgExecutor>[0], editing: string | null) => {
        // `editing` is the row's original NAME — the dialog's edit contract — matched against the
        // list as it opened, exactly the way the personal page's mergeExecutors matches.
        const message = await (editing === null
            ? createOrgExecutor(next)
            : updateOrgExecutor(list.find((executor) => executor.name === editing)!.id, next));
        if (!message) onRefresh();
        return message;
    };

    /**
     * The row actions resolve the row by name through the on-demand admin read — the poll's
     * metadata carries no ids, and the actions are rare human clicks, never a per-tick fetch.
     */
    const withRow = async (name: string, act: (row: OrgExecutorFull) => Promise<string | null>): Promise<void> => {
        onError(null);
        const result = await listOrgExecutorConfigs();
        if (!result.ok) {
            onError(result.error);
            return;
        }
        const row = result.executors.find((executor) => executor.name === name);
        if (!row) {
            onError(`"${name}" no longer exists — refresh the page.`);
            return;
        }
        const message = await act(row);
        if (message) {
            onError(message);
            return;
        }
        onRefresh();
    };

    /**
     * The confirmed write (issue 411): the only place Delete and Make personal reach their routes.
     * A row click opens the confirmation and nothing else — both actions are org-wide and take the
     * profile away from every other member, so neither may happen on one unguarded click.
     */
    const runConfirmed = async (): Promise<void> => {
        if (!confirm) return;
        setConfirming(true);
        await withRow(confirm.name, (row) =>
            confirmedWrite(confirm.action, row, {
                remove: deleteOrgExecutor,
                demote: (id) => changeOrgExecutorScope(id, 'user'),
            })
        );
        setConfirming(false);
        setConfirm(null);
    };

    return (
        <>
            <OrgExecutorsPanel
                executors={executors}
                isAdmin={isAdmin}
                saving={saving}
                defaultName={defaultExecutor?.scope === 'org' ? defaultExecutor.name : null}
                onAdd={isAdmin ? () => void openDialog(null) : undefined}
                onEdit={isAdmin ? (name) => void openDialog(name) : undefined}
                onDelete={isAdmin ? (name) => setConfirm({ action: 'delete', name }) : undefined}
                onDemote={isAdmin ? (name) => setConfirm({ action: 'demote', name }) : undefined}
                onSuspend={
                    isAdmin
                        ? (name, suspended) => void withRow(name, (row) => suspendOrgExecutor(row.id, suspended))
                        : undefined
                }
                onMakeDefault={(name) => void onMakeDefault('org', name).then((message) => message && onError(message))}
            />
            <OrgExecutorConfirmDialog
                confirm={confirm}
                busy={confirming}
                onClose={() => setConfirm(null)}
                onConfirm={() => void runConfirmed()}
            />
            <ExecutorDialog
                open={dialog !== null}
                existing={list}
                editing={dialog?.mode === 'edit' ? (list.find((row) => row.id === dialog.id)?.name ?? null) : null}
                onClose={() => setDialog(null)}
                onSave={save}
                onSaved={onSaved}
                saving={saving}
            />
        </>
    );
}
