import type { InstallationRepo, ReposPayload } from '../api/useRepos.js';
import type { CloneStatus, WorkspaceRepo } from '../api/useWorkspace.js';

/**
 * The repository setup page's pure decision layer (issue 181).
 *
 * Every rule the page enforces — search, the whole-selection draft, the 20-repository ceiling, the
 * save guard, the summary counts and one checkout-status cell — lives here as plain data-in,
 * data-out functions, so the offline suite pins the rules without a DOM and the components only
 * draw. The server stays the authority on every request-shaped rule; the ceiling here is the same
 * number the server enforces, mirrored so a row disables before a doomed request is built.
 */

/** The existing per-member ceiling (server/src/routes/workspace.ts). The server still enforces it. */
export const MAX_SELECTED_REPOS = 20;

export const repoKey = (repo: { owner: string; name: string }): string => `${repo.owner}/${repo.name}`;

/** Case-insensitive `owner/name` substring match; a blank query filters nothing. */
export function matchesSearch(repos: readonly InstallationRepo[], query: string): readonly InstallationRepo[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((repo) => repoKey(repo).toLowerCase().includes(needle));
}

/** Most recently pushed first, because that is where somebody's own repositories are. */
export function orderByRecency(repos: readonly InstallationRepo[]): InstallationRepo[] {
    return [...repos].sort((a, b) => {
        if (a.pushedAt && b.pushedAt) return b.pushedAt.localeCompare(a.pushedAt);
        if (a.pushedAt) return -1;
        if (b.pushedAt) return 1;
        return repoKey(a).localeCompare(repoKey(b));
    });
}

/** One key per repository — the draft's seed from the workspace poll's answer. */
export function seedSelection(repos: readonly { owner: string; name: string }[]): ReadonlySet<string> {
    return new Set(repos.map(repoKey));
}

/** Chosen keys the installation list no longer reports, sorted — the save blockers. */
export function absentSelection(chosen: ReadonlySet<string>, reported: readonly InstallationRepo[]): string[] {
    const reportedKeys = new Set(reported.map(repoKey));
    return [...chosen].filter((key) => !reportedKeys.has(key)).sort();
}

/** A draft differs from its baseline — either side alone is not the whole truth. */
export function isDirty(chosen: ReadonlySet<string>, baseline: ReadonlySet<string>): boolean {
    if (chosen.size !== baseline.size) return true;
    for (const key of chosen) if (!baseline.has(key)) return true;
    return false;
}

/**
 * Fold one checkbox click into the draft. Removal is always allowed; an addition at the ceiling is
 * refused whole — the same set comes back, so the click changes nothing the row would have to
 * undo.
 */
export function toggleSelection(
    chosen: ReadonlySet<string>,
    key: string,
    max: number = MAX_SELECTED_REPOS
): ReadonlySet<string> {
    if (chosen.has(key)) {
        const next = new Set(chosen);
        next.delete(key);
        return next;
    }
    if (chosen.size >= max) return chosen;
    return new Set([...chosen, key]);
}

/** Whether anything more can be selected — unchecked rows disable at the ceiling, checked never. */
export function canSelect(chosen: ReadonlySet<string>, max: number = MAX_SELECTED_REPOS): boolean {
    return chosen.size < max;
}

/** The PUT's body: the WHOLE selection as owner/name pairs, sorted for a stable request. */
export function selectionPayload(chosen: ReadonlySet<string>): { owner: string; name: string }[] {
    return [...chosen].sort().map((key) => {
        const slash = key.indexOf('/');
        return { owner: key.slice(0, slash), name: key.slice(slash + 1) };
    });
}

export interface SelectionSaveState {
    disabled: boolean;
    /** The visible reason the save is blocked, when one the summary should carry exists. */
    reason: string | null;
}

/**
 * The whole-list save's guard.
 *
 * The body is the WHOLE selection, so a save against a list that never arrived would deselect
 * everything — the same trap the old picker guarded. A selected repository GitHub stopped reporting
 * cannot be saved past either: the payload would silently drop it, so the mandate is to remove it
 * first, by name, before anything else saves.
 */
export function selectionSaveState(o: {
    saving: boolean;
    reposLoading: boolean;
    reposData: ReposPayload | null;
    absentCount: number;
    rootNull: boolean;
}): SelectionSaveState {
    const disabled = o.saving || o.reposLoading || !o.reposData || o.absentCount > 0 || o.rootNull;
    const reason =
        o.absentCount > 0
            ? 'Remove repositories GitHub no longer reports before saving other selection changes.'
            : null;
    return { disabled, reason };
}

export interface SelectionCounts {
    available: number;
    enabled: number;
    ready: number;
    settingUp: number;
    failed: number;
}

/**
 * The summary's numbers. `enabled` is the draft's size; the three statuses count the draft's rows
 * that the workspace poll knows about — queued and cloning read as one "setting up" figure, and a
 * draft-only repository raises `enabled` with no status, which is what the dirty sentence explains.
 */
export function counts(
    repos: readonly InstallationRepo[],
    workspace: readonly WorkspaceRepo[] | null,
    chosen: ReadonlySet<string>
): SelectionCounts {
    const byKey = new Map((workspace ?? []).map((row) => [repoKey(row), row]));
    let ready = 0;
    let settingUp = 0;
    let failed = 0;
    for (const key of chosen) {
        const status = byKey.get(key)?.status;
        if (status === 'ready') ready += 1;
        else if (status === 'queued' || status === 'cloning') settingUp += 1;
        else if (status === 'failed') failed += 1;
    }
    return { available: repos.length, enabled: chosen.size, ready, settingUp, failed };
}

/** Whether the workspace poll has answered: 'loading' before the first answer, 'error' on failure. */
export type WorkspaceState = 'loading' | 'ready' | 'error';

export type CheckoutCell =
    | { kind: 'checking' }
    | { kind: 'unknown' }
    | { kind: 'absent' }
    | { kind: 'status'; status: CloneStatus; error: string | null };

/**
 * One row's checkout cell.
 *
 * `checking` — the workspace poll has not answered, so nothing about checkouts may be stated as
 * fact. `unknown` — not measured: the draft selects the repository but the poll carries no row for
 * it yet, or the last poll failed and no row is in hand — either way an em dash, never a zero and
 * never a claimed "Not checked out". `absent` — nothing selects it and the poll answered: not
 * checked out. A row wins over all of those.
 */
export function checkoutCell(selected: boolean, row: WorkspaceRepo | undefined, ws: WorkspaceState): CheckoutCell {
    if (ws === 'loading') return { kind: 'checking' };
    if (row) return { kind: 'status', status: row.status, error: row.error };
    if (selected || ws === 'error') return { kind: 'unknown' };
    return { kind: 'absent' };
}

/** The cell as sentence text — the status never relies on color alone. */
export function checkoutText(cell: CheckoutCell): string {
    switch (cell.kind) {
        case 'checking':
            return 'Checking checkout status…';
        case 'unknown':
            return '—';
        case 'absent':
            return 'Not checked out';
        case 'status':
            switch (cell.status) {
                case 'queued':
                    return 'Queued';
                case 'cloning':
                    return 'Cloning';
                case 'ready':
                    return 'Ready';
                case 'failed':
                    return cell.error ? `Failed · ${cell.error}` : 'Failed';
            }
    }
}
