import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_HELPER, gitProbeScript, gitWorktreeRemoveScript, gitWorktreeScript } from '../src/publish.js';
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

function hasOpenssl(): boolean {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Every script file, with the checker that gates its syntax. */
const FILES: [string, 'node' | 'sh'][] = [
    ['git-probe.cjs', 'node'],
    ['git-worktree.cjs', 'node'],
    ['git-worktree-remove.cjs', 'node'],
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
        expect(gitWorktreeRemoveScript).toBe(readFileSync(pathOf('git-worktree-remove.cjs'), 'utf8'));
        expect(bellowsReadScript).toBe(readFileSync(pathOf('bellows-read.sh'), 'utf8'));
        expect(opencodeReadoutScript).toBe(readFileSync(pathOf('opencode-readout.cjs'), 'utf8'));
        expect(opencodeCacheProbeScript).toBe(readFileSync(pathOf('opencode-cache-probe.cjs'), 'utf8'));
        expect(CREDENTIAL_HELPER).toBe(readFileSync(pathOf('credential-helper.sh'), 'utf8'));
        expect(remoteSessionScript).toBe(readFileSync(pathOf('remote-session.sh'), 'utf8'));
    });
});

/**
 * The sync fetch's credential wiring, against real git — the same offline shape as
 * worktree.test.ts, except the remote: an HTTPS URL, because the token-leak finding is ABOUT the
 * transport a credential rides: the helper answers every credential request with the token, so
 * the suite must exercise the scheme the token would actually leave over. The stub remote
 * answers 401 to everything, so git runs the credential dance: with CRED_HELPER set the helper
 * is spawned (the marker file proves it), without it the fetch fails plain. GIT_* config is
 * pinned to /dev/null so the host's own helpers (osxkeychain and friends) stay out of the dance
 * entirely; the fixture's certificate is self-signed, so TLS verification is switched off for
 * the script's git children — what is under test is the scheme gate and the helper wiring, not
 * the chain of trust.
 */
describe.skipIf(!hasGit() || !hasOpenssl())('the sync fetch credential helper', () => {
    const FIXTURE_CONFIG = ['-c', 'init.defaultBranch=main'];
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', [...FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();

    let dir: string;
    let clone: string;
    let bare: string;
    let server: ReturnType<typeof createHttpsServer>;

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
                    // The loopback remote's certificate is self-signed (minted per-test below);
                    // verification off keeps the fixture about the scheme, not the chain.
                    GIT_CONFIG_COUNT: '1',
                    GIT_CONFIG_KEY_0: 'http.sslVerify',
                    GIT_CONFIG_VALUE_0: 'false',
                    ...env,
                },
                encoding: 'utf8',
            },
        );
        return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!);
    };

    /** The marker-writing helper: the same shape as the shipped credential-helper.sh (a `!f(){
     * ... }; f` shell snippet passed as the helper CODE), with a side effect git's auth dance
     * cannot fake. */
    const markerHelper = (marker: string): string =>
        `!f(){ printf "username=u\\n"; printf "password=p\\n"; echo invoked > '${marker}'; }; f`;

    beforeEach(async () => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-cred-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# cred\n');
        execFileSync('git', [...FIXTURE_CONFIG, '-C', work, 'add', 'README.md'], { stdio: 'ignore' });
        execFileSync('git', [...FIXTURE_CONFIG, '-C', work, '-c', 'user.email=t@e.c', '-c', 'user.name=T', 'commit', '-m', 'init'], { stdio: 'ignore' });
        bare = join(dir, 'cred.git');
        execFileSync('git', [...FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        execFileSync('git', [...FIXTURE_CONFIG, 'clone', `file://${bare}`, join(dir, 'clone')], { stdio: 'ignore' });
        clone = join(dir, 'clone');
        // A throwaway self-signed certificate for the loopback https remote — the transport the
        // token would really leave over.
        const key = join(dir, 'key.pem');
        const cert = join(dir, 'cert.pem');
        execFileSync(
            'openssl',
            ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1'],
            { stdio: 'ignore' },
        );
        // The 401-everything remote: the first unauthenticated request is refused, which is
        // what sends git looking for a credential helper. Offline — loopback only.
        server = createHttpsServer(
            { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') },
            (_req, res) => {
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="factory-test"' });
                res.end('no');
            },
        );
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        git(clone, 'remote', 'set-url', 'origin', `https://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`);
    });

    afterEach(async () => {
        // git's libcurl keeps the connection alive after a refused fetch; close() alone waits
        // for it, which would hang the suite. Drop the sockets, then close.
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    it('invokes the helper for the fetch when CRED_HELPER is set against an https origin', async () => {
        const marker = join(dir, 'helper-invoked');
        // The remote never authenticates, so the sync answers ok:false — the assertion is the
        // helper having RUN, which the marker proves.
        expect((await sync({ CRED_HELPER: markerHelper(marker) })).ok).toBe(false);
        expect(existsSync(marker)).toBe(true);
    });

    it('runs the fetch plain when CRED_HELPER is absent', async () => {
        const marker = join(dir, 'helper-invoked');
        expect((await sync({})).ok).toBe(false);
        expect(existsSync(marker)).toBe(false);
    });

    it('refuses the credentialed fetch when origin is not https, and never runs the helper', async () => {
        // The remote URL is the member tree's state: a prior agent session can re-point origin
        // at a cleartext or local transport, and the next sync must not hand it the token. The
        // helper answers every credential request with the token, whatever host or scheme asks.
        git(clone, 'remote', 'set-url', 'origin', `file://${bare}`);
        const marker = join(dir, 'helper-invoked');
        const result = await sync({ CRED_HELPER: markerHelper(marker) });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('https');
        expect(existsSync(marker)).toBe(false);
    });

    it('pins the credentialed fetch to same-host redirects (http.followRedirects=initial)', async () => {
        // The fetch's exact argv, captured by a recording `git` shim earlier in PATH that logs
        // each invocation and execs the real git — the redirect pin rides the same `-c` chain
        // as the helper, so the assertion is on the argv the script builds.
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const log = join(dir, 'git-argv.log');
        const shimDir = join(dir, 'shim');
        mkdirSync(shimDir);
        writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
        chmodSync(join(shimDir, 'git'), 0o755);
        await sync({ CRED_HELPER: markerHelper(join(dir, 'helper-invoked')), PATH: `${shimDir}:${process.env.PATH}` });
        const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        expect(lines.some((line) => line.includes('http.followRedirects=initial') && line.includes('fetch origin --prune'))).toBe(true);
    });

    it('leaves the plain uncredentialed fetch ungated: a file:// origin still syncs', async () => {
        // The scheme gate exists to keep the TOKEN off non-https transports; with no token in
        // play the gate must not exist either — a public repo on any transport git can read
        // keeps its plain fetch.
        git(clone, 'remote', 'set-url', 'origin', `file://${bare}`);
        const marker = join(dir, 'helper-invoked');
        expect((await sync({})).ok).toBe(true);
        expect(existsSync(marker)).toBe(false);
    });
});

/**
 * The terminal reclaim script, against real git — the artifact the reclaim container runs once a
 * thread is finished (issue #47). Both runners parse only the LAST stdout line, so the script's
 * stated contract of one JSON verdict is load-bearing: the refusal case here pins that a refusal
 * is terminal — exactly one line, and no trailing prune or success verdict that would shadow it
 * as a successful no-op.
 */
describe.skipIf(!hasGit())('the worktree reclaim script', () => {
    const GIT_FIXTURE_CONFIG = [
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=Test',
        '-c',
        'init.defaultBranch=main',
    ];
    const git = (cwd: string, ...args: string[]): string =>
        execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();

    const ROOT = '55555555-5555-4555-8555-555555555555';
    const STALE = '66666666-6666-4666-8666-666666666666';
    const UNREGISTERED = '77777777-7777-4777-8777-777777777777';

    let dir: string;
    let clone: string;

    const wtPath = (name: string): string => join(dir, 'worktrees', name);

    const remove = (wt: string): { stdout: string; verdict: { ok: boolean; removed?: boolean; reason?: string } } => {
        // The script FILE itself, not a -e wrap: the artifact the reclaim container runs is what
        // is under test.
        const stdout = execFileSync('node', [pathOf('git-worktree-remove.cjs')], {
            env: { ...process.env, REPO: clone, WORKTREE: wt },
            encoding: 'utf8',
        });
        return { stdout, verdict: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!) };
    };

    /** A registered worktree of the clone, at a path beside it — the sync's own shape. */
    const addWorktree = (name: string): string => {
        const wt = wtPath(name);
        git(clone, 'worktree', 'add', '-b', `factory/${name}`, wt);
        return wt;
    };

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(join(tmpdir(), 'factory-reclaim-')));
        const work = join(dir, 'origin-work');
        mkdirSync(work, { recursive: true });
        git(work, 'init');
        writeFileSync(join(work, 'README.md'), '# factory\n');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, '-C', work, 'add', 'README.md'], { stdio: 'ignore' });
        execFileSync('git', [...GIT_FIXTURE_CONFIG, '-C', work, 'commit', '-m', 'init'], { stdio: 'ignore' });
        const bare = join(dir, 'factory.git');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
        clone = join(dir, 'clone');
        execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', `file://${bare}`, clone], { stdio: 'ignore' });
    });

    it('removes a registered worktree whose directory is there', () => {
        const wt = addWorktree(ROOT);
        expect(remove(wt).verdict).toEqual({ ok: true, removed: true });
        expect(existsSync(wt)).toBe(false);
        expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain(wt);
    });

    it('prunes a registered worktree whose directory is already gone', () => {
        const wt = addWorktree(ROOT);
        rmSync(wt, { recursive: true });
        expect(remove(wt).verdict).toEqual({ ok: true, removed: false });
        expect(git(clone, 'worktree', 'list', '--porcelain')).not.toContain(wt);
    });

    it('refuses an unregistered git tree with exactly one verdict, pruning nothing', () => {
        // A stale registered entry beside the refused tree: the trailing prune that used to run
        // after the refusal would have cleared it, so its survival proves nothing ran.
        const stale = addWorktree(STALE);
        rmSync(stale, { recursive: true });
        const refused = wtPath(UNREGISTERED);
        mkdirSync(refused, { recursive: true });
        writeFileSync(join(refused, '.git'), 'gitdir: /somewhere/else\n');
        writeFileSync(join(refused, 'PRECIOUS.md'), 'uncommitted work\n');

        const { stdout, verdict } = remove(refused);

        // One line, and it is the refusal: a second verdict would make the runner — which reads
        // only the last line — report this as a successful no-op.
        expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1);
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toContain('not a registered worktree');

        // The refused tree is untouched...
        expect(readFileSync(join(refused, 'PRECIOUS.md'), 'utf8')).toBe('uncommitted work\n');
        // ...and so is the stale admin entry beside it.
        expect(git(clone, 'worktree', 'list', '--porcelain')).toContain(`worktree ${stale}`);
    });

    it('removes a bare leftover with no .git at the path', () => {
        const wt = wtPath(UNREGISTERED);
        mkdirSync(wt, { recursive: true });
        writeFileSync(join(wt, 'leftover.txt'), 'not a worktree');
        expect(remove(wt).verdict).toEqual({ ok: true, removed: true });
        expect(existsSync(wt)).toBe(false);
    });

    it('is a no-op when there is nothing at the path', () => {
        expect(remove(wtPath(ROOT)).verdict).toEqual({ ok: true, removed: false });
    });
});
