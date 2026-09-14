import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from './reconcile.js';

/**
 * Creates a member's workspace directory, and nothing else.
 *
 * The two costs are split deliberately. Making a directory is microseconds; cloning a repository is
 * minutes. So signing in provisions the directory, and cloning starts only when somebody actually
 * picks repositories — which also means a member who signs in once and never returns costs no disk
 * at all.
 *
 * Not in `auth/store.ts` alongside `signIn`, tempting as that is: that module is SQL only, it is
 * used by the CLIs, and a `mkdirSync` there would make `memoryAuthStore()` lie about what signing
 * in does.
 */

export interface ProvisionOptions {
    /** Null when no workspace root is configured, in which case this is a no-op. */
    readonly root: string | null;
    readonly orgId: string;
    readonly userId: string;
    /** Written into the breadcrumb only. Never read back, never keyed on. */
    readonly login: string;
    readonly githubUserId: number;
    /**
     * Rewrite the breadcrumb even when the directory already existed.
     *
     * Set at sign-in, which is the only moment a rename can have happened. Left off on the polled
     * read path, where the write would be pure cost.
     */
    readonly rewriteBreadcrumb?: boolean;
    readonly log?: (message: string) => void;
}

/**
 * A file naming who owns the directory, so `ls /workspaces/<org>` is not a wall of uuids.
 *
 * The legibility a login-named directory would have given, without the two failures it would have
 * brought: a rename orphaning a tree that holds uncommitted work, and a freed login handing a
 * stranger the previous holder's checkouts. Deliberately never read by any code — a breadcrumb that
 * something resolves against is a second source of truth for the thing app_user.id already is.
 */
const BREADCRUMB = '.factory-workspace.json';

export function ensureUserWorkspace(options: ProvisionOptions): string | null {
    const { root, orgId, userId, login, githubUserId, log = () => {} } = options;
    if (!root) return null;

    const dir = workspaceDir(root, orgId, userId);
    /*
     * `recursive: true` returns the first path it created, or undefined when there was nothing to
     * do — which is what decides whether the breadcrumb is rewritten.
     *
     * That guard matters: `GET /api/workspace` calls this on every request and the SPA polls it, so
     * an unconditional write was two synchronous syscalls per poll per member, forever. Writing
     * only on creation loses nothing, because the other caller is the sign-in callback, and a
     * rename is only visible at sign-in anyway.
     */
    const created = mkdirSync(dir, { recursive: true });
    if (created !== undefined || options.rewriteBreadcrumb) {
        writeFileSync(
            join(dir, BREADCRUMB),
            `${JSON.stringify({ userId, githubUserId, login, updatedAt: new Date().toISOString() }, null, 2)}\n`
        );
        log(`workspace ${dir} (${login})`);
    }
    return dir;
}
