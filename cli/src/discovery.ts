import type { VisibleRepos, WorkspaceView } from './board.js';

/**
 * The data a discovery command reports, joined from the board's own reads. Pure: nothing here
 * calls the board, and nothing a discovery command calls writes — no sync, no provisioning.
 */

export interface RepoRow {
    repo: string;
    /** The App installation can see it — a member could choose to check it out. */
    visible: boolean;
    /** It is in the caller's workspace selection, whatever state its checkout is in. */
    synced: boolean;
    private: boolean | null;
    defaultBranch: string | null;
    syncStatus: string | null;
    syncError: string | null;
}

export interface RepoDiscovery {
    repos: RepoRow[];
    /** False when the deployment has no workspace root: nothing can be synced, and `synced` is all false. */
    workspaceEnabled: boolean;
    /** The board's named reason the visible list may be stale or empty, else null. */
    error: string | null;
    fetchedAt: string | null;
}

/** Visible repos first, then synced ones the installation no longer shows — both are worth naming. */
export function repoDiscovery(visible: VisibleRepos, workspace: WorkspaceView): RepoDiscovery {
    const synced = new Map(workspace.repos.map((repo) => [`${repo.owner}/${repo.name}`, repo]));
    const rows: RepoRow[] = visible.repos.map((repo) => {
        const full = `${repo.owner}/${repo.name}`;
        const sync = synced.get(full);
        synced.delete(full);
        return {
            repo: full,
            visible: true,
            synced: sync !== undefined,
            private: repo.private,
            defaultBranch: repo.defaultBranch,
            syncStatus: sync?.status ?? null,
            syncError: sync?.error ?? null,
        };
    });
    for (const [full, sync] of synced) {
        rows.push({
            repo: full,
            visible: false,
            synced: true,
            private: null,
            defaultBranch: null,
            syncStatus: sync.status,
            syncError: sync.error,
        });
    }
    return {
        repos: rows,
        workspaceEnabled: workspace.root !== null,
        error: visible.meta.error,
        fetchedAt: visible.meta.fetchedAt,
    };
}

export interface ExecutorRow {
    /** The `--executor-scope` value that selects it. */
    scope: 'user' | 'org';
    name: string;
    type: string;
    suspended: boolean;
    /** The caller's resolved default: what a task naming no executor gets. */
    default: boolean;
}

/** Personal profiles, then the org's, each with its selection scope; credentials never ride along. */
export function executorDiscovery(workspace: WorkspaceView): { executors: ExecutorRow[] } {
    const row = (scope: ExecutorRow['scope'], profile: WorkspaceView['executors'][number]): ExecutorRow => ({
        scope,
        name: profile.name,
        type: profile.type,
        suspended: profile.suspended === true,
        default: workspace.defaultExecutor?.scope === scope && workspace.defaultExecutor.name === profile.name,
    });
    return {
        executors: [
            ...workspace.executors.map((profile) => row('user', profile)),
            ...workspace.orgExecutors.map((profile) => row('org', profile)),
        ],
    };
}
