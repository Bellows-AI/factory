import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Shared support for the container-script suites (split out of `scripts.test.ts` for its
 * line-count cap): the driver-availability probes every suite skips on, and the path helper into
 * `driver/src/scripts/`, the directory the driver build copies into the runtime image verbatim.
 */
export const SCRIPTS_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'scripts');

export const pathOf = (name: string): string => join(SCRIPTS_DIR, name);

export function hasGit(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function hasOpenssl(): boolean {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** node:sqlite is flagged experimental and its landing version varies; the suite skips, not breaks. */
export function hasNodeSqlite(): boolean {
    try {
        new DatabaseSync(':memory:').close();
        return true;
    } catch {
        return false;
    }
}
