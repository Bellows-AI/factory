import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasGit, hasOpenssl } from './fixtures/scripts-support.js';

const execFile = promisify(execFileCb);

const UNAUTHORIZED_STATUS = 401;
const FIXTURE_CONFIG = ['-c', 'init.defaultBranch=main'];

const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', [...FIXTURE_CONFIG, ...args], { cwd, encoding: 'utf8' }).trim();

/** The marker-writing helper: the same shape as the shipped credential-helper.sh (a `!f(){
 * ... }; f` shell snippet passed as the helper CODE), with a side effect git's auth dance
 * cannot fake. */
const markerHelper = (marker: string): string =>
    `!f(){ printf "username=u\\n"; printf "password=p\\n"; echo invoked > '${marker}'; }; f`;

interface CredentialHelperFixture {
    dir: () => string;
    clone: () => string;
    bare: () => string;
    // ASYNC on purpose: the 401 server lives on THIS worker's event loop, and a synchronous
    // execFile would block the very loop the fetch needs to answer the credential round-trips —
    // the fetch would wait on a server that cannot run. Awaited, the loop stays free.
    sync: (env: Record<string, string>) => Promise<{ ok: boolean; reason: string | null }>;
}

/**
 * Builds one bare-remote + clone + self-signed-HTTPS-remote layout per test, and registers the
 * `beforeEach`/`afterEach` that create and tear it down. Must be called from inside a `describe`.
 * The 401-everything remote is what sends git looking for a credential helper.
 */
function credentialHelperFixture(): CredentialHelperFixture {
    let dir: string;
    let clone: string;
    let bare: string;
    let server: ReturnType<typeof createHttpsServer>;

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
            }
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
        execFileSync(
            'git',
            [...FIXTURE_CONFIG, '-C', work, '-c', 'user.email=t@e.c', '-c', 'user.name=T', 'commit', '-m', 'init'],
            { stdio: 'ignore' }
        );
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
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-keyout',
                key,
                '-out',
                cert,
                '-days',
                '2',
                '-nodes',
                '-subj',
                '/CN=127.0.0.1',
            ],
            { stdio: 'ignore' }
        );
        // The 401-everything remote: the first unauthenticated request is refused, which is
        // what sends git looking for a credential helper. Offline — loopback only.
        server = createHttpsServer(
            { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') },
            (_req, res) => {
                res.writeHead(UNAUTHORIZED_STATUS, { 'WWW-Authenticate': 'Basic realm="factory-test"' });
                res.end('no');
            }
        );
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        git(
            clone,
            'remote',
            'set-url',
            'origin',
            `https://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`
        );
    });

    afterEach(async () => {
        // git's libcurl keeps the connection alive after a refused fetch; close() alone waits
        // for it, which would hang the suite. Drop the sockets, then close.
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    return { dir: () => dir, clone: () => clone, bare: () => bare, sync };
}

/**
 * The sync fetch's credential wiring, against real git — the same offline shape as
 * worktree.test.ts, except the remote: an HTTPS URL, because the token-leak finding is ABOUT the
 * transport a credential rides: the helper answers every credential request with the token, so
 * the suite must exercise the scheme the token would actually leave over. GIT_* config is pinned
 * to /dev/null so the host's own helpers (osxkeychain and friends) stay out of the dance
 * entirely; the fixture's certificate is self-signed, so TLS verification is switched off for
 * the script's git children — what is under test is the scheme gate and the helper wiring, not
 * the chain of trust.
 *
 * Split into two describe blocks for the line-count cap, sharing the fixture above: whether the
 * helper runs (and over which scheme) here, the argv-shape pins below.
 */
describe.skipIf(!hasGit() || !hasOpenssl())('the sync fetch credential helper', () => {
    const fx = credentialHelperFixture();

    it('invokes the helper for the fetch when CRED_HELPER is set against an https origin', async () => {
        const marker = join(fx.dir(), 'helper-invoked');
        // The remote never authenticates, so the sync answers ok:false — the assertion is the
        // helper having RUN, which the marker proves.
        expect((await fx.sync({ CRED_HELPER: markerHelper(marker) })).ok).toBe(false);
        expect(existsSync(marker)).toBe(true);
    });

    it('runs the fetch plain when CRED_HELPER is absent', async () => {
        const marker = join(fx.dir(), 'helper-invoked');
        expect((await fx.sync({})).ok).toBe(false);
        expect(existsSync(marker)).toBe(false);
    });

    it('refuses the credentialed fetch when origin is not https, and never runs the helper', async () => {
        // The remote URL is the member tree's state: a prior agent session can re-point origin
        // at a cleartext or local transport, and the next sync must not hand it the token. The
        // helper answers every credential request with the token, whatever host or scheme asks.
        git(fx.clone(), 'remote', 'set-url', 'origin', `file://${fx.bare()}`);
        const marker = join(fx.dir(), 'helper-invoked');
        const result = await fx.sync({ CRED_HELPER: markerHelper(marker) });
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('https');
        expect(existsSync(marker)).toBe(false);
    });
});

describe.skipIf(!hasGit() || !hasOpenssl())('the sync fetch credential helper: argv shape', () => {
    const fx = credentialHelperFixture();
    const EXECUTABLE_MODE = 0o755;

    it('pins the credentialed fetch to same-host redirects (http.followRedirects=initial)', async () => {
        // The fetch's exact argv, captured by a recording `git` shim earlier in PATH that logs
        // each invocation and execs the real git — the redirect pin rides the same `-c` chain
        // as the helper, so the assertion is on the argv the script builds.
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const log = join(fx.dir(), 'git-argv.log');
        const shimDir = join(fx.dir(), 'shim');
        mkdirSync(shimDir);
        writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
        chmodSync(join(shimDir, 'git'), EXECUTABLE_MODE);
        await fx.sync({
            CRED_HELPER: markerHelper(join(fx.dir(), 'helper-invoked')),
            PATH: `${shimDir}:${process.env.PATH}`,
        });
        const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        expect(
            lines.some((line) => line.includes('http.followRedirects=initial') && line.includes('fetch origin --prune'))
        ).toBe(true);
    });

    it('leaves the plain uncredentialed fetch ungated: a file:// origin still syncs', async () => {
        // The scheme gate exists to keep the TOKEN off non-https transports; with no token in
        // play the gate must not exist either — a public repo on any transport git can read
        // keeps its plain fetch.
        git(fx.clone(), 'remote', 'set-url', 'origin', `file://${fx.bare()}`);
        const marker = join(fx.dir(), 'helper-invoked');
        expect((await fx.sync({})).ok).toBe(true);
        expect(existsSync(marker)).toBe(false);
    });
});
