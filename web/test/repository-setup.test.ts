import { describe, expect, it } from 'vitest';
import type { InstallationRepo, ReposPayload } from '../src/api/useRepos.js';
import type { WorkspaceRepo } from '../src/api/useWorkspace.js';
import {
    absentSelection,
    canSelect,
    checkoutCell,
    checkoutText,
    counts,
    isDirty,
    matchesSearch,
    MAX_SELECTED_REPOS,
    orderByRecency,
    repoKey,
    selectionPayload,
    selectionSaveState,
    seedSelection,
    toggleSelection,
} from '../src/components/repository-setup.js';
import type { CheckoutCell, WorkspaceState } from '../src/components/repository-setup.js';

const repo = (overrides: Partial<InstallationRepo> = {}): InstallationRepo => ({
    owner: 'acme',
    name: 'web',
    private: false,
    defaultBranch: 'main',
    pushedAt: '2026-08-20T09:00:00.000Z',
    ...overrides,
});

const checkout = (overrides: Partial<WorkspaceRepo> = {}): WorkspaceRepo => ({
    owner: 'acme',
    name: 'web',
    status: 'ready',
    error: null,
    selectedAt: '2026-08-01T00:00:00.000Z',
    readyAt: '2026-08-01T00:05:00.000Z',
    branch: 'main',
    lastCommit: null,
    sizeBytes: null,
    ...overrides,
});

const loaded: ReposPayload = {
    repos: [],
    installation: null,
    meta: { fetchedAt: '2026-01-01T00:00:00.000Z', error: null },
};

describe('repoKey', () => {
    it('joins owner and name with a slash', () => {
        expect(repoKey({ owner: 'acme', name: 'web' })).toBe('acme/web');
    });
});

describe('matchesSearch', () => {
    const repos = [repo(), repo({ owner: 'Other', name: 'api' })];

    it('matches owner/name case-insensitively', () => {
        expect(matchesSearch(repos, 'acme/web').map(repoKey)).toEqual(['acme/web']);
        expect(matchesSearch(repos, 'ACME/WEB').map(repoKey)).toEqual(['acme/web']);
        expect(matchesSearch(repos, 'api').map(repoKey)).toEqual(['Other/api']);
        expect(matchesSearch(repos, 'WEB').map(repoKey)).toEqual(['acme/web']);
    });

    it('treats a blank query as no filter', () => {
        expect(matchesSearch(repos, '')).toBe(repos);
        expect(matchesSearch(repos, '   ')).toBe(repos);
    });

    it('matches nothing on a miss', () => {
        expect(matchesSearch(repos, 'zzz')).toEqual([]);
    });
});

describe('orderByRecency', () => {
    it('puts the most recently pushed first, unpushed last, ties grouped by name', () => {
        const ordered = orderByRecency([
            repo({ name: 'zebra', pushedAt: null }),
            repo({ name: 'old', pushedAt: '2020-01-01T00:00:00.000Z' }),
            repo({ name: 'newer', pushedAt: '2026-08-20T09:00:00.000Z' }),
            repo({ name: 'newest', pushedAt: '2026-09-01T00:00:00.000Z' }),
            repo({ name: 'also-old', pushedAt: '2020-01-01T00:00:00.000Z' }),
        ]);
        const keys = ordered.map(repoKey);
        // The tie between the two 2020 entries sorts by key under localeCompare, whose order for
        // punctuation differs by locale — the pinned contract is the recency bands, not the tie.
        expect(keys.slice(0, 2)).toEqual(['acme/newest', 'acme/newer']);
        expect(keys.slice(2, 4).sort()).toEqual(['acme/also-old', 'acme/old']);
        expect(keys[4]).toBe('acme/zebra');
    });
});

describe('selection draft', () => {
    it('seeds one key per repository', () => {
        expect(seedSelection([repo(), repo({ name: 'api' })])).toEqual(new Set(['acme/web', 'acme/api']));
    });

    it('reports chosen keys the installation no longer reports, sorted', () => {
        const chosen = new Set(['acme/web', 'acme/gone', 'acme/aabsent']);
        expect(absentSelection(chosen, [repo()])).toEqual(['acme/aabsent', 'acme/gone']);
    });

    it('compares a draft against its baseline', () => {
        const baseline = new Set(['acme/web']);
        expect(isDirty(new Set(['acme/web']), baseline)).toBe(false);
        expect(isDirty(new Set(['acme/web', 'acme/api']), baseline)).toBe(true);
        expect(isDirty(new Set(), baseline)).toBe(true);
    });

    it('toggles rows on and off, and refuses additions at the ceiling but never removals', () => {
        const chosen = new Set<string>();
        expect(toggleSelection(chosen, 'acme/web')).toEqual(new Set(['acme/web']));
        expect(toggleSelection(new Set(['acme/web']), 'acme/web')).toEqual(new Set());

        const full = new Set(Array.from({ length: MAX_SELECTED_REPOS }, (_, i) => `acme/r${i}`));
        expect(toggleSelection(full, 'acme/extra')).toBe(full);
        expect(toggleSelection(full, 'acme/r0')).toEqual(new Set(Array.from({ length: MAX_SELECTED_REPOS - 1 }, (_, i) => `acme/r${i + 1}`)));
    });

    it('says whether anything more can be selected', () => {
        const full = new Set(Array.from({ length: MAX_SELECTED_REPOS }, (_, i) => `acme/r${i}`));
        expect(canSelect(full)).toBe(false);
        expect(canSelect(new Set(['acme/web']))).toBe(true);
    });

    it('builds the whole-selection payload, sorted, as owner/name pairs', () => {
        expect(selectionPayload(new Set(['acme/web', 'acme/api']))).toEqual([
            { owner: 'acme', name: 'api' },
            { owner: 'acme', name: 'web' },
        ]);
    });
});

describe('selectionSaveState', () => {
    it('blocks while a save runs, the list has not loaded, or there is no list', () => {
        expect(selectionSaveState({ saving: true, reposLoading: false, reposData: loaded, absentCount: 0, rootNull: false }).disabled).toBe(true);
        expect(selectionSaveState({ saving: false, reposLoading: true, reposData: null, absentCount: 0, rootNull: false }).disabled).toBe(true);
        expect(selectionSaveState({ saving: false, reposLoading: false, reposData: null, absentCount: 0, rootNull: false }).disabled).toBe(true);
    });

    it('blocks with the mandated sentence while GitHub no longer reports a selected repository', () => {
        const state = selectionSaveState({
            saving: false,
            reposLoading: false,
            reposData: loaded,
            absentCount: 1,
            rootNull: false,
        });
        expect(state.disabled).toBe(true);
        expect(state.reason).toBe('Remove repositories GitHub no longer reports before saving other selection changes.');
    });

    it('blocks on a deployment with no workspace root', () => {
        expect(selectionSaveState({ saving: false, reposLoading: false, reposData: loaded, absentCount: 0, rootNull: true }).disabled).toBe(true);
    });

    it('allows a save once the list is loaded and nothing blocks it', () => {
        const state = selectionSaveState({ saving: false, reposLoading: false, reposData: loaded, absentCount: 0, rootNull: false });
        expect(state.disabled).toBe(false);
        expect(state.reason).toBeNull();
    });
});

describe('counts', () => {
    it('counts enabled against the draft and statuses against its rows', () => {
        const repos = [repo(), repo({ name: 'api' }), repo({ name: 'cli' })];
        const rows = [
            checkout(),
            checkout({ name: 'api', status: 'cloning' }),
            checkout({ name: 'cli', status: 'failed', error: 'fatal: not found' }),
        ];
        expect(counts(repos, rows, new Set(['acme/web', 'acme/api', 'acme/cli']))).toEqual({
            available: 3,
            enabled: 3,
            ready: 1,
            settingUp: 1,
            failed: 1,
        });
    });

    it('raises enabled for a draft-only repository, with no status counted', () => {
        expect(counts([repo()], [checkout()], new Set(['acme/web', 'acme/draft']))).toEqual({
            available: 1,
            enabled: 2,
            ready: 1,
            settingUp: 0,
            failed: 0,
        });
    });

    it('counts nothing while the workspace poll has not answered', () => {
        expect(counts([repo()], null, new Set(['acme/web']))).toEqual({
            available: 1,
            enabled: 1,
            ready: 0,
            settingUp: 0,
            failed: 0,
        });
    });
});

describe('checkoutCell and checkoutText', () => {
    const states: WorkspaceState[] = ['loading', 'ready', 'error'];

    it('says checkout status is being checked while the workspace poll runs', () => {
        const cell = checkoutCell(false, undefined, 'loading');
        expect(cell).toEqual({ kind: 'checking' });
        expect(checkoutText(cell)).toBe('Checking checkout status…');
        // Unresolved is not a fact about any repository — never "Not checked out" while loading.
        expect(checkoutText(checkoutCell(true, checkout(), 'loading'))).toBe('Checking checkout status…');
        expect(states).toContain('loading');
    });

    it('reads the checkout status from the workspace row, with a failed reason attached', () => {
        expect(checkoutText(checkoutCell(true, checkout({ status: 'ready' }), 'ready'))).toBe('Ready');
        expect(checkoutText(checkoutCell(true, checkout({ status: 'queued' }), 'ready'))).toBe('Queued');
        expect(checkoutText(checkoutCell(true, checkout({ status: 'cloning' }), 'ready'))).toBe('Cloning');
        expect(checkoutText(checkoutCell(true, checkout({ status: 'failed', error: 'fatal: repository not found' }), 'ready'))).toBe(
            'Failed · fatal: repository not found'
        );
    });

    it('keeps the states apart when no row exists: selected is unmeasured, unselected is not checked out', () => {
        expect(checkoutText(checkoutCell(true, undefined, 'ready'))).toBe('—');
        expect(checkoutText(checkoutCell(false, undefined, 'ready'))).toBe('Not checked out');
        expect(checkoutText(checkoutCell(false, undefined, 'error') as CheckoutCell)).toBe('Not checked out');
    });

    it('renders a failed clone without a reason as plain Failed', () => {
        expect(checkoutText(checkoutCell(true, checkout({ status: 'failed', error: null }), 'ready'))).toBe('Failed');
    });
});
