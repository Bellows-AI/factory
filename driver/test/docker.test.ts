import { afterEach, describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import {
    containerName,
    dockerArgs,
    envFilePath,
    gateEnvArgs,
    gateEnvContainerName,
    gateExecArgs,
    opencodeSessionReadoutArgs,
    parseDockerServicePs,
    parseDockerStats,
} from '../src/docker.js';
import { claimEnv, envFileBody, transcriptDir } from '../src/claim.js';
import {
    currentActivity,
    reportTail,
    type RunOutcome,
    type RunSession,
    stripAnsi,
    tailBytes,
    tailKept,
} from '../src/runner.js';
import { claudeTurnsArgs, opencodeCacheProbeArgs } from '../src/docker-close-read.js';
import {
    CACHE_WATCH_TURNS,
    cacheCollapse,
    parseClaudeCloseRead,
    parseOpencodeCacheProbe,
    parseOpencodeRunOutcome,
    parseTranscriptRead,
    readsAgentTurns,
} from '../src/close-read.js';
import { ARTIFACT_LIMIT, commandMark, OPENCODE_EXPORT_LIMIT, SERVICE_LOG_TAIL_LINES } from '../src/runner.js';
import { claudeTurnsScript, opencodeReadoutScript } from '../src/container-scripts.js';
import { createDockerRunner } from '../src/docker-runner.js';
import { exporterCreateArgs, supervisorCreateArgs, supervisorName } from '../src/docker-group.js';
import { HELPER_TIMEOUT_MS, lookupHelper, type HelperPlan } from '../src/helpers.js';
import {
    forgetDeclaredServices,
    networkName,
    type ServiceSpec,
    serviceContainerName,
    serviceRunArgs,
} from '../src/services.js';
import { type RunnerFiles, startJobServices } from '../src/docker-runner-support.js';
import type { StepSink, SupervisorEndpoint } from '../src/step-control.js';
import {
    SUPERVISOR_ENV,
    SUPERVISOR_EXIT,
    type StepKind,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../src/supervisor-contract.js';
import { ServicesNotRunning } from '../src/service-restart.js';
import { telemetryConfig, telemetryConfigTar } from '../src/telemetry-config.js';
import {
    CREDENTIAL_HELPER,
    gitProbeScript,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    isBranchName,
    parseGitState,
    parsePrSummary,
    publishPlan,
    repoPath,
    SYNC_DEADLINE_MS,
    TRANSIENT_SYNC_REASON,
    worktreeBranch,
    worktreeDir,
    worktreeRelDir,
} from '../src/publish.js';

const USER = '44444444-4444-4444-8444-444444444444';
const CONTROL_TOKEN = 'supervisor-control-token';

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: MASTER_PROMPT,
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: CONTROL_TOKEN },
};

const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const FINALIZED: SupervisorReport = { outcome: null, cause: null, agentExit: 0, agentEnd: 'exited', drained: true };

/**
 * The supervised-step channel stood in: every step is recorded (with the token it was submitted
 * under) and answered by `answer` — default exit 0, empty — and the supervisor's report is
 * `reported` at once, as a finalized run's would be.
 */
function fakeSteps(
    answer: (step: StepRequest) => StepResult | Promise<StepResult> = () => ok(),
    reported: SupervisorReport | Promise<SupervisorReport> = FINALIZED
) {
    const submitted: { token: string; step: StepRequest }[] = [];
    const sink: StepSink = {
        submit: async (token, step) => {
            submitted.push({ token, step });
            return answer(step);
        },
        awaitReport: () => Promise.resolve(reported),
        contacted: () => true,
    };
    const ofKind = (kind: StepKind) => submitted.filter((entry) => entry.step.kind === kind).map((entry) => entry.step);
    return { sink, submitted, steps: () => submitted.map((entry) => entry.step), ofKind };
}

/** A supervisor that answers every step with the sync's `stdout` — by default, a clean sync. */
const syncSteps = (stdout = '{"ok":true,"reason":null}') => fakeSteps(() => ok(stdout));

/** A daemon that answers every verb with nothing. */
const emptyDaemon = (async () => ({ stdout: '' })) as unknown as (args: string[]) => Promise<{ stdout: string }>;

const RECLAIM_TOKEN = 'reclaim-control-token';

/** The endpoint a supervisor-only group is served on, recording the tokens it closed. */
function reclaimEndpoint() {
    const closed: string[] = [];
    const endpoint: SupervisorEndpoint = {
        open: async () => ({ url: 'http://driver:8130', token: RECLAIM_TOKEN }),
        close: (token) => {
            closed.push(token);
        },
    };
    return { endpoint, closed };
}

/** A runner whose reclaim step prints `stdout`, over a group served by {@link reclaimEndpoint}. */
function reclaimRunner(stdout: string) {
    const supervised = fakeSteps((step) => ok(step.kind === 'reclaim' ? stdout : ''));
    const { endpoint, closed } = reclaimEndpoint();
    return { supervised, closed, runner: dockerRunner(emptyDaemon, { steps: supervised.sink, endpoint }) };
}

const SESSION = '33333333-3333-4333-8333-333333333333';
const PR_URL = 'https://github.com/Bellows-AI/factory/pull/42';
const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };

/** One `docker ps --format '{{json .}}'` line for a service container, the fields the parse reads. */
const psLine = (service: { name: string; image: string; state: string }): string =>
    `${JSON.stringify({
        Command: '"sleep"',
        CreatedAt: '2026-09-14T10:00:00.000Z',
        ID: `id-${service.name}`,
        Image: service.image,
        Labels: `factory.job=${job.id},factory.lease=${job.leaseToken},factory.service=${service.name}`,
        Names: `factory-job-${job.id}-${job.leaseToken}-svc-${service.name}`,
        State: service.state,
        Status: `${service.state} (a minute ago)`,
    })}\n`;

const args = (
    env: NodeJS.ProcessEnv = {},
    session: RunSession | null = { id: SESSION, resume: false },
    servicesNetwork: string | null = null
) => dockerArgs(loadDriverConfig(env), job, session, { servicesNetwork: servicesNetwork, envFile: '/tmp/env-file' });

describe('the docker run arguments', () => {
    // The plan itself is pinned in runner-plan.test.ts; this is docker's rendering of it: every
    // env pair as `-e NAME=value` BEFORE the image — docker stops option parsing there, and an
    // `-e` past it would be the CLI's argv — and the CLI args verbatim after it.
    it('renders the runner plan: env pairs as -e before the image, the CLI args after it', () => {
        const envBeforeImage = (line: string[], image: string, pairs: string[]) => {
            for (const pair of pairs) {
                expect(line[line.indexOf(pair) - 1]).toBe('-e');
                expect(line.indexOf(pair)).toBeLessThan(line.indexOf(image));
            }
        };
        const claude = args();
        expect(claude.slice(-9)).toEqual([
            'claude-executor',
            '--session-id',
            SESSION,
            '--append-system-prompt',
            MASTER_PROMPT,
            '--system-prompt-snapshot',
            'off',
            '-p',
            'fix the failing build',
        ]);
        envBeforeImage(claude, 'claude-executor', [
            `FACTORY_TRANSCRIPT_DIR=/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            `BELLOWS_SESSION_ID=${SESSION}`,
            'NPM_CONFIG_UPDATE_NOTIFIER=false',
        ]);
        const opencode = dockerArgs(
            loadDriverConfig({}),
            { ...opencodeJob, followUp: true },
            { id: 'ses_f86188c3dffeZGYO4yZq4atba9', resume: true },
            { envFile: '/tmp/env-file' }
        );
        expect(opencode.slice(-7)).toEqual([
            'opencode-executor',
            'run',
            '--agent',
            'factory',
            '--session',
            'ses_f86188c3dffeZGYO4yZq4atba9',
            'fix the failing build',
        ]);
        envBeforeImage(opencode, 'opencode-executor', [
            `XDG_DATA_HOME=/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}`,
            'NPM_CONFIG_UPDATE_NOTIFIER=false',
            'BELLOWS_SESSION_ID=ses_f86188c3dffeZGYO4yZq4atba9',
        ]);
    });

    it("mounts the checkouts volume and starts at the AUTHOR's workspace root", () => {
        // Was `/workspaces/<orgId>`, built from the driver's own ORG_ID — one tree every member's
        // agent shared. The board sends the path now, because it owns the layout; this process
        // only knows where the volume is mounted.
        //
        // The mount is scoped with volume-subpath to the job's own `<orgId>/<userId>` subtree:
        // the container's volume root is the member's tree, enforced by the mount itself, not by
        // where the WORKDIR happens to point.
        expect(args()).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
                `WORKDIR=/workspaces/bellows/${USER}`,
            ])
        );
    });

    it('refuses a workspace path that is not <org>/<uuid>', () => {
        /*
         * The board is not something this process trusts with a fragment of a command line — the
         * same rule every board-supplied id is held to, and the stakes are higher here:
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
                String(path)
            ).toThrow(/no usable workspace path/);
        }
    });

    it('adds no resource flags when none are configured — the dev daemon stays unthrottled', () => {
        expect(args()).not.toContain('--cpus');
        expect(args()).not.toContain('--memory');
        expect(args()).not.toContain('--memory-reservation');
        expect(args()).not.toContain('--cpu-shares');
    });

    // Stated limit, not an oversight: docker has no absolute CPU floor — `--cpu-shares` is a
    // relative weight, not a kubernetes request — and capping a dev runner at its request via
    // `--cpus` would throttle builds the kubernetes side leaves free.
    it('renders no cpu request flag — docker has no absolute CPU floor for a kubernetes request', () => {
        const requested = args({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' });
        expect(requested).not.toContain('--cpus');
        expect(requested).not.toContain('--cpu-shares');
        expect(requested).toEqual(expect.arrayContaining(['--memory-reservation', '1073741824']));
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
            ])
        );
    });

    it('joins a network only when one is configured', () => {
        expect(args()).not.toContain('--network');
        expect(args({ RUNNER_NETWORK: 'factory-ai_default' })).toEqual(
            expect.arrayContaining(['--network', 'factory-ai_default'])
        );
    });

    // servicesNetwork is null whenever the job declared no services — and then the argv is
    // byte-identical to what the pins above and below expect, which is the compatibility promise
    // the whole feature makes: no .bellows.yaml, no difference.
    it('joins the per-job services network only when one is given', () => {
        expect(args()).not.toContain(networkName(job));
        expect(args({}, { id: SESSION, resume: false }, networkName(job))).toEqual(
            expect.arrayContaining(['--network', networkName(job)])
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
        expect(args()).toEqual(expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']));
        expect(args({ RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' })).toEqual(
            expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://telemetry.internal:4318'])
        );
    });

    // The branch reporter posts to the board's API, and the endpoint rides beside the OTEL one:
    // a URL, not a credential, defaulted from JOB_BOARD_URL.
    it('points the runner at the board so it can report its branch', () => {
        expect(args()).toEqual(expect.arrayContaining(['-e', 'FACTORY_STATS_URL=http://127.0.0.1:8080']));
        expect(args({ RUNNER_STATS_URL: 'http://stats.internal:8080' })).toEqual(
            expect.arrayContaining(['-e', 'FACTORY_STATS_URL=http://stats.internal:8080'])
        );
    });

    // A default only: a member who wants the notice back names it in claim env, and the driver's
    // `-e` — which would beat the env file — is not there to override it.
    it('leaves the npm notice to a claim that names it', () => {
        const envJob: BoardJob = { ...job, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        const line = dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false }, { envFile: '/tmp/e' });
        expect(line.some((arg) => arg.startsWith('NPM_CONFIG_UPDATE_NOTIFIER'))).toBe(false);
        expect(envFileBody(envJob, loadDriverConfig({}))).toContain('NPM_CONFIG_UPDATE_NOTIFIER=true\n');
    });

    // --rm is gone deliberately: cleanup is explicit (a `docker rm` after close), so the runner
    // can ask the daemon whether a 125 run left a container behind before removing it.
    it('leaves nothing behind, by explicit cleanup rather than --rm', () => {
        expect(args()).not.toContain('--rm');
    });

    // Both halves are board-supplied and become one filesystem path inside a container that runs
    // the agent — asserted exactly like runWorkingDir's halves, with the root id getting the same
    // uuid assertion envFilePath applies to job.id.
    describe('transcriptDir', () => {
        const ROOT = '55555555-5555-4555-8555-555555555555';

        it('composes the per-thread-root store from the claim fields', () => {
            expect(transcriptDir(loadDriverConfig({}), job)).toBe(
                `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`
            );
            // A follow-up is a NEW job row resuming the parent conversation: its store is the
            // thread's, keyed by the same root the worktree is keyed by.
            expect(transcriptDir(loadDriverConfig({}), { ...job, rootJobId: ROOT })).toBe(
                `/workspaces/bellows/${USER}/.factory/transcripts/${ROOT}`
            );
        });

        it('refuses a null workspace and a non-uuid thread root', () => {
            expect(() => transcriptDir(loadDriverConfig({}), { ...job, workspacePath: null })).toThrow(
                /no usable workspace path/
            );
            expect(() => transcriptDir(loadDriverConfig({}), { ...job, rootJobId: '../../etc' })).toThrow(/not a uuid/);
        });
    });
});

describe("the board's environment", () => {
    const envJob: BoardJob = {
        ...job,
        env: { MY_TOKEN: 'board-secret', WORKDIR: '/etc' },
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
        const line = dockerArgs(
            loadDriverConfig({}),
            envJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
        expect(line).not.toContain('MY_TOKEN');
        expect(line.some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    it('gives the claim precedence over the driver’s own forwarded names', () => {
        // docker gives `-e` precedence over `--env-file`, so a name the claim also carries must
        // not go out as `-e` — otherwise the driver's own value would silently win.
        const configured = loadDriverConfig({ RUNNER_ENV: 'MY_TOKEN,OTHER' });
        const line = dockerArgs(configured, envJob, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' });
        expect(line).toEqual(expect.arrayContaining(['-e', 'OTHER']));
        expect(line).not.toContain('MY_TOKEN');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    // Issue #244: the collision check must read the SAME env the file is actually written from
    // (`runnerClaimEnv`), or an operator who names OPENCODE_CONFIG_CONTENT in RUNNER_ENV could
    // have `-e` (driver-process value, almost always unset) win over the reserved-agent merge —
    // docker gives `-e` precedence over `--env-file`.
    it('never forwards OPENCODE_CONFIG_CONTENT as -e for an opencode job — the merged value must win', () => {
        const configured = loadDriverConfig({ RUNNER_ENV: 'OPENCODE_CONFIG_CONTENT' });
        const line = dockerArgs(configured, opencodeJob, null, { envFile: '/tmp/env-file' });
        expect(line).not.toEqual(expect.arrayContaining(['-e', 'OPENCODE_CONFIG_CONTENT']));
    });

    it('still forwards OPENCODE_CONFIG_CONTENT as -e for a claude-code job with no claim env', () => {
        // Pins that runnerClaimEnv passes non-opencode claims through unchanged: this name is
        // ordinary for any other executor, and the collision rule must still apply to it.
        const configured = loadDriverConfig({ RUNNER_ENV: 'OPENCODE_CONFIG_CONTENT' });
        const line = dockerArgs(configured, job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' });
        expect(line).toEqual(expect.arrayContaining(['-e', 'OPENCODE_CONFIG_CONTENT']));
    });

    it('refuses to run a claim that carries env with no env file to put it in', () => {
        // A silent drop would run the job without the credentials it was queued against.
        expect(() => dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false })).toThrow(/no env file/);
    });

    // The runner's branch-ingest credential is the attempt's job id + lease token pair: it rides
    // the 0600 env file as the last lines (docker's --env-file is last-duplicate-wins, so the
    // order is the precedence rule), and never appears on an argv any `ps` on the host can read.
    // The deployment-wide ingest token used to ride here too — it authorized nothing the runner
    // does any more once branch ingest moved to the pair, so it is gone.
    it('carries the attempt pair in the env file, last, and never on the argv', () => {
        expect(envFileBody(envJob, loadDriverConfig({}))).toBe(
            'MY_TOKEN=board-secret\nRUNNER_JOB_ID=11111111-1111-4111-8111-111111111111\nRUNNER_LEASE_TOKEN=22222222-2222-4222-8222-222222222222\n'
        );
        const line = dockerArgs(
            loadDriverConfig({}),
            envJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
        expect(line.some((arg) => arg.includes('RUNNER_LEASE_TOKEN'))).toBe(false);
    });

    // The pair rides every runner, claim env or not — it is the credential its attribution
    // reports authenticate with, so a runner without the file would be silently unauthenticated.
    // dockerArgs refuses to build that argv.
    it('always needs the env file: the pair rides it even for a claim with no env', () => {
        expect(() => dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false })).toThrow(/no env file/);
        const line = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    // The reporter's env names are the runner's own contract, like WORKDIR: a member value in
    // one of them steers where the report goes, what authenticates it, and which session it
    // claims — a cross-tenant write into the telemetry store.
    it('refuses the reporter env names from a claim', () => {
        expect(
            claimEnv({
                ...job,
                env: {
                    FACTORY_STATS_URL: 'http://evil',
                    RUNNER_JOB_ID: 'spoof',
                    RUNNER_LEASE_TOKEN: 'spoof',
                    BELLOWS_SESSION_ID: 'spoof',
                },
            })
        ).toEqual({});
    });

    // A Jira credential is a managed connection the board spends (docs/connections.md): even a
    // stale or hand-planted claim value never reaches the runner's env file, so a runner holds the
    // attempt pair and nothing that authenticates to Atlassian. Pinned beside the k8s Secret case.
    it('never writes a Jira credential to the env file, only the attempt pair', () => {
        const withJira: BoardJob = {
            ...envJob,
            env: {
                MY_TOKEN: 'board-secret',
                ATLASSIAN_SITE: 'https://example.atlassian.net',
                ATLASSIAN_EMAIL: 'agent@example.com',
                ATLASSIAN_API_TOKEN: 'atlassian-secret',
            },
        };
        const body = envFileBody(withJira, loadDriverConfig({}));
        expect(body).not.toContain('ATLASSIAN');
        expect(body).not.toContain('atlassian-secret');
        expect(body).toContain('RUNNER_LEASE_TOKEN=');
    });

    it('writes one NAME=value line per variable, reserved names dropped', () => {
        expect(envFileBody(envJob)).toBe('MY_TOKEN=board-secret\n');
        expect(envFileBody(job)).toBe('');
        // A value with a newline would corrupt the file's line structure — refused, not mangled.
        expect(() => envFileBody({ ...job, env: { BROKEN: 'line1\nline2' } })).toThrow(/newline/);
    });

    // The refusal must name WHICH half carries the newline: blaming the name for the value's
    // offence sends a reader hunting through the env scopes for a variable that is fine.
    it('names the newline offender, the name or the value', () => {
        expect(() => envFileBody({ ...job, env: { BROKEN: 'line1\nline2' } })).toThrow(
            /the value of "BROKEN" contains a newline/
        );
        expect(() => envFileBody({ ...job, env: { 'BRO\nKEN': 'fine' } })).toThrow(
            /the name of "BRO\nKEN" contains a newline/
        );
        // The gate lines are checked by the same rule.
        expect(() => envFileBody({ ...job, gateEnv: { BELLOWS_GATE_TOKEN: 'tok\ntok' } })).toThrow(
            /the value of "BELLOWS_GATE_TOKEN" contains a newline/
        );
    });

    // Issue #442: the run-control channel the loop mints per attempt rides the env file, after the
    // claim lines — and a member cannot mint it for themselves.
    it('writes the run-control channel after the claim lines, and drops a member-set one', () => {
        const controlled = {
            ...envJob,
            env: { MY_TOKEN: 'board-secret', BELLOWS_CONTROL_TOKEN: 'member-forged' },
            gateEnv: { BELLOWS_CONTROL_URL: 'http://driver:41000', BELLOWS_CONTROL_TOKEN: 'minted' },
        };
        expect(envFileBody(controlled)).toBe(
            'MY_TOKEN=board-secret\nBELLOWS_CONTROL_URL=http://driver:41000\nBELLOWS_CONTROL_TOKEN=minted\n'
        );
    });

    it('never forwards a name the runner itself claims', () => {
        expect(claimEnv(envJob)).toEqual({ MY_TOKEN: 'board-secret' });
        const line = dockerArgs(
            loadDriverConfig({}),
            envJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        // The one WORKDIR on the line is the runner's own, with the mount in it.
        expect(line.filter((arg) => arg === 'WORKDIR')).toHaveLength(0);
        expect(line).toEqual(expect.arrayContaining([`WORKDIR=/workspaces/bellows/${USER}`]));
    });

    it.each<[string, Record<string, string>]>([
        // CRED_HELPER is the sync fetch's credential-helper CODE, a value the driver alone
        // chooses; a member's `!` helper riding the claim env into the sync container would be
        // member-controlled code execution, run by git as helper code.
        ['CRED_HELPER', { CRED_HELPER: '!evil' }],
        // RESTORE is the sync's restore-mode switch (issue #58), and the claim env rides the
        // same sync container: a member value there would flip STARTING claims into restore
        // mode — no fetch, no rebase, a first attempt dead-ending on "the branch is gone" —
        // so the driver alone chooses it.
        ['RESTORE', { RESTORE: '1' }],
        // The startup sync lock's bounds (issue #307) are the script's defaults; a member value
        // riding the claim env into the sync container could shrink the wait to nothing or make
        // every sync steal its neighbour's live lock — so the names stay driver-owned, like
        // RESTORE beside them.
        ['SYNC_LOCK_*', { SYNC_LOCK_WAIT_MS: '1', SYNC_LOCK_STALE_MS: '1' }],
        // The transcript store's location is driver-composed (transcriptDir); a member value
        // would steer where headless transcripts are written — and, through the entrypoint's
        // redirect, where the CLI's whole config dir lands.
        ['FACTORY_TRANSCRIPT_DIR', { FACTORY_TRANSCRIPT_DIR: '/somewhere' }],
        // The turn context is board-rendered (runner-plan.ts); a member value would reach the
        // model through the UserPromptSubmit hook as Factory's own context.
        ['FACTORY_TURN_CONTEXT', { FACTORY_TURN_CONTEXT: 'spoof' }],
    ])('drops a member %s from the claim env and the env file', (_name, member) => {
        const hijacked = { ...job, env: { ...member, OTHER: 'fine' } };
        expect(claimEnv(hijacked)).toEqual({ OTHER: 'fine' });
        expect(envFileBody(hijacked)).toBe('OTHER=fine\n');
    });

    it('always writes the env file for the runner — the pair rides it even with no claim env', () => {
        // The claim-less body is exactly the pair: the runner's own credential, nothing else.
        expect(envFileBody(job, loadDriverConfig({}))).toBe(
            'RUNNER_JOB_ID=11111111-1111-4111-8111-111111111111\nRUNNER_LEASE_TOKEN=22222222-2222-4222-8222-222222222222\n'
        );
        const line = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });
});

const START = '2026-08-20T06:00:00.000Z';

describe('the close-time claude-code turn count', () => {
    /**
     * The read is the opencode readout's twin: a throwaway container over the workspaces
     * volume, reading the transcript the CLI wrote onto FACTORY_TRANSCRIPT_DIR while it lived.
     * Pure and pinned for the same reason opencodeSessionReadoutArgs is — the job container is
     * already gone, and the volume is the only thing that outlived it.
     */
    it('reads the transcript off the workspaces volume, session id by env, never in the script text', () => {
        const line = claudeTurnsArgs(loadDriverConfig({}), job, SESSION, START);
        expect(line.slice(0, 16)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            '--mount',
            `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            '-e',
            `CLAUDE_TRANSCRIPT_DIR=/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            '-e',
            `CLAUDE_SESSION_ID=${SESSION}`,
            // The per-run delta bound: a follow-up resumes this transcript, so only the
            // entries written at or after this run began are its turns.
            '-e',
            `RUN_STARTED_AT=${START}`,
            '--entrypoint',
            'node',
        ]);
        // The static script by content (what it reads: scripts-claude-turns.test.ts).
        expect(line.slice(16)).toEqual(['claude-executor', '-e', claudeTurnsScript]);
    });

    it('refuses a session id that is not a uuid — it names a file the script would read', () => {
        expect(() => claudeTurnsArgs(loadDriverConfig({}), job, '../../etc/passwd', START)).toThrow(/not a uuid/);
    });

    it('parses the count and summary the script answered, and answers nulls for anything else', () => {
        expect(parseClaudeCloseRead('{"turns":11,"summary":"Fixed the failing gates"}\n')).toEqual({
            turns: 11,
            summary: 'Fixed the failing gates',
            blocked: null,
        });
        // A genuine zero is a measurement — a conversation with no assistant response.
        expect(parseClaudeCloseRead('{"turns":0,"summary":null}')).toEqual({ turns: 0, summary: null, blocked: null });
        expect(parseClaudeCloseRead('{"turns":null,"summary":null,"error":"no transcript for session x"}')).toEqual({
            turns: null,
            summary: null,
            blocked: null,
        });
        // Fractional, negative, or garbage: unmeasured, never a wrong number.
        expect(parseClaudeCloseRead('{"turns":2.5,"summary":42}')).toEqual({
            turns: null,
            summary: null,
            blocked: null,
        });
        expect(parseClaudeCloseRead('{"turns":-3,"summary":"x"}')).toEqual({
            turns: null,
            summary: 'x',
            blocked: null,
        });
        expect(parseClaudeCloseRead('')).toEqual({ turns: null, summary: null, blocked: null });
        expect(parseClaudeCloseRead('node: nothing to run')).toEqual({ turns: null, summary: null, blocked: null });
        // The final message's blocked line rides beside the summary, read before its collapse.
        expect(parseClaudeCloseRead('{"turns":1,"summary":"a FACTORY_BLOCKED: b","blocked":"b"}')).toEqual({
            turns: 1,
            summary: 'a FACTORY_BLOCKED: b',
            blocked: 'b',
        });
    });
});

describe('which runs get a close-time turn read', () => {
    /** The read is claude-code-only, and this decision is pure so it stays pinned as the runners evolve. */
    it('reads for a claude-code run with a session', () => {
        const session = { id: SESSION, resume: false };
        expect(readsAgentTurns(job, session)).toBe(true);
        // Opencode counts in its own readout; there is no second read for it.
        expect(readsAgentTurns(opencodeJob, session)).toBe(false);
        // No session minted — nothing to read a transcript for.
        expect(readsAgentTurns(job, null)).toBe(false);
        expect(readsAgentTurns(job, { id: 'not-a-uuid', resume: false })).toBe(false);
    });
});

describe('the transcript export reads (issue #325)', () => {
    it('opencode: has no transcript container of its own — the session readout carries the export', () => {
        const line = opencodeSessionReadoutArgs(loadDriverConfig({}), opencodeJob, START);
        expect(line).toContain(`EXPORT_LIMIT_BYTES=${OPENCODE_EXPORT_LIMIT}`);
        expect(line).toContain(opencodeReadoutScript);
    });

    /**
     * The parser both executors' transcript reads answer through: marker sniffed and stripped,
     * plain JSONL through untouched, the driver's own cap re-applied at whole-line granularity —
     * a record that cannot fit whole is skipped, never split into a partial JSONL line — and the
     * failure line, or an empty answer, costs the artifact; content is never invented.
     */
    it('parses the export: marker stripped, whole lines kept within the cap, failure lines answer null', () => {
        // Plain content, no marker.
        expect(parseTranscriptRead('{"a":1}\n{"b":2}\n')).toEqual({ content: '{"a":1}\n{"b":2}', truncated: false });
        // The marker is sniffed and stripped, and its flag rides the answer.
        expect(parseTranscriptRead('{"truncated":true,"droppedLines":3}\n{"b":2}\n')).toEqual({
            content: '{"b":2}',
            truncated: true,
        });
        // A marker with content under the cap: truncated stays true, no second cut.
        // The failure line, alone: no artifact, never an error line uploaded as content.
        expect(parseTranscriptRead('{"error":"no transcript for session x"}\n')).toBeNull();
        // Silence and garbage: no artifact.
        expect(parseTranscriptRead('')).toBeNull();
        expect(parseTranscriptRead('node: nothing to run\n')).toEqual({
            content: 'node: nothing to run',
            truncated: false,
        });
        // Over the cap, whole lines only: an oversized newest record is skipped — never split —
        // the older lines that fit are kept, and the flag is earned, not guessed.
        const old = '{"old":1}';
        const oversized = 'x'.repeat(ARTIFACT_LIMIT + 10);
        expect(parseTranscriptRead(`${old}\n${oversized}\n`)).toEqual({ content: old, truncated: true });
        // The kept total, separators included, stays within the cap: a line that fits only by
        // splitting its neighbor is dropped with it.
        const almost = 'y'.repeat(ARTIFACT_LIMIT - 10);
        const kept = parseTranscriptRead(`{"head":1}\n${almost}\n${almost}\n`);
        expect(kept).toEqual({ content: almost, truncated: true });
        expect(kept === null || Buffer.byteLength(kept.content, 'utf8') <= ARTIFACT_LIMIT).toBe(true);
        // Nothing fits whole: no artifact at all, never a partial record.
        expect(parseTranscriptRead(`${oversized}\n`)).toBeNull();
    });
});

describe('an opencode runner', () => {
    const oc = (env: NodeJS.ProcessEnv = {}) =>
        dockerArgs(loadDriverConfig(env), opencodeJob, null, { envFile: '/tmp/env-file' });

    // Issue #244: the real runner's env file carries the reserved `factory` agent merged into
    // OPENCODE_CONFIG_CONTENT — the one place this happens, so a swap back to `claimEnv` here
    // would silently drop the master prompt from every OpenCode run.
    describe('the master prompt reaches the real runner only', () => {
        it('merges the reserved factory agent into the runner env file', () => {
            const body = envFileBody(opencodeJob, loadDriverConfig({}));
            expect(body).toContain(
                `OPENCODE_CONFIG_CONTENT={"agent":{"factory":{"mode":"primary","prompt":${JSON.stringify(MASTER_PROMPT)},"disable":false}}}`
            );
        });

        it('preserves the member’s own executor config alongside the reserved agent', () => {
            const withMemberConfig: BoardJob = {
                ...opencodeJob,
                env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'anthropic/claude-sonnet' }) },
            };
            const body = envFileBody(withMemberConfig, loadDriverConfig({}));
            const line = body.split('\n').find((l) => l.startsWith('OPENCODE_CONFIG_CONTENT='));
            const merged = JSON.parse(line!.slice('OPENCODE_CONFIG_CONTENT='.length));
            expect(merged.model).toBe('anthropic/claude-sonnet');
            expect(merged.agent.factory).toEqual({ mode: 'primary', prompt: MASTER_PROMPT, disable: false });
        });

        it('never merges into an aux container’s env (no config argument)', () => {
            // Sync, gates, publish and block-helper containers never run the agent CLI, so they
            // must never carry the reserved agent — and calling with no `config` must not throw
            // even though the claim's masterPrompt-dependent merge would otherwise need one.
            expect(envFileBody(opencodeJob)).not.toContain('OPENCODE_CONFIG_CONTENT');
        });
    });

    /**
     * The close path reads what the run left behind — the session id AND how the run's last
     * message ended. A zero exit code with finish `length` is the model's context limit cutting
     * the task short, and the outcome must carry that; only a reason the daemon's read actually
     * produced lands, a failed readout costing neither.
     */
    it('scrapes the finish reason beside the session id when an opencode run closes', async () => {
        const { exec } = entrypointAnswers(
            '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433,"cost":0.31}\n'
        );
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        const outcome = await runner.run({ ...opencodeJob, followUp: false }, null);
        expect(outcome).toMatchObject({
            exitCode: 0,
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
        });
    });

    // The retry and merge are pinned in close-read.test.ts; this is docker's transport failure —
    // a readout container the daemon refused rides the outcome. RUNNER_SERVICES=0: the stub
    // routes every `--entrypoint` run to one branch, and this is the SESSION readout.
    const ocServicesOff = { RUNNER_SERVICES: '0' } as const;

    it('carries a refused readout container on the outcome too', async () => {
        const { exec } = entrypointAnswers(() => {
            throw new Error('daemon refused the readout');
        });
        const runner = dockerRunner(exec, { env: ocServicesOff, spawn: spawnChild('done\n', '', 0) });

        const outcome = await runner.run({ ...opencodeJob, followUp: false }, null);
        expect(outcome.readoutError).toBe('the readout container failed: daemon refused the readout');
    });

    it('uses the image configured for its selected executor type', () => {
        // The image is the argument before the command; the default would read `opencode-executor`.
        expect(oc({ OPENCODE_EXECUTOR_IMAGE: 'registry/oc:2' }).slice(-5)).toEqual([
            'registry/oc:2',
            'run',
            '--agent',
            'factory',
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
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
                `WORKDIR=/workspaces/bellows/${USER}`,
                '-e',
                'ANTHROPIC_API_KEY',
            ])
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
    it('refuses to build a readout argv for a claim whose workspace path cannot be asserted', () => {
        // The path lands in the mount's volume-subpath now, so it is asserted before any argv
        // exists — a malformed claim produces no container, not one mounted somewhere unintended.
        const broken = { ...opencodeJob, workspacePath: '../../etc' };
        expect(() => opencodeSessionReadoutArgs(loadDriverConfig({}), broken, START)).toThrow(/workspace path/);
        expect(() => opencodeCacheProbeArgs(loadDriverConfig({}), broken)).toThrow(/workspace path/);
    });

    it('reads the session database out of the member’s data directory, root sessions only', () => {
        const line = opencodeSessionReadoutArgs(loadDriverConfig({}), opencodeJob, START);
        expect(line.slice(0, 16)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            '--mount',
            `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            '-e',
            `OPENCODE_DB=/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            '-e',
            // The scope: the session database is per member, so the readout answers only the
            // session whose `directory` is the working directory the RUN container had — the
            // member root here, since this job names no repo. Without it, two concurrent tasks
            // of one member share the database and the newest-root-session scrape answers
            // whichever task closed last (observed 2026-09-11: two /fix tasks recorded one
            // session id, and both their follow-ups resumed the same conversation).
            `OPENCODE_DIR=/workspaces/bellows/${USER}`,
            '-e',
            // The per-run delta bound: a follow-up resumes the same root conversation, so the
            // turn count is bounded to the messages written at or after this run began.
            `RUN_STARTED_MS=${Date.parse(START)}`,
            '-e',
            `EXPORT_LIMIT_BYTES=${OPENCODE_EXPORT_LIMIT}`,
        ]);
        // The static script by content (what it answers: scripts-opencode-readout.test.ts).
        expect(line.slice(16)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e', opencodeReadoutScript]);
    });

    it('scopes the readout to the task worktree when the job names a repo', () => {
        const line = opencodeSessionReadoutArgs(
            loadDriverConfig({}),
            { ...opencodeJob, repo: 'Bellows-AI/factory' },
            START
        );
        expect(line).toContain(`OPENCODE_DIR=/workspaces/bellows/${USER}/.worktrees/${job.id}`);
    });

    it('pulls the session id, finish reason and context stats out of the readout’s answer', () => {
        expect(
            parseOpencodeRunOutcome(
                '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433.4,"cost":0.31}\n'
            )
        ).toEqual({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // A healthy run's closing word, and a free-tier cost of zero.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":"stop","tokens":1200,"cost":0,"turns":7}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'stop',
            contextTokens: 1200,
            costUsd: 0,
            agentTurns: 7,
            summary: null,
            blocked: null,
            error: null,
        });
        // A message that never reported a finish or tokens reads as none, not as a reason.
        // A line with no turn count reads unmeasured — pre-change readouts, or a parse miss.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":null,"tokens":null,"cost":null}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // The readout's own failure line: carried through as the reason, with no stats.
        expect(parseOpencodeRunOutcome('{"error":"no such column: role"}')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: 'no such column: role',
        });
        expect(parseOpencodeRunOutcome('')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // Not a session id: a path, an error line, or a uuid that would read as claude's.
        expect(parseOpencodeRunOutcome('ses_f86188c3dffeZGYO4yZq4atba9\n').sessionId).toBeNull();
        expect(parseOpencodeRunOutcome('Error: Session not found').sessionId).toBeNull();
        expect(
            parseOpencodeRunOutcome('{"id":"33333333-3333-4333-8333-333333333333","finish":"stop"}').sessionId
        ).toBeNull();
        // Negative or non-numeric context stats are not stats.
        // A negative or fractional turn count is not a count — unmeasured, never negative.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","tokens":-5,"cost":"free","turns":-1}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // A session line that also carries the last provider error: both ride — the session makes
        // the task follow-up-able, the error is the premature stop's cause.
        expect(
            parseOpencodeRunOutcome(
                '{"id":"ses_x1","finish":"tool-calls","tokens":100016,"cost":0,"error":"Error from provider (Console): Rate limit exceeded. Please try again later."}'
            )
        ).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'tool-calls',
            contextTokens: 100016,
            costUsd: 0,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: 'Error from provider (Console): Rate limit exceeded. Please try again later.',
        });
        // The final message's blocked line rides beside the summary, read before its collapse.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","summary":"a","blocked":"no access"}').blocked).toBe(
            'no access'
        );
    });
});

describe('the cache watch', () => {
    const DEATH =
        '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","turns":[' +
        '{"input":84000,"cacheRead":0,"ms":250000},' +
        '{"input":80000,"cacheRead":0,"ms":200000},' +
        '{"input":63000,"cacheRead":0,"ms":150000}]}';

    /**
     * The probe is a throwaway container over the workspaces volume, entrypoint swapped for node
     * — the live-run twin of the close-time readout. Pure and pinned for the same reason.
     */
    it('probes the newest root session of the member’s data directory, read-only', () => {
        const line = opencodeCacheProbeArgs(loadDriverConfig({}), opencodeJob);
        expect(line.slice(0, 12)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            '--mount',
            `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            '-e',
            `OPENCODE_DB=/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            '-e',
            // The turn count rides from the driver's own constant, so the probe and the verdict
            // cannot drift apart.
            `CACHE_WATCH_TURNS=${CACHE_WATCH_TURNS}`,
        ]);
        expect(line.slice(12, 16)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e']);
        const script = line[16] as string;
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
        c.stdout = new EventEmitter() as Readable;
        c.stderr = new EventEmitter() as Readable;
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
        const runner = dockerRunner(exec, {
            env: {
                RUNNER_CACHE_WATCH: '1',
                RUNNER_CACHE_WATCH_POLL_MS: '250',
            },
            spawn: childSpawn,
        });

        const pending = runner.run({ ...opencodeJob, followUp: false }, null);
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
        const runner = dockerRunner(exec, { spawn: childSpawn });

        const pending = runner.run({ ...opencodeJob, followUp: false }, null);
        // Two poll periods of a live run, had the watch been armed at the same 250ms the armed
        // test uses — then an ordinary clean exit.
        await new Promise((r) => setTimeout(r, 500));
        close(0);
        await pending;

        // The close-time readout does run; the mid-run probe never does.
        expect(calls.some((a) => a[0] === 'run' && a.includes('order by id desc'))).toBe(false);
    });

    it('does not probe Claude Code tasks when the mixed-task driver has the OpenCode watch enabled', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = dockerRunner(exec, {
            env: { RUNNER_CACHE_WATCH: '1', RUNNER_CACHE_WATCH_POLL_MS: '250' },
            spawn: childSpawn,
        });

        const pending = runner.run(job, { id: SESSION, resume: false });
        await new Promise((r) => setTimeout(r, 500));
        close(0);
        await pending;

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
            ])
        );
    });

    it('mounts the checkouts volume and works inside the worktree, like the coding agent does', () => {
        // Scoped to the checkout key's own `<orgId>/<userId>` half — the same subtree the
        // runner and every other aux container get for this job.
        expect(gateEnvArgs(config, KEY, 'node:24')).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
                '-w',
                `/workspaces/${KEY}`,
            ])
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
            expect.arrayContaining(['--network', 'factory-ai_default'])
        );
        expect(gateEnvArgs(config, KEY, 'node:24', { envFile: '/tmp/gate.env' })).toEqual(
            expect.arrayContaining(['--env-file', '/tmp/gate.env'])
        );
    });

    // The gate env writes the shared task worktree, so it writes as the uid:gid every other
    // writer on that tree uses — the executor images' USER node (1000:1000). Its own default is
    // usually root, and root-written files are ones the uid-1000 sync/reclaim can never remove
    // (observed 2026-09-13: a gate-built core/dist left a worktree unremovable).
    it('runs as the runner uid:gid, with a HOME the non-root uid can write', () => {
        const line = gateEnvArgs(config, KEY, 'node:24');
        expect(line).toEqual(expect.arrayContaining(['--user', '1000:1000', '-e', 'HOME=/tmp']));
    });

    // Issue #507, the docker half: the gate container is sized by GATE_* (each slot falling back
    // to the runner's), rendered as the runner's own flags; nothing configured leaves it unthrottled.
    it('carries the gate resources as docker flags before the image, and none when unconfigured', () => {
        const sized = gateEnvArgs(
            loadDriverConfig({ RUNNER_CPU_LIMIT: '4', GATE_MEMORY_LIMIT: '8Gi', GATE_MEMORY_REQUEST: '2Gi' }),
            KEY,
            'node:24'
        );
        expect(sized.slice(0, sized.indexOf('node:24'))).toEqual(
            expect.arrayContaining(['--cpus', '4', '--memory', '8589934592', '--memory-reservation', '2147483648'])
        );
        const plain = gateEnvArgs(config, KEY, 'node:24');
        expect(plain).not.toContain('--cpus');
        expect(plain).not.toContain('--memory');
        expect(plain).not.toContain('--memory-reservation');
    });

    // A gate's tail is what the job output shows; npm's update notice must not be its last word
    // (#511). Container env, so every `docker exec` of a gate inherits it.
    it('silences npm update notices for every gate exec', () => {
        const line = gateEnvArgs(config, KEY, 'node:24');
        const at = line.indexOf('NPM_CONFIG_UPDATE_NOTIFIER=false');
        expect(line[at - 1]).toBe('-e');
        expect(at).toBeLessThan(line.indexOf('node:24'));
    });

    it('leaves the npm notice to a claim that names it, in the gate env file', () => {
        const envJob = { id: 'j', leaseToken: 'l', workspacePath: null, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        const line = gateEnvArgs(config, KEY, 'node:24', { envFile: '/tmp/gate.env', job: envJob });
        expect(line.filter((_, i) => line[i - 1] === '-e')).toEqual(['HOME=/tmp']);
    });

    it('never puts a member value on the command line — the env file is the only carrier', () => {
        const line = gateEnvArgs(config, KEY, 'node:24', { envFile: '/tmp/gate.env' });
        // The only -e values are the driver's own literals — HOME for the non-root uid and the
        // npm notice switch (above); every claim value travels the env file.
        expect(line.filter((_, i) => line[i - 1] === '-e')).toEqual(['HOME=/tmp', 'NPM_CONFIG_UPDATE_NOTIFIER=false']);
    });

    // Issue #734: the gate env (and so the setup step exec'd into it) gets the same repo cache
    // path the runner does, inside the one member mount it already has.
    it('points each declared cache name into the repo cache, with no extra mount', () => {
        const cacheJob = {
            ...job,
            repo: 'acme/widgets',
            gates: { image: 'node:24', cache: ['NPM_CONFIG_CACHE'], gates: [] },
        };
        const line = gateEnvArgs(config, KEY, 'node:24', { job: cacheJob });
        expect(line.filter((_, i) => line[i - 1] === '-e')).toEqual([
            'HOME=/tmp',
            'NPM_CONFIG_UPDATE_NOTIFIER=false',
            `NPM_CONFIG_CACHE=/workspaces/bellows/${USER}/.cache/acme/widgets/NPM_CONFIG_CACHE`,
        ]);
        expect(line.filter((arg) => arg === '--mount')).toHaveLength(1);
        const claimed = { ...cacheJob, env: { NPM_CONFIG_CACHE: '/elsewhere' } };
        const own = gateEnvArgs(config, KEY, 'node:24', { envFile: '/tmp/gate.env', job: claimed });
        expect(own.some((arg) => arg.startsWith('NPM_CONFIG_CACHE='))).toBe(false);
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
            'BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n'
        );
        const line = dockerArgs(
            loadDriverConfig({}),
            gateOnly,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    it('refuses to run a job whose only env is gate credentials with no env file to carry them', () => {
        // The same silent drop the claim-env refusal prevents — the credentials it was spawned
        // against never reach the container.
        expect(() => dockerArgs(loadDriverConfig({}), gateOnly, { id: SESSION, resume: false })).toThrow(/no env file/);
    });

    it('adds the host gateway mapping so the default gate URL resolves on Linux daemons', () => {
        expect(
            dockerArgs(loadDriverConfig({}), gated, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).toEqual(expect.arrayContaining(['--add-host', 'host.docker.internal:host-gateway']));
        // ... and only for a gated job: an ungated runner's argv must stay byte-identical.
        expect(
            dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).not.toContain('host.docker.internal:host-gateway');
    });

    it('never puts a gate value on the command line', () => {
        const line = dockerArgs(
            loadDriverConfig({}),
            gated,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line.some((arg) => arg.includes('tok'))).toBe(false);
        expect(line.some((arg) => arg.includes('host.docker.internal:9099'))).toBe(false);
    });

    // Regression pin for the feature boundary: a claim without gates builds exactly the argv it
    // always did.
    it('builds byte-identical argv for a job without gates', () => {
        expect(
            dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).toEqual(
            dockerArgs(
                loadDriverConfig({}),
                { ...job, gates: null },
                { id: SESSION, resume: false },
                { envFile: '/tmp/env-file' }
            )
        );
    });

    // opencode's plugin reads its endpoint from otel.json, not from OTEL_EXPORTER_OTLP_ENDPOINT —
    // the driver renders that file (telemetry-config.ts). The env var still reaches the runner,
    // for this CLI no less than for claude-code.
    it('forwards the OTEL endpoint to the opencode runner too', () => {
        const line = dockerArgs(
            loadDriverConfig({ RUNNER_OTEL_ENDPOINT: 'http://collector:4318' }),
            opencodeJob,
            null,
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']));
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
        expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    });

    it('keeps the tail, not the head', () => {
        expect(tailBytes('head-head-head-tail', 4)).toBe('tail');
    });

    it('cuts at a character boundary: a multibyte character split by the limit is dropped whole (#825)', () => {
        // Each ☕ is three bytes, so a 4-byte limit lands inside the second-to-last one.
        expect(tailBytes('☕'.repeat(100), 4)).toBe('☕');
        const kept = tailKept('€'.repeat(ARTIFACT_LIMIT), ARTIFACT_LIMIT);
        expect(kept.truncated).toBe(true);
        expect(Buffer.byteLength(kept.content, 'utf8')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(kept.content).not.toContain('�');
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
        const s = new EventEmitter() as Readable;
        if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
        return s;
    };
    child.stdout = stream(stdout);
    child.stderr = stream(stderr);
    process.nextTick(() => child.emit('close', code));
    return child;
}

/** A child whose stdout arrives as exactly these byte chunks and ends, in one tick, before it exits `code`. */
function chunkedChild(chunks: Buffer[], code = 0): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter() as Readable;
    child.stdout = stdout;
    child.stderr = new EventEmitter() as Readable;
    process.nextTick(() => {
        for (const chunk of chunks) stdout.emit('data', chunk);
        stdout.emit('end');
        child.emit('close', code);
    });
    return child;
}

/** A log whose stream ends inside a `€`: its last two bytes begin a character that never completes. */
const CUT_SHORT = [Buffer.concat([Buffer.from('ok'), Buffer.from('€').subarray(0, 2)])];

/**
 * `body` then a `€` split across two chunks after its first byte (issue #825): decoded chunk by
 * chunk, each half would read as U+FFFD.
 */
const splitEuro = (body: string): Buffer[] => {
    const euro = Buffer.from('€');
    return [
        Buffer.concat([Buffer.from(body), euro.subarray(0, 1)]),
        Buffer.concat([euro.subarray(1), Buffer.from('\n')]),
    ];
};
/** Below the artifact cap, and above it in multibyte text: [body, the truncated flag it earns]. */
const SPLIT_EURO_CASES = [
    ['a', false],
    ['€'.repeat(ARTIFACT_LIMIT / 2), true],
] as const;
const expectWholeEuro = (outcome: RunOutcome | undefined, truncated: boolean): void => {
    expect(outcome?.fullLog?.endsWith('€\n')).toBe(true);
    expect(outcome?.fullLog).not.toContain('�');
    expect(outcome?.output).not.toContain('�');
    expect(Buffer.byteLength(outcome?.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
    expect(outcome?.logTruncated).toBe(truncated);
};

/** A spawn whose every call hands back one {@link fakeChild}. */
function spawnChild(stdout: string, stderr?: string, code?: number | null): typeof spawn {
    return (() => fakeChild(stdout, stderr as string, code as number | null)) as unknown as typeof spawn;
}

/**
 * A stateful daemon: containers and networks live in maps keyed by id/name with their labels,
 * `ps` and `network ls` honor `--filter label=` pairs, and `rm -f` / `network rm` remove exactly
 * what they are told. Service containers, networks and the runner's own `docker create` register
 * through the exec seam, so cross-attempt "B is untouched" assertions are state, not argv. The
 * throwaway `run … --entrypoint` container answers `readout` (default: the sync's success
 * verdict). `fail`, when given, turns the matching call into an execFile-shaped rejection —
 * stderr on the error, the way the promisified execFile carries a daemon refusal.
 */
/**
 * The readiness wait's `docker ps --format '{{json .}}'` answer: every service container the
 * daemon was asked to run (`--network-alias`, labelled `factory.service`), running.
 */
function runningServicesPs(calls: readonly string[][]): { stdout: string } {
    const names = calls
        .filter((a) => a[0] === 'run' && a.includes('--network-alias'))
        .flatMap((a) => a.filter((arg) => arg.startsWith('factory.service=')));
    return {
        stdout: names.map((label) => JSON.stringify({ Labels: label, Image: 'svc:1', State: 'running' })).join('\n'),
    };
}

function labelDaemon({
    readout = '{"ok":true,"reason":null}',
    fail,
}: {
    readout?: string;
    fail?: (args: string[]) => string | null;
} = {}) {
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
    const listed = (entries: Map<string, Record<string, string>>, args: string[]) => {
        const filters = filtersOf(args);
        if (args.includes('{{json .}}')) {
            // The readiness wait's listing: every matching service container, running.
            const services = [...entries.values()].filter(
                (labels) => labels['factory.service'] && filters.every(([key, value]) => labels[key] === value)
            );
            return {
                stdout: services
                    .map((labels) =>
                        JSON.stringify({
                            Labels: `factory.service=${labels['factory.service']}`,
                            Image: 'svc:1',
                            State: 'running',
                        })
                    )
                    .join('\n'),
            };
        }
        // The fence's `--format` asks for each object's lease label beside its name, as docker renders it.
        const withLease = (args[args.indexOf('--format') + 1] ?? '').includes('factory.lease');
        return {
            stdout: [...entries.entries()]
                .filter(([, labels]) => filters.every(([key, value]) => labels[key] === value))
                .map(([name, labels]) => (withLease ? `${name}\t${labels['factory.lease'] ?? ''}` : name))
                .join('\n'),
        };
    };
    const exec = vitest.fn(async (args: string[]) => {
        calls.push(args);
        const refused = fail?.(args);
        if (refused) {
            throw Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), { stderr: refused });
        }
        if (args[0] === 'ps') return listed(containers, args);
        if (args[0] === 'rm' && args[1] === '-f') {
            for (const id of args.slice(2)) containers.delete(id);
            return { stdout: '' };
        }
        if (args[0] === 'network' && args[1] === 'ls') return listed(networks, args);
        if (args[0] === 'network' && args[1] === 'rm') {
            for (const name of args.slice(2)) networks.delete(name);
            return { stdout: '' };
        }
        if (args[0] === 'network' && args[1] === 'create') {
            networks.set(args[args.length - 1]!, labelsOf(args));
            return { stdout: '' };
        }
        if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: readout };
        if ((args[0] === 'run' && args.includes('--network-alias')) || args[0] === 'create') {
            containers.set(args[args.indexOf('--name') + 1]!, labelsOf(args));
            return { stdout: '' };
        }
        return { stdout: '' };
    }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
    return { containers, networks, calls, exec };
}

/**
 * The common daemon stub: the throwaway `run … --entrypoint` container (a readout, a sync)
 * prints `answer` — a function sees the argv and may throw, as a refusing daemon does — and
 * every other docker verb answers empty. Every argv is recorded in `calls`.
 */
function entrypointAnswers(answer: string | ((args: string[]) => string)): {
    exec: (args: string[]) => Promise<{ stdout: string }>;
    calls: string[][];
} {
    const calls: string[][] = [];
    const exec = vitest.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'run' && args.includes('--entrypoint')) {
            return { stdout: typeof answer === 'string' ? answer : answer(args) };
        }
        return { stdout: '' };
    });
    return { exec, calls };
}

/**
 * The runner under test: configured from `env`, the daemon stood in by `exec`, and a spawn whose
 * child prints nothing and exits 0 unless the test hands its own.
 */
function dockerRunner(
    exec: Parameters<typeof createDockerRunner>[2],
    {
        env = {},
        spawn: spawnFn = spawnChild('', '', 0),
        files,
        steps = fakeSteps().sink,
        endpoint,
    }: {
        env?: Parameters<typeof loadDriverConfig>[0];
        spawn?: typeof spawn;
        files?: RunnerFiles;
        steps?: StepSink;
        endpoint?: SupervisorEndpoint;
    } = {}
): ReturnType<typeof createDockerRunner> {
    return createDockerRunner(loadDriverConfig(env), spawnFn, exec, {
        ...(files ? { files } : {}),
        steps,
        ...(endpoint ? { endpoint } : {}),
    });
}

describe('the docker runner', () => {
    // The daemon is stood in by `execDocker`, so the suite never shells out: the fence and the
    // cleanup `rm` answer empty, and the `inspect` that classifies a 125 close is scripted per
    // test. The fake child carries whatever the run itself printed.
    const noContainer = (args: string[]) => {
        if (args[0] === 'inspect') throw new Error('Error: No such object');
        // The task supervisor finalized: the group's `wait` answers its exit status.
        return Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
    };

    it('reads a daemon refusal as a container that never started', async () => {
        // The run printed the daemon's error — and so would a command that echoed it. The
        // classifier does not read this stream at all: the daemon says no container exists.
        const runner = dockerRunner(noContainer, {
            spawn: spawnChild(
                '',
                'docker: Error response from daemon: Conflict. The container name is already in use\n',
                125
            ),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
    });

    // Issue #452: the runner is created, handed its managed settings as a root-owned 0444
    // archive, and only then started attached. Nothing inside the container — which runs as the
    // agent's uid — ever writes the file.
    it('creates a claude-code runner, copies its rendered managed settings in, then starts it attached', async () => {
        const calls: { args: string[]; input?: Buffer }[] = [];
        const exec = (args: string[], options?: { input?: Buffer }) => {
            calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
            return noContainer(args);
        };
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0', RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' },
            spawn: spawnFn as unknown as typeof spawn,
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const verbs = calls.map((call) => call.args[0]);
        // The supervisor's group is created first; the agent's own create is the one that names it.
        const create = calls.find((call) => call.args[0] === 'create' && call.args.includes(containerName(job)));
        expect(create).toBeDefined();
        expect(calls.findIndex((call) => call.args.includes(supervisorName(job)))).toBeLessThan(calls.indexOf(create!));
        const cp = calls.find((call) => call.args[0] === 'cp');
        expect(cp?.args).toEqual(['cp', '-', `${containerName(job)}:/etc`]);
        expect(cp?.input?.equals(telemetryConfigTar(telemetryConfig('claude-code', 'http://otel.example:4318')))).toBe(
            true
        );
        expect(verbs.indexOf('create')).toBeLessThan(verbs.indexOf('cp'));
        expect(spawnFn.mock.calls).toEqual([['docker', ['start', '-a', containerName(job)], expect.anything()]]);
    });

    it('copies the rendered otel.json into an opencode runner, where its plugin is pointed', async () => {
        const calls: { args: string[]; input?: Buffer }[] = [];
        const exec = (args: string[], options?: { input?: Buffer }) => {
            calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
            return noContainer(args);
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0', RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' },
        });
        await runner.run(opencodeJob, null);
        const cp = calls.find((call) => call.args[0] === 'cp');
        expect(cp?.args).toEqual(['cp', '-', `${containerName(opencodeJob)}:/etc`]);
        expect(cp?.input?.equals(telemetryConfigTar(telemetryConfig('opencode', 'http://otel.example:4318')))).toBe(
            true
        );
    });

    // The daemon refusing the create (a name conflict, a missing image) or the copy is what a
    // refused `docker run` was: a container that never started, nothing spawned, the leftover
    // removed, and the daemon's own words in the output.
    it.each(['create', 'cp'])('reads a refused %s as a container that never started', async (verb) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (args[0] === verb && (verb !== 'create' || args.includes(containerName(job)))) {
                return Promise.reject(
                    Object.assign(new Error('Command failed'), { stderr: 'Error response from daemon: Conflict\n' })
                );
            }
            return noContainer(args);
        };
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnFn as unknown as typeof spawn });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
        expect(outcome.output).toContain('Error response from daemon: Conflict');
        expect(spawnFn).not.toHaveBeenCalled();
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
    });

    // `docker start -a` exits 1 — not run's 125 — when the runtime cannot start the process
    // (a bad mount, a missing binary). The daemon still holds the container as `created`: never
    // started, so the attempt is left to its lease rather than reported as a failed run.
    it('reads a start the runtime refused as a container that never started', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"created","ExitCode":0}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: failed to create task for container\n', 1),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: false });
    });

    it('still reads a run that exited non-zero as a verdict', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":1}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('', 'boom\n', 1) });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
    });

    // A runner container removed under the run (issue #560) — `docker rm -f` by hand, a host
    // cleanup — exits the attached start 137, but the agent never ended it: the driver's own kill
    // only kills, so a container the daemon no longer knows is an infrastructure loss.
    it('reads a runner container removed mid-run as an infrastructure loss', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(
                      Object.assign(new Error('Command failed'), {
                          stderr: `Error: No such object: ${containerName(job)}\n`,
                      })
                  )
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('', '', 137) });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({
            exitCode: 137,
            started: true,
            infraLoss: 'the runner container was removed before it exited (exit 137)',
        });
    });

    it('reads an inspect that fails for any other reason as no loss', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(new Error('daemon unreachable'))
                : Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('', '', 1) });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
        expect(outcome).not.toHaveProperty('infraLoss');
    });

    // The full-log accumulator (issue #325): everything the stream printed, tail-kept at the
    // artifact cap — the artifact the loop uploads at close, of which the verdict's rolling tail
    // is only the end. The refused-start path carries neither.
    it('carries the full log on the outcome, capped tail-true, beside the unchanged report tail', async () => {
        // Past the artifact cap (512 KiB), so the accumulator really has to cut.
        const fullOutput = `${'head\n'.repeat(20)}${'body line\n'.repeat(60_000)}`;
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(fullOutput, '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The full log is the whole stream tail-kept at the cap: its last line survives, its
        // head was cut, and the flag says so.
        expect(outcome.logTruncated).toBe(true);
        expect(outcome.fullLog?.endsWith('body line\n')).toBe(true);
        expect(Buffer.byteLength(outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        // The rolling tail is unchanged: still the report's 16 KiB window.
        expect(outcome.output.length).toBeLessThanOrEqual(16 * 1024);
        expect(outcome.output.endsWith('body line\n')).toBe(true);
    });

    it('keeps the full log byte-true under the cap when the run never exceeded it', async () => {
        const fullOutput = 'short run\n';
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(fullOutput, '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.fullLog).toBe('short run\n');
        expect(outcome.logTruncated).toBe(false);
    });

    it('calls a log of exactly ARTIFACT_LIMIT bytes complete, and one byte more truncated (#825)', async () => {
        for (const [size, truncated] of [
            [ARTIFACT_LIMIT, false],
            [ARTIFACT_LIMIT + 1, true],
        ] as const) {
            const runner = dockerRunner(noContainer, {
                env: { RUNNER_SERVICES: '0' },
                spawn: spawnChild('x'.repeat(size), '', 0),
            });
            const outcome = await runner.run(job, { id: SESSION, resume: false });
            expect(outcome.logTruncated).toBe(truncated);
            expect(Buffer.byteLength(outcome.fullLog ?? '')).toBe(ARTIFACT_LIMIT);
        }
    });

    it('keeps the bytes of a stream that ended inside a character, never drops them (#825)', async () => {
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: (() => chunkedChild(CUT_SHORT)) as unknown as typeof spawn,
        });

        const outcome = await runner.run(job, { id: SESSION, resume: false });

        expect(outcome.fullLog).toBe('ok\uFFFD');
        expect(outcome.logTruncated).toBe(false);
    });

    it('decodes a multibyte character split across two stream chunks once, whole — below and above the cap (#825)', async () => {
        for (const [body, truncated] of SPLIT_EURO_CASES) {
            const runner = dockerRunner(noContainer, {
                env: { RUNNER_SERVICES: '0' },
                spawn: (() => chunkedChild(splitEuro(body))) as unknown as typeof spawn,
            });

            expectWholeEuro(await runner.run(job, { id: SESSION, resume: false }), truncated);
        }
    });

    // The security constraint the issue states (docs/security.md): forwarded env secrets must
    // not leak into the stored artifacts. The full log is the child's own stream and NOTHING
    // else — pinned by strict equality, so any driver-side injection on the artifact path (the
    // env file's values included) would break it.
    it('makes the full log exactly the stream — no claim env value can enter the artifact', async () => {
        const stdout = 'plain run output\nwith a second line\n';
        const runner = dockerRunner(noContainer, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild(stdout, '', 0) });
        const outcome = await runner.run(
            { ...job, env: { SENTINEL_SECRET: 'shh-do-not-store' } },
            { id: SESSION, resume: false }
        );
        expect(outcome.fullLog).toBe(stdout);
        expect(outcome.fullLog).not.toContain('shh-do-not-store');
    });

    it('reads a container that ran and exited 125 as a verdict, not an infrastructure refusal', async () => {
        // The exact case a stderr signature gets wrong: the command prints `docker: ` itself —
        // an agent reproducing an error, say — and exits 125. The daemon saw the container run
        // and exit, so `started` is true and the code is reported as the command's verdict.
        const inspect = vitest.fn((args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":125}\n' })
                : Promise.resolve({ stdout: '' })
        );
        const runner = dockerRunner(inspect as unknown as (args: string[]) => Promise<{ stdout: string }>, {
            spawn: spawnChild('work done\n', 'reproduced: docker: Error response from daemon: Conflict\n', 125),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: true });
        expect(inspect).toHaveBeenCalled();
    });

    it('never asks the daemon about a run whose exit code is unambiguous', async () => {
        const inspect = vitest.fn((_args: string[]) => Promise.resolve({ stdout: '' }));
        const runner = dockerRunner(inspect as unknown as (args: string[]) => Promise<{ stdout: string }>, {
            spawn: spawnChild('done\n', '', 0),
        });
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
        const spawnFn = vitest.fn((_cmd: string, _argv: string[], _options?: object) => fakeChild('', '', 0));
        let create: string[] = [];
        const exec = (args: string[]) => {
            if (args[0] === 'create' && args.includes(containerName(job))) create = args;
            return noContainer(args);
        };
        const runner = dockerRunner(exec, { spawn: spawnFn as unknown as typeof spawn });
        const outcome = await runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0 });
        const [cmd, argv, options] = spawnFn.mock.calls[0]!;
        expect(cmd).toBe('docker');
        const fileArg = create[create.indexOf('--env-file') + 1];
        expect(create).toContain('--env-file');
        expect(fileArg).toBeTruthy();
        // The file existed and carried the value while the CLI ran; it is gone once the run is.
        expect(existsSync(fileArg!)).toBe(false);
        // The CLI's environment is inherited, never merged with claim values.
        expect(options && 'env' in options).toBe(false);
        expect([...create, ...(argv as string[])].some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    /**
     * The live-output hook: every chunk that arrives is handed to the caller as the newest tail —
     * the same string a complete report would carry, growing. One call per chunk; throttling is
     * the loop's business.
     */
    it('hands every chunk it reads to the output stream', async () => {
        const tails: string[] = [];
        const runner = dockerRunner(noContainer, { spawn: spawnChild('step one\n', 'warn\n', 0) });

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
            if (args[0] === 'stats') {
                expect(args.slice(1, 4)).toEqual(['--no-stream', '--format', '{{json .}}']);
                expect(args[4]).toBe(containerName(job));
                return Promise.resolve({
                    stdout: '{"CPUPerc":"93.00%","MemPerc":"7.02%","MemUsage":"544MiB / 7.754GiB","Name":"x"}\n',
                });
            }
            // The fleet read answers nothing here: the pin is the vitals shape alone.
            expect(args[0]).toBe('ps');
            return Promise.resolve({ stdout: '' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
        });
    });

    /**
     * The attempt's service fleet rides the same sample (issue #60): the dashboard can answer
     * "did db come up" while the run is going. The read is scoped by the job AND lease label —
     * the attempt-scoping every other per-attempt call leans on — and requires the
     * `factory.service` key, so the runner and gate containers never answer it. `-a` so exited
     * containers report: "did it come up and die" is exactly the honest answer wanted here.
     */
    it('samples the service fleet beside the vitals', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn((args: string[]) => {
            calls.push(args);
            if (args[0] === 'stats') {
                return Promise.resolve({
                    stdout: '{"CPUPerc":"93.00%","MemPerc":"7.02%","MemUsage":"544MiB / 7.754GiB","Name":"x"}\n',
                });
            }
            expect(args[0]).toBe('ps');
            return Promise.resolve({
                stdout:
                    psLine({ name: 'db', image: 'postgres:16', state: 'running' }) +
                    psLine({ name: 'cache', image: 'redis:7', state: 'exited' }),
            });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
            services: [
                { name: 'cache', image: 'redis:7', state: 'exited' },
                { name: 'db', image: 'postgres:16', state: 'running' },
            ],
        });
        const ps = calls.find((args) => args[0] === 'ps')!;
        expect(ps).toContain('-a');
        expect(ps).toContain(`label=factory.job=${job.id}`);
        expect(ps).toContain(`label=factory.lease=${job.leaseToken}`);
        expect(ps).toContain('label=factory.service');
    });

    /**
     * Each half of the sample stands on its own: a fleet read that fails costs the fleet, not the
     * vitals — and never the sample; unreadable vitals must not silence the fleet (null numbers,
     * real states); and only when both reads fail is the sample null.
     */
    const STATS = '{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}';
    const refused = new Error('daemon refused');
    it.each<[string, string | Error, string | Error, unknown]>([
        [
            'keeps the vitals when the service read fails',
            STATS,
            refused,
            { cpuPercent: 93, memUsedMb: 544, memPercent: 7.02 },
        ],
        [
            'reports the service fleet even when the vitals read fails',
            refused,
            psLine({ name: 'db', image: 'postgres:16', state: 'running' }),
            {
                cpuPercent: null,
                memUsedMb: null,
                memPercent: null,
                services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
            },
        ],
        ['answers null when the vitals sample cannot be taken', refused, refused, null],
    ])('%s', async (_label, stats, ps, expected) => {
        const answer = (value: string | Error) =>
            value instanceof Error ? Promise.reject(value) : Promise.resolve({ stdout: value });
        const exec = vitest.fn((args: string[]) => answer(args[0] === 'stats' ? stats : ps)) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual(expected);
    });

    /** Services off: the sample is exactly what it was before services were sampled. */
    it('does not ask the daemon about services when they are off', async () => {
        const commands: string[] = [];
        const exec = vitest.fn((args: string[]) => {
            commands.push(args[0]!);
            return Promise.resolve({ stdout: '{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
        });
        expect(commands).toEqual(['stats']);
    });

    /**
     * The dead half of the fleet (issue #423): an exited or dead service, with the daemon's exit
     * code and reason and the container's last log lines — stdout and stderr both, because an
     * entrypoint's `chown` refusal lands on stderr. Read over the sample's own label scoping; a
     * running service is never inspected.
     */
    it('reads each dead service with its exit, reason and log tail', async () => {
        const calls: string[][] = [];
        const mongo = `factory-job-${job.id}-${job.leaseToken}-svc-mongo`;
        const exec = vitest.fn((args: string[]) => {
            calls.push(args);
            if (args[0] === 'ps') {
                return Promise.resolve({
                    stdout:
                        psLine({ name: 'mongo', image: 'mongo:8', state: 'exited' }) +
                        psLine({ name: 'cache', image: 'redis:7', state: 'dead' }) +
                        psLine({ name: 'db', image: 'postgres:16', state: 'running' }),
                });
            }
            if (args[0] === 'inspect') {
                return Promise.resolve({
                    stdout:
                        args.at(-1) === mongo
                            ? '{"ExitCode":1,"OOMKilled":false,"Error":""}\n'
                            : '{"ExitCode":137,"OOMKilled":true,"Error":""}\n',
                });
            }
            expect(args.slice(0, 3)).toEqual(['logs', '--tail', String(SERVICE_LOG_TAIL_LINES)]);
            return Promise.resolve(
                args.at(-1) === mongo
                    ? { stdout: 'starting\n', stderr: 'chown: Operation not permitted\n' }
                    : { stdout: '' }
            );
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.deadServices(job)).resolves.toEqual([
            { name: 'cache', image: 'redis:7', state: 'dead', exitCode: 137, reason: 'OOMKilled', logTail: '' },
            {
                name: 'mongo',
                image: 'mongo:8',
                state: 'exited',
                exitCode: 1,
                reason: null,
                logTail: 'starting\nchown: Operation not permitted\n',
            },
        ]);
        const ps = calls.find((args) => args[0] === 'ps')!;
        expect(ps).toContain('-a');
        expect(ps).toContain(`label=factory.job=${job.id}`);
        expect(ps).toContain(`label=factory.lease=${job.leaseToken}`);
        expect(ps).toContain('label=factory.service');
        expect(calls.some((args) => args.at(-1)?.endsWith('-svc-db'))).toBe(false);
    });

    it('keeps a dead service whose inspect fails, and throws on an unreadable fleet', async () => {
        const fleet = vitest.fn((args: string[]) =>
            args[0] === 'ps'
                ? Promise.resolve({ stdout: psLine({ name: 'mongo', image: 'mongo:8', state: 'exited' }) })
                : Promise.reject(new Error('No such container'))
        ) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        await expect(dockerRunner(fleet, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)).resolves.toEqual([
            { name: 'mongo', image: 'mongo:8', state: 'exited', exitCode: null, reason: null, logTail: '' },
        ]);

        const refused = vitest.fn(() => Promise.reject(new Error('daemon refused'))) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        await expect(dockerRunner(refused, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)).rejects.toThrow(
            'daemon refused'
        );
    });

    it('answers no dead services without asking the daemon when services are off', async () => {
        const exec = vitest.fn(() => Promise.resolve({ stdout: '' }));
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        await expect(runner.deadServices(job)).resolves.toEqual([]);
        expect(exec).not.toHaveBeenCalled();
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

    describe('parseDockerServicePs', () => {
        it('reads name, image and state off one ps line', () => {
            expect(parseDockerServicePs(psLine({ name: 'db', image: 'postgres:16', state: 'running' }))).toEqual([
                { name: 'db', image: 'postgres:16', state: 'running' },
            ]);
        });

        it('reads every line, sorted by name', () => {
            const out = parseDockerServicePs(
                `${psLine({ name: 'db', image: 'postgres:16', state: 'running' })}${psLine({ name: 'cache', image: 'redis:7', state: 'exited' })}`
            );
            expect(out).toEqual([
                { name: 'cache', image: 'redis:7', state: 'exited' },
                { name: 'db', image: 'postgres:16', state: 'running' },
            ]);
        });

        it('skips rows without the service label, an image or a state, and garbage lines', () => {
            const unlabeled = psLine({ name: 'db', image: 'postgres:16', state: 'running' }).replace(
                /factory\.service=db,?/,
                ''
            );
            expect(
                parseDockerServicePs(
                    `${unlabeled}not json\n${psLine({ name: 'ok', image: '', state: 'running' })}${psLine({ name: 'ok2', image: 'redis:7', state: '' })}`
                )
            ).toEqual([]);
        });

        it('answers empty for empty output', () => {
            expect(parseDockerServicePs('')).toEqual([]);
            expect(parseDockerServicePs('\n\n')).toEqual([]);
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
            expect(currentActivity('x'.repeat(500))!.length).toBe(200);
            expect(currentActivity(null)).toBeNull();
            expect(currentActivity('\n\n')).toBeNull();
            expect(stripAnsi('\x1b]0;title\x07after')).toBe('after');
        });
    });

    // A gated job whose claim resolves to no variables still needs the minted gate credentials:
    // keyed on the claim alone, the file would not exist and the runner could never call a gate.
    it('writes the gate credentials into the env file of a job whose claim env is empty', async () => {
        let fileBody: string | null = null;
        let create: string[] = [];
        const exec = (args: string[]) => {
            // Read at create time, through the argv: what the CLI could see is what counts.
            if (args[0] === 'create' && args.includes(containerName(job))) {
                create = args;
                fileBody = readFileSync(args[args.indexOf('--env-file') + 1]!, 'utf8');
            }
            return noContainer(args);
        };
        const runner = dockerRunner(exec);

        const outcome = await runner.run(
            { ...job, gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' } },
            { id: SESSION, resume: false }
        );

        expect(outcome).toMatchObject({ exitCode: 0 });
        expect(create).toContain('--env-file');
        expect(fileBody).toBe(
            'BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n' +
                `RUNNER_JOB_ID=${job.id}\nRUNNER_LEASE_TOKEN=${job.leaseToken}\n`
        );
    });

    // The lease lost DURING the env-file write: the kill-check just above the write has already
    // passed, and the write's await breaks the synchronous gap the setup promises. Without one
    // more check, the runner spawns over a dead lease — its job-derived container name colliding
    // with the replacement's. On that abort the just-written file must go too: the cleanup around
    // the outcome only covers a settled run, and this throw precedes it.
    //
    // The env-file write is INJECTED here (the constructor's `files` seam) rather than observed
    // through a node:fs/promises mock: under isolate:false that mock only binds when docker.js
    // first executes in a worker, and a copy cached by scripts.test.ts's import once bypassed
    // this park entirely — the run completed, and the test waited on a write that never came.
    it('spawns nothing when the lease is lost during the env-file write, and leaves no file behind', async () => {
        let releaseWrite: (() => void) | null = null;
        const writeReleased = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        let markWrite: (() => void) | null = null;
        const writeUnderway = new Promise<void>((resolve) => {
            markWrite = resolve;
        });
        let writtenTo: string | null = null;
        const files: RunnerFiles = {
            writeFile: async (path, data, options) => {
                writtenTo = String(path);
                markWrite!();
                await writeReleased;
                return writeFile(path, data, options);
            },
            rm,
        };

        const spawnSpy = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(noContainer, { spawn: spawnSpy as unknown as typeof spawn, files: files });

        const pending = runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });
        await writeUnderway; // the run is parked inside the env-file write

        await runner.kill(job); // the lease dies while the write is pending
        releaseWrite!(); // the write lands; the run now learns its lease is gone

        await expect(pending).rejects.toThrow(/killed while setting up services/);
        expect(spawnSpy).not.toHaveBeenCalled();
        // No leak: the file the write just created is removed on the abort path.
        expect(writtenTo).toBeTruthy();
        expect(existsSync(writtenTo!)).toBe(false);
    });

    // Issue #452 split the launch into create → cp → start, and the create and the copy are
    // awaits too: a lease lost behind them must not reach the start. The created container is
    // this attempt's own leftover, removed by name, and the env file goes with it.
    it('starts nothing when the lease is lost during the create, and leaves no container or file behind', async () => {
        const calls: string[][] = [];
        let envFile: string | null = null;
        let runner: ReturnType<typeof createDockerRunner> | null = null;
        const exec = async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'create' && args.includes(containerName(job))) {
                envFile = args[args.indexOf('--env-file') + 1]!;
                await runner!.kill(job); // the lease dies while the create is pending
            }
            return noContainer(args);
        };
        const spawnSpy = vitest.fn(() => fakeChild('', '', 0));
        runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnSpy as unknown as typeof spawn });

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /killed while setting up services/
        );
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
        expect(envFile).toBeTruthy();
        expect(existsSync(envFile!)).toBe(false);
    });
});

/** The suite's job with no services on the claim, for the block below that shadows `job`. */
const baseJob = job;

/*
 * Auxiliary services (issue #6, resolved at claim time by issue #769). The switch is on in this
 * whole block, and the daemon is scripted on argv shape: the service runs (they carry
 * --network-alias) answer created, the label `ps` answers one container id, and everything else
 * succeeds empty. The spawn stands in for the runner container itself and records the argv it was
 * given. The services ride on the claim: this block's `job` declares the one `stub` service.
 */
describe('auxiliary services (RUNNER_SERVICES)', () => {
    const STUB: ServiceSpec = { name: 'stub', image: 'stub-svc:1', environment: [] };
    const job: BoardJob = { ...baseJob, services: [STUB] };
    // The declared fleet is process-wide and the suite runs isolate: false — a failed test must not leak it.
    afterEach(() => forgetDeclaredServices(job));
    /** A restart's stand-down signal that never fires. */
    const live = new AbortController().signal;

    const daemon = (opts: { serviceFails?: boolean; attached?: string } = {}) =>
        vitest.fn(async (args: string[]) => {
            if (args[0] === 'network' && args[1] === 'inspect') return { stdout: opts.attached ?? '' };
            if (args[0] === 'run' && args.includes('--network-alias')) {
                if (opts.serviceFails) throw new Error('daemon refused the service');
                return { stdout: '' };
            }
            // The readiness wait's listing: the declared stub, running.
            if (args[0] === 'ps' && args.includes('{{json .}}')) {
                return {
                    stdout: JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State: 'running' }),
                };
            }
            // The attempt's own service: what the fence's lease-labelled listing shows for it.
            if (args[0] === 'ps')
                return { stdout: args.includes('--format') ? `svc-id-1\t${job.leaseToken}\n` : 'svc-id-1\n' };
            // The task supervisor finalized: the group's `wait` answers its exit status.
            if (args[0] === 'wait') return { stdout: '0\n' };
            return { stdout: '' };
        });

    const spawnRecording = (stdout: string, code: number | null) => {
        const seen: string[][] = [];
        const fn = ((_command: string, argv: string[]) => {
            seen.push(argv);
            const c = new EventEmitter() as ChildProcess;
            const stream = (text: string) => {
                const s = new EventEmitter() as Readable;
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

    /**
     * The loop's order (PR 737): its setup phase starts the services — before the gate
     * environment's setup — and run() spawns the runner. A refused start ends there.
     */
    let startingServices = 0;
    const asLoop = (runner: ReturnType<typeof createDockerRunner>): ReturnType<typeof createDockerRunner> => ({
        ...runner,
        run: async (j, session, onOutput) => {
            startingServices += 1;
            let refused: Awaited<ReturnType<typeof runner.startServices>>;
            try {
                refused = await runner.startServices(j);
            } finally {
                startingServices -= 1;
            }
            return refused ?? runner.run(j, session, onOutput);
        },
    });
    /**
     * The fakes below script `docker ps` for the fence, teardown and probes; while a start waits for
     * its fleet, the readiness listing answers every service the daemon was asked to run, running —
     * what docker would say once they are up. Outside a start the fake's own answer stands.
     */
    const readyWhileStarting = (exec: unknown): Parameters<typeof createDockerRunner>[2] => {
        const seen: string[][] = [];
        const inner = exec as (args: string[]) => Promise<{ stdout: string }>;
        return (async (args: string[]) => {
            seen.push(args);
            if (startingServices > 0 && args[0] === 'ps' && args.includes('{{json .}}')) return runningServicesPs(seen);
            return inner(args);
        }) as Parameters<typeof createDockerRunner>[2];
    };
    const bareServicesRunner = (exec: ReturnType<typeof daemon>, fn: typeof spawn) =>
        dockerRunner(readyWhileStarting(exec), {
            env: { RUNNER_SERVICES: '1' },
            spawn: fn,
        });
    const servicesRunner = (exec: ReturnType<typeof daemon>, fn: typeof spawn) => asLoop(bareServicesRunner(exec, fn));

    // A spawn stub whose children never emit on their own: each spawn hands the test a fire
    // function, so the interleaving — one attempt's error or close landing after another
    // attempt's fleet is already up — is the test's to pace. `track`, when given, sees every
    // spawned argv: it is how the cross-instance tests register the runner container on the
    // scripted daemon, whose `docker run` goes through spawnFn and never through the exec seam.
    const gatedSpawns = (track?: (argv: string[]) => void) => {
        const fires: ((what: 'error' | 'close', payload?: unknown) => void)[] = [];
        const fn = ((_command: string, argv: string[]) => {
            track?.(argv);
            const c = new EventEmitter() as ChildProcess;
            const stream = () => {
                const s = new EventEmitter() as Readable;
                return s;
            };
            c.stdout = stream();
            c.stderr = stream();
            fires.push((what, payload) => process.nextTick(() => c.emit(what, payload)));
            return c;
        }) as unknown as typeof spawn;
        const childAt = async (index: number): Promise<(what: 'error' | 'close', payload?: unknown) => void> => {
            // A macrotask per turn, never a bare microtask wait: the runner now always writes its
            // env file (real fs) between setup and spawn, and a wait that never leaves the
            // microtask queue would starve the event loop — the I/O completion the next spawn
            // waits behind could never run.
            while (fires.length <= index) await new Promise((r) => setImmediate(r));
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

    it('creates the job network, starts the claim’s service, and joins the runner to it', async () => {
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        const createAt = calls.findIndex((a) => a[0] === 'network' && a[1] === 'create');
        const serviceAt = calls.findIndex((a) => a[0] === 'run' && a.includes('--network-alias'));
        // Create before the service — the fence's rounds sit between, which is why these are
        // comparisons and not exact positions.
        expect(createAt).toBeGreaterThanOrEqual(0);
        expect(serviceAt).toBeGreaterThan(createAt);
        expect(calls[serviceAt]).toEqual(serviceRunArgs(job, { name: 'stub', image: 'stub-svc:1', environment: [] }));
        // The runner shares the network — that is the whole feature: inside the job, `stub`
        // resolves to the service container.
        expect(seen[0]).toEqual(['start', '-a', containerName(job)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(job)))).toEqual(
            dockerArgs(
                loadDriverConfig({ RUNNER_SERVICES: '1' }),
                job,
                { id: SESSION, resume: false },
                { servicesNetwork: networkName(job), envFile: envFilePath(job) }
            )
        );
    });

    it('starts every service the claim carries, a declared port changing no argv', async () => {
        const planned: BoardJob = {
            ...baseJob,
            services: [
                { name: 'postgres', image: 'postgres:1', environment: [], ports: [5432] },
                { name: 'redis', image: 'redis:1', environment: [], user: { uid: 999, gid: 999 } },
            ],
        };
        const exec = daemon();
        const outcome = await servicesRunner(exec, spawnRecording('ran\n', 0).fn).run(planned, {
            id: SESSION,
            resume: false,
        });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const started = exec.mock.calls
            .map((call) => call[0])
            .filter((a) => a[0] === 'run' && a.includes('--network-alias'));
        expect(started).toEqual([
            serviceRunArgs(planned, { name: 'postgres', image: 'postgres:1', environment: [] }),
            serviceRunArgs(planned, { name: 'redis', image: 'redis:1', environment: [], user: { uid: 999, gid: 999 } }),
        ]);
        expect(started.every((a) => !a.includes('5432'))).toBe(true);
    });

    it('starts only the network and the service runs: no readout container is ever run', async () => {
        const exec = daemon();
        const runner = bareServicesRunner(exec, spawnRecording('', 0).fn);
        await expect(runner.startServices(job)).resolves.toBeNull();

        const runs = exec.mock.calls.map((call) => call[0]).filter((a) => a[0] === 'run');
        expect(runs).toEqual([serviceRunArgs(job, STUB)]);
        expect(runs.some((a) => a.includes('--entrypoint') || a.includes('sh'))).toBe(false);
        expect(exec.mock.calls.map((call) => call[0]).filter((a) => a[0] === 'network' && a[1] === 'create')).toEqual([
            [
                'network',
                'create',
                '--label',
                `factory.job=${job.id}`,
                '--label',
                `factory.lease=${job.leaseToken}`,
                networkName(job),
            ],
        ]);
    });

    it('starts nothing and changes no argv when the claim carries no services', async () => {
        // The path every existing repo takes: no services on the claim, no network, byte-identical
        // runner argv, exercised end to end rather than only at the dockerArgs parameter.
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(baseJob, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(seen[0]).toEqual(['start', '-a', containerName(baseJob)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(baseJob)))).toEqual(
            dockerArgs(
                loadDriverConfig({ RUNNER_SERVICES: '1' }),
                baseJob,
                { id: SESSION, resume: false },
                { envFile: envFilePath(baseJob) }
            )
        );
        expect(calls).not.toContainEqual(['network', 'create', networkName(job)]);
        expect(calls.every((a) => !a.includes('--network-alias'))).toBe(true);
    });

    /*
     * The fleet outlives run(): the loop runs the declared gates after it, and those are what
     * test against the services. The close tears down only the runner container; the loop's
     * releaseServices takes the fleet down once the gates are done.
     */
    it('keeps the services up past the run, and tears them down on release', async () => {
        const exec = daemon();
        const runner = servicesRunner(exec, spawnRecording('', 1).fn);
        await runner.run(job, { id: SESSION, resume: false });

        const createAt = exec.mock.calls.findIndex((call) => call[0][0] === 'network' && call[0][1] === 'create');
        const afterSetup = exec.mock.calls.slice(createAt).map((call) => call[0]);
        expect(afterSetup).not.toContainEqual(['network', 'rm', networkName(job)]);
        expect(afterSetup).not.toContainEqual(['rm', '-f', 'svc-id-1']);

        const releasedAt = exec.mock.calls.length;
        await runner.releaseServices(job);
        const released = exec.mock.calls.slice(releasedAt).map((call) => call[0]);
        expect(released).toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(released).toContainEqual(['network', 'rm', networkName(job)]);
    });

    // The gate environment joins the services network to reach the fleet, and docker refuses to
    // remove a network with an endpoint still attached — so the release detaches whatever is
    // left on it first, or the network would outlive the attempt.
    it('detaches the gate environment from the network before removing it', async () => {
        const exec = daemon({ attached: 'factory-gateenv-x\n' });
        await servicesRunner(exec, spawnRecording('', 0).fn).releaseServices(job);

        const calls = exec.mock.calls.map((call) => call[0]);
        const disconnectAt = calls.findIndex(
            (a) => a.join(' ') === ['network', 'disconnect', '-f', networkName(job), 'factory-gateenv-x'].join(' ')
        );
        const removeAt = calls.findIndex((a) => a.join(' ') === ['network', 'rm', networkName(job)].join(' '));
        expect(disconnectAt).toBeGreaterThanOrEqual(0);
        expect(removeAt).toBeGreaterThan(disconnectAt);
    });

    // Review: setup must not race a fleet still starting — the start answers only once every
    // service runs, and one that never does is a ServicesNotRunning, as in the restart.
    const readinessDaemon = (states: string[]) => {
        const base = daemon();
        let polls = 0;
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('{{json .}}')) {
                const State = states[Math.min(polls++, states.length - 1)];
                return { stdout: JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State }) };
            }
            return base(args);
        });
        return { exec, polls: () => polls };
    };
    const startWith = (exec: ReturnType<typeof readinessDaemon>['exec']) =>
        startJobServices(job, loadDriverConfig({ RUNNER_SERVICES: '1' }), {
            execDocker: exec as unknown as (args: string[]) => Promise<{ stdout: string; stderr: string }>,
            killed: new Set(),
            serviceTeardown: async () => {},
            sleep: async () => {},
        });

    it('startServices answers only once every service runs', async () => {
        const d = readinessDaemon(['created', 'running']);
        await expect(startWith(d.exec)).resolves.toBeNull();
        expect(d.polls()).toBe(2);
    });

    it('startServices rejects with ServicesNotRunning when a service exits', async () => {
        const d = readinessDaemon(['exited']);
        await expect(startWith(d.exec)).rejects.toBeInstanceOf(ServicesNotRunning);
    });

    // Review (PR 737): the loop starts the services before the gate environment's setup, so run()
    // must neither start them again nor fence them away; the runner still joins their network.
    it('run() starts no services after the loop started them, and the runner joins their network', async () => {
        const exec = daemon();
        const runner = bareServicesRunner(exec, spawnRecording('', 0).fn);
        await expect(runner.startServices(job)).resolves.toBeNull();
        const startedAt = exec.mock.calls.length;
        await runner.run(job, { id: SESSION, resume: false });

        const during = exec.mock.calls.slice(startedAt).map((call) => call[0]);
        expect(during.some((a) => a[0] === 'network' && a[1] === 'create')).toBe(false);
        const readsBellows = (a: string[]) => a.some((arg) => arg.startsWith('BELLOWS_ROOT='));
        expect(during.some((a) => a[0] === 'run' && (a.includes('--network-alias') || readsBellows(a)))).toBe(false);
        const created = during.find((a) => a[0] === 'create' && a.includes(containerName(job)));
        expect(created?.[created.indexOf('--network') + 1]).toBe(networkName(job));
    });

    it("run()'s fence spares this attempt's own containers and networks", async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('--format')) {
                return { stdout: `own-1\t${job.leaseToken}\nold-1\tolder-lease\n` };
            }
            if (args[0] === 'network' && args[1] === 'ls') {
                return { stdout: `own-net\t${job.leaseToken}\nold-net\tolder-lease\n` };
            }
            return { stdout: '' };
        });
        await bareServicesRunner(exec, spawnRecording('', 0).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'old-1']);
        expect(calls).not.toContainEqual(['rm', '-f', 'own-1']);
        expect(calls).toContainEqual(['network', 'rm', 'old-net']);
        expect(calls).not.toContainEqual(['network', 'rm', 'own-net']);
    });

    it('fences leftover services before anything is created', async () => {
        const exec = daemon();
        await servicesRunner(exec, spawnRecording('', 0).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        const firstPsAt = calls.findIndex((a) => a[0] === 'ps');
        const createAt = calls.findIndex((a) => a[0] === 'network' && a[1] === 'create');
        // A dead previous attempt leaves its fleet behind — the same leftover the runner
        // container's rm catches, one layer out, and for the same reason.
        expect(firstPsAt).toBeGreaterThanOrEqual(0);
        expect(firstPsAt).toBeLessThan(createAt);
        expect(calls.slice(0, createAt).some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'svc-id-1')).toBe(true);
    });

    it('sends a refused service to the lease, after tearing down what did start', async () => {
        const exec = daemon({ serviceFails: true });
        const { fn, seen } = spawnRecording('', 0);
        await expect(servicesRunner(exec, fn).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not start service "stub"/
        );
        expect(seen).toHaveLength(0);
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'svc-id-1']);
        expect(calls).toContainEqual(['network', 'rm', networkName(job)]);
    });

    it('kill() takes the services and the network down with the runner', async () => {
        const exec = daemon();
        await servicesRunner(exec, spawnRecording('', 0).fn).kill(job);
        const calls = exec.mock.calls.map((call) => call[0]);
        // The runner is resolved through this attempt's own labels and killed by ID — never by
        // name, which a stale attempt's kill could otherwise compute against a replacement's
        // container. The hard kill takes the whole group: the supervisor and the exporter too.
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
            if (args[0] === 'network' && args[1] === 'create') {
                // The lease is lost while the network create is in flight; kill() is what the loop
                // calls, and it must be recorded before the create resolves.
                await handle.kill!(job);
                return { stdout: '' };
            }
            if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: 'svc-id-1\n' };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /killed while setting up services/
        );
        const calls = exec.mock.calls.map((call) => call[0]);
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
            if (args[0] === 'network' && args[1] === 'create') {
                if (!killedA) {
                    // A's lease is lost while its network create is in flight; the loop's kill()
                    // must be on record before the create resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseA!();
                }
                return { stdout: '' };
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
        // A's create was in flight when its kill landed; it went no further. Only B started a
        // service — and the last network created is B's, labeled like everything the attempt
        // stands up.
        const creates = exec.mock.calls.map((call) => call[0]).filter((a) => a[0] === 'network' && a[1] === 'create');
        expect(creates).toHaveLength(2);
        const services = exec.mock.calls.map((call) => call[0]).filter((a) => a.includes('--network-alias'));
        expect(services).toEqual([serviceRunArgs(attemptB, STUB)]);
        expect(creates.at(-1)).toEqual([
            'network',
            'create',
            '--label',
            `factory.job=${job.id}`,
            '--label',
            `factory.lease=${ATTEMPT_B}`,
            networkName(attemptB),
        ]);
        expect(seen).toHaveLength(1);
    });

    // The abort must not disturb a sibling attempt's fleet. In the gated world that needed a
    // teardown-FREE abort; in the scoped world the kill's teardown ISSUES its daemon calls and
    // is safe because of what it names: every ps carries A's lease, every removal carries A's
    // id or A's network name. B claims with a fresh token and stands its fleet up afterwards,
    // untouched — nothing A issued could resolve to it.
    it("scopes a killed attempt's teardown to its own lease, leaving a sibling attempt's fleet alone", async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        let killedA = false;
        let releaseKill: (() => void) | null = null;
        const killSettled = new Promise<void>((resolve) => {
            releaseKill = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'network' && args[1] === 'create') {
                if (!killedA) {
                    // A's lease is lost while its network create is in flight; kill() — its own
                    // teardown included — must be fully settled before the create resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseKill!();
                }
                return { stdout: '' };
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

    // A's close that lands LATE, over B's live fleet, two ways:
    // - killed: A was killed — kill() tore A's own fleet down while it was still legitimately A's
    //   own — and the loop re-claimed the job as B before A's CLI client finally exited (137).
    // - natural close: NO kill anywhere — the lease expires server-side and the board re-claims
    //   the job as B before any heartbeat delivers 'lost', so A's `killed` marker is never
    //   recorded. B's fence removes A's leftovers, which closes A's CLI client (0). Not-killed is
    //   not a free pass to skip the release — it runs unconditionally.
    // Either way the loop's release after A's verdict still runs its teardown, gate-free: the
    // teardown is scoped to A's lease, so whatever it names is A's own, and B's live fleet is
    // structurally unaddressable no matter how late the close lands.
    it.each([
        ["a killed attempt's", true, 137],
        ["a natural close's", false, 0],
    ])(
        'scopes %s late verdict teardown to its own lease when the replacement has stood its fleet up',
        async (_label, killA, closeCode) => {
            // Both children hold their close until released, so the interleaving — A still alive
            // while B stands its fleet up, then A's close landing over it — is the test's to pace.
            const closers: (() => void)[] = [];
            const gatedSpawn = ((_command: string, _argv: string[]) => {
                const c = new EventEmitter() as ChildProcess;
                const stream = () => {
                    const s = new EventEmitter() as Readable;
                    return s;
                };
                c.stdout = stream();
                c.stderr = stream();
                closers.push(() => process.nextTick(() => c.emit('close', closeCode)));
                return c;
            }) as unknown as typeof spawn;
            const closeOf = async (index: number): Promise<() => void> => {
                // Same macrotask yield as childAt above: the runner's env-file write is real fs on the
                // way to each spawn, and a microtask-only wait would starve it.
                while (closers.length <= index) await new Promise((r) => setImmediate(r));
                return closers[index]!;
            };

            const exec = vitest.fn(async (args: string[]) => {
                if (args[0] === 'run' && args.includes('--network-alias')) return { stdout: '' };
                if (args[0] === 'ps') return { stdout: psAnswer(args) };
                return { stdout: '' };
            });
            const runner = servicesRunner(exec, gatedSpawn);

            const runA = runner.run(attemptA, { id: SESSION, resume: false });
            const closeA = await closeOf(0); // A spawned; its CLI client is alive
            // Killed: the loop loses A's lease and kills the attempt — A's own fleet torn down while
            // it is still legitimately A's. Natural close: no kill in between; the heartbeat has not
            // yet told the loop A's lease is gone, and B's fence removes A's leftovers by label.
            if (killA) await runner.kill(attemptA);
            // B re-claims the same job id and stands a fresh fleet up.
            const runB = runner.run(attemptB, { id: SESSION, resume: false });
            await closeOf(1); // B spawned; its network and service are live
            const afterBCreation = exec.mock.calls.length;

            // A's CLI client only now exits — daemon slowness, or B's fence, makes the close
            // arbitrarily late — and its verdict lands over B's live fleet; the loop releases A's
            // services after it.
            closeA();
            await runA;
            await runner.releaseServices(attemptA);

            const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
            // The teardown ran — and every call of it is A's: the ps filters carry A's lease, the
            // removals carry A's id and A's network name, and nothing names B.
            expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
            expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
            expect(late).toContainEqual(['network', 'rm', networkName(attemptA)]);
            expect(late.every((a) => !touchesB(a))).toBe(true);

            // B is untouched and still finishes under its own verdict.
            closers[1]!();
            await expect(runB).resolves.toMatchObject({ exitCode: closeCode, started: true });
        }
    );

    // The late-kill twin of the two close tests above: the kill itself arrives AFTER the
    // replacement claimed the job and stood its fleet up — the heartbeat can be arbitrarily
    // slow to deliver the lease loss, and the claim loop has no per-job dedupe. There is no
    // gate to stop the kill, and none is needed: the kill resolves its target through A's own
    // lease label and kills by id, so the only container it can name is A's, and its teardown
    // is scoped the same way.
    it("scopes a kill that lands after the replacement stood its fleet up to the killed attempt's own lease", async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
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
            if (args[0] === 'network' && args[1] === 'create') {
                armed = true;
                return { stdout: '' };
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
    it("scopes a superseded spawn error's teardown to the failing attempt's own lease", async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
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
    it("keeps a replacement attempt unaddressable to a stale attempt's late kill across two runner instances", async () => {
        const d = labelDaemon({});
        const spawnA = gatedSpawns();
        const spawnB = gatedSpawns();
        const runner1 = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: spawnA.fn,
            })
        );
        const runner2 = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: spawnB.fn,
            })
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
    it("computes disjoint names per attempt for the same job id, and fences the previous attempt's leftovers by label", async () => {
        // The pure argv half: the names differ for the same job id.
        expect(containerName(attemptB)).not.toBe(containerName(attemptA));
        expect(networkName(attemptB)).not.toBe(networkName(attemptA));
        expect(serviceContainerName(attemptB, 'stub')).not.toBe(serviceContainerName(attemptA, 'stub'));

        // A's leftovers still exist on the daemon when B's run starts.
        const d = labelDaemon({});
        d.containers.set(containerName(attemptA), { 'factory.job': job.id, 'factory.lease': ATTEMPT_A });
        d.containers.set(serviceContainerName(attemptA, 'stub'), {
            'factory.job': job.id,
            'factory.lease': ATTEMPT_A,
            'factory.service': 'stub',
        });

        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: fn,
            })
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // The fence removed both of A's leftovers by label.
        expect(d.containers.has(containerName(attemptA))).toBe(false);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(false);
        // And B's own create and start are B-scoped: no name A could have been holding.
        const created = d.calls.find((a) => a[0] === 'create' && a.includes(containerName(attemptB)))!;
        expect(created[created.indexOf('--name') + 1]).toBe(containerName(attemptB));
        // The supervisor beside it carries B's names too.
        expect(d.calls.some((a) => a[0] === 'create' && a.includes(supervisorName(attemptB)))).toBe(true);
        expect(seen[0]).toEqual(['start', '-a', containerName(attemptB)]);
    });

    // The fence is the only job-scoped sweep, and this is its full inventory: every labeled
    // container of the job regardless of which attempt made it, every labeled network, and —
    // transitional — the legacy unlabeled network the pre-redesign name scheme left behind.
    // Anything not this job's is left alone.
    it('fences every leftover of the job by label — containers, networks, and the legacy network — and nothing else', async () => {
        const oldA = { ...job, leaseToken: 'aaaaaaaa-1111-4111-8111-111111111111' };
        const oldB = { ...job, leaseToken: 'bbbbbbbb-2222-4222-8222-222222222222' };
        const d = labelDaemon({});
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

        // The loop started B's services first; run()'s fence then sweeps, and the runner's create is
        // the first call after it, so snapshotting there is snapshotting the fence's outcome.
        let afterFence: { containers: string[]; networks: string[] } | null = null;
        const exec = async (args: string[]) => {
            if (!afterFence && args[0] === 'create') {
                afterFence = { containers: [...d.containers.keys()], networks: [...d.networks.keys()] };
            }
            return d.exec(args);
        };
        const { fn } = spawnRecording('ran\n', 0);
        const runner = asLoop(
            dockerRunner(readyWhileStarting(exec as unknown as (args: string[]) => Promise<{ stdout: string }>), {
                env: { RUNNER_SERVICES: '1' },
                spawn: fn,
            })
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // All four leftovers are gone; the other job's container is not this fence's business, and
        // this attempt's own fleet and network — started before run() — are spared.
        expect(afterFence!.containers.sort()).toEqual(
            [serviceContainerName(attemptB, 'stub'), 'someone-elses-runner'].sort()
        );
        expect(afterFence!.networks).toEqual([networkName(attemptB)]);
    });

    it('leaves the daemon alone when the switch is off', async () => {
        // RUNNER_SERVICES=0 explicitly: the default is on (services.test.ts pins that), and this
        // test is about the opt-out posture.
        const cfg = loadDriverConfig({ RUNNER_SERVICES: '0' });
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await createDockerRunner(
            cfg,
            fn,
            exec as unknown as (args: string[]) => Promise<{ stdout: string }>,
            { steps: fakeSteps().sink }
        ).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        // The fence is the runner's, not the services feature's, so its label and network
        // sweeps still run — but nothing services-specific happens: no readout, no network
        // create, no service containers, byte-identical runner argv. The one `--entrypoint`
        // run allowed is the close-time claude-code turn read, which is the runner's own.
        expect(calls.every((a) => !(a[0] === 'network' && a[1] === 'create'))).toBe(true);
        expect(calls.every((a) => !a.includes('--network-alias'))).toBe(true);
        expect(
            calls.every(
                (a) =>
                    !(a[0] === 'run' && a.includes('--entrypoint')) ||
                    a.some((x) => typeof x === 'string' && x.startsWith('CLAUDE_TRANSCRIPT_DIR='))
            )
        ).toBe(true);
        expect(seen[0]).toEqual(['start', '-a', containerName(job)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(job)))).toEqual(
            dockerArgs(cfg, job, { id: SESSION, resume: false }, { envFile: envFilePath(job) })
        );
    });

    it('reports a declared service that vanished from docker ps as dead (issue #471)', async () => {
        const base = daemon();
        let removedByHand = false;
        const exec = vitest.fn(async (args: string[]) =>
            removedByHand && args[0] === 'ps' ? { stdout: '' } : base(args)
        ) as unknown as ReturnType<typeof daemon>;
        const { fn } = spawnRecording('', 0);
        const runner = servicesRunner(exec, fn);
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        removedByHand = true; // `docker rm -f` of the stub service, between the run and the gates
        const dead = await runner.deadServices(job);
        expect(dead).toMatchObject([
            { name: 'stub', state: 'missing', exitCode: null, reason: 'container removed', logTail: '' },
        ]);

        // The attempt's teardown ends the declaration: nothing is expected of a released fleet.
        await runner.releaseServices(job);
        expect(await runner.deadServices(job)).toEqual([]);
    });

    const runningStub = JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State: 'running' });

    it("restartServices re-runs a removed service on the attempt's existing network (issue #560)", async () => {
        const base = daemon();
        let removedByHand = false;
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--network-alias')) removedByHand = false;
            if (args[0] === 'ps' && args.includes('{{json .}}')) return { stdout: removedByHand ? '' : runningStub };
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        removedByHand = true;
        const before = exec.mock.calls.length;

        await runner.restartServices(job, live);

        const calls = exec.mock.calls.slice(before).map((call) => call[0]);
        // The leftover goes by name, the service comes back on the SAME network — never the
        // whole teardown, which removes the network the gate containers join.
        expect(calls[0]).toEqual(['rm', '-f', serviceContainerName(job, 'stub')]);
        expect(calls[1]).toEqual(expect.arrayContaining(['--network', networkName(job), '--network-alias', 'stub']));
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(await runner.deadServices(job)).toEqual([]);

        await runner.releaseServices(job);
    });

    it('restartServices stops on a stand-down and removes the service it started again (issue #560)', async () => {
        const base = daemon();
        const stand = new AbortController();
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'run' && args.includes('--network-alias') && stand.signal.aborted === false) {
                // The Stop lands while the replacement is being started.
                const answer = await base(args);
                stand.abort();
                return answer;
            }
            if (args[0] === 'ps' && args.includes('{{json .}}')) return { stdout: '' };
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        const before = exec.mock.calls.length;

        await expect(runner.restartServices(job, stand.signal)).rejects.toThrow(
            'the restart was abandoned: the attempt stood down'
        );
        const calls = exec.mock.calls.slice(before).map((call) => call[0]);
        expect(calls.at(-1)).toEqual(['rm', '-f', serviceContainerName(job, 'stub')]);
        expect(calls.some((a) => a[0] === 'ps')).toBe(false);
    });

    it('restartServices throws when the daemon refuses the service again (issue #560)', async () => {
        const base = daemon();
        let refuse = false;
        const exec = vitest.fn(async (args: string[]) => {
            if (refuse && args[0] === 'run' && args.includes('--network-alias')) throw new Error('no such network');
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        refuse = true;

        await expect(runner.restartServices(job, live)).rejects.toThrow(
            'could not start service "stub": no such network'
        );

        await runner.releaseServices(job);
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

    it('caps the fallback title at 144 characters', () => {
        const capped = publishPlan({ ...job, command: 'y'.repeat(200) }, NOW);
        expect(capped.title).toBe('y'.repeat(144));
        expect(capped.issueNumber).toBeNull();
    });

    it('plans the same branch and closure from the bare /fix <number> form', () => {
        expect(publishPlan({ ...job, command: '/fix 100' }, NOW)).toEqual({
            branch: 'fix/100',
            title: '/fix 100 (#100)',
            issueNumber: 100,
        });
        const hashed = publishPlan({ ...job, command: '/fix #44' }, NOW);
        expect(hashed.branch).toBe('fix/44');
        expect(hashed.issueNumber).toBe(44);
        expect(publishPlan({ ...job, command: '/fix https://github.com/o/r/issues/44' }, NOW).issueNumber).toBe(44);
    });

    it('does not name an issue from a command that merely looks like /fix', () => {
        expect(publishPlan({ ...job, command: '/fix-a 100' }, NOW)).toEqual({
            branch: 'task/20260909',
            title: '/fix-a 100',
            issueNumber: null,
        });
    });

    it("closes the thread root's issue when a follow-up publishes", () => {
        // `/fix 122` failed its gates; the follow-up `both OK` is the run that publishes.
        const followUp = { ...job, command: 'both OK', rootCommand: '/fix 122' };
        expect(publishPlan(followUp, NOW).issueNumber).toBe(122);
        // A root that names no issue leaves the follow-up's own command to name one.
        expect(publishPlan({ ...job, command: 'now /fix 9', rootCommand: 'tidy' }, NOW).issueNumber).toBe(9);
        expect(publishPlan({ ...job, command: 'both OK', rootCommand: 'tidy' }, NOW).issueNumber).toBeNull();
    });

    it('prefers the /fix target over an incidental #mention', () => {
        expect(publishPlan({ ...job, command: '/fix 44 but really #9' }, NOW)).toEqual({
            branch: 'fix/44',
            title: '/fix 44 but really #9 (#44)',
            issueNumber: 44,
        });
    });

    it('rejects lookalike and impossible issue numbers', () => {
        // A trailing word character means the digits were the prefix of a longer token.
        expect(publishPlan({ ...job, command: '/fix 44oops' }, NOW).issueNumber).toBeNull();
        expect(publishPlan({ ...job, command: 'see #44oops' }, NOW).issueNumber).toBeNull();
        // Zero is no issue, and past the safe-integer range the number is not honest.
        expect(publishPlan({ ...job, command: '/fix 0' }, NOW).issueNumber).toBeNull();
        expect(publishPlan({ ...job, command: '/fix 99999999999999999999' }, NOW).issueNumber).toBeNull();
        // A sentence period after the reference is punctuation, not a longer number.
        expect(publishPlan({ ...job, command: 'fix #44.' }, NOW).issueNumber).toBe(44);
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
            `/workspaces/bellows/${USER}/.worktrees/${ROOT}`
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
        for (const job of broken) expect(worktreeRelDir(job), job.repo ?? undefined).toBeNull();
    });

    it('runs a repo job inside its worktree, and a repo-less job at the member root', () => {
        const withRepo = dockerArgs(
            loadDriverConfig({}),
            repoJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(withRepo).toContain(`WORKDIR=/workspaces/bellows/${USER}/.worktrees/${job.id}`);
        // A command-only job names no repo: no worktree exists, and the member root is where it
        // always started — the argv stays byte-identical to what it was.
        expect(
            dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).toContain(`WORKDIR=/workspaces/bellows/${USER}`);
    });

    it('refuses to run a repo job whose worktree path cannot be asserted', () => {
        expect(() =>
            dockerArgs(loadDriverConfig({}), { ...repoJob, rootJobId: 'not-a-uuid' }, { id: SESSION, resume: false })
        ).toThrow(/worktree/);
    });

    // What the sync does is executed for real in worktree*.test.ts and scripts-worktree-lock.test.ts;
    // these pins have no behavioural twin.
    it('runs every git call of the sync without a shell, and anchors the transient marker', () => {
        expect(gitWorktreeScript).toContain('execFileSync');
        expect(gitWorktreeScript).not.toContain('execSync(');
        // A rebase that fails without a conflict aborts itself — the worktree never sits
        // mid-rebase — and the refusal names what happened.
        expect(gitWorktreeScript).toContain("inw('rebase', '--abort')");
        expect(gitWorktreeScript).toContain('rebased onto');
        expect(TRANSIENT_SYNC_REASON.test('transient worktree sync: still held')).toBe(true);
        // Anchored at the head: ordinary refusal reasons splice member-controlled git stderr,
        // and a conflicted file named after the marker must never read as transient.
        expect(TRANSIENT_SYNC_REASON.test('conflict in transient worktree sync.md')).toBe(false);
    });

    it('hands the sync the clone, the worktree and the branch, by env', async () => {
        const supervised = syncSteps();
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const [sync] = supervised.ofKind('sync');
        expect(sync?.argv).toEqual(['node', '-e', gitWorktreeScript]);
        // The clone — where origin lives and the worktree is created FROM. Paths, not credentials:
        // the claim env rides the step's own env, exactly as it rode the env file.
        expect(sync?.env).toMatchObject({
            REPO: `/workspaces/bellows/${USER}/factory`,
            WORKTREE: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
            BRANCH: `factory/${job.id}`,
        });
        // The step goes to the attempt's supervisor, under the control token only it holds.
        expect(supervised.submitted.map((entry) => entry.token)).toEqual([CONTROL_TOKEN]);
        // The supervisor mounts the job's own subtree — the same scoping every other container
        // this runner starts gets, nothing broader — and the sync starts no container of its own.
        const create = d.calls.find((a) => a[0] === 'create' && a.includes(supervisorName(repoJob)))!;
        expect(create).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            ])
        );
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });

    // git reads no token from the environment, so a private-repo fetch needs the same token-backed
    // helper the push uses. It rides CONDITIONALLY: only beside the token the board minted for this
    // sync (docs/connections.md), because a public repo must keep its plain unauthenticated fetch
    // (a helper answering an empty password would break it). The VALUE passed is helper CODE,
    // never the credential — the token itself travels only in the step env, where the helper reads it.
    it("hands the sync the credential-helper code only beside the board's minted token", async () => {
        const supervised = syncSteps();
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        await runner.syncCheckout(repoJob, undefined, null, 't0k-3n');
        const [withToken] = supervised.ofKind('sync');
        expect(withToken?.env).toMatchObject({ CRED_HELPER: CREDENTIAL_HELPER, GITHUB_TOKEN: 't0k-3n' });
        // The token itself rides the step, never argv — the step's or the daemon's.
        expect(withToken?.argv.some((arg) => arg.includes('t0k-3n'))).toBe(false);
        expect(d.calls.flat().some((arg) => arg.includes('t0k-3n'))).toBe(false);

        // No minted token keeps the plain fetch — and a claim value under the reserved name is no
        // token: it is dropped, never forwarded.
        await runner.syncCheckout({ ...repoJob, env: { GITHUB_TOKEN: 'claim-pat', CORE_TOKEN: 'shh' } });
        const plain = supervised.ofKind('sync')[1];
        expect(plain?.env).not.toHaveProperty('CRED_HELPER');
        expect(plain?.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(plain?.env).toMatchObject({ CORE_TOKEN: 'shh' });

        // An EMPTY token is no token: the helper would answer an empty password and break the
        // public-repo plain fetch it exists to preserve.
        await runner.syncCheckout(repoJob, undefined, null, '');
        expect(supervised.ofKind('sync')[2]?.env).not.toHaveProperty('CRED_HELPER');
    });

    // A claim that CONTINUES a session — a follow-up — is mid-task, and git operations that touch
    // the remote belong to the task's beginning and end (issue #58). Its sync is a RESTORE: the
    // step runs with RESTORE=1 and carries NO claim env at all (restore talks only to the local
    // clone — nothing to credential), and the fetch's helper code is absent even beside a token.
    it('restores a claim that continues a session instead of syncing it', async () => {
        const supervised = syncSteps();
        const runner = dockerRunner(emptyDaemon, { steps: supervised.sink });

        await runner.syncCheckout({ ...repoJob, followUp: true }, undefined, null, 't0k-3n');
        const [follow] = supervised.ofKind('sync');
        expect(follow?.env).toMatchObject({ RESTORE: '1' });
        expect(follow?.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(follow?.env).not.toHaveProperty('CRED_HELPER');

        // A claim carrying a resume session (resumeSessionId without the followUp flag) is the
        // same mid-task hazard: the session's tree must not move under it either.
        await runner.syncCheckout({ ...repoJob, resumeSessionId: SESSION }, undefined, null, 't0k-3n');
        const parked = supervised.ofKind('sync')[1];
        expect(parked?.env).toMatchObject({ RESTORE: '1' });
        expect(parked?.env).not.toHaveProperty('GITHUB_TOKEN');

        // A starting claim beside a token keeps the sync shape: no RESTORE, the token on.
        await runner.syncCheckout(repoJob, undefined, null, 't0k-3n');
        const fresh = supervised.ofKind('sync')[2];
        expect(fresh?.env).not.toHaveProperty('RESTORE');
        expect(fresh?.env).toMatchObject({ GITHUB_TOKEN: 't0k-3n' });
    });

    /* The terminal reclaim (issue #47): the one step that undoes the sync, naming only the clone
     * and the tree — no BRANCH, no credential helper, no claim env. The thread has no attempt, so
     * it runs in a supervisor-only group of its own, under a token of its own, and ends it. */
    it('reclaims the worktree through a supervisor-only group of its own, naming only paths', async () => {
        const d = labelDaemon();
        const { endpoint, closed } = reclaimEndpoint();
        const supervised = fakeSteps((step) =>
            ok(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}' : '')
        );
        const runner = dockerRunner(d.exec, { steps: supervised.sink, endpoint });
        const result = await runner.reclaimWorktree({ ...repoJob, env: { GITHUB_TOKEN: 't0k-3n' } });

        expect(result).toEqual({ ok: true, removed: true, reason: null });
        const [reclaim] = supervised.ofKind('reclaim');
        expect(reclaim?.argv).toEqual(['node', '-e', gitWorktreeRemoveScript]);
        // Reclaim touches no credential and no branch: the thread is terminal, so there is no
        // fetch to authenticate and no follow-up branch to preserve.
        expect(reclaim?.env).toEqual({
            REPO: `/workspaces/bellows/${USER}/factory`,
            WORKTREE: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        });
        // Under the token its own endpoint opened — not the attempt's — and ended with the group.
        expect(supervised.submitted.every((entry) => entry.token === RECLAIM_TOKEN)).toBe(true);
        expect(supervised.ofKind('finish')).toHaveLength(1);
        expect(closed).toEqual([RECLAIM_TOKEN]);
        // A supervisor and nothing else, under a lease of its own, with the control pair off argv;
        // it mounts the job's own subtree like the sync it undoes, and it is gone afterwards.
        const creates = d.calls.filter((a) => a[0] === 'create');
        expect(creates).toHaveLength(1);
        const create = creates[0]!;
        expect(create).toContain('--entrypoint');
        expect(create.some((arg) => arg.includes(repoJob.leaseToken))).toBe(false);
        expect(create.join(' ')).not.toContain(RECLAIM_TOKEN);
        expect(create).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            ])
        );
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
        expect(d.containers.size).toBe(0);
    });

    it('refuses a reclaim by saying this driver has no supervisor endpoint to run it through', async () => {
        const supervised = fakeSteps();
        const runner = dockerRunner(emptyDaemon, { steps: supervised.sink });

        const result = await runner.reclaimWorktree(repoJob);

        expect(result).toMatchObject({ ok: false, removed: false });
        expect(result.reason).toContain('no supervisor endpoint');
        expect(supervised.steps()).toEqual([]);
    });

    it('reclaims nothing, run untouched, for a job that never had a worktree', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec);
        expect(await runner.reclaimWorktree(job)).toEqual({ ok: true, removed: false, reason: null });
        expect(calls).toHaveLength(0);
    });

    /*
     * An unreadable sync/reclaim verdict names why — what the step printed — and a step that
     * exited non-zero says it in the tool's own words. (A RESOLVED unreadable verdict is by
     * construction an exit-0 step.)
     */
    it('names what the sync step printed when its answer is not a verdict', async () => {
        const supervised = syncSteps('fetching origin\nfatal: could not read from remote repository\n');
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('the worktree sync answered nothing readable');
        expect(result.reason).toContain('fatal: could not read from remote repository');
    });

    it('names a sync step that printed nothing readable', async () => {
        const result = await dockerRunner(emptyDaemon, { steps: syncSteps('').sink }).syncCheckout(repoJob);

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/^the worktree sync answered nothing readable/);
    });

    it('says why a sync step that exited non-zero failed, in the tool’s own words', async () => {
        const supervised = fakeSteps(() => ({
            exitCode: 128,
            stdout: '',
            stderr: 'fatal: unable to access the remote',
            timedOut: false,
        }));
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        expect(result).toEqual({ ok: false, reason: 'the worktree sync failed: fatal: unable to access the remote' });
    });

    /*
     * Issue #559: a sync that never lands (a fetch stalled on the network) would hold its clone's
     * queue, and every sibling behind it, forever. The step carries the sync deadline, which the
     * supervisor enforces — it kills the step's process and answers `timedOut` — and the run fails
     * like a sync the kubelet ended. Nothing of the step outlives the answer, so there is nothing
     * further to wait out.
     */
    it('bounds the sync step by the sync deadline, and fails the run when the supervisor ends it there', async () => {
        const supervised = fakeSteps(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        const [sync] = supervised.ofKind('sync');
        expect(sync?.timeoutMs).toBe(SYNC_DEADLINE_MS);
        expect(result).toMatchObject({
            ok: false,
            reason: `the worktree sync failed: the step exceeded its ${SYNC_DEADLINE_MS}ms deadline`,
        });
        expect(TRANSIENT_SYNC_REASON.test(result.reason ?? '')).toBe(false);
        expect(result.settled).toBeUndefined();
    });

    // The sync is never abandoned mid-write: a stand-down — or an attempt whose channel closed —
    // kills the whole group instead, which rejects the step. The loop leaves the job to its lease,
    // and the group is gone from the daemon.
    it('removes the group and throws when the channel closes under the sync', async () => {
        const d = labelDaemon();
        const sink: StepSink = {
            submit: () => Promise.reject(new Error('the task supervisor channel closed before its step was answered')),
            awaitReport: () => Promise.resolve(FINALIZED),
            contacted: () => true,
        };
        const runner = dockerRunner(d.exec, { steps: sink });

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow('channel closed');

        expect(d.calls).toContainEqual(['rm', '-f', supervisorName(repoJob)]);
        expect(d.containers.size).toBe(0);
        // Nothing is remembered of the group: the next sync creates one afresh.
        const created = d.calls.filter((a) => a[0] === 'create').length;
        await expect(runner.syncCheckout(repoJob)).rejects.toThrow('channel closed');
        expect(d.calls.filter((a) => a[0] === 'create').length).toBe(created * 2);
    });

    // Issue #559: the contention verdict reaches the loop unchanged — the anchored marker is what
    // hands the claim back to the board — and the sync never shortens the script's lock wait.
    it('passes checkout contention through as the transient reason, with the shipped lock wait', async () => {
        const reason =
            'transient worktree sync: the checkout lock /w/.git/factory-sync.lock is still held after 20000ms';
        const supervised = syncSteps(`${JSON.stringify({ ok: false, reason })}\n`);
        const runner = dockerRunner(emptyDaemon, { steps: supervised.sink });

        const result = await runner.syncCheckout(repoJob);

        expect(result).toMatchObject({ ok: false, reason });
        expect(TRANSIENT_SYNC_REASON.test(result.reason ?? '')).toBe(true);
        expect(
            Object.keys(supervised.ofKind('sync')[0]!.env).some((name) => name.startsWith('SYNC_LOCK_WAIT_MS'))
        ).toBe(false);
    });

    it('carries the script’s failure kind through the sync step’s stdout (issue #666)', async () => {
        const verdict = { ok: false, reason: 'the repository clone /w/r does not exist', kind: 'missing_clone' };
        const runner = dockerRunner(emptyDaemon, { steps: syncSteps(`${JSON.stringify(verdict)}\n`).sink });

        expect(await runner.syncCheckout(repoJob)).toMatchObject(verdict);
    });

    it('names why the reclaim verdict was unreadable', async () => {
        const { runner } = reclaimRunner('rm: permission denied\n');
        const result = await runner.reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.removed).toBe(false);
        expect(result.reason).toContain('the worktree reclaim answered nothing readable');
        expect(result.reason).toContain('rm: permission denied');
    });

    it('answers the refusal verbatim when the reclaim script refuses', async () => {
        const { runner } = reclaimRunner(
            '{"ok":false,"removed":false,"reason":"refusing to remove /x: a git tree that is not a registered worktree"}'
        );
        const result = await runner.reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('registered worktree');
    });

    // The fence before the sync (PR #46 review): the loop calls syncCheckout before the
    // runner's own fence, so the sweep has to come here — the sync is the first writer on the
    // task worktree, and starting it over a previous attempt's live runner would mix edits.
    it('sweeps the job label before the sync step is asked of a group', async () => {
        const d = labelDaemon();
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const shapes = d.calls.map((a) => a[0]);
        expect(shapes).toContain('ps');
        expect(shapes.indexOf('ps')).toBeLessThan(shapes.indexOf('create'));
        expect(shapes.indexOf('create')).toBeLessThan(shapes.indexOf('start'));
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    // The replacement-with-an-active-previous-runner shape of the review comment: the old
    // attempt's runner is still on the daemon when the replacement's sync starts, and the
    // fence's removal must land BEFORE the sync's group is created — not after it.
    it('removes a previous attempt’s still-running runner before the sync runs', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const NEW_TOKEN = 'bbbbbbbb-2222-4222-8222-222222222222';
        const d = labelDaemon();
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const runner = dockerRunner(d.exec, { steps: syncSteps().sink });
        const next = { ...repoJob, leaseToken: NEW_TOKEN };
        const result = await runner.syncCheckout(next);

        expect(result).toEqual({ ok: true, reason: null });
        // The previous runner is off the daemon; what is there is the new attempt's own group.
        expect([...d.containers.keys()]).toEqual([supervisorName(next)]);
        const rmIndex = d.calls.findIndex((a) => a[0] === 'rm');
        const createIndex = d.calls.findIndex((a) => a[0] === 'create');
        expect(rmIndex).toBeGreaterThanOrEqual(0);
        expect(rmIndex).toBeLessThan(createIndex);
    });

    // A fence that converts a failed `docker ps` into an empty answer reads "nothing left" —
    // and the sync would start while a previous attempt's runner is still writing the worktree.
    // The fence is infrastructure, not the command's verdict: it must throw, and the loop's
    // try/catch around syncCheckout leaves the job to its lease. The same holds for every verb
    // of the fence, with the leftover the refused verb would have touched seeded.
    it.each<[string, (args: string[]) => string | null, 'container' | 'network' | null]>([
        [
            'cannot list the job’s leftover containers',
            (args) => (args[0] === 'ps' ? 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' : null),
            null,
        ],
        [
            'cannot list the job’s stale networks',
            (args) => (args[0] === 'network' && args[1] === 'ls' ? 'Cannot connect to the Docker daemon' : null),
            null,
        ],
        [
            'a leftover container refuses to be removed',
            (args) => (args[0] === 'rm' ? 'Error: cannot remove container: device is busy' : null),
            'container',
        ],
        [
            'a leftover network refuses to be removed',
            (args) => (args[0] === 'network' && args[1] === 'rm' ? 'Error: cannot remove network: in use' : null),
            'network',
        ],
    ])('fails the sync when the fence %s', async (_label, fail, leftover) => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = labelDaemon({ fail });
        const labels = { 'factory.job': job.id, 'factory.lease': OLD_TOKEN };
        if (leftover === 'container') d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), labels);
        if (leftover === 'network') d.networks.set(networkName({ ...job, leaseToken: OLD_TOKEN }), labels);
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/re-claim fence/);
        // No group, and no sync step, over an unfenced checkout: the throw precedes both.
        expect(d.calls.some((a) => a[0] === 'create')).toBe(false);
        expect(supervised.steps()).toEqual([]);
    });

    // The one tolerated shape: a container exiting between the fence's ps and its rm answers
    // "No such container" — the fence SUCCEEDED, the runner is gone. Failing there would burn
    // attempts on the daemon confirming a removal already finished.
    it('proceeds when the fence’s rm answers that the container is already gone', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = labelDaemon({
            fail: (args) =>
                args[0] === 'rm'
                    ? `Error response from daemon: No such container: ${containerName({ ...job, leaseToken: OLD_TOKEN })}`
                    : null,
        });
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        expect(await runner.syncCheckout(repoJob)).toEqual({ ok: true, reason: null });
        expect(d.calls.some((a) => a[0] === 'create' && a.includes(supervisorName(repoJob)))).toBe(true);
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    it('runs every publish step inside the task worktree', async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.publishGit!(ISSUE_JOB);

        const wt = `/workspaces/bellows/${USER}/.worktrees/${job.id}`;
        expect(steps.steps().length).toBeGreaterThan(0);
        for (const step of steps.steps()) {
            if (step.argv.some((x) => x.includes('shortstat'))) {
                // The summarizer (issue #82) is anchored like every git step — the task
                // worktree as its working directory, never the image default, where git would find
                // no repo and the summary would silently degrade to the command title. Pinned
                // explicitly, because its failure mode is the quiet one.
                expect(step.cwd).toBe(wt);
            } else if ('LEDGER' in step.env) {
                // The publication ledger is a file under the worktree, named by path.
                expect(step.env.LEDGER?.startsWith(`${wt}/`)).toBe(true);
            } else if (step.argv.some((x) => x.includes('execFileSync'))) {
                // The probe runs at the mount root and reads the repo by REPO.
                expect(step.env).toMatchObject({ REPO: wt });
            } else {
                expect(step.cwd).toBe(wt);
            }
        }
        // The steps run in the supervisor, which mounts the job's own subtree — the publish never
        // sees another member's tree.
        const create = docker.find((a) => a[0] === 'create' && a.includes(supervisorName(ISSUE_JOB)))!;
        expect(create).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            ])
        );
    });

    // The loop asks the board for a token right before the push (docs/connections.md); the env the
    // steps ride must carry THAT credential, and a claim value under the reserved name never.
    it("publishes with the board's minted token, never a claim value", async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN);
        const result = await runner.publishGit!(ISSUE_JOB, 'ghs_fresh');

        expect(result.ok).toBe(true);
        const credentialed = steps.steps().filter((step) => 'GITHUB_TOKEN' in step.env);
        expect(credentialed.length).toBeGreaterThan(0);
        for (const step of credentialed) expect(step.env.GITHUB_TOKEN).toBe('ghs_fresh');
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
        // Credentials ride the step and nothing else: never the daemon's argv.
        expect(docker.flat().join(' ')).not.toContain('ghs_fresh');
    });

    // Executor parity for the publish flag (docs/workflows.md): the flag is read in exactly ONE
    // place — the loop, shared by both executors — so this transport must have no opinion of its
    // own. The loop tests pin that a publish:false claim never reaches publishGit; this pins the
    // other half, that the docker transport grew no gate of its own to drift against.
    // Issue #825, executor parity: a bound publish's tree check rides the supervisor's steps here
    // exactly as under kubernetes — staged hook-free, the commit held to that tree.
    it.each([
        ['pushes when the commit holds the staged tree', {}, true],
        ['refuses stale, pushing nothing, when a commit hook moved it', { committed: 'b'.repeat(40) }, false],
    ])('a bound publish %s', async (_case, trees, published) => {
        const bound = { ...DIRTY_ON_MAIN, fingerprint: 'h:1' };
        const { steps, runner } = publishRunner(bound, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
            trees,
        });

        const result = await runner.publishGit!(ISSUE_JOB, undefined, { revision: 'h:1' });

        expect(result).toMatchObject(published ? { ok: true, published } : { ok: false, stale: true });
        const argvs = steps.steps().map((step) => step.argv);
        expect(argvs.some((a) => a.includes('write-tree') && a.includes('core.hooksPath=/dev/null'))).toBe(true);
        expect(argvs.some((a) => a.includes('push'))).toBe(published);
    });

    it('leaves the publish decision to the loop: publishGit ignores a publish:false claim', async () => {
        const { steps, runner } = publishRunner(DIRTY_ON_MAIN);
        const result = await runner.publishGit!({ ...ISSUE_JOB, publish: false });

        expect(result.ok).toBe(true);
        expect(steps.steps().length).toBeGreaterThan(0);
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
        expect(
            parseGitState(
                '{"cloned":true,"branch":"fix/10","defaultBranch":"main","dirty":true,"unpushed":2,"hasIdentity":false}'
            )
        ).toEqual({
            cloned: true,
            branch: 'fix/10',
            defaultBranch: 'main',
            dirty: true,
            unpushed: 2,
            hasIdentity: false,
            fingerprint: null,
            conflicts: [],
            rebasing: false,
        });
        expect(parseGitState('{"cloned":true,"fingerprint":"abc:def"}').fingerprint).toBe('abc:def');
        expect(parseGitState('')).toEqual({
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
            conflicts: [],
            rebasing: false,
        });
    });

    it('parses the PR summary’s answer, defaulting anything missing', () => {
        expect(parsePrSummary('{"title":"Fix the fence","body":"## Commits"}')).toEqual({
            title: 'Fix the fence',
            body: '## Commits',
        });
        expect(parsePrSummary('{"title":"","body":null}')).toEqual({ title: null, body: null });
        expect(parsePrSummary('')).toEqual({ title: null, body: null });
        expect(parsePrSummary('git: fatal: not a git repository')).toEqual({ title: null, body: null });
    });

    /**
     * The supervisor stood in: the probe answers from `state`, git steps mutate nothing, and every
     * step the runner submits is recorded, so the flow — what ran, in which order, and what was
     * skipped — is the assertion. A step is a request over the control channel, never a container:
     * the daemon only ever sees the group (the supervisor), recorded in `docker`.
     */
    const publishRunner = (
        state: Record<string, unknown>,
        opts: {
            prExists?: boolean;
            fail?: ((argv: string[]) => boolean) | undefined;
            /** The step's stderr, as the supervisor answers it beside a non-zero exit. */
            failStderr?: string;
            summary?: Record<string, unknown>;
            exec?: (args: string[]) => Promise<{ stdout: string }>;
            /** What a bound publish's staged and committed trees read (issue #825); default both one tree. */
            trees?: { staged?: string; committed?: string };
        } = {}
    ) => {
        const docker: string[][] = [];
        const steps = fakeSteps((step) => {
            const argv = step.argv;
            if (opts.fail?.(argv)) {
                return { exitCode: 1, stdout: '', stderr: opts.failStderr ?? 'step refused', timedOut: false };
            }
            // The publication ledger answers "never recorded", and HEAD is a commit.
            if ('LEDGER' in step.env) return ok('{}');
            if (argv.includes('write-tree')) return ok(`${opts.trees?.staged ?? 't'.repeat(40)}\n`);
            if (argv.includes('HEAD^{tree}')) return ok(`${opts.trees?.committed ?? 't'.repeat(40)}\n`);
            if (argv.includes('rev-parse')) return ok(`${'a'.repeat(40)}\n`);
            // The probe's marker rides INSIDE the -e script string; the git steps carry their
            // subcommand as a standalone argv element. The PR summarizer (issue #82) is the
            // second node step — told apart by the git argv its script embeds.
            if (argv.some((a) => a.includes('execFileSync'))) {
                if (argv.some((a) => a.includes('shortstat'))) return ok(JSON.stringify(opts.summary ?? SUMMARY));
                return ok(JSON.stringify(state));
            }
            if (argv.includes('pr') && argv.includes('view')) {
                if (opts.prExists) return ok(`${PR_URL}\n`);
                return { exitCode: 1, stdout: '', stderr: 'no pull requests', timedOut: false };
            }
            if (argv.includes('pr') && argv.includes('create')) return ok(`${PR_URL}\n`);
            return ok();
        });
        const exec =
            opts.exec ??
            (vitest.fn(async (args: string[]) => {
                docker.push(args);
                return { stdout: args[0] === 'wait' ? '0\n' : '' };
            }) as unknown as (args: string[]) => Promise<{ stdout: string }>);
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: steps.sink });
        return { steps, docker, runner };
    };

    const DIRTY_ON_MAIN = {
        cloned: true,
        branch: 'main',
        defaultBranch: 'main',
        dirty: true,
        unpushed: 0,
        hasIdentity: false,
    };

    /** What the PR summarizer answers (issue #82): what the branch did, not what was asked. */
    const SUMMARY = { title: 'Fix the sync re-claim fence', body: '## Commits\n\n- Fix the sync re-claim fence' };

    const argvsOf = (steps: ReturnType<typeof fakeSteps>): string[][] => steps.steps().map((step) => step.argv);

    const shapesOf = (steps: ReturnType<typeof fakeSteps>): string[] =>
        steps.steps().map(({ argv: a, env }) => {
            // The publication ledger (publish-reconcile.ts) is a node step keyed by its LEDGER path.
            if ('LEDGER' in env) return 'ledger';
            if (a.includes('rev-parse')) return 'rev-parse';
            if (a.some((x) => x.includes('execFileSync'))) {
                return a.some((x) => x.includes('shortstat')) ? 'summary' : 'probe';
            }
            if (a.includes('switch')) return 'switch';
            if (a.includes('add')) return 'add';
            if (a.includes('reset')) return 'reset';
            if (a.includes('commit')) return 'commit';
            if (a.includes('push')) return 'push';
            if (a.includes('view')) return 'pr-view';
            if (a.includes('create')) return 'pr-create';
            return 'other';
        });

    // The post-gate tree read: one probe step over the worktree, with no claim env.
    it('probes the tree fingerprint with one env-less step', async () => {
        const { steps, runner } = publishRunner({ ...DIRTY_ON_MAIN, fingerprint: 'h:1' });

        expect(await runner.probeTree?.(ISSUE_JOB)).toBe('h:1');

        expect(shapesOf(steps)).toEqual(['probe']);
        const [probe] = steps.ofKind('probe');
        expect(probe?.env).toEqual({ REPO: worktreeDir(loadDriverConfig({}), ISSUE_JOB) });
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
    });

    // A Stop while the probe step is in flight ends the wait for its answer, never the supervisor.
    it('hands the stand-down signal to the probe step and answers null once it aborts', async () => {
        const cancel = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const sink: StepSink = {
            submit: async (_token, _step, signal) => {
                seen.push(signal);
                cancel.abort();
                throw new Error('step was cancelled');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            contacted: () => true,
        };
        const exec = (async () => ({ stdout: '' })) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: sink });

        expect(await runner.probeTree?.(ISSUE_JOB, cancel.signal)).toBeNull();

        expect(seen).toEqual([cancel.signal]);
    });

    it.each([
        ['answers no fingerprint', {}, undefined],
        ['fails', {}, () => true],
    ])('answers null when the probe %s', async (_label, extra, fail) => {
        const { runner } = publishRunner({ ...DIRTY_ON_MAIN, ...extra }, { fail });
        expect(await runner.probeTree?.(ISSUE_JOB)).toBeNull();
    });

    it('branches, commits, pushes and opens the PR — in that order', async () => {
        // The checkout sits on main with no fix branch yet: the plain switch refuses (no such
        // branch), and `-c` creates it — both calls are part of the expected shape.
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        const result = await runner.publishGit!(ISSUE_JOB, 'ghs_minted');

        expect(result).toEqual({
            ok: true,
            published: true,
            branch: 'fix/10',
            prUrl: PR_URL,
            reason: null,
            repository: 'Bellows-AI/factory',
            baseBranch: 'main',
            prNumber: 42,
            cause: null,
        });
        const calls = argvsOf(steps);
        expect(shapesOf(steps)).toEqual([
            'probe',
            'switch',
            'switch',
            'add',
            'reset',
            'commit',
            // The operation (`branch@sha`) is named and recorded in the publication ledger around
            // each effect, so a retry after a lost answer reads what happened instead of redoing it.
            'rev-parse',
            'ledger',
            'push',
            'ledger',
            'pr-view',
            'summary',
            'pr-create',
            'ledger',
        ]);
        // The decisions are publishCheckout's (publish-checkout.test.ts); this is their supervised
        // rendering. A step that needs the claim env gets it as its own env, never on argv — and
        // nowhere in what the daemon was asked.
        const pushStep = steps.steps().find((step) => step.argv.includes('push'))!;
        expect(pushStep.argv).toContain('--force-with-lease');
        expect(pushStep.env).toMatchObject({ GITHUB_TOKEN: 'ghs_minted' });
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
        expect(calls.flat().join(' ')).not.toContain('ghs_minted');
        expect(docker.flat().join(' ')).not.toContain('ghs_minted');
        // A step's literal envs ride as env, and a step that needs no credential carries none.
        const summary = steps.steps().find((step) => step.argv.some((x) => x.includes('shortstat')))!;
        expect(summary.env).toEqual({
            BASE: 'origin/main',
            BACKSTOP_TITLE: '/fix https://github.com/Bellows-AI/factory/issues/10 (#10)',
        });
        // The summarizer's stdout reaches the PR through this transport.
        const create = calls.find((a) => a.includes('pr') && a.includes('create'));
        expect(create?.[create.indexOf('--title') + 1]).toBe('Fix the sync re-claim fence (#10)');
    });

    // The acceptance of #771: a sync or a publish step is a request to the task supervisor, never a
    // `docker run`. The daemon is asked for the group's own containers and nothing else.
    it('starts no container of its own for a sync or a publish step', async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.syncCheckout(ISSUE_JOB);
        await runner.publishGit!(ISSUE_JOB);

        expect(steps.steps().length).toBeGreaterThan(0);
        expect(docker.some((a) => a[0] === 'run')).toBe(false);
        const created = docker.filter((a) => a[0] === 'create').map((a) => a[a.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(ISSUE_JOB)]);
    });

    // Issue #581: the board recovers a failed publish by its cause, read from the step's own words.
    it('names a rejected non-fast-forward push a conflict', async () => {
        const { runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('push'),
            failStderr: ' ! [rejected]        HEAD -> fix/10 (non-fast-forward)\nerror: failed to push some refs',
        });
        const result = await runner.publishGit!(ISSUE_JOB);

        expect(result).toMatchObject({ ok: false, published: false, cause: 'conflict' });
    });

    // The group the publish needs is infrastructure: a daemon that refuses it is thrown to the
    // loop — never a publish verdict, and no step is asked of a supervisor that does not exist.
    it('throws, submitting nothing, when the daemon refuses the group a publish needs', async () => {
        const { steps, runner } = publishRunner(DIRTY_ON_MAIN, {
            exec: async (args) => {
                if (args[0] === 'create') throw new Error('Error response from daemon: no space left on device');
                return { stdout: '' };
            },
        });

        await expect(runner.publishGit!(ISSUE_JOB)).rejects.toThrow('no space left on device');
        expect(steps.steps()).toEqual([]);
    });
});

describe('the block-helper transport (issue #207)', () => {
    const NOOP_SCRIPT = lookupHelper('noop')!.scriptBody;
    const NOOP_VERDICT = JSON.stringify({ schema: 'helper-noop/v1', version: 1, ok: true, output: { echoed: true } });
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 'claim-token' } };
    const plan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: { a: 1 },
        githubWriting: false,
        ...over,
    });

    /** A runner whose supervisor answers each helper step with `answer`; the daemon's every argv is kept. */
    const helperRunner = (answer: (step: StepRequest) => StepResult | Promise<StepResult> = () => ok(NOOP_VERDICT)) => {
        const docker: string[][] = [];
        const supervised = fakeSteps(answer);
        const exec = vitest.fn(async (args: string[]) => {
            docker.push(args);
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        return { docker, supervised, runner: dockerRunner(exec, { steps: supervised.sink }) };
    };

    it('fails an unknown helper id before any step is submitted', async () => {
        const { supervised, runner } = helperRunner();
        const result = await runner.runHelper!(job, plan({ helperId: 'not-a-real-helper' }));
        expect(result).toEqual({
            ok: false,
            reason: 'unknown_helper',
            message: expect.stringContaining('not-a-real-helper'),
        });
        expect(supervised.steps()).toEqual([]);
    });

    it('runs the noop helper end to end, as one supervised step with node and the script by content', async () => {
        const { docker, supervised, runner } = helperRunner();
        const result = await runner.runHelper!(repoJob, plan());

        expect(result).toEqual({ ok: true, output: { echoed: true } });
        const [step] = supervised.ofKind('helper');
        // Submitted to the attempt's supervisor, under the token only it holds.
        expect(supervised.submitted.map((entry) => entry.token)).toEqual([CONTROL_TOKEN]);
        expect(step?.argv).toEqual(['node', '-e', NOOP_SCRIPT]);
        expect(step?.timeoutMs).toBe(HELPER_TIMEOUT_MS);
        // Each call is its own operation: a helper is never replayed from an earlier answer.
        expect(step?.id).toMatch(/^helper-[0-9a-f]{16}-/);
        // The task worktree, when the job names a repo — the same tree the agent run edits.
        expect(step?.cwd).toBe(`/workspaces/bellows/${USER}/.worktrees/${job.id}`);
        // A read-only helper (githubWriting: false) gets its bounded input and nothing of the claim env.
        expect(step?.env).toEqual({ HELPER_INPUT: JSON.stringify({ a: 1 }) });
        // No container of its own: the daemon never saw the helper.
        expect(docker.some((a) => a[0] === 'run')).toBe(false);
    });

    it('maps a step the supervisor timed out to a named timeout failure', async () => {
        const { runner } = helperRunner(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await runner.runHelper!(job, plan());
        expect(result).toEqual({ ok: false, reason: 'timeout', message: expect.stringContaining('ms bound') });
    });

    it('hands the stand-down signal to the step, and a cancelled helper is no timeout (issue #488)', async () => {
        const controller = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const sink: StepSink = {
            submit: async (_token, _step, signal) => {
                seen.push(signal);
                controller.abort();
                throw new Error('step was cancelled');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            contacted: () => true,
        };
        const runner = dockerRunner(emptyDaemon, { steps: sink });

        const result = await runner.runHelper!(job, plan(), undefined, controller.signal);

        expect(seen).toEqual([controller.signal]);
        expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
    });

    it('carries a fresh token in the step env, only for a github-writing helper', async () => {
        const { supervised, runner } = helperRunner();
        const result = await runner.runHelper!(repoJob, plan({ githubWriting: true }), 'fresh-install-token');

        expect(result).toEqual({ ok: true, output: { echoed: true } });
        const [step] = supervised.ofKind('helper');
        // The minted token is the step's GitHub credential; a claim value under the name never is.
        expect(step?.env).toMatchObject({ GITHUB_TOKEN: 'fresh-install-token' });
        expect(JSON.stringify(step)).not.toContain('claim-token');
    });

    it('never puts the token in the daemon’s argv or the step’s — only in the step env', async () => {
        const { docker, supervised, runner } = helperRunner();
        await runner.runHelper!(repoJob, plan({ githubWriting: true }), 'super-secret-token');
        expect(docker.flat().some((a) => a.includes('super-secret-token'))).toBe(false);
        const [step] = supervised.ofKind('helper');
        expect(step?.argv.some((a) => a.includes('super-secret-token'))).toBe(false);
        expect(step?.env.GITHUB_TOKEN).toBe('super-secret-token');
    });

    it('maps any other failure to runner_error, using the tool own output', async () => {
        const { runner } = helperRunner(() => ({
            exitCode: 1,
            stdout: '',
            stderr: 'permission denied while running the helper',
            timedOut: false,
        }));
        const result = await runner.runHelper!(job, plan());
        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('permission denied'),
        });
    });

    it('runs a command-only job (no repo) at the member root, with no working directory', async () => {
        const { supervised, runner } = helperRunner();
        await runner.runHelper!(job, plan());
        expect(supervised.ofKind('helper')[0]).not.toHaveProperty('cwd');
    });
});

/*
 * Issue #382, the docker half. Kubernetes is the primary executor, but a hardening that exists on
 * only one of them is a hardening an operator cannot reason about — and docker is the executor a
 * developer actually runs agent-written code under, on their own machine, against a daemon that
 * is root on it. Same two controls, spelled the way docker spells them:
 *
 *   --cap-drop ALL                      the kubernetes `capabilities.drop: [ALL]`
 *   --security-opt no-new-privileges    the kubernetes `allowPrivilegeEscalation: false`
 *
 * There is no seccomp twin to assert: the daemon applies its own default profile to every
 * container unless told otherwise, which is what `seccompProfile: RuntimeDefault` asks the kubelet
 * for. Adding a flag to restate it would be a flag that can only ever be wrong.
 *
 * Asserted as an ADJACENT ARGV PAIR, never as "contains the flag": `--cap-drop` separated from
 * `ALL` by an inserted argument is the exact bug a substring check reports as passing, and the
 * argv is built by concatenation in thirteen places.
 */
describe('every container the driver runs is hardened (#382)', () => {
    /** The flag and its value, as the pair docker reads them — index-adjacent or it is not set. */
    const hasPair = (argv: string[], flag: string, value: string): boolean =>
        argv.some((arg, i) => arg === flag && argv[i + 1] === value);

    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const config = () => loadDriverConfig({});
    const builders: [string, () => string[]][] = [
        ['the runner', () => dockerArgs(config(), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })],
        ['a gate', () => gateEnvArgs(config(), `bellows/${USER}/.worktrees/${job.id}`, 'node:24')],
        ['the opencode session readout', () => opencodeSessionReadoutArgs(config(), opencodeJob, START)],
        ['the opencode cache probe', () => opencodeCacheProbeArgs(config(), opencodeJob)],
        ['the claude turns readout', () => claudeTurnsArgs(config(), job, SESSION, START)],
        [
            'the task supervisor',
            () => supervisorCreateArgs(config(), job, { exporting: true, agentless: false }, '/tmp/supervisor.env'),
        ],
        [
            'the task supervisor of an agentless or reclaim group',
            () => supervisorCreateArgs(config(), repoJob, { exporting: false, agentless: true }, '/tmp/supervisor.env'),
        ],
        ['the claude transcript exporter', () => exporterCreateArgs(config(), job, START, '/tmp/export.env')],
        ['a declared service', () => serviceRunArgs(job, { name: 'cache', image: 'redis', environment: [] })],
    ];

    it.each(builders)('drops every capability on %s', (_name, build) => {
        expect(hasPair(build(), '--cap-drop', 'ALL')).toBe(true);
    });

    it.each(builders)('refuses privilege escalation on %s', (_name, build) => {
        expect(hasPair(build(), '--security-opt', 'no-new-privileges')).toBe(true);
    });

    /*
     * The paths that used to build a `docker run` argv INLINE — the worktree reclaim, the publish
     * steps, the tree probe and the block helpers — now ask the task supervisor for a step instead
     * (#771). What they leave on the daemon is the group they ran in, so what is asserted is every
     * container THEY create (the supervisor of a group they open) and that none of them runs one
     * of its own: a new `docker run` site would land here unnoticed otherwise.
     *
     * Asserted through each path's own `execDocker` fake, so the argv checked is the argv the
     * daemon would have been handed.
     */
    const containersFrom = async (drive: (runner: ReturnType<typeof createDockerRunner>) => Promise<unknown>) => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(
            exec,
            // A fake `files`: the group's control env file is a real file in os.tmpdir() under the
            // default, and an offline unit test has no business touching the filesystem.
            {
                files: { writeFile: async () => undefined, rm: async () => undefined } as unknown as RunnerFiles,
                endpoint: reclaimEndpoint().endpoint,
            }
        );
        await drive(runner).catch(() => undefined);
        return {
            created: calls.filter((a) => a[0] === 'create'),
            runs: calls.filter((a) => a[0] === 'run'),
        };
    };

    it.each([
        [
            'the worktree reclaim',
            (r: ReturnType<typeof createDockerRunner>) => r.reclaimWorktree({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'a block helper',
            (r: ReturnType<typeof createDockerRunner>) =>
                r.runHelper!(job, { helperId: 'noop', phase: 'pre', input: { a: 1 }, githubWriting: false }),
        ],
        [
            'the publish path',
            (r: ReturnType<typeof createDockerRunner>) => r.publishGit!({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'the tree probe',
            (r: ReturnType<typeof createDockerRunner>) => r.probeTree!({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'the startup sync',
            (r: ReturnType<typeof createDockerRunner>) => r.syncCheckout({ ...job, repo: 'Bellows-AI/factory' }),
        ],
    ])('hardens every container %s creates, and runs none of its own', async (_name, drive) => {
        const { created, runs } = await containersFrom(
            drive as (r: ReturnType<typeof createDockerRunner>) => Promise<unknown>
        );
        // The load-bearing guard: a path that created nothing would pass the loop below vacuously.
        expect(created.length).toBeGreaterThan(0);
        expect(runs).toEqual([]);
        for (const argv of created) {
            expect(hasPair(argv, '--cap-drop', 'ALL')).toBe(true);
            expect(hasPair(argv, '--security-opt', 'no-new-privileges')).toBe(true);
        }
    });

    // The same opt-out the kubernetes service pod carries, and reaching exactly as far: a stock
    // image whose entrypoint chowns its data directory as root gets its capabilities back and
    // nothing else. `no-new-privileges` stays on, because chowning does not require escalating.
    it('lets a declared service opt out of the capability drop, and of nothing else', () => {
        const argv = serviceRunArgs(job, { name: 'db', image: 'postgres:16', environment: [], unhardened: true });
        expect(argv).not.toContain('--cap-drop');
        expect(hasPair(argv, '--security-opt', 'no-new-privileges')).toBe(true);
    });

    // The hardened alternative: the declared uid:gid, with every capability still dropped.
    it('runs a declared service as its declared uid:gid, still hardened', () => {
        const argv = serviceRunArgs(job, {
            name: 'db',
            image: 'postgres:17',
            environment: [],
            user: { uid: 999, gid: 999 },
        });
        expect(hasPair(argv, '--user', '999:999')).toBe(true);
        expect(hasPair(argv, '--cap-drop', 'ALL')).toBe(true);
        expect(hasPair(argv, '--security-opt', 'no-new-privileges')).toBe(true);
        expect(argv.indexOf('--user')).toBeLessThan(argv.indexOf('postgres:17'));
    });

    it('passes no --user to a service that declared none', () => {
        expect(serviceRunArgs(job, { name: 'db', image: 'postgres:17', environment: [] })).not.toContain('--user');
    });
});

/*
 * Issue #805: a supervisor that already exited answers `docker wait` at once. Its exit is no sign
 * the agent ended — nobody is left to deliver the kill order — so the stop hard-kills the agent
 * still running, and only the agent: the supervisor's loss stays the close path's to record.
 */
describe('stopping an agent whose supervisor already exited (#805)', () => {
    const daemon = (supervisorExit: string, agentPs: string, refuses: (args: string[]) => boolean = () => false) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (refuses(args)) return Promise.reject(new Error('the daemon answered 503'));
            if (args[0] === 'wait') return Promise.resolve({ stdout: `${supervisorExit}\n` });
            if (args[0] === 'ps' && args.includes('label=factory.role=agent'))
                return Promise.resolve({ stdout: agentPs });
            // The whole group's listing; the service teardown's own listing finds no services.
            if (args[0] === 'ps' && !args.includes('label=factory.service'))
                return Promise.resolve({ stdout: 'agent-id\nsupervisor-id\nexporter-id\n' });
            return Promise.resolve({ stdout: '' });
        };
        return { exec, calls };
    };
    const kills = (calls: string[][]) => calls.filter((args) => args[0] === 'kill');

    it('hard-kills the still-running agent, and only it, when the supervisor exited non-zero', async () => {
        const { exec, calls } = daemon('70', 'agent-id\n');

        await dockerRunner(exec).stopAgent!(job);

        expect(kills(calls)).toEqual([['kill', 'agent-id']]);
        const listed = calls.find((args) => args[0] === 'ps' && args.includes('label=factory.role=agent'));
        expect(listed).toEqual(
            expect.arrayContaining([`label=factory.job=${job.id}`, `label=factory.lease=${job.leaseToken}`])
        );
    });

    it('kills nothing when the supervisor finalized and the agent is gone', async () => {
        const { exec, calls } = daemon('0', '');

        await dockerRunner(exec).stopAgent!(job);

        expect(kills(calls)).toEqual([]);
    });

    // Never throws, like the kubernetes twin: a lookup the daemon refused falls back to the hard kill.
    it('falls back to the hard kill of the whole group when the agent lookup fails', async () => {
        const { exec, calls } = daemon('70', 'agent-id\n', (args) => args.includes('label=factory.role=agent'));

        await dockerRunner(exec).stopAgent!(job);

        expect(kills(calls)).toEqual([
            ['kill', 'agent-id'],
            ['kill', 'supervisor-id'],
            ['kill', 'exporter-id'],
        ]);
    });

    it('force-removes the agent when its kill fails', async () => {
        const { exec, calls } = daemon('70', 'agent-id\n', (args) => args[0] === 'kill');

        await dockerRunner(exec).stopAgent!(job);

        expect(calls).toContainEqual(['rm', '-f', 'agent-id']);
    });
});

/*
 * Issue #792, the docker twin: a driver restarted while its runner container ran on. The claim
 * that superseded it reads the EXITED runner container of the earlier claim — exit code, log,
 * session — and only then removes it; the run is never redone.
 */
describe('adopting a finished runner container of an earlier claim (#792)', () => {
    const adopter: BoardJob = { ...job, leaseToken: '99999999-9999-4999-8999-999999999999', claimSeq: 2 };
    const listing = (
        seq = '1',
        lease = job.leaseToken,
        name = containerName({ ...job, leaseToken: lease }),
        command = commandMark(job.command)
    ) => `${name}\t${lease}\t${seq}\t${SESSION}\t${command}\n`;

    /** The fence's own listing: every container of the job by id and lease — the runner's and the exporter's. */
    const FENCE_PS = `runner-id\t${job.leaseToken}\nexporter-id\t${job.leaseToken}\n`;

    /**
     * The daemon, and the `docker logs` read the adoption streams through spawn — its argv recorded
     * among the daemon calls, in order, its child printing `log` and exiting `logExit`.
     */
    const daemon = (ps: string, supervisorExit = '0', log: string | Buffer[] = 'did the work\n', logExit = 0) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            // The earlier attempt's supervisor: finalized (0) unless a test says how it ended.
            if (args[0] === 'wait') return Promise.resolve({ stdout: `${supervisorExit}\n` });
            if (args[0] === 'ps') return Promise.resolve({ stdout: args.includes('status=exited') ? ps : FENCE_PS });
            if (args[0] === 'inspect') {
                return Promise.resolve({
                    stdout: '{"Status":"exited","ExitCode":0,"StartedAt":"2026-10-01T00:00:00Z"}\n',
                });
            }
            return Promise.resolve({ stdout: '' });
        };
        const logs = ((_command: string, args: string[]) => {
            calls.push(args);
            return typeof log === 'string' ? fakeChild(log, '', logExit) : chunkedChild(log, logExit);
        }) as unknown as typeof spawn;
        return { exec, calls, logs };
    };

    it('reads the exit code, log and session before removing the container', async () => {
        const { exec, calls, logs } = daemon(listing());

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt!(adopter);

        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, timedOut: false, sessionId: SESSION },
        });
        expect(adopted!.outcome.output).toContain('did the work');
        const read = calls.findIndex((args) => args[0] === 'logs');
        const removed = calls.findIndex((args) => args[0] === 'rm' && args.includes('runner-id'));
        expect(read).toBeGreaterThanOrEqual(0);
        expect(removed).toBeGreaterThan(read);
        expect(calls[0]).toEqual(expect.arrayContaining(['ps', '-a', `label=factory.job=${job.id}`, 'status=exited']));
        // The earlier attempt's other leftovers go with it, read first: the fence the sync would run.
        const swept = calls.findIndex((args) => args[0] === 'rm' && args.includes('exporter-id'));
        expect(swept).toBeGreaterThan(read);
    });

    // Issue #796: a run read but never swept is no adoption — the attempt runs the job itself.
    it('rejects when the read run cannot be swept', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const exec = (args: string[]) => {
            if (args[0] !== 'rm') return base(args);
            calls.push(args);
            return Promise.reject(new Error('the daemon answered 503'));
        };

        await expect(dockerRunner(exec, { spawn: logs }).adopt!(adopter)).rejects.toThrow('the daemon answered 503');

        const read = calls.findIndex((args) => args[0] === 'logs');
        expect(read).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'rm')).toBeGreaterThan(read);
    });

    // The supervisor outlives the agent to finalize: the next claim waits for it rather than
    // reading a half-finished group, and a supervisor lost mid-finalize adopts nothing — and
    // sweeps nothing: the group stays for the fence the sync runs.
    it('waits for the earlier attempt’s supervisor before it reads, and reads its deadline exit as a timeout', async () => {
        const { exec, calls, logs } = daemon(listing(), '124');

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt!(adopter);

        expect(adopted?.outcome.timedOut).toBe(true);
        const waited = calls.findIndex((args) => args[0] === 'wait');
        expect(waited).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'logs')).toBeGreaterThan(waited);
    });

    it('adopts nothing and removes nothing when the earlier supervisor was lost before it finalized', async () => {
        const { exec, calls, logs } = daemon(listing(), '137');

        expect(await dockerRunner(exec, { spawn: logs }).adopt!(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'logs' || args[0] === 'rm')).toBe(false);
    });

    it('adopts nothing when the earlier supervisor lost its driver before it released the agent', async () => {
        const { exec, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.lost));

        expect(await dockerRunner(exec, { spawn: logs }).adopt!(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'logs' || args[0] === 'rm')).toBe(false);
    });

    // A queued task's command can be edited after a handover: a run of the old command is not its run.
    it('never adopts a run of a command since edited', async () => {
        const { exec, calls, logs } = daemon(
            listing('1', job.leaseToken, containerName(job), commandMark('another command'))
        );

        expect(await dockerRunner(exec, { spawn: logs }).adopt!(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'logs')).toBe(false);
    });

    // Failure injection (#825): a log past an exec's output buffer streams; it never fails the adoption.
    it('adopts a runner whose log outgrew an exec buffer: its tail kept, flagged truncated', async () => {
        const EXEC_MAX_BUFFER = 1024 * 1024;
        const line = 'body line\n';
        const { exec: base, calls, logs } = daemon(listing(), '0', line.repeat(EXEC_MAX_BUFFER / line.length + 1));
        const exec = (args: string[]) =>
            args[0] === 'logs'
                ? Promise.reject(
                      Object.assign(new Error('stdout maxBuffer length exceeded'), {
                          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                      })
                  )
                : base(args);

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt!(adopter);

        expect(adopted?.outcome.logTruncated).toBe(true);
        expect(adopted?.outcome.fullLog?.endsWith(line)).toBe(true);
        expect(Buffer.byteLength(adopted?.outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(Buffer.byteLength(adopted?.outcome.output ?? '')).toBeLessThanOrEqual(16 * 1024);
        const read = calls.findIndex((args) => args[0] === 'logs');
        expect(read).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'rm')).toBeGreaterThan(read);
    });

    it('adopts a short log whole and complete', async () => {
        const { exec, logs } = daemon(listing());

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt!(adopter);

        expect(adopted?.outcome).toMatchObject({ fullLog: 'did the work\n', logTruncated: false });
    });

    it('decodes a multibyte character split across two log chunks once, whole — below and above the cap', async () => {
        for (const [body, truncated] of SPLIT_EURO_CASES) {
            const { exec, logs } = daemon(listing(), '0', splitEuro(body));

            const adopted = await dockerRunner(exec, { spawn: logs }).adopt!(adopter);

            expectWholeEuro(adopted?.outcome, truncated);
        }
    });

    it('keeps the bytes of an adopted log that ended inside a character, never drops them', async () => {
        const { exec, logs } = daemon(listing(), '0', CUT_SHORT);

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt!(adopter);

        expect(adopted?.outcome).toMatchObject({ fullLog: 'ok\uFFFD', logTruncated: false });
    });

    it('rejects an adoption whose log read failed, and removes nothing', async () => {
        const { exec, calls, logs } = daemon(listing(), '0', 'Error: No such container\n', 1);

        await expect(dockerRunner(exec, { spawn: logs }).adopt!(adopter)).rejects.toThrow(/docker logs/);
        expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    });

    it('adopts nothing of its own claim, a newer one, or a container that is not the runner', async () => {
        const own = listing('2', adopter.leaseToken);
        const notRunner = listing('1', job.leaseToken, `factory-svc-${job.id}-db`);
        const { exec, calls, logs } = daemon(own + notRunner);

        expect(await dockerRunner(exec, { spawn: logs }).adopt!(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    });

    it('answers null when no earlier runner exited', async () => {
        const { exec } = daemon('');
        expect(await dockerRunner(exec).adopt!(adopter)).toBeNull();
    });

    it('labels every runner container with its claim sequence and session', () => {
        const args = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(args).toEqual(
            expect.arrayContaining([
                '--label',
                'factory.claim-seq=1',
                '--label',
                `factory.session=${SESSION}`,
                '--label',
                `factory.command=${commandMark(job.command)}`,
            ])
        );
    });
});
