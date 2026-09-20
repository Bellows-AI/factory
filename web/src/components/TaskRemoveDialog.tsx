import { useRef } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { taskTitleFromCommand } from '../task-tree.js';

/**
 * The remove confirmation's copy, exported pure so the offline suite holds it: the title names
 * the task — the root command's first line, the same name the page's h1 carries — and the body
 * states every consequence the board's remove contract actually has. Factory rows are deleted
 * immediately; the worktree's reclamation is queued; published branches and pull requests live
 * on GitHub and are not touched. No ceremony on top: the consequence IS the confirmation.
 */
export function removeDialogTitle(command: string): string {
    return `Remove \u201C${taskTitleFromCommand(command)}\u201D?`;
}

export function removeDialogBody(runCount: number): string {
    return (
        `This permanently deletes all ${runCount} runs and their transcript from Factory. ` +
        `Its worktree will be queued for deletion. Published branches and pull requests are not ` +
        `deleted. This cannot be undone.`
    );
}

/**
 * The accessible face of Remove task (issue 178): a presentational Headless UI `Dialog` that
 * replaced the `window.confirm` the header used to lean on. Focus trapping, Escape, the backdrop
 * and focus restoration to the menu trigger are the library's; `initialFocus` lands on Cancel, so
 * the destructive answer is never the first thing a keypress reaches.
 *
 * Mid-request the dialog is the whole world: `onClose` refuses (Escape and the backdrop included),
 * both buttons disable, and the confirm button reads Removing… — a request in flight must not be
 * dismissable into a state nobody can see. A refusal keeps the dialog open and is announced once,
 * as an alert; the page navigates to the inbox only on success, so a failed remove leaves the
 * reader exactly where the decision was made.
 */
export function TaskRemoveDialog({
    open,
    command,
    runCount,
    removing,
    error,
    onClose,
    onConfirm,
}: {
    /** Controlled by the page — the menu item in the header opens this, never mutates. */
    open: boolean;
    /** The thread's ROOT command; the title derives its first line from it. */
    command: string;
    /** The thread's whole length — every run the removal deletes. */
    runCount: number;
    /** The page's in-flight guard: the mutation is one request, and it cannot be dismissed. */
    removing: boolean;
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
                if (!removing) onClose();
            }}
            className="dialog-layer"
            initialFocus={cancelRef}
        >
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="task-remove">
                    {/* The page's one h1 is the header's; a dialog title is an h2. */}
                    <DialogTitle as="h2" className="task-remove-title">
                        {removeDialogTitle(command)}
                    </DialogTitle>
                    <p>{removeDialogBody(runCount)}</p>
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
                            disabled={removing}
                        >
                            Cancel
                        </button>
                        <button type="button" className="chat-remove" onClick={onConfirm} disabled={removing}>
                            {removing ? 'Removing\u2026' : 'Remove task'}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
