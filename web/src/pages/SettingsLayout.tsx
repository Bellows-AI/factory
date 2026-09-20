import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useBlocker, useOutletContext } from 'react-router-dom';
import { useEnv } from '../api/useEnv.js';
import type { UseEnv } from '../api/useEnv.js';
import { useWorkspace } from '../api/useWorkspace.js';
import type { UseWorkspace } from '../api/useWorkspace.js';
import { useShell } from '../components/AppShell.js';
import type { ShellContext } from '../components/AppShell.js';
import {
    beforeUnloadWarning,
    subscribeBeforeUnload,
    UnsavedChangesDialog,
    UnsavedChangesProvider,
} from '../components/UnsavedChangesDialog.js';
import type { GuardApi, UnsavedDraft } from '../components/UnsavedChangesDialog.js';

/**
 * The layout route of the settings area: `/settings` and everything under it.
 *
 * It owns the two configuration polls the four sections share. The workspace poll feeds the
 * workspace page (root, repos, orphaned checkouts) AND the executors page (the rows and the
 * whole-list PUT), so it must be ONE instance above both; the environment poll feeds the org,
 * workspace and per-repository editors, and its after-save refetch exists to keep the repository
 * select's options tracking the store. Navigating between the sections refetches nothing, and
 * leaving the area unmounts both — the same route-scoping by mount that TasksLayout gives
 * `/tasks*`, and the reason the sidenav can stay poll-free.
 *
 * It also owns the area's ONE unsaved-change guard (issue 182): the editors register their scope
 * drafts here while they are dirty, and this layout turns that into the three protections the
 * reader can rely on — a `beforeunload` warning for the browser, a React Router blocker for
 * in-app navigation, and one discard confirmation dialog for both the blocker and the guarded
 * repository switch. One pending slot means nested blockers cannot duplicate dialogs: there is
 * exactly one blocker (this one) and one dialog (this one), whatever nests below.
 *
 * `useOutletContext` returns the NEAREST provider, so an Outlet context of just the polls would
 * shadow the shell's and strip the shared task poll and the session off every page below. This
 * route is a direct child of the shell's Outlet, so it reads the shell context HERE and
 * re-publishes it with the polls added — one context, everything below. The guard rides its own
 * React context, so the outlet context keeps exactly the shape it had.
 */
export interface SettingsPageContext extends ShellContext {
    workspace: UseWorkspace;
    env: UseEnv;
}

/** Typed access to what this layout route publishes. */
export function useSettingsPage(): SettingsPageContext {
    return useOutletContext<SettingsPageContext>();
}

/** What the single dialog is currently answering: a blocked navigation, or a guarded switch. */
type PendingGuard =
    | { kind: 'route'; proceed: () => void; reset: () => void }
    | { kind: 'draft'; draft: UnsavedDraft; resolve: (discardConfirmed: boolean) => void };

export function SettingsLayout() {
    const shell = useShell();
    const workspace = useWorkspace();
    const env = useEnv();

    // The registry of mounted editors' drafts. Registration follows the dirty flag (the editor's
    // hook re-registers when it flips), so `dirtyIds` recomputes exactly when dirtiness does,
    // and the blocker's armed state IS the dirty state.
    const drafts = useRef(new Map<string, UnsavedDraft>());
    const [dirtyIds, setDirtyIds] = useState<string[]>([]);
    const dirtyDrafts = () => [...drafts.current.values()].filter((draft) => draft.dirty);

    const [pending, setPending] = useState<PendingGuard | null>(null);

    const registerDraft = useCallback((draft: UnsavedDraft) => {
        drafts.current.set(draft.id, draft);
        setDirtyIds(
            [...drafts.current.values()].filter((candidate) => candidate.dirty).map((candidate) => candidate.id)
        );
        return () => {
            if (drafts.current.get(draft.id) === draft) drafts.current.delete(draft.id);
            setDirtyIds(
                [...drafts.current.values()].filter((candidate) => candidate.dirty).map((candidate) => candidate.id)
            );
        };
    }, []);

    const confirmDiscard = useCallback(
        (draft: UnsavedDraft) =>
            new Promise<boolean>((resolve) => {
                setPending({ kind: 'draft', draft, resolve });
            }),
        []
    );

    const api: GuardApi = useMemo(() => ({ registerDraft, confirmDiscard }), [registerDraft, confirmDiscard]);

    // The router blocker: React Router 7 requires a data router for this hook — main.tsx mounts
    // one for exactly this reason. Idle while nothing is dirty, so a clean route proceeds
    // untouched.
    const blocker = useBlocker(dirtyIds.length > 0);
    useEffect(() => {
        if (blocker.state === 'blocked') {
            setPending({ kind: 'route', proceed: blocker.proceed, reset: blocker.reset });
        }
    }, [blocker.state, blocker.proceed, blocker.reset]);

    // The browser tab's own guard, armed only while something is dirty — the listener's lifetime
    // is the dirty state.
    useEffect(() => {
        if (dirtyIds.length === 0) return;
        return subscribeBeforeUnload(window, beforeUnloadWarning);
    }, [dirtyIds.length]);

    const continueEditing = () => {
        if (pending?.kind === 'route') pending.reset();
        else pending?.resolve(false);
        setPending(null);
    };

    const discardChanges = () => {
        // Reset the drafts BEFORE resuming, so the panels re-render clean while they are still
        // mounted — and so a route-guarded discard hands the navigation an honest, clean tree.
        for (const draft of dirtyDrafts()) draft.discard();
        if (pending?.kind === 'route') pending.proceed();
        else pending?.resolve(true);
        setPending(null);
    };

    const context: SettingsPageContext = { ...shell, workspace, env };
    return (
        <UnsavedChangesProvider api={api}>
            <Outlet context={context} />
            {pending !== null ? (
                <UnsavedChangesDialog
                    labels={
                        pending.kind === 'route' ? dirtyDrafts().map((draft) => draft.label) : [pending.draft.label]
                    }
                    onClose={continueEditing}
                    onConfirm={discardChanges}
                />
            ) : null}
        </UnsavedChangesProvider>
    );
}
