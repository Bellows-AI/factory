import { useRef } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useNavigate } from 'react-router-dom';
import { withDraftReturn } from './DraftReturnBanner.js';

/** The settings page that selects and syncs repositories — where this dialog sends the member. */
export const REPOSITORIES_PATH = '/settings/repos';

export const NO_SYNCED_REPOS_TITLE = 'No repos synced';
export const NO_SYNCED_REPOS_MESSAGE =
    'Go to the Repositories page to select and sync a repository before running a task.';

/**
 * The composer's answer to a launch attempt with no synced repository (issue 263). Go to
 * Repositories carries the draft-return marker, so the draft the shell holds is one click away on
 * the way back; Cancel, Escape and the backdrop close it and keep the draft. Headless UI traps
 * focus and returns it to the control that opened the dialog — the Start button or whichever field
 * held Ctrl/⌘+Enter. Cancel takes the initial focus: the safe answer, as in the discard dialog.
 */
export function NoSyncedReposDialog({ onClose }: { onClose: () => void }) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    const navigate = useNavigate();
    return (
        <Dialog open onClose={onClose} className="dialog-layer" initialFocus={cancelRef}>
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="dialog unsaved">
                    {/* The page's one h1 is the header's; a dialog title is an h2. */}
                    <DialogTitle as="h2" className="unsaved-title">
                        {NO_SYNCED_REPOS_TITLE}
                    </DialogTitle>
                    <p>{NO_SYNCED_REPOS_MESSAGE}</p>
                    <div className="unsaved-actions">
                        <button ref={cancelRef} type="button" className="chat-resume" onClick={onClose}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="primary"
                            onClick={() => void navigate(withDraftReturn(REPOSITORIES_PATH))}
                        >
                            Go to Repositories
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
