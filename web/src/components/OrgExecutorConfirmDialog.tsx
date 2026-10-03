import { useRef } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import {
    confirmBody,
    confirmBusyLabel,
    confirmLabel,
    confirmTitle,
    type OrgRowConfirm,
} from '../panels/org-executor-confirm.js';

/**
 * The accessible face of the org executor row's Delete and Make personal (issue 411), in the
 * TaskRemoveDialog/OrphanDeleteDialog shape: the shared `dialog` panel at the remove dialog's
 * width, `initialFocus` on Cancel so the ownership-changing answer is never the first thing a
 * keypress reaches, and no dismissal mid-request. Presentational — the section owns the write.
 */
export function OrgExecutorConfirmDialog({
    confirm,
    busy,
    onClose,
    onConfirm,
}: {
    /** The pending action and the row it names, or null when nothing is pending. */
    confirm: OrgRowConfirm | null;
    /** The in-flight guard: the mutation is one request, and it cannot be dismissed. */
    busy: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open={confirm !== null}
            onClose={() => {
                if (!busy) onClose();
            }}
            className="dialog-layer"
            initialFocus={cancelRef}
        >
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="dialog task-remove">
                    {/* The page's one h1 is the header's; a dialog title is an h2. */}
                    <DialogTitle as="h2" className="task-remove-title">
                        {confirm ? confirmTitle(confirm) : ''}
                    </DialogTitle>
                    <p>{confirm ? confirmBody(confirm) : ''}</p>
                    <div className="task-remove-actions">
                        <button ref={cancelRef} type="button" className="chat-resume" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        {/* Only the delete is destructive. A red "Make personal" would overstate a
                            scope move an admin can undo by promoting the row back. */}
                        <button
                            type="button"
                            className={confirm?.action === 'demote' ? 'primary' : 'chat-remove'}
                            onClick={onConfirm}
                            disabled={busy}
                        >
                            {confirm ? (busy ? confirmBusyLabel(confirm) : confirmLabel(confirm)) : ''}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
