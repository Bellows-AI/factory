import { describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import type { ChildProcess, spawn } from 'node:child_process';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { CACHE_WATCH_TURNS, cacheCollapse, claimEnv, containerName, createDockerRunner, currentActivity, dockerArgs, envFileBody, gateEnvArgs, gateEnvContainerName, gateExecArgs, opencodeCacheProbeArgs, opencodeSessionReadoutArgs, parseDockerStats, parseOpencodeCacheProbe, parseOpencodeRunOutcome, parseRemoteSessionId, remoteSessionArgs, reportTail, stripAnsi, tailBytes } from '../src/docker.js';
import { networkName, serviceContainerName, serviceRunArgs } from '../src/services.js';
import { CREDENTIAL_HELPER, gitProbeScript, gitWorktreeRemoveScript, gitWorktreeScript, isBranchName, parseGitState, publishPlan, repoPath, worktreeBranch, worktreeDir, worktreeRelDir } from '../src/publish.js';

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
        // The job label is what the fence sweeps and what finds an orphan after the driver dies;
        // the lease label is what makes every per-attempt operation resolve to THIS attempt's
        // containers only — the job label alone is shared by every attempt of the job, the lease
        // label never repeats.
        expect(args()).toEqual(
            expect.arrayContaining([
                '--name',
                containerName(job),
                '--label',
                `factory.job=${job.id}`,
                '--label',
                `factory.lease=${job.leaseToken}`,
            ]),
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

    // The endpoint is always provided, defaulting to the compose collector when
    // RUNNER_OTEL_ENDPOINT is not set — the guarantee that a runner's telemetry reaches the
    // collector whether or not an operator named one. RUNNER_OTEL_ENDPOINT overrides it for a
    // collector the compose network cannot name.
    it('always points the runner at a collector, overriding it when configured', () => {
        expect(args()).toEqual(
            expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']),
        );
        expect(args({ RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' })).toEqual(
            expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://telemetry.internal:4318']),
        );
    });

    it('skips permissions only when told to', () => {
        expect(args()).not.toContain('--dangerously-skip-permissions');
        expect(args({ RUNNER_SKIP_PERMISSIONS: '1' })).toContain('--dangerously-skip-permissions');
    });

    // The branch reporter posts to the board's API, and the endpoint rides beside the OTEL one:
    // a URL, not a credential, defaulted from JOB_BOARD_URL and forwarded under Remote Control
    // too — attribution is as wanted on a drivable session as on a headless one.
    it('points the runner at the board so it can report its branch', () => {
        expect(args()).toEqual(expect.arrayContaining(['-e', 'FACTORY_STATS_URL=http://127.0.0.1:8080']));
        expect(args({ RUNNER_STATS_URL: 'http://stats.internal:8080' })).toEqual(
            expect.arrayContaining(['-e', 'FACTORY_STATS_URL=http://stats.internal:8080']),
        );
        expect(args({ RUNNER_REMOTE_CONTROL: '1' })).toEqual(
            expect.arrayContaining(['-e', 'FACTORY_STATS_URL=http://127.0.0.1:8080']),
        );
    });

    // The claude runner is told the session id before the container starts (the driver mints it),
    // so the reporter never has to scrape a transcript. A resumed session keeps its id — the
    // parked job's spans must join to the same conversation.
    it('tells the claude runner which session to report', () => {
        expect(args()).toEqual(expect.arrayContaining(['-e', `BELLOWS_SESSION_ID=${SESSION}`]));
        expect(resumed()).toEqual(expect.arrayContaining(['-e', `BELLOWS_SESSION_ID=${SESSION}`]));
    });

    it('gives the opencode runner a session id only when one exists', () => {
        const open = (env: NodeJS.ProcessEnv = {}, session: RunSession | null = null) =>
            dockerArgs(loadDriverConfig({ RUNNER_CLI: 'opencode', ...env }), job, session);
        // A fresh opencode run has no id yet — the reporter discovers it from the session
        // database. An unvalidated id must never be interpolated.
        expect(open().some((arg) => arg.includes('BELLOWS_SESSION_ID'))).toBe(false);
        const followUp = dockerArgs(
            loadDriverConfig({ RUNNER_CLI: 'opencode' }),
            { ...job, followUp: true },
            { id: SESSION, resume: true },
        );
        expect(followUp).toEqual(expect.arrayContaining(['-e', `BELLOWS_SESSION_ID=${SESSION}`]));
        // BEFORE the image name: docker stops option parsing there, and an `-e` past it is the
        // CLI's argv — `opencode run` has no `-e` flag, and the reporter would never see the id.
        expect(followUp.indexOf(`BELLOWS_SESSION_ID=${SESSION}`)).toBeLessThan(
            followUp.indexOf('opencode-executor'),
        );
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

    // The token is a credential: it rides the 0600 env file, as the LAST line (docker's
    // --env-file is last-duplicate-wins, so the order is the precedence rule), and it never
    // appears on an argv any `ps` on the host can read. Without it the file's body is
    // byte-identical to what it always was.
    it('carries the ingest token in the env file, last, and never on the argv', () => {
        const config = loadDriverConfig({ RUNNER_INGEST_TOKEN: ' tok ' });
        expect(envFileBody(envJob, config)).toBe('MY_TOKEN=board-secret\nINGEST_TOKEN=tok\n');
        expect(envFileBody(envJob, loadDriverConfig({}))).toBe('MY_TOKEN=board-secret\n');
        const line = dockerArgs(config, envJob, { id: SESSION, resume: false }, null, '/tmp/env-file');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
        expect(line.some((arg) => arg.includes('INGEST_TOKEN'))).toBe(false);
    });

    // A token with no claim env and no gates still needs the file — without it the runner is
    // silently unauthenticated, and on an ingest-token board every report 401s into silence.
    it('needs the env file when only the ingest token would ride it', () => {
        const config = loadDriverConfig({ RUNNER_INGEST_TOKEN: 'tok' });
        expect(() => dockerArgs(config, job, { id: SESSION, resume: false })).toThrow(/no env file/);
        const line = dockerArgs(config, job, { id: SESSION, resume: false }, null, '/tmp/env-file');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    // The reporter's env names are the runner's own contract, like WORKDIR: a member value in
    // one of them steers where the report goes, what authenticates it, and which session it
    // claims — a cross-tenant write into the telemetry store.
    it('refuses the reporter env names from a claim', () => {
        expect(
            claimEnv({
                ...job,
                env: { FACTORY_STATS_URL: 'http://evil', INGEST_TOKEN: 'spoof', BELLOWS_SESSION_ID: 'spoof' },
            }),
        ).toEqual({});
    });

    it('writes one NAME=value line per variable, reserved names dropped', () => {
        expect(envFileBody(envJob)).toBe('MY_TOKEN=board-secret\n');
        expect(envFileBody(job)).toBe('');
        // A value with a newline would corrupt the file's line structure — refused, not mangled.
        expect(() =>
            envFileBody({ ...job, env: { BROKEN: 'line1\nline2' } }),
        ).toThrow(/newline/);
    });

    // The refusal must name WHICH half carries the newline: blaming the name for the value's
    // offence sends a reader hunting through the env scopes for a variable that is fine.
    it('names the newline offender, the name or the value', () => {
        expect(() => envFileBody({ ...job, env: { BROKEN: 'line1\nline2' } })).toThrow(
            /the value of "BROKEN" contains a newline/,
        );
        expect(() => envFileBody({ ...job, env: { 'BRO\nKEN': 'fine' } })).toThrow(
            /the name of "BRO\nKEN" contains a newline/,
        );
        // The gate lines are checked by the same rule.
        expect(() =>
            envFileBody({ ...job, gateEnv: { BELLOWS_GATE_TOKEN: 'tok\ntok' } }),
        ).toThrow(/the value of "BELLOWS_GATE_TOKEN" contains a newline/);
    });

    it('never forwards a name the runner itself claims', () => {
        expect(claimEnv(envJob)).toEqual({ MY_TOKEN: 'board-secret' });
        const line = dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false }, null, '/tmp/env-file');
        // The one WORKDIR on the line is the runner's own, with the mount in it; TRUST_WORKDIR
        // belongs to the Remote Control branch, which this is not.
        expect(line.filter((arg) => arg === 'WORKDIR' || arg === 'TRUST_WORKDIR')).toHaveLength(0);
        expect(line).toEqual(expect.arrayContaining([`WORKDIR=/workspaces/bellows/${USER}`]));
    });

    it('drops a member CRED_HELPER from the claim env and the env file', () => {
        // CRED_HELPER is the sync fetch's credential-helper CODE, a value the driver alone
        // chooses; a member's `!` helper riding the claim env into the sync container would be
        // member-controlled code execution, run by git as helper code.
        const hijacked = { ...job, env: { CRED_HELPER: '!evil', OTHER: 'fine' } };
        expect(claimEnv(hijacked)).toEqual({ OTHER: 'fine' });
        expect(envFileBody(hijacked)).toBe('OTHER=fine\n');
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
        // The script is the static file; the session id rides as its first positional
        // parameter, a plain argv value — never interpolated into the script text.
        expect(line[5]).toBe('sh');
        expect(line[6]).toBe(SESSION);
        expect(line[4]).toContain('bridge-session');
        expect(line[4]).toContain('"$1".jsonl');
        expect(line[4]).not.toContain(SESSION);
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
        // The BELLOWS_SESSION_ID env rides before the image (it is a container env, not a CLI
        // flag), naming the SAME conversation the `--session` below restores.
        expect(line.slice(-5)).toEqual([
            'opencode-executor',
            'run',
            '--session',
            'ses_f86188c3dffeZGYO4yZq4atba9',
            'fix the failing build',
        ]);
        expect(line).toEqual(expect.arrayContaining(['-e', 'BELLOWS_SESSION_ID=ses_f86188c3dffeZGYO4yZq4atba9']));
    });

    /**
     * The close path reads what the run left behind — the session id AND how the run's last
     * message ended. A zero exit code with finish `length` is the model's context limit cutting
     * the task short, and the outcome must carry that; only a reason the daemon's read actually
     * produced lands, a failed readout costing neither.
     */
    it('scrapes the finish reason beside the session id when an opencode run closes', async () => {
        const exec = vitest.fn((args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                return Promise.resolve({
                    stdout: '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433,"cost":0.31}\n',
                });
            }
            return Promise.resolve({ stdout: '' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_CLI: 'opencode' }),
            (() => fakeChild('done\n', '', 0)) as unknown as typeof spawn,
            exec,
        );

        const outcome = await runner.run({ ...job, followUp: false }, null);
        expect(outcome).toMatchObject({
            exitCode: 0,
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
        });
    });

    /**
     * The session line may also carry the last provider error the run recorded — the premature
     * stop's cause, which only the session database knows. With a session scraped it is NOT a
     * readout failure: it rides the outcome as its own field, so the verdict can name the 429
     * instead of leaving the author a finish reason to decode.
     */
    it('carries the session’s last provider error on the outcome beside the session', async () => {
        const exec = vitest.fn((args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                return Promise.resolve({
                    stdout:
                        '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"tool-calls","tokens":100016,"cost":0,"error":"Error from provider (Console): Rate limit exceeded. Please try again later."}\n',
                });
            }
            return Promise.resolve({ stdout: '' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_CLI: 'opencode' }),
            (() => fakeChild('done\n', '', 0)) as unknown as typeof spawn,
            exec,
        );

        const outcome = await runner.run({ ...job, followUp: false }, null);
        expect(outcome.sessionId).toBe('ses_f86188c3dffeZGYO4yZq4atba9');
        expect(outcome.finishReason).toBe('tool-calls');
        expect(outcome.providerError).toBe('Error from provider (Console): Rate limit exceeded. Please try again later.');
        // A scraped session means the readout itself worked — the error is the run's, not the read's.
        expect(outcome.readoutError).toBeUndefined();
    });

    /**
     * The readout answers one of three ways — a session line, an error line, or nothing — and the
     * retries must fire on ALL but the first: the WAL-mid-checkpoint read that fails outright and
     * succeeds milliseconds later presents as an error or as silence, never as a session. A run
     * whose scrape never lands carries WHY on the outcome, because a lost session presents later
     * as "this task cannot take a follow-up" and the reason is the only way to tell a broken
     * query from an empty database.
     */
    it('retries a readout that answers nothing, and takes the session when a later try answers', async () => {
        let calls = 0;
        const exec = vitest.fn((args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                calls += 1;
                return Promise.resolve({ stdout: calls === 1 ? '' : '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"stop"}\n' });
            }
            return Promise.resolve({ stdout: '' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_CLI: 'opencode' }),
            (() => fakeChild('done\n', '', 0)) as unknown as typeof spawn,
            exec,
        );

        const outcome = await runner.run({ ...job, followUp: false }, null);
        expect(calls).toBe(2);
        expect(outcome.sessionId).toBe('ses_f86188c3dffeZGYO4yZq4atba9');
        expect(outcome.readoutError).toBeUndefined();
    });

    it('carries the readout’s error on the outcome when every try fails', async () => {
        let calls = 0;
        const exec = vitest.fn((args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                calls += 1;
                return Promise.resolve({ stdout: '{"error":"no such column: role"}\n' });
            }
            return Promise.resolve({ stdout: '' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_CLI: 'opencode' }),
            (() => fakeChild('done\n', '', 0)) as unknown as typeof spawn,
            exec,
        );

        const outcome = await runner.run({ ...job, followUp: false }, null);
        expect(calls).toBe(3);
        expect(outcome.sessionId ?? null).toBeNull();
        expect(outcome.readoutError).toBe('no such column: role');
    });

    it('carries a refused readout container on the outcome too', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) throw new Error('daemon refused the readout');
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_CLI: 'opencode' }),
            (() => fakeChild('done\n', '', 0)) as unknown as typeof spawn,
            exec,
        );

        const outcome = await runner.run({ ...job, followUp: false }, null);
        expect(outcome.readoutError).toBe('the readout container failed: daemon refused the readout');
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
                '--label',
                `factory.lease=${job.leaseToken}`,
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
            '-e',
            `OPENCODE_DB=/workspaces/bellows/${USER}/.opencode/opencode/opencode.db`,
            '-e',
            // The scope: the session database is per member, so the readout answers only the
            // session whose `directory` is the working directory the RUN container had — the
            // member root here, since this job names no repo. Without it, two concurrent tasks
            // of one member share the database and the newest-root-session scrape answers
            // whichever task closed last (observed 2026-09-11: two /fix tasks recorded one
            // session id, and both their follow-ups resumed the same conversation).
            `OPENCODE_DIR=/workspaces/bellows/${USER}`,
        ]);
        expect(line.slice(8, 12)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e']);
        const script = line[12] as string;
        // The script is the static file: the database path arrives by env, so no board-derived
        // value is ever part of its text.
        expect(script).not.toContain(`/workspaces/bellows/${USER}`);
        expect(script).toContain('process.env.OPENCODE_DB');
        expect(script).toContain('process.env.OPENCODE_DIR');
        expect(script).toContain('parent_id is null');
        expect(script).toContain('directory = ?');
        // The role is a field INSIDE the message's data JSON, not a column — a SQL role filter
        // throws "no such column: role" on every read and the scrape answers nothing. Filtered in
        // JS instead, where the parsed role actually is.
        expect(script).not.toContain("role='assistant'");
        expect(script).toContain("d.role !== 'assistant'");
        expect(script).toContain('readOnly');
        // A failure prints one parseable error line — the empty output of a broken query is
        // otherwise indistinguishable from an empty database.
        expect(script).toContain('{ error:');
    });

    it('scopes the readout to the task worktree when the job names a repo', () => {
        const line = opencodeSessionReadoutArgs(loadDriverConfig({ RUNNER_CLI: 'opencode' }), {
            ...job,
            repo: 'Bellows-AI/factory',
        });
        expect(line).toContain(`OPENCODE_DIR=/workspaces/bellows/${USER}/.worktrees/${job.id}`);
    });

    it('pulls the session id, finish reason and context stats out of the readout’s answer', () => {
        expect(
            parseOpencodeRunOutcome('{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433.4,"cost":0.31}\n'),
        ).toEqual({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
            error: null,
        });
        // A healthy run's closing word, and a free-tier cost of zero.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":"stop","tokens":1200,"cost":0}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'stop',
            contextTokens: 1200,
            costUsd: 0,
            error: null,
        });
        // A message that never reported a finish or tokens reads as none, not as a reason.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":null,"tokens":null,"cost":null}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            error: null,
        });
        // The readout's own failure line: carried through as the reason, with no stats.
        expect(parseOpencodeRunOutcome('{"error":"no such column: role"}')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            error: 'no such column: role',
        });
        expect(parseOpencodeRunOutcome('')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            error: null,
        });
        // Not a session id: a path, an error line, or a uuid that would read as claude's.
        expect(parseOpencodeRunOutcome('ses_f86188c3dffeZGYO4yZq4atba9\n').sessionId).toBeNull();
        expect(parseOpencodeRunOutcome('Error: Session not found').sessionId).toBeNull();
        expect(
            parseOpencodeRunOutcome('{"id":"33333333-3333-4333-8333-333333333333","finish":"stop"}').sessionId,
        ).toBeNull();
        // Negative or non-numeric context stats are not stats.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","tokens":-5,"cost":"free"}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            error: null,
        });
        // A session line that also carries the last provider error: both ride — the session makes
        // the task follow-up-able, the error is the premature stop's cause.
        expect(
            parseOpencodeRunOutcome(
                '{"id":"ses_x1","finish":"tool-calls","tokens":100016,"cost":0,"error":"Error from provider (Console): Rate limit exceeded. Please try again later."}',
            ),
        ).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'tool-calls',
            contextTokens: 100016,
            costUsd: 0,
            error: 'Error from provider (Console): Rate limit exceeded. Please try again later.',
        });
    });
});

describe('the cache watch', () => {
    const DEATH = '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","turns":[' +
        '{"input":84000,"cacheRead":0,"ms":250000},' +
        '{"input":80000,"cacheRead":0,"ms":200000},' +
        '{"input":63000,"cacheRead":0,"ms":150000}]}';

    /**
     * The probe is a throwaway container over the workspaces volume, entrypoint swapped for node
     * — the live-run twin of the close-time readout. Pure and pinned for the same reason.
     */
    it('probes the newest root session of the member’s data directory, read-only', () => {
        const line = opencodeCacheProbeArgs(loadDriverConfig({ RUNNER_CLI: 'opencode' }), job);
        expect(line.slice(0, 8)).toEqual([
            'run',
            '--rm',
            '-v',
            'factory-ai_workspaces:/workspaces',
            '-e',
            `OPENCODE_DB=/workspaces/bellows/${USER}/.opencode/opencode/opencode.db`,
            '-e',
            // The turn count rides from the driver's own constant, so the probe and the verdict
            // cannot drift apart.
            `CACHE_WATCH_TURNS=${CACHE_WATCH_TURNS}`,
        ]);
        expect(line.slice(8, 12)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e']);
        const script = line[12] as string;
        expect(script).toContain('process.env.OPENCODE_DB');
        expect(script).toContain('process.env.CACHE_WATCH_TURNS');
        // Newest-first, so the probe can answer from the run's last handful of messages without
        // reading the session whole.
        expect(script).toContain('order by id desc');
        expect(script).toContain('parent_id is null');
        expect(script).toContain("d.role !== 'assistant'");
        expect(script).toContain('readOnly');
        expect(script).toContain('{ error:');
    });

    it('parses the probe’s answer, error lines included', () => {
        expect(parseOpencodeCacheProbe(`${DEATH}\n`)).toEqual({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            turns: [
                { input: 84000, cacheRead: 0, ms: 250000 },
                { input: 80000, cacheRead: 0, ms: 200000 },
                { input: 63000, cacheRead: 0, ms: 150000 },
            ],
            error: null,
        });
        // Not yet: no session, no turns, no error.
        expect(parseOpencodeCacheProbe('')).toEqual({ sessionId: null, turns: [], error: null });
        expect(parseOpencodeCacheProbe('{"error":"database is locked"}')).toEqual({
            sessionId: null,
            turns: [],
            error: 'database is locked',
        });
        // Malformed turns are not turns.
        expect(parseOpencodeCacheProbe('{"id":"ses_x1","turns":[{"input":-1},{"input":5}]}').turns).toEqual([]);
    });

    it('fires only on three consecutive dead, real-context, slow turns', () => {
        const turn = (over: Partial<{ input: number; cacheRead: number; ms: number }> = {}) => ({
            input: 80000,
            cacheRead: 0,
            ms: 200000,
            ...over,
        });
        // Fewer than three: not yet, whatever the turns look like.
        expect(cacheCollapse([turn(), turn()])).toBeNull();
        // The collapse itself, with the observed shape of the first incident.
        const verdict = cacheCollapse([turn({ ms: 250000 }), turn({ ms: 200000 }), turn({ ms: 150000 })]);
        expect(verdict).toContain('3 consecutive turns with no prompt-cache reads');
        expect(verdict).toContain('80k/80k/80k');
        expect(verdict).toContain('150-250s');
        // Cache hits, fast turns, or a tiny context each break the chain — the watch fires on a
        // provider that stopped CACHING INTO A WALL, not on a model that never cached and answers
        // quickly anyway.
        expect(cacheCollapse([turn({ cacheRead: 5000 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn({ ms: 1000 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn({ input: 500 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn(), turn({ ms: 1000 }), turn()])).toBeNull();
    });

    // A controllable child: stays open while the probe interval ticks, closed by the test once
    // the daemon has seen what the assertions need. The runner's own `docker run` goes through
    // spawnFn; every daemon call goes through the exec seam below.
    const openChild = () => {
        const c = new EventEmitter() as ChildProcess;
        c.stdout = new EventEmitter();
        c.stderr = new EventEmitter();
        return {
            spawn: (() => c) as unknown as typeof spawn,
            close: (code: number | null) => {
                process.nextTick(() => c.emit('close', code));
            },
        };
    };

    it('kills the run when the probe reports a dead cache, and carries the reason', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: DEATH };
            // The kill resolves its runner through its own label pair; the lease filter marks
            // this attempt's ps, and answering it with a container id is what lets the mock see
            // the `docker kill` itself.
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease'))) {
                return { stdout: 'runner-1\n' };
            }
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = createDockerRunner(
            loadDriverConfig({
                RUNNER_CLI: 'opencode',
                RUNNER_CACHE_WATCH: '1',
                RUNNER_CACHE_WATCH_POLL_MS: '250',
            }),
            childSpawn,
            exec,
        );

        const pending = runner.run({ ...job, followUp: false }, null);
        while (!calls.some((a) => a[0] === 'kill')) await new Promise((r) => setTimeout(r, 5));
        close(137);
        const outcome = await pending;

        expect(outcome.exitCode).toBe(137);
        expect(outcome.cacheLost).toContain('3 consecutive turns with no prompt-cache reads');
        expect(outcome.timedOut).toBe(false);
    });

    it('leaves the daemon alone while the watch is off', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_CLI: 'opencode' }),
            childSpawn,
            exec,
        );

        const pending = runner.run({ ...job, followUp: false }, null);
        // Two poll periods of a live run, had the watch been armed at the same 250ms the armed
        // test uses — then an ordinary clean exit.
        await new Promise((r) => setTimeout(r, 500));
        close(0);
        await pending;

        // The close-time readout does run; the mid-run probe never does.
        expect(calls.some((a) => a[0] === 'run' && a.includes('order by id desc'))).toBe(false);
    });
});

/**
 * The gate environment container: one long-lived `docker run -d` per task worktree, a `docker exec`
 * per gate. Pure and pinned for the same reason dockerArgs is — everything security-relevant about
 * the environment runner is decided in these arrays, and the values they interpolate arrive from
 * the board and from a file in a member's checkout.
 */
describe('the gate environment container', () => {
    const ROOT = '55555555-5555-4555-8555-555555555555';
    const KEY = `bellows/${USER}/.worktrees/${ROOT}`;
    const config = loadDriverConfig({});

    it('names the container after the worktree key, exec-able and orphan-findable', () => {
        expect(gateEnvContainerName(KEY)).toBe(`factory-env-bellows-${USER}-.worktrees-${ROOT}`);
        expect(gateEnvArgs(config, KEY, 'node:24')).toEqual(
            expect.arrayContaining([
                '-d',
                '--name',
                `factory-env-bellows-${USER}-.worktrees-${ROOT}`,
                '--label',
                `factory.gates=${KEY}`,
            ]),
        );
    });

    it('mounts the checkouts volume and works inside the worktree, like the coding agent does', () => {
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
    // board's claim plus a repo label — asserted, not trusted, the WORKSPACE_PATH posture. The
    // worktree key is the only shape now: gates run in the tree the agent edits, and that tree
    // is `<org>/<uuid>/.worktrees/<root id>`, never the pristine clone.
    it('refuses a key that is not <org>/<uuid>/.worktrees/<uuid>', () => {
        for (const key of [
            '../../etc',
            `bellows/${USER}`,
            `bellows/not-a-uuid/.worktrees/${ROOT}`,
            `bellows/${USER}/.worktrees/not-a-uuid`,
            `bellows/${USER}/factory`,
            `bellows/${USER}/../..`,
            `bellows/${USER}/.worktrees/${ROOT}/../..`,
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

    // The name validator and the name generator must agree: a long org + long uuid produces the
    // longest key the pattern allows (org 39 + uuid 36 + the worktree segment + root uuid 36),
    // and every gate of that checkout must still be exec-able.
    it('accepts the longest container name the worktree-key pattern can produce', () => {
        const longestUuid = `${'f'.repeat(8)}-${'f'.repeat(4)}-${'f'.repeat(4)}-${'f'.repeat(4)}-${'f'.repeat(12)}`;
        const key = `${'a'.repeat(39)}/${USER}/.worktrees/${longestUuid}`;
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

    /**
     * A claim can resolve to nothing — no env configured in any scope — while the job still
     * declares gates. The loop mints BELLOWS_GATE_URL/TOKEN for exactly such a job, and a runner
     * that keyed the env file on the claim alone would spawn with neither: no ad-hoc gate call
     * possible, and the run's own verification unreadable to the agent.
     */
    const gateOnly: BoardJob = {
        ...job,
        repo: 'Bellows-AI/factory',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
        gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' },
    };

    it('mounts the env file when the only env is the gate credentials', () => {
        expect(envFileBody(gateOnly)).toBe(
            'BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n',
        );
        const line = dockerArgs(loadDriverConfig({}), gateOnly, { id: SESSION, resume: false }, null, '/tmp/env-file');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    it('refuses to run a job whose only env is gate credentials with no env file to carry them', () => {
        // The same silent drop the claim-env refusal prevents — the credentials it was spawned
        // against never reach the container.
        expect(() => dockerArgs(loadDriverConfig({}), gateOnly, { id: SESSION, resume: false })).toThrow(
            /no env file/,
        );
    });

    it('adds the host gateway mapping so the default gate URL resolves on Linux daemons', () => {
        expect(
            dockerArgs(loadDriverConfig({}), gated, { id: SESSION, resume: false }, null, '/tmp/env-file'),
        ).toEqual(expect.arrayContaining(['--add-host', 'host.docker.internal:host-gateway']));
        // ... and only for a gated job: an ungated runner's argv must stay byte-identical.
        expect(dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false })).not.toContain(
            'host.docker.internal:host-gateway',
        );
    });

    it('never puts a gate value on the command line', () => {
        const line = dockerArgs(loadDriverConfig({}), gated, { id: SESSION, resume: false }, null, '/tmp/env-file');
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

    // opencode's plugin reads its endpoint from otel.json, not from OTEL_EXPORTER_OTLP_ENDPOINT —
    // the executor entrypoint rewrites the file. This is the driver half of that contract: the env
    // var has to reach the runner at all, for this CLI no less than for claude-code.
    it('forwards the OTEL endpoint to the opencode runner too', () => {
        const line = dockerArgs(loadDriverConfig({ RUNNER_CLI: 'opencode', RUNNER_OTEL_ENDPOINT: 'http://collector:4318' }), job, null);
        expect(line).toEqual(
            expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']),
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

    /**
     * The vitals sample goes through the same daemon seam as everything else, named by this
     * attempt's lease token — a sample can only ever resolve its own attempt's runner. A daemon
     * that refuses (the container exited between the ask and the read) is null, never a throw:
     * a missed sample costs freshness, not the run.
     */
    it('samples the runner container vitals through the daemon seam', async () => {
        const exec = vitest.fn((args: string[]) => {
            expect(args[0]).toBe('stats');
            expect(args.slice(1, 4)).toEqual(['--no-stream', '--format', '{{json .}}']);
            expect(args[4]).toBe(containerName(job));
            return Promise.resolve({
                stdout: '{"CPUPerc":"93.00%","MemPerc":"7.02%","MemUsage":"544MiB / 7.754GiB","Name":"x"}\n',
            });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(loadDriverConfig({}), child('done\n', '', 0), exec);

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
        });
    });

    it('answers null when the vitals sample cannot be taken', async () => {
        const exec = vitest.fn(() => Promise.reject(new Error('daemon refused'))) as unknown as (
            args: string[],
        ) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(loadDriverConfig({}), child('done\n', '', 0), exec);

        await expect(runner.sampleRuntime(job)).resolves.toBeNull();
    });

    describe('parseDockerStats', () => {
        // The stats fields are display strings; the parse is worth its own pin.
        it('reads the JSON line the daemon prints', () => {
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}')).toEqual({
                cpuPercent: 93,
                memUsedMb: 544,
                memPercent: 7.02,
            });
        });

        it('converts every memory unit to MiB, binary and decimal spellings alike', () => {
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"1.5GiB / 8GiB"}')).toMatchObject({
                memUsedMb: 1536,
            });
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"512KiB / 8GiB"}')).toMatchObject({
                memUsedMb: 0.5,
            });
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"2000kB / 8GiB"}')).toMatchObject({
                memUsedMb: 2,
            });
        });

        it('takes null for a percentage the daemon did not report, and null for garbage', () => {
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB"}')).toMatchObject({
                memPercent: null,
            });
            expect(parseDockerStats('')).toBeNull();
            expect(parseDockerStats('not json')).toBeNull();
            expect(parseDockerStats('{"MemUsage":"544MiB / 7.754GiB"}')).toBeNull();
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"? / 8GiB"}')).toBeNull();
        });
    });

    describe('currentActivity', () => {
        // The activity line is the stream's last non-empty line with its escapes stripped — the
        // tool call most of the time. A heuristic on purpose: the stream is the CLI's to format.
        it('strips ANSI escapes and takes the last non-empty line', () => {
            expect(currentActivity('$ npm test\n\x1b[32m→ Read src/x.ts\x1b[0m\n')).toBe('→ Read src/x.ts');
            expect(currentActivity('one\n\n  \ntwo')).toBe('two');
        });

        it('caps the line and takes null for a tail that says nothing', () => {
            expect(currentActivity('x'.repeat(500)).length).toBe(200);
            expect(currentActivity(null)).toBeNull();
            expect(currentActivity('\n\n')).toBeNull();
            expect(stripAnsi('\x1b]0;title\x07after')).toBe('after');
        });
    });


    // A gated job whose claim resolves to no variables still needs the minted gate credentials:
    // keyed on the claim alone, the file would not exist and the runner could never call a gate.
    it('writes the gate credentials into the env file of a job whose claim env is empty', async () => {
        let fileBody: string | null = null;
        const spawnFn = vitest.fn((_cmd: unknown, argv: unknown) => {
            // Read at spawn time, through the argv: what the CLI could see is what counts.
            const args = argv as string[];
            const fileArg = args[args.indexOf('--env-file') + 1];
            fileBody = readFileSync(fileArg, 'utf8');
            return fakeChild('', '', 0);
        });
        const runner = createDockerRunner(loadDriverConfig({}), spawnFn as unknown as typeof spawn, noContainer);

        const outcome = await runner.run(
            { ...job, gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' } },
            { id: SESSION, resume: false },
        );

        expect(outcome).toMatchObject({ exitCode: 0 });
        const [, argv] = spawnFn.mock.calls[0]!;
        expect(argv).toContain('--env-file');
        expect(fileBody).toBe('BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n');
    });

    // The Remote Control posture is untouched: no forwarded credential of any kind, the volume
    // login is the only one — so gate credentials make no env file appear either.
    it('writes no env file for a Remote Control runner, gate credentials included', async () => {
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_REMOTE_CONTROL: '1' }),
            spawnFn as unknown as typeof spawn,
            noContainer,
        );
        await runner.run({ ...job, gateEnv: { BELLOWS_GATE_TOKEN: 'tok' } }, { id: SESSION, resume: false });

        const [, argv] = spawnFn.mock.calls[0]!;
        expect(argv).not.toContain('--env-file');
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
    // attempt's fleet is already up — is the test's to pace. `track`, when given, sees every
    // spawned argv: it is how the cross-instance tests register the runner container on the
    // scripted daemon, whose `docker run` goes through spawnFn and never through the exec seam.
    const gatedSpawns = (track?: (argv: string[]) => void) => {
        const fires: ((what: 'error' | 'close', payload?: unknown) => void)[] = [];
        let resolveSpawn: (() => void) | null = null;
        const spawned = new Promise<void>((resolve) => {
            resolveSpawn = resolve;
        });
        const fn = ((command: string, argv: string[]) => {
            track?.(argv);
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

    /*
     * The attempt-scoping helpers. Two attempts of one job — the stale-race cast, used by every
     * test below that replays an interleaving between an attempt A and its replacement B. The
     * lease-aware ps answer is what makes "A's removals never carry B's id" assertable: a `ps`
     * whose filters carry a lease label answers with that attempt's own id only (idFor mints it
     * from the token's first letter), while a job-scoped `ps` — the fence's — answers with both
     * attempts'. touchesB is the blanket assertion: no argv element of a stale attempt may
     * contain any of B's identifiers.
     */
    const ATTEMPT_A = 'aaaaaaa2-2222-4222-8222-222222222222';
    const ATTEMPT_B = 'bbbbbbb3-3333-4333-8333-333333333333';
    const attemptA: BoardJob = { ...job, leaseToken: ATTEMPT_A };
    const attemptB: BoardJob = { ...job, leaseToken: ATTEMPT_B };
    const idFor = (token: string): string => `${token.slice(0, 1)}-svc-id`;
    const touchesB = (args: string[]): boolean => args.some((arg) => arg.includes(ATTEMPT_B) || arg === 'b-svc-id');
    const psAnswer = (args: string[]): string => {
        const lease = args.find((arg) => arg.startsWith('label=factory.lease='))?.split('=')[2];
        // A lease-scoped ps answers with that attempt's own id; a job-scoped one — the fence's —
        // answers with a neutral leftover, because the fence legitimately removes EVERYTHING the
        // job label covers: that is its role, and it runs before anything is created.
        return lease ? `${idFor(lease)}\n` : 'stale-leftover\n';
    };

    /*
     * A stateful daemon for the cross-attempt tests: containers and networks live in maps keyed
     * by id/name with their labels, `ps` and `network ls` honor `--filter label=` pairs, and rm /
     * network rm remove exactly what they are told. Service containers and networks register
     * through the exec seam itself; runner containers register through acceptRun, because the
     * runner's own `docker run` goes through spawnFn. With this daemon the "B is untouched"
     * assertions stop being argv-shaped and become state: B's entries are still in the maps
     * after everything A did.
     */
    const scriptedDaemon = (readout: string) => {
        const containers = new Map<string, Record<string, string>>();
        const networks = new Map<string, Record<string, string>>();
        const calls: string[][] = [];
        const labelsOf = (args: string[]): Record<string, string> => {
            const labels: Record<string, string> = {};
            for (let i = 0; i < args.length; i += 1) {
                if (args[i] === '--label') {
                    const [key, value] = (args[i + 1] ?? '').split('=');
                    if (key && value !== undefined) labels[key] = value;
                }
            }
            return labels;
        };
        const filtersOf = (args: string[]): [string, string][] => {
            const filters: [string, string][] = [];
            for (let i = 0; i < args.length; i += 1) {
                if (args[i] === '--filter' && (args[i + 1] ?? '').startsWith('label=')) {
                    const [key, value] = (args[i + 1] ?? '').slice('label='.length).split('=');
                    if (key && value !== undefined) filters.push([key, value]);
                }
            }
            return filters;
        };
        const matches = (filters: [string, string][], labels: Record<string, string>): boolean =>
            filters.every(([key, value]) => labels[key] === value);
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'ps') {
                const filters = filtersOf(args);
                return {
                    stdout: [...containers.entries()]
                        .filter(([, labels]) => matches(filters, labels))
                        .map(([id]) => id)
                        .join('\n'),
                };
            }
            if (args[0] === 'rm' && args[1] === '-f') {
                for (const id of args.slice(2)) containers.delete(id);
                return { stdout: '' };
            }
            if (args[0] === 'kill') return { stdout: '' };
            if (args[0] === 'network' && args[1] === 'ls') {
                const filters = filtersOf(args);
                return {
                    stdout: [...networks.entries()]
                        .filter(([, labels]) => matches(filters, labels))
                        .map(([name]) => name)
                        .join('\n'),
                };
            }
            if (args[0] === 'network' && args[1] === 'rm') {
                for (const name of args.slice(2)) networks.delete(name);
                return { stdout: '' };
            }
            if (args[0] === 'network' && args[1] === 'create') {
                networks.set(args[args.length - 1]!, labelsOf(args));
                return { stdout: '' };
            }
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: readout };
            if (args[0] === 'run' && args.includes('--network-alias')) {
                containers.set(args[args.indexOf('--name') + 1]!, labelsOf(args));
                return { stdout: '' };
            }
            return { stdout: '' };
        });
        const acceptRun = (argv: string[]): void => {
            calls.push(argv);
            const name = argv[argv.indexOf('--name') + 1];
            if (name) containers.set(name, labelsOf(argv));
        };
        return { containers, networks, calls, exec, acceptRun };
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
        // The runner is resolved through this attempt's own labels and killed by ID — never by
        // name, which a stale attempt's kill could otherwise compute against a replacement's
        // container.
        expect(calls).toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            `label=factory.lease=${job.leaseToken}`,
        ]);
        expect(calls).toContainEqual(['kill', 'svc-id-1']);
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
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        // runA rejects as soon as its kill lands — before the test observes it — so mark it
        // handled now; an interim unhandled-rejection state here derails the test worker.
        runA.catch(() => undefined);
        await killRecorded;
        // Everything issued so far is A's: the kill window closes here, before B starts.
        const aEnd = exec.mock.calls.length;
        // B's claim lands while A is still between awaited steps — nothing stops it.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });

        // A was the attempt the loop killed: it aborts.
        await expect(runA).rejects.toThrow(/killed while setting up services/);
        // And nothing A issued on its way out — kill and teardown included — named anything of
        // B's: the ps filters carry A's lease, and B's token appears in no argv.
        const aCalls = exec.mock.calls.slice(0, aEnd).map((call) => call[0]);
        expect(aCalls.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(aCalls.every((a) => !touchesB(a))).toBe(true);

        // B was never killed, whatever happened to A: network, service, spawn all happen —
        // under B's OWN names, since every name carries B's token.
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
        // Exactly one attempt got as far as creating the network, and it is B's network —
        // created labeled, like everything the attempt stands up.
        const creates = exec.mock.calls.map((call) => call[0]).filter((a) => a[0] === 'network' && a[1] === 'create');
        expect(creates).toEqual([
            [
                'network',
                'create',
                '--label',
                `factory.job=${job.id}`,
                '--label',
                `factory.lease=${ATTEMPT_B}`,
                networkName(attemptB),
            ],
        ]);
        expect(seen).toHaveLength(1);
    });

    // The abort must not disturb a sibling attempt's fleet. In the gated world that needed a
    // teardown-FREE abort; in the scoped world the kill's teardown ISSUES its daemon calls and
    // is safe because of what it names: every ps carries A's lease, every removal carries A's
    // id or A's network name. B claims with a fresh token and stands its fleet up afterwards,
    // untouched — nothing A issued could resolve to it.
    it('scopes a killed attempt\'s teardown to its own lease, leaving a sibling attempt\'s fleet alone', async () => {
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
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        // runA rejects as soon as its kill lands — before the test observes it — so mark it
        // handled now; an interim unhandled-rejection state here derails the test worker.
        runA.catch(() => undefined);
        await killSettled;
        await expect(runA).rejects.toThrow(/killed while setting up services/);

        // Everything so far is A's: the kill and its teardown ran — and every call of them is
        // scoped to A. The ps filters carry A's lease, the removals carry A's id and A's
        // network name, and no argv element names anything of B's.
        const aCalls = exec.mock.calls.map((call) => call[0]);
        expect(aCalls.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(aCalls).toContainEqual(['kill', idFor(ATTEMPT_A)]);
        expect(aCalls).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(aCalls).toContainEqual(['network', 'rm', networkName(attemptA)]);
        expect(aCalls.every((a) => !touchesB(a))).toBe(true);

        // B, the newer attempt for the same job id: fence, network create, service start and
        // runner spawn all happen after A's abort — and nothing A did on the way out disturbed
        // them.
        const outcome = await runner.run(attemptB, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual([
            'network',
            'create',
            '--label',
            `factory.job=${job.id}`,
            '--label',
            `factory.lease=${ATTEMPT_B}`,
            networkName(attemptB),
        ]);
        expect(calls.some((a) => a.includes('--network-alias'))).toBe(true);
        expect(seen).toHaveLength(1);
    });

    // A's close that lands LATE: A was killed — kill() tore A's own fleet down while it was
    // still legitimately A's own — and the loop re-claimed the job as B before A's CLI client
    // finally exited. A's verdict still runs its teardown, gate-free: the teardown is scoped to
    // A's lease, so whatever it names is A's own, and B's live fleet is structurally
    // unaddressable no matter how late the close lands.
    it('scopes a killed attempt\'s late verdict teardown to its own lease when the replacement has stood its fleet up', async () => {
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

        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, gatedSpawn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        const closeA = await closeOf(0); // A spawned; its CLI client is alive
        // The loop loses A's lease and kills the attempt: A's own fleet torn down while it is
        // still legitimately A's.
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
        // The teardown ran — and every call of it is A's: the ps filters carry A's lease, the
        // removals carry A's id and A's network name, and nothing names B.
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late).toContainEqual(['network', 'rm', networkName(attemptA)]);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        closers[1]!();
        await expect(runB).resolves.toMatchObject({ exitCode: 137, started: true });
    });

    // The natural-close twin of the test above, with NO kill anywhere: the lease expires
    // server-side and the board re-claims the job as B before any heartbeat delivers 'lost' —
    // so the loop never kills A, and A's `killed` marker is never recorded. B's fence removes
    // A's leftovers, which closes A's CLI client, and A's verdict then lands over B's live
    // fleet. Not-killed is not a free pass to skip the teardown — it runs unconditionally —
    // and it is safe unconditionally: scoped to A's lease, it can only ever name A's own.
    it('scopes a natural close\'s late verdict teardown to its own lease when a replacement claim has stood its fleet up', async () => {
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
            closers.push(() => process.nextTick(() => c.emit('close', 0)));
            resolveSpawn!();
            return c;
        }) as unknown as typeof spawn;
        const closeOf = async (index: number): Promise<() => void> => {
            while (closers.length <= index) await spawned;
            return closers[index]!;
        };

        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, gatedSpawn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        const closeA = await closeOf(0); // A spawned; its CLI client is alive — and never killed
        // B re-claims the same job id with no kill in between: the heartbeat has not yet told
        // the loop A's lease is gone. B's fence removes A's leftovers by label.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await closeOf(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        // A's CLI client only now closes naturally — its container was fenced away by B.
        closeA();
        await runA;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late).toContainEqual(['network', 'rm', networkName(attemptA)]);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        closers[1]!();
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The late-kill twin of the two close tests above: the kill itself arrives AFTER the
    // replacement claimed the job and stood its fleet up — the heartbeat can be arbitrarily
    // slow to deliver the lease loss, and the claim loop has no per-job dedupe. There is no
    // gate to stop the kill, and none is needed: the kill resolves its target through A's own
    // lease label and kills by id, so the only container it can name is A's, and its teardown
    // is scoped the same way.
    it('scopes a kill that lands after the replacement stood its fleet up to the killed attempt\'s own lease', async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its CLI client is alive
        // B re-claims the same job id and stands a fresh fleet up BEFORE the loop learns of
        // A's lost lease.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        // Only now does the loop's kill for A fire — over a daemon where B's fleet is live.
        await runner.kill(attemptA);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        // The kill resolved its runner through A's lease label and killed by id — never by
        // name — and the teardown behind it is A-scoped too. Nothing names B.
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['kill', idFor(ATTEMPT_A)]);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late).toContainEqual(['network', 'rm', networkName(attemptA)]);
        expect(late.every((a) => !touchesB(a))).toBe(true);

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
                // ps #1 is the entry fence; ps #2 is the fence's own service half; ps #3 is the
                // error-path teardown, held so the close handler gets its turn while the
                // teardown is still in flight.
                if (psCount === 3) await teardownPsGate;
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
    // services down before rejecting — unconditionally now, and safe unconditionally: the
    // teardown's filters carry A's lease, so the only fleet it can find and remove is A's own.
    it('scopes a superseded spawn error\'s teardown to the failing attempt\'s own lease', async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A is as far as its spawn, whose failure stays undelivered for now
        // B re-claims the same job id and stands a fresh fleet up while A's spawn failure is
        // still in flight.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        fires[0]!('error', new Error('spawn docker ENOENT'));
        // The rejection still surfaces — and the teardown it waited for addressed only A's own
        // resources. Marked handled at once: the rejection lands while the teardown is still in
        // flight, before the await below observes it.
        runA.catch(() => undefined);
        await expect(runA).rejects.toThrow(/ENOENT/);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late).toContainEqual(['network', 'rm', networkName(attemptA)]);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The mid-flight twin: the spawn error lands while A is STILL current, the teardown starts,
    // and B claims the job id only while that teardown sits mid-flight, between its ps and its
    // removals. In the gated world this interleaving needed a live ownership predicate
    // re-armed at every step; in the scoped world it needs nothing: the removals were chosen by
    // a ps that filtered on A's lease, and releasing them late removes exactly what that ps
    // found — A's own resources — whatever B stood up in between.
    it('keeps a teardown scoped to its own lease even when the replacement stands its fleet up while it is mid-flight', async () => {
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
                // ps #1 is A's entry fence; ps #2 is A's fence-half teardown; ps #3 is A's
                // error-path teardown, parked so B can stand its fleet up while it sits
                // between its ps and its removals; ps #4 and #5 are B's fence and fence-half.
                if (psCount === 3) {
                    markTeardownPs!();
                    await teardownPsGate;
                }
                return { stdout: psAnswer(args) };
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

        releaseTeardownPs!(); // the teardown resumes — and names only what its own ps found
        // Marked handled at once: the rejection lands as soon as the teardown settles, before
        // the await below observes it.
        runA.catch(() => undefined);
        await expect(runA).rejects.toThrow(/ENOENT/); // the rejection still surfaces

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late).toContainEqual(['network', 'rm', networkName(attemptA)]);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The kill() twin: kill()'s `docker kill` daemon call is arbitrarily slow, and a
    // replacement claim lands inside that window and stands its fleet up — under its own
    // names. When the kill resumes, its teardown addresses only what A's lease filters resolve
    // to; B's fleet was never nameable by any of it, so there is nothing to re-check.
    it('keeps a kill scoped to its own lease even when the replacement stands its fleet up while the docker kill is mid-flight', async () => {
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
                // call inside which B claims.
                markKillParked!();
                await killGate;
                return { stdout: '' };
            }
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: READOUT };
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its runner and fleet stand
        const pending = runner.kill(attemptA); // resolves its target, then parks in `docker kill`
        await killParked;

        // The kill by id was issued before B existed, and it was A's id — resolved through
        // A's lease label — not a name.
        const killCall = exec.mock.calls.map((call) => call[0]).find((a) => a[0] === 'kill');
        expect(killCall).toEqual(['kill', idFor(ATTEMPT_A)]);

        // B re-claims the same job id with a fresh token and stands a fresh fleet up while
        // A's kill is still awaiting the daemon.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its network and service are live
        const afterBCreation = exec.mock.calls.length;

        releaseKill!(); // the kill resumes into its teardown
        await pending;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late).toContainEqual(['network', 'rm', networkName(attemptA)]);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // A still winds down by its own killed marker, and B is untouched, finishing under
        // its own verdict.
        fires[0]!('close', 137);
        await runA;
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    /*
     * The three pins of the attempt-scoping redesign itself. The race tests above replay
     * interleavings; these three state the structural invariant they all follow from: names
     * are attempt-scoped and never repeat, the fence is the only job-scoped sweep, and a stale
     * attempt's every daemon call resolves to its own lease or nothing.
     */

    // The flagship: two RUNNER INSTANCES share one daemon, the way two driver processes hold
    // two attempts of the same job with no in-process state between them. B's fence is
    // job-scoped and removes A's live fleet — that is its role, and it runs before B creates
    // anything; A's runner dying to it is the accepted re-claim semantics. The pin is the LATE
    // kill: fired from A's own runner after B stands its fleet up, every call it issues
    // carries A's lease, B's names appear in no argv, and B finishes its run untouched.
    it('keeps a replacement attempt unaddressable to a stale attempt\'s late kill across two runner instances', async () => {
        const d = scriptedDaemon(READOUT);
        const spawnA = gatedSpawns((argv) => d.acceptRun(argv));
        const spawnB = gatedSpawns((argv) => d.acceptRun(argv));
        const runner1 = createDockerRunner(
            loadDriverConfig({ RUNNER_SERVICES: '1' }),
            spawnA.fn,
            d.exec as unknown as (args: string[]) => Promise<{ stdout: string }>,
        );
        const runner2 = createDockerRunner(
            loadDriverConfig({ RUNNER_SERVICES: '1' }),
            spawnB.fn,
            d.exec as unknown as (args: string[]) => Promise<{ stdout: string }>,
        );

        const runA = runner1.run(attemptA, { id: SESSION, resume: false });
        await spawnA.childAt(0); // A's fleet and runner stand on the daemon
        expect(d.containers.has(containerName(attemptA))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(true);
        expect(d.networks.has(networkName(attemptA))).toBe(true);

        // B claims the same job id with a different token. Its fence is job-scoped and removes
        // A's live fleet before creating anything of its own.
        const runB = runner2.run(attemptB, { id: SESSION, resume: false });
        // Indexes are per instance: B is spawnB's FIRST spawn, not the second of a shared one.
        await spawnB.childAt(0);
        expect(d.containers.has(containerName(attemptA))).toBe(false);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(false);
        expect(d.networks.has(networkName(attemptA))).toBe(false);
        expect(d.containers.has(containerName(attemptB))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptB, 'stub'))).toBe(true);
        expect(d.networks.has(networkName(attemptB))).toBe(true);
        const afterBCreation = d.calls.length;

        // A's late kill fires from its own runner, over a daemon where B's fleet is live.
        await runner1.kill(attemptA);

        const late = d.calls.slice(afterBCreation);
        // Every call kill() issues is scoped to A: the ps filters carry A's lease, and nothing
        // in any argv names B — not B's token, names, or ids.
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late.every((a) => !touchesB(a))).toBe(true);
        // B's fleet survives on the daemon: containers and network all still there.
        expect(d.containers.has(containerName(attemptB))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptB, 'stub'))).toBe(true);
        expect(d.networks.has(networkName(attemptB))).toBe(true);

        // B finishes its run under its own verdict — and A's runner child winds down too:
        // its run never settles otherwise, and the job-timeout timer armed at its spawn would
        // hold the worker's event loop open for the full timeout.
        spawnB.fires[0]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
        spawnA.fires[0]!('close', 137);
        await expect(runA).resolves.toMatchObject({ exitCode: 137, started: true });
    });

    // Same job id, different attempts: every name either attempt computes carries its own
    // token, so no name conflicts and no attempt can compute another's names. The fence is
    // what removes a previous attempt's leftovers when it runs — here seeded as A's leftover
    // runner and service container, still existing when B starts.
    it('computes disjoint names per attempt for the same job id, and fences the previous attempt\'s leftovers by label', async () => {
        // The pure argv half: the names differ for the same job id.
        expect(containerName(attemptB)).not.toBe(containerName(attemptA));
        expect(networkName(attemptB)).not.toBe(networkName(attemptA));
        expect(serviceContainerName(attemptB, 'stub')).not.toBe(serviceContainerName(attemptA, 'stub'));

        // A's leftovers still exist on the daemon when B's run starts.
        const d = scriptedDaemon(READOUT);
        d.containers.set(containerName(attemptA), { 'factory.job': job.id, 'factory.lease': ATTEMPT_A });
        d.containers.set(serviceContainerName(attemptA, 'stub'), {
            'factory.job': job.id,
            'factory.lease': ATTEMPT_A,
            'factory.service': 'stub',
        });

        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_SERVICES: '1' }),
            fn,
            d.exec as unknown as (args: string[]) => Promise<{ stdout: string }>,
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // The fence removed both of A's leftovers by label.
        expect(d.containers.has(containerName(attemptA))).toBe(false);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(false);
        // And B's own spawn argv is B-scoped: no name A could have been holding.
        const spawnedArgv = seen[0]!;
        expect(spawnedArgv[spawnedArgv.indexOf('--name') + 1]).toBe(containerName(attemptB));
    });

    // The fence is the only job-scoped sweep, and this is its full inventory: every labeled
    // container of the job regardless of which attempt made it, every labeled network, and —
    // transitional — the legacy unlabeled network the pre-redesign name scheme left behind.
    // Anything not this job's is left alone.
    it('fences every leftover of the job by label — containers, networks, and the legacy network — and nothing else', async () => {
        const oldA = { ...job, leaseToken: 'aaaaaaaa-1111-4111-8111-111111111111' };
        const oldB = { ...job, leaseToken: 'bbbbbbbb-2222-4222-8222-222222222222' };
        const d = scriptedDaemon(READOUT);
        d.containers.set(containerName(oldA), { 'factory.job': job.id, 'factory.lease': oldA.leaseToken });
        d.containers.set(serviceContainerName(oldB, 'stub'), {
            'factory.job': job.id,
            'factory.lease': oldB.leaseToken,
            'factory.service': 'stub',
        });
        d.containers.set('someone-elses-runner', { 'factory.job': '99999999-9999-4999-8999-999999999999' });
        d.networks.set(networkName(oldA), { 'factory.job': job.id, 'factory.lease': oldA.leaseToken });
        // The legacy name: created before the token joined the name, carrying no labels at all.
        d.networks.set(`factory-job-${job.id}-services`, {});

        // The fence runs before anything is created; the readout is the first call after it,
        // so snapshotting there is snapshotting the fence's outcome.
        let afterFence: { containers: string[]; networks: string[] } | null = null;
        const exec = async (args: string[]) => {
            const answer = await d.exec(args);
            if (!afterFence && args[0] === 'run' && args.includes('--entrypoint')) {
                afterFence = { containers: [...d.containers.keys()], networks: [...d.networks.keys()] };
            }
            return answer;
        };
        const { fn } = spawnRecording('ran\n', 0);
        const runner = createDockerRunner(
            loadDriverConfig({ RUNNER_SERVICES: '1' }),
            fn,
            exec as unknown as (args: string[]) => Promise<{ stdout: string }>,
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // All four leftovers are gone; the other job's container is not this fence's business.
        expect(afterFence!.containers.sort()).toEqual(['someone-elses-runner']);
        expect(afterFence!.networks).toEqual([]);
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
        // The fence is the runner's, not the services feature's, so its label and network
        // sweeps still run — but nothing services-specific happens: no readout, no network
        // create, no service containers, byte-identical runner argv.
        expect(calls.every((a) => !(a[0] === 'network' && a[1] === 'create'))).toBe(true);
        expect(calls.every((a) => !a.includes('--network-alias'))).toBe(true);
        expect(calls.every((a) => !(a[0] === 'run' && a.includes('--entrypoint')))).toBe(true);
        expect(seen[0]).toEqual(dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }));
    });
});

describe('publishing the produced work', () => {
    const ISSUE_JOB: BoardJob = {
        ...job,
        command: '/fix https://github.com/Bellows-AI/factory/issues/10',
        repo: 'Bellows-AI/factory',
        env: { GITHUB_TOKEN: 't0k-3n' },
    };
    const NOW = new Date('2026-09-09T12:00:00Z');
    const PR_URL = 'https://github.com/Bellows-AI/factory/pull/42';

    it('plans the branch, title and issue from the command', () => {
        expect(publishPlan(ISSUE_JOB, NOW)).toEqual({
            branch: 'fix/10',
            title: '/fix https://github.com/Bellows-AI/factory/issues/10 (#10)',
            issueNumber: 10,
        });
        // No issue named: a dated task branch, no closed issue.
        const plain = publishPlan({ ...job, command: 'tidy the docs' }, NOW);
        expect(plain.branch).toBe('task/20260909');
        expect(plain.issueNumber).toBeNull();
        expect(plain.title).toBe('tidy the docs');
    });

    it('builds the checkout path from the workspace and repo label, asserting both', () => {
        expect(repoPath(loadDriverConfig({}), ISSUE_JOB)).toBe(`/workspaces/bellows/${USER}/factory`);
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, workspacePath: null })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, workspacePath: '../etc' })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, repo: 'just-a-name' })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, repo: 'o/..' })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, repo: 'o/.' })).toBeNull();
    });

    /*
     * The per-task workspace (issue #35): one `git worktree` of the job's repo, branched off the
     * remote default, per task THREAD. Keyed by the thread's ROOT job id — stable across attempts
     * of the same job, and shared by follow-ups, because a follow-up resumes the parent session
     * and a session is only coherent in the tree it ran in. The clone itself stays pristine.
     */
    const ROOT = '55555555-5555-4555-8555-555555555555';
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    it('computes the worktree path and branch from the thread root', () => {
        expect(worktreeRelDir(repoJob)).toBe(`bellows/${USER}/.worktrees/${job.id}`);
        // A follow-up is a NEW job row resuming the parent conversation: its worktree is the
        // thread's, so it lands in the tree the session (and the parent's work) lives in.
        expect(worktreeRelDir({ ...repoJob, rootJobId: ROOT })).toBe(`bellows/${USER}/.worktrees/${ROOT}`);
        expect(worktreeDir(loadDriverConfig({}), { ...repoJob, rootJobId: ROOT })).toBe(
            `/workspaces/bellows/${USER}/.worktrees/${ROOT}`,
        );
        expect(worktreeBranch({ ...repoJob, rootJobId: ROOT })).toBe(`factory/${ROOT}`);
    });

    it('refuses a worktree path it could not assert', () => {
        // The same posture repoPath pins above: every board-supplied half is asserted before it
        // joins a path, and here the value becomes the agent's working directory.
        const broken: BoardJob[] = [
            { ...repoJob, workspacePath: null },
            { ...repoJob, workspacePath: '../etc' },
            { ...repoJob, workspacePath: `bellows/not-a-uuid` },
            { ...repoJob, repo: 'just-a-name' },
            { ...repoJob, repo: 'o/..' },
            { ...repoJob, repo: 'o/.' },
            { ...repoJob, rootJobId: 'not-a-uuid' },
            { ...repoJob, rootJobId: '../../etc' },
        ];
        for (const job of broken) expect(worktreeRelDir(job), job.repo).toBeNull();
    });

    it('runs a repo job inside its worktree, and a repo-less job at the member root', () => {
        const withRepo = dockerArgs(loadDriverConfig({}), repoJob, { id: SESSION, resume: false });
        expect(withRepo).toContain(`WORKDIR=/workspaces/bellows/${USER}/.worktrees/${job.id}`);
        // A command-only job names no repo: no worktree exists, and the member root is where it
        // always started — the argv stays byte-identical to what it was.
        expect(dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false })).toContain(
            `WORKDIR=/workspaces/bellows/${USER}`,
        );
    });

    it('refuses to run a repo job whose worktree path cannot be asserted', () => {
        expect(() =>
            dockerArgs(loadDriverConfig({}), { ...repoJob, rootJobId: 'not-a-uuid' }, { id: SESSION, resume: false }),
        ).toThrow(/worktree/);
    });

    it('creates the worktree off the remote default, rebasing an existing one', () => {
        // Every git call in the script is execFileSync — no value can become a command.
        expect(gitWorktreeScript).toContain('execFileSync');
        expect(gitWorktreeScript).not.toContain('execSync(');
        // The remote is fetched with the env file's credential; nothing on a command line.
        expect(gitWorktreeScript).toContain("git('fetch', 'origin', '--prune')");
        // Stale worktree admin entries are pruned before an add, so a directory that was
        // removed underneath git can be recreated instead of failing forever.
        expect(gitWorktreeScript).toContain("git('worktree', 'prune')");
        expect(gitWorktreeScript).toContain("git('worktree', 'add', wt, branch)");
        // An existing worktree keeps its commits by rebasing onto the new default — with
        // --autostash, so a follow-up in the same tree works even when the previous run left
        // uncommitted edits: the edits are stashed for the rebase and reapplied after it.
        expect(gitWorktreeScript).toContain("inw('rebase', '--autostash', 'origin/' + def)");
        // A conflicted rebase aborts itself — the worktree must never sit mid-rebase — and the
        // failure names what happened.
        expect(gitWorktreeScript).toContain("inw('rebase', '--abort')");
        expect(gitWorktreeScript).toContain('rebased onto');
        // A path that holds a git tree this sync did not create is refused, never deleted.
        expect(gitWorktreeScript).toContain("fs.existsSync(wt + '/.git')");
    });

    it('hands the sync the clone, the worktree and the branch, by env', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: '{"ok":true,"reason":null}' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            exec,
        );
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const run = calls.find((a) => a[0] === 'run')!;
        // The clone — where origin lives and the worktree is created FROM. Paths, not
        // credentials: the claim env rides the env file exactly as before.
        expect(run).toEqual(expect.arrayContaining(['-e', `REPO=/workspaces/bellows/${USER}/factory`]));
        expect(run).toEqual(expect.arrayContaining(['-e', `WORKTREE=/workspaces/bellows/${USER}/.worktrees/${job.id}`]));
        expect(run).toEqual(expect.arrayContaining(['-e', `BRANCH=factory/${job.id}`]));
    });

    // git reads no token from the environment, and the executor images ship no credential
    // helper — so a private-repo fetch needs the same token-backed helper the push uses. It
    // rides CONDITIONALLY: only when the claim env actually carries GITHUB_TOKEN, because a
    // public repo must keep its plain unauthenticated fetch (a helper answering an empty
    // password would break it). The VALUE passed is helper CODE, never the credential — the
    // token itself travels only in the env file, where the helper reads it.
    it('hands the sync the credential-helper code only when the claim env carries GITHUB_TOKEN', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: '{"ok":true,"reason":null}' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            exec,
        );

        await runner.syncCheckout({ ...repoJob, env: { GITHUB_TOKEN: 't0k-3n' } });
        const run = calls.find((a) => a[0] === 'run')!;
        expect(run).toEqual(expect.arrayContaining(['-e', `CRED_HELPER=${CREDENTIAL_HELPER}`]));
        // The token itself rides the env file, never argv.
        expect(run.some((arg) => arg.includes('t0k-3n'))).toBe(false);

        // Any other claim env — even a non-empty one — keeps the plain fetch, no helper.
        await runner.syncCheckout({ ...repoJob, env: { CORE_TOKEN: 'shh' } });
        const plain = calls.filter((a) => a[0] === 'run')[1]!;
        expect(plain.some((arg) => arg.startsWith('CRED_HELPER='))).toBe(false);

        // A PRESENT-BUT-EMPTY token is no token: the helper would answer an empty password and
        // break the public-repo plain fetch it exists to preserve — and a private repo with an
        // empty token fails auth either way. Property presence is not the test; the VALUE is.
        await runner.syncCheckout({ ...repoJob, env: { GITHUB_TOKEN: '' } });
        const empty = calls.filter((a) => a[0] === 'run')[2]!;
        expect(empty.some((arg) => arg.startsWith('CRED_HELPER='))).toBe(false);
    });

    /* The terminal reclaim (issue #47): the same one-container shape as the sync it undoes,
     * but naming only the clone and the tree — no BRANCH, no credential helper, no env file. */
    it('reclaims the worktree in a throwaway container, naming only paths', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'run') return { stdout: '{"ok":true,"removed":true,"reason":null}' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            exec,
        );
        const result = await runner.reclaimWorktree(repoJob);

        expect(result).toEqual({ ok: true, removed: true, reason: null });
        const run = calls.find((a) => a[0] === 'run')!;
        expect(run).toEqual(expect.arrayContaining(['-e', `REPO=/workspaces/bellows/${USER}/factory`]));
        expect(run).toEqual(expect.arrayContaining(['-e', `WORKTREE=/workspaces/bellows/${USER}/.worktrees/${job.id}`]));
        expect(run).toEqual(expect.arrayContaining(['--entrypoint', 'node', 'claude-executor', '-e', gitWorktreeRemoveScript]));
        // Reclaim touches no credential and no branch: the thread is terminal, so there is no
        // fetch to authenticate and no follow-up branch to preserve.
        expect(run.some((arg) => arg.startsWith('BRANCH='))).toBe(false);
        expect(run.some((arg) => arg.startsWith('CRED_HELPER='))).toBe(false);
        expect(run.some((arg) => arg.startsWith('--env-file'))).toBe(false);
    });

    it('reclaims nothing, run untouched, for a job that never had a worktree', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            exec,
        );
        expect(await runner.reclaimWorktree(job)).toEqual({ ok: true, removed: false, reason: null });
        expect(calls).toHaveLength(0);
    });

    it('answers the refusal verbatim when the reclaim script refuses', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run') return { stdout: '{"ok":false,"removed":false,"reason":"refusing to remove /x: a git tree that is not a registered worktree"}' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            exec,
        );
        const result = await runner.reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('registered worktree');
    });

    /*
     * A minimal stateful daemon for the sync's fence: containers and networks live in maps,
     * `ps` and `network ls` honor their `--filter label=` pairs, and rm removes what it names.
     * The sync container itself answers the script's success verdict. `fail`, when given, turns
     * the matching call into an execFile-shaped rejection — stderr on the error, the way the
     * promisified execFile carries a daemon refusal — so a test can script the daemon saying no.
     */
    const fenceDaemon = (fail?: (args: string[]) => string | null) => {
        const containers = new Map<string, Record<string, string>>();
        const networks = new Map<string, Record<string, string>>();
        const calls: string[][] = [];
        const matches = (args: string[], labels: Record<string, string>): boolean => {
            for (let i = 0; i < args.length; i += 1) {
                if (args[i] === '--filter' && (args[i + 1] ?? '').startsWith('label=')) {
                    const [key, value] = (args[i + 1] ?? '').slice('label='.length).split('=');
                    if (labels[key] !== value) return false;
                }
            }
            return true;
        };
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            const refused = fail?.(args);
            if (refused) {
                throw Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), { stderr: refused });
            }
            if (args[0] === 'run' && args.includes('--entrypoint')) {
                return { stdout: '{"ok":true,"reason":null}' };
            }
            if (args[0] === 'ps') {
                return {
                    stdout: [...containers.entries()]
                        .filter(([, labels]) => matches(args, labels))
                        .map(([id]) => id)
                        .join('\n'),
                };
            }
            if (args[0] === 'rm') {
                for (const id of args.slice(1)) containers.delete(id);
                return { stdout: '' };
            }
            if (args[0] === 'network' && args[1] === 'ls') {
                return {
                    stdout: [...networks.entries()]
                        .filter(([, labels]) => matches(args, labels))
                        .map(([name]) => name)
                        .join('\n'),
                };
            }
            if (args[0] === 'network' && args[1] === 'rm') {
                for (const name of args.slice(2)) networks.delete(name);
                return { stdout: '' };
            }
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        return { containers, networks, calls, exec };
    };

    // The fence before the sync (PR #46 review): the loop calls syncCheckout before the
    // runner's own fence, so the sweep has to come here — the sync is the first writer on the
    // task worktree, and starting it over a previous attempt's live runner would mix edits.
    it('sweeps the job label before the sync container is created', async () => {
        const d = fenceDaemon();
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            d.exec,
        );
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const shapes = d.calls.map((a) => a[0]);
        expect(shapes).toContain('ps');
        expect(shapes.indexOf('ps')).toBeLessThan(shapes.indexOf('run'));
    });

    // The replacement-with-an-active-previous-runner shape of the review comment: the old
    // attempt's runner is still on the daemon when the replacement's sync starts, and the
    // fence's removal must land BEFORE the sync container runs — not after it.
    it('removes a previous attempt’s still-running runner before the sync runs', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const NEW_TOKEN = 'bbbbbbbb-2222-4222-8222-222222222222';
        const d = fenceDaemon();
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            d.exec,
        );
        const result = await runner.syncCheckout({ ...repoJob, leaseToken: NEW_TOKEN });

        expect(result).toEqual({ ok: true, reason: null });
        // The previous runner is off the daemon by the time the sync container is created.
        expect(d.containers.size).toBe(0);
        const rmIndex = d.calls.findIndex((a) => a[0] === 'rm');
        const runIndex = d.calls.findIndex((a) => a[0] === 'run');
        expect(rmIndex).toBeGreaterThanOrEqual(0);
        expect(rmIndex).toBeLessThan(runIndex);
    });

    // A fence that converts a failed `docker ps` into an empty answer reads "nothing left" —
    // and the sync would start while a previous attempt's runner is still writing the worktree.
    // The fence is infrastructure, not the command's verdict: it must throw, and the loop's
    // try/catch around syncCheckout leaves the job to its lease.
    it('fails the sync when the fence cannot list the job’s leftover containers', async () => {
        const d = fenceDaemon((args) =>
            args[0] === 'ps' ? 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' : null,
        );
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            d.exec,
        );

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/re-claim fence/);
        // No sync container over an unfenced checkout: the throw precedes the run argv entirely.
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });

    it('fails the sync when the fence cannot list the job’s stale networks', async () => {
        const d = fenceDaemon((args) =>
            args[0] === 'network' && args[1] === 'ls' ? 'Cannot connect to the Docker daemon' : null,
        );
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            d.exec,
        );

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/re-claim fence/);
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });

    it('fails the sync when a leftover container refuses to be removed', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = fenceDaemon((args) => (args[0] === 'rm' ? 'Error: cannot remove container: device is busy' : null));
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            d.exec,
        );

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/re-claim fence/);
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });

    it('fails the sync when a leftover network refuses to be removed', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = fenceDaemon((args) =>
            args[0] === 'network' && args[1] === 'rm' ? 'Error: cannot remove network: in use' : null,
        );
        d.networks.set(networkName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            d.exec,
        );

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/re-claim fence/);
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });

    // The one tolerated shape: a container exiting between the fence's ps and its rm answers
    // "No such container" — the fence SUCCEEDED, the runner is gone. Failing there would burn
    // attempts on the daemon confirming a removal already finished.
    it('proceeds when the fence’s rm answers that the container is already gone', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = fenceDaemon((args) =>
            args[0] === 'rm'
                ? `Error response from daemon: No such container: ${containerName({ ...job, leaseToken: OLD_TOKEN })}`
                : null,
        );
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const runner = createDockerRunner(
            loadDriverConfig({}),
            (() => fakeChild('', '', 0)) as unknown as typeof spawn,
            d.exec,
        );

        expect(await runner.syncCheckout(repoJob)).toEqual({ ok: true, reason: null });
        expect(d.calls.some((a) => a[0] === 'run')).toBe(true);
    });

    it('runs every publish step inside the task worktree', async () => {
        const { calls, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.publishGit(ISSUE_JOB);

        const wt = `/workspaces/bellows/${USER}/.worktrees/${job.id}`;
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            if (call.some((x) => typeof x === 'string' && x.includes('execFileSync'))) {
                expect(call).toEqual(expect.arrayContaining(['-e', `REPO=${wt}`]));
            } else if (call.includes('-w')) {
                expect(call[call.indexOf('-w') + 1]).toBe(wt);
            }
        }
    });

    it('refuses branch names that could read as something else', () => {
        expect(isBranchName('fix/10')).toBe(true);
        expect(isBranchName('task/20260909')).toBe(true);
        expect(isBranchName('')).toBe(false);
        expect(isBranchName('../etc')).toBe(false);
        expect(isBranchName('-oProxyCommand')).toBe(false);
        expect(isBranchName('a b')).toBe(false);
    });

    it('probes without a shell and reads the credential from the environment, never argv', () => {
        // Every git call in the probe is execFileSync — no value can become a command.
        expect(gitProbeScript).toContain('execFileSync');
        expect(gitProbeScript).not.toContain('execSync(');
        // "Unpushed" is counted against the remote default branch, never `@{u}`: a branch that
        // was never pushed has no upstream, and the fatal rev-list would read its local-only
        // commits as fully landed — which once reported a two-commit task branch as "nothing to
        // publish".
        expect(gitProbeScript).toContain("'origin/' + out.defaultBranch + '..HEAD'");
        expect(gitProbeScript).not.toContain('@{u}');
        // The helper reads the token from the container's environment — the env file's job —
        // and the literal appears in no argv the publisher builds.
        expect(CREDENTIAL_HELPER).toContain('$GITHUB_TOKEN');
    });

    it('parses the probe’s answer, defaulting anything missing', () => {
        expect(parseGitState('{"cloned":true,"branch":"fix/10","defaultBranch":"main","dirty":true,"unpushed":2,"hasIdentity":false}')).toEqual({
            cloned: true,
            branch: 'fix/10',
            defaultBranch: 'main',
            dirty: true,
            unpushed: 2,
            hasIdentity: false,
        });
        expect(parseGitState('')).toEqual({
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
        });
    });

    /**
     * A stateful daemon: the probe answers from `state`, git steps mutate nothing, and every
     * call is recorded so the flow — what ran, in which order, and what was skipped — is the
     * assertion. The runner's own `docker run` never happens; only publish argv reaches the
     * exec seam here.
     */
    const publishRunner = (state: Record<string, unknown>, opts: { prExists?: boolean; fail?: (args: string[]) => boolean } = {}) => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            // The probe's marker rides INSIDE the -e script string; the git steps carry their
            // subcommand as a standalone argv element.
            if (args.some((a) => typeof a === 'string' && a.includes('execFileSync'))) {
                return { stdout: JSON.stringify(state) };
            }
            if (opts.fail?.(args)) throw new Error('step refused');
            if (args.includes('pr') && args.includes('view')) {
                if (opts.prExists) return { stdout: `${PR_URL}\n` };
                throw new Error('no pull requests');
            }
            if (args.includes('pr') && args.includes('create')) return { stdout: `${PR_URL}\n` };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = createDockerRunner(loadDriverConfig({ RUNNER_CLI: 'opencode' }), (() => fakeChild('')) as unknown as typeof spawn, exec);
        return { calls, runner };
    };

    const DIRTY_ON_MAIN = {
        cloned: true,
        branch: 'main',
        defaultBranch: 'main',
        dirty: true,
        unpushed: 0,
        hasIdentity: false,
    };

    it('branches, commits, pushes and opens the PR — in that order', async () => {
        // The checkout sits on main with no fix branch yet: the plain switch refuses (no such
        // branch), and `-c` creates it — both calls are part of the expected shape.
        const { calls, runner } = publishRunner(DIRTY_ON_MAIN, { fail: (a) => a.includes('switch') && !a.includes('-c') });
        const result = await runner.publishGit(ISSUE_JOB);

        expect(result).toEqual({ ok: true, published: true, branch: 'fix/10', prUrl: PR_URL, reason: null });
        const shapes = calls.map((a) => {
            if (a.some((x) => typeof x === 'string' && x.includes('execFileSync'))) return 'probe';
            if (a.includes('switch')) return 'switch';
            if (a.includes('add')) return 'add';
            if (a.includes('commit')) return 'commit';
            if (a.includes('push')) return 'push';
            if (a.includes('view')) return 'pr-view';
            if (a.includes('create')) return 'pr-create';
            return 'other';
        });
        expect(shapes).toEqual(['probe', 'switch', 'switch', 'add', 'commit', 'push', 'pr-view', 'pr-create']);
        // The first switch finds no branch; the second creates it. Commits carry the plan title,
        // and the fallback identity rides only the commit.
        const switchCreate = calls.find((a) => a.includes('switch') && a.includes('-c'));
        expect(switchCreate).toContain('fix/10');
        const commit = calls.find((a) => a.includes('commit'));
        expect(commit).toContain('-m');
        expect(commit).toContain('/fix https://github.com/Bellows-AI/factory/issues/10 (#10)');
        expect(commit).toContain('user.name=factory-ai');
        // Push and PR steps carry the env file; the credential helper reads the token from it.
        // The push is force-with-lease: the startup sync may have rewritten the task branch's
        // base, and the lease refuses to clobber a remote that moved under us.
        const push = calls.find((a) => a.includes('push'));
        expect(push).toContain('--env-file');
        expect(push).toContain('--force-with-lease');
        expect(push.join(' ')).toContain('credential.helper=');
        expect(push.join(' ')).not.toContain('t0k-3n');
        const create = calls.find((a) => a.includes('pr') && a.includes('create'));
        expect(create).toContain('--head');
        expect(create).toContain('fix/10');
    });

    it('reuses an existing task branch and an existing PR', async () => {
        const { calls, runner } = publishRunner(
            { ...DIRTY_ON_MAIN, branch: 'fix/10', hasIdentity: true, unpushed: 1, dirty: false },
            { prExists: true },
        );
        const result = await runner.publishGit(ISSUE_JOB);

        expect(result).toEqual({ ok: true, published: true, branch: 'fix/10', prUrl: PR_URL, reason: null });
        const shapes = calls.map((a) => {
            if (a.some((x) => typeof x === 'string' && x.includes('execFileSync'))) return 'probe';
            if (a.includes('switch')) return 'switch';
            if (a.includes('add')) return 'add';
            if (a.includes('commit')) return 'commit';
            if (a.includes('push')) return 'push';
            if (a.includes('view')) return 'pr-view';
            if (a.includes('create')) return 'pr-create';
            return 'other';
        });
        // On a task branch already: no switch, no commit (clean tree), push of the unpushed
        // commit, PR found and reused.
        expect(shapes).toEqual(['probe', 'push', 'pr-view']);
    });

    it('answers the ordinary no-ops without touching the daemon further', async () => {
        const clean = publishRunner({ ...DIRTY_ON_MAIN, dirty: false, unpushed: 0 });
        expect(await clean.runner.publishGit(ISSUE_JOB)).toEqual({
            ok: true,
            published: false,
            branch: null,
            prUrl: null,
            reason: 'no uncommitted changes and nothing unpushed',
        });
        expect(clean.calls).toHaveLength(1);

        const uncloned = publishRunner({ cloned: false });
        expect(await uncloned.runner.publishGit(ISSUE_JOB)).toEqual({
            ok: true,
            published: false,
            branch: null,
            prUrl: null,
            reason: 'the checkout has not been cloned yet',
        });
        expect(uncloned.calls).toHaveLength(1);
    });

    // EVERY container this feature starts is a full `docker run` — the sync and the publisher
    // once built argv without the subcommand, and `docker -v ... -w ...` failed on every job
    // while the flow tests (matching argv by shape, not by head) stayed green. Pinned at the
    // head, where the omission actually lives.
    it('starts every sync and publish container with `docker run --rm`', async () => {
        const { calls, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.publishGit(ISSUE_JOB);

        expect(calls.length).toBeGreaterThan(0);
        for (const args of calls) {
            expect(args[0]).toBe('run');
            expect(args).toContain('--rm');
        }
        // And the sync, which takes no part in the publish flow above. The re-claim fence now
        // precedes the sync container (ps / network reads and removals — argv-only, no
        // container among them), so the pin counts CONTAINER starts: one, a full
        // `docker run --rm`.
        const { calls: syncCalls, runner: syncRunner } = publishRunner(DIRTY_ON_MAIN);
        await syncRunner.syncCheckout(ISSUE_JOB);
        const syncContainers = syncCalls.filter((a) => a[0] === 'run');
        expect(syncContainers).toHaveLength(1);
        expect(syncContainers[0]).toContain('--rm');
    });

    it('fails with the step’s reason when a git step refuses', async () => {
        const { runner } = publishRunner(DIRTY_ON_MAIN, { fail: (a) => a.includes('push') });
        const result = await runner.publishGit(ISSUE_JOB);

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('step refused');
    });
});
