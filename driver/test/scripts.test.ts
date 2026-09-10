import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_HELPER, gitProbeScript, gitWorktreeScript } from '../src/publish.js';
import { bellowsReadScript } from '../src/services.js';
import { opencodeCacheProbeScript, opencodeReadoutScript, remoteSessionScript } from '../src/docker.js';

/**
 * The scripts this driver hands to containers are REAL FILES under `driver/src/scripts/`, read at
 * load time and passed to the container by argv — never inline template strings in the TS source,
 * and never by mounting a path (the driver has no host path into a named volume). This suite is
 * the seam between the two halves: the files must exist, must PARSE (a syntax error here is a
 * container-only failure otherwise — every runner that would have executed the script burns its
 * attempt instead), and the TS-side constants must be exactly their file's content, so a pin on a
 * constant is a pin on the artifact the container runs.
 */

const SCRIPTS_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'src', 'scripts');

/** Every script file, with the checker that gates its syntax. */
const FILES: [string, 'node' | 'sh'][] = [
    ['git-probe.cjs', 'node'],
    ['git-worktree.cjs', 'node'],
    ['bellows-read.sh', 'sh'],
    ['opencode-readout.cjs', 'node'],
    ['opencode-cache-probe.cjs', 'node'],
    ['credential-helper.sh', 'sh'],
    ['remote-session.sh', 'sh'],
];

const pathOf = (name: string): string => join(SCRIPTS_DIR, name);

describe('the container scripts', () => {
    it('ships exactly the scripts the driver loads, and nothing else', () => {
        // The build copies this directory wholesale (driver/package.json), so the directory IS
        // the contract: a file here is a file in the image, and a stray one would ship too.
        expect(readdirSync(SCRIPTS_DIR).sort()).toEqual(FILES.map(([name]) => name).sort());
    });

    it.each(FILES)('%s parses', (name, runtime) => {
        const path = pathOf(name);
        expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThan(0);
        if (runtime === 'node') {
            // --check parses only; it executes nothing, so a script here is safe to compile-check.
            execFileSync('node', ['--check', path], { stdio: 'ignore' });
        } else {
            execFileSync('sh', ['-n', path], { stdio: 'ignore' });
        }
    });

    // Loader parity: the constant a docker/k8s argv builder passes must be byte-identical to the
    // file on disk — otherwise the pins above guard a string nobody runs.
    it('loads every script from its file, byte for byte', () => {
        expect(gitProbeScript).toBe(readFileSync(pathOf('git-probe.cjs'), 'utf8'));
        expect(gitWorktreeScript).toBe(readFileSync(pathOf('git-worktree.cjs'), 'utf8'));
        expect(bellowsReadScript).toBe(readFileSync(pathOf('bellows-read.sh'), 'utf8'));
        expect(opencodeReadoutScript).toBe(readFileSync(pathOf('opencode-readout.cjs'), 'utf8'));
        expect(opencodeCacheProbeScript).toBe(readFileSync(pathOf('opencode-cache-probe.cjs'), 'utf8'));
        expect(CREDENTIAL_HELPER).toBe(readFileSync(pathOf('credential-helper.sh'), 'utf8'));
        expect(remoteSessionScript).toBe(readFileSync(pathOf('remote-session.sh'), 'utf8'));
    });
});
