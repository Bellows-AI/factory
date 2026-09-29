import { useRef } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

/**
 * The manual purge's confirmation (issue #92), exported pure so the offline suite holds it the
 * way TaskRemoveDialog's copy is held. The body states every consequence the delete contract
 * actually has, because this is the one place the member is told before the tree goes: the
 * checkout's uncommitted work AND its local `factory/<root>` task branches — the branches a
 * follow-up would have reused — are lost, and the clone comes down with them. Published branches
 * and pull requests live on GitHub and are not touched. There is no bulk, no admin override and
 * no undo: one orphan, one member, deliberately.
 */
export function orphanDeleteDialogTitle(owner: string, name: string): string {
    return `Delete ${owner}/${name} from disk?`;
}

export function orphanDeleteDialogBody(): string {
    return (
        'This deletes the clone from this member\u2019s workspace. Any uncommitted work in the ' +
        'checkout and its local factory/<task> branches are permanently lost. Published branches ' +
        'and pull requests on GitHub are not affected. The checkout can be re-cloned later, but ' +
        'this cannot be undone.'
    );
}

/**
 * The accessible face of Delete from disk: a presentational Headless UI `Dialog` in the
 * TaskRemoveDialog shape. `initialFocus` lands on Cancel, so the destructive answer is never the
 * first thing a keypress reaches; mid-request the dialog refuses to close and the confirm button
 * reads Deleting…; a refusal keeps it open and is announced once, as an alert.
 */
export function OrphanDeleteDialog({
    open,
    owner,
    name,
    purging,
    error,
    onClose,
    onConfirm,
}: {
    /** Controlled by the page — the row's Delete action opens this, never mutates. */
    open: boolean;
    owner: string;
    name: string;
    /** The page's in-flight guard: the mutation is one request, and it cannot be dismissed. */
    purging: boolean;
    /** The board's refusal, announced once as an alert inside the open dialog. */
    error: string | null;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open={open}
            onClose={() => {
                if (!purging) onClose();
            }}
            className="dialog-layer"
            initialFocus={cancelRef}
        >
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="dialog task-remove">
                    {/* The page's one h1 is the header's; a dialog title is an h2. */}
                    <DialogTitle as="h2" className="task-remove-title">
                        {orphanDeleteDialogTitle(owner, name)}
                    </DialogTitle>
                    <p>{orphanDeleteDialogBody()}</p>
                    {error !== null ? (
                        <p className="status error" role="alert">
                            {error}
                        </p>
                    ) : null}
                    <div className="task-remove-actions">
                        <button
                            ref={cancelRef}
                            type="button"
                            className="chat-resume"
                            onClick={onClose}
                            disabled={purging}
                        >
                            Cancel
                        </button>
                        <button type="button" className="chat-remove" onClick={onConfirm} disabled={purging}>
                            {purging ? 'Deleting\u2026' : 'Delete from disk'}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
