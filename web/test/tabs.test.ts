import { describe, expect, it } from 'vitest';
import type { Job } from '../src/api/useJobs.js';
import {
    addGroup,
    closeTab,
    effectiveGroup,
    groupLabel,
    loadTaskTabs,
    nextGroupId,
    openTask,
    saveTaskTabs,
    taskStatus,
    taskTitle,
} from '../src/tabs.js';
import type { TaskGroup, TaskTabsState } from '../src/tabs.js';

/**
 * The tasks-area tab model is pure — every transition takes a state and returns a state — so this
 * suite pins the rules without a DOM or a router. Only the storage round-trip reaches for a local
 * `localStorage` stub, installed for the one test and torn down, so the shared worker stays clean.
 */
function state(groups: TaskGroup[], activeGroup = groups[0]!.id): TaskTabsState {
    return { groups, activeGroup };
}

const g1: TaskGroup = { id: '1', tabs: ['aaa', 'bbb'] };
const g2: TaskGroup = { id: '2', tabs: [] };

function withStorage(): () => void {
    const store = new Map<string, string>();
    const stub: Storage = {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
        clear: () => store.clear(),
        key: (index) => [...store.keys()][index] ?? null,
        get length() {
            return store.size;
        },
    };
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: stub });
    return () => {
        if (descriptor !== undefined) Object.defineProperty(globalThis, 'localStorage', descriptor);
        else delete (globalThis as { localStorage?: unknown }).localStorage;
    };
}

describe('task groups', () => {
    it('labels a group from its number, never a stored name', () => {
        expect(groupLabel({ id: '1', tabs: [] })).toBe('Group 1');
        expect(groupLabel({ id: '12', tabs: [] })).toBe('Group 12');
    });

    it('numbers the next group after the highest existing number', () => {
        expect(nextGroupId([])).toBe('1');
        expect(nextGroupId([{ id: '1', tabs: [] }])).toBe('2');
        expect(nextGroupId([{ id: '2', tabs: [] }, { id: '4', tabs: [] }])).toBe('5');
        // A non-numeric id is no lower bound; the count still advances.
        expect(nextGroupId([{ id: 'x', tabs: [] }])).toBe('1');
    });
});

describe('openTask', () => {
    it('appends the task to the selected group as the newest tab', () => {
        const next = openTask(state([g1, g2], '2'), 'ccc');
        expect(next.groups[1]!.tabs).toEqual(['ccc']);
        expect(next.activeGroup).toBe('2');
    });

    it('focuses the group that already holds the task instead of duplicating it', () => {
        const next = openTask(state([g1, g2], '2'), 'aaa');
        expect(next.groups).toEqual([g1, g2]); // untouched — same tab, same place
        expect(next.activeGroup).toBe('1');
    });

    it('is a no-op when the task already sits in the selected group', () => {
        const start = state([g1, g2], '1');
        expect(openTask(start, 'aaa')).toBe(start);
    });
});

describe('closeTab', () => {
    it('removes the tab and hands back its right neighbour when there is one', () => {
        const result = closeTab(state([g1]), 'aaa');
        expect(result.state.groups[0]!.tabs).toEqual(['bbb']);
        expect(result.next).toBe('bbb');
    });

    it('focuses the new rightmost tab when the last one closes', () => {
        const result = closeTab(state([g1]), 'bbb');
        expect(result.state.groups[0]!.tabs).toEqual(['aaa']);
        expect(result.next).toBe('aaa');
    });

    it('leaves the group empty rather than deleting it', () => {
        const result = closeTab(state([{ id: '1', tabs: ['aaa'] }]), 'aaa');
        expect(result.state.groups).toEqual([{ id: '1', tabs: [] }]);
        expect(result.next).toBeNull();
    });

    it('changes nothing for a task no group holds', () => {
        const start = state([g1]);
        expect(closeTab(start, 'zzz')).toEqual({ state: start, next: null });
    });
});

describe('addGroup', () => {
    it('appends an empty group with the next number and selects it', () => {
        const next = addGroup(state([g1, g2], '1'));
        expect(next.groups).toHaveLength(3);
        expect(next.groups[2]).toEqual({ id: '3', tabs: [] });
        expect(next.activeGroup).toBe('3');
    });
});

describe('effectiveGroup', () => {
    it('prefers the group holding the focused task over the selected group', () => {
        expect(effectiveGroup(state([g1, g2], '2'), 'aaa')).toBe(g1);
        expect(effectiveGroup(state([g1, g2], '2'), null)).toBe(g2);
    });

    it('falls back to a fresh group when the state is unreachable', () => {
        const broken = { groups: [], activeGroup: '9' };
        expect(effectiveGroup(broken, null)).toEqual({ id: '1', tabs: [] });
    });
});

describe('taskTitle', () => {
    const job: Job = {
        id: '11111111-1111-4111-8111-111111111111',
        command: 'fix the flaky login test',
        status: 'succeeded',
        attempts: 1,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        followUpTo: null,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        sessionId: null,
        remoteSessionId: null,
    };

    it('uses the command once the poll knows the task, and a short id before that', () => {
        expect(taskTitle(job.id, [job])).toBe('fix the flaky login test');
        expect(taskTitle(job.id, null)).toBe('11111111');
        expect(taskTitle(job.id, [])).toBe('11111111');
    });
});

describe('taskStatus', () => {
    const job = (id: string, overrides: Partial<Job> = {}): Job => ({
        id,
        command: `command ${id}`,
        status: 'succeeded',
        attempts: 1,
        exitCode: 0,
        output: null,
        repo: null,
        executor: null,
        followUpTo: null,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-09-01T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        sessionId: null,
        remoteSessionId: null,
        ...overrides,
    });

    it('answers the named run when it is its own chain root', () => {
        expect(taskStatus('a', [job('a', { status: 'running' })])).toEqual({
            status: 'running',
            cancelRequestedAt: null,
            doneAt: null,
        });
    });

    it('resolves ANY member to the newest run of the chain, like the detail page does', () => {
        // The chain, oldest first: root a, follow-up b, newest c. `taskStatus` must answer c's
        // state whether asked for the root or one of the follow-ups.
        const chain = [
            job('a'),
            job('b', { followUpTo: 'a' }),
            job('c', { followUpTo: 'b', status: 'running', cancelRequestedAt: '2026-09-01T13:00:00.000Z' }),
        ];
        const expected = { status: 'running', cancelRequestedAt: '2026-09-01T13:00:00.000Z', doneAt: null };
        expect(taskStatus('a', chain)).toEqual(expected);
        expect(taskStatus('b', chain)).toEqual(expected);
        expect(taskStatus('c', chain)).toEqual(expected);
    });

    it('picks the newest member of the chain regardless of the rows\' order', () => {
        // The head is found by who points at whom, not by array position — the newest member is
        // the one no other chain job continues, so a shuffled list answers the same task state.
        const newest = job('z', { followUpTo: 'b', status: 'failed', doneAt: '2026-09-01T14:00:00.000Z' });
        const expected = { status: 'failed', cancelRequestedAt: null, doneAt: '2026-09-01T14:00:00.000Z' };
        expect(taskStatus('b', [newest, job('b', { followUpTo: 'a' }), job('a')])).toEqual(expected);
        expect(taskStatus('b', [job('a'), job('b', { followUpTo: 'a' }), newest])).toEqual(expected);
    });

    it('falls back to the named run when its ancestors are outside the poll window', () => {
        // The poll holds only the newest rows: a follow-up whose parent fell out of the window
        // still carries its own live status, and the dot must not drop just because the root is
        // no longer in the poll.
        expect(taskStatus('b', [job('b', { followUpTo: 'a', status: 'running' })])).toEqual({
            status: 'running',
            cancelRequestedAt: null,
            doneAt: null,
        });
    });

    it('falls back to the newest member the window can still reach', () => {
        // Root a fell out of the poll window; the segment the poll still holds is b <- c, so the
        // newest reachable run c answers for the task, not a blank.
        const window = [
            job('b', { followUpTo: 'a' }),
            job('c', { followUpTo: 'b', status: 'failed', doneAt: '2026-09-01T14:00:00.000Z' }),
        ];
        const expected = { status: 'failed', cancelRequestedAt: null, doneAt: '2026-09-01T14:00:00.000Z' };
        expect(taskStatus('b', window)).toEqual(expected);
        expect(taskStatus('c', window)).toEqual(expected);
    });

    it('answers nothing about a task the poll does not know', () => {
        expect(taskStatus('nope', [job('a')])).toEqual({ status: null, cancelRequestedAt: null, doneAt: null });
        expect(taskStatus('a', null)).toEqual({ status: null, cancelRequestedAt: null, doneAt: null });
        expect(taskStatus('a', [])).toEqual({ status: null, cancelRequestedAt: null, doneAt: null });
    });
});

describe('task-tabs storage', () => {
    it('starts a fresh install with one empty group', () => {
        // The offline suite has no localStorage at all, which is the fresh-install state.
        expect(loadTaskTabs()).toEqual({ groups: [{ id: '1', tabs: [] }], activeGroup: '1' });
    });

    it('round-trips a saved arrangement', () => {
        const restore = withStorage();
        try {
            const saved = state([{ id: '2', tabs: ['x'] }, g1], '2');
            saveTaskTabs(saved);
            expect(loadTaskTabs()).toEqual(saved);
        } finally {
            restore();
        }
    });

    it('survives a corrupt value and a corrupt shape as a fresh start', () => {
        const restore = withStorage();
        try {
            localStorage.setItem('factory.task-tabs.v1', '{not json');
            expect(loadTaskTabs()).toEqual({ groups: [{ id: '1', tabs: [] }], activeGroup: '1' });

            localStorage.setItem('factory.task-tabs.v1', JSON.stringify({ groups: 'nope' }));
            expect(loadTaskTabs()).toEqual({ groups: [{ id: '1', tabs: [] }], activeGroup: '1' });

            // Non-string tabs are dropped, duplicate group ids collapse, and a dangling active
            // group falls back to the first.
            localStorage.setItem(
                'factory.task-tabs.v1',
                JSON.stringify({ groups: [{ id: '2', tabs: [3, 'ok'] }, { id: '2', tabs: [] }], activeGroup: '9' }),
            );
            expect(loadTaskTabs()).toEqual({ groups: [{ id: '2', tabs: ['ok'] }], activeGroup: '2' });
        } finally {
            restore();
        }
    });
});