import { useCallback, useEffect, useState } from 'react';

/**
 * The settings area's shared unsaved-change registry — Slice D's route/browser leave protection
 * contract (issue 181).
 *
 * A page holding a draft the server has not seen registers a guard: an id naming the draft and the
 * sentence explaining what would be lost. Anything that would take the drafts away asks the
 * registry first and either stops or shows the reason. The registry is presentation-neutral on
 * purpose — pure state, no dialog, no router coupling — so each consumer decides what its leave
 * looks like: the browser's own beforeunload prompt today, the repos page's in-page blocker when
 * the configuration detail would switch repositories, and the navigation dialog a later slice adds.
 *
 * Guards are keyed by id and replaced whole: one draft holds one guard, so a re-registration never
 * accumulates. Setting a guard to null clears it.
 */
export interface UnsavedGuard {
    /** Names the draft, e.g. `workspace.repos` or `repo-env:acme/web`. One draft, one id. */
    id: string;
    /** The sentence a blocker or dialog renders — what leaving would discard. */
    reason: string;
}

export type UnsavedGuards = ReadonlyMap<string, UnsavedGuard>;

/** What the settings layout publishes: the live guard set and the one way to change it. */
export interface UnsavedCoordinator {
    guards: UnsavedGuards;
    setGuard: (id: string, reason: string | null) => void;
}

/**
 * Registers (or replaces) one guard. Pure — the map is copied, never mutated.
 *
 * Re-registering an identical id+reason is a no-op on purpose: effects that keep a guard in step
 * with a draft re-run on renders that have nothing to do with the draft, and a fresh map each time
 * would feed back into the very state that re-rendered them.
 */
export function withGuard(guards: UnsavedGuards, guard: UnsavedGuard): UnsavedGuards {
    const existing = guards.get(guard.id);
    if (existing && existing.reason === guard.reason) return guards;
    const next = new Map(guards);
    next.set(guard.id, guard);
    return next;
}

/** Clears one guard by id; clearing an id that holds none is a no-op. */
export function withoutGuard(guards: UnsavedGuards, id: string): UnsavedGuards {
    if (!guards.has(id)) return guards;
    const next = new Map(guards);
    next.delete(id);
    return next;
}

/** Why `id` must not be left, or null when nothing stands in the way. */
export function leaveReason(guards: UnsavedGuards, id: string): string | null {
    return guards.get(id)?.reason ?? null;
}

/**
 * The browser-leave half: the handler the `beforeunload` listener calls while any guard stands.
 * Both gestures are required — without `preventDefault()` Chrome skips the dialog entirely, and
 * Chromium only shows its own wording when `returnValue` is the empty string.
 */
export function beforeUnloadGuard(event: { preventDefault(): void; returnValue: string }): void {
    event.preventDefault();
    event.returnValue = '';
}

/** One registry for the settings area; the layout creates it and pages register against it. */
export function useUnsavedGuards(): UnsavedCoordinator {
    const [guards, setGuards] = useState<UnsavedGuards>(new Map());

    const setGuard = useCallback((id: string, reason: string | null) => {
        setGuards((current) => (reason === null ? withoutGuard(current, id) : withGuard(current, { id, reason })));
    }, []);

    // The browser-leave arm lives here, where the guard set does: a listener is attached while any
    // guard stands and removed the moment none do, so a page with no drafts never holds the tab
    // open.
    useEffect(() => {
        if (guards.size === 0) return;
        const handler = (event: BeforeUnloadEvent) => beforeUnloadGuard(event);
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [guards]);

    return { guards, setGuard };
}
