import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Job } from './api/useJobs.js';

/**
 * Task groups and their tabs — the tasks area's browser-style tab model.
 *
 * A group is the top-level organizer of the left navigation tree, labelled `Group N` where N is
 * assigned automatically and never edited. A tab is one task (a thread root) open inside a group;
 * the tasks area renders the active group's tabs as a Chrome-like strip with a close control on
 * each and a `+` that starts a new tab (the composer).
 *
 * A task's address IS its tab: arriving at `/tasks/:id` opens the task as a tab of the selected
 * group (deep link, queued task's redirect and left-nav click all land the same way), and the
 * group that holds the focused task is the one shown as active. Groups hold nothing but ids — the
 * titles come from the shell's `/api/jobs` poll — and the whole arrangement lives in localStorage
 * under one key, so a reload keeps the tabs that were open.
 *
 * The transitions are pure functions so the offline suite can pin them without a DOM or a router;
 * `useTaskTabs` is the thin layer that owns the state, persists it, and navigates.
 */

export interface TaskGroup {
    /** The group's number. Labels are derived, never stored, so they cannot drift. */
    id: string;
    /** The open tasks, in the order their tabs sit left to right. */
    tabs: string[];
}

export interface TaskTabsState {
    groups: TaskGroup[];
    /** The group the tab bar shows and the sidenav highlights when no task is focused. */
    activeGroup: string;
}

export function groupLabel(group: TaskGroup): string {
    return `Group ${group.id}`;
}

/** A tab's label: the task's command once the poll knows it, a short id until then. */
export function taskTitle(id: string, jobs: readonly Job[] | null): string {
    const found = jobs?.find((job) => job.id === id);
    return found !== undefined ? found.command : id.slice(0, 8);
}

export function groupById(state: TaskTabsState, id: string): TaskGroup | null {
    return state.groups.find((group) => group.id === id) ?? null;
}

export function groupOfTask(state: TaskTabsState, taskId: string | null): TaskGroup | null {
    if (taskId === null) return null;
    return state.groups.find((group) => group.tabs.includes(taskId)) ?? null;
}

/** The group the strip shows and the nav highlights: the holder of the focused task, else the selected one. */
export function effectiveGroup(state: TaskTabsState, taskId: string | null): TaskGroup {
    return groupOfTask(state, taskId) ?? groupById(state, state.activeGroup) ?? state.groups[0] ?? FIRST_GROUP;
}

/** The number after the largest group id — "Group 1", "Group 2", … */
export function nextGroupId(groups: readonly TaskGroup[]): string {
    const highest = groups.reduce((acc, group) => {
        const value = Number.parseInt(group.id, 10);
        return Number.isFinite(value) ? Math.max(acc, value) : acc;
    }, 0);
    return String(highest + 1);
}

/**
 * Open a task as a tab: focus the group that already holds it, or append it to the selected group.
 * A task lives in exactly one group — the same id can never sit in two tabs.
 */
export function openTask(state: TaskTabsState, taskId: string): TaskTabsState {
    const holder = groupOfTask(state, taskId);
    if (holder !== null) return holder.id === state.activeGroup ? state : { ...state, activeGroup: holder.id };
    const group = groupById(state, state.activeGroup) ?? state.groups[0] ?? FIRST_GROUP;
    if (group.tabs.includes(taskId)) return state;
    const groups = state.groups.map((candidate) =>
        candidate.id === group.id ? { ...candidate, tabs: [...candidate.tabs, taskId] } : candidate,
    );
    return { ...state, groups, activeGroup: group.id };
}

/**
 * Close a tab. `next` is the tab to focus: the one that slid into the closed tab's place, the
 * new rightmost tab, or null when the group is left empty — the caller navigates to `next` or to
 * the composer.
 */
export function closeTab(state: TaskTabsState, taskId: string): { state: TaskTabsState; next: string | null } {
    const group = groupOfTask(state, taskId);
    if (group === null) return { state, next: null };
    const index = group.tabs.indexOf(taskId);
    if (index === -1) return { state, next: null };
    const tabs = group.tabs.filter((id) => id !== taskId);
    const groups = state.groups.map((candidate) => (candidate.id === group.id ? { ...candidate, tabs } : candidate));
    return { state: { ...state, groups }, next: tabs[index] ?? tabs[index - 1] ?? null };
}

/** Create the next group, empty, and make it the selected one. */
export function addGroup(state: TaskTabsState): TaskTabsState {
    const id = nextGroupId(state.groups);
    return { groups: [...state.groups, { id, tabs: [] }], activeGroup: id };
}

const KEY = 'factory.task-tabs.v1';

const FIRST_GROUP: TaskGroup = { id: '1', tabs: [] };
const DEFAULT_STATE: TaskTabsState = { groups: [FIRST_GROUP], activeGroup: FIRST_GROUP.id };

function sanitize(raw: unknown): TaskTabsState {
    if (typeof raw !== 'object' || raw === null) return DEFAULT_STATE;
    const parsed = raw as { groups?: unknown; activeGroup?: unknown };
    if (!Array.isArray(parsed.groups)) return DEFAULT_STATE;
    const groups: TaskGroup[] = [];
    for (const entry of parsed.groups) {
        if (typeof entry !== 'object' || entry === null) continue;
        const candidate = entry as { id?: unknown; tabs?: unknown };
        if (typeof candidate.id !== 'string' || candidate.id === '' || !Array.isArray(candidate.tabs)) continue;
        // Group ids are the state's keys; a duplicate would let one id name two headings.
        if (groups.some((group) => group.id === candidate.id)) continue;
        groups.push({ id: candidate.id, tabs: candidate.tabs.filter((t): t is string => typeof t === 'string') });
    }
    if (groups.length === 0) return DEFAULT_STATE;
    const activeGroup =
        typeof parsed.activeGroup === 'string' && groups.some((group) => group.id === parsed.activeGroup)
            ? parsed.activeGroup
            : groups[0]!.id;
    return { groups, activeGroup };
}

export function loadTaskTabs(): TaskTabsState {
    if (typeof localStorage === 'undefined') return DEFAULT_STATE;
    try {
        const raw = localStorage.getItem(KEY);
        return raw === null ? DEFAULT_STATE : sanitize(JSON.parse(raw) as unknown);
    } catch {
        // A corrupt value is a fresh start, never a crash.
        return DEFAULT_STATE;
    }
}

export function saveTaskTabs(state: TaskTabsState): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // A full or blocked storage must not take the tab bar down with it; the arrangement
        // just does not survive the reload.
    }
}

function taskIdFromPath(pathname: string): string | null {
    const match = pathname.match(/^\/tasks\/([^/]+)$/);
    return match?.[1] ?? null;
}

/** What the nav and the tab strip need of the tabs state, with the actions that change it. */
export interface TaskTabs {
    readonly groups: readonly TaskGroup[];
    /** The group the tab strip shows and the sidenav highlights. */
    readonly active: TaskGroup;
    /** Focus a group: its first tab, or the composer when it holds none. */
    activateGroup: (id: string) => void;
    /** Create the next group and open its (empty) tab strip. */
    createGroup: () => void;
    /** Close a tab; when it was the focused one, focus its neighbour or fall to the composer. */
    removeTab: (taskId: string) => void;
}

export function useTaskTabs(): TaskTabs {
    const [state, setState] = useState<TaskTabsState>(loadTaskTabs);
    const { pathname } = useLocation();
    const navigate = useNavigate();
    const stateRef = useRef(state);
    stateRef.current = state;

    useEffect(() => {
        saveTaskTabs(state);
    }, [state]);

    // A task's address is its tab: arriving at /tasks/:id opens or focuses its tab, so a deep
    // link, a queued task's redirect and a left-nav click all land the same way.
    const taskId = taskIdFromPath(pathname);
    useEffect(() => {
        if (taskId === null) return;
        setState((current) => openTask(current, taskId));
    }, [taskId]);

    const active = useMemo(() => effectiveGroup(state, taskId), [state, taskId]);

    const activateGroup = useCallback(
        (id: string) => {
            // Already displaying this group with a task focused — the heading is a no-op, the
            // way a browser window keeps its current tab when you click it.
            const focused = taskIdFromPath(pathname);
            const holder = focused !== null ? groupOfTask(stateRef.current, focused) : null;
            if (holder !== null && holder.id === id) return;
            const target = groupById(stateRef.current, id);
            if (target === null) return;
            setState({ ...stateRef.current, activeGroup: id });
            navigate(target.tabs[0] !== undefined ? `/tasks/${target.tabs[0]}` : '/tasks');
        },
        [navigate, pathname],
    );

    const createGroup = useCallback(() => {
        setState((current) => addGroup(current));
        navigate('/tasks');
    }, [navigate]);

    const removeTab = useCallback(
        (id: string) => {
            const result = closeTab(stateRef.current, id);
            setState(result.state);
            // A background tab closing keeps the focused one; only the focused tab's close
            // moves the selection, to its neighbour or to the composer.
            if (id !== taskIdFromPath(pathname)) return;
            navigate(result.next !== null ? `/tasks/${result.next}` : '/tasks');
        },
        [navigate, pathname],
    );

    return { groups: state.groups, active, activateGroup, createGroup, removeTab };
}