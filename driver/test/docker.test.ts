import { describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { claimEnv, containerName, createDockerRunner, dockerArgs, envFileBody, opencodeSessionReadoutArgs, parseOpencodeSessionId, parseRemoteSessionId, remoteSessionArgs, reportTail, tailBytes } from '../src/docker.js';
import { networkName, serviceRunArgs } from '../src/services.js';

/*
 * The env-file write is the one await between the setup's final kill-check and the spawn, and a
 * test below needs the kill to land INSIDE it — deterministically. The mock passes every call
 * through to the real fs and only parks when a test has armed the gate; every other test in
 * this file is unaffected.
 */
const fsHook = vitest.hoisted(() => ({ gate: null as null | ((path: string) => Promise<void>) }));

vitest.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            if (fsHook.gate) await fsHook.gate(String(args[0]));
            return actual.writeFile(...args);
        },
    };
});

const USER = '44444444-4444-4444-8444-444444444444';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
};

const SESSION = '33333333-3333-4333-8333-333333333333';

const args = (env: NodeJS.ProcessEnv = {}, session: RunSession | null = { id: SESSION, resume: false }, servicesNetwork: string | null = null) =>
    dockerArgs(loadDriverConfig(env), job, session, servicesNetwork);

const resumed = (env: NodeJS.ProcessEnv = {}) =>
    dockerArgs(loadDriverConfig(env), job, { id: SESSION, resume: true });

describe('the docker run arguments', () => {
    it('runs the command as a prompt, after the image', () => {
        expect(args().slice(-5)).toEqual([
            'claude-executor',
            '--session-id',
            SESSION,
            '-p',
            'fix the failing build',
        ]);
    });

    // The link the UI shows is built from this, so it has to be the id the runner actually uses —
    // which is why it is given to the CLI rather than read back out of it.
    it('tells the runner which session id to use, in both modes', () => {
        expect(args()).toEqual(expect.arrayContaining(['--session-id', SESSION]));
        expect(args({ RUNNER_REMOTE_CONTROL: '1' })).toEqual(
            expect.arrayContaining(['--session-id', SESSION]),
        );
    });

    it('mounts the checkouts volume and starts at the AUTHOR\'s workspace root', () => {
        // Was `/workspaces/<orgId>`, built from the driver's own ORG_ID — one tree every member's
        // agent shared. The board sends the path now, because it owns the layout; this process
        // only knows where the volume is mounted.
        expect(args()).toEqual(
            expect.arrayContaining([
                '-v',
                'factory-ai_workspaces:/workspaces',
                `WORKDIR=/workspaces/bellows/${USER}`,
            ]),
        );
    });

    it('refuses a workspace path that is not <org>/<uuid>', () => {
        /*
         * The board is not something this process trusts with a fragment of a command line — the
         * same rule remoteSessionArgs applies to a session id, and the stakes are higher here:
         * the value becomes the agent's working directory, and `..` in it points at the parent of
         * every member's tree.
         */
        for (const path of [
            '../../etc',
            'bellows/../../etc',
            'bellows/not-a-uuid',
            `/absolute/${USER}`,
            `bellows/${USER}/extra`,
            null,
        ]) {
            expect(
                () => dockerArgs(loadDriverConfig({}), { ...job, workspacePath: path }, { id: SESSION, resume: false }),
                String(path),
            ).toThrow(/no usable workspace path/);
        }
    });

    // The same discipline the workspace reconcile applies to the git token: `-e NAME` makes docker
    // read the value from the driver's environment, where `-e NAME=value` would publish it to every
    // `ps` on the host.
    it('names credentials without ever putting their values on the command line', () => {
        const line = args({ RUNNER_ENV: 'CLAUDE_CODE_OAUTH_TOKEN' });
        expect(line).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN']));
        expect(line.some((arg) => arg.includes('CLAUDE_CODE_OAUTH_TOKEN='))).toBe(false);
    });

    it('labels the container so an orphan can be found after the driver dies', () => {
        expect(args()).toEqual(
            expect.arrayContaining(['--name', containerName(job), '--label', `factory.job=${job.id}`]),
        );
    });

    it('joins a network only when one is configured', () => {
        expect(args()).not.toContain('--network');
        expect(args({ RUNNER_NETWORK: 'factory-ai_default' })).toEqual(
            expect.arrayContaining(['--network', 'factory-ai_default']),
        );
    });

    // servicesNetwork is null whenever the job declared no services — and then the argv is
    // byte-identical to what the pins above and below expect, which is the compatibility promise
    // the whole feature makes: no .bellows.yaml, no difference.
    it('joins the per-job services network only when one is given', () => {
        expect(args()).not.toContain(networkName(job));
        expect(args({}, { id: SESSION, resume: false }, networkName(job))).toEqual(
            expect.arrayContaining(['--network', networkName(job)]),
        );
    });

    it('can sit on both the configured and the per-job network', () => {
        // RUNNER_NETWORK carries telemetry to the collector; the services network carries the
        // job's DNS aliases. Two different jobs for one container — and a Docker 25.0 floor
        // (API 1.44 is where multi-network create landed): on an older daemon the last --network
        // silently wins, so a driver running services plus a telemetry network needs a current
        // docker, which docs/jobs.md states.
        const line = args({ RUNNER_NETWORK: 'factory-ai_default' }, { id: SESSION, resume: false }, networkName(job));
        expect(line.filter((arg) => arg === '--network')).toHaveLength(2);
        expect(line.indexOf('factory-ai_default')).toBeGreaterThanOrEqual(0);
        expect(line.indexOf(networkName(job))).toBeGreaterThan(line.indexOf('factory-ai_default'));
    });

    it('skips permissions only when told to', () => {
        expect(args()).not.toContain('--dangerously-skip-permissions');
        expect(args({ RUNNER_SKIP_PERMISSIONS: '1' })).toContain('--dangerously-skip-permissions');
    });

    // --rm is gone deliberately: cleanup is explicit (a `docker rm` after close), so the runner
    // can ask the daemon whether a 125 run left a container behind before removing it.
    it('leaves nothing behind, by explicit cleanup rather than --rm', () => {
        expect(args()).not.toContain('--rm');
    });
});

describe('the board\'s environment', () => {
    const envJob: BoardJob = {
        ...job,
        env: { MY_TOKEN: 'board-secret', WORKDIR: '/etc', TRUST_WORKDIR: '1' },
    };

    it('reads a claim without an env field as no environment', () => {
        // A board that predates the field omits it — the established defensive read.
        expect(claimEnv(job)).toEqual({});
    });

    it('carries the claim env into the runner by env file, never through this process', () => {
        /*
         * `-e NAME` reads the value from the docker CLI's OWN environment — and claim names are
         * member-controlled. A member's PATH or DOCKER_HOST there steers the CLI the driver
         * executes on the host, which is host code execution, not "the runner's environment". So
         * the values travel in a --env-file the driver writes and removes, and this process's
         * environment stays exactly the operator's.
         */
        const line = dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false }, null, '/tmp/env-file');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
        expect(line).not.toContain('MY_TOKEN');
        expect(line.some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    it('gives the claim precedence over the driver’s own forwarded names', () => {
        // docker gives `-e` precedence over `--env-file`, so a name the claim also carries must
        // not go out as `-e` — otherwise the driver's own value would silently win.
        const configured = loadDriverConfig({ RUNNER_ENV: 'MY_TOKEN,OTHER' });
        const line = dockerArgs(configured, envJob, { id: SESSION, resume: false }, null, '/tmp/env-file');
        expect(line).toEqual(expect.arrayContaining(['-e', 'OTHER']));
        expect(line).not.toContain('MY_TOKEN');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    it('refuses to run a claim that carries env with no env file to put it in', () => {
        // A silent drop would run the job without the credentials it was queued against.
        expect(() => dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false })).toThrow(
            /no env file/,
        );
    });

    it('writes one NAME=value line per variable, reserved names dropped', () => {
        expect(envFileBody(envJob)).toBe('MY_TOKEN=board-secret\n');
        expect(envFileBody(job)).toBe('');
        // A value with a newline would corrupt the file's line structure — refused, not mangled.
        expect(() =>
            envFileBody({ ...job, env: { BROKEN: 'line1\nline2' } }),
        ).toThrow(/newline/);
    });

    it('never forwards a name the runner itself claims', () => {
        expect(claimEnv(envJob)).toEqual({ MY_TOKEN: 'board-secret' });
        const line = dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false }, null, '/tmp/env-file');
        // The one WORKDIR on the line is the runner's own, with the mount in it; TRUST_WORKDIR
        // belongs to the Remote Control branch, which this is not.
        expect(line.filter((arg) => arg === 'WORKDIR' || arg === 'TRUST_WORKDIR')).toHaveLength(0);
        expect(line).toEqual(expect.arrayContaining([`WORKDIR=/workspaces/bellows/${USER}`]));
    });

    it('forwards no board env to a Remote Control runner, and writes no env file for one', () => {
        // The same exclusion RUNNER_ENV obeys: a forwarded credential does not fail there, it
        // degrades the session in silence.
        const line = dockerArgs(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '1' }), envJob, {
            id: SESSION,
            resume: false,
        }, null, '/tmp/env-file');
        expect(line).not.toContain('--env-file');
        expect(line).not.toContain('MY_TOKEN');
        expect(line.some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    it('writes no env file for a claim without env', () => {
        expect(envFileBody(job)).toBe('');
        const line = dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, null, '/tmp/env-file');
        expect(line).not.toContain('--env-file');
    });
});

describe('a follow-up run', () => {
    const followUp = { ...job, followUp: true };

    /**
     * The one new thing a follow-up asks of the runner: restore the parent conversation AND
     * deliver the new command into it. A plain resume restores only, because its command is
     * already in the transcript — a follow-up's command is not, and without the `-p` the
     * adjustment would never reach the agent.
     */
    it('delivers the command into the restored session', () => {
        const line = dockerArgs(loadDriverConfig({}), followUp, { id: SESSION, resume: true });
        expect(line.slice(-5)).toEqual([
            'claude-executor',
            '--resume',
            SESSION,
            '-p',
            'fix the failing build',
        ]);
        expect(line).not.toContain('--session-id');
    });

    it('delivers it under Remote Control as the opening prompt of the restored session', () => {
        const line = dockerArgs(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '1' }), followUp, {
            id: SESSION,
            resume: true,
        });
        expect(line.slice(-5)).toEqual([
            '--resume',
            SESSION,
            '--remote-control',
            containerName(job),
            'fix the failing build',
        ]);
    });

    // The delivered-once rule is not suspended for follow-ups: a PARKED one has its command in
    // the transcript already, and its resume is an ordinary resume. Only the board knows which
    // kind of resume a claim is — hence the flag rather than a local guess.
    it('still omits the command when a parked job is resumed', () => {
        const line = dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: true });
        expect(line.slice(-3)).toEqual(['claude-executor', '--resume', SESSION]);
        expect(line).not.toContain('fix the failing build');
    });
});

describe('reading the remote session id', () => {
    it('reads the bridge record out of the running container, by session id', () => {
        const line = remoteSessionArgs(job, SESSION);
        expect(line.slice(0, 4)).toEqual(['exec', containerName(job), 'sh', '-c']);
        expect(line[4]).toContain(`${SESSION}.jsonl`);
        expect(line[4]).toContain('bridge-session');
    });

    // The id arrives from the board on a resume, and a board is not something this process should
    // trust with a fragment of a shell command.
    it('refuses a session id that is not a uuid, rather than interpolating it', () => {
        expect(() => remoteSessionArgs(job, '$(touch /tmp/pwned)')).toThrow('not a uuid');
    });

    it('pulls the remote id out of the transcript line', () => {
        const line = JSON.stringify({
            type: 'bridge-session',
            sessionId: SESSION,
            bridgeSessionId: 'cse_015tb2nHhHNrBuL7ZDhn9Wx5',
        });
        expect(parseRemoteSessionId(line)).toBe('cse_015tb2nHhHNrBuL7ZDhn9Wx5');
    });

    // Every one of these is the ordinary case: the bridge has not connected, or the file is being
    // written as it is read.
    it.each([['', 'nothing yet'], ['not json', 'a partial line'], ['{"type":"mode"}', 'another record']])(
        'answers null for %p (%s)',
        (line) => {
            expect(parseRemoteSessionId(line)).toBeNull();
        },
    );
});

describe('a Remote Control runner', () => {
    const rc = (env: NodeJS.ProcessEnv = {}) => args({ RUNNER_REMOTE_CONTROL: '1', ...env });

    it('starts an interactive session with the command as its opening prompt', () => {
        expect(rc().slice(-3)).toEqual(['--remote-control', containerName(job), 'fix the failing build']);
        expect(rc()).not.toContain('-p');
    });

    /**
     * `-t` and never `-i -t`. The CLI will not start an interactive session without a tty, but the
     * driver's stdin is not a terminal, and `docker run -i` from such a process fails outright with
     * "the input device is not a TTY" — so the pairing that looks obvious is the one that breaks.
     */
    it('allocates a tty without attaching stdin to it', () => {
        expect(rc()).toContain('-t');
        expect(rc()).not.toContain('-i');
        expect(args()).not.toContain('-t');
    });

    /**
     * The two halves of resuming a parked job. `--resume` keeps the original session id rather than
     * forking it, so the link the UI shows still opens the session — and the command is NOT
     * re-delivered, because it is already in the transcript and sending it again would re-run the
     * work somebody has been driving by hand.
     */
    it('restores the session instead of starting one, without re-sending the command', () => {
        const line = resumed({ RUNNER_REMOTE_CONTROL: '1' });
        expect(line.slice(-4)).toEqual([
            '--resume',
            SESSION,
            '--remote-control',
            containerName(job),
        ]);
        expect(line).not.toContain('--session-id');
        expect(line).not.toContain('fix the failing build');
    });

    it('mounts the login volume over the config directory', () => {
        expect(rc()).toEqual(expect.arrayContaining(['-v', 'claude-executor-auth:/home/node/.claude']));
        expect(rc({ RUNNER_AUTH_VOLUME: 'other' })).toEqual(
            expect.arrayContaining(['-v', 'other:/home/node/.claude']),
        );
        expect(args().join(' ')).not.toContain('/home/node/.claude');
    });

    /**
     * The failure this prevents is silent, which is why it is pinned. Remote Control needs a
     * claude.ai subscription login; given a token instead, `--remote-control` still starts a
     * perfectly ordinary local session and the only symptom is that it never appears at
     * claude.ai/code.
     */
    it('forwards no credentials, so the volume login is the only one available', () => {
        expect(rc({ RUNNER_ENV: 'CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY' })).not.toContain(
            'CLAUDE_CODE_OAUTH_TOKEN',
        );
    });

    // An interactive session started by a driver has nobody to answer the trust dialog.
    it('accepts the trust dialog for the mount', () => {
        expect(rc()).toEqual(expect.arrayContaining(['-e', 'TRUST_WORKDIR=1']));
        expect(args()).not.toContain('TRUST_WORKDIR=1');
    });
});

describe('an opencode runner', () => {
    const oc = (env: NodeJS.ProcessEnv = {}) => args({ RUNNER_CLI: 'opencode', ...env }, null);

    // opencode's asymmetry, per the repo's own executor spec: `run --session <id>` CONTINUES an
    // existing session, it cannot adopt one minted in advance. So a fresh run is just
    // `run <command>` — the id it uses is scraped after the run and reported then.
    it('runs the command headless, with no session id at all', () => {
        const line = oc();
        expect(line.slice(-3)).toEqual(['opencode-executor', 'run', 'fix the failing build']);
        expect(line).not.toContain('--session-id');
        expect(line).not.toContain('--resume');
        expect(line).not.toContain(SESSION);
    });

    // The session database has to outlive the container or there is nothing to resume into: a
    // fresh container starts with an empty one. It lives per member, next to their checkouts, on
    // the workspaces volume.
    it('persists the session database under the member’s own workspace tree', () => {
        expect(oc()).toEqual(
            expect.arrayContaining(['-e', `XDG_DATA_HOME=/workspaces/bellows/${USER}/.opencode`]),
        );
    });

    /**
     * The follow-up: the claim carries the session opencode ITSELF created (scraped and reported
     * when the parent ran), and `run --session <id> <command>` continues that conversation with
     * the new adjustment. This is what makes an opencode task follow-up-able.
     */
    it('continues its own session with the new command on a follow-up', () => {
        const line = dockerArgs(loadDriverConfig({ RUNNER_CLI: 'opencode' }), { ...job, followUp: true }, {
            id: 'ses_f86188c3dffeZGYO4yZq4atba9',
            resume: true,
        });
        expect(line.slice(-5)).toEqual([
            'opencode-executor',
            'run',
            '--session',
            'ses_f86188c3dffeZGYO4yZq4atba9',
            'fix the failing build',
        ]);
    });

    // Standby is a Remote Control feature and opencode cannot be configured for it, so a resume
    // with nothing to deliver means board state from before a RUNNER_CLI flip. The loop refuses
    // it first; the runner refuses it too, because a headless run restoring a session without a
    // command would idle to its deadline.
    it('refuses to restore a session when there is no command to deliver', () => {
        expect(() => resumed({ RUNNER_CLI: 'opencode' })).toThrow(/session/);
        expect(() => oc()).not.toThrow();
    });

    it('keeps the explicit-image rule', () => {
        expect(oc({ EXECUTOR_IMAGE: 'registry/oc:2' }).slice(-2)).toEqual([
            'run',
            'fix the failing build',
        ]);
    });

    // The claude pins hold unchanged, because nothing about the docker-level posture depends on
    // which CLI is behind the image: workspace, label, name, and credentials by name only.
    it('keeps every docker-level invariant', () => {
        const line = oc({ RUNNER_ENV: 'ANTHROPIC_API_KEY' });
        expect(line).toEqual(
            expect.arrayContaining([
                '--name',
                containerName(job),
                '--label',
                `factory.job=${job.id}`,
                '-v',
                'factory-ai_workspaces:/workspaces',
                `WORKDIR=/workspaces/bellows/${USER}`,
                '-e',
                'ANTHROPIC_API_KEY',
            ]),
        );
        expect(line.some((arg) => arg.includes('ANTHROPIC_API_KEY='))).toBe(false);
    });
});

describe('scraping the session opencode used', () => {
    /**
     * The readout is a throwaway container over the workspaces volume, entrypoint swapped for
     * node — the job container is already gone by the time it runs, and the driver has no host
     * path into a named volume. Pure and pinned for the same reason dockerArgs is.
     */
    it('reads the session database out of the member’s data directory, root sessions only', () => {
        const line = opencodeSessionReadoutArgs(loadDriverConfig({ RUNNER_CLI: 'opencode' }), job);
        expect(line.slice(0, 8)).toEqual([
            'run',
            '--rm',
            '-v',
            'factory-ai_workspaces:/workspaces',
            '--entrypoint',
            'node',
            'opencode-executor',
            '-e',
        ]);
        expect(line[8]).toContain(`/workspaces/bellows/${USER}/.opencode/opencode/opencode.db`);
        expect(line[8]).toContain('parent_id is null');
        expect(line[8]).toContain('readOnly');
    });

    it('pulls the session id out of the readout’s answer, and nothing that is not one', () => {
        expect(parseOpencodeSessionId('ses_f86188c3dffeZGYO4yZq4atba9\n')).toBe(
            'ses_f86188c3dffeZGYO4yZq4atba9',
        );
        expect(parseOpencodeSessionId('')).toBeNull();
        // Not a session id: a path, an error line, or a uuid that would read as claude's.
        expect(parseOpencodeSessionId('/workspaces/bellows/x/.opencode')).toBeNull();
        expect(parseOpencodeSessionId('Error: Session not found')).toBeNull();
        expect(parseOpencodeSessionId('33333333-3333-4333-8333-333333333333')).toBeNull();
    });
});

/*
 * The report has to fit the board's 128 KiB body limit whatever the log contained — a refused
 * report leaves the job to its lease and re-runs finished work, which is worse than a short log.
 * A character count cannot state that bound: 64 Ki of CJK text is 192 KiB of UTF-8, and a control
 * character expands six-fold under JSON escaping. Hence bytes.
 */
describe('the report tail', () => {
    it('answers nothing for a log that already fits', () => {
        expect(tailBytes('hello', 64)).toBe('hello');
        // Multibyte text, well under the limit, comes back exactly as it went in.
        expect(tailBytes('café ☕', 64)).toBe('café ☕');
    });

    it('caps by UTF-8 bytes, not by characters', () => {
        // Each ☕ is three bytes: 10_000 of them are 30_000 bytes in only 10_000 characters.
        const log = '☕'.repeat(10_000);
        const tail = tailBytes(log, 16 * 1024);

        expect(tail.length).toBeLessThan(log.length);
        expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(16 * 1024 + 3);
    });

    it('keeps the tail, not the head', () => {
        expect(tailBytes('head-head-head-tail', 4)).toBe('tail');
    });

    it('still answers a string when the limit cuts a multibyte character', () => {
        const tail = tailBytes('☕'.repeat(100), 4);
        // One replaced character at most: the cut lands inside a three-byte one.
        expect(tail.length).toBeLessThanOrEqual(2);
    });

    it('reportTail fits a JSON-escaped complete POST under the board body limit', () => {
        // The worst log: three-byte characters, then control characters that JSON escaping
        // expands six-fold.
        const worst = 'あ\u0001'.repeat(64 * 1024);
        const body = JSON.stringify({
            leaseToken: '22222222-2222-4222-8222-222222222222',
            status: 'succeeded',
            exitCode: 0,
            output: reportTail(worst),
        });
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(128 * 1024);
    });
});

/**
 * A child that streams the given text and exits, the way `spawn`'s product behaves — enough of
 * one for the runner, which reads two streams and a close event and nothing else.
 */
function fakeChild(stdout: string, stderr: string, code: number | null): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stream = (text: string) => {
        const s = new EventEmitter();
        if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
        return s;
    };
    child.stdout = stream(stdout);
    child.stderr = stream(stderr);
    process.nextTick(() => child.emit('close', code));
    return child;
}

describe('the docker runner', () => {
    // The daemon is stood in by `execDocker`, so the suite never shells out: the fence and the
    // cleanup `rm` answer empty, and the `inspect` that classifies a 125 close is scripted per
    // test. The fake child carries whatever the run itself printed.
    const noContainer = (args: string[]) => {
        if (args[0] === 'inspect') throw new Error('Error: No such object');
        return Promise.resolve({ stdout: '' });
    };
    const child = (stdout: string, stderr: string, code: number | null) =>
        (() => {
            const c = new EventEmitter() as ChildProcess;
            const stream = (text: string) => {
                const s = new EventEmitter();
                if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
                return s;
            };
            c.stdout = stream(stdout);
            c.stderr = stream(stderr);
            process.nextTick(() => c.emit('close', code));
            return c;
        }) as unknown as typeof spawn;

    it('reads a daemon refusal as a container that never started', async () => {
        // The run printed the daemon's error — and so would a command that echoed it. The
        // classifier does not read this stream at all: the daemon says no container exists.
        const runner = createDockerRunner(
            loadDriverConfig({}),
            child('', 'docker: Error response from daemon: Conflict. The container name is already in use\n', 125),
            noContainer,
        );
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
    });

    it('reads a container that ran and exited 125 as a verdict, not an infrastructure refusal', async () => {
        // The exact case a stderr signature gets wrong: the command prints `docker: ` itself —
        // an agent reproducing an error, say — and exits 125. The daemon saw the container run
        // and exit, so `started` is true and the code is reported as the command's verdict.
        const inspect = vitest.fn((args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":125}\n' })
                : Promise.resolve({ stdout: '' }),
        );
        const runner = createDockerRunner(
            loadDriverConfig({}),
            child('work done\n', 'reproduced: docker: Error response from daemon: Conflict\n', 125),
            inspect as unknown as (args: string[]) => Promise<{ stdout: string }>,
        );
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: true });
        expect(inspect).toHaveBeenCalled();
    });

    it('never asks the daemon about a run whose exit code is unambiguous', async () => {
        const inspect = vitest.fn((args: string[]) => Promise.resolve({ stdout: '' }));
        const runner = createDockerRunner(
            loadDriverConfig({}),
            child('done\n', '', 0),
            inspect as unknown as (args: string[]) => Promise<{ stdout: string }>,
        );
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        // The fence and the cleanup `rm` go through the same seam; only the inspect is the
        // classifier, and an unambiguous exit code must not pay for one.
        expect(inspect.mock.calls.filter((call) => call[0][0] === 'inspect')).toHaveLength(0);
    });

    it('spawns docker with the claim env in a file, and its own environment untouched', async () => {
        // The values reach the container through the --env-file, so the docker CLI's own
        // environment stays the operator's — a member-configured PATH or DOCKER_* can never steer
        // the CLI this driver executes.
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = createDockerRunner(
            loadDriverConfig({}),
            spawnFn as unknown as typeof spawn,
            noContainer,
        );
        const outcome = await runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0 });
        const [cmd, argv, options] = spawnFn.mock.calls[0]!;
        expect(cmd).toBe('docker');
        const args = argv as string[];
        const fileArg = args[args.indexOf('--env-file') + 1];
        expect(fileArg).toBeTruthy();
        // The file existed and carried the value while the CLI ran; it is gone once the run is.
        expect(existsSync(fileArg)).toBe(false);
        // The CLI's environment is inherited, never merged with claim values.
        expect(options && 'env' in options).toBe(false);
        expect(args.some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    /**
     * The live-output hook: every chunk that arrives is handed to the caller as the newest tail —
     * the same string a complete report would carry, growing. One call per chunk; throttling is
     * the loop's business.
     */
    it('hands every chunk it reads to the output stream', async () => {
        const tails: string[] = [];
        const runner = createDockerRunner(loadDriverConfig({}), child('step one\n', 'warn\n', 0), noContainer);

        const outcome = await runner.run(job, { id: SESSION, resume: false }, (tail) => tails.push(tail));

        expect(outcome.exitCode).toBe(0);
        expect(tails).toEqual(['step one\n', 'step one\nwarn\n']);
    });

    // The lease lost DURING the env-file write: the kill-check just above the write has already
    // passed, and the write's await breaks the synchronous gap the setup promises. Without one
    // more check, the runner spawns over a dead lease — its job-derived container name colliding
    // with the replacement's. On that abort the just-written file must go too: the cleanup around
    // the outcome only covers a settled run, and this throw precedes it.
    it('spawns nothing when the lease is lost during the env-file write, and leaves no file behind', async () => {
        try {
            let releaseWrite: (() => void) | null = null;
            const writeReleased = new Promise<void>((resolve) => {
                releaseWrite = resolve;
            });
            let markWrite: (() => void) | null = null;
            const writeUnderway = new Promise<void>((resolve) => {
                markWrite = resolve;
            });
            let writtenTo: string | null = null;
            fsHook.gate = async (path: string) => {
                fsHook.gate = null; // only this test's write is ever parked
                writtenTo = path;
                markWrite!();
                await writeReleased;
            };

            const spawnSpy = vitest.fn(() => fakeChild('', '', 0));
            const runner = createDockerRunner(loadDriverConfig({}), spawnSpy as unknown as typeof spawn, noContainer);

            const pending = runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });
            await writeUnderway; // the run is parked inside the env-file write

            await runner.kill(job); // the lease dies while the write is pending
            releaseWrite!(); // the write lands; the run now learns its lease is gone

            await expect(pending).rejects.toThrow(/killed while setting up services/);
            expect(spawnSpy).not.toHaveBeenCalled();
            // No leak: the file the write just created is removed on the abort path.
            expect(writtenTo).toBeTruthy();
            expect(existsSync(writtenTo!)).toBe(false);
        } finally {
            fsHook.gate = null;
        }
    });
});

/*
 * Auxiliary services (issue #6). The switch is on in this whole block, and the daemon is
 * scripted on argv shape: the readout run (it carries --entrypoint sh) answers with the checkouts'
 * `.bellows.yaml` files, the service runs (they carry --network-alias) answer created, the label
 * `ps` answers one container id, and everything else succeeds empty. The spawn stands in for the
 * runner container itself and records the argv it was given.
 */
describe('auxiliary services (RUNNER_SERVICES)', () => {
    const READOUT = '###__bellows:demo\nservices:\n  - name: stub\n    image: stub-svc:1\n';

    const daemon = (readout: string, opts: { readoutFails?: boolean; serviceFails?: boolean } = {}) =>
        vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                if (opts.readoutFails) throw new Error('daemon refused the readout');
                return { stdout: readout };
            }
            if (args[0] === 'run' && args.includes('--network-alias')) {
                if (opts.serviceFails) throw new Error('daemon refused the service');
                return { stdout: '' };
            }
            if (args[0] === 'ps') return { stdout: 'svc-id-1\n' };
            return { stdout: '' };
        });

    const spawnRecording = (stdout: string, code: number | null) => {
        const seen: string[][] = [];
        const fn = ((command: string, argv: string[]) => {
            seen.push(argv);
            const c = new EventEmitter() as ChildProcess;
            const stream = (text: string) => {
                const s = new EventEmitter();
                if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
                return s;
            };
            c.stdout = stream(stdout);
            c.stderr = stream('');
            process.nextTick(() => c.emit('close', code));
            return c;
        }) as unknown as typeof spawn;
        return { fn, seen };
    };

    const servicesRunner = (exec: ReturnType<typeof daemon>, fn: typeof spawn) =>
        createDockerRunner(loadDriverConfig({ RUNNER_SERVICES: '1' }), fn, exec as unknown as (args: string[]) => Promise<{ stdout: string }>);

    // A spawn stub whose children never emit on their own: each spawn hands the test a fire
    // function, so the interleaving — one attempt's error or close landing after another
    // attempt's fleet is already up — is the test's to pace.
    const gatedSpawns = () => {
        const fires: ((what: 'error' | 'close', payload?: unknown) => void)[] = [];
        let resolveSpawn: (() => void) | null = null;
        const spawned = new Promise<void>((resolve) => {
            resolveSpawn = resolve;
        });
        const fn = ((command: string, argv: string[]) => {
            const c = new EventEmitter() as ChildProcess;
            const stream = () => {
                const s = new EventEmitter();
                return s;
            };
            c.stdout = stream();
            c.stderr = stream();
            fires.push((what, payload) => process.nextTick(() => c.emit(what, payload)));
            resolveSpawn!();
            return c;
        }) as unknown as typeof spawn;
        const childAt = async (index: number): Promise<(what: 'error' | 'close', payload?: unknown) => void> => {
            while (fires.length <= index) await spawned;
            return fires[index]!;
        };
        return { fn, fires, childAt };
    };

    it('reads .bellows.yaml, creates the job network, starts the service, and joins the runner to it', async () => {
        const exec = daemon(READOUT);
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        const readAt = calls.findIndex((a) => a[0] === 'run' && a.includes('--entrypoint'));
        const createAt = calls.findIndex((a) => a[0] === 'network' && a[1] === 'create');
        const serviceAt = calls.findIndex((a) => a[0] === 'run' && a.includes('--network-alias'));
        // Read before create, create before the service — the fence's rounds sit between, which
        // is why these are comparisons and not exact positions.
        expect(readAt).toBeGreaterThanOrEqual(0);
        expect(createAt).toBeGreaterThan(readAt);
        expect(serviceAt).toBeGreaterThan(createAt);
        expect(calls[serviceAt]).toEqual(serviceRunArgs(job, { name: 'stub', image: 'stub-svc:1', environment: [] }));
        // The runner shares the network — that is the whole feature: inside the job, `stub`
        // resolves to the service container.
        expect(seen[0]).toEqual(dockerArgs(loadDriverConfig({ RUNNER_SERVICES: '1' }), job, { id: SESSION, resume: false }, networkName(job)));
    });

    it('starts nothing and changes no argv when the flag is on but no file declares services', async () => {
        // The path every existing repo takes the moment an operator turns the flag on: empty
        // readout, no network, byte-identical runner argv — the compatibility promise, exercised
        // end to end rather than only at the dockerArgs parameter.
        const exec = daemon('');
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        expect(seen[0]).toEqual(dockerArgs(loadDriverConfig({ RUNNER_SERVICES: '1' }), job, { id: SESSION, resume: false }));
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).not.toContainEqual(['network', 'create', networkName(job)]);
        expect(calls.every((a) => !a.includes('--network-alias'))).toBe(true);
    });

    it('fails the job with the readout’s oversize refusal, rather than throwing it at the lease', async () => {
        // The size bound exists because unbounded author content would otherwise die inside
        // execFile's maxBuffer and classify as infrastructure. The marker path must therefore
        // land on the terminal-refusal side of the taxonomy: failed with the reason, zero spawns.
        const exec = daemon('###__bellows:demo\n###__bellows_error:/workspaces/b/x/demo/.bellows.yaml is larger than 65536 bytes\n');
        const { fn, seen } = spawnRecording('', 0);
        const outcome = await servicesRunner(exec, fn).run(job, { id: SESSION, resume: false });

        expect(outcome.started).toBe(true);
        expect(outcome.exitCode).toBeNull();
        expect(outcome.output).toContain('.bellows.yaml');
        expect(outcome.output).toContain('larger than 65536 bytes');
        expect(seen).toHaveLength(0);
        expect(exec.mock.calls.map((call) => call[0])).not.toContainEqual(['network', 'create', networkName(job)]);
    });

    it('tears the services and the network down after the run, whatever the verdict', async () => {
        const exec = daemon(READOUT);
        await servicesRunner(exec, spawnRecording('', 1).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(calls[calls.length - 1]).toEqual(['network', 'rm', networkName(job)]);
    });

    it('fences leftover services before anything is created', async () => {
        const exec = daemon(READOUT);
        await servicesRunner(exec, spawnRecording('', 0).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        const firstPsAt = calls.findIndex((a) => a[0] === 'ps');
        const createAt = calls.findIndex((a) => a[0] === 'network' && a[1] === 'create');
        // A dead previous attempt leaves its fleet behind — the same leftover the runner
        // container's rm catches, one layer out, and for the same reason.
        expect(firstPsAt).toBeGreaterThanOrEqual(0);
        expect(firstPsAt).toBeLessThan(createAt);
        expect(
            calls.slice(0, createAt).some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'svc-id-1'),
        ).toBe(true);
    });

    it('fails the job with the parse reason, and starts nothing, when a file is malformed', async () => {
        // `ports:` is exactly the key the parser refuses — a host publish can never be parsed
        // into existence by writing YAML.
        const exec = daemon('###__bellows:demo\nservices:\n  - name: db\n    ports: ["5432:5432"]\n');
        const { fn, seen } = spawnRecording('', 0);
        const outcome = await servicesRunner(exec, fn).run(job, { id: SESSION, resume: false });

        // A deterministic author error: terminal failed with the reason in the output, not a
        // retry — burning attempts on a file that cannot change would be the verdict that lies.
        expect(outcome.started).toBe(true);
        expect(outcome.exitCode).toBeNull();
        expect(outcome.output).toContain('.bellows.yaml');
        expect(outcome.output).toContain('ports');
        expect(seen).toHaveLength(0);
        expect(exec.mock.calls.map((call) => call[0])).not.toContainEqual(['network', 'create', networkName(job)]);
    });

    it('sends a refused readout to the lease instead of blaming the command', async () => {
        const exec = daemon('', { readoutFails: true });
        const { fn, seen } = spawnRecording('', 0);
        await expect(servicesRunner(exec, fn).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not read \.bellows\.yaml/,
        );
        expect(seen).toHaveLength(0);
    });

    it('sends a refused service to the lease, after tearing down what did start', async () => {
        const exec = daemon(READOUT, { serviceFails: true });
        const { fn, seen } = spawnRecording('', 0);
        await expect(servicesRunner(exec, fn).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not start service "stub"/,
        );
        expect(seen).toHaveLength(0);
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(calls).toContainEqual(['network', 'rm', networkName(job)]);
    });

    it('kill() takes the services and the network down with the runner', async () => {
        const exec = daemon(READOUT);
        await servicesRunner(exec, spawnRecording('', 0).fn).kill(job);
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['kill', containerName(job)]);
        expect(calls).toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(calls).toContainEqual(['network', 'rm', networkName(job)]);
    });

    // A lost lease fires kill() while the setup may still be awaiting the daemon. Throwing is the
    // loop's contract for it — the outcome of a lost lease is discarded, and the next attempt's
    // fence removes whatever was already created — so the abort's only job is to stop THIS
    // attempt from creating more resources and from spawning the runner over a lease that is gone.
    it('aborts the setup, creating nothing more and spawning nothing, when the job is killed mid-setup', async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                // The lease is lost while the readout is in flight; kill() is what the loop
                // calls, and it must be recorded before the read resolves.
                await handle.kill!(job);
                return { stdout: READOUT };
            }
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: 'svc-id-1\n' };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /killed while setting up services/,
        );
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).not.toContainEqual(['network', 'create', networkName(job)]);
        expect(calls.every((a) => !a.includes('--network-alias'))).toBe(true);
        expect(seen).toHaveLength(0);
    });

    // The two-attempt race: A loses its lease mid-setup and B claims the same job id before A
    // aborts — the loop dedups by nothing. A kill names ATTEMPT A; B carries a fresh lease
    // token that was never killed, so B must proceed, and A must stay aborted. Keyed by job
    // id, one marker serves both attempts: B's claim would either be aborted by a kill meant
    // for A, or wipe the marker and revive A to compete for the same network and containers.
    it('aborts only the killed attempt when a sibling attempt of the same id claims the job', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, id: job.id, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        let killedA = false;
        let releaseA: (() => void) | null = null;
        const killRecorded = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                if (!killedA) {
                    // A's lease is lost while its readout is in flight; the loop's kill()
                    // must be on record before the read resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseA!();
                }
                return { stdout: READOUT };
            }
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: 'svc-id-1\n' };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await killRecorded;
        // B's claim lands while A is still between awaited steps — nothing stops it.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });

        // A was the attempt the loop killed: it aborts.
        await expect(runA).rejects.toThrow(/killed while setting up services/);
        // B was never killed, whatever happened to A: network, service, spawn all happen.
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
        // Exactly one attempt got as far as creating the network and spawning the runner.
        const creates = exec.mock.calls.map((call) => call[0]).filter((a) => a[0] === 'network' && a[1] === 'create');
        expect(creates).toEqual([['network', 'create', networkName(job)]]);
        expect(seen).toHaveLength(1);
    });

    // The abort must be teardown-FREE, not merely stopped. kill() ran the job-scoped teardown
    // when the lease was lost; whatever THIS attempt created after that point is a leftover only
    // the NEXT attempt's fence may remove — the fence runs BEFORE the newer attempt creates
    // anything, so it is the one component that can tell a dead attempt's leftovers from a live
    // fleet. A teardown fired from the dying attempt has no such timing guarantee: overlapping a
    // newer attempt's setup, it would delete the network and service containers the newer
    // attempt is already using.
    it('aborts without issuing any removals, so a sibling attempt\'s fleet survives', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        let killedA = false;
        let releaseKill: (() => void) | null = null;
        const killSettled = new Promise<void>((resolve) => {
            releaseKill = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                if (!killedA) {
                    // A's lease is lost while its readout is in flight; kill() — its own
                    // teardown included — must be fully settled before the read resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseKill!();
                }
                return { stdout: READOUT };
            }
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: 'svc-id-1\n' };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await killSettled;
        // Everything A does from here to its rejection IS the abort path, and the pin is that
        // it contains no removals at all.
        const killEnd = exec.mock.calls.length;
        await expect(runA).rejects.toThrow(/killed while setting up services/);
        const abortCalls = exec.mock.calls.slice(killEnd).map((call) => call[0]);
        expect(abortCalls).not.toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(abortCalls).not.toContainEqual(['network', 'rm', networkName(job)]);

        // B, the newer attempt for the same job id: fence, network create, service start and
        // runner spawn all happen after A's abort — and nothing A did on the way out disturbed
        // them.
        const outcome = await runner.run(attemptB, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['network', 'create', networkName(job)]);
        expect(calls.some((a) => a.includes('--network-alias'))).toBe(true);
        expect(seen).toHaveLength(1);
    });

    // A's close that lands LATE: A was killed — kill() tore the fleet down while it was still
    // legitimately A's own — and the loop re-claimed the job as B before A's CLI client finally
    // exited. A's close handler must not run the job-scoped teardown a second time: everything
    // that teardown would find under the job label now belongs to B, and removing it strands
    // B's runner mid-run.
    it('skips the service teardown on a killed attempt whose close lands after the replacement stood its fleet up', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        // Both children hold their close until released, so the interleaving — A still alive
        // while B stands its fleet up, then A's close landing over it — is the test's to pace.
        const closers: (() => void)[] = [];
        let resolveSpawn: (() => void) | null = null;
        const spawned = new Promise<void>((resolve) => {
            resolveSpawn = resolve;
        });
        const gatedSpawn = ((command: string, argv: string[]) => {
            const c = new EventEmitter() as ChildProcess;
            const stream = () => {
                const s = new EventEmitter();
                return s;
            };
            c.stdout = stream();
            c.stderr = stream();
            closers.push(() => process.nextTick(() => c.emit('close', 137)));
            resolveSpawn!();
            return c;
        }) as unknown as typeof spawn;
        const closeOf = async (index: number): Promise<() => void> => {
            while (closers.length <= index) await spawned;
            return closers[index]!;
        };

        const exec = daemon(READOUT);
        const runner = servicesRunner(exec, gatedSpawn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        const closeA = await closeOf(0); // A spawned; its CLI client is alive
        // The loop loses A's lease and kills the attempt: token recorded, A's own fleet torn
        // down while it is still legitimately A's.
        await runner.kill(attemptA);
        // B re-claims the same job id and stands a fresh fleet up.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await closeOf(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        // A's CLI client only now exits — daemon slowness makes the close arbitrarily late —
        // and its verdict lands over B's live fleet.
        closeA();
        await runA;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).not.toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            'label=factory.service',
        ]);
        expect(late).not.toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(late).not.toContainEqual(['network', 'rm', networkName(job)]);

        // B is untouched and still finishes under its own verdict.
        closers[1]!();
        await expect(runB).resolves.toMatchObject({ exitCode: 137, started: true });
    });

    // The natural-close twin of the test above, with NO kill anywhere: the lease expires
    // server-side and the board re-claims the job as B before any heartbeat delivers 'lost' —
    // so the loop never kills A, and A's `killed` marker is never recorded. B's fence removes
    // A's runner by name, which closes A's CLI client, and A's verdict then lands over B's live
    // fleet. Not-killed is not the same as still-current: only the newest attempt for the job id
    // may tear the shared-name fleet down.
    it('skips the service teardown on a natural close that lands after a replacement claim stood its fleet up', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        const closers: (() => void)[] = [];
        let resolveSpawn: (() => void) | null = null;
        const spawned = new Promise<void>((resolve) => {
            resolveSpawn = resolve;
        });
        const gatedSpawn = ((command: string, argv: string[]) => {
            const c = new EventEmitter() as ChildProcess;
            const stream = () => {
                const s = new EventEmitter();
                return s;
            };
            c.stdout = stream();
            c.stderr = stream();
            closers.push(() => process.nextTick(() => c.emit('close', 0)));
            resolveSpawn!();
            return c;
        }) as unknown as typeof spawn;
        const closeOf = async (index: number): Promise<() => void> => {
            while (closers.length <= index) await spawned;
            return closers[index]!;
        };

        const exec = daemon(READOUT);
        const runner = servicesRunner(exec, gatedSpawn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        const closeA = await closeOf(0); // A spawned; its CLI client is alive — and never killed
        // B re-claims the same job id with no kill in between: the heartbeat has not yet told
        // the loop A's lease is gone. B's fence removes A's runner by name; A's fleet follows
        // through B's own entry fence.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await closeOf(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        // A's CLI client only now closes naturally — its container was fenced away by B.
        closeA();
        await runA;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).not.toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            'label=factory.service',
        ]);
        expect(late).not.toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(late).not.toContainEqual(['network', 'rm', networkName(job)]);

        // B is untouched and still finishes under its own verdict.
        closers[1]!();
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The late-kill twin of the two close tests above: the kill itself arrives AFTER the
    // replacement claimed the job and stood its fleet up — the heartbeat can be arbitrarily
    // slow to deliver the lease loss, and the claim loop has no per-job dedupe. By then the
    // job-derived container name and the service label already refer to B's runner and fleet,
    // so a kill by that name or a job-scoped teardown would destroy the live attempt out from
    // under its runner; B's fence has already run and cannot reclaim them back.
    it('skips the daemon actions on a kill that lands after the replacement stood its fleet up', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        const { fn, fires, childAt } = gatedSpawns();
        const exec = daemon(READOUT);
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its CLI client is alive
        // B re-claims the same job id and stands a fresh fleet up BEFORE the loop learns of
        // A's lost lease.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        // Only now does the loop's kill for A fire — over names B already owns.
        await runner.kill(attemptA);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).not.toContainEqual(['kill', containerName(job)]);
        expect(late).not.toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            'label=factory.service',
        ]);
        expect(late).not.toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(late).not.toContainEqual(['network', 'rm', networkName(job)]);

        // A still winds down by its own killed marker, and B is untouched, finishing under
        // its own verdict.
        fires[0]!('close', 137);
        await runA;
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // Ordering, not just outcome: the rejection must not be observable while the teardown is
    // still in flight, or the caller sees shutdown and the next lifecycle step race the
    // removals. The LAST teardown step is held in flight on a gate the test controls — armed
    // only after the readout, so the fence's own network rm passes — and a rejection observable
    // while the gate is closed is one that did not wait for cleanup.
    it('tears the services down before a spawn error rejects', async () => {
        let releaseNetworkRm: (() => void) | null = null;
        const networkRmGate = new Promise<void>((resolve) => {
            releaseNetworkRm = resolve;
        });
        let armed = false;
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                armed = true;
                return { stdout: READOUT };
            }
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: 'svc-id-1\n' };
            if (args[0] === 'network' && args[1] === 'rm' && armed) await networkRmGate;
            return { stdout: '' };
        });
        // A child that never closes: the CLI could not even be spawned, which is the 'error'
        // event and nothing else.
        const erroring = (() => {
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => c.emit('error', new Error('spawn docker ENOENT')));
            return c;
        }) as unknown as typeof spawn;
        const pending = servicesRunner(exec, erroring).run(job, { id: SESSION, resume: false });
        let rejected = false;
        pending.catch(() => {
            rejected = true;
        });
        // A macrotask, so every microtask — the rejection among them — gets its turn while the
        // gate is still closed.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(rejected).toBe(false);

        releaseNetworkRm!();
        await expect(pending).rejects.toThrow(/ENOENT/);
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(calls).toContainEqual(['network', 'rm', networkName(job)]);
    });

    // A spawn failure makes Node deliver 'error' and then 'close' with a null code. The close
    // must not settle the promise once the error has been seen: verdict(null) would read as a
    // started run with no exit code — a terminal failed job — when the truth is infrastructure
    // the loop should leave to its lease. The daemon holds the error-path teardown's ps on a
    // gate, so under the bug the close handler's verdict wins the race and RESOLVES the run.
    it('rejects with the spawn error even when close follows it while teardown is pending', async () => {
        let releaseTeardownPs: (() => void) | null = null;
        const teardownPsGate = new Promise<void>((resolve) => {
            releaseTeardownPs = resolve;
        });
        let psCount = 0;
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') {
                psCount++;
                // ps #1 is the entry fence; ps #2 is the error-path teardown, held so the
                // close handler gets its turn while the teardown is still in flight.
                if (psCount === 2) await teardownPsGate;
                return { stdout: 'svc-id-1\n' };
            }
            return { stdout: '' };
        });
        // Node's failed-spawn order: 'error' first, then 'close' with code null.
        const errorThenClose = (() => {
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => {
                c.emit('error', new Error('spawn docker ENOENT'));
                c.emit('close', null);
            });
            return c;
        }) as unknown as typeof spawn;
        const pending = servicesRunner(exec, errorThenClose).run(job, { id: SESSION, resume: false });
        // A macrotask, so the error, the close and the close handler's verdict all get their
        // turn while the gate is still closed.
        await new Promise((resolve) => setTimeout(resolve, 20));
        releaseTeardownPs!();
        await expect(pending).rejects.toThrow(/ENOENT/);
    });

    // The spawn-error twin: A's runner spawn fails, but the failure is delivered only after B
    // claimed the same job id and stood its fleet up. The error path tears the attempt's
    // services down before rejecting — but the label ps and the network rm run at teardown
    // time, when they would find and delete B's live fleet. Superseded, the path must reject
    // without touching the daemon: whatever A left behind is B's fence's business.
    it('rejects a superseded spawn error without tearing the replacement fleet down', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        const { fn, fires, childAt } = gatedSpawns();
        const exec = daemon(READOUT);
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A is as far as its spawn, whose failure stays undelivered for now
        // B re-claims the same job id and stands a fresh fleet up while A's spawn failure is
        // still in flight.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        fires[0]!('error', new Error('spawn docker ENOENT'));
        // The rejection still surfaces — but nothing may be removed behind it.
        await expect(runA).rejects.toThrow(/ENOENT/);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).not.toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            'label=factory.service',
        ]);
        expect(late).not.toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(late).not.toContainEqual(['network', 'rm', networkName(job)]);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The twin the entry-time snapshot cannot see: the spawn error lands while A is STILL
    // current — the gate passes and the teardown starts — and B claims the job id only while
    // that teardown sits mid-flight, between its label ps and its removals. A check made once
    // at entry cannot catch B: the ps has already listed what to remove and the network rm is
    // still to come, so by execution time they delete B's live fleet. Daemon calls are
    // arbitrarily slow, so ownership must hold at the EXECUTION time of each daemon step — the
    // gate the teardown carries must be re-armed between its awaited steps.
    it('aborts a spawn-error teardown that a replacement supersedes mid-flight', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        const { fn, fires, childAt } = gatedSpawns();
        let releaseTeardownPs: (() => void) | null = null;
        const teardownPsGate = new Promise<void>((resolve) => {
            releaseTeardownPs = resolve;
        });
        let markTeardownPs: (() => void) | null = null;
        const teardownPsParked = new Promise<void>((resolve) => {
            markTeardownPs = resolve;
        });
        let psCount = 0;
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') {
                psCount++;
                // ps #1 is A's entry fence; ps #2 is the error-path teardown, parked so B can
                // stand its fleet up while the teardown sits between its ps and its removals;
                // ps #3 is B's entry fence.
                if (psCount === 2) {
                    markTeardownPs!();
                    await teardownPsGate;
                }
                return { stdout: 'svc-id-1\n' };
            }
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its CLI client is alive
        fires[0]!('error', new Error('spawn docker ENOENT')); // A is still current: its teardown starts
        await teardownPsParked; // the teardown is parked between its ps and its removals

        // B re-claims the same job id and stands a fresh fleet up while A's teardown is in flight.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        releaseTeardownPs!(); // the teardown resumes — over names B now owns
        await expect(runA).rejects.toThrow(/ENOENT/); // the rejection still surfaces

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).not.toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(late).not.toContainEqual(['network', 'rm', networkName(job)]);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The kill() twin of the spawn-error test above: kill()'s entry gate is a snapshot, and
    // the `docker kill` daemon call between it and the teardown is arbitrarily slow. A
    // replacement claim landing inside that window supersedes this attempt — records itself
    // as current, fences and stands its fleet up — so by the time the kill's teardown runs,
    // the job-derived label and network name refer to the REPLACEMENT's fleet. Ownership
    // must therefore be live at the teardown's execution time, and a superseded kill aborts
    // at its first owns() boundary instead of removing anything.
    it('aborts a kill teardown that a replacement supersedes while the docker kill is mid-flight', async () => {
        const attemptA = { ...job, leaseToken: 'aaaaaaa2-2222-4222-8222-222222222222' };
        const attemptB = { ...job, leaseToken: 'bbbbbbb3-3333-4333-8333-333333333333' };
        const { fn, fires, childAt } = gatedSpawns();
        let releaseKill: (() => void) | null = null;
        const killGate = new Promise<void>((resolve) => {
            releaseKill = resolve;
        });
        let markKillParked: (() => void) | null = null;
        const killParked = new Promise<void>((resolve) => {
            markKillParked = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'kill') {
                // kill()'s `docker kill` is held mid-flight — the arbitrarily slow daemon
                // call between the entry gate and the teardown, inside which B claims.
                markKillParked!();
                await killGate;
                return { stdout: '' };
            }
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: 'svc-id-1\n' };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its runner and fleet stand
        const pending = runner.kill(attemptA); // the entry gate passes: A is still current
        await killParked; // the kill is parked inside its docker kill daemon call

        // B re-claims the same job id with a fresh token and stands a fresh fleet up while
        // A's kill is still awaiting the daemon.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        releaseKill!(); // the kill resumes — straight into its teardown, over names B owns
        await pending;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        // The teardown was entered — its label ps ran — and then aborted at its first
        // owns() boundary, before any removal.
        expect(late).toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            'label=factory.service',
        ]);
        expect(late).not.toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(late).not.toContainEqual(['network', 'rm', networkName(job)]);

        // A still winds down by its own killed marker, and B is untouched, finishing under
        // its own verdict.
        fires[0]!('close', 137);
        await runA;
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    it('leaves the daemon alone when the switch is off', async () => {
        const exec = daemon(READOUT);
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await createDockerRunner(
            loadDriverConfig({}),
            fn,
            exec as unknown as (args: string[]) => Promise<{ stdout: string }>,
        ).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls.every((a) => a[0] !== 'ps' && a[0] !== 'network')).toBe(true);
        expect(seen[0]).toEqual(dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }));
    });
});
