import { useState } from 'react';
import type { WorkspaceExecutor } from '../api/useWorkspace.js';
import { OrgExecutorConfirmDialog } from '../components/OrgExecutorConfirmDialog.js';
import type { ConfirmRequest } from './org-executor-confirm.js';

/**
 * The personal profile's removal (issue 440): a row click only opens the confirmation, and the
 * confirmed write goes by the id the poll carried for the name the confirmation showed — so only
 * that row goes, never a whole-list rewrite. A row that vanished meanwhile is said, not guessed.
 */
export function PersonalExecutorRemoval({
    request,
    executors,
    removeExecutor,
    onClose,
    onResult,
}: {
    /** The pending removal, or null: no confirmation, no delete. */
    request: ConfirmRequest | null;
    executors: readonly WorkspaceExecutor[];
    removeExecutor: (id: string) => Promise<string | null>;
    onClose: () => void;
    /** The write's failure sentence, or null on success — the page's shared error line. */
    onResult: (message: string | null) => void;
}) {
    const [busy, setBusy] = useState(false);
    const confirmRemoval = async () => {
        if (!request) return;
        const row = executors.find((executor) => executor.name === request.name);
        setBusy(true);
        const message = row ? await removeExecutor(row.id) : `"${request.name}" no longer exists — refresh the page.`;
        setBusy(false);
        onClose();
        onResult(message);
    };
    return (
        <OrgExecutorConfirmDialog
            confirm={request}
            busy={busy}
            onClose={onClose}
            onConfirm={() => void confirmRemoval()}
        />
    );
}
