import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_HELPER, gitProbeScript, gitWorktreeScript } from '../src/publish.js';
import { bellowsReadScript } from '../src/services.js';
import { opencodeCacheProbeScript, opencodeReadoutScript, remoteSessionScript } from '../src/docker.js';

const execFile = promisify(execFileCb);

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

function hasGit(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

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

/**
 * The sync fetch's credential wiring, against real git — the same offline shape as
 * worktree.test.ts, except the remote: an http URL, because a credential helper is only ever
 * invoked when a transport actually asks for credentials and file:// never does. The stub
 * remote answers 401 to everything, so git runs the credential dance: with CRED_HELPER set the
 * helper is spawned (the marker file proves it), without it the fetch fails plain. GIT_* config
 * is pinned to /dev/null so the host's own helpers (osxkeychain and friends) stay out of the
 * dance entirely.
 */
describe.skipIf(!hasGit())('the sync fetch credential helper', () => {
    const FIXTURE_CONFIG = ['-c', 'init.defaultBranch=main'];
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', [...FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();

    let dir: string;
    let clone: string;
    let server: ReturnType<typeof createServer>;

    // ASYNC on purpose: the 401 server lives on THIS worker's event loop, and a synchronous
    // execFile would block the very loop the fetch needs to answer the credential round-trips —
    // the fetch would wait on a server that cannot run. Awaited, the loop stays free.
    const sync = async (env: Record<string, string>): Promise<{ ok: boolean; reason: string | null }> => {
        const { stdout } = await execFile(
            'node',
            [join(import.meta.dirname, '..', 'src', 'scripts', 'git-worktree.cjs')],
            {
                env: {
                    ...process.env,
                    REPO: clone,
                    WORKTREE: join(dir, 'wt'),
                    BRANCH: 'factory/99999999-9999-4999-8999-999999999999',
                    // Only CRED_HELPER may answer the credential prompt: the host's global/system
                    // helpers would muddy exactly the wiring under test.
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_CONFIG_SYSTEM: '/dev/null',
                    GIT_TERMINAL_PROMPT: '0',
                    ...env,
                },
                encoding: 'utf8',
            },
        );
        return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!);
    };

    beforeEach(async () => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-cred-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# cred\n');
        execFileSync('git', [...FIXTURE_CONFIG, '-C', work, 'add', 'README.md'], { stdio: 'ignore' });
        execFileSync('git', [...FIXTURE_CONFIG, '-C', work, '-c', 'user.email=t@e.c', '-c', 'user.name=T', 'commit', '-m', 'init'], { stdio: 'ignore' });
        const bare = join(dir, 'cred.git');
        execFileSync('git', [...FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        execFileSync('git', [...FIXTURE_CONFIG, 'clone', `file://${bare}`, join(dir, 'clone')], { stdio: 'ignore' });
        clone = join(dir, 'clone');
        // The 401-everything remote: the first unauthenticated request is refused, which is
        // what sends git looking for a credential helper. Offline — loopback only.
        server = createServer((_req, res) => {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="factory-test"' });
            res.end('no');
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        git(clone, 'remote', 'set-url', 'origin', `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`);
    });

    afterEach(async () => {
        // git's libcurl keeps the connection alive after a refused fetch; close() alone waits
        // for it, which would hang the suite. Drop the sockets, then close.
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    it('invokes the helper for the fetch when CRED_HELPER is set', async () => {
        const marker = join(dir, 'helper-invoked');
        // The marker-writing helper: the same shape as the shipped credential-helper.sh (a
        // `!f(){ ... }; f` shell snippet passed as the helper CODE), with a side effect git's
        // auth dance cannot fake.
        const helper = `!f(){ printf "username=u\\n"; printf "password=p\\n"; echo invoked > '${marker}'; }; f`;
        // The remote never authenticates, so the sync answers ok:false — the assertion is the
        // helper having RUN, which the marker proves.
        expect((await sync({ CRED_HELPER: helper })).ok).toBe(false);
        expect(existsSync(marker)).toBe(true);
    });

    it('runs the fetch plain when CRED_HELPER is absent', async () => {
        const marker = join(dir, 'helper-invoked');
        expect((await sync({})).ok).toBe(false);
        expect(existsSync(marker)).toBe(false);
    });
});
