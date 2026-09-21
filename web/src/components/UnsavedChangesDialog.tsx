import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

/**
 * One editor's guarded draft: what the settings area's coordinator knows about it, and the one
 * way to reset it. `discard` reseeds the editor from its own baseline — the coordinator calls it
 * only after the reader answered Discard changes, so the answer is the reset.
 */
export interface UnsavedDraft {
    /** Stable scope id — `'org'`, `'workspace'`, or `repo:owner/name`. */
    id: string;
    /** The scope's human label, carried into the dialog's one-sentence body. */
    label: string;
    dirty: boolean;
    discard: () => void;
}

/**
 * The coordinator API the layout publishes. `registerDraft` returns the unregister call;
 * `confirmDiscard` runs the dialog contract for one draft — e.g. before a repository switch —
 * and resolves true only when the reader chose Discard changes (the caller then performs the
 * switch it was guarding).
 */
export interface GuardApi {
    registerDraft: (draft: UnsavedDraft) => () => void;
    confirmDiscard: (draft: UnsavedDraft) => Promise<boolean>;
}

const UnsavedChangesContext = createContext<GuardApi | null>(null);

/** The settings area's guard, or null outside it — every caller must treat null as unguarded. */
export function useUnsavedChanges(): GuardApi | null {
    return useContext(UnsavedChangesContext);
}

export function UnsavedChangesProvider({ api, children }: { api: GuardApi; children: ReactNode }) {
    return <UnsavedChangesContext.Provider value={api}>{children}</UnsavedChangesContext.Provider>;
}

/**
 * Registers one editor's draft with the area's coordinator for as long as it is mounted, so
 * dirty state can block navigation and raise the one confirmation dialog. Registration follows
 * the dirty flag: a clean draft is registered too (the coordinator learns the scope exists), and
 * flipping to dirty re-registers, which is what arms the route blocker. Outside the settings
 * area — or for a read-only editor — there is nothing to guard and this is a no-op.
 */
export function useGuardedDraft(draft: UnsavedDraft | null): void {
    const guard = useUnsavedChanges();
    const id = draft?.id ?? null;
    const label = draft?.label ?? '';
    const dirty = draft?.dirty ?? false;
    const discard = draft?.discard;
    useEffect(() => {
        if (!guard || id === null || !discard) return;
        return guard.registerDraft({ id, label, dirty, discard });
    }, [guard, id, label, dirty, discard]);
}

/** The dialog's copy, exported pure so the offline suite holds it. */
export function unsavedDialogTitle(): string {
    return 'Discard unsaved changes?';
}

export function unsavedDialogBody(labels: readonly string[]): string {
    return `Your changes to ${labels.join(' and ')} have not been saved.`;
}

/**
 * The `beforeunload` warning, split from its registration so both halves are testable without a
 * window: the handler is the browser's own "are you sure" (the returnValue assignment is what
 * Chrome and Firefox require, alongside the cancel), and the subscription returns its own
 * teardown — the effect that owns it re-runs exactly when dirty state flips, so the listener's
 * lifetime IS the dirty state.
 */
export function beforeUnloadWarning(event: { preventDefault: () => void; returnValue: string }): void {
    event.preventDefault();
    event.returnValue = '';
}

export interface BeforeUnloadTarget {
    addEventListener(
        type: 'beforeunload',
        handler: (event: { preventDefault: () => void; returnValue: string }) => void
    ): void;
    removeEventListener(
        type: 'beforeunload',
        handler: (event: { preventDefault: () => void; returnValue: string }) => void
    ): void;
}

export function subscribeBeforeUnload(
    target: BeforeUnloadTarget,
    handler: (event: { preventDefault: () => void; returnValue: string }) => void
): () => void {
    target.addEventListener('beforeunload', handler);
    return () => target.removeEventListener('beforeunload', handler);
}

/**
 * The discard confirmation (issue 182), one instance raised by the settings layout's coordinator
 * — for a blocked navigation or a guarded repository switch alike, so nested blockers can never
 * duplicate dialogs. `onClose` IS Continue editing: Escape and the backdrop take the safe answer,
 * as does the initially focused button, and Headless UI returns focus to the control that had it
 * when the dialog opened. Discard changes is the destructive edge. Focus trapping and the
 * restore are the library's, exactly as for the remove dialog.
 */
export function UnsavedChangesDialog({
    labels,
    onClose,
    onConfirm,
}: {
    labels: readonly string[];
    onClose: () => void;
    onConfirm: () => void;
}) {
    const continueRef = useRef<HTMLButtonElement>(null);
    return (
        <Dialog open onClose={onClose} className="dialog-layer" initialFocus={continueRef}>
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="unsaved">
                    {/* The page's one h1 is the header's; a dialog title is an h2. */}
                    <DialogTitle as="h2" className="unsaved-title">
                        {unsavedDialogTitle()}
                    </DialogTitle>
                    <p>{unsavedDialogBody(labels)}</p>
                    <div className="unsaved-actions">
                        <button ref={continueRef} type="button" className="chat-resume" onClick={onClose}>
                            Continue editing
                        </button>
                        <button type="button" className="chat-remove" onClick={onConfirm}>
                            Discard changes
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
