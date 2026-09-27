import { type ReactNode, createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import type { Session } from './api/useSession.js';
import type { DefaultStepOverrides, freshWorkflowDraft } from './task-composer.js';

type WorkflowDraft = ReturnType<typeof freshWorkflowDraft>;

/**
 * The composer's in-progress task, held above the routed page so a trip to Settings and back
 * finds it where the member left it. In memory only: a reload is a fresh start.
 */
export interface ComposerDraftState {
    /** `${organization.id}:${user.id}` of the session that saved it. */
    owner: string;
    draft: string;
    executor: string;
    repo: string;
    repoTouched: boolean;
    workflowRepo: string;
    workflow: string;
    storedParams: WorkflowDraft['storedParams'];
    paramTouched: WorkflowDraft['paramTouched'];
    defaultStepOverrides: DefaultStepOverrides;
}

/** What the composer hands over; the store stamps the owner itself. */
export type ComposerDraftInput = Omit<ComposerDraftState, 'owner'>;

export interface ComposerDraftStore {
    state: ComposerDraftState | null;
    save(next: ComposerDraftInput): void;
    clear(): void;
}

type DraftAction = { type: 'save'; next: ComposerDraftInput; owner: string } | { type: 'clear' };

export function draftOwner(session: Session | null): string | null {
    return session ? `${session.organization.id}:${session.user.id}` : null;
}

export function composerDraftReducer(_held: ComposerDraftState | null, action: DraftAction): ComposerDraftState | null {
    return action.type === 'save' ? { ...action.next, owner: action.owner } : null;
}

/**
 * The held draft, only for the session that saved it: after a sign-out and a different sign-in,
 * the next account reads null. An org switch needs no check here — `switchOrg` reloads the page
 * (api/org.ts), and the reload drops this in-memory state with everything else.
 */
export function ownedDraft(held: ComposerDraftState | null, owner: string | null): ComposerDraftState | null {
    return owner !== null && held?.owner === owner ? held : null;
}

const ComposerDraftContext = createContext<ComposerDraftStore | null>(null);

export function ComposerDraftProvider({ session, children }: { session: Session | null; children: ReactNode }) {
    const [held, dispatch] = useReducer(composerDraftReducer, null);
    const owner = draftOwner(session);
    // `save` and `clear` keep their identity across saves on purpose: a composer that syncs from
    // an effect lists them as dependencies, and a `save` that changed with the state would loop.
    // A save with no session yet has no owner to stamp, and is dropped.
    const save = useCallback(
        (next: ComposerDraftInput) => {
            if (owner !== null) dispatch({ type: 'save', next, owner });
        },
        [owner]
    );
    const clear = useCallback(() => dispatch({ type: 'clear' }), []);
    const value = useMemo(() => ({ state: ownedDraft(held, owner), save, clear }), [held, owner, save, clear]);
    return <ComposerDraftContext.Provider value={value}>{children}</ComposerDraftContext.Provider>;
}

export function useComposerDraftStore(): ComposerDraftStore {
    const value = useContext(ComposerDraftContext);
    if (!value) throw new Error('useComposerDraftStore must be used within a ComposerDraftProvider');
    return value;
}
