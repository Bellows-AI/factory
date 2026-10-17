import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { envFileBody, GITHUB_CACHE_DIR, runnerClaimEnv } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker.js';
import { runnerJobSpec } from '../src/k8s-podspec.js';
import { AGENT_CONTAINER } from '../src/supervisor-contract.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The runner's GitHub helper (docs/connections.md), shipped in both executor images: what it asks
 * the board, when it renews, how often it retries, where it caches and what it says. Driven in
 * process with a fake clock and a fake board, and once as a real process to pin the channels: the
 * token on stdout only, guidance on stderr only.
 */

const HELPER = join(ROOT, 'docker/claude-executor/github-credential.cjs');
interface Deps {
    env: Record<string, string | undefined>;
    dir: string;
    now: () => number;
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    stdin: () => Promise<string>;
    stdout: (text: string) => void;
    stderr: (line: string) => void;
}
const helper = createRequire(import.meta.url)(HELPER) as {
    main: (argv: string[], deps: Deps) => Promise<number>;
    obtain: (deps: Deps) => Promise<string | null>;
    RENEW_SKEW_MS: number;
    MAX_ATTEMPTS: number;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const START = Date.parse('2026-10-16T12:00:00.000Z');
const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const PAIR_ENV = { FACTORY_STATS_URL: 'http://board.test/', RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: LEASE };
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PERMISSION_BITS = 0o777;

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'github-credential-'));
    dirs.push(dir);
    return dir;
};

type Answer = { status: number; body?: unknown } | Error;

/** A fake board answering each ask in turn (the last answer repeats), and a clock the test moves. */
function rig(answers: Answer[], env: Record<string, string | undefined> = PAIR_ENV) {
    const asks: { url: string; headers: Record<string, string> }[] = [];
    const sleeps: number[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let now = START;
    const deps: Deps = {
        env,
        dir: join(scratch(), 'factory-github'),
        now: () => now,
        fetch: (async (url: string, init: RequestInit) => {
            asks.push({ url, headers: init.headers as Record<string, string> });
            const answer = answers[Math.min(asks.length - 1, answers.length - 1)]!;
            if (answer instanceof Error) throw answer;
            return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
        }) as unknown as typeof fetch,
        sleep: async (ms) => {
            sleeps.push(ms);
        },
        stdin: async () => 'protocol=https\nhost=github.com\n\n',
        stdout: (text) => stdout.push(text),
        stderr: (line) => stderr.push(line),
    };
    return { deps, asks, sleeps, stdout, stderr, advance: (ms: number) => (now += ms) };
}

const minted = (token: string, lifetimeMs = HOUR_MS, from = START) => ({
    status: 200,
    body: { token, expiresAt: new Date(from + lifetimeMs).toISOString() },
});

describe('the runner GitHub helper', () => {
    it('asks the board with the attempt pair and answers git on stdout', async () => {
        const r = rig([minted('ghs_first_secret')]);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(0);
        expect(r.asks).toEqual([
            {
                url: `http://board.test/api/jobs/${JOB}/credentials/github`,
                headers: { 'x-factory-job-id': JOB, 'x-factory-job-lease-token': LEASE },
            },
        ]);
        expect(r.stdout.join('')).toBe('username=x-access-token\npassword=ghs_first_secret\n');
        expect(r.stderr).toEqual([]);
    });

    it('serves the cache until the renewal skew, then renews before the token expires', async () => {
        const r = rig([minted('ghs_a_secret'), minted('ghs_b_secret', HOUR_MS, START + HOUR_MS)]);
        expect(await helper.obtain(r.deps)).toBe('ghs_a_secret');
        r.advance(HOUR_MS - helper.RENEW_SKEW_MS - 1);
        expect(await helper.obtain(r.deps)).toBe('ghs_a_secret');
        expect(r.asks).toHaveLength(1);
        // Inside the skew the cached token still has minutes left, and is renewed anyway.
        r.advance(2);
        expect(await helper.obtain(r.deps)).toBe('ghs_b_secret');
        expect(r.asks).toHaveLength(2);
    });

    it('keeps the cache 0600 in a 0700 directory, and clears it on exit', async () => {
        const r = rig([minted('ghs_cached_secret')]);
        await helper.obtain(r.deps);
        const file = join(r.deps.dir, 'token.json');
        expect(statSync(file).mode & PERMISSION_BITS).toBe(FILE_MODE);
        expect(statSync(r.deps.dir).mode & PERMISSION_BITS).toBe(DIR_MODE);
        expect(await helper.main(['clear'], r.deps)).toBe(0);
        expect(existsSync(file)).toBe(false);
    });

    it('drops the cache when git reports the credential rejected, so the next ask renews', async () => {
        const r = rig([minted('ghs_old_secret'), minted('ghs_new_secret')]);
        await helper.obtain(r.deps);
        expect(await helper.main(['git', 'erase'], r.deps)).toBe(0);
        expect(await helper.obtain(r.deps)).toBe('ghs_new_secret');
    });

    it('never reads a cache another attempt wrote', async () => {
        const r = rig([minted('ghs_mine_secret')]);
        const other = rig([minted('ghs_theirs_secret')], { ...PAIR_ENV, RUNNER_LEASE_TOKEN: 'other' });
        other.deps.dir = r.deps.dir;
        await helper.obtain(other.deps);
        expect(await helper.obtain(r.deps)).toBe('ghs_mine_secret');
        expect(r.asks).toHaveLength(1);
    });

    it('retries an unreachable board a bounded number of times, backing off, then says so', async () => {
        const r = rig([new Error('connect ECONNREFUSED')]);
        expect(await helper.main(['token'], r.deps)).toBe(1);
        expect(r.asks).toHaveLength(helper.MAX_ATTEMPTS);
        expect(r.sleeps).toEqual([500, 1000]);
        expect(r.stderr.join('\n')).toContain('did not issue a GitHub token after several tries');
        expect(r.stdout).toEqual([]);
    });

    it('rides out a board error and answers the token the retry brings', async () => {
        const r = rig([{ status: 503 }, minted('ghs_retried_secret')]);
        expect(await helper.obtain(r.deps)).toBe('ghs_retried_secret');
        expect(r.asks).toHaveLength(2);
    });

    it.each([401, 403])('stops at a %s with reconnect guidance, and never retries it', async (status) => {
        const r = rig([{ status, body: { error: 'refused' } }]);
        expect(await helper.main(['git', 'get'], r.deps)).toBe(1);
        expect(r.asks).toHaveLength(1);
        expect(r.stderr.join('\n')).toContain('the board refused this attempt a GitHub token');
        expect(r.stdout).toEqual([]);
    });

    it('says the organization holds no App when the board answers 409', async () => {
        const r = rig([{ status: 409, body: { code: 'GITHUB_UNAVAILABLE' } }]);
        expect(await helper.main(['token'], r.deps)).toBe(1);
        expect(r.stderr.join('\n')).toContain('no GitHub App installation');
    });

    it('answers no host but github.com over https, and asks nothing for one', async () => {
        const r = rig([minted('ghs_unused_secret')]);
        r.deps.stdin = async () => 'protocol=https\nhost=example.com\n\n';
        expect(await helper.main(['git', 'get'], r.deps)).toBe(0);
        expect(r.stdout).toEqual([]);
        expect(r.asks).toEqual([]);
    });

    it('says why there is no token in a container without the attempt pair', async () => {
        const r = rig([minted('ghs_unused_secret')], {});
        expect(await helper.main(['token'], r.deps)).toBe(1);
        expect(r.stderr.join('\n')).toContain('no attempt credential');
        expect(r.asks).toEqual([]);
    });
});

/** A board on a loopback port answering each credential ask in turn. */
async function board(answers: { status: number; body: unknown }[]): Promise<{ url: string; server: Server }> {
    let call = 0;
    const server = createServer((request: IncomingMessage, response) => {
        const answer = answers[Math.min(call, answers.length - 1)]!;
        call += 1;
        request.resume();
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const run = promisify(execFile);

describe('the runner GitHub helper as a process', () => {
    const servers: Server[] = [];
    afterEach(async () => {
        for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    });

    const spawnHelper = (args: string[], url: string) =>
        run(process.execPath, [HELPER, ...args], {
            env: { PATH: process.env.PATH, FACTORY_STATS_URL: url, RUNNER_JOB_ID: JOB, RUNNER_LEASE_TOKEN: LEASE },
        }).then(
            (out) => ({ code: 0, ...out }),
            (error: { code: number; stdout: string; stderr: string }) => error
        );

    it('prints the token on stdout and nothing on stderr', async () => {
        const fake = await board([
            {
                status: 200,
                body: { token: 'ghs_process_secret', expiresAt: new Date(Date.now() + HOUR_MS).toISOString() },
            },
        ]);
        servers.push(fake.server);
        const out = await spawnHelper(['token'], fake.url);
        expect(out.code).toBe(0);
        expect(out.stdout).toBe('ghs_process_secret\n');
        expect(out.stderr).toBe('');
    });

    it('prints guidance on stderr, no token anywhere, and exits non-zero on a refusal', async () => {
        const fake = await board([{ status: 403, body: { error: 'refused', token: 'ghs_never_secret' } }]);
        servers.push(fake.server);
        const out = await spawnHelper(['token'], fake.url);
        expect(out.code).not.toBe(0);
        expect(out.stdout).toBe('');
        expect(out.stderr).toContain('Do not retry');
        expect(out.stderr).not.toContain('ghs_never_secret');
    });
});

describe('the gh wrapper and the helper in both images', () => {
    const IMAGES = ['docker/claude-executor', 'docker/opencode-executor'];
    const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

    it('ships byte-identical copies of the helper and the wrapper', () => {
        expect(read('docker/opencode-executor/github-credential.cjs')).toBe(
            read('docker/claude-executor/github-credential.cjs')
        );
        expect(read('docker/opencode-executor/gh-wrapper.sh')).toBe(read('docker/claude-executor/gh-wrapper.sh'));
    });

    it.each(IMAGES)('%s installs the real gh in libexec and the wrapper as /usr/local/bin/gh', (dir) => {
        const dockerfile = read(`${dir}/Dockerfile`);
        expect(dockerfile).toMatch(/mv "[^"]*\/bin\/gh" \/usr\/local\/libexec\/gh/);
        expect(dockerfile).toMatch(/^COPY gh-wrapper\.sh \/usr\/local\/bin\/gh$/m);
        expect(dockerfile).toMatch(/^COPY github-credential\.cjs \/usr\/local\/bin\/github-credential\.cjs$/m);
        expect(dockerfile).toMatch(/chmod 0755 \/usr\/local\/bin\/gh \/usr\/local\/bin\/github-credential\.cjs /);
    });

    it('hands gh the helper token only when no token is already set', async () => {
        const wrapper = read('docker/claude-executor/gh-wrapper.sh');
        expect(wrapper).toMatch(/^if \[ -z "\$\{GH_TOKEN:-\}" \] && \[ -z "\$\{GITHUB_TOKEN:-\}" \]; then$/m);
        expect(wrapper).toContain('GH_TOKEN="$(node /usr/local/bin/github-credential.cjs token)"');
        expect(wrapper.trimEnd().split('\n').at(-1)).toBe('exec /usr/local/libexec/gh "$@"');
        // POSIX sh: the images ship dash.
        await expect(run('sh', ['-n', join(ROOT, 'docker/claude-executor/gh-wrapper.sh')])).resolves.toBeDefined();
    });

    it('needs no write to anything but the cache directory it is given', () => {
        // The cache path is a constant, never an env name a member could point at a shared volume.
        const source = read('docker/claude-executor/github-credential.cjs');
        expect(source).toContain("const CACHE_DIR = '/run/factory-github';");
        expect(source).not.toMatch(/process\.env\.[A-Z_]*DIR/);
    });
});

describe('the token cache and the runner env, on both executors', () => {
    const USER = '44444444-4444-4444-8444-444444444444';
    const MEMBER_TOKEN = 'ghp_member_value_never_forwarded';
    const runnerJob = {
        id: JOB,
        command: 'push the fix',
        rootCommand: 'push the fix',
        attempts: 1,
        maxAttempts: 1,
        lastAttempt: false,
        claimSeq: 1,
        leaseToken: LEASE,
        leaseExpiresAt: '2026-10-16T12:05:00.000Z',
        executorType: 'claude-code',
        executorRefusal: null,
        planRefusal: null,
        skillRefusal: null,
        masterPrompt:
            'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
        resumeSessionId: null,
        followUp: false,
        userId: USER,
        workspacePath: `bellows/${USER}`,
        repo: 'Bellows-AI/factory',
        // A board that still sent one: both names are reserved, so neither may reach a runner.
        env: { GITHUB_TOKEN: MEMBER_TOKEN, GH_TOKEN: MEMBER_TOKEN, MEMBER_VAR: 'member' },
    } as BoardJob;
    const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };

    it("caches where the image's helper writes", () => {
        expect(GITHUB_CACHE_DIR).toBe((helper as unknown as { CACHE_DIR: string }).CACHE_DIR);
    });

    it('docker mounts a 0700 memory tmpfs over the cache in the agent container', () => {
        const args = dockerArgs(loadDriverConfig({}), runnerJob, SESSION, { envFile: '/tmp/agent.env' });
        const at = args.indexOf('--tmpfs');
        expect(args[at + 1]).toBe(`${GITHUB_CACHE_DIR}:rw,noexec,nosuid,size=1m,mode=0700,uid=1000`);
        expect(args.join(' ')).not.toContain(MEMBER_TOKEN);
        expect(envFileBody(runnerJob, loadDriverConfig({}))).not.toMatch(/^(GITHUB_TOKEN|GH_TOKEN)=/m);
    });

    it('kubernetes mounts a Memory emptyDir over the cache in the agent container alone', () => {
        const spec = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), runnerJob, SESSION).spec.template.spec;
        expect(spec.volumes).toContainEqual({ name: 'github-cache', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } });
        const mounting = spec.containers
            .filter((c) => c.volumeMounts.some((m) => m.mountPath === GITHUB_CACHE_DIR))
            .map((c) => c.name);
        expect(mounting).toEqual([AGENT_CONTAINER]);
        // No GitHub value rides the pod spec or the Secret's claim half.
        expect(JSON.stringify(spec)).not.toContain(MEMBER_TOKEN);
        expect(runnerClaimEnv(runnerJob)).toEqual({ MEMBER_VAR: 'member' });
    });
});

describe('the stated limit of a gate environment’s token', () => {
    it('is in docs/connections.md: asked at each gate run’s start, never renewed during it', () => {
        const docs = readFileSync(join(ROOT, 'docs/connections.md'), 'utf8').replace(/\s+/g, ' ');
        expect(docs).toContain("A gate run's GitHub token is asked at its start and never renewed during it");
        expect(docs).toContain('Secret replaced for the run (`driver/src/k8s-gates.ts`)');
    });
});
