import { describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { claimEnv, containerName, createDockerRunner, dockerArgs, envFileBody, gateEnvArgs, gateEnvContainerName, gateExecArgs, opencodeSessionReadoutArgs, parseOpencodeSessionId, parseRemoteSessionId, remoteSessionArgs, reportTail, tailBytes } from '../src/docker.js';

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

const args = (env: NodeJS.ProcessEnv = {}, session: RunSession | null = { id: SESSION, resume: false }) =>
    dockerArgs(loadDriverConfig(env), job, session);

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
        const line = dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false }, '/tmp/env-file');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
        expect(line).not.toContain('MY_TOKEN');
        expect(line.some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    it('gives the claim precedence over the driver’s own forwarded names', () => {
        // docker gives `-e` precedence over `--env-file`, so a name the claim also carries must
        // not go out as `-e` — otherwise the driver's own value would silently win.
        const configured = loadDriverConfig({ RUNNER_ENV: 'MY_TOKEN,OTHER' });
        const line = dockerArgs(configured, envJob, { id: SESSION, resume: false }, '/tmp/env-file');
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
        const line = dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false }, '/tmp/env-file');
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
        }, '/tmp/env-file');
        expect(line).not.toContain('--env-file');
        expect(line).not.toContain('MY_TOKEN');
        expect(line.some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    it('writes no env file for a claim without env', () => {
        expect(envFileBody(job)).toBe('');
        const line = dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, '/tmp/env-file');
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

/**
 * The gate environment container: one long-lived `docker run -d` per member+repo, a `docker exec`
 * per gate. Pure and pinned for the same reason dockerArgs is — everything security-relevant about
 * the environment runner is decided in these arrays, and the values they interpolate arrive from
 * the board and from a file in a member's checkout.
 */
describe('the gate environment container', () => {
    const KEY = `bellows/${USER}/factory`;
    const config = loadDriverConfig({});

    it('names the container after the checkout key, exec-able and orphan-findable', () => {
        expect(gateEnvContainerName(KEY)).toBe(`factory-env-bellows-${USER}-factory`);
        expect(gateEnvArgs(config, KEY, 'node:24')).toEqual(
            expect.arrayContaining([
                '-d',
                '--name',
                `factory-env-bellows-${USER}-factory`,
                '--label',
                `factory.gates=${KEY}`,
            ]),
        );
    });

    it('mounts the checkouts volume and works inside the checkout, like the coding agent does', () => {
        expect(gateEnvArgs(config, KEY, 'node:24')).toEqual(
            expect.arrayContaining([
                '-v',
                'factory-ai_workspaces:/workspaces',
                '-w',
                `/workspaces/${KEY}`,
            ]),
        );
    });

    // sleep infinity: the container's only job is to BE an environment. Gates enter it by exec,
    // which is what keeps npm install's state alive across gates and turns.
    it('runs the declared image as a detached sleeper', () => {
        const line = gateEnvArgs(config, KEY, 'node:24');
        expect(line.slice(-4)).toEqual(['--entrypoint', 'sleep', 'node:24', 'infinity']);
        expect(line[line.length - 1]).toBe('infinity');
    });

    it('joins a network only when one is configured, and takes an env file only when given one', () => {
        expect(gateEnvArgs(config, KEY, 'node:24')).not.toContain('--network');
        expect(gateEnvArgs(config, KEY, 'node:24')).not.toContain('--env-file');
        expect(gateEnvArgs(loadDriverConfig({ RUNNER_NETWORK: 'factory-ai_default' }), KEY, 'node:24')).toEqual(
            expect.arrayContaining(['--network', 'factory-ai_default']),
        );
        expect(gateEnvArgs(config, KEY, 'node:24', '/tmp/gate.env')).toEqual(
            expect.arrayContaining(['--env-file', '/tmp/gate.env']),
        );
    });

    it('never puts a value on the command line — the env file is the only carrier', () => {
        const line = gateEnvArgs(config, KEY, 'node:24', '/tmp/gate.env');
        expect(line.filter((arg) => arg === '-e')).toHaveLength(0);
    });

    it('refuses an image that smuggles a flag, whitespace or expansion', () => {
        for (const image of ['-v /:/host', 'node:24 alpine', 'node:$TAG', '']) {
            expect(() => gateEnvArgs(config, KEY, image), image).toThrow(/image/);
        }
    });

    // The key is interpolated into argv (-w) and into a container NAME. It arrives from the
    // board's claim plus a repo label — asserted, not trusted, the WORKSPACE_PATH posture.
    it('refuses a checkout key that is not <org>/<uuid>/<repo>', () => {
        for (const key of [
            '../../etc',
            `bellows/${USER}`,
            `bellows/not-a-uuid/factory`,
            `bellows/${USER}/../..`,
            `bellows/${USER}/-rf`,
            '',
        ]) {
            expect(() => gateEnvArgs(config, key, 'node:24'), key).toThrow();
        }
    });

    it('execs gates as sh -c inside the named container, and refuses a strange container name', () => {
        const name = gateEnvContainerName(KEY);
        expect(gateExecArgs(name, 'npm test')).toEqual(['exec', name, 'sh', '-c', 'npm test']);
        expect(() => gateExecArgs('bad name; rm -rf', 'x')).toThrow();
    });

    // The name validator and the name generator must agree: a long org + long repo produces the
    // longest key the pattern allows (org 39 + uuid 36 + repo 100), and every gate of that
    // checkout must still be exec-able.
    it('accepts the longest container name the checkout-key pattern can produce', () => {
        const key = `${'a'.repeat(39)}/${USER}/${'r'.repeat(100)}`;
        const name = gateEnvContainerName(key);
        expect(() => gateExecArgs(name, 'npm test')).not.toThrow();
        expect(gateEnvArgs(config, key, 'node:24')).toEqual(expect.arrayContaining(['--name', name]));
    });
});

/**
 * The runner-side plumbing for gated jobs: the env file carries the ad-hoc gate credentials AFTER
 * the claim's own lines, and the runner can resolve the default gate URL on a Linux daemon.
 */
describe('the runner env for a gated job', () => {
    const gated: BoardJob = {
        ...job,
        repo: 'Bellows-AI/factory',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
        env: { CLAIM_TOKEN: 'board-secret' },
        gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' },
    };

    it('carries the gate credentials after the claim env, so the claim cannot spoof them', () => {
        // docker's --env-file is last-duplicate-wins: the gate lines are appended after the
        // claim's, so a member-configured BELLOWS_GATE_TOKEN in any scope loses to the driver's.
        const body = envFileBody(gated).split('\n').filter(Boolean);
        expect(body).toEqual([
            'CLAIM_TOKEN=board-secret',
            'BELLOWS_GATE_URL=http://host.docker.internal:9099',
            'BELLOWS_GATE_TOKEN=tok',
        ]);
    });

    it('adds the host gateway mapping so the default gate URL resolves on Linux daemons', () => {
        expect(
            dockerArgs(loadDriverConfig({}), gated, { id: SESSION, resume: false }, '/tmp/env-file'),
        ).toEqual(expect.arrayContaining(['--add-host', 'host.docker.internal:host-gateway']));
        // ... and only for a gated job: an ungated runner's argv must stay byte-identical.
        expect(dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false })).not.toContain(
            'host.docker.internal:host-gateway',
        );
    });

    it('never puts a gate value on the command line', () => {
        const line = dockerArgs(loadDriverConfig({}), gated, { id: SESSION, resume: false }, '/tmp/env-file');
        expect(line.some((arg) => arg.includes('tok'))).toBe(false);
        expect(line.some((arg) => arg.includes('host.docker.internal:9099'))).toBe(false);
    });

    // Regression pin for the feature boundary: a claim without gates builds exactly the argv it
    // always did.
    it('builds byte-identical argv for a job without gates', () => {
        expect(dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false })).toEqual(
            dockerArgs(loadDriverConfig({}), { ...job, gates: undefined }, { id: SESSION, resume: false }),
        );
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
});
