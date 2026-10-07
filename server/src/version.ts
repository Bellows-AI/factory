import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Plain SemVer core, no `v` and no leading zeros — the same shape `scripts/release.sh` accepts. */
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The release version packaged with this server: the root `VERSION`, at a depth that resolves the
 * same from `src/` and `dist/` — the checkout's committed file locally, `/app/VERSION` in the
 * image. Missing or malformed throws, so a server never reports a plausible version it does not have.
 */
export function readVersion(file: string | URL = new URL('../../VERSION', import.meta.url)): string {
    const path = file instanceof URL ? fileURLToPath(file) : file;
    let contents: string;
    try {
        contents = readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(`cannot read the release version at ${path}`, { cause: error });
    }
    const version = contents.trim();
    if (!VERSION_PATTERN.test(version)) throw new Error(`${path} holds ${JSON.stringify(version)}, not X.Y.Z`);
    return version;
}
