import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/*
 * The branch reporter's behavior, against a stub board and real git fixtures. The reporter's
 * contract is "never fail, never speak": every test asserts exit 0 and empty stdio beside
 * whatever wire shape it pins, because one stderr line from the reporter would corrupt the
 * run output the driver tails.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLAUDE_REPORTER = join(ROOT, 'docker/claude-executor/branch-reporter.cjs');
const OPENCODE_REPORTER = join(ROOT, 'docker/opencode-executor/branch-reporter.cjs');

const SESSION = '33333333-3333-4333-8333-333333333333';

interface Request {
    path: string;
    headers: IncomingHttpHeaders;
    body: Record<string, unknown> | null;
}

const boards: Server[] = [];

const board = async (status = 200): Promise<{ url: string; requests: Request[]; waitForRequest: () => Promise<Request> }> => {
    const requests: Request[] = [];
    let notify: (() => void) | null = null;
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
            requests.push({
                path: req.url ?? '',
                headers: req.headers,
                body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
            });
            notify?.();
            notify = null;
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end('{}');
        });
    });
    boards.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const waitForRequest = () =>
        new Promise<Request>((resolve) => {
            const poll = () => {
                const seen = requests[0];
                if (seen) return resolve(seen);
                notify = () => void poll();
            };
            poll();
        });
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, waitForRequest };
};

afterAll(() => {
    for (const server of boards) server.close();
});

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'branch-reporter-'));

/** A checkout whose origin slug is acme/widgets, with one commit on main. */
const gitRepo = (): string => {
    const dir = tempDir();
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git(['init', '-q', '-b', 'main']);
    git(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    git(['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init']);
    return dir;
};

// node:sqlite still warns on stderr, and the reporter's contract is that nothing but the run
// output ever reaches it — spawn the way the entrypoints do, with the warning disabled.
const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];

const run = (
    script: string,
    env: Record<string, string>,
    args: string[] = ['--once'],
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
        const child = spawn(process.execPath, [...NODE_ARGS, script, ...args], {
            cwd: env.WORKDIR ?? process.cwd(),
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
    });

describe('the branch reporter', () => {
    it('posts the plugin’s exact wire shape for the session it was given', async () => {
        const { url, requests } = await board();
        const dir = gitRepo();
        try {
            const { status, stdout, stderr } = await run(CLAUDE_REPORTER, {
                FACTORY_STATS_URL: url,
                BELLOWS_SESSION_ID: SESSION,
                WORKDIR: dir,
            });
            expect(status).toBe(0);
            expect(stdout).toBe('');
            expect(stderr).toBe('');
            expect(requests).toHaveLength(1);
            expect(requests[0].path).toBe('/api/sessions/branch');
            expect(requests[0].body).toMatchObject({
                agent: 'claude-code',
                sessionId: SESSION,
                repo: 'acme/widgets',
                branch: 'main',
            });
            // One sample per report: the join intersects spans, so the SHA at report time is
            // what makes a moved branch attributable to the right commit.
            expect(requests[0].body?.headSha).toMatch(/^[0-9a-f]{40}$/);
            expect(Number.isNaN(Date.parse(String(requests[0].body?.at)))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('authenticates with the ingest token in a header, only when one is configured', async () => {
        const withToken = await board();
        const withoutToken = await board();
        const dir = gitRepo();
        try {
            await run(CLAUDE_REPORTER, {
                FACTORY_STATS_URL: withToken.url,
                BELLOWS_SESSION_ID: SESSION,
                WORKDIR: dir,
                INGEST_TOKEN: ' tok ',
            });
            expect(withToken.requests[0].headers['x-factory-ingest-token']).toBe('tok');
            // A credential never travels as a query parameter — it lands in access logs.
            expect(withToken.requests[0].path).toBe('/api/sessions/branch');

            await run(CLAUDE_REPORTER, {
                FACTORY_STATS_URL: withoutToken.url,
                BELLOWS_SESSION_ID: SESSION,
                WORKDIR: dir,
            });
            expect(withoutToken.requests[0].headers['x-factory-ingest-token']).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('is inert without an endpoint: silent, successful, and asks nothing', async () => {
        const { requests } = await board();
        const dir = gitRepo();
        try {
            const { status, stdout, stderr } = await run(CLAUDE_REPORTER, {
                BELLOWS_SESSION_ID: SESSION,
                WORKDIR: dir,
            });
            expect(status).toBe(0);
            expect(stdout).toBe('');
            expect(stderr).toBe('');
            expect(requests).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // Telemetry degrades alone: a board that refuses (401 on a token mismatch, 500 on a bad
    // night) must never read as a failed run. The reporter's whole error path is silence.
    it.each([401, 500])('survives a %d from the board, silently', async (refused) => {
        const { url, requests } = await board(refused);
        const dir = gitRepo();
        try {
            const { status, stdout, stderr } = await run(CLAUDE_REPORTER, {
                FACTORY_STATS_URL: url,
                BELLOWS_SESSION_ID: SESSION,
                WORKDIR: dir,
            });
            expect(status).toBe(0);
            expect(stdout).toBe('');
            expect(stderr).toBe('');
            expect(requests).toHaveLength(1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('does nothing outside a git repository', async () => {
        const { url, requests } = await board();
        const dir = tempDir();
        try {
            const { status, stdout, stderr } = await run(CLAUDE_REPORTER, {
                FACTORY_STATS_URL: url,
                BELLOWS_SESSION_ID: SESSION,
                WORKDIR: dir,
            });
            expect(status).toBe(0);
            expect(stdout).toBe('');
            expect(stderr).toBe('');
            expect(requests).toHaveLength(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // Detached HEAD reports null — the literal 'HEAD' would join to nothing while looking like
    // a branch name. The SHA still travels, so the commit is attributable even when the branch is not.
    it('reports a null branch on a detached HEAD, with the SHA', async () => {
        const { url, requests } = await board();
        const dir = gitRepo();
        execFileSync('git', ['checkout', '-q', '--detach', 'HEAD'], { cwd: dir, stdio: 'ignore' });
        try {
            await run(CLAUDE_REPORTER, {
                FACTORY_STATS_URL: url,
                BELLOWS_SESSION_ID: SESSION,
                WORKDIR: dir,
            });
            expect(requests[0].body?.branch).toBeNull();
            expect(requests[0].body?.headSha).toMatch(/^[0-9a-f]{40}$/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A fresh opencode run is given no session id: the reporter discovers it live, the same way
    // the close-time readout does — the newest ROOT session (subagents create children).
    it('discovers the newest root opencode session from the session database', async () => {
        const { url, requests } = await board();
        const dir = gitRepo();
        const data = tempDir();
        mkdirSync(join(data, 'opencode'), { recursive: true });
        const db = new DatabaseSync(join(data, 'opencode', 'opencode.db'));
        db.exec('create table session (id text primary key, parent_id text, time_created text)');
        db.prepare('insert into session values (?, ?, ?)').run('ses_old', null, '2026-01-01 00:00:00.000');
        db.prepare('insert into session values (?, ?, ?)').run('ses_child', 'ses_old', '2026-01-02 00:00:00.000');
        db.prepare('insert into session values (?, ?, ?)').run('ses_new', null, '2026-01-03 00:00:00.000');
        db.close();
        try {
            const { status, stdout, stderr } = await run(OPENCODE_REPORTER, {
                FACTORY_STATS_URL: url,
                XDG_DATA_HOME: data,
                WORKDIR: dir,
            });
            expect(status).toBe(0);
            expect(stdout).toBe('');
            expect(stderr).toBe('');
            expect(requests).toHaveLength(1);
            // The child is NOT the session, however much newer it is than nothing — the query
            // filters to roots, and this is the assertion that catches the filter being lost.
            expect(requests[0].body).toMatchObject({ agent: 'opencode', sessionId: 'ses_new' });
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(data, { recursive: true, force: true });
        }
    });

    it('prefers the session id it was handed over the database', async () => {
        const { url, requests } = await board();
        const dir = gitRepo();
        const data = tempDir();
        mkdirSync(join(data, 'opencode'), { recursive: true });
        const db = new DatabaseSync(join(data, 'opencode', 'opencode.db'));
        db.exec('create table session (id text primary key, parent_id text, time_created text)');
        db.prepare('insert into session values (?, ?, ?)').run('ses_db', null, '2026-01-01 00:00:00.000');
        db.close();
        try {
            await run(OPENCODE_REPORTER, {
                FACTORY_STATS_URL: url,
                BELLOWS_SESSION_ID: SESSION,
                XDG_DATA_HOME: data,
                WORKDIR: dir,
            });
            expect(requests[0].body?.sessionId).toBe(SESSION);
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(data, { recursive: true, force: true });
        }
    });

    // Loop mode is what the entrypoint launches: the first report lands immediately (the run may
    // be short), the process stays alive and silent, and the close-time `--once` sample is a
    // separate invocation tested above.
    it('reports immediately in loop mode and stays silent while it waits', async () => {
        const { url, waitForRequest } = await board();
        const dir = gitRepo();
        let child;
        try {
            child = spawn(process.execPath, [...NODE_ARGS, CLAUDE_REPORTER], {
                cwd: dir,
                env: { ...process.env, FACTORY_STATS_URL: url, BELLOWS_SESSION_ID: SESSION, WORKDIR: dir },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => (stdout += chunk));
            child.stderr.on('data', (chunk) => (stderr += chunk));
            const first = await waitForRequest();
            expect(first.body).toMatchObject({ agent: 'claude-code', sessionId: SESSION });
            // Still running, and having said nothing: the loop must outlive the report it came
            // for, because branch moves and session changes are exactly what it exists to catch.
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(child.exitCode).toBeNull();
            expect(stdout).toBe('');
            expect(stderr).toBe('');
        } finally {
            child?.kill();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // The boundary between two conversations is what must not blur into one span: the loop
    // reports a CHANGED session id immediately, whatever the sampling interval says.
    it('reports a changed session id immediately, not on the next interval', async () => {
        const { url, requests } = await board();
        const dir = gitRepo();
        const data = tempDir();
        mkdirSync(join(data, 'opencode'), { recursive: true });
        const db = new DatabaseSync(join(data, 'opencode', 'opencode.db'));
        db.exec('create table session (id text primary key, parent_id text, time_created text)');
        db.prepare('insert into session values (?, ?, ?)').run('ses_first', null, '2026-01-01 00:00:00.000');
        const untilRequest = (count: number) =>
            new Promise<void>((resolve, reject) => {
                const startedAt = Date.now();
                const poll = () => {
                    if (requests.length >= count) return resolve();
                    if (Date.now() - startedAt > 4_000) {
                        return reject(
                            new Error(`never saw ${count} reports; got ${JSON.stringify(requests.map((r) => r.body?.sessionId))}`),
                        );
                    }
                    setTimeout(poll, 50);
                };
                poll();
            });
        try {
            const child = spawn(process.execPath, [...NODE_ARGS, OPENCODE_REPORTER], {
                cwd: dir,
                env: { ...process.env, FACTORY_STATS_URL: url, XDG_DATA_HOME: data, WORKDIR: dir },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (chunk) => (stderr += chunk));
            try {
                await untilRequest(1);
                expect(requests[0].body?.sessionId).toBe('ses_first');
                // The row appears AFTER the first report — mid-loop, the state a live run is in
                // when its conversation starts — and the change must be reported on the very
                // next discovery, not a full sampling cycle later.
                db.prepare('insert into session values (?, ?, ?)').run('ses_second', null, '2026-01-02 00:00:00.000');
                await untilRequest(2);
                expect(requests[1].body?.sessionId).toBe('ses_second');
                expect(stderr).toBe('');
            } finally {
                child.kill();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
            rmSync(data, { recursive: true, force: true });
        }
    }, 15_000);
});
