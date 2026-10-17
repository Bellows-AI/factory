import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardJob } from '../src/board.js';
import { type DriverConfig, loadDriverConfig } from '../src/config.js';
import {
    AGENT_CONTAINER,
    EXPORTER_CONTAINER,
    GO_MARKER,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_EXIT,
    SUPERVISOR_STEPS_MS,
    SUPERVISOR_WINDDOWN_MS,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../src/supervisor-contract.js';
import { StepChannelClosed, type StepSink } from '../src/step-control.js';
import { claudeTurnsScript, claudeExportScript } from '../src/container-scripts.js';
import { ARTIFACT_LIMIT, commandMark, OPENCODE_EXPORT_LIMIT, SERVICE_LOG_TAIL_LINES } from '../src/runner.js';
import { lookupHelper } from '../src/helpers.js';
import { claudeManagedSettings, opencodeOtelConfig } from '../src/telemetry-config.js';
import type { HelperPlan } from '../src/helpers.js';
import type { K8sDeps, K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import {
    LOG_TAIL_LINES,
    POLL_MAX_CONSECUTIVE_FAILURES,
    parseDeadServicePods,
    parseServicePods,
    parsePodMetrics,
} from '../src/k8s-transport.js';
import { readVerdict, runnerLossOf } from '../src/k8s-poll.js';
import { orphanBoundMs } from '../src/supervisor-plan.js';
import {
    claudeTurnsJobName,
    claudeTurnsJobSpec,
    envBodyToData,
    fleetDnsField,
    gateEnvSecretName,
    gateJobSpec,
    jobsPath,
    opencodeReadoutJobName,
    opencodeReadoutJobSpec,
    runnerJobName,
    runnerJobSpec,
    secretName,
    serviceSubdomain,
} from '../src/k8s-podspec.js';
import { claimName, jobPath, serviceDnsSpec, servicePodSpec } from '../src/k8s-auxspec.js';
import { createKubernetesGateManager } from '../src/k8s-gates.js';
import { reclaimGroupSpec } from '../src/k8s-group.js';
import { createKubernetesRunner } from '../src/k8s-runner.js';
import { throughTransport } from './fixtures/k8s-transport-bridge.js';
import { ServicesNotRunning } from '../src/service-restart.js';
import {
    CREDENTIAL_HELPER,
    gitProbeScript,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    TRANSIENT_SYNC_REASON,
} from '../src/publish.js';
import { forgetDeclaredServices, type ServiceSpec } from '../src/services.js';

const USER = '44444444-4444-4444-8444-444444444444';
/** The Job's backstop beyond the agent's budget: the drain and the report, then the hours the group serves steps. */
const WINDDOWN_S = (SUPERVISOR_WINDDOWN_MS + SUPERVISOR_STEPS_MS) / 1000;

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

/** The control pair a run with a control endpoint carries for its supervisor — the exporter's, too. */
const SUPERVISED: Pick<BoardJob, 'supervisorEnv'> = {
    supervisorEnv: { SUPERVISOR_CONTROL_URL: 'http://driver:7000', SUPERVISOR_CONTROL_TOKEN: 'tok-supervisor' },
};

/** The step channel every attempt here is reached through: the control token the fake sink is keyed by. */
const CONTROL_TOKEN = SUPERVISED.supervisorEnv!.SUPERVISOR_CONTROL_TOKEN!;

const job: BoardJob = {
    ...SUPERVISED,
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    maxAttempts: 1,
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
    rootCommand: 'fix the failing build',
};

const SESSION = '33333333-3333-4333-8333-333333333333';
const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };

const spec = (env: NodeJS.ProcessEnv = {}) =>
    runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', ...env }), job, { id: SESSION, resume: false });

describe('the runner job spec', () => {
    it('is a batch/v1 Job named after the job id and lease token, within the label bound', () => {
        expect(spec().apiVersion).toBe('batch/v1');
        expect(spec().kind).toBe('Job');
        expect(spec().metadata.name).toBe(runnerJobName(job));
        // The apiserver stamps the Job's name onto the pod template as the `job-name` label, and
        // a label value is capped at 63 bytes — the raw `factory-job-<id>-<lease token>` is 85
        // and the create answers 422. Hashed, the name is 23; the pin is the BOUND, not today's
        // spelling, so a future name change cannot reintroduce the refusal.
        expect(spec().metadata.name.length).toBeLessThanOrEqual(63);
    });

    // The plan is pinned in runner-plan.test.ts; this is its kubernetes rendering: the CLI args as
    // the container's args (its env pairs are the literal values pinned below).
    it('runs the command as a prompt, with the same argv the docker runner passes after the image', () => {
        expect(spec().spec.template.spec.containers[0]!.args).toEqual([
            '--session-id',
            SESSION,
            '--append-system-prompt',
            MASTER_PROMPT,
            '--system-prompt-snapshot',
            'off',
            '-p',
            'fix the failing build',
        ]);
    });

    it("mounts the workspaces PVC and starts at the AUTHOR's workspace root", () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'WORKDIR', value: `/workspaces/bellows/${USER}` });
        expect(spec().spec.template.spec.volumes).toContainEqual({
            name: 'workspaces',
            persistentVolumeClaim: { claimName: 'factory-ai_workspaces' },
        });
        // The mount is scoped to the job's own `<orgId>/<userId>` subtree — both segments
        // asserted — so the container's volume root is the member's tree, never the shared
        // parent every member's checkout lives under.
        expect(container.volumeMounts).toContainEqual({
            name: 'workspaces',
            mountPath: `/workspaces/bellows/${USER}`,
            subPath: `bellows/${USER}`,
        });
    });

    // Issue #452: the managed settings come from the per-attempt Secret, mounted read-only and
    // 0444 over /etc/claude-code — root-owned in the pod, so the agent (uid 1000) cannot rewrite
    // the scope that outranks every other.
    it('mounts the rendered managed settings read-only from the attempt Secret for a claude-code runner', () => {
        const s = spec();
        expect(s.spec.template.spec.volumes).toContainEqual({
            name: 'telemetry-config',
            secret: {
                secretName: secretName(job),
                items: [{ key: 'managed-settings.json', path: 'managed-settings.json' }],
                defaultMode: 0o444,
            },
        });
        expect(s.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'telemetry-config',
            mountPath: '/etc/claude-code',
            readOnly: true,
        });
    });

    it('mounts the rendered otel.json read-only from the attempt Secret for an opencode runner', () => {
        const s = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), opencodeJob, null);
        expect(s.spec.template.spec.volumes).toContainEqual({
            name: 'telemetry-config',
            secret: {
                secretName: secretName(opencodeJob),
                items: [{ key: 'otel.json', path: 'otel.json' }],
                defaultMode: 0o444,
            },
        });
        expect(s.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'telemetry-config',
            mountPath: '/etc/opencode-otel',
            readOnly: true,
        });
    });

    // Executor parity for the task worktree (issue #35): a repo job starts in the thread's
    // worktree here exactly as the docker runner does — same WORKDIR rule, one code path on the
    // board side.
    it('starts a repo job in its task worktree', () => {
        const repoSpec = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...job, repo: 'Bellows-AI/factory' },
            {
                id: SESSION,
                resume: false,
            }
        );
        expect(repoSpec.spec.template.spec.containers[0]!.env).toContainEqual({
            name: 'WORKDIR',
            value: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        });
    });

    it('refuses to run a repo job whose worktree path cannot be asserted', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, repo: 'Bellows-AI/factory', rootJobId: 'not-a-uuid' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/worktree/);
    });

    it('refuses a thread root that is not a uuid before it becomes a path', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, rootJobId: '../../etc' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/not a uuid/);
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
                () =>
                    runnerJobSpec(
                        loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                        { ...job, workspacePath: path },
                        { id: SESSION, resume: false }
                    ),
                String(path)
            ).toThrow(/no usable workspace path/);
        }
    });

    // The id becomes the Job object's name and lands in API paths — the same interpolation the
    // docker runner guards before a `docker run`, from the same kind of board.
    it('refuses a job id that is not a uuid, rather than interpolating it', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, id: '../../etc/passwd' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/must be a uuid/);
    });

    // The k8s form of `-e NAME`: the NAMES travel and the values live in a Secret the cluster
    // already holds. A literal `value:` would put the credential in the pod spec, which anyone who
    // can `get pods` can read — the same audience every `ps` on the host has.
    it('names credentials by secretKeyRef, never by value', () => {
        const container = spec({ RUNNER_CREDENTIALS_SECRET: 'claude-credentials' }).spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({
            name: 'CLAUDE_CODE_OAUTH_TOKEN',
            valueFrom: {
                secretKeyRef: { name: 'claude-credentials', key: 'CLAUDE_CODE_OAUTH_TOKEN', optional: true },
            },
        });
        expect(container.env).toContainEqual({
            name: 'ANTHROPIC_API_KEY',
            valueFrom: { secretKeyRef: { name: 'claude-credentials', key: 'ANTHROPIC_API_KEY', optional: true } },
        });
        // WORKDIR, the OTLP endpoint, the board URL, the transcript store and the npm notice
        // switch are the only literal values a runner env carries, none of them secrets — the
        // object of the pin above.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            // The two mailbox paths the agent finds its supervisor through — paths, no credential.
            { name: 'FACTORY_CTL_IN', value: '/factory/in' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // A default only: the claim's own value rides the Secret by reference, and the pod spec never
    // states the name a second time beside it.
    it('leaves the npm notice to a claim that names it', () => {
        const envJob: BoardJob = { ...job, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        const env = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), envJob, { id: SESSION, resume: false })
            .spec.template.spec.containers[0]!.env;
        expect(env.filter((entry) => entry.name === 'NPM_CONFIG_UPDATE_NOTIFIER')).toEqual([
            {
                name: 'NPM_CONFIG_UPDATE_NOTIFIER',
                valueFrom: { secretKeyRef: { name: secretName(envJob), key: 'NPM_CONFIG_UPDATE_NOTIFIER' } },
            },
        ]);
    });

    // Where a runner's telemetry goes. A literal value like WORKDIR — an OTLP endpoint is a path,
    // not a credential — but unlike the compose world there is no network for a pod to join that
    // would make the image's baked `collector:4318` resolve, so this process has to name the
    // collector. RUNNER_OTEL_ENDPOINT overrides the compose-collector default; the pin is that it
    // lands as the runner's own `value`, readable in the pod spec like WORKDIR is.
    it('points the runner at a collector, overriding it when configured', () => {
        const def = spec().spec.template.spec.containers[0]!;
        expect(def.env).toContainEqual({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' });
        const configured = spec({ RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' }).spec.template.spec
            .containers[0]!;
        expect(configured.env).toContainEqual({
            name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
            value: 'http://telemetry.internal:4318',
        });
    });

    // `RUNNER_CREDENTIALS_SECRET` forwards nothing when unset: its names never appear. What the
    // spec DOES always carry is the runner's own attempt pair — the branch-ingest credential,
    // referenced into the per-attempt Secret below (its values ride the Secret, never the spec).
    it('forwards no user-configured credentials when no secret is configured', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'RUNNER_JOB_ID',
                valueFrom: {
                    secretKeyRef: { name: `factory-job-${job.id}-${job.leaseToken}-env`, key: 'RUNNER_JOB_ID' },
                },
            },
            {
                name: 'RUNNER_LEASE_TOKEN',
                valueFrom: {
                    secretKeyRef: { name: `factory-job-${job.id}-${job.leaseToken}-env`, key: 'RUNNER_LEASE_TOKEN' },
                },
            },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            { name: 'FACTORY_CTL_IN', value: '/factory/in' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // The claim env's VALUES never touch the pod spec — anyone who can `get pods` would read them.
    // They live in a per-attempt Secret the runner creates before the Job and reaps with it.
    it('references claim env by secretKeyRef into the per-job Secret, never by value', () => {
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const container = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), envJob, {
            id: SESSION,
            resume: false,
        }).spec.template.spec.containers[0]!;
        // NOT optional: the driver created this exact Secret moments before the Job, under this
        // attempt's own lease token — a missing key is a bug and must fail loud
        // (CreateContainerConfigError), not start the pod silently without its env.
        expect(container.env).toContainEqual({
            name: 'CORE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(envJob), key: 'CORE_TOKEN' } },
        });
        expect(JSON.stringify(container.env)).not.toContain('shh');
    });

    // Issue #442: the run-control channel rides the same per-attempt Secret as the gate pair, so a
    // kubernetes runner's stop poller reaches the driver pod's endpoint exactly as a docker one does.
    it('names the run-control channel by secretKeyRef into the per-job Secret', () => {
        const controlled: BoardJob = {
            ...job,
            gateEnv: {
                BELLOWS_CONTROL_URL: 'http://10.1.2.3:41000',
                BELLOWS_CONTROL_TOKEN: 'ctl-secret',
            },
        };
        const container = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), controlled, {
            id: SESSION,
            resume: false,
        }).spec.template.spec.containers[0]!;
        for (const name of ['BELLOWS_CONTROL_URL', 'BELLOWS_CONTROL_TOKEN']) {
            expect(container.env).toContainEqual({
                name,
                valueFrom: { secretKeyRef: { name: secretName(controlled), key: name } },
            });
        }
        expect(JSON.stringify(container.env)).not.toContain('ctl-secret');
    });

    it('carries no claim env entries for an env-less claim', () => {
        const container = spec().spec.template.spec.containers[0]!;
        // The attempt pair names the per-attempt Secret now, always — that is the runner's own
        // credential, not claim env. What must not appear is anything MEMBER-configured.
        expect(JSON.stringify(container.env)).not.toContain('CORE_TOKEN');
        // The literal values: WORKDIR, the two URLs every runner is pointed somewhere by —
        // the collector for OTLP metrics, the board for the branch reporter's attribution
        // reports — the transcript store path and the npm notice switch, none of them
        // credentials, in a spec anyone with `get pods` can read.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            { name: 'FACTORY_CTL_IN', value: '/factory/in' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // The branch reporter posts to the board's API; the same URL the docker runner forwards as
    // `-e FACTORY_STATS_URL`, defaulted from JOB_BOARD_URL and overridable for a split topology.
    it('names the board for the branch reporter, overridable', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' });
        expect(
            spec({ RUNNER_STATS_URL: 'http://stats.internal:8080' }).spec.template.spec.containers[0]!.env
        ).toContainEqual({ name: 'FACTORY_STATS_URL', value: 'http://stats.internal:8080' });
    });

    // The attempt pair is a credential — the lease token most of all — so the NAMES travel in
    // the pod spec and the VALUES ride the per-attempt Secret by reference, the same discipline
    // as every claim env entry. There is no opt-out: the pair is how the runner's branch
    // reporter authenticates at all.
    it('delivers the attempt pair by secret reference, never as a value', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({
            name: 'RUNNER_JOB_ID',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_JOB_ID' } },
        });
        expect(container.env).toContainEqual({
            name: 'RUNNER_LEASE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_LEASE_TOKEN' } },
        });
        // No literal pair values in the spec: only valueFrom references.
        expect(
            container.env.filter((entry) => entry.name === 'RUNNER_JOB_ID' || entry.name === 'RUNNER_LEASE_TOKEN')
        ).toEqual(
            container.env.filter(
                (entry) =>
                    (entry.name === 'RUNNER_JOB_ID' || entry.name === 'RUNNER_LEASE_TOKEN') && 'valueFrom' in entry
            )
        );
    });

    // A failed runner pod must never be re-run by the cluster: a kubelet retry would re-send the
    // prompt and run the work twice. The board owns retries — the lease expires and the job is
    // offered again, which is visible in `attempts`.
    it('never restarts a failed runner', () => {
        expect(spec().spec.template.spec.restartPolicy).toBe('Never');
        expect(spec().spec.backoffLimit).toBe(0);
    });

    it('bounds the run with an active deadline', () => {
        // DRIVER_JOB_TIMEOUT_MS maps onto the kubelet-enforced deadline, so a runner that outlives
        // its driver still dies — the k8s form of `docker kill`. The supervisor ends the agent at the
        // budget itself; the kubelet's backstop adds the drain and the report on top.
        expect(spec({ DRIVER_JOB_TIMEOUT_MS: '45000' }).spec.activeDeadlineSeconds).toBe(45 + WINDDOWN_S);
    });

    // Issue #733: environment.setup ran before the agent, inside the same run budget.
    it('takes the time environment.setup spent off the active deadline', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_JOB_TIMEOUT_MS: '45000' });
        const setUp = runnerJobSpec(config, { ...job, setupMs: 15_000 }, { id: SESSION, resume: false });
        expect(setUp.spec.activeDeadlineSeconds).toBe(30 + WINDDOWN_S);
    });

    it('runs exactly one pod, and reaps the object when it is done', () => {
        expect(spec().spec.completions).toBe(1);
        expect(spec().spec.parallelism).toBe(1);
        expect(spec().spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    });

    // The same labels the docker runner passes as --label: factory.job is what lets `kubectl
    // get jobs -l factory.job=<id>` find a runner that outlived its driver — and what the
    // re-claim fence sweeps by; factory.lease scopes every per-attempt operation to its own
    // attempt's objects, the same split as the docker runner's two labels.
    it('labels the pod so an orphan can be found after the driver dies', () => {
        expect(spec().spec.template.metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
        expect(spec().metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
    });

    // Every runner pod would otherwise auto-mount the driver's own ServiceAccount token — the
    // credentials that may create Jobs — into the Claude container. That is the docker socket
    // riding along with the dashboard, and it is refused here for the same reason.
    it('leaves no service account token in the runner', () => {
        expect(spec().spec.template.spec.automountServiceAccountToken).toBe(false);
    });

    /**
     * Kubernetes defaults to `Always` for an untagged or `:latest` image, which would reach past
     * the node's own local images to a registry that has never heard of `claude-executor` — the
     * docker runner's "use what the daemon has" behavior has to be stated, not assumed.
     */
    it('states the pull policy instead of letting kubernetes default to Always', () => {
        expect(spec().spec.template.spec.containers[0]!.imagePullPolicy).toBe('IfNotPresent');
        expect(spec({ RUNNER_IMAGE_PULL_POLICY: 'Always' }).spec.template.spec.containers[0]!.imagePullPolicy).toBe(
            'Always'
        );
    });

    /**
     * Issue #360: a pod with no requests is BestEffort — first evicted under node memory
     * pressure, and a zero-request pod the autoscaler never provisions capacity for. The
     * configured requests land on the container verbatim.
     */
    it('renders the configured requests and limits, so the pod is Burstable and the autoscaler can size for it', () => {
        expect(
            spec({
                RUNNER_CPU_REQUEST: '500m',
                RUNNER_MEMORY_REQUEST: '1Gi',
                RUNNER_CPU_LIMIT: '2',
                RUNNER_MEMORY_LIMIT: '4Gi',
            }).spec.template.spec.containers[0]!.resources
        ).toEqual({
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '2', memory: '4Gi' },
        });
    });

    // Limits off by default, the dashboard pod's own posture: a request only reserves, while a
    // memory limit on an agent run turns a big build into an OOM kill mid-work.
    it('renders requests only when limits are unset — the dashboard posture', () => {
        const container = spec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' }).spec.template.spec
            .containers[0]!;
        expect(container.resources).toEqual({ requests: { cpu: '500m', memory: '1Gi' } });
        expect(container.resources?.limits).toBeUndefined();
    });

    it('renders no resources block at all when none are configured — the BestEffort pod this issue came from', () => {
        expect(spec().spec.template.spec.containers[0]!.resources).toBeUndefined();
    });
});

/*
 * Every pod the driver specs, by name: the runner, the ten aux builders (all through
 * `auxJobSpec`) and a declared service's bare Pod. Each entry is a thunk, built inside the it
 * bodies — the file's `namespace` is declared below, and nothing here may build eagerly. A
 * builder that bypassed `auxJobSpec` altogether would need its own entry here, and the
 * admission policy is the backstop that refuses it at the apiserver either way.
 */
const POD_NAMES = [
    'the runner',
    'the gate',
    'the opencode session readout',
    'the claude turns readout',
    'the task supervisor',
    'the transcript exporter',
    'the reclaim group',
    'the service pod',
] as const;
type PodName = (typeof POD_NAMES)[number];
/** Every Job-backed pod — all of them but the declared service's bare Pod. */
const JOB_POD_NAMES = POD_NAMES.filter((name) => name !== 'the service pod');

type JobSpecOf = ReturnType<typeof runnerJobSpec> | ReturnType<typeof gateJobSpec>;
type ServicePodOf = ReturnType<typeof servicePodSpec>;
interface PodView {
    /** The Job object — absent on the service's bare Pod. */
    job?: JobSpecOf;
    /** The POD's metadata: the Job's pod template, or the bare Pod's own. */
    meta: JobSpecOf['spec']['template']['metadata'] | ServicePodOf['metadata'];
    /** The pod spec, read only through the fields every pod shares. */
    pod: {
        restartPolicy: string;
        automountServiceAccountToken: boolean;
        securityContext?: { seccompProfile?: { type: string } };
        imagePullSecrets?: { name: string }[];
        nodeSelector?: unknown;
        tolerations?: unknown;
        affinity?: unknown;
        containers: {
            resources?: unknown;
            securityContext?: {
                capabilities?: { drop?: string[] };
                allowPrivilegeEscalation?: boolean;
                readOnlyRootFilesystem?: boolean;
            };
            volumeMounts?: { name: string; subPath?: string }[];
        }[];
    };
}
const jobView = (spec: JobSpecOf): PodView => ({
    job: spec,
    meta: spec.spec.template.metadata,
    pod: spec.spec.template.spec,
});

/**
 * One container of a claude-code run's pod, seen through the fields every pod shares: the same Job
 * and pod, with only the named container left in `containers` — so each per-container pin below
 * reads `containers[0]` for the supervisor and the exporter as it does for the agent.
 */
const containerView = (config: DriverConfig, of: BoardJob, name: string): PodView => {
    const spec = runnerJobSpec(
        config,
        { ...of, executorType: 'claude-code', ...SUPERVISED },
        { id: SESSION, resume: false }
    );
    const view = jobView(spec);
    const container = spec.spec.template.spec.containers.find((candidate) => candidate.name === name);
    if (!container) throw new Error(`the run's pod has no ${name} container`);
    return { ...view, pod: { ...view.pod, containers: [container] } };
};

/** The gate builder's input, the one argument object every gate spec here starts from. */
const gateArgs = (over: Partial<Parameters<typeof gateJobSpec>[2]> = {}): Parameters<typeof gateJobSpec>[2] => ({
    key: `bellows/${USER}/.worktrees/${job.id}`,
    image: 'node:24',
    gateName: 't',
    command: 'npm test',
    run: 1,
    envSecretName: null,
    gateTimeoutMs: 30_000,
    ...over,
});

const everyPodSpec = (env: NodeJS.ProcessEnv = {}, of: BoardJob = job): Record<PodName, () => PodView> => {
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, ...env });
    const repoJob: BoardJob = { ...of, repo: 'Bellows-AI/factory' };
    const startedAt = '2026-09-01T00:00:00Z';
    return {
        'the runner': () => jobView(runnerJobSpec(config, of, { id: SESSION, resume: false })),
        'the gate': () => jobView(gateJobSpec(config, of, gateArgs())),
        'the opencode session readout': () => jobView(opencodeReadoutJobSpec(config, of, startedAt)),
        'the claude turns readout': () => jobView(claudeTurnsJobSpec(config, of, SESSION, startedAt)),
        'the task supervisor': () => containerView(config, of, SUPERVISOR_CONTAINER),
        'the transcript exporter': () => containerView(config, of, EXPORTER_CONTAINER),
        'the reclaim group': () => jobView(reclaimGroupSpec(config, repoJob)),
        'the service pod': () => {
            const pod = servicePodSpec(config, of, { name: 'cache', image: 'redis', environment: [] }, 'svc-uid');
            return { meta: pod.metadata, pod: pod.spec };
        },
    };
};

describe('resources on every pod the driver specs', () => {
    // Issue #360: the autoscaler sizes the whole runner fleet, not just the runner pod — an
    // unschedulable sync or gate on a right-sized node strands the run. One config, every
    // builder: the requests render on each container from the same four variables. The one Pod
    // (not Job) in the fleet, a declared service under the attempt's headless Service, is sized
    // like everything else, or it lands wherever a pod slot is free.
    const REQUESTS = { requests: { cpu: '500m', memory: '1Gi' } };
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    // The runner's pod is sized by its agent: the supervisor and the exporter beside it are small
    // scripts, and a request on each would multiply the pod's reservation by three. The reclaim
    // group is a supervisor alone, so it carries no request at all.
    const SIDECARS: readonly PodName[] = ['the task supervisor', 'the transcript exporter', 'the reclaim group'];
    const SIZED_POD_NAMES = POD_NAMES.filter((name) => !SIDECARS.includes(name));

    it.each(SIDECARS)('leaves %s unsized: the pod is sized by its agent', (name) => {
        const { pod } = everyPodSpec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' })[name]();
        expect(pod.containers[0]!.resources).toBeUndefined();
    });

    it.each(SIZED_POD_NAMES)('carries the same requests on %s', (name) => {
        const { pod } = everyPodSpec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' })[name]();
        expect(pod.containers[0]!.resources).toEqual(REQUESTS);
    });

    // Issue #507: a gate runs the whole suite, so it is sized by GATE_* — every other aux Job
    // keeps the runner's sizing, and an unset GATE_ slot inherits the runner's.
    it('sizes the gate Job by GATE_* while every other aux Job keeps the runner resources', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            RUNNER_CPU_REQUEST: '500m',
            RUNNER_MEMORY_REQUEST: '1Gi',
            RUNNER_CPU_LIMIT: '4',
            GATE_CPU_REQUEST: '2',
            GATE_MEMORY_REQUEST: '2Gi',
        });
        const gate = gateJobSpec(config, job, gateArgs());
        expect(gate.spec.template.spec.containers[0]!.resources).toEqual({
            requests: { cpu: '2', memory: '2Gi' },
            limits: { cpu: '4' },
        });
        // The runner's pod keeps the runner's sizing, through its agent.
        const runnerPod = runnerJobSpec(config, repoJob, { id: SESSION, resume: false });
        expect(runnerPod.spec.template.spec.containers[0]!.resources).toEqual({
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '4' },
        });
    });

    it.each(SIZED_POD_NAMES)('carries no resources on %s when none are configured', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.resources).toBeUndefined();
    });
});

// Every pod runs once and never talks to the apiserver: no restart, no service-account token.
// Every Job-backed pod is bounded by a deadline of its own, never retried, and reaped once done.
describe('the lifecycle of every pod the driver specs', () => {
    it.each(POD_NAMES)('runs %s once, without a service-account token', (name) => {
        const { pod } = everyPodSpec()[name]();
        expect(pod.restartPolicy).toBe('Never');
        expect(pod.automountServiceAccountToken).toBe(false);
    });

    it.each(JOB_POD_NAMES)('bounds %s with a deadline of its own, never retries it and reaps its pod', (name) => {
        const { job: jobObject } = everyPodSpec()[name]();
        expect(jobObject?.spec.activeDeadlineSeconds).toBeGreaterThan(0);
        expect(jobObject?.spec.backoffLimit).toBe(0);
        expect(jobObject?.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    });
});

/*
 * Issue #382. Every pod the driver specs runs code it did not write — the agent's commands, the
 * repository's scripts, a gate, a helper, a declared service's image. The hardening below is what
 * stands between that code and the node, and it is unconditional: there is no config knob, because
 * an operator who can turn it off is an operator who will find it off after an incident.
 *
 * What actually protects a NEW aux Job is not the list above — which is hand-written and can fall
 * behind — but the single spread inside `auxJobSpec`, which every aux builder goes through. This
 * suite pins that the spread exists and reaches all ten of today's aux builders (`runnerJobSpec`
 * has its own spread and never goes through it), and the declared service pod besides.
 */
describe('the pod hardening on every pod the driver specs (#382)', () => {
    // A capability is a slice of root the kernel hands a process without asking anyone. An agent
    // run needs none of them: it reads, writes and compiles inside its own worktree. Dropping ALL
    // is what makes `CAP_NET_RAW` (ARP spoofing a neighbour pod) and `CAP_DAC_OVERRIDE` (reading
    // past the file modes on the shared claim) unavailable rather than merely unused.
    it.each(POD_NAMES)('drops every capability on %s', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.capabilities?.drop).toEqual(['ALL']);
    });

    // Without this a setuid binary inside the image re-acquires what the drop above removed, and
    // the drop becomes decoration. The two are one control; they are asserted separately because
    // a regression reaches for one at a time.
    it.each(POD_NAMES)('refuses privilege escalation on %s', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.allowPrivilegeEscalation).toBe(false);
    });

    // Pod level, not container level: seccomp is a property of the whole pod's containers, and
    // naming it once is what keeps a future sidecar from being born unfiltered. RuntimeDefault is
    // the runtime's own profile — it blocks the syscalls a container has no business making
    // (keyctl, the kernel module calls) without the per-image tuning a Localhost profile needs.
    it.each(POD_NAMES)('runs %s under the runtime default seccomp profile', (name) => {
        expect(everyPodSpec()[name]().pod.securityContext?.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    });

    // The deliberate absence, pinned so a future tightening reads the reason before it lands: an
    // agent run writes its caches, its HOME and its git worktree, and a read-only root filesystem
    // fails it on the first npm install. The workspace is the writable surface by design; see
    // docs/security.md, "What the hardening does not do".
    it.each(POD_NAMES)('sets no readOnlyRootFilesystem on %s, which an agent run needs', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.readOnlyRootFilesystem).toBeUndefined();
    });

    // A declared service is the one pod in the fleet whose image the driver did not build: a
    // repository author names it in `.bellows.yaml` and the cluster pulls it. It is hardened like
    // everything else (the rows above) — "every execution path" is the whole point of the issue —
    // and the escape hatch below is a declaration, not a default.
    it('hardens a declared service pod like every other pod', () => {
        expect(everyPodSpec()['the service pod']().meta.labels['factory.unhardened']).toBeUndefined();
    });

    // The opt-out, and exactly how far it goes. `unhardened: true` restores THE IMAGE'S DEFAULT
    // CAPABILITY SET and nothing else, because that is the only part that breaks a stock image: a
    // root entrypoint that chowns its data directory needs CHOWN, DAC_OVERRIDE and FOWNER back.
    // It does not need to escalate, so the escalation bit stays off, and it does not need an
    // unfiltered syscall table, so the seccomp profile stays on. The label is what lets the
    // admission policy tell a declared opt-out from a driver that silently stopped hardening.
    it('lets a declared service opt out of the capability drop, and of nothing else', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        const pod = servicePodSpec(
            config,
            job,
            { name: 'db', image: 'postgres:16', environment: [], unhardened: true },
            'svc-uid'
        );
        expect(pod.spec.containers[0]!.securityContext?.capabilities).toBeUndefined();
        expect(pod.spec.containers[0]!.securityContext?.allowPrivilegeEscalation).toBe(false);
        expect(pod.spec.securityContext?.seccompProfile).toEqual({ type: 'RuntimeDefault' });
        expect(pod.metadata.labels['factory.unhardened']).toBe('true');
        // Nothing the opt-out touches reaches the node: it is still a tokenless pod, and the
        // admission policy still refuses it a host mount and a foreign Secret.
        expect(pod.spec.automountServiceAccountToken).toBe(false);
    });

    // The hardened alternative, same reach as `--user` on docker: the declared uid:gid on the
    // container, every capability still dropped, and no opt-out label for admission to read.
    it('runs a declared service as its declared uid:gid, still hardened', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        const pod = servicePodSpec(
            config,
            job,
            { name: 'db', image: 'postgres:17', environment: [], user: { uid: 999, gid: 999 } },
            'svc-uid'
        );
        expect(pod.spec.containers[0]!.securityContext).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            runAsNonRoot: true,
            runAsUser: 999,
            runAsGroup: 999,
        });
        expect(pod.metadata.labels['factory.unhardened']).toBeUndefined();
    });

    it('sets no uid on a service that declared none', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        const pod = servicePodSpec(config, job, { name: 'db', image: 'postgres:17', environment: [] }, 'svc-uid');
        expect(pod.spec.containers[0]!.securityContext?.runAsUser).toBeUndefined();
    });

    // The merge, not the replace. The gate writes the shared worktree as a fixed uid:gid, and that
    // pod-level securityContext is the same field the seccomp profile lands in — a builder that
    // assigns instead of spreading silently drops one of the two, and only one of the two has a
    // visible symptom.
    it('keeps the gate uid:gid beside the seccomp profile', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        const gate = gateJobSpec(config, job, gateArgs());
        expect(gate.spec.template.spec.securityContext).toEqual({
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
        });
    });
});

/*
 * The runner is tested against an injected request function — the same discipline board.test.ts
 * applies to fetch, and the reason this suite spawns nothing and needs no cluster. The fake is a
 * router over (method, path): everything it is not told about throws, so a test that passes is one
 * whose every call was accounted for.
 */
interface Call {
    method: string;
    path: string;
    body?: unknown;
}

const namespace = 'factory';

const podName = `${runnerJobName(job)}-xxxxx`;

/**
 * The close-time claude-code turn read, appended to every claude-code run: one aux Job over the
 * PVC, its verdict poll, the pod log it answers through, and the reaping delete. The fake routes
 * the Job status and pod routes to the same canned answers the runner Job gets, so the read
 * "succeeds" with an unparseable log — agentTurns null, the unmeasured answer.
 */
const cturnsCalls = (j: BoardJob): string[] => [
    `POST ${jobsPath(namespace)}`,
    `GET ${jobPath(namespace, claudeTurnsJobName(j))}`,
    `GET /api/v1/namespaces/factory/pods`,
    `GET /api/v1/namespaces/factory/pods/${podName}/log`,
    `DELETE ${jobPath(namespace, claudeTurnsJobName(j))}`,
];

/**
 * The methods of a runner attempt from its Secret on: the Secret POST, the claim verify, the
 * Job POST, the claim verify, the status poll, the pod list and the log; then the close-time
 * claude-code turn read — one aux Job, posted,
 * polled, its pod listed, logged and reaped; then the claim read and its release. The group's
 * Secret is not reaped here: `finish` does. The fence tests spell out everything before it.
 */
const RUN_FROM_SECRET = [
    ...['POST', 'GET', 'POST', 'GET', 'GET', 'GET', 'GET'],
    ...['POST', 'GET', 'GET', 'GET', 'DELETE'],
    // The claim read and its release. The Secret and the group are not reaped: they outlive the run.
    ...['GET', 'DELETE'],
];

const FAKE: Record<string, unknown> = {
    create: { status: 201, body: '{}' },
    // The fence: a label LIST that answers empty (nothing left to delete). fenceDelete stays
    // only so an unexpected collection DELETE still gets an answer instead of a route miss.
    fenceDelete: { status: 200, body: '{}' },
    fenceList: { status: 200, body: '{"items":[]}' },
    job: { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) },
    failed: {
        status: 200,
        body: JSON.stringify({ status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] } }),
    },
    pods: {
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                },
            ],
        }),
    },
    log: { status: 200, body: 'did the work\n' },
    secretCreate: { status: 201, body: '{}' },
    secretDelete: { status: 200, body: '{}' },
};

/** A request function that answers from FAKE, or throws if the test did not script the call. */
const fakeRequest = (overrides: Record<string, unknown> = {}): { request: K8sRequest; calls: Call[] } => {
    const calls: Call[] = [];
    const answers = { ...FAKE, ...overrides };
    const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
    // The checkout claim, emulated the way the apiserver arbitrates it: name uniqueness on POST,
    // a readable GET, a uid-preconditioned DELETE (see claimServer).
    const serve = claimServer();
    const request: K8sRequest = (method, path, body) => {
        calls.push({ method, path, body });
        const claimAnswer = serve(method, path, body);
        if (claimAnswer) return Promise.resolve(claimAnswer);
        if (path === jobsPath(namespace) && method === 'POST') return Promise.resolve(answers.create as K8sResponse);
        if (path.startsWith(`${jobsPath(namespace)}?`)) {
            if (method === 'DELETE') return Promise.resolve(answers.fenceDelete as K8sResponse);
            return Promise.resolve(answers.fenceList as K8sResponse);
        }
        if (path === secretsPath) {
            if (method === 'DELETE') return Promise.resolve(answers.secretDelete as K8sResponse);
            return Promise.resolve(answers.secretCreate as K8sResponse);
        }
        if (path.startsWith(`${secretsPath}/`)) return Promise.resolve(answers.secretDelete as K8sResponse);
        // Any attempt's Job: names carry the lease token now, so a run's own status poll targets
        // a path built from ITS token, not the fixture job's.
        if (path.startsWith(`${jobsPath(namespace)}/`)) return Promise.resolve(answers.job as K8sResponse);
        // Service objects: lists answer empty (nothing to sweep, nothing to tear down), a POST
        // creates one, a delete succeeds. Overrides script the interesting cases.
        const servicesPath = `/api/v1/namespaces/${namespace}/services`;
        if (path === servicesPath) {
            if (method === 'DELETE') return Promise.resolve(answers.fenceDelete as K8sResponse);
            return Promise.resolve((answers.serviceCreate ?? { status: 201, body: '{}' }) as K8sResponse);
        }
        if (path.startsWith(`${servicesPath}?`)) return Promise.resolve(answers.fenceList as K8sResponse);
        if (path.startsWith(`${servicesPath}/`)) return Promise.resolve(answers.fenceDelete as K8sResponse);
        if (
            path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
            decodeURIComponent(path).includes('job-name=')
        ) {
            return Promise.resolve(answers.pods as K8sResponse);
        }
        if (path.startsWith(`/api/v1/namespaces/${namespace}/pods/`) && !path.endsWith('/log') && method === 'DELETE') {
            return Promise.resolve(answers.fenceDelete as K8sResponse);
        }
        if (path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)) {
            return Promise.resolve(answers.log as K8sResponse);
        }
        {
            const aux = auxRoutes(method, path);
            if (aux) return Promise.resolve(aux);
        }
        return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
    };
    return { request, calls };
};

/** A test's own routes, tried before fakeRequest's; `undefined` falls through to them. */
type Special = (method: K8sMethod, path: string, body: unknown) => K8sResponse | Promise<K8sResponse> | undefined;

/**
 * fakeRequest with the routes a test is about in front of it: `special` answers first, and
 * anything it leaves (`undefined`) falls through to fakeRequest — whose claim server, Job,
 * pod, log, Secret and aux routes answer as usual, and whose unscripted paths still reject.
 * Every call is recorded, the ones `special` answered included.
 */
const routed = (special: Special, overrides: Record<string, unknown> = {}): { request: K8sRequest; calls: Call[] } => {
    const calls: Call[] = [];
    const base = fakeRequest(overrides);
    const request: K8sRequest = (method, path, body) => {
        calls.push({ method, path, body });
        const answer = special(method, path, body);
        return answer === undefined ? base.request(method, path, body) : Promise.resolve(answer);
    };
    return { request, calls };
};

/** The answer a hand-written fake gave a call it did not script. */
const noAnswer = (method: K8sMethod, path: string): Promise<K8sResponse> =>
    Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
/** A DELETE of one Job by name — a `routed` fake whose original never scripted it rejects it. */
const isJobDelete = (method: K8sMethod, path: string): boolean =>
    method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`);
/** A DELETE of the checkout claim — likewise rejected where the original never scripted it. */
const isClaimDelete = (method: K8sMethod, path: string): boolean =>
    method === 'DELETE' && path.startsWith(`${configmapsPath}/`);

const stepOk = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** What the supervisor answers a step by default: the sync's verdict, otherwise a quiet success. */
const defaultStepAnswer = (step: StepRequest): StepResult =>
    stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : '');

/**
 * The supervised-step channel of an attempt (issue #771): records every step submitted, answers each
 * through `answer`, and reports only when the test says so — so a run's end is the Job's, as it is
 * for any test that scripts the Job status, unless a test calls `report`.
 */
function fakeSteps(answer: (step: StepRequest) => StepResult | Promise<StepResult> = defaultStepAnswer) {
    const submitted: StepRequest[] = [];
    const tokens = new Set<string>();
    const signals: (AbortSignal | undefined)[] = [];
    let report!: (r: SupervisorReport) => void;
    const reported = new Promise<SupervisorReport>((resolve) => {
        report = resolve;
    });
    const sink: StepSink = {
        submit: async (token, step, signal) => {
            tokens.add(token);
            signals.push(signal);
            if (signal?.aborted) throw new Error('the step was cancelled');
            submitted.push(step);
            return answer(step);
        },
        awaitReport: () => reported,
        contacted: () => true,
    };
    return { sink, submitted, tokens, signals, report };
}
const kindsOf = (steps: { submitted: StepRequest[] }): string[] => steps.submitted.map((step) => step.kind);

/** createKubernetesRunner with a step channel wired in unless the test brings its own: no attempt runs without one. */
const supervisedRunner = (
    config: DriverConfig,
    request: K8sRequest,
    sleep: (ms: number) => Promise<void> = async () => {},
    wiring: Parameters<typeof createKubernetesRunner>[3] = {}
) => createKubernetesRunner(config, request, sleep, { steps: fakeSteps().sink, ...wiring });

const runner = (
    request: K8sRequest,
    env: Record<string, string> = {},
    leases?: Board['leases'],
    steps: StepSink = fakeSteps().sink
) =>
    supervisedRunner(
        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0', ...env }),
        request,
        async () => {},
        { ...(leases ? { leases } : {}), steps }
    );

/** The board's lease lookup, answering that `held` holds the job's live lease. */
const boardLease =
    (held: BoardJob, leaseToken: string | null = held.leaseToken): Board['leases'] =>
    async (ids) =>
        ids.includes(held.id) ? [{ id: held.id, status: 'running', leaseToken }] : [];

/**
 * Default answers for the objects the runner touches beyond the runner Job itself: the fence
 * sweeps service pods and headless Services by the job label, the lease teardown lists them,
 * and aux Jobs (gates, the .bellows.yaml readout) ride the same Job routes the tests script.
 * fakeRequest (and so every routed fake) falls through to this before rejecting, so a test only scripts the
 * objects it is about. Lists answer empty — nothing to sweep, nothing to tear down.
 */
const AUX = {
    list: { status: 200, body: '{"items":[]}' },
    delete: { status: 200, body: '{}' },
    create: { status: 201, body: '{}' },
} satisfies Record<string, K8sResponse>;
function auxRoutes(method: string, path: string): K8sResponse | null {
    const ns = `/api/v1/namespaces/${namespace}`;
    if (path === `${ns}/services`) {
        if (method === 'DELETE') return AUX.delete;
        if (method === 'POST') return AUX.create;
        return AUX.list;
    }
    if (path.startsWith(`${ns}/services?`)) return AUX.list;
    if (path.startsWith(`${ns}/services/`)) return AUX.delete;
    // Every pod list EXCEPT the runner's job-name discovery (those are routed by the routers
    // above): the fence's sweep and the lease teardown answer empty — nothing of this job's.
    if (path.startsWith(`${ns}/pods?`)) return AUX.list;
    if (path.startsWith(`${ns}/pods/`) && !path.endsWith('/log') && method === 'DELETE') return AUX.delete;
    return null;
}

/** A lease token distinct from the fixture job's, for the attempt that reclaimed a job. */
const NEW_TOKEN = '99999999-9999-4999-8999-999999999999';

/** The run start both close-time readouts bound their turn counts to. */
const START = '2026-08-20T06:00:00.000Z';

const configmapsPath = `/api/v1/namespaces/${namespace}/configmaps`;

/** The checkout claim's path: one ConfigMap per JOB id, shared by every attempt (issue #32). */
const claimPathFor = (id: string): string => `${configmapsPath}/factory-job-${id}-claim`;

/**
 * A minimal API server for the checkout claim: ConfigMap NAME uniqueness arbitrates (a POST of a
 * taken name answers 409), a GET reads the stored claim, and a DELETE honors uid preconditions —
 * exactly the three apiserver properties the acquire/takeover/release protocol rests on.
 */
const claimServer = () => {
    const claims = new Map<string, { uid: string; holder: string; claimSeq: string; created: string }>();
    let uids = 0;
    return (method: K8sMethod, path: string, body: unknown): K8sResponse | undefined => {
        if (method === 'POST' && path === configmapsPath) {
            const b = body as { metadata?: { name?: string }; data?: { holder?: string; claimSeq?: string } };
            const name = b.metadata?.name ?? '';
            if (claims.has(name)) return { status: 409, body: '{"reason":"AlreadyExists"}' };
            claims.set(name, {
                uid: `claim-uid-${++uids}`,
                holder: b.data?.holder ?? '',
                claimSeq: b.data?.claimSeq ?? '',
                // The apiserver stamps this on every object; the orphaned-claim readout (issue
                // #344) reports the claim's age from it.
                created: new Date().toISOString(),
            });
            return { status: 201, body: '{}' };
        }
        if (path?.startsWith(`${configmapsPath}/`)) {
            const name = path.slice(configmapsPath.length + 1);
            const claim = claims.get(name);
            if (method === 'GET') {
                return claim
                    ? {
                          status: 200,
                          body: JSON.stringify({
                              metadata: { uid: claim.uid, creationTimestamp: claim.created },
                              data: { holder: claim.holder, claimSeq: claim.claimSeq },
                          }),
                      }
                    : { status: 404, body: '{"kind":"Status"}' };
            }
            if (method === 'DELETE') {
                const want = (body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid;
                if (claim && (!want || want === claim.uid)) {
                    claims.delete(name);
                    return { status: 200, body: '{}' };
                }
                return { status: claim ? 409 : 404, body: '{"kind":"Status"}' };
            }
        }
        return undefined;
    };
};

describe('readVerdict', () => {
    const depsOf = (request: K8sRequest): K8sDeps => ({
        request,
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
    });

    it('retries a plain-text 400 Bad Request like a 5xx and answers the eventual 2xx', async () => {
        let reads = 0;
        const request: K8sRequest = () => {
            reads += 1;
            return reads <= 2
                ? Promise.resolve({ status: 400, body: '400 Bad Request' })
                : Promise.resolve({ status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) });
        };
        const response = await readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j');
        expect(response.status).toBe(200);
        expect(reads).toBe(3);
    });

    it('does not retry a JSON Status 400 — the API refused, and retrying would only repeat it', async () => {
        let reads = 0;
        const request: K8sRequest = () => {
            reads += 1;
            return Promise.resolve({
                status: 400,
                body: '{"kind":"Status","status":"Failure","reason":"Invalid","message":"Job.batch is invalid"}',
            });
        };
        const response = await readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j');
        expect(response.status).toBe(400);
        expect(reads).toBe(1);
    });

    it('throws with the body in the message when the malformed 400 never stops', async () => {
        const request: K8sRequest = () => Promise.resolve({ status: 400, body: '400 Bad Request' });
        await expect(readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j')).rejects.toThrow(
            /answered 400 .* in a row.*400 Bad Request/s
        );
    });
});

/*
 * The startup sync (issue #35), ported: the docker runner creates the task worktree with a
 * `docker run` of the worktree script; here the same script is the same Job shape every other
 * aux Job uses — the declared image over the workspaces PVC, read-write this time, because the
 * whole point is creating the worktree the run will edit. Executor parity is why this exists:
 * without it, every claimed job fails at the loop's sync step.
 */
/*
 * The startup sync is the attempt's first supervised step (issue #771): the fence takes the checkout
 * claim, the attempt's group is created (one Job, its supervisor, its agent), and the sync is a
 * step the supervisor runs as a child process. What it asks and how its answer reads is pinned
 * here; the group's own lifecycle is k8s-group.test.ts.
 */
describe('the worktree sync', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const WORKTREE = `/workspaces/bellows/${USER}/.worktrees/${repoJob.id}`;
    const syncOf = (steps: { submitted: StepRequest[] }): StepRequest =>
        steps.submitted.find((s) => s.kind === 'sync')!;
    const syncing = (stdout: string) => fakeSteps((step) => (step.kind === 'sync' ? stepOk(stdout) : stepOk()));
    const SESSION_OF = { id: SESSION, resume: false };
    const sync = (j: BoardJob, steps = fakeSteps(), request = fakeRequest().request, githubToken?: string) =>
        runner(request, {}, undefined, steps.sink).syncCheckout(j, undefined, SESSION_OF, githubToken);
    const deletedGroup = (calls: Call[], j: BoardJob, propagation: string) =>
        calls.findIndex(
            (call) =>
                call.method === 'DELETE' &&
                call.path === `${jobsPath(namespace)}/${runnerJobName(j)}?propagationPolicy=${propagation}`
        );

    it('submits the worktree script as one sync step, naming the three paths as literals beside the claim env', async () => {
        const envJob: BoardJob = { ...repoJob, env: { CORE_TOKEN: 'shh' } };
        const steps = fakeSteps();
        expect(await sync(envJob, steps)).toEqual({ ok: true, reason: null });

        const step = syncOf(steps);
        expect(step.argv).toEqual(['node', '-e', gitWorktreeScript]);
        expect(step.env).toEqual({
            CORE_TOKEN: 'shh',
            REPO: `/workspaces/bellows/${USER}/factory`,
            WORKTREE,
            BRANCH: `factory/${repoJob.id}`,
        });
        expect(steps.tokens).toEqual(new Set([CONTROL_TOKEN]));
    });

    it('creates no Job of its own: the sync rides the attempt’s one group', async () => {
        const { request, calls } = fakeRequest();
        await sync(repoJob, fakeSteps(), request);
        const jobs = calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(jobs.map((call) => (call.body as { metadata: { name: string } }).metadata.name)).toEqual([
            runnerJobName(repoJob),
        ]);
    });

    // The sync's fetch needs a credential helper to read the token git never reads from the
    // environment — but only beside the token the board minted for it (docs/connections.md): a
    // public repo must keep its plain unauthenticated fetch. What travels as the literal is helper
    // CODE, never the credential value — the token is the step's env alone.
    it("passes the sync the credential-helper code only beside the board's minted token", async () => {
        const withToken = fakeSteps();
        await sync(repoJob, withToken, undefined, 'ghs_minted');
        expect(syncOf(withToken).env.CRED_HELPER).toBe(CREDENTIAL_HELPER);
        expect(syncOf(withToken).env.GITHUB_TOKEN).toBe('ghs_minted');
        expect(syncOf(withToken).env.CRED_HELPER).not.toContain('ghs_minted');

        // A claim value under the reserved name is no token: dropped, never forwarded, no helper.
        const noToken = fakeSteps();
        await sync({ ...repoJob, env: { GITHUB_TOKEN: 't0k-3n', CORE_TOKEN: 'shh' } }, noToken);
        expect(syncOf(noToken).env).not.toHaveProperty('CRED_HELPER');
        expect(JSON.stringify(syncOf(noToken))).not.toContain('t0k-3n');

        // An EMPTY token is no token: the helper would answer an empty password and break the
        // public-repo plain fetch it exists to preserve.
        const emptyToken = fakeSteps();
        await sync(repoJob, emptyToken, undefined, '');
        expect(syncOf(emptyToken).env).not.toHaveProperty('CRED_HELPER');
    });

    // A claim that CONTINUES a session — a follow-up, or a parked job resumed — is mid-task, and
    // git operations that touch the remote belong to the task's beginning and end (issue #58).
    // Its sync is a RESTORE: the step carries the literal, no credential helper even with a
    // token, and no claim env at all.
    it('carries RESTORE for a claim that continues a session, with no helper and no claim env', async () => {
        const followUp = fakeSteps();
        await sync({ ...repoJob, followUp: true }, followUp, undefined, 't0k-3n');
        expect(syncOf(followUp).env.RESTORE).toBe('1');
        expect(syncOf(followUp).env).not.toHaveProperty('CRED_HELPER');
        expect(JSON.stringify(syncOf(followUp))).not.toContain('t0k-3n');

        // A parked job resumed (resumeSessionId without followUp) is the same mid-task hazard.
        const parked = fakeSteps();
        await sync({ ...repoJob, resumeSessionId: SESSION }, parked, undefined, 't0k-3n');
        expect(syncOf(parked).env.RESTORE).toBe('1');
        expect(JSON.stringify(syncOf(parked))).not.toContain('t0k-3n');

        // A starting claim — even with a token — carries no RESTORE.
        const fresh = fakeSteps();
        await sync(repoJob, fresh, undefined, 't0k-3n');
        expect(syncOf(fresh).env).not.toHaveProperty('RESTORE');
    });

    it('carries no claim env for a claim that resolved to none', async () => {
        const steps = fakeSteps();
        await sync(repoJob, steps);
        expect(Object.keys(syncOf(steps).env).sort()).toEqual(['BRANCH', 'REPO', 'WORKTREE']);
    });

    // No task worktree resolves for a thread root that is not a uuid, so there is nothing to sync;
    // the run that follows refuses it (the runner job spec's own refusal, above).
    it('submits nothing for a worktree path it cannot assert', async () => {
        const steps = fakeSteps();
        const { request, calls } = fakeRequest();
        expect(await sync({ ...repoJob, rootJobId: 'not-a-uuid' }, steps, request)).toEqual({ ok: true, reason: null });
        expect(steps.submitted).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it('takes the claim, then the attempt’s Secret and group, then submits the sync — and keeps all of it for the run', async () => {
        const { request, calls } = fakeRequest();
        const steps = fakeSteps();
        const result = await sync({ ...repoJob, env: { CORE_TOKEN: 'shh' } }, steps, request);

        expect(result).toEqual({ ok: true, reason: null });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const order = calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`);
        const claimPost = order.indexOf(`POST ${configmapsPath}`);
        expect(claimPost).toBe(0);
        expect(claimPost).toBeLessThan(order.indexOf(`POST ${secretsPath}`));
        expect(order.indexOf(`POST ${secretsPath}`)).toBeLessThan(order.indexOf(`POST ${jobsPath(namespace)}`));
        expect(kindsOf(steps)).toEqual(['sync']);
        // Success KEEPS the claim, the group and its Secret: the run (and its steps after it) follow
        // within the same lease, and releasing here would open a window another claimant could use.
        expect(order).not.toContain(`DELETE ${claimPathFor(repoJob.id)}`);
        expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    });

    it('syncs nothing for a job that names no repository', async () => {
        const { request, calls } = fakeRequest();
        const steps = fakeSteps();
        expect(await sync(job, steps, request)).toEqual({ ok: true, reason: null });
        expect(calls).toHaveLength(0);
        expect(steps.submitted).toEqual([]);
    });

    it.each([
        [
            'the script’s own reason',
            stepOk('{"ok":false,"reason":"worktree sync failed: no space left"}\n'),
            /^worktree sync failed: no space left$/,
        ],
        [
            'the tool’s words when the step exits non-zero with no verdict',
            { exitCode: 2, stdout: '', stderr: 'fatal: could not read from remote repository\n', timedOut: false },
            /^the worktree sync failed: fatal: could not read from remote repository$/,
        ],
        [
            'a named deadline when the supervisor ends the step at its bound',
            { exitCode: null, stdout: '', stderr: '', timedOut: true },
            /^the worktree sync failed: the step exceeded its \d+ms deadline$/,
        ],
        [
            'the last output when a clean exit printed no verdict',
            stepOk('fetching origin\nsome other line\n'),
            /^the worktree sync answered nothing readable[\s\S]*some other line/,
        ],
    ] as const)('answers ok:false with %s', async (_what, answer, reason) => {
        const result = await sync(
            repoJob,
            fakeSteps(() => answer)
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(reason);
    });

    it('carries the script’s failure kind through the step’s answer (issue #666)', async () => {
        const verdict = { ok: false, reason: 'the repository clone /w/r does not exist', kind: 'missing_clone' };
        expect(await sync(repoJob, syncing(`${JSON.stringify(verdict)}\n`))).toMatchObject(verdict);
    });

    it('answers checkout contention with the transient reason, its claim already given back', async () => {
        const reason =
            'transient worktree sync: the checkout lock /w/.git/factory-sync.lock is still held after 20000ms';
        const { request, calls } = fakeRequest();

        const result = await sync(repoJob, syncing(`${JSON.stringify({ ok: false, reason })}\n`), request);

        expect(result.ok).toBe(false);
        expect(TRANSIENT_SYNC_REASON.test(result.reason ?? '')).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(true);
    });

    // A failed sync means no runner follows, so nobody else would give the checkout back: the
    // claim goes, conditionally on this attempt still holding its exact incarnation.
    it('releases the claim when the sync fails after taking it', async () => {
        const { request, calls } = fakeRequest();
        const result = await sync(
            repoJob,
            syncing('{"ok":false,"reason":"worktree sync failed: no space left"}\n'),
            request
        );
        expect(result.ok).toBe(false);
        const release = calls.find((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
        expect(release).toBeDefined();
        // The uid precondition is what keeps a stale release from reaching a newer claim.
        expect((release?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBeDefined();
    });

    /*
     * A failure hands the checkout over to a replacement — and a replacement's sync must not
     * overlap the failed attempt's group on the shared worktree. So the failure arms delete the
     * group with Foreground propagation (the delete returns only after the pod is gone) and AWAIT
     * it BEFORE releaseClaim. Modeled with a delay on the group's delete: a release issued before
     * the await would complete (and be recorded) first.
     */
    it('takes the group down Foreground, and only then releases the claim, when the sync fails', async () => {
        const base = fakeRequest();
        const completions: string[] = [];
        const gated: K8sRequest = async (method, path, body) => {
            const response = await base.request(method, path, body);
            if (
                method === 'DELETE' &&
                path === `${jobPath(namespace, runnerJobName(repoJob))}?propagationPolicy=Foreground`
            ) {
                // Foreground returns only once the dependents are gone — that takes time.
                await new Promise((resolve) => setTimeout(resolve, 20));
                completions.push('group-gone');
            } else if (method === 'DELETE' && path === claimPathFor(repoJob.id)) {
                completions.push('claim-released');
            }
            return response;
        };
        const result = await sync(
            repoJob,
            syncing('{"ok":false,"reason":"worktree sync failed: no space left"}\n'),
            gated
        );

        expect(result.ok).toBe(false);
        expect(completions).toEqual(['group-gone', 'claim-released']);
        // The Secret goes with it: nothing of the attempt is left behind a failed sync.
        expect(
            base.calls.some(
                (c) =>
                    c.method === 'DELETE' && c.path === `/api/v1/namespaces/${namespace}/secrets/${secretName(repoJob)}`
            )
        ).toBe(true);
    });

    // The same handover discipline on the THROW arm: a step whose answer never came (the channel
    // closed under it) leaves a group that may still be running, and the rethrow follows the
    // release — so the take-down must be complete before the claim goes.
    it('takes the group down Foreground, and only then releases the claim, when the sync step throws', async () => {
        const base = fakeRequest();
        const completions: string[] = [];
        const gated: K8sRequest = async (method, path, body) => {
            const response = await base.request(method, path, body);
            if (method === 'DELETE' && path.includes(runnerJobName(repoJob))) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                completions.push('group-gone');
            } else if (method === 'DELETE' && path === claimPathFor(repoJob.id)) {
                completions.push('claim-released');
            }
            return response;
        };
        const steps = fakeSteps(() => {
            throw new Error('the step channel closed');
        });
        await expect(sync(repoJob, steps, gated)).rejects.toThrow(/step channel closed/);
        expect(completions).toEqual(['group-gone', 'claim-released']);
    });

    // The mirror pin: success keeps ownership, so no delete of any kind is issued — the claim and
    // the group are held through the run, and `finish` ends the group.
    it('never deletes the group when the sync succeeds', async () => {
        const { request, calls } = fakeRequest();
        expect(await sync(repoJob, fakeSteps(), request)).toEqual({ ok: true, reason: null });
        expect(deletedGroup(calls, repoJob, 'Foreground')).toBe(-1);
        expect(calls.some((call) => call.method === 'DELETE' && call.path.includes(runnerJobName(repoJob)))).toBe(
            false
        );
    });

    // The group's creates, the same transient-400 rule the polls have (issue #308): a pre-handler
    // `400 Bad Request` is connection damage, never the sync's verdict — it throws, and the loop's
    // catch leaves the job to its lease; the throw still hands the checkout over cleanly.
    it.each([
        ['the pre-handler 400', { status: 400, body: '400 Bad Request' }, /creating the runner job answered 400/],
        [
            'a genuine API Status 400',
            {
                status: 400,
                body: '{"kind":"Status","status":"Failure","reason":"Invalid","message":"Job.batch is invalid"}',
            },
            /Job\.batch is invalid/,
        ],
    ])(
        'leaves the sync to the lease when the group POST answers %s, its claim given back',
        async (_what, create, error) => {
            const { request, calls } = fakeRequest({ create });
            await expect(sync(repoJob, fakeSteps(), request)).rejects.toThrow(error);
            expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(true);
        }
    );

    it('leaves the sync to the lease when the attempt’s Secret POST answers the pre-handler 400', async () => {
        const { request } = fakeRequest({ secretCreate: { status: 400, body: '400 Bad Request' } });
        await expect(sync(repoJob, fakeSteps(), request)).rejects.toThrow(/answered 400/);
    });

    /*
     * Issue #302: an executor image the node cannot pull holds the group's pod in ImagePullBackOff
     * and no supervisor ever comes up. The wait names the image the moment the pod does, not after
     * a timeout (the plain case is k8s-group.test.ts). It must not settle while the container is
     * merely WAITING: ContainerCreating covers the whole first pull, and a pull that fails after
     * that tick would otherwise go unnamed (review of issue #302).
     */
    it('keeps watching through ContainerCreating and names the image when the later pull fails', async () => {
        const base = fakeRequest();
        const waitingPod = (reason: string, message?: string): string =>
            JSON.stringify({
                items: [
                    {
                        metadata: { name: podName },
                        status: {
                            containerStatuses: [{ state: { waiting: message ? { reason, message } : { reason } } }],
                        },
                    },
                ],
            });
        let podReads = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (
                method === 'GET' &&
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('job-name=')
            ) {
                podReads += 1;
                return {
                    status: 200,
                    body: waitingPod(
                        podReads === 1 ? 'ContainerCreating' : 'ErrImagePull',
                        podReads === 1 ? undefined : 'pull access denied, repository does not exist'
                    ),
                };
            }
            return base.request(method, path, body);
        };
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        const result = await sync(repoJob, steps, request);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(
            /the executor image "claude-executor" cannot be pulled: ErrImagePull — pull access denied/
        );
        // Named on the SECOND round: the first round's ContainerCreating did not settle the watch.
        expect(podReads).toBe(2);
        expect(steps.submitted).toEqual([]);
    });

    /*
     * The fence before the sync (PR #46 review): the loop calls syncCheckout before run(), so the
     * sync is the FIRST writer on the task worktree — and the only mutual exclusion it can get is
     * the checkout claim, taken here under the same acquireClaim protocol prepare() runs. The
     * claim is then held through the run: prepare()'s acquire recognizes its own holder.
     */
    // The replacement-with-an-active-runner shape of the review comment: a claim POST that
    // answers 409 against a LIVE newer attempt is the run path's stand-down, and the sync must
    // honor it before creating anything — no Secret, no group, nothing to sweep later.
    it('stands down without creating anything when a live newer attempt holds the claim', async () => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 409, body: '{"reason":"AlreadyExists"}' });
            }
            if (path === claimPathFor(job.id) && method === 'GET') {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-9' },
                        data: { holder: NEW_TOKEN, claimSeq: '2' },
                    }),
                });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        const steps = fakeSteps();
        await expect(sync(repoJob, steps, request)).rejects.toThrow(/stands down/);
        expect(calls.some((call) => call.method === 'POST' && call.path.includes('/secrets'))).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        expect(steps.submitted).toEqual([]);
    });

    /*
     * Issue #559: a contention requeue refunds the attempt, so `attempts` can go DOWN between two
     * claims of one job. The claim is ordered by the claim sequence, which never does — a stale
     * worker whose attempt count is ahead of its replacement's still stands down, and a
     * replacement whose attempt was refunded still takes over the claim it supersedes.
     */
    const seedClaim = (request: K8sRequest, claimSeq: string) =>
        request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq },
        });

    it('stands a stale worker down against a newer claim even when its attempt count is ahead', async () => {
        const { request, calls } = fakeRequest();
        await seedClaim(request, '4');

        await expect(sync({ ...repoJob, attempts: 2, claimSeq: 3 }, fakeSteps(), request)).rejects.toThrow(
            /held by a newer claim \(4 >= 3\)/
        );
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
    });

    it('takes over an older claim after its attempt was refunded', async () => {
        const { request } = fakeRequest();
        await seedClaim(request, '3');
        const replacement: BoardJob = { ...repoJob, attempts: 1, claimSeq: 4 };

        expect(await sync(replacement, fakeSteps(), request)).toMatchObject({ ok: true });

        const held = await request('GET', claimPathFor(repoJob.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: replacement.leaseToken, claimSeq: '4' } });
    });

    // Review of PR #564: a claim a pre-#559 driver wrote carries no claimSeq, and is never taken
    // over on that absence alone — only when the board proves this attempt's lease is the live one.
    const seedLegacyClaim = (request: K8sRequest) =>
        request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, attempt: '1' },
        });

    it('takes over a claim with no claim sequence when the board proves this attempt holds the lease', async () => {
        const { request } = fakeRequest();
        await seedLegacyClaim(request);

        expect(
            await runner(request, {}, boardLease(repoJob)).syncCheckout(repoJob, undefined, SESSION_OF)
        ).toMatchObject({ ok: true });
    });

    it.each([
        ['the board names the claim’s holder as the live lease', boardLease(repoJob, NEW_TOKEN)],
        ['the board holds no live lease', boardLease(repoJob, null)],
        ['the board cannot answer', (async () => null) as Board['leases']],
        ['the lookup throws', (async () => Promise.reject(new Error('board unreachable'))) as Board['leases']],
        ['no lookup is wired', undefined],
    ] as const)('stands down on a claim with no claim sequence when %s', async (_what, leases) => {
        const { request, calls } = fakeRequest();
        await seedLegacyClaim(request);

        await expect(runner(request, {}, leases).syncCheckout(repoJob, undefined, SESSION_OF)).rejects.toThrow(
            /stands down/
        );
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
    });

    // The sync takes the claim, the run follows within the same lease on the SAME group: the run's
    // acquire must read the claim it meets as ITS OWN (holder === lease token) and proceed, never
    // stand down against itself — and it creates no second group.
    it('hands the claim and the group to the run that follows without standing down against itself', async () => {
        const { request, calls } = fakeRequest();
        const r = runner(request);
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const outcome = await r.run(repoJob, SESSION_OF);
        expect(outcome.exitCode).toBe(0);
        const groups = calls.filter(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                JSON.stringify(call.body).includes('"factory-runner-')
        );
        expect(groups).toHaveLength(1);
    });
});

/*
 * The terminal reclaim (issue #47), ported the same way the sync was: the remove script as a
 * supervised step, in a supervisor-only group of its own (the thread has no attempt to ask) under
 * a lease token it opens through the driver's endpoint. What it shares with the sync is the
 * checkout CLAIM: a thread that looks terminal can gain a follow-up between the board's answer
 * and the removal, and the follow-up's own sync is a writer on the same root-scoped tree — so
 * the reclaim takes the claim for its whole duration, and an acquire that answers 409 (a live
 * attempt holds the checkout) SKIPS the reclaim. Costing the reclaim is fine by contract;
 * costing a live run is not. No claim env: removing needs nothing the claim held.
 */
describe('the worktree reclaim', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 't0k-3n' } };
    const WORKTREE = `/workspaces/bellows/${USER}/.worktrees/${repoJob.id}`;
    const RECLAIM_TOKEN = 'reclaim-token';
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: RECLAIM_TOKEN }),
        close: () => undefined,
    };
    const reclaimer = (request: K8sRequest, steps = fakeSteps(reclaimAnswer())) =>
        supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {},
            { steps: steps.sink, endpoint }
        );
    function reclaimAnswer(stdout = '{"ok":true,"removed":true,"reason":null}\n') {
        return (step: StepRequest): StepResult => (step.kind === 'reclaim' ? stepOk(stdout) : stepOk());
    }
    const groupOf = (calls: Call[]) =>
        calls.find((call) => call.method === 'POST' && call.path === jobsPath(namespace))!.body as ReturnType<
            typeof runnerJobSpec
        >;

    it('submits the remove script as a reclaim step, naming only the clone and the worktree', async () => {
        const steps = fakeSteps(reclaimAnswer());
        const result = await reclaimer(fakeRequest().request, steps).reclaimWorktree(repoJob);

        expect(result).toEqual({ ok: true, removed: true, reason: null });
        const step = steps.submitted.find((s) => s.kind === 'reclaim')!;
        expect(step.argv).toEqual(['node', '-e', gitWorktreeRemoveScript]);
        // No BRANCH, no credential-helper code, no claim env: reclaim authenticates nothing.
        expect(step.env).toEqual({ REPO: `/workspaces/bellows/${USER}/factory`, WORKTREE });
        expect(steps.tokens).toEqual(new Set([RECLAIM_TOKEN]));
    });

    it('runs in a supervisor-only group over the member’s own subtree, never the attempt’s group', async () => {
        const { request, calls } = fakeRequest();
        await reclaimer(request).reclaimWorktree(repoJob);

        const group = groupOf(calls);
        expect(group.metadata.name).toMatch(/^factory-reclaim-/);
        expect(group.metadata.name).not.toBe(runnerJobName(repoJob));
        expect(group.spec.template.spec.containers.map((c) => c.name)).toEqual([SUPERVISOR_CONTAINER]);
        expect(group.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'workspaces',
            mountPath: `/workspaces/bellows/${USER}`,
            subPath: `bellows/${USER}`,
        });
        // The claim env is never the group's: not in its Secret, not in its spec.
        expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('t0k-3n');
    });

    it('reclaims nothing for a worktree path it cannot assert', async () => {
        const { request, calls } = fakeRequest();
        const result = await reclaimer(request).reclaimWorktree({ ...repoJob, rootJobId: 'not-a-uuid' });
        expect(result).toEqual({ ok: true, removed: false, reason: null });
        expect(calls).toHaveLength(0);
    });

    it('takes the checkout claim before the group and releases it after the group is deleted', async () => {
        const { request, calls } = fakeRequest();
        const result = await reclaimer(request).reclaimWorktree(repoJob);

        expect(result).toEqual({ ok: true, removed: true, reason: null });
        // The claim brackets the group: acquired before the POST (so a follow-up's sync, itself
        // claim-taking, cannot interleave), released only after the group's delete.
        const name = groupOf(calls).metadata.name;
        const claimPost = calls.findIndex((call) => call.method === 'POST' && call.path === configmapsPath);
        const jobPost = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        const jobDelete = calls.findIndex(
            (call) =>
                call.method === 'DELETE' && call.path === `${jobsPath(namespace)}/${name}?propagationPolicy=Foreground`
        );
        const claimDelete = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id)
        );
        expect(claimPost).toBeGreaterThanOrEqual(0);
        expect(jobPost).toBeGreaterThan(claimPost);
        expect(jobDelete).toBeGreaterThan(jobPost);
        expect(claimDelete).toBeGreaterThan(jobDelete);
    });

    it('skips the reclaim — ok:false, no group — when a live attempt holds the checkout claim', async () => {
        const { request, calls } = fakeRequest();
        // Another attempt holds the checkout: a claim whose attempt is at or ahead of ours —
        // a follow-up claimed and mid-sync, most likely. The acquire must refuse to take over.
        await request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '5' },
        });
        const steps = fakeSteps(reclaimAnswer());

        const result = await reclaimer(request, steps).reclaimWorktree(repoJob);

        expect(result.ok).toBe(false);
        expect(result.removed).toBe(false);
        expect(result.reason).toContain('held');
        expect(result.reason).toContain(WORKTREE);
        // Nothing was created against a checkout somebody else is writing.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        expect(steps.submitted).toEqual([]);
    });

    // The failure arms take the group down Foreground BEFORE the release, so a mid-flight
    // removal never outlives the claim it runs under. The thrown step is an ok:false answer
    // now — the reclaim's group is its own, there is no lease to leave the row to.
    it('releases the checkout claim only after the group is gone, even when the step throws', async () => {
        const base = fakeRequest();
        const completions: string[] = [];
        const gated: K8sRequest = async (method, path, body) => {
            const response = await base.request(method, path, body);
            if (method === 'DELETE' && path.includes('/jobs/') && path.endsWith('propagationPolicy=Foreground')) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                completions.push('group-gone');
            } else if (method === 'DELETE' && path === claimPathFor(repoJob.id)) {
                completions.push('claim-released');
            }
            return response;
        };
        const steps = fakeSteps((step) => {
            if (step.kind === 'reclaim') throw new Error('the step channel closed');
            return stepOk();
        });

        const result = await reclaimer(gated, steps).reclaimWorktree(repoJob);

        expect(result).toMatchObject({
            ok: false,
            removed: false,
            reason: expect.stringContaining('step channel closed'),
        });
        expect(completions).toEqual(['group-gone', 'claim-released']);
    });

    // The group's own POST, the same transient-400 rule the polls have (issue #308): the answer
    // is the reclaim's ok:false — the reclaim never throws into the loop — with the checkout
    // handed back.
    it('answers ok:false, claim given back, when the group POST answers the pre-handler 400', async () => {
        const { request, calls } = fakeRequest({ create: { status: 400, body: '400 Bad Request' } });
        const result = await reclaimer(request).reclaimWorktree(repoJob);
        expect(result).toMatchObject({ ok: false, removed: false, reason: expect.stringContaining('answered 400') });
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(true);
    });

    /*
     * Issue #302's reclaim twin: the same unpullable image holds the reclaim group's pod in
     * ImagePullBackOff and no supervisor comes up. The wait names the image the moment the pod does.
     */
    it('names an unpullable executor image instead of waiting out the supervisor', async () => {
        const { request } = fakeRequest({
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: 'reclaim-pod' },
                            status: {
                                containerStatuses: [
                                    {
                                        state: {
                                            waiting: {
                                                reason: 'ImagePullBackOff',
                                                message: 'pull access denied, repository does not exist',
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
            },
        });
        const steps = fakeSteps(reclaimAnswer());
        steps.sink.contacted = () => false;
        const result = await reclaimer(request, steps).reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.removed).toBe(false);
        expect(result.reason).toMatch(
            /the executor image "claude-executor" cannot be pulled: ImagePullBackOff — pull access denied/
        );
        expect(steps.submitted.filter((s) => s.kind === 'reclaim')).toEqual([]);
    });

    it('answers the script verdict when the reclaim script refuses', async () => {
        const result = await reclaimer(
            fakeRequest().request,
            fakeSteps(
                reclaimAnswer(
                    '{"ok":false,"removed":false,"reason":"refusing to remove /x: a git tree that is not a registered worktree"}\n'
                )
            )
        ).reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('registered worktree');
    });

    // Issue #344's reclaim twin: an unreadable reclaim verdict names why, the same way the sync's
    // does, and a step that ends badly says so in the tool's own words.
    it.each([
        [
            'a clean exit that printed no verdict',
            stepOk('something else\n'),
            /^the worktree reclaim answered nothing readable.*something else/,
        ],
        [
            'a non-zero exit',
            { exitCode: 1, stdout: '', stderr: 'rm: permission denied\n', timedOut: false },
            /^the worktree reclaim failed: rm: permission denied$/,
        ],
        [
            'a step ended at its bound',
            { exitCode: null, stdout: '', stderr: '', timedOut: true },
            /^the worktree reclaim failed: the step exceeded its \d+ms deadline$/,
        ],
    ] as const)('folds %s into the reclaim verdict', async (_what, answer, reason) => {
        const result = await reclaimer(
            fakeRequest().request,
            fakeSteps((step) => (step.kind === 'reclaim' ? answer : stepOk()))
        ).reclaimWorktree(repoJob);
        expect(result).toMatchObject({ ok: false, removed: false });
        expect(result.reason).toMatch(reason);
    });

    /*
     * Issue #344, the claim loop: a reclaim refused by the checkout claim used to leave only the
     * transport's raw 409 header dump — no claim name, no holder, no age. The refusal now carries
     * the claim's identity so the loop can name it — and, when the board proves the holder gone,
     * reap it.
     */
    it('reports the held claim’s identity when the checkout is held', async () => {
        const { request } = fakeRequest();
        await request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '5' },
        });

        const result = await runner(request).reclaimWorktree(repoJob);

        expect(result.ok).toBe(false);
        expect(result.heldClaim).toEqual({
            name: `factory-job-${repoJob.id}-claim`,
            claimSeq: '5',
            createdMs: expect.any(Number),
        });
    });

    it('answers heldClaim undefined when the refusal was not the claim’s', async () => {
        // A transport failure in the acquire is not a claim refusal — no claim to read, and the
        // heldClaim read (which answers 404 here, nothing on the configmap path) stays undefined.
        const { request: base } = fakeRequest();
        const request: K8sRequest = (method, path, body) => {
            if (method === 'POST' && path === configmapsPath) {
                return Promise.reject(new Error('connection refused'));
            }
            return base(method, path, body);
        };
        const result = await runner(request).reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('the checkout is held');
        expect(result.heldClaim).toBeUndefined();
    });

    it('reaps an orphaned checkout claim by uid precondition', async () => {
        const { request, calls } = fakeRequest();
        await request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '3' },
        });

        await expect(runner(request).reapOrphanedClaim?.(repoJob)).resolves.toBe(true);
        // The delete names the exact incarnation it read — a claim replaced between the read and
        // the delete (a live claimant's takeover) is never the one that goes.
        const del = calls.find((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
        expect((del?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toMatch(
            /^claim-uid-/
        );
        // Gone: the second read answers 404 and the reap answers false — there was nothing to reap.
        await expect(runner(request).reapOrphanedClaim?.(repoJob)).resolves.toBe(false);
    });

    it('answers false and deletes nothing when the claim was replaced between the read and the delete', async () => {
        const { request: base, calls } = fakeRequest();
        await base('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '3' },
        });
        // The read answers a stale incarnation: the claim was taken over (deleted and re-created
        // under a new uid) between the proof and the reap.
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path === claimPathFor(repoJob.id)) {
                return base(method, path, body).then((res) => ({
                    status: res.status,
                    body: JSON.stringify({
                        ...JSON.parse(res.body),
                        metadata: { uid: 'claim-uid-stale-incarnation' },
                    }),
                }));
            }
            return base(method, path, body);
        };

        await expect(runner(request).reapOrphanedClaim?.(repoJob)).resolves.toBe(false);

        // The precondition answered 409 and the live claim survives: the real object is still
        // there for its holder's own release.
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(true);
        await expect(runner(base).reapOrphanedClaim?.(repoJob)).resolves.toBe(true);
    });

    it('answers createdMs null when the claim carries no creation stamp', async () => {
        const { request: base } = fakeRequest();
        await base('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '5' },
        });
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path === claimPathFor(repoJob.id)) {
                return base(method, path, body).then((res) => {
                    const parsed = JSON.parse(res.body) as { metadata: Record<string, unknown> };
                    delete parsed.metadata.creationTimestamp;
                    return { status: res.status, body: JSON.stringify(parsed) };
                });
            }
            return base(method, path, body);
        };

        const result = await runner(request).reclaimWorktree(repoJob);
        expect(result.heldClaim).toEqual({
            name: `factory-job-${repoJob.id}-claim`,
            claimSeq: '5',
            createdMs: null,
        });
    });

    it('reclaims nothing for a job that names no repository', async () => {
        const { request, calls } = fakeRequest();
        expect(await runner(request).reclaimWorktree(job)).toEqual({ ok: true, removed: false, reason: null });
        // Not even a claim attempt: there is no tree and no checkout to fence.
        expect(calls).toHaveLength(0);
    });
});

/*
 * Publishing, ported (docs/jobs.md): the same publishCheckout workflow the docker runner runs, over
 * this executor's transport — one supervised step per publish step, in the attempt's group, the
 * claim env (and the board's fresh token) riding the step itself. The flow tests script each step's
 * (exit code, output) pair in order, because every step asks the same channel.
 */
describe('publishing the produced work', () => {
    const ISSUE_JOB: BoardJob = {
        ...job,
        command: '/fix https://github.com/Bellows-AI/factory/issues/10',
        repo: 'Bellows-AI/factory',
        env: { GITHUB_TOKEN: 't0k-3n' },
    };
    const WT = `/workspaces/bellows/${USER}/.worktrees/${ISSUE_JOB.id}`;
    const PR_URL = 'https://github.com/Bellows-AI/factory/pull/42';

    const DIRTY_ON_MAIN = {
        cloned: true,
        branch: 'main',
        defaultBranch: 'main',
        dirty: true,
        unpushed: 0,
        hasIdentity: false,
    };
    const HEAD_SHA = 'a'.repeat(40);
    const failed = (exitCode: number, stdout = ''): StepResult => ({ exitCode, stdout, stderr: '', timedOut: false });

    /**
     * The supervisor's answers to a publish, by what each step IS rather than by its place in the
     * sequence — the workflow orders its steps (publish.ts), this only answers them: the probe
     * with `probe`, HEAD with a sha, the publication ledger empty, `git switch` as a branch that
     * needs creating, no PR yet, the PR it opens, and every other step a quiet success unless
     * `step` overrides it.
     */
    const scripted = (over: { probe?: object; step?: (step: StepRequest) => StepResult | null } = {}) =>
        fakeSteps((step) => {
            const argv = step.argv;
            const has = (word: string) => argv.includes(word);
            const custom = over.step?.(step);
            if (custom) return custom;
            if (step.kind === 'sync' || step.kind === 'go') return stepOk();
            if (argv[2] === gitProbeScript) return stepOk(JSON.stringify(over.probe ?? DIRTY_ON_MAIN));
            if (has('rev-parse')) return stepOk(`${HEAD_SHA}\n`);
            if (step.env.ACTION) return stepOk(step.env.ACTION === 'read' ? '{}' : '');
            if (has('switch')) return has('-c') ? stepOk() : failed(1);
            if (has('pr') && has('view')) return failed(1);
            if (argv[2]?.includes('shortstat')) {
                return stepOk(JSON.stringify({ title: 'Fix the sync re-claim fence', body: '## Commits' }));
            }
            if (has('pr') && has('create')) return stepOk(`${PR_URL}\n`);
            return stepOk();
        });
    const publishing = (steps: { sink: StepSink }, request = fakeRequest().request) =>
        runner(request, {}, undefined, steps.sink);
    const publishStepsOf = (steps: { submitted: StepRequest[] }) =>
        steps.submitted.filter((step) => step.kind === 'publish');

    it('branches, commits, pushes and opens the PR — one step per git/gh call, in order', async () => {
        const steps = scripted();
        const { request, calls } = fakeRequest();
        const result = await publishing(steps, request).publishGit!(ISSUE_JOB);

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
        const sent = publishStepsOf(steps);
        // Each step has an identity of its own; the supervisor answers a retried one from its ledger.
        expect(new Set(sent.map((step) => step.id)).size).toBe(sent.length);
        // No Job per step: the one group of the attempt, and nothing else.
        const jobs = calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(jobs).toHaveLength(1);
        // The decisions are publishCheckout's (publish-checkout.test.ts); this is their rendering
        // as steps: each step's argv, the token never in one.
        const commands = sent.map((step) => step.argv);
        const order = (word: string): number => commands.findIndex((argv) => argv.includes(word));
        expect(order('switch')).toBeLessThan(order('add'));
        expect(order('add')).toBeLessThan(order('commit'));
        expect(order('commit')).toBeLessThan(order('push'));
        expect(order('push')).toBeLessThan(order('create'));
        const commit = commands.find((argv) => argv.includes('commit'));
        expect(commit).toContain('/fix https://github.com/Bellows-AI/factory/issues/10 (#10)');
        expect(commit).toContain('user.name=factory-ai');
        const push = commands.find((argv) => argv.includes('push'));
        expect(push!.join(' ')).toContain('credential.helper=');
        expect(push).toContain('--force-with-lease');
        // The summarizer is one step like every other (issue #82): node over the worktree, the
        // BASE ref and the backstop commit's subject as literal envs, and no credential — local
        // git reads only. Its worktree anchor is pinned explicitly, because its failure mode
        // without one is the quiet one: nulls, and the command title this issue removes.
        const summary = sent.find((step) => step.argv[2]?.includes('shortstat'));
        expect(summary).toBeDefined();
        expect(summary!.argv).toEqual(['node', '-e', expect.stringContaining('shortstat')]);
        expect(summary!.env).toEqual({
            BASE: 'origin/main',
            BACKSTOP_TITLE: '/fix https://github.com/Bellows-AI/factory/issues/10 (#10)',
        });
        expect(summary!.cwd).toBe(WT);
        const create = commands.find((argv) => argv.includes('pr') && argv.includes('create'));
        expect(create).toContain('--head');
        expect(create).toContain('fix/10');
        expect(create?.[create.indexOf('--title') + 1]).toBe('Fix the sync re-claim fence (#10)');
        expect(JSON.stringify(commands)).not.toContain('t0k-3n');
    });

    it('hands the claim env and the minted token to the steps that read them, and to no other', async () => {
        const steps = scripted();
        await publishing(steps).publishGit!(ISSUE_JOB, 'ghs_minted');

        const sent = publishStepsOf(steps);
        const push = sent.find((step) => step.argv.includes('push'))!;
        expect(push.env.GITHUB_TOKEN).toBe('ghs_minted');
        const add = sent.find((step) => step.argv.includes('add'))!;
        expect(add.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(add.cwd).toBe(WT);
        // The probe takes no working directory and only the REPO literal.
        const probe = sent[0]!;
        expect(probe.cwd).toBeUndefined();
        expect(probe.env).toEqual({ REPO: WT });
    });

    // The loop asks the board for a token right before the push (docs/connections.md); the step
    // must carry THAT credential, and a claim value under the reserved name never. Neither reaches
    // an object the cluster stores for the step.
    it("publishes with the board's minted token in the step env, never a claim value", async () => {
        const steps = scripted();
        const { request, calls } = fakeRequest();
        await publishing(steps, request).publishGit!(ISSUE_JOB, 'ghs_fresh');

        const push = publishStepsOf(steps).find((step) => step.argv.includes('push'))!;
        expect(push.env.GITHUB_TOKEN).toBe('ghs_fresh');
        expect(JSON.stringify(publishStepsOf(steps))).not.toContain('t0k-3n');
        expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('ghs_fresh');
    });

    // The post-gate tree read: the publish's probe step alone, with no claim env.
    it('probes the tree fingerprint as one env-less step', async () => {
        const steps = scripted({ probe: { ...DIRTY_ON_MAIN, fingerprint: 'h:1' } });
        const { request, calls } = fakeRequest();

        expect(await publishing(steps, request).probeTree?.(ISSUE_JOB)).toBe('h:1');

        const probes = steps.submitted.filter((step) => step.kind === 'probe');
        expect(probes).toHaveLength(1);
        expect(probes[0]!.argv).toEqual(['node', '-e', gitProbeScript]);
        expect(probes[0]!.env).toEqual({ REPO: WT });
        expect(calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toHaveLength(1);
    });

    // A Stop while the probe step is still running must not wait for the step to finish on its own.
    it('abandons a pending probe once the stand-down signal aborts', async () => {
        const cancel = new AbortController();
        const sink: StepSink = {
            submit: (_token, step, signal) =>
                step.kind === 'probe'
                    ? new Promise((_resolve, reject) => {
                          signal?.addEventListener('abort', () => reject(new Error('the step was cancelled')));
                          cancel.abort();
                      })
                    : Promise.resolve(stepOk()),
            awaitReport: () => new Promise(() => undefined),
            contacted: () => true,
        };

        expect(await publishing({ sink }).probeTree?.(ISSUE_JOB, cancel.signal)).toBeNull();
    });

    it.each([
        ['a probe that answers no fingerprint', stepOk(JSON.stringify(DIRTY_ON_MAIN))],
        ['a probe that failed', failed(1, 'boom')],
    ])('answers null for %s', async (_label, answer) => {
        const steps = scripted({ step: (step) => (step.kind === 'probe' ? answer : null) });
        expect(await publishing(steps).probeTree?.(ISSUE_JOB)).toBeNull();
    });

    it('carries no claim env for an env-less claim', async () => {
        const steps = scripted({ probe: { cloned: false } });
        const { env: _env, ...envLess } = ISSUE_JOB;
        const result = await publishing(steps).publishGit!(envLess);

        expect(result).toEqual({
            ok: true,
            published: false,
            branch: null,
            prUrl: null,
            reason: 'the checkout has not been cloned yet',
            repository: null,
            baseBranch: null,
            prNumber: null,
            cause: null,
        });
        expect(publishStepsOf(steps).every((step) => !('GITHUB_TOKEN' in step.env))).toBe(true);
    });

    // Executor parity for the publish flag (docs/workflows.md): the flag is read in exactly ONE
    // place — the loop, shared by both executors — so this transport must have no opinion of its
    // own. A `publish: false` claim that reached publishGit anyway would publish; the loop tests
    // pin that the loop never lets it through. If this runner grew its own gate, the flag would
    // live in two places and drift.
    it('leaves the publish decision to the loop: publishGit ignores a publish:false claim', async () => {
        const steps = scripted();
        const result = await publishing(steps).publishGit!({ ...ISSUE_JOB, publish: false });

        expect(result.ok).toBe(true);
        expect(publishStepsOf(steps).some((step) => step.argv.includes('push'))).toBe(true);
    });

    // The step's own output is what its failure — and so its cause (#581) — is read from.
    it('fails with the step and the tool’s own words when the push is refused', async () => {
        const steps = scripted({
            step: (step) =>
                step.argv.includes('push')
                    ? {
                          exitCode: 128,
                          stdout: '',
                          stderr: 'remote: Permission to Bellows-AI/factory.git denied to bellows-ai[bot]\nfatal: Authentication failed\n',
                          timedOut: false,
                      }
                    : null,
        });
        const result = await publishing(steps).publishGit!(ISSUE_JOB);

        expect(result.ok).toBe(false);
        expect(result.published).toBe(false);
        expect(result.reason).toContain('Permission to Bellows-AI/factory');
        expect(result.cause).toBe('denied');
    });

    // Issue #825, executor parity: a bound publish's tree check rides the supervisor's steps here
    // exactly as under docker — staged hook-free, the commit held to that tree.
    it.each([
        ['pushes when the commit holds the staged tree', 't'.repeat(40), true],
        ['refuses stale, pushing nothing, when a commit hook moved it', 'b'.repeat(40), false],
    ])('a bound publish %s', async (_case, committed, published) => {
        const steps = scripted({
            probe: { ...DIRTY_ON_MAIN, fingerprint: 'h:1' },
            step: (step) => {
                if (step.argv.includes('write-tree')) return stepOk(`${'t'.repeat(40)}\n`);
                return step.argv.includes('HEAD^{tree}') ? stepOk(`${committed}\n`) : null;
            },
        });

        const result = await publishing(steps).publishGit!(ISSUE_JOB, undefined, { revision: 'h:1' });

        expect(result).toMatchObject(published ? { ok: true, published } : { ok: false, stale: true });
        const argvs = publishStepsOf(steps).map((step) => step.argv);
        expect(argvs.some((a) => a.includes('write-tree') && a.includes('core.hooksPath=/dev/null'))).toBe(true);
        expect(argvs.some((a) => a.includes('push'))).toBe(published);
    });

    // A step the supervisor never answers (the channel closed under it) is a transport failure
    // the loop can retry, never a verdict on the work.
    it('names a closed step channel a transport failure', async () => {
        const steps = scripted({
            step: (step) => {
                if (!step.argv.includes('push')) return null;
                throw new StepChannelClosed('the answer');
            },
        });
        const result = await publishing(steps).publishGit!(ISSUE_JOB, 'ghs_fresh');
        expect(result).toMatchObject({ ok: false, published: false, cause: 'transport' });
    });
});

/*
 * The runner vitals under kubernetes: the metrics API is the docker stats twin, read from the
 * runner's own pod — and null, never an error, whenever there is nothing to read (no pod yet,
 * no metrics-server in the cluster, a body that is not metrics).
 */
describe('the runner vitals', () => {
    it('parses the PodMetrics object the metrics API answers', () => {
        expect(parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '250m', memory: '150Mi' } }] }))).toEqual({
            cpuPercent: 25,
            memUsedMb: 150,
            memPercent: null,
        });
        // Nanocores and plain bytes — the other spellings metrics-server emits.
        expect(
            parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '1250000n', memory: '5368709120' } }] }))
        ).toEqual({ cpuPercent: 0.125, memUsedMb: 5120, memPercent: null });
        // Whole cores and binary memory sizes.
        expect(parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '1.5', memory: '2Gi' } }] }))).toEqual({
            cpuPercent: 150,
            memUsedMb: 2048,
            memPercent: null,
        });
        expect(parsePodMetrics('')).toBeNull();
        expect(parsePodMetrics('{"containers":[]}')).toBeNull();
        expect(
            parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: 'busy', memory: '150Mi' } }] }))
        ).toBeNull();
    });

    it('samples through the metrics API, and answers null when the cluster runs no metrics-server', async () => {
        const base = fakeRequest();
        const withMetrics: K8sRequest = (method, path, body) => {
            if (path === `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${podName}`) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ containers: [{ usage: { cpu: '310m', memory: '96Mi' } }] }),
                });
            }
            return base.request(method, path, body);
        };
        expect(await runner(withMetrics).sampleRuntime(job)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
        });

        const noMetricsServer: K8sRequest = (method, path, body) => {
            if (path.startsWith('/apis/metrics.k8s.io/'))
                return Promise.resolve({ status: 404, body: 'no metrics-server' });
            return base.request(method, path, body);
        };
        expect(await runner(noMetricsServer).sampleRuntime(job)).toBeNull();
    });

    /**
     * The attempt's service fleet rides the same sample (issue #60), read off the lease-scoped
     * pod list — the same selector the teardown uses, so the runner and gate pods never answer.
     * THE kubernetes regression this exists for: a cluster with no metrics-server (kind, for one)
     * must not silence the fleet — the sample carries null vitals beside real service states
     * rather than skipping the flush. An empty fleet is no key at all, so a job that declared
     * nothing reports exactly what it reported before.
     */
    it('reports the service fleet beside the vitals, with or without them', async () => {
        const base = fakeRequest();
        const fleetBody = JSON.stringify({
            items: [
                {
                    metadata: { labels: { 'factory.service': 'db' } },
                    spec: { containers: [{ image: 'postgres:16' }] },
                    status: { phase: 'Running' },
                },
            ],
        });
        const emptyBody = '{"items":[]}';
        const metricsBody = {
            status: 200,
            body: JSON.stringify({ containers: [{ usage: { cpu: '310m', memory: '96Mi' } }] }),
        };
        const wrap =
            (fleet: string | null, metrics: { status: number; body: string } | null): K8sRequest =>
            (method, path, body) => {
                if (
                    fleet !== null &&
                    path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                    decodeURIComponent(path).includes(`factory.lease=${job.leaseToken}`)
                ) {
                    return Promise.resolve({ status: 200, body: fleet });
                }
                if (metrics !== null && path.startsWith('/apis/metrics.k8s.io/')) {
                    return Promise.resolve(metrics as K8sResponse);
                }
                return base.request(method, path, body);
            };

        // Both reads land: numbers and fleet.
        expect(await runner(wrap(fleetBody, metricsBody), { RUNNER_SERVICES: '1' }).sampleRuntime(job)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
            services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
        });

        // No metrics-server: the fleet still reports, the numbers go honestly null.
        expect(
            await runner(wrap(fleetBody, { status: 404, body: 'no metrics-server' }), {
                RUNNER_SERVICES: '1',
            }).sampleRuntime(job)
        ).toEqual({
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
        });

        // Nothing declared: no key, and without metrics nothing to report at all.
        expect(
            await runner(wrap(emptyBody, { status: 404, body: 'x' }), { RUNNER_SERVICES: '1' }).sampleRuntime(job)
        ).toBeNull();

        // Services off: exactly the vitals-only sample, and no fleet request is even issued.
        const off = fakeRequest();
        expect(
            await runner((method, path, body) => {
                if (path.startsWith('/apis/metrics.k8s.io/')) return Promise.resolve(metricsBody as K8sResponse);
                return off.request(method, path, body);
            }).sampleRuntime(job)
        ).toEqual({ cpuPercent: 31, memUsedMb: 96, memPercent: null });
        expect(off.calls.some((call) => decodeURIComponent(call.path).includes('factory.lease'))).toBe(false);
    });

    describe('parseServicePods', () => {
        const pod = (name: string, phase: string | undefined, image = 'postgres:16'): unknown => ({
            metadata: { labels: { 'factory.service': name } },
            spec: { containers: [{ image }] },
            status: phase === undefined ? {} : { phase },
        });

        it('reads name, image and phase off each pod, lowercased and sorted by name', () => {
            expect(
                parseServicePods(JSON.stringify({ items: [pod('db', 'Running'), pod('cache', 'Pending', 'redis:7')] }))
            ).toEqual([
                { name: 'cache', image: 'redis:7', state: 'pending' },
                { name: 'db', image: 'postgres:16', state: 'running' },
            ]);
        });

        it('answers unknown for a pod with no phase yet', () => {
            expect(parseServicePods(JSON.stringify({ items: [pod('db', undefined)] }))).toEqual([
                { name: 'db', image: 'postgres:16', state: 'unknown' },
            ]);
        });

        it('skips pods without the service label or an image, and garbage', () => {
            expect(parseServicePods(JSON.stringify({ items: [{ metadata: {}, spec: { containers: [] } }] }))).toEqual(
                []
            );
            expect(parseServicePods('not json')).toEqual([]);
            expect(parseServicePods('{"items":[]}')).toEqual([]);
        });
    });

    /**
     * The dead half of the fleet (issue #423): a service pod runs under `restartPolicy: Never`, so
     * `Failed` and `Succeeded` are both a service that is no longer there for the gates. The
     * verdict quotes the kubelet's termination and the pod's last log lines — the only place the
     * cause survives, because the teardown deletes the pod right after.
     */
    describe('dead services', () => {
        const pod = (name: string, phase: string, terminated?: { exitCode: number; reason?: string }): unknown => ({
            metadata: { name: `svc-${name}`, labels: { 'factory.service': name } },
            spec: { containers: [{ image: `${name}:1` }] },
            status: { phase, containerStatuses: terminated ? [{ state: { terminated } }] : [] },
        });

        it('parses failed and succeeded pods with their termination, skipping live ones and garbage', () => {
            const body = JSON.stringify({
                items: [
                    pod('mongo', 'Failed', { exitCode: 1, reason: 'Error' }),
                    pod('cache', 'Succeeded', { exitCode: 0, reason: 'Completed' }),
                    pod('db', 'Running'),
                    pod('queue', 'Pending'),
                    pod('blank', 'Failed'),
                ],
            });
            expect(parseDeadServicePods(body)).toEqual([
                { pod: 'svc-blank', name: 'blank', image: 'blank:1', state: 'failed', exitCode: null, reason: null },
                {
                    pod: 'svc-cache',
                    name: 'cache',
                    image: 'cache:1',
                    state: 'succeeded',
                    exitCode: 0,
                    reason: 'Completed',
                },
                { pod: 'svc-mongo', name: 'mongo', image: 'mongo:1', state: 'failed', exitCode: 1, reason: 'Error' },
            ]);
            expect(parseDeadServicePods('not json')).toEqual([]);
            // A pod stuck Pending on an image or config error never starts: docker fails the same as infrastructure.
            const stuck = (waiting: string) => ({
                metadata: { name: 'svc-mongo', labels: { 'factory.service': 'mongo' } },
                spec: { containers: [{ image: 'mongo:1' }] },
                status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: waiting } } }] },
            });
            for (const reason of ['ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError']) {
                expect(parseDeadServicePods(JSON.stringify({ items: [stuck(reason)] }))).toEqual([
                    { pod: 'svc-mongo', name: 'mongo', image: 'mongo:1', state: 'pending', exitCode: null, reason },
                ]);
            }
            expect(parseDeadServicePods(JSON.stringify({ items: [stuck('ContainerCreating')] }))).toEqual([]);
            // An eviction records no container termination: the pod's own reason stands in.
            const evicted = {
                metadata: { name: 'svc-mongo', labels: { 'factory.service': 'mongo' } },
                spec: { containers: [{ image: 'mongo:1' }] },
                status: { phase: 'Failed', reason: 'Evicted', message: 'low on memory' },
            };
            expect(parseDeadServicePods(JSON.stringify({ items: [evicted] }))).toEqual([
                {
                    pod: 'svc-mongo',
                    name: 'mongo',
                    image: 'mongo:1',
                    state: 'failed',
                    exitCode: null,
                    reason: 'Evicted: low on memory',
                },
            ]);
        });

        it('reads the lease-scoped fleet, then the log tail of each dead pod only', async () => {
            const base = fakeRequest();
            const fleet = JSON.stringify({
                items: [pod('mongo', 'Failed', { exitCode: 1, reason: 'Error' }), pod('db', 'Running')],
            });
            const request: K8sRequest = (method, path, body) => {
                if (
                    path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                    decodeURIComponent(path).includes(`factory.lease=${job.leaseToken}`)
                )
                    return Promise.resolve({ status: 200, body: fleet });
                if (path === `/api/v1/namespaces/${namespace}/pods/svc-mongo/log?tailLines=${SERVICE_LOG_TAIL_LINES}`)
                    return Promise.resolve({ status: 200, body: 'chown: Operation not permitted\n' });
                return base.request(method, path, body);
            };

            expect(await runner(request, { RUNNER_SERVICES: '1' }).deadServices(job)).toEqual([
                {
                    name: 'mongo',
                    image: 'mongo:1',
                    state: 'failed',
                    exitCode: 1,
                    reason: 'Error',
                    logTail: 'chown: Operation not permitted\n',
                },
            ]);
            expect(base.calls.some((call) => call.path.includes('svc-db'))).toBe(false);
        });

        it('keeps a dead service whose log is gone, and throws on an unreadable fleet', async () => {
            const fleet = JSON.stringify({ items: [pod('mongo', 'Failed', { exitCode: 1 })] });
            const request =
                (fleetStatus: number): K8sRequest =>
                (_method, path) =>
                    Promise.resolve(
                        path.includes('/log')
                            ? { status: 404, body: 'gone' }
                            : { status: fleetStatus, body: fleetStatus === 200 ? fleet : 'forbidden' }
                    );

            expect(await runner(request(200), { RUNNER_SERVICES: '1' }).deadServices(job)).toEqual([
                { name: 'mongo', image: 'mongo:1', state: 'failed', exitCode: 1, reason: null, logTail: '' },
            ]);
            await expect(runner(request(403), { RUNNER_SERVICES: '1' }).deadServices(job)).rejects.toThrow(/403/);
        });

        it('answers empty without a request when services are off', async () => {
            const off = fakeRequest();
            expect(await runner(off.request).deadServices(job)).toEqual([]);
            expect(off.calls).toEqual([]);
        });
    });
});

describe('the kubernetes runner and the task supervisor', () => {
    const exporting: BoardJob = {
        ...job,
        gateEnv: { BELLOWS_CONTROL_URL: 'http://driver:7000', BELLOWS_CONTROL_TOKEN: 'tok-agent' },
        ...SUPERVISED,
    };
    const containersOf = (body: unknown): string[] =>
        (body as ReturnType<typeof runnerJobSpec>).spec.template.spec.containers.map((c) => c.name);
    const jobBodies = (calls: Call[]) =>
        calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace)).map((c) => c.body);

    it('runs the supervisor, the agent and the exporter as one pod — no exporter Job beside it', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(exporting, { id: SESSION, resume: false });
        const names = jobBodies(calls).map((body) => (body as { metadata: { name: string } }).metadata.name);
        expect(names[0]).toBe(runnerJobName(exporting));
        expect(names.some((name) => name.startsWith('factory-cexport-'))).toBe(false);
        expect(containersOf(jobBodies(calls)[0]).sort()).toEqual(['agent', 'exporter', 'supervisor']);
        // Nothing deletes the pod while the supervisor drains: the pod ends once it has finalized.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(runnerJobName(exporting)))).toBe(
            false
        );
    });

    // A run submits its steps over the control channel, so no run goes without one; the spec is
    // still pinned for a claim that carries none: the supervisor stays, the exporter is dropped.
    it('keeps the supervisor, and drops only the exporter, for a claim with no control endpoint', () => {
        const { supervisorEnv: _none, ...unsupervised } = job;
        const spec = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            unsupervised,
            { id: SESSION, resume: false }
        );
        expect(containersOf(spec).sort()).toEqual(['agent', 'supervisor']);
    });

    it('keeps the supervisor’s control pair in the attempt Secret and out of the agent’s env', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(exporting, { id: SESSION, resume: false });
        const secret = calls.find((call) => call.method === 'POST' && call.path.endsWith('/secrets'))!;
        const data = JSON.stringify(secret.body);
        expect(data).toContain('tok-supervisor');
        const pod = jobBodies(calls)[0] as ReturnType<typeof runnerJobSpec>;
        const agent = pod.spec.template.spec.containers.find((c) => c.name === 'agent')!;
        expect(JSON.stringify(agent)).not.toMatch(/SUPERVISOR_CONTROL/);
        expect(JSON.stringify(agent.volumeMounts)).not.toMatch(/ctl-supervisor|ctl-export/);
    });

    it('kill deletes the whole pod: the agent, the supervisor and the exporter go together', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).kill(exporting);
        const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path ?? '');
        expect(deleted.some((path) => path.includes(runnerJobName(exporting)))).toBe(true);
    });

    // The loop raised the kill order; the supervisor ends the agent, drains the exporter and
    // finalizes, so the pod ends by itself — a stop that waits is not a delete.
    it('stopAgent waits for the supervisor to finalize and deletes nothing once the pod is done', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).stopAgent!(exporting);
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(runnerJobName(exporting)))).toBe(
            false
        );
    });

    it('stopAgent falls back to deleting the pod when the supervisor never finishes', async () => {
        const { request, calls } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) },
        });
        await runner(request).stopAgent!(exporting);
        expect(calls).toContainEqual(
            expect.objectContaining({
                method: 'DELETE',
                path: expect.stringContaining(jobPath(namespace, runnerJobName(exporting))),
            })
        );
    });

    it('a refused Job fails the run as infrastructure, with no second Job left over', async () => {
        const { request, calls } = fakeRequest({
            create: { status: 403, body: 'forbidden' },
        });
        await expect(runner(request).run(exporting, { id: SESSION, resume: false })).rejects.toThrow();
        expect(jobBodies(calls)).toHaveLength(1);
    });
});

describe('the kubernetes runner', () => {
    it('sweeps the job label, then creates the job in the configured namespace and reports success', async () => {
        const { request, calls } = fakeRequest();
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        // The claim is the first thing the run does: one POST whose name uniqueness arbitrates
        // the checkout. Then the fence: a label LIST of the job's previous attempts — nothing
        // answers — before this one creates anything.
        expect(calls[0]?.method).toBe('POST');
        expect(calls[0]?.path).toBe(configmapsPath);
        expect(calls[1]).toEqual({ method: 'GET', path: expect.stringContaining(jobsPath(namespace)) });
        expect(calls[1]!.path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`)).toEqual([
            `POST ${configmapsPath}`,
            // The sweep lists every kind the job label can answer — runner and gate Jobs, then
            // service pods, then service DNS Services — before this attempt creates anything.
            `GET ${jobsPath(namespace)}`,
            `GET /api/v1/namespaces/factory/pods`,
            `GET /api/v1/namespaces/factory/services`,
            // The per-attempt Secret (the runner's attempt pair) is created after the sweep and
            // before the claim — the credential exists before anything names it.
            `POST /api/v1/namespaces/factory/secrets`,
            `GET ${claimPathFor(job.id)}`,
            `POST ${jobsPath(namespace)}`,
            `GET ${claimPathFor(job.id)}`,
            `GET ${jobPath(namespace, runnerJobName(job))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
            // The close-time claude-code turn read: one aux Job, polled, logged, reaped.
            ...cturnsCalls(job),
            `GET ${claimPathFor(job.id)}`,
            `DELETE ${claimPathFor(job.id)}`,
            // No fleet teardown here: the services outlive run() for the declared gates, and the
            // loop's releaseServices takes them down. Nor does the group go: its Job and Secret
            // serve the steps after the run until the loop's `finish`.
        ]);
        expect(outcome).toEqual({
            // The fake's log parses as no count at all: unmeasured, never zero.
            agentTurns: null,
            exitCode: 0,
            output: 'did the work\n',
            timedOut: false,
            started: true,
            // The full log rides the outcome now (issue #325) — the whole (one-line) log, uncut.
            fullLog: 'did the work\n',
            logTruncated: false,
        });
    });

    it('creates the per-job Secret before the Job when the claim carries env, and keeps it until the group is finished', async () => {
        const { request, calls } = fakeRequest();
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const r = supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        );
        await r.run(envJob, { id: SESSION, resume: false });

        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        expect(secretPost?.body).toMatchObject({
            apiVersion: 'v1',
            kind: 'Secret',
            type: 'Opaque',
            metadata: { name: secretName(envJob), labels: { 'factory.job': envJob.id } },
            stringData: {
                CORE_TOKEN: 'shh',
                RUNNER_JOB_ID: envJob.id,
                RUNNER_LEASE_TOKEN: envJob.leaseToken,
            },
        });
        // The Secret precedes the Job: a pod referencing a Secret that is not there yet is a
        // CreateContainerConfigError and a burned attempt.
        const secretIndex = calls.findIndex((call) => call.method === 'POST' && call.path === secretsPath);
        const jobIndex = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(secretIndex).toBeGreaterThanOrEqual(0);
        expect(secretIndex).toBeLessThan(jobIndex);
        // And creating it is the FIRST thing the run does to a Secret: the name carries this
        // attempt's lease token, so there is no previous attempt's Secret at this name to sweep.
        const firstSecretCall = calls.find((call) => call.path?.includes('/secrets'));
        expect(firstSecretCall?.method).toBe('POST');
        // The attempt outlives its run (the gates, the publish and the helpers are its supervisor's
        // steps), so the verdict does not reap the Secret: `finish` does, once nothing of the group
        // can still read it.
        const reaped = (): boolean =>
            calls.some((call) => call.method === 'DELETE' && call.path === `${secretsPath}/${secretName(envJob)}`);
        expect(reaped()).toBe(false);
        await r.finish!(envJob);
        expect(reaped()).toBe(true);
    });

    // The parity pin for docs/connections.md: the runner pod gets the attempt pair and the board
    // URL, from which its entrypoint derives JIRA_API — and never a Jira credential, whatever the
    // claim carried.
    it('never puts a Jira credential in the per-attempt Secret or the pod env', async () => {
        const { request, calls } = fakeRequest();
        const withJira: BoardJob = {
            ...job,
            env: { ATLASSIAN_API_TOKEN: 'atlassian-secret', ATLASSIAN_EMAIL: 'agent@example.com' },
        };
        await runner(request).run(withJira, { id: SESSION, resume: false });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(Object.keys(stringData).filter((key) => key.startsWith('ATLASSIAN'))).toEqual([]);
        expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('atlassian-secret');
        expect(stringData).toMatchObject({ RUNNER_JOB_ID: job.id, RUNNER_LEASE_TOKEN: job.leaseToken });
    });

    it('creates the per-attempt Secret for every runner — the pair rides it even with no claim env', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(job, { id: SESSION, resume: false });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        // The Secret is never empty now: the runner's own branch-ingest credential is always in it.
        expect(secretPost?.body).toMatchObject({
            stringData: { RUNNER_JOB_ID: job.id, RUNNER_LEASE_TOKEN: job.leaseToken },
        });
    });

    // Issue #452: the Secret carries the managed settings the pod mounts, rendered with the
    // driver's endpoint — the entrypoint no longer rewrites them in place.
    it.each([
        [{}, 'http://collector:4318'],
        [{ RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' }, 'http://otel.example:4318'],
    ])('renders the managed settings into a claude-code runner Secret (%o)', async (env, endpoint) => {
        const { request, calls } = fakeRequest();
        await runner(request, env).run(job, { id: SESSION, resume: false });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(stringData['managed-settings.json']).toBe(claudeManagedSettings(endpoint));
    });

    it('renders otel.json, and no managed settings, into an opencode runner Secret', async () => {
        const { request, calls } = fakeRequest();
        await runner(request, { RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' }).run(opencodeJob, null);
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(stringData['otel.json']).toBe(opencodeOtelConfig('http://otel.example:4318'));
        expect(stringData).not.toHaveProperty('managed-settings.json');
    });

    // Issue #244: the per-attempt Secret and the pod spec's env NAMES must agree on
    // OPENCODE_CONFIG_CONTENT — one merge (runnerClaimEnv), never two, or the two could drift the
    // way `secretEnv`/`runnerEnv` used `claimEnv` independently before this change.
    it('merges the reserved factory agent into the runner Secret and references it by name in the pod spec', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(opencodeJob, null);

        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(JSON.parse(stringData.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
            agent: { factory: { mode: 'primary', prompt: MASTER_PROMPT, disable: false } },
        });

        const jobPost = calls.find((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        const env = (jobPost?.body as { spec?: { template?: { spec?: { containers?: { env?: unknown[] }[] } } } })?.spec
            ?.template?.spec?.containers?.[0]?.env as {
            name: string;
            valueFrom?: { secretKeyRef?: { key: string } };
        }[];
        expect(env).toContainEqual({
            name: 'OPENCODE_CONFIG_CONTENT',
            valueFrom: { secretKeyRef: { name: secretName(opencodeJob), key: 'OPENCODE_CONFIG_CONTENT' } },
        });
    });

    /*
     * kill() deletes the attempt's group (the Job) and its Secret by their own names. The attempt
     * outlives `run` now — its steps and its `finish` follow it — so run() no longer reaps the
     * Secret, and a kill, the one path that takes the group away without `finish`, must. (The
     * reaper sweeps what a dead driver leaves.)
     */
    it('deletes the runner Job and its own attempt Secret when it kills', async () => {
        const { request, calls } = fakeRequest();
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        await runner(request).kill(envJob);
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path?.startsWith(jobPath(namespace, runnerJobName(envJob)))
            )
        ).toBe(true);
        expect(calls.filter((call) => call.path?.includes('/secrets')).map((call) => call.path)).toEqual([
            `/api/v1/namespaces/${namespace}/secrets/${secretName(envJob)}`,
        ]);
    });

    /*
     * The reported race: a lease expires, the board reclaims the job, and a replacement attempt
     * creates its Secret. The superseded worker then processes its lost heartbeat and its kill()
     * deletes a Secret. The lease token is in the name, so what kill() deletes is the old attempt's
     * own Secret and never the replacement's — whose group outlives its `run`, Secret and all.
     */
    it("deletes only the superseded attempt's Secret when the job id has been reclaimed", async () => {
        const oldJob: BoardJob = {
            ...job,
            env: { CORE_TOKEN: 'shh' },
            leaseToken: '22222222-2222-4222-8222-222222222222',
        };
        const newJob: BoardJob = {
            ...job,
            env: { CORE_TOKEN: 'shh' },
            leaseToken: '99999999-9999-4999-8999-999999999999',
        };
        const { request, calls } = fakeRequest();

        // The replacement attempt runs to completion: it creates its OWN Secret, which it keeps for
        // its group's steps until `finish`.
        const replacement = runner(request);
        await replacement.run(newJob, { id: SESSION, resume: false });
        const afterRun = calls.length;
        const secretOf = (j: BoardJob) => `/api/v1/namespaces/${namespace}/secrets/${secretName(j)}`;
        expect(calls.some((call) => call.method === 'DELETE' && call.path === secretOf(newJob))).toBe(false);

        // The superseded worker's kill reaches its own attempt's Secret and nothing else: the
        // replacement's is a different name.
        await runner(request).kill(oldJob);
        const deleted = calls.slice(afterRun).filter((call) => call.path?.includes('/secrets'));
        expect(deleted.map((call) => call.path)).toEqual([secretOf(oldJob)]);
        expect(secretName(oldJob)).not.toBe(secretName(newJob));

        // The replacement's own `finish` is what reaps its Secret.
        await replacement.finish!(newJob);
        expect(calls.some((call) => call.method === 'DELETE' && call.path === secretOf(newJob))).toBe(true);
    });

    it('reports a non-zero exit with the pod exit code and the tail of the log', async () => {
        const { request } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { failed: 1 } }) },
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                containerStatuses: [
                                    { name: 'agent', state: { terminated: { exitCode: 3 } } },
                                    { name: 'supervisor', state: { terminated: { exitCode: 0 } } },
                                ],
                            },
                        },
                    ],
                }),
            },
            log: { status: 200, body: 'claude: permission denied' },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(3);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.output).toBe('claude: permission denied');
    });

    /**
     * Live output on this platform is the log tail read mid-run: one poll sees the Job still
     * running, discovers the pod, and hands the caller what the log says so far; the next sees
     * the terminal status and the finished run reports exactly as it always did. The final log
     * read is unchanged — the preview never replaces the report.
     */
    it('streams the log tail while the pod runs, and reports the finished log at the end', async () => {
        const tails: string[] = [];
        let gets = 0;
        const { request } = routed((method, path) => {
            if (path === jobPath(namespace, runnerJobName(job))) {
                gets += 1;
                // First poll: still running, and worth a look at the log. Second: done.
                return gets === 1 ? { status: 200, body: JSON.stringify({ status: {} }) } : (FAKE.job as K8sResponse);
            }
            if (path.includes('/log')) {
                return gets === 1 ? { status: 200, body: 'partial output\n' } : (FAKE.log as K8sResponse);
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false }, (tail) => tails.push(tail));

        expect(tails).toEqual(['partial output\n']);
        expect(outcome).toEqual({
            // The fake's log parses as no count at all: unmeasured, never zero.
            agentTurns: null,
            exitCode: 0,
            output: 'did the work\n',
            timedOut: false,
            started: true,
            // The full log rides the outcome now (issue #325) — the whole (one-line) log, uncut.
            fullLog: 'did the work\n',
            logTruncated: false,
        });
    });

    // A pod that has not been scheduled yet, or a log endpoint that hiccups, is a skipped preview —
    // never a failed run.
    it('streams nothing, and fails nothing, when the mid-run log read answers badly', async () => {
        const tails: string[] = [];
        let gets = 0;
        const { request } = routed((method, path) => {
            if (path === jobPath(namespace, runnerJobName(job))) {
                gets += 1;
                return gets === 1 ? { status: 200, body: JSON.stringify({ status: {} }) } : (FAKE.job as K8sResponse);
            }
            if (path.includes('/log')) return { status: 500, body: 'unavailable' };
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false }, (tail) => tails.push(tail));

        expect(tails).toEqual([]);
        expect(outcome.exitCode).toBe(0);
    });

    /*
     * A job id is only reused when a lease expired and the row was reclaimed — and the leftover
     * Job objects of the previous attempts may still exist. Sweeping them by label before
     * creating is the fencing mechanism: two writers on one checkout is the thing actually
     * worth preventing (docs/jobs.md). The sweep is by LABEL, not by name — attempt-scoped Job
     * names would make a name-targeted delete miss every previous attempt.
     */
    it('sweeps leftover jobs by label before creating, and waits for the sweep to land', async () => {
        const leftover = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let lists = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                // First read: the old Job is still listed. Second: gone. Everything after is
                // the NEW Job's own status poll. The fixture carries no creationTimestamp —
                // the fence classifies nothing, so it reads none.
                return lists === 1
                    ? { status: 200, body: JSON.stringify({ items: [{ metadata: { name: leftover } }] }) }
                    : { status: 200, body: JSON.stringify({ items: [] }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) return { status: 200, body: '{}' };
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        // Claim, then LIST finds the leftover by label, the claim is confirmed still ours,
        // the leftover is deleted BY NAME with Foreground propagation, LISTs again — nothing
        // deletable answers — and only then the create. Foreground propagation starts the
        // teardown; the next list is what proves the old pods are off the checkout — the
        // delete's own response does not wait for them.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Round one lists every kind — jobs names the leftover, pods and services answer
            // empty — then the claim is confirmed ours and the leftover is deleted by name.
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            // Round two: all three kinds answer empty. The per-attempt Secret is written after
            // the sweep, before the claim that precedes the create — and reaped with the attempt.
            'GET',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
        expect(calls[1]!.path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls[5]!.path).toBe(`${jobPath(namespace, leftover)}?propagationPolicy=Foreground`);
    });

    // A re-claim whose sweep never lands — an apiserver losing deletes, say — must not loop
    // forever heartbeating a lease around a create that would run alongside leftovers. Bounded,
    // then thrown: the job goes back to the board rather than two writers racing one checkout.
    // "Deletable" means ANY item the selector answers — the fence classifies nothing — so the
    // fixture carries no timestamp for it to read.
    it('gives up when a deletable leftover job never disappears', async () => {
        const leftover = {
            metadata: { name: 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner' },
        };
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [leftover] }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                // Answered, and yet the object never leaves the list — the failure mode the
                // bound exists for.
                return { status: 200, body: '{}' };
            }
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/never disappeared/);
    });

    /*
     * Issue #32, race 2: the old fence deleted EVERY Job the `factory.job` selector answered, so
     * a stale attempt fencing after its replacement was posted would delete the legitimate lease
     * holder's Job — whose status poll then answers 404 and aborts an active run. Under the
     * claim protocol the stale attempt loses the acquisition step instead — the claim's attempt
     * number is ahead of its own — and stands down having created and deleted nothing at all.
     */
    it('stands down when a newer attempt holds the checkout claim, and touches nothing of its replacement', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const newerJobName = runnerJobName(newerJob);
        const claimPath = claimPathFor(job.id);
        let replacementAlive = true;
        const { request, calls } = routed((method, path) => {
            // The claim is held by attempt 2; this run is attempt 1.
            if (method === 'POST' && path === configmapsPath) {
                return { status: 409, body: '{"reason":"AlreadyExists"}' };
            }
            if (path === claimPath && method === 'GET') {
                return {
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-2' },
                        data: { holder: NEW_TOKEN, claimSeq: '2' },
                    }),
                };
            }
            // The replacement's runner Job is live and answers the label selector.
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: replacementAlive ? [{ metadata: { name: newerJobName } }] : [],
                    }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, newerJobName)}?`)) {
                replacementAlive = false;
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/stands down/);
        // The replacement's Job still exists — a superseded attempt never reaches the winner.
        expect(replacementAlive).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(newerJobName))).toBe(false);
        // Nothing was created either: standing down leaves the job to its lease.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        // And the claim it does not hold is not deleted by the loser either.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    /*
     * Issue #302's runner twin: an unpullable executor image used to hold the runner Job past
     * its whole deadline — the run reporting a timeout while the pod's own words went unread.
     * The poll names the image the moment the pod does.
     */
    it('names an unpullable executor image instead of burning the runner deadline', async () => {
        const { request: base } = fakeRequest({
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                containerStatuses: [
                                    {
                                        state: {
                                            waiting: {
                                                reason: 'ImagePullBackOff',
                                                message: 'Failed to pull image "claude-executor": pull access denied',
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
            },
        });
        let polls = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                polls += 1;
                return polls === 1
                    ? { status: 200, body: '{"status":{}}' }
                    : {
                          status: 200,
                          body: JSON.stringify({
                              status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] },
                          }),
                      };
            }
            return base(method, path, body);
        };
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /the executor image "claude-executor" cannot be pulled: ImagePullBackOff/
        );
        // Named on the first poll — the image question never waits out the deadline.
        expect(polls).toBe(1);
    });

    /*
     * The takeover pin: a leftover claim of an OLDER attempt (a driver that died holding it) is
     * released by the next claimant, conditionally on the exact incarnation it read — the uid
     * precondition is what keeps a stale attempt's delete from ever reaching a newer incarnation
     * of the claim. Attempt numbers order the attempts of one job; no clock is read anywhere.
     */
    it('takes over the leftover claim of an older attempt under a uid precondition, then creates', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const claimPath = claimPathFor(job.id);
        const serve = claimServer();
        // A leftover from the older attempt: the first claim POST stores it under claim-uid-1.
        let seeded = false;
        const { request, calls } = routed((method, path, body) => {
            if (!seeded) {
                seeded = true;
                serve('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: job.leaseToken, claimSeq: '1' },
                });
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            return serve(method, path, body);
        });

        const outcome = await supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        ).run(newerJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // The takeover delete names the exact claim incarnation that was read.
        const takeover = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
        expect((takeover?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
            'claim-uid-1'
        );
        expect(calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`)).toEqual([
            `POST ${configmapsPath}`,
            `GET ${claimPath}`,
            `DELETE ${claimPath}`,
            `POST ${configmapsPath}`,
            `GET ${jobsPath(namespace)}`,
            `GET /api/v1/namespaces/factory/pods`,
            `GET /api/v1/namespaces/factory/services`,
            // The per-attempt Secret — written after the sweep, before the claim. It is kept with
            // the group: `finish` reaps it, not the run.
            `POST /api/v1/namespaces/factory/secrets`,
            `GET ${claimPath}`,
            `POST ${jobsPath(namespace)}`,
            `GET ${claimPath}`,
            `GET ${jobPath(namespace, runnerJobName(newerJob))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
            // The close-time claude-code turn read: one aux Job, polled, logged, reaped. It
            // rides THIS attempt, so its name hashes the token this run holds.
            ...cturnsCalls(newerJob),
            `GET ${claimPath}`,
            `DELETE ${claimPath}`,
        ]);
    });

    /*
     * Issue #32, race 1: both fences could observe an empty selector before either POST became
     * visible, and both attempts would create Jobs — two runners on one writable checkout, the
     * exact harm docs/jobs.md calls the single most important line in the board contract. Under
     * the claim protocol the second attempt's POST answers 409, it takes over only because its
     * attempt number is ahead, and the FIRST attempt — still inside its sweep, holding nothing
     * anymore — finds the claim no longer its own and stands down before creating anything.
     */
    it('admits one runner per checkout: the superseded attempt stands down mid-sweep', async () => {
        const olderJob: BoardJob = { ...job, attempts: 1, claimSeq: 1 };
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const newerJobName = runnerJobName(newerJob);
        const liveJobs = new Set<string>();

        let signalOlderClaimed!: () => void;
        const olderClaimed = new Promise<void>((resolve) => {
            signalOlderClaimed = resolve;
        });
        let openOlderList!: () => void;
        const olderList = new Promise<void>((resolve) => {
            openOlderList = resolve;
        });

        // One fake for both attempts: they share its claim server, as they share the apiserver.
        const { request: shared, calls } = routed((method, path, body) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({ items: [...liveJobs].map((name) => ({ metadata: { name } })) }),
                };
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                liveJobs.add((body as { metadata?: { name?: string } })?.metadata?.name ?? '');
                return { status: 201, body: '{}' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                liveJobs.delete(path.slice(jobsPath(namespace).length + 1).split('?')[0] ?? '');
                return { status: 200, body: '{}' };
            }
        });
        // The older attempt's fence: its first label list is held until the test has run the
        // newer attempt to completion, so the sweep sees the replacement's live Job.
        const olderRequest: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                // The claim is taken before the first list in the fixed code; signal then. Before
                // the fix there is no claim POST, so signal at the list instead — the test must
                // start the newer attempt either way.
                signalOlderClaimed();
                return olderClaimed.then(() => olderList).then(() => shared(method, path, body));
            }
            const result = shared(method, path, body);
            if (method === 'POST' && path === configmapsPath) {
                result.then(
                    () => signalOlderClaimed(),
                    () => signalOlderClaimed()
                );
            }
            return result;
        };

        const makeRunner = (request: K8sRequest) =>
            supervisedRunner(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
                request,
                async () => {}
            );

        const olderRun = makeRunner(olderRequest).run(olderJob, { id: SESSION, resume: false });
        await olderClaimed;
        const newerOutcome = await makeRunner(shared).run(newerJob, { id: SESSION, resume: false });
        expect(newerOutcome.exitCode).toBe(0);
        openOlderList();
        await expect(olderRun).rejects.toThrow(/stands down/);

        // Exactly one runner Job was ever created, and it is the newer attempt's. Named by its
        // body: the close-time turn read posts its own aux Job here too.
        const jobPosts = calls.filter(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata?: { name?: string } } | undefined)?.metadata?.name === newerJobName
        );
        expect(jobPosts).toHaveLength(1);
        expect((jobPosts[0]?.body as { metadata?: { name?: string } } | undefined)?.metadata?.name).toBe(newerJobName);
        // The superseded attempt never reached the winner's objects.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(newerJobName))).toBe(false);
    });

    // The env Secret this run creates precedes its first Job POST — and must SURVIVE the fence:
    // the Job references it by name, and a deleted one would start the pod silently without its
    // claim env. The fence sweeps JOBS by label and nothing else — and the Secret's name carries
    // this attempt's own lease token, so there is no previous attempt's Secret at this name.
    it('keeps the freshly created Secret across the label fence', async () => {
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        // Every delete but the claim's answers plainly; the claim keeps its uid precondition.
        const { request, calls } = routed((method, path) =>
            method === 'DELETE' && !path.startsWith(configmapsPath) ? { status: 200, body: '{}' } : undefined
        );

        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const outcome = await supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        ).run(envJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // Created once, before the Job POST.
        const secretPosts = calls.filter((c) => c.method === 'POST' && c.path === secretsPath);
        expect(secretPosts).toHaveLength(1);
        expect(calls.findIndex((c) => c.method === 'POST' && c.path === secretsPath)).toBeLessThan(
            calls.findIndex((c) => c.method === 'POST' && c.path === jobsPath(namespace))
        );
        // And NOT deleted between the fence and the Job POST.
        const fenceList = calls.findIndex((c) => c.method === 'GET' && c.path?.includes('labelSelector='));
        const rePost = calls.findIndex(
            (c, i) => i > fenceList && c.method === 'POST' && c.path === jobsPath(namespace)
        );
        const secretDeletesInTheFence = calls
            .slice(fenceList, rePost)
            .filter((c) => c.method === 'DELETE' && c.path?.includes('/secrets'));
        expect(secretDeletesInTheFence).toHaveLength(0);
    });

    /*
     * The sweep classifies NOTHING, so every Job the `factory.job` selector answers is deleted —
     * which is safe exactly because the claim is held: whoever the Jobs belonged to, the board
     * has superseded them, and a successor that reclaims while this sweep is in flight makes the
     * claim check answer not-ours and stands this attempt down before a single delete lands. No
     * timestamp makes a predecessor distinguishable — one can be younger than any cutoff, because
     * its attempt's fencing waited on the kubelet's unbounded garbage collection. Each is deleted
     * BY NAME with Foreground propagation; a collection DELETE is still never issued, because
     * the API server evaluates a selector at processing time and one in flight could reach Jobs
     * posted after the fence began — this attempt's own, once created.
     */
    it('fences every Job the label answers — leftover and fresh successor alike — by name, never as a collection DELETE', async () => {
        const now = Date.now();
        const oldName = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        const freshName = 'factory-job-11111111-1111-4111-8111-111111111111-newlease-runner';
        const oldJob = { metadata: { name: oldName, creationTimestamp: new Date(now - 10 * 60_000).toISOString() } };
        const freshJob = { metadata: { name: freshName, creationTimestamp: new Date(now).toISOString() } };
        let old = true;
        let fresh = true;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({ items: [old ? oldJob : null, fresh ? freshJob : null].filter(Boolean) }),
                };
            }
            // The API server evaluates a selector at processing time: a collection DELETE would
            // take EVERY Job of the id — including this attempt's own once created. The fence
            // must never issue one.
            if (method === 'DELETE' && path.includes('labelSelector=')) {
                old = false;
                fresh = false;
                return { status: 200, body: '{}' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                if (path.startsWith(`${jobPath(namespace, oldName)}`)) old = false;
                if (path.startsWith(`${jobPath(namespace, freshName)}`)) fresh = false;
                return { status: 200, body: '{}' };
            }
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // No collection DELETE anywhere in the run: one whose selector would match this
        // attempt's own Job once created is exactly the delete this fence must never issue.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes('labelSelector='))).toBe(false);
        // Both Jobs go BY NAME, Foreground — the fresh successor's leftover too: its run
        // released the claim before this attempt acquired it, so its Job is sweepable.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, oldName)}?propagationPolicy=Foreground`,
        });
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, freshName)}?propagationPolicy=Foreground`,
        });
        // Claim, LIST ×3 (finds both in jobs; pods and services empty), claim confirmed ours,
        // two deletes, LIST ×3 (clean), claim re-verified before the create, create, claim
        // verified again, then the status poll, the pod list, the log, the claim release and
        // the Secret's reap.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'DELETE',
            'GET',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    /*
     * THE race the mutex closes: this attempt loses its lease while its own Secret creation and
     * fencing consume more than half of it. The predecessor's Job — a different lease token —
     * was created 7 seconds before the fence's deciding list under a 10s lease, so the
     * half-lease cutoff computed at fence entry classified it FRESH and spared it: two writers
     * on one checkout. No clock-derived predicate can classify that correctly — a Job stamped
     * fence-entry-fresh is exactly what the cutoff tested — so the fence no longer classifies
     * at all: any Job the label answers is deleted by name and awaited before the create. The
     * lease is pinned at the supported minimum to prove nothing timing-based remains
     * load-bearing.
     */
    it('deletes a live predecessor the age filter would have called fresh, and waits for it before creating', async () => {
        const predecessor = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let predecessorAlive = true;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: predecessorAlive
                            ? [{ metadata: { name: predecessor, creationTimestamp: new Date().toISOString() } }]
                            : [],
                    }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                if (path.startsWith(jobPath(namespace, predecessor))) predecessorAlive = false;
                return { status: 200, body: '{}' };
            }
        });

        // A 10s lease puts the entry-time cutoff 5s back: the predecessor — younger than that
        // at the deciding list — is a live writer on this checkout, and it must not survive.
        const r = supervisedRunner(
            loadDriverConfig({
                EXECUTOR: 'kubernetes',
                K8S_NAMESPACE: namespace,
                DRIVER_LEASE_SECONDS: '10',
                RUNNER_SERVICES: '0',
            }),
            request,
            async () => {}
        );
        const outcome = await r.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // Deleted BY NAME, Foreground...
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, predecessor)}?propagationPolicy=Foreground`,
        });
        // ...and only once the claim is confirmed ours and the selector answers nothing does
        // this attempt create its own Job: claim, LIST ×3 (finds the predecessor in jobs; the
        // others empty), claim confirmed, DELETE, LIST ×3 (clean), claim re-verified, POST,
        // claim verified, then the status poll and the close-time reads.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    // A collection that answers 404 has nothing behind it to fence: straight to the create, no
    // second list, no deletes.
    it('treats a 404 from the label list as nothing left to fence', async () => {
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 404, body: '{"kind":"Status"}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Jobs 404s; the sweep goes on to the pods and services lists, both empty — the
            // round is conclusive and the checkout is free. The per-attempt Secret is written
            // after the sweep, before the claim that precedes the create — and reaped with it.
            'GET',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    // A dropped connection says nothing about whether the objects are gone; the fence keeps
    // polling within the same bound instead of creating alongside what may still be there.
    it('keeps fencing through a transport failure on the list', async () => {
        let lists = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                // First read: the connection drops. Second: the selector answers nothing.
                return lists === 1
                    ? Promise.reject(new Error('connection reset'))
                    : Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Round one: the jobs list drops — the round is inconclusive, and the pods and
            // services lists still run before the retry.
            'GET',
            'GET',
            'GET',
            // Round two: jobs, pods and services all answer empty — free to create. The
            // per-attempt Secret is written after the sweep, before the claim — reaped with it.
            'GET',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    /*
     * Release is conditional: the only claim this attempt may ever delete is the exact
     * incarnation it still holds, proved by a GET before the DELETE. Case (a): a finished run
     * releases its own claim, uid-preconditioned. Case (b): a claim that has moved on — taken
     * over, or already gone — is left entirely alone.
     */
    it('releases the claim when the run ends, and never releases a claim it no longer holds', async () => {
        const claimPath = claimPathFor(job.id);
        // (a) A successful run ends with the claim read and released, the last call of the run —
        // the service fleet outlives run() until the loop releases it, and the attempt's group and
        // Secret until its `finish`.
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const released = fakeRequest();
        await runner(released.request).run(envJob, { id: SESSION, resume: false });
        const tail = released.calls.slice(-2);
        expect(tail[0]).toEqual({ method: 'GET', path: claimPath });
        expect(tail[1]?.method).toBe('DELETE');
        expect(tail[1]?.path).toBe(claimPath);
        expect((tail[1]?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
            'claim-uid-1'
        );

        // (b) The claim answers gone at release time: no DELETE on the configmaps path at all.
        let reads = 0;
        const serve = claimServer();
        const { request, calls } = routed((method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) {
                // The verify reads (our claim, still held) succeed; every later read — the
                // release's — answers 404, as if another attempt took the claim over and
                // finished its whole run in between.
                reads += 1;
                if (reads > 3) return { status: 404, body: '{"kind":"Status"}' };
                return claimAnswer;
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The acquire POST and the two verifies around the Job POST happened — reads 1 through
        // 3 — and the release read found the claim gone without deleting anything.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // A claim with no claim sequence — hand-made, or written by a driver from before the field
    // existed — cannot be ordered, so it is taken over only once the board proves this attempt
    // holds the job's live lease: its holder's lease is then gone. Standing down on garbage alone
    // would let a dead claim hold the checkout forever.
    it('takes over a claim object that carries no claim sequence once the board proves the lease', async () => {
        const claimPath = claimPathFor(job.id);
        const serve = claimServer();
        let seeded = false;
        const { request, calls } = routed((method, path, body) => {
            if (!seeded) {
                seeded = true;
                // A hand-made claim: a holder, but no attempt field at all.
                serve('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: 'someone-else' },
                });
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            return serve(method, path, body);
        });

        const outcome = await runner(request, {}, boardLease(job)).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // Taken over, not stood down: the holder was not a newer attempt.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(true);
        // And the takeover was conditioned on the incarnation the GET read.
        expect(
            (
                calls.find((call) => call.method === 'DELETE' && call.path === claimPath)?.body as
                    | {
                          preconditions?: { uid?: string };
                      }
                    | undefined
            )?.preconditions?.uid
        ).toBe('claim-uid-1');
    });

    // The claim name is the one job-scoped object name this runner ever writes — asserted before
    // it joins an API path, the same way the Job's and the Secret's are.
    it('names the checkout claim after the job id alone, and refuses a job id that is not a uuid', () => {
        expect(claimName(job)).toBe(`factory-job-${job.id}-claim`);
        expect(() => claimName({ ...job, id: '../../etc/passwd' })).toThrow(/not a uuid/);
    });

    /*
     * The post-create verify is the bracket that closes race 1's residual window: a takeover
     * landing between the Job POST and the claim read is answered by the loser deleting its OWN
     * attempt-scoped Job and standing down — never by touching anything of the winner's.
     */
    it('stands down and removes its own Job when the claim is taken over between the Job POST and the verify', async () => {
        const claimPath = claimPathFor(job.id);
        let jobPosted = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === jobsPath(namespace)) {
                jobPosted = true;
                return { status: 201, body: '{}' };
            }
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    // The claim is ours until this attempt's Job exists; the takeover lands the
                    // moment it is — exactly the window this bracket closes.
                    return Promise.resolve(
                        jobPosted
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-9' },
                                      data: { holder: NEW_TOKEN, claimSeq: '2' },
                                  }),
                              }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-8' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /taken over before the runner could start/
        );
        // Its OWN Job, by name, Foreground.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, runnerJobName(job))}?propagationPolicy=Foreground`,
        });
        // And nothing of the winner's: no Job of the newer attempt is ever addressed.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(NEW_TOKEN))).toBe(false);
    });

    // A read that cannot name the incarnation it read is a bad read, and an UNCONDITIONED delete
    // of it could reach a newer claim — reopening both races through the takeover itself. The
    // runner refuses instead: fail loud, leave the job to its lease, delete nothing.
    it('refuses to release a claim it cannot identify, rather than deleting unconditioned', async () => {
        const claimPath = claimPathFor(job.id);
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 409, body: '{"reason":"AlreadyExists"}' };
            }
            if (path === claimPath && method === 'GET') {
                // An older holder by attempt number, but a body with no uid on it.
                return {
                    status: 200,
                    body: JSON.stringify({ data: { holder: 'someone-else', claimSeq: '0' } }),
                };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not be identified/
        );
        // No delete anywhere near the configmaps path, least of all an unconditioned one.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
        expect(calls.some((call) => call.method === 'DELETE' && call.body !== undefined)).toBe(false);
    });

    // A blink on the post-create verify is not proof the claim moved: the read runs with the
    // same bounded patience the status poll has, and only a definitive answer stands the run down.
    it('keeps the run through a transient failure on the post-create claim verify', async () => {
        const claimPath = claimPathFor(job.id);
        let reads = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // First read: the apiserver blinks right after the Job POST. Second: ours.
                    return Promise.resolve(
                        reads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The 503 was retried, not acted on; the run created its Job and released its claim.
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(
            calls.filter(
                (call) =>
                    call.method === 'POST' &&
                    call.path === jobsPath(namespace) &&
                    (call.body as { metadata?: { name?: string } } | undefined)?.metadata?.name === runnerJobName(job)
            )
        ).toHaveLength(1);
    });

    /*
     * The bracket's first half: a takeover already visible BEFORE the Job POST must meet a
     * create() that creates nothing — the older attempt never becomes a second writer on the
     * checkout, not even briefly. The claim read that answers the takeover is the one between
     * the sweep and the POST.
     */
    it('stands down before creating the runner job when the claim is taken over before the POST', async () => {
        const claimPath = claimPathFor(job.id);
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath && method === 'GET') {
                // The takeover lands between the sweep and the Job POST.
                return {
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-7' },
                        data: { holder: NEW_TOKEN, claimSeq: '2' },
                    }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return { status: 200, body: '{}' };
            }
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/stands down/);
        // The takeover was visible before the POST: no Job is ever created...
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        // ...and nothing on the jobs path is deleted — this attempt has nothing there to delete.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(jobsPath(namespace)))).toBe(
            false
        );
    });

    // The pre-create verify carries the same bounded patience as every verdict-carrying read: a
    // blink before the Job POST is waited out, not acted on — and the Job is posted exactly
    // once, only after the claim is confirmed.
    it('waits out a blink on the pre-create claim verify, and posts the Job only after it', async () => {
        const claimPath = claimPathFor(job.id);
        let reads = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // The apiserver blinks on the FIRST claim read of the run — the pre-create
                    // verify's — and answers ours from then on.
                    return Promise.resolve(
                        reads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(
            calls.filter(
                (call) =>
                    call.method === 'POST' &&
                    call.path === jobsPath(namespace) &&
                    (call.body as { metadata?: { name?: string } } | undefined)?.metadata?.name === runnerJobName(job)
            )
        ).toHaveLength(1);
        const firstClaimRead = calls.findIndex((call) => call.method === 'GET' && call.path === claimPath);
        const jobPost = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(firstClaimRead).toBeGreaterThanOrEqual(0);
        expect(firstClaimRead).toBeLessThan(jobPost);
    });

    /*
     * The post-create verify matrix. No runner stays on a checkout its driver cannot verify: when
     * the post-create verify spends its whole patience without an answer — or answers but cannot
     * name a holder, neither provably ours nor a definitive loss — the loser best-effort deletes
     * its OWN Job (Foreground) and burns the attempt, the fence's own rule.
     *
     * The failed-delete rule: a stand-down whose own-Job DELETE answers neither 2xx nor 404 leaves
     * the Job's fate to the kubelet's deadline — and this attempt's runner may still be on the
     * checkout when a replacement claimant arrives. So the claim is NOT released: the next
     * claimant's stale-holder takeover (uid-preconditioned release, then a sweep of every
     * `factory.job=<id>` Job) is the documented route that reclaims both. A 404 is a SUCCESS (the
     * Job is already gone) and a 2xx the ordinary success: both release the claim,
     * uid-preconditioned as ever.
     */
    const ours = {
        status: 200,
        body: JSON.stringify({ metadata: { uid: 'claim-uid-1' }, data: { holder: job.leaseToken, claimSeq: '1' } }),
    };
    const noHolder = { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-x' } }) };
    // Read 1 is the pre-create verify (ours); reads 2 through POLL_MAX_CONSECUTIVE_FAILURES + 2 are
    // the post-create verify; anything after would be the release's read.
    const spent = (read: number): boolean => read > 2 + POLL_MAX_CONSECUTIVE_FAILURES;
    const verifyCases: {
        name: string;
        claimRead: (read: number) => { status: number; body: string };
        deleteStatus: number;
        error: RegExp;
        claim: 'held' | 'released';
    }[] = [
        {
            name: 'removes its own Job when the post-create claim verify exhausts its patience',
            // Every post-create read answers 503, the release's read too.
            claimRead: (read) => (read === 1 ? ours : { status: 503, body: 'unavailable' }),
            deleteStatus: 200,
            error: /in a row|unavailable|checkout claim/i,
            claim: 'held',
        },
        {
            name: 'removes its own Job when the post-create claim verify cannot name a holder',
            // Every later read answers 200 with a body that carries no holder at all.
            claimRead: (read) => (read === 1 ? ours : noHolder),
            deleteStatus: 200,
            error: /could not be confirmed/,
            claim: 'held',
        },
        {
            name: 'holds the claim when the post-create verify exhausts its patience and the own-Job delete fails',
            claimRead: (read) => (read === 1 || spent(read) ? ours : { status: 500, body: 'unavailable' }),
            deleteStatus: 500,
            error: /in a row/,
            claim: 'held',
        },
        {
            name: 'releases the claim when the own-Job delete answers 404 — already gone is a success',
            claimRead: (read) => (read === 1 || spent(read) ? ours : { status: 500, body: 'unavailable' }),
            deleteStatus: 404,
            error: /in a row/,
            claim: 'released',
        },
        {
            name: 'releases the claim when the own-Job delete succeeds after an exhausted post-create verify',
            claimRead: (read) => (read === 1 || spent(read) ? ours : { status: 500, body: 'unavailable' }),
            deleteStatus: 200,
            error: /in a row/,
            claim: 'released',
        },
        {
            // Uniformity: the unverifiable branch holds the claim on a failed delete exactly like
            // the exhausted-patience branch — and here the release read WOULD answer ours, so the
            // hold is the only thing standing between the claim and its release.
            name: 'holds the claim when the verify cannot name a holder and the own-Job delete fails',
            claimRead: (read) => (read === 2 ? noHolder : ours),
            deleteStatus: 500,
            error: /could not be confirmed/,
            claim: 'held',
        },
    ];
    it.each(verifyCases.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
        const { claimRead, deleteStatus, error, claim } = row;
        const claimPath = claimPathFor(job.id);
        let reads = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    return Promise.resolve(claimRead(reads));
                }
                return { status: 200, body: '{}' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return { status: deleteStatus, body: deleteStatus === 404 ? '{"kind":"Status"}' : '{}' };
            }
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(error);
        // The delete names only this attempt's own Job, Foreground — best-effort.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, runnerJobName(job))}?propagationPolicy=Foreground`,
        });
        if (claim === 'held') {
            expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
        } else {
            const release = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
            expect(release).toBeDefined();
            expect((release?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
                'claim-uid-1'
            );
        }
    });

    /*
     * The taken-over branch sets the hold flag the same way, but the claim itself was never this
     * attempt's to release once a newer attempt holds it — releaseClaim was a no-op there before
     * the flag existed, and this pin keeps the uniform flag from regressing that: a failed delete
     * must not turn a no-op release into a delete of a claim this attempt does not hold.
     */
    it('leaves a taken-over claim untouched when the stand-down deletes nothing', async () => {
        const claimPath = claimPathFor(job.id);
        let jobPosted = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === jobsPath(namespace)) {
                jobPosted = true;
                return { status: 201, body: '{}' };
            }
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath && method === 'GET') {
                // The claim is ours until this attempt's Job exists; the takeover lands the
                // moment it is. Later reads — the release's — still answer the new holder.
                return Promise.resolve(
                    jobPosted
                        ? {
                              status: 200,
                              body: JSON.stringify({
                                  metadata: { uid: 'claim-uid-9' },
                                  data: { holder: NEW_TOKEN, claimSeq: '2' },
                              }),
                          }
                        : {
                              status: 200,
                              body: JSON.stringify({
                                  metadata: { uid: 'claim-uid-8' },
                                  data: { holder: job.leaseToken, claimSeq: '1' },
                              }),
                          }
                );
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return { status: 500, body: 'refused' };
            }
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /taken over before the runner could start/
        );
        // The stand-down did try its own Job delete — and only its own.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, runnerJobName(job))}?propagationPolicy=Foreground`,
        });
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(NEW_TOKEN))).toBe(false);
        // And the claim that moved on is never deleted.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // The sweep deletes only when the claim verify answers definitively: a blink on the claim
    // read is 'unknown' — nothing is deleted that round, and the fence looks again within its
    // bound, because deleting on a maybe is what would reach the winner's Job.
    it('deletes nothing on a round whose claim verify could not be confirmed, and looks again', async () => {
        const leftover = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let claimReads = 0;
        let lists = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPathFor(job.id)) {
                if (method === 'GET') {
                    claimReads += 1;
                    // The sweep's FIRST verify read: the apiserver blinks. The second (and every
                    // later read, including the post-create verify and the release) answers ours.
                    return Promise.resolve(
                        claimReads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                return {
                    status: 200,
                    body: JSON.stringify({ items: lists <= 2 ? [{ metadata: { name: leftover } }] : [] }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return { status: 200, body: '{}' };
            }
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // LIST ×3 (leftover in jobs; pods/services empty), verify 503 → no delete, LIST ×3
        // (leftover again), verify ours → DELETE, LIST ×3 (clean), claim re-verified, create,
        // verify, poll, pods, log, release, release-delete, Secret reap.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
        expect(calls[9]?.path).toBe(`${jobPath(namespace, leftover)}?propagationPolicy=Foreground`);
    });

    // The board refuses a complete POST that does not fit its body limit — an oversized report
    // would fail to report, leave the job to its lease, and re-run finished work until the job
    // went dead. The cap has to hold for the WORST log, not the average one: a character cap
    // counts UTF-16 units, and 64 Ki of CJK text is 192 KiB of UTF-8, while control characters
    // expand six-fold under JSON escaping.
    it('keeps the report under the board body limit even fully escaped', async () => {
        // CJK: three bytes per character in UTF-8. Control characters: up to six bytes once
        // JSON.stringify escapes them. Together, the worst case the report can face.
        const oversized = 'あ'.repeat(100 * 1024) + '\u0001'.repeat(100 * 1024);
        const { request } = fakeRequest({ log: { status: 200, body: oversized } });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        const body = JSON.stringify({
            leaseToken: job.leaseToken,
            status: 'succeeded',
            exitCode: 0,
            output: outcome.output,
        });
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(128 * 1024);
        // The tail, not the head: a run that fails says why at the end.
        expect(outcome.output.endsWith('\u0001')).toBe(true);
    });

    // A 503 during an apiserver upgrade, or a dropped connection, is not the run's verdict — the
    // pod may already have succeeded. The poll retries a bounded number of times instead of
    // abandoning the job to its lease and re-running it.
    it('keeps polling through transient API failures', async () => {
        let gets = 0;
        const { request } = routed((method, path) => {
            if (path === jobPath(namespace, runnerJobName(job))) {
                gets += 1;
                if (gets <= 2) return { status: 503, body: 'unavailable' };
                return FAKE.job as K8sResponse;
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(gets).toBe(3);
    });

    // HTTP failures and transport exceptions take separate branches, but have the same bound and
    // cleanup contract: the run hands the checkout claim back, and the attempt's group and Secret
    // go with the loop's `finish`, which the loop calls on every exit. One table keeps that
    // contract in one place instead of duplicating the whole attempt fixture.
    it.each(['http', 'transport'] as const)(
        'abandons after consecutive %s polling failures, hands the claim back and reaps the attempt Secret on finish',
        async (failure) => {
            const base = fakeRequest({ job: { status: 503, body: 'unavailable' } });
            let failedReads = 0;
            const request: K8sRequest = (method, path, body) => {
                if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                    failedReads += 1;
                    if (failure === 'transport') return Promise.reject(new Error('connection reset'));
                }
                return base.request(method, path, body);
            };
            const calls = base.calls;
            const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
            const attempt = supervisedRunner(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
                request,
                async () => {}
            );
            await expect(attempt.run(envJob, { id: SESSION, resume: false })).rejects.toThrow(
                failure === 'http' ? /in a row/ : /connection reset/
            );

            expect(failedReads).toBe(POLL_MAX_CONSECUTIVE_FAILURES + 1);
            const last = calls[calls.length - 1]!;
            expect(last.method).toBe('DELETE');
            expect(last.path).toBe(claimPathFor(envJob.id));
            const secretPath = `/api/v1/namespaces/${namespace}/secrets/${secretName(envJob)}`;
            expect(calls.some((call) => call.method === 'DELETE' && call.path === secretPath)).toBe(false);

            await attempt.finish!(envJob);
            const secretCreate = calls.findIndex((call) => call.method === 'POST' && call.path?.endsWith('/secrets'));
            const secretReap = calls.findIndex((call) => call.method === 'DELETE' && call.path === secretPath);
            expect(secretReap).toBeGreaterThan(secretCreate);
        }
    );

    // Two outages of 10 reads each would trip the bound if the count carried across them — it
    // must not. One good read in between proves the job is alive and observable again.
    it('recounts after a good read, so separate outages do not add up', async () => {
        const outage = (): K8sResponse => ({ status: 503, body: 'unavailable' });
        const script: K8sResponse[] = [
            ...Array.from({ length: 10 }, outage),
            { status: 200, body: JSON.stringify({ status: {} }) },
            ...Array.from({ length: 10 }, outage),
            FAKE.job as K8sResponse,
        ];
        let served = 0;
        const { request } = routed((method, path) => {
            if (path === jobPath(namespace, runnerJobName(job))) {
                return script[served++] ?? outage();
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        expect(served).toBe(22);
    });

    /*
     * A completed pod can be garbage-collected before the list that reads its exit code. The Job
     * status is then the verdict: this Job runs one pod and never retries it, so the controller
     * can only have counted success on an exit-0 termination — and a null exit code would map to
     * `failed` in the loop, recording finished work as failed. A failed Job still reports failed.
     */
    it.each<[string, Record<string, unknown>, number | null]>([
        ['treats the Job status as the verdict when its pod is already gone', {}, 0],
        [
            'still reports a failed job when its pod is gone',
            { job: { status: 200, body: JSON.stringify({ status: { failed: 1 } }) } },
            null,
        ],
    ])('%s', async (_name, overrides, exitCode) => {
        const { request } = fakeRequest({ ...overrides, pods: { status: 200, body: JSON.stringify({ items: [] }) } });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode, timedOut: false, output: '' });
    });

    // After a re-claim, the replaced attempt's pod can still be listed while it terminates — same
    // job-name label, different run. Its exit code must never be reported as this run's verdict.
    it('skips a pod that is still terminating, rather than reporting its exit code', async () => {
        const { request } = fakeRequest({
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: `${podName}-old`, deletionTimestamp: '2026-08-29T12:06:00.000Z' },
                            status: { containerStatuses: [{ state: { terminated: { exitCode: 7 } } }] },
                        },
                        {
                            metadata: { name: podName },
                            status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                        },
                    ],
                }),
            },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
    });

    // A vanished Job object is not a transient failure: its verdict can never arrive, so polling
    // on would hold a worker slot forever.
    it('abandons the run when the job object is gone', async () => {
        const { request } = fakeRequest({ job: { status: 404, body: '{"kind":"Status"}' } });
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/no longer exists/);
    });

    // The deadline is enforced by the kubelet, so the Job reports failed with the reason attached;
    // the driver maps that onto the same verdict `docker kill` after DRIVER_JOB_TIMEOUT_MS gets.
    // A current cluster marks the deadline `FailureTarget` first and `Failed` only once the pod is
    // gone; the runner reads the first terminal status it sees, so it must know both.
    it.each<[string, () => unknown]>([
        ['treats DeadlineExceeded as a timeout', () => FAKE.failed],
        [
            'treats a DeadlineExceeded FailureTarget as a timeout too',
            () => ({
                status: 200,
                body: JSON.stringify({
                    status: { failed: 1, conditions: [{ type: 'FailureTarget', reason: 'DeadlineExceeded' }] },
                }),
            }),
        ],
    ])('%s', async (_name, answer) => {
        const { request } = fakeRequest({ job: answer() });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.timedOut).toBe(true);
    });

    // The runner never started — creation was refused. Reporting `failed` would blame the command
    // for the driver's problem, so the error propagates and the loop leaves the job to its lease.
    it('leaves a job to its lease when the job cannot be created', async () => {
        const { request } = fakeRequest({ create: { status: 500, body: 'nope' } });
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/500/);
    });

    it('keeps polling the pod list through transient API failures', async () => {
        let lists = 0;
        const { request } = routed((method, path) => {
            if (
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('job-name=')
            ) {
                lists += 1;
                // A 503 during an apiserver upgrade is not the run's verdict; the exit code is
                // still out there. The third read succeeds.
                return lists <= 2 ? { status: 503, body: 'unavailable' } : (FAKE.pods as K8sResponse);
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The runner's poll plus the claude turn read's own pod list.
        expect(lists).toBe(4);
    });

    // A log read that fails outright — connection reset, pod gone — must not fail the report: the
    // exit code already carries the verdict, and re-running finished work is the worse outcome.
    it('keeps the verdict when the log read fails outright', async () => {
        const { request } = routed((method, path) => {
            if (path.includes('/log')) return Promise.reject(new Error('connection reset'));
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(outcome.output).toBe('');
    });

    it('kill deletes the job and tolerates it already being gone', async () => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path) => {
            calls.push({ method, path });
            // First call is the Job DELETE (200); everything after — the service fleet's lease
            // lists and their deletes — answers 404, the ordinary end of nothing being there.
            return Promise.resolve({ status: calls.length === 1 ? 200 : 404, body: '{}' });
        };
        await runner(request).kill(job);
        await runner(request).kill(job);

        expect(calls[0]!.method).toBe('DELETE');
        expect(calls[0]!.path).toContain(`jobs/${runnerJobName(job)}`);
        // Every further call is the attempt's own teardown: its Secret (by its own name — the
        // group's steps are over with the Job, and a 404 is the ordinary end), then the lease-scoped
        // pod and service lists (and 404 deletes for whatever they ever named).
        expect(calls[1]!.method).toBe('DELETE');
        expect(calls[1]!.path).toBe(`/api/v1/namespaces/${namespace}/secrets/${secretName(job)}`);
        expect(calls.filter((call) => call.path?.includes('/secrets'))).toHaveLength(2);
        expect(calls.every((call) => call.method === 'DELETE' || call.path?.includes('?labelSelector='))).toBe(true);
    });

    // The id lands in the DELETE path the same way it lands in the create — asserted before it is
    // interpolated, whatever the call.
    it('kill refuses a job id that is not a uuid', async () => {
        const { request } = fakeRequest();
        await expect(runner(request).kill({ ...job, id: 'not-a-uuid' })).rejects.toThrow(/not a uuid/);
    });
});

/** The runner pod's agent log read — the verdict's, and the live tail's. */
const isAgentLogRead = (path: string): boolean =>
    path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`) &&
    path.includes(`container=${AGENT_CONTAINER}`);

/** The kubelet's answer to a pod log read: the whole log, or its last `tailLines` lines when asked for. */
const kubeletLog =
    (log: string) =>
    (path: string): K8sResponse => {
        const tail = new URL(path, 'http://apiserver').searchParams.get('tailLines');
        return {
            status: 200,
            body:
                tail === null
                    ? log
                    : log
                          .split(/(?<=\n)/)
                          .slice(-Number(tail))
                          .join(''),
        };
    };

/** A fake whose agent log reads `answer` gives, everything else as fakeRequest answers it. */
const withAgentLog = (answer: (path: string) => K8sResponse) =>
    routed((method, path) => (method === 'GET' && isAgentLogRead(path) ? answer(path) : undefined));

const numberedLines = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i}\n`).join('');

describe('the runner verdict log (#825)', () => {
    const run = (request: K8sRequest) => runner(request).run(job, { id: SESSION, resume: false });

    it('uploads a log past the 1,000-line tail whole, and complete', async () => {
        const whole = numberedLines(LOG_TAIL_LINES + 500);
        const { request, calls } = withAgentLog(kubeletLog(whole));

        const outcome = await run(request);

        expect(outcome.fullLog).toBe(whole);
        expect(outcome.logTruncated).toBe(false);
        const reads = calls.filter((call) => isAgentLogRead(call.path));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((call) => !call.path.includes('tailLines'))).toBe(true);
    });

    it('reports a log the transport cut as truncated, whatever bytes it kept', async () => {
        const { request } = withAgentLog(() => ({ status: 200, body: 'kept tail\n', truncated: true }));

        const outcome = await run(request);

        expect(outcome).toMatchObject({ fullLog: 'kept tail\n', logTruncated: true });
    });

    it('keeps a multibyte log under the cap byte-true, with no replacement character', async () => {
        const { request } = withAgentLog(() => ({ status: 200, body: '€'.repeat(ARTIFACT_LIMIT / 2) }));

        const outcome = await run(request);

        expect(outcome.logTruncated).toBe(true);
        expect(Buffer.byteLength(outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(outcome.fullLog).not.toContain('�');
        expect(outcome.output).not.toContain('�');
    });

    it('calls a log of exactly ARTIFACT_LIMIT bytes complete, and one byte more truncated', async () => {
        for (const [size, truncated] of [
            [ARTIFACT_LIMIT, false],
            [ARTIFACT_LIMIT + 1, true],
        ] as const) {
            const { request } = withAgentLog(() => ({ status: 200, body: 'x'.repeat(size) }));

            const outcome = await run(request);

            expect(outcome.logTruncated).toBe(truncated);
            expect(Buffer.byteLength(outcome.fullLog ?? '')).toBe(ARTIFACT_LIMIT);
        }
    });

    it('reads the verdict log of the agent container alone, never the exporter or the supervisor beside it', async () => {
        const { request, calls } = fakeRequest();

        await run(request);

        const logs = calls.filter((call) =>
            call.path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)
        );
        expect(logs.some((call) => isAgentLogRead(call.path))).toBe(true);
        for (const other of [EXPORTER_CONTAINER, SUPERVISOR_CONTAINER]) {
            expect(logs.some((call) => call.path.includes(`container=${other}`))).toBe(false);
        }
    });
});

// ==============================================================================================
// Gates under kubernetes: a gate run IS a Job — the declared image over the workspaces PVC,
// workingDir at the checkout, env by reference. Everything security-relevant about a gate Job is
// decided in gateJobSpec and pinned here, exactly as the runner's is in runnerJobSpec.
// ==============================================================================================

const gatedConfig = loadDriverConfig({
    EXECUTOR: 'kubernetes',
    K8S_NAMESPACE: namespace,
    GATE_TIMEOUT_MS: '30000',
});

describe('the gate job spec', () => {
    const ROOT_KEY = '55555555-5555-4555-8555-555555555555';
    const gateSpec = (overrides = 1, envSecret: string | null = 'the-secret') =>
        gateJobSpec(gatedConfig, job, {
            key: `bellows/${USER}/.worktrees/${ROOT_KEY}`,
            image: 'node:24',
            gateName: 'test',
            command: 'npm test',
            run: overrides,
            envSecretName: envSecret,
            gateTimeoutMs: 30_000,
        });

    it('is a batch/v1 Job named after the job id, lease and gate, unique per run', () => {
        expect(gateSpec().apiVersion).toBe('batch/v1');
        expect(gateSpec().metadata.name).toMatch(/^factory-gate-test-[0-9a-f]{16}$/);
        // A second run of the same gate is a different object — ad-hoc calls land mid-run, and
        // two runs of one gate must never race for one name.
        expect(gateSpec(2).metadata.name).not.toBe(gateSpec(1).metadata.name);
    });

    // The command travels as ONE argv element into `sh -c` — the same single element docker
    // exec's gate runs receive. It is never interpolated into a larger shell line.
    it('runs the declared command via sh -c as one argv element', () => {
        expect(gateSpec().spec.template.spec.containers[0]!.command).toEqual(['sh', '-c', 'npm test']);
    });

    it('works at the checkout the coding agent edits — the same tree, via the same PVC', () => {
        const container = gateSpec().spec.template.spec.containers[0]!;
        expect(container.workingDir).toBe(`/workspaces/bellows/${USER}/.worktrees/${ROOT_KEY}`);
        expect(container.image).toBe('node:24');
        expect(gateSpec().spec.template.spec.volumes).toEqual([
            { name: 'workspaces', persistentVolumeClaim: { claimName: 'factory-ai_workspaces' } },
        ]);
    });

    // The gate mounts the same per-job subtree the job's runner does — the checkout key's own
    // `<orgId>/<userId>` half — so the gate reads and writes one checkout and no sibling's or
    // foreign org's tree is reachable from it.
    it("mounts the checkout's own subtree only — the same scoping the runner gets", () => {
        const container = gateSpec().spec.template.spec.containers[0]!;
        expect(container.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
        ]);
    });

    it('carries the attempt labels and no ServiceAccount token', () => {
        const s = gateSpec();
        expect(s.metadata.labels).toEqual({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
        expect(s.spec.template.metadata.labels).toEqual(s.metadata.labels);
    });

    // The kubelet's deadline is the gate's wall-clock cap; the driver reads DeadlineExceeded
    // off the finished Job and reports exit 124.
    it('bounds the run with activeDeadlineSeconds from GATE_TIMEOUT_MS', () => {
        expect(gateSpec().spec.activeDeadlineSeconds).toBe(30);
    });

    // The env travels by reference and never as literals — the same rule that keeps claim
    // values out of the runner pod spec keeps them out of a gate pod spec. The literals are the
    // driver's own: HOME for the non-root uid (below) and the npm notice switch.
    it('reads the env from a Secret by reference, and skips envFrom entirely when there is none', () => {
        const container = gateSpec().spec.template.spec.containers[0]!;
        expect(container.envFrom).toEqual([{ secretRef: { name: 'the-secret' } }]);
        expect(container.env).toEqual([
            { name: 'HOME', value: '/tmp' },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
        ]);
        expect(gateSpec(1, null).spec.template.spec.containers[0]!.envFrom).toBeUndefined();
        // The two pinned just above are the only literal values anywhere in the spec.
        expect(JSON.stringify(gateSpec()).match(/"value":/g)).toHaveLength(2);
    });

    // The gate writes the shared task worktree, so it writes as the uid:gid every other writer
    // on that tree uses — the executor images' USER node (1000:1000), which the sync, reclaim
    // and runner Jobs run as. The declared image's own default (root, usually) would leave
    // gate-written files the uid-1000 reclaim can never remove (observed 2026-09-13 on the
    // docker twin: a gate-built core/dist left a worktree unremovable and its thread stuck).
    it('writes the worktree as the runner uid:gid, with a HOME that uid can write', () => {
        const s = gateSpec();
        // The uid:gid half only — the same field also carries the #382 seccomp profile, whose
        // merge with these two is pinned in 'keeps the gate uid:gid beside the seccomp profile'.
        expect(s.spec.template.spec.securityContext).toMatchObject({ runAsUser: 1000, runAsGroup: 1000 });
        const container = s.spec.template.spec.containers[0]!;
        expect(container.env).toEqual([
            { name: 'HOME', value: '/tmp' },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
        ]);
    });

    // A gate's tail is what the job output shows; npm's update notice must not be its last word
    // (#511) — the docker gate env's twin.
    it('silences npm update notices for every gate run', () => {
        expect(gateSpec().spec.template.spec.containers[0]!.env).toContainEqual({
            name: 'NPM_CONFIG_UPDATE_NOTIFIER',
            value: 'false',
        });
    });

    // Issue #734: the gate Job and the runner pod name the same cache path, inside the one
    // member subPath mount both already carry — the docker gate env's twin.
    it('points each declared cache name into the repo cache, the same path the runner pod gets', () => {
        const cacheJob: BoardJob = {
            ...job,
            repo: 'acme/widgets',
            rootJobId: ROOT_KEY,
            gates: { image: 'node:24', cache: ['NPM_CONFIG_CACHE'], gates: [] },
        };
        const path = `/workspaces/bellows/${USER}/.cache/acme/widgets/NPM_CONFIG_CACHE`;
        const gate = gateJobSpec(gatedConfig, cacheJob, {
            key: `bellows/${USER}/.worktrees/${ROOT_KEY}`,
            image: 'node:24',
            gateName: 'test',
            command: 'npm test',
            run: 1,
            envSecretName: 'the-secret',
            gateTimeoutMs: 30_000,
        }).spec.template.spec.containers[0]!;
        expect(gate.env).toContainEqual({ name: 'NPM_CONFIG_CACHE', value: path });
        expect(gate.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
        ]);
        const runner = runnerJobSpec(gatedConfig, cacheJob, { id: SESSION, resume: false }).spec.template.spec
            .containers[0]!;
        expect(runner.env).toContainEqual({ name: 'NPM_CONFIG_CACHE', value: path });
        const claimed: BoardJob = { ...cacheJob, env: { NPM_CONFIG_CACHE: '/elsewhere' } };
        const env = runnerJobSpec(gatedConfig, claimed, { id: SESSION, resume: false }).spec.template.spec
            .containers[0]!.env;
        expect(env.filter((entry) => entry.name === 'NPM_CONFIG_CACHE')).toEqual([
            {
                name: 'NPM_CONFIG_CACHE',
                valueFrom: { secretKeyRef: { name: secretName(claimed), key: 'NPM_CONFIG_CACHE' } },
            },
        ]);
    });

    // The claim's value arrives by envFrom, which an explicit `env` entry would beat.
    it('leaves the npm notice to a claim that names it, in the gate env Secret', () => {
        const envJob: BoardJob = { ...job, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        const s = gateJobSpec(gatedConfig, envJob, {
            key: `bellows/${USER}/.worktrees/${ROOT_KEY}`,
            image: 'node:24',
            gateName: 'test',
            command: 'npm test',
            run: 1,
            envSecretName: 'the-secret',
            gateTimeoutMs: 30_000,
        });
        expect(s.spec.template.spec.containers[0]!.env).toEqual([{ name: 'HOME', value: '/tmp' }]);
    });

    it('sanitizes a hostile gate name into a legal k8s name without carrying it raw', () => {
        const s = gateJobSpec(gatedConfig, job, {
            key: `bellows/${USER}/.worktrees/${ROOT_KEY}`,
            image: 'node:24',
            gateName: 'UPPER Case!!',
            command: 'npm test',
            run: 1,
            envSecretName: null,
            gateTimeoutMs: 30_000,
        });
        expect(s.metadata.name).toMatch(/^factory-gate-[a-z0-9.-]+-[0-9a-f]{16}$/);
        expect(s.metadata.name).not.toContain('UPPER');
        expect(s.metadata.name).not.toContain('Case');
    });

    it('refuses a checkout key or image that is not the shape the board legally produces', () => {
        expect(() => gateSpec(1, null)).not.toThrow();
        expect(() =>
            gateJobSpec(gatedConfig, job, {
                key: '../other-member/repo',
                image: 'node:24',
                gateName: 'test',
                command: 'npm test',
                run: 1,
                envSecretName: null,
                gateTimeoutMs: 30_000,
            })
        ).toThrow(/checkout key/);
        expect(() =>
            gateJobSpec(gatedConfig, job, {
                key: `bellows/${USER}/.worktrees/${ROOT_KEY}`,
                image: '-flag-image',
                gateName: 'test',
                command: 'npm test',
                run: 1,
                envSecretName: null,
                gateTimeoutMs: 30_000,
            })
        ).toThrow(/image reference/);
    });
});

describe('the gate env body', () => {
    it('parses NAME=value lines and drops nothing but the newlines', () => {
        expect(envBodyToData('A=1\nB=hello world\n')).toEqual({ A: '1', B: 'hello world' });
    });

    it('refuses a line that is not NAME=value, before it becomes a Secret key', () => {
        expect(() => envBodyToData('A=1\nnot-a-pair\n')).toThrow(/NAME=value/);
        expect(() => envBodyToData('bad key!=1')).toThrow(/NAME=value/);
    });
});

describe('the kubernetes gate manager', () => {
    const KEY = `bellows/${USER}/.worktrees/55555555-5555-4555-8555-555555555555`;
    const GATE_JOB = /^factory-gate-test-[0-9a-f]{16}$/;
    const GATE_JOB_PATH = /\/jobs\/factory-gate-test-[0-9a-f]{16}\?/;

    /** A fake that routes the objects one gate run touches: env Secret, Job, its pod, its log. */
    const gateFake = (
        options: {
            job?: K8sResponse;
            pods?: K8sResponse;
            log?: K8sResponse;
            secretCreate?: K8sResponse;
            jobCreate?: K8sResponse;
        } = {}
    ) => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const respond = (r: K8sResponse) => Promise.resolve(r);
            if (path === `/api/v1/namespaces/${namespace}/secrets`) {
                if (method === 'DELETE') return respond({ status: 200, body: '{}' });
                return respond(options.secretCreate ?? { status: 201, body: '{}' });
            }
            if (path.startsWith(`/api/v1/namespaces/${namespace}/secrets/`))
                return respond({ status: 200, body: '{}' });
            if (path === jobsPath(namespace)) {
                if (method === 'DELETE') return respond({ status: 200, body: '{}' });
                return respond(options.jobCreate ?? { status: 201, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}/`)) {
                return respond(options.job ?? { status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) });
            }
            if (path.includes('pods?') && decodeURIComponent(path).includes('job-name=')) {
                return respond(
                    options.pods ?? {
                        status: 200,
                        body: JSON.stringify({
                            items: [
                                {
                                    metadata: { name: 'gate-pod' },
                                    status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                                },
                            ],
                        }),
                    }
                );
            }
            if (path.includes('/log')) return respond(options.log ?? { status: 200, body: 'gate said hi\n' });
            return Promise.reject(new Error(`gate fake has no answer for ${method} ${path}`));
        };
        return { request, calls };
    };

    const manager = (request: K8sRequest) =>
        createKubernetesGateManager({ config: gatedConfig, request, sleep: async () => {} });

    it('creates the attempt env Secret before the Job, and reaps the Job with the verdict', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        await m.acquire(KEY, 'node:24', 'CORE_TOKEN=shh\n', { job });
        const outcome = await m.runGate(KEY, 'test', 'npm test');

        expect(outcome).toEqual({ exitCode: 0, output: 'gate said hi' });
        const secretPost = calls.findIndex((c) => c.method === 'POST' && c.path?.endsWith('/secrets'));
        const jobPost = calls.findIndex((c) => c.method === 'POST' && c.path === jobsPath(namespace));
        expect(secretPost).toBeGreaterThanOrEqual(0);
        expect(secretPost).toBeLessThan(jobPost);
        // The Secret carries the env values, labeled to this attempt — one per attempt, created
        // before any gate Job references it.
        expect(calls[secretPost]?.body).toMatchObject({
            kind: 'Secret',
            stringData: { CORE_TOKEN: 'shh' },
            metadata: { labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken } },
        });
        expect(calls[secretPost]?.body).toMatchObject({
            metadata: { name: gateEnvSecretName(job) },
        });
        // The Job goes once the verdict and log have been read; the Secret's life is the
        // attempt's, and release() is what ends it.
        expect(calls.some((c) => c.method === 'DELETE' && c.path?.startsWith(`${jobsPath(namespace)}/`))).toBe(true);
        expect(calls.some((c) => c.method === 'DELETE' && c.path?.includes('/secrets/'))).toBe(false);
        await m.release(KEY, job);
        expect(
            calls.some(
                (c) =>
                    c.method === 'DELETE' &&
                    c.path === `/api/v1/namespaces/${namespace}/secrets/${gateEnvSecretName(job)}`
            )
        ).toBe(true);
    });

    // A gate run's own GitHub token (asked at each run's start, docs/connections.md) reaches the
    // gate Job's pod through the Secret it reads at start: a changed body replaces the Secret.
    it('replaces the attempt env Secret when a re-acquire brings a different body, and only then', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        const secretCalls = () => calls.filter((c) => c.path?.includes('/secrets'));
        await m.acquire(KEY, 'node:24', 'GITHUB_TOKEN=ghs_first\n', { job });
        await m.acquire(KEY, 'node:24', 'GITHUB_TOKEN=ghs_second\n', { job });

        const after = secretCalls().map((c) => c.method);
        expect(after).toEqual(['POST', 'DELETE', 'POST']);
        expect(secretCalls()[2]?.body).toMatchObject({ stringData: { GITHUB_TOKEN: 'ghs_second' } });

        // The same body again replaces nothing: its create answers 409, and the Secret stands.
        await m.acquire(KEY, 'node:24', 'GITHUB_TOKEN=ghs_second\n', { job });
        expect(secretCalls().filter((c) => c.method === 'DELETE')).toHaveLength(1);
    });

    it('runs a gate with no env at all without touching a Secret', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', { job });
        await m.runGate(KEY, 'test', 'npm test');
        expect(calls.some((c) => c.path?.includes('/secrets'))).toBe(false);
    });

    it('reports the kubelet deadline as exit 124, the docker timeout convention', async () => {
        const { request } = gateFake({
            job: {
                status: 200,
                body: JSON.stringify({
                    status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] },
                }),
            },
        });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', { job });
        const outcome = await m.runGate(KEY, 'test', 'npm test');
        expect(outcome.exitCode).toBe(124);
    });

    /*
     * What a deadline looks like the moment it fires on a current cluster (observed on v1.37): the
     * Job already counts the pod failed but carries only `FailureTarget` — `Failed` lands later,
     * once the pod is gone — and the pod is terminating, so there is no live pod to read. Read as
     * an ordinary failure, that reported "exit 1, empty output" over a gate that simply ran long.
     */
    it('reports a deadline still at FailureTarget, pod terminating, as the timeout it is', async () => {
        const { request } = gateFake({
            job: {
                status: 200,
                body: JSON.stringify({
                    status: { failed: 1, conditions: [{ type: 'FailureTarget', reason: 'DeadlineExceeded' }] },
                }),
            },
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [{ metadata: { name: 'gate-pod', deletionTimestamp: '2026-09-26T05:40:24Z' } }],
                }),
            },
        });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', { job });
        const outcome = await m.runGate(KEY, 'test', 'npm test');
        expect(outcome.exitCode).toBe(124);
        expect(outcome.output).toMatch(/gate killed after \d+ms/);
    });

    // A gate's own `timeout:` (issue #576) is its Job's deadline; setup keeps GATE_TIMEOUT_MS.
    it("files the gate Job with the gate's own activeDeadlineSeconds, setup with the default", async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        const withSetup = { ...job, gates: { image: 'node:24', setup: 'npm ci', gates: [] } };
        await m.acquire(KEY, 'node:24', '', { job: withSetup });
        await m.runGate(KEY, 'ui', 'npm run verify:ui', { timeoutMs: 2_700_000 });

        const deadlines = calls
            .filter((c) => c.method === 'POST' && c.path === jobsPath(namespace))
            .map((c) => (c.body as { spec: { activeDeadlineSeconds: number } }).spec.activeDeadlineSeconds);
        expect(deadlines).toEqual([30, 2700]);
    });

    it("names the gate's own deadline when the kubelet kills it", async () => {
        const { request } = gateFake({
            job: {
                status: 200,
                body: JSON.stringify({
                    status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] },
                }),
            },
            log: { status: 200, body: '' },
        });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', { job });
        const outcome = await m.runGate(KEY, 'ui', 'npm run verify:ui', { timeoutMs: 2_700_000 });
        expect(outcome).toEqual({ exitCode: 124, output: '[driver] gate killed after 2700000ms' });
    });

    // A Stop or Remove ends the gate where it stands: its Job goes Foreground, its pod with it.
    it('deletes the running gate Job when the signal aborts, and stops polling', async () => {
        const { request, calls } = gateFake({ job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) } });
        const cancel = new AbortController();
        const watching: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}/`)) cancel.abort();
            return request(method, path, body);
        };
        const m = createKubernetesGateManager({
            config: gatedConfig,
            request: watching,
            sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
        });
        await m.acquire(KEY, 'node:24', '', { job });

        await expect(m.runGate(KEY, 'test', 'npm test', { signal: cancel.signal })).rejects.toMatchObject({
            code: 125,
        });

        const deletes = calls.filter((c) => c.method === 'DELETE' && c.path?.startsWith(`${jobsPath(namespace)}/`));
        expect(deletes.some((c) => c.path?.includes('propagationPolicy=Foreground'))).toBe(true);
        expect(deletes[0]?.path).toMatch(GATE_JOB_PATH);
    });

    it('creates no Job for a signal already aborted', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', { job });

        await expect(m.runGate(KEY, 'test', 'npm test', { signal: AbortSignal.abort() })).rejects.toMatchObject({
            code: 125,
        });

        expect(calls.some((c) => c.method === 'POST' && c.path === jobsPath(namespace))).toBe(false);
    });

    // The api-server row is a verified bug (docs/plans/k8s-runner-prune.md Step 0): a transport
    // failure that exhausts the status-poll retries used to rethrow the raw error with no
    // CONTAINER_GONE code, while the 429/5xx exhaustion arm already wrapped it — so `gates.ts`'s
    // ad-hoc endpoint (which maps CONTAINER_GONE to 409) answered 500 for a kubernetes API-server
    // outage where docker answers 409 for the same harness failure.
    it.each<[string, () => K8sRequest]>([
        ['the cluster refuses the run', () => gateFake({ jobCreate: { status: 403, body: 'forbidden' } }).request],
        [
            'the api server cannot be reached at all',
            () => (method, path) => {
                if (path === `/api/v1/namespaces/${namespace}/secrets`) {
                    return Promise.resolve({ status: 201, body: '{}' });
                }
                if (path === jobsPath(namespace)) return Promise.resolve({ status: 201, body: '{}' });
                if (path.startsWith(`${jobsPath(namespace)}/`)) return Promise.reject(new Error('ECONNREFUSED'));
                return Promise.reject(new Error(`gate fake has no answer for ${method} ${path}`));
            },
        ],
    ])('rejects with the harness code when %s', async (_when, request) => {
        const m = manager(request());
        await m.acquire(KEY, 'node:24', '', { job });
        await expect(m.runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: 125 });
    });

    it('names an unpullable gate image instead of burning the deadline', async () => {
        const { request } = gateFake({
            job: { status: 200, body: '{"status":{}}' },
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: 'gate-pod' },
                            status: {
                                containerStatuses: [
                                    { state: { waiting: { reason: 'ImagePullBackOff', message: 'no such image' } } },
                                ],
                            },
                        },
                    ],
                }),
            },
        });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', { job });
        const error = await m.runGate(KEY, 'test', 'npm test').then(
            () => null,
            (e: Error) => e
        );
        expect((error as Error | null)?.message).toBe(
            'the gate image "node:24" cannot be pulled: ImagePullBackOff — no such image'
        );
        // The harness code, not a bare error: gates.ts maps CONTAINER_GONE to the endpoint's 409.
        expect((error as { code?: number } | null)?.code).toBe(125);
    });

    it('refuses a run whose attempt context was never acquired, like docker refuses a missing container', async () => {
        const { request } = gateFake();
        await expect(manager(request).runGate(KEY, 'test', 'npm test')).rejects.toMatchObject({ code: 125 });
    });

    it('validates the checkout key and image shapes at acquire, before anything runs', async () => {
        const { request } = gateFake();
        const m = manager(request);
        await expect(m.acquire('../other/repo', 'node:24', '', { job })).rejects.toThrow(/checkout key/);
        await expect(m.acquire(KEY, 'not an image!!', '', { job })).rejects.toThrow(/image reference/);
        await expect(m.acquire(KEY, 'node:24', '', { job })).resolves.toBeUndefined();
    });

    it('names the gate Job so two runs of one gate never collide', async () => {
        const { request, calls } = gateFake();
        const m = manager(request);
        await m.acquire(KEY, 'node:24', '', { job });
        await m.runGate(KEY, 'test', 'npm test');
        await m.runGate(KEY, 'test', 'npm test');
        const names = calls
            .filter((c) => c.method === 'POST' && c.path === jobsPath(namespace))
            .map((c) => (c.body as { metadata?: { name?: string } })?.metadata?.name);
        expect(names[0]).toMatch(GATE_JOB);
        expect(names[0]).not.toBe(names[1]);
    });

    // The close-of-run gates re-acquire before every run (the cooldown heal, issue #78), so a
    // re-acquire of the SAME attempt must not reset the run counter back onto a name a previous
    // run of that gate already used — the reaped Job can still exist when the create lands.
    // The re-acquire also re-POSTs the attempt's env Secret, answered 409 already-exists —
    // the tolerance the production re-acquire relies on.
    it('keeps the run counter across re-acquires of the same attempt, so a re-acquired run never reuses a name', async () => {
        const { request, calls } = gateFake({ secretCreate: { status: 409, body: '{}' } });
        const m = manager(request);
        await m.acquire(KEY, 'node:24', 'GATE_VAR=1', { job });
        await m.runGate(KEY, 'test', 'npm test');
        await m.acquire(KEY, 'node:24', 'GATE_VAR=1', { job });
        await m.runGate(KEY, 'test', 'npm test');
        const names = calls
            .filter((c) => c.method === 'POST' && c.path === jobsPath(namespace))
            .map((c) => (c.body as { metadata?: { name?: string } })?.metadata?.name);
        expect(names).toHaveLength(2);
        expect(names[0]).toMatch(GATE_JOB);
        expect(names[1]).toMatch(GATE_JOB);
        expect(names[0]).not.toBe(names[1]);
    });
});

// ==============================================================================================
// Auxiliary services under kubernetes: a pod per declared service, a headless Service as its DNS
// name, alive for exactly the attempt.
// ==============================================================================================

describe('the service pod and DNS specs', () => {
    const cache: ServiceSpec = {
        name: 'cache',
        image: 'redis',
        environment: [{ key: 'ALLOW_EMPTY_PASSWORD', value: 'yes' }],
    };

    it('runs the service as a never-restarted, token-less pod with the declared env as literals', () => {
        const pod = servicePodSpec(gatedConfig, job, cache, 'svc-uid');
        expect(pod.kind).toBe('Pod');
        expect(pod.metadata.name).toBe(`factory-job-${job.id}-${job.leaseToken}-svc-cache`);
        expect(pod.metadata.labels).toEqual({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
            'factory.service': 'cache',
            'factory.fleet': serviceSubdomain(job),
        });
        // The declared name is the pod's hostname under the attempt's subdomain — the DNS
        // record `cache` resolves to through the runner's search domain.
        expect(pod.spec.hostname).toBe('cache');
        expect(pod.spec.subdomain).toBe(serviceSubdomain(job));
        expect(pod.spec.restartPolicy).toBe('Never');
        expect(pod.spec.automountServiceAccountToken).toBe(false);
        expect(pod.spec.containers[0]!.image).toBe('redis');
        expect(pod.spec.containers[0]!.env).toEqual([{ name: 'ALLOW_EMPTY_PASSWORD', value: 'yes' }]);
    });

    // Issue #363: VPC CNI network-policy enforcement is "optimized for" pods carrying
    // metadata.ownerReferences and "might not work reliably" for standalone pods — and the
    // declared-service pod is the one driver-specced pod that is not a Job. It is owned by the
    // attempt's own headless DNS Service, created moments before, so every pod a .bellows.yaml
    // starts is a managed pod even where the CNI cares.
    it("owns the service pod by the attempt's DNS Service, so an enforcing CNI sees a managed pod", () => {
        const pod = servicePodSpec(gatedConfig, job, cache, 'svc-uid');
        expect(pod.metadata.ownerReferences).toEqual([
            {
                apiVersion: 'v1',
                kind: 'Service',
                name: serviceSubdomain(job),
                uid: 'svc-uid',
                blockOwnerDeletion: false,
                controller: false,
            },
        ]);
    });

    it('refuses an environment key that is not a variable name', () => {
        expect(() =>
            servicePodSpec(gatedConfig, job, { ...cache, environment: [{ key: 'not a key', value: 'x' }] }, 'svc-uid')
        ).toThrow(/not a valid environment variable name/);
    });

    it('names the DNS object for the attempt, never the declared name, headless, selecting only its fleet', () => {
        const dns = serviceDnsSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), job);
        expect(dns.kind).toBe('Service');
        expect(dns.metadata.name).toBe(serviceSubdomain(job));
        expect(dns.metadata.name).toMatch(/^factory-svc-[0-9a-f]{16}$/);
        expect(dns.metadata.labels).toMatchObject({ 'factory.lease': job.leaseToken });
        expect(dns.metadata.labels).toHaveProperty('factory.service');
        expect(dns.spec.clusterIP).toBe('None');
        expect(dns.spec.selector).toEqual({ 'factory.fleet': serviceSubdomain(job) });

        // Issue #301: the orphan reaper's scan pairs factory.job + factory.service with the
        // release label, so the Service must carry it exactly as the service pods do — without
        // it, a chart-deployed reaper could never see the fleets it exists to reap.
        const released = serviceDnsSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, K8S_RELEASE: 'factory' }),
            job
        );
        expect(released.metadata.labels['app.kubernetes.io/instance']).toBe('factory');
    });

    it('gives two concurrent attempts disjoint DNS names, so both can declare the same service', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        const other = { ...job, id: '22222222-2222-4222-8222-222222222222' };
        expect(serviceDnsSpec(config, other).metadata.name).not.toBe(serviceDnsSpec(config, job).metadata.name);
        const retry = { ...job, leaseToken: '33333333-3333-4333-8333-333333333333' };
        expect(serviceDnsSpec(config, retry).metadata.name).not.toBe(serviceDnsSpec(config, job).metadata.name);
    });

    it('puts the attempt search domain on the runner and gate pods, and only when services are on', () => {
        const searches = [`${serviceSubdomain(job)}.${namespace}.svc.cluster.local`];
        const on = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' });
        expect(fleetDnsField(on, job)).toEqual({ dnsConfig: { searches } });
        const session = { id: SESSION, resume: false };
        expect(runnerJobSpec(on, job, session).spec.template.spec.dnsConfig).toEqual({ searches });
        const gate = gateJobSpec(on, job, {
            key: `bellows/${USER}/.worktrees/55555555-5555-4555-8555-555555555555`,
            image: 'node:22',
            gateName: 'test',
            command: 'npm test',
            run: 1,
            envSecretName: null,
            gateTimeoutMs: 60_000,
        });
        expect(gate.spec.template.spec.dnsConfig).toEqual({ searches });

        const domain = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            K8S_CLUSTER_DOMAIN: 'corp.internal',
        });
        expect(fleetDnsField(domain, job).dnsConfig?.searches).toEqual([
            `${serviceSubdomain(job)}.${namespace}.svc.corp.internal`,
        ]);

        const off = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
        expect(runnerJobSpec(off, job, session).spec.template.spec).not.toHaveProperty('dnsConfig');
    });
});

/** The suite's job with no services on the claim, for the block below that shadows `job`. */
const baseJob = job;

describe('the kubernetes services flow', () => {
    // Issue #769: the services ride on the claim — this block's `job` declares the one `cache` service.
    const CACHE: ServiceSpec = {
        name: 'cache',
        image: 'redis',
        environment: [{ key: 'ALLOW_EMPTY_PASSWORD', value: 'yes' }],
    };
    const job: BoardJob = { ...baseJob, services: [CACHE] };
    // The declared fleet is process-wide and the suite runs isolate: false — a failed test must not leak it.
    afterEach(() => forgetDeclaredServices(job));
    /** A restart's stand-down signal that never fires. */
    const live = new AbortController().signal;
    const DNS_UID = '99999999-9999-4999-8999-999999999999';

    /** A fake that routes one full run with services: service objects, runner Job. */
    const servicesFake = (options: { dnsCreate?: K8sResponse } = {}) => {
        const calls: Call[] = [];
        const createdPods: { metadata: { labels: Record<string, string> }; spec: unknown }[] = [];
        const runningPod = (pod: (typeof createdPods)[number]) => ({ ...pod, status: { phase: 'Running' } });
        const serve = claimServer();
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) return Promise.resolve(claimAnswer);
            const respond = (r: K8sResponse) => Promise.resolve(r);
            const empty = { status: 200, body: '{"items":[]}' };
            if (path === jobsPath(namespace)) {
                // Every Job POST is accepted; nothing ever polls as failed.
                return respond({ status: 201, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) {
                // The fence's job list: nothing of this job's left to sweep.
                return respond(empty);
            }
            if (path.startsWith(`${jobsPath(namespace)}/`)) {
                return respond({ status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) });
            }
            if (path === `/api/v1/namespaces/${namespace}/services`) {
                return respond(
                    options.dnsCreate ?? { status: 201, body: JSON.stringify({ metadata: { uid: DNS_UID } }) }
                );
            }
            if (path.includes('pods?') && decodeURIComponent(path).includes('job-name=')) {
                return respond({
                    status: 200,
                    body: JSON.stringify({
                        items: [
                            {
                                metadata: { name: 'runner-pod' },
                                status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                            },
                        ],
                    }),
                });
            }
            if (path === `/api/v1/namespaces/${namespace}/pods/runner-pod/log`) {
                return respond({ status: 200, body: 'did the work\n' });
            }
            // The lease-scoped list the readiness wait polls: every pod this fake created, Running.
            if (method === 'GET' && path.includes('pods?') && decodeURIComponent(path).includes('factory.lease=')) {
                return respond({ status: 200, body: JSON.stringify({ items: createdPods.map(runningPod) }) });
            }
            if (path.includes('pods?') || path.includes('services?')) return respond(empty);
            if (path === `/api/v1/namespaces/${namespace}/pods`) {
                if (method === 'POST') createdPods.push(body as (typeof createdPods)[number]);
                return respond({ status: 201, body: '{}' });
            }
            if (path.includes('/secrets')) return respond({ status: 200, body: '{}' });
            if (path.startsWith('/api/v1/namespaces/factory/pods/')) return respond({ status: 200, body: '{}' });
            if (path.startsWith('/api/v1/namespaces/factory/services/')) return respond({ status: 200, body: '{}' });
            return Promise.reject(new Error(`services fake has no answer for ${method} ${path}`));
        };
        return { request, calls, pods: createdPods };
    };

    /**
     * The loop's order (PR 737): its setup phase starts the fleet — before the gate environment's
     * setup — and run() spawns the runner. A refused start ends there.
     */
    const asLoop = (runner: ReturnType<typeof createKubernetesRunner>): ReturnType<typeof createKubernetesRunner> => ({
        ...runner,
        run: async (j, session, onOutput) => (await runner.startServices(j)) ?? runner.run(j, session, onOutput),
    });
    const bareServicesRunner = (request: K8sRequest) =>
        supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' }),
            request,
            async () => {}
        );
    const servicesRunner = (request: K8sRequest) => asLoop(bareServicesRunner(request));

    it('starts the declared fleet before the runner and keeps it up until the loop releases it', async () => {
        const { request, calls } = servicesFake();
        const runner = servicesRunner(request);
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // The attempt's DNS name, then the service pod under it, and only then the runner Job —
        // docker's fleet-before-runner order. No readout Job runs before them.
        const podPost = calls.findIndex((c) => c.method === 'POST' && c.path?.endsWith('/pods'));
        const dnsPost = calls.findIndex((c) => c.method === 'POST' && c.path?.endsWith('/services'));
        const jobPost = calls.findIndex(
            (c) =>
                c.method === 'POST' &&
                c.path === jobsPath(namespace) &&
                (c.body as { metadata?: { name?: string } })?.metadata?.name === runnerJobName(job)
        );
        expect(dnsPost).toBeGreaterThanOrEqual(0);
        expect(podPost).toBeGreaterThan(dnsPost);
        expect(jobPost).toBeGreaterThan(podPost);
        expect((calls[dnsPost]!.body as { metadata: { name: string } }).metadata.name).toBe(serviceSubdomain(job));

        // The fleet OUTLIVES run(): the declared gates run after it and test against these
        // services, so run() ends with the claim's release (GET, DELETE) — no lease-scoped fleet
        // list, and no reap of the attempt's group or Secret, which serve the gates' steps.
        const leaseList = (c: Call) =>
            c.method === 'GET' &&
            (c.path?.includes(`pods?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`) ||
                c.path?.includes(`services?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`));
        expect(calls.slice(-2).map((c) => c.method)).toEqual(['GET', 'DELETE']);
        expect(calls.slice(jobPost).some(leaseList)).toBe(false);

        // The loop's release takes it down, by lease: the pods and the DNS objects.
        const releasedAt = calls.length;
        await runner.releaseServices(job);
        expect(calls.slice(releasedAt).filter(leaseList)).toHaveLength(2);
    });

    // Review: setup must not race a fleet still scheduling or pulling — the start answers only once
    // every service pod runs, and one that never does is a ServicesNotRunning, as in the restart.
    it('startServices answers only once every service pod runs', async () => {
        const { request } = servicesFake();
        let leaseLists = 0;
        const pending: K8sRequest = (method, path, body) => {
            const leaseList =
                method === 'GET' && path.includes('pods?') && decodeURIComponent(path).includes('factory.lease=');
            if (leaseList && leaseLists++ === 0) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        items: [
                            {
                                metadata: { name: 'p', labels: { 'factory.service': 'cache' } },
                                spec: { containers: [{ image: 'redis' }] },
                                status: { phase: 'Pending' },
                            },
                        ],
                    }),
                });
            }
            return request(method, path, body);
        };
        await expect(bareServicesRunner(pending).startServices(job)).resolves.toBeNull();
        expect(leaseLists).toBeGreaterThanOrEqual(2);
    });

    it('startServices rejects with ServicesNotRunning when a service pod fails', async () => {
        const { request } = servicesFake();
        const failing: K8sRequest = (method, path, body) =>
            method === 'GET' && path.includes('pods?') && decodeURIComponent(path).includes('factory.lease=')
                ? Promise.resolve({
                      status: 200,
                      body: JSON.stringify({
                          items: [
                              {
                                  metadata: { name: 'p', labels: { 'factory.service': 'cache' } },
                                  spec: { containers: [{ image: 'redis' }] },
                                  status: { phase: 'Failed' },
                              },
                          ],
                      }),
                  })
                : request(method, path, body);
        await expect(bareServicesRunner(failing).startServices(job)).rejects.toBeInstanceOf(ServicesNotRunning);
    });

    // Review (PR 737): the loop starts the fleet before the gate environment's setup, so run()
    // must neither start it again nor sweep it away.
    it("run() starts no fleet after the loop started it, and its sweep spares the attempt's own lease", async () => {
        const { request, calls } = servicesFake();
        const runner = bareServicesRunner(request);
        await expect(runner.startServices(job)).resolves.toBeNull();
        const startedAt = calls.length;
        await runner.run(job, { id: SESSION, resume: false });

        const during = calls.slice(startedAt);
        expect(during.some((c) => c.method === 'POST' && c.path?.endsWith('/pods'))).toBe(false);
        expect(during.some((c) => c.method === 'POST' && c.path?.endsWith('/services'))).toBe(false);
        const sweeps = during.filter(
            (c) => c.method === 'GET' && decodeURIComponent(c.path ?? '').includes(`factory.job=${job.id}`)
        );
        expect(sweeps.length).toBeGreaterThan(0);
        for (const sweep of sweeps) {
            expect(decodeURIComponent(sweep.path ?? '')).toContain(`factory.lease!=${job.leaseToken}`);
        }
    });

    // Issue #363: every service pod carries the attempt DNS Service as its ownerReference —
    // the uid can only come from the create response, so the flow must wire it through.
    it('wires the created DNS Service uid into every service pod as its owner', async () => {
        const { request, calls } = servicesFake();
        const runner = servicesRunner(request);
        await runner.run(job, { id: SESSION, resume: false });

        const podPosts = calls.filter((c) => c.method === 'POST' && c.path?.endsWith('/pods'));
        expect(podPosts.length).toBeGreaterThan(0);
        for (const post of podPosts) {
            expect((post.body as { metadata: { ownerReferences: unknown } }).metadata.ownerReferences).toEqual([
                {
                    apiVersion: 'v1',
                    kind: 'Service',
                    name: serviceSubdomain(job),
                    uid: DNS_UID,
                    blockOwnerDeletion: false,
                    controller: false,
                },
            ]);
        }
    });

    it('fails a DNS create that answers no uid as infrastructure, tearing the partial fleet down', async () => {
        const { request, calls } = servicesFake({ dnsCreate: { status: 201, body: '{}' } });
        // An apiserver always stamps a uid; an answer without one is a proxy or a fake lying —
        // and a pod created without its owner is exactly the standalone pod an enforcing CNI
        // may not confine. Fail loud, tear the partial fleet down, leave the job to its lease.
        await expect(servicesRunner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not start the service DNS name.*no uid/s
        );

        // The runner Job was never created — a failed start has no runner to orphan.
        expect(
            calls.some(
                (c) =>
                    c.method === 'POST' &&
                    c.path === jobsPath(namespace) &&
                    (c.body as { metadata?: { name?: string } })?.metadata?.name === runnerJobName(job)
            )
        ).toBe(false);
        // And the partial fleet was torn down on the way out: the lease lists ran (their empty
        // answers mean the fake had nothing left to delete).
        expect(
            calls.some(
                (c) =>
                    c.method === 'GET' &&
                    c.path?.includes(`pods?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`)
            )
        ).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'GET' &&
                    c.path?.includes(`services?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`)
            )
        ).toBe(true);
    });

    it('fails a DNS-name create as infrastructure, tearing the partial fleet down', async () => {
        const { request, calls } = servicesFake({ dnsCreate: { status: 500, body: '{"reason":"InternalError"}' } });
        await expect(servicesRunner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not start the service DNS name/
        );

        // The runner Job was never created — a failed start has no runner to orphan.
        expect(
            calls.some(
                (c) =>
                    c.method === 'POST' &&
                    c.path === jobsPath(namespace) &&
                    (c.body as { metadata?: { name?: string } })?.metadata?.name === runnerJobName(job)
            )
        ).toBe(false);
        // And the partial fleet was torn down on the way out: the lease lists ran (their empty
        // answers mean the fake had nothing left to delete).
        expect(
            calls.some(
                (c) =>
                    c.method === 'GET' &&
                    c.path?.includes(`pods?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`)
            )
        ).toBe(true);
        expect(
            calls.some(
                (c) =>
                    c.method === 'GET' &&
                    c.path?.includes(`services?labelSelector=${encodeURIComponent(`factory.lease=${job.leaseToken}`)}`)
            )
        ).toBe(true);
    });

    it('reports a declared service whose pod is gone from the lease list as dead (issue #471)', async () => {
        const { request, pods } = servicesFake();
        const runner = servicesRunner(request);
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        pods.length = 0; // the lease-scoped pod list answers empty from here: the pod is gone

        const dead = await runner.deadServices(job);
        expect(dead).toMatchObject([{ name: 'cache', state: 'missing', exitCode: null, logTail: '' }]);

        // The attempt's teardown ends the declaration: nothing is expected of a released fleet.
        await runner.releaseServices(job);
        expect(await runner.deadServices(job)).toEqual([]);
    });

    /** The fake with the lease-scoped service pod list answered by `servicePods`, everything else as before. */
    const withServicePods = (request: K8sRequest, servicePods: () => unknown[]): K8sRequest => {
        // Scripted once the runner Job exists: until then the fleet the start waits on is running.
        let launched = false;
        return (method, path, body) => {
            const scoped = decodeURIComponent(path ?? '');
            const named = (body as { metadata?: { name?: string } } | undefined)?.metadata?.name;
            if (method === 'POST' && path === jobsPath(namespace) && named === runnerJobName(job)) launched = true;
            if (
                launched &&
                method === 'GET' &&
                scoped.includes('/pods?') &&
                scoped.includes(`factory.lease=${job.leaseToken}`)
            ) {
                return Promise.resolve({ status: 200, body: JSON.stringify({ items: servicePods() }) });
            }
            return request(method, path, body);
        };
    };
    const cachePod = (phase: string) => ({
        metadata: { name: 'cache-pod', labels: { 'factory.service': 'cache' } },
        spec: { containers: [{ image: 'redis' }] },
        status: { phase },
    });

    it('names why a vanished service pod went, from its newest event (issue #560)', async () => {
        const { request, pods } = servicesFake();
        const events: K8sRequest = (method, path, body) =>
            path?.includes('/events?')
                ? Promise.resolve({
                      status: 200,
                      body: JSON.stringify({
                          items: [
                              { reason: 'Scheduled', message: 'assigned', lastTimestamp: '2026-10-08T13:44:28Z' },
                              // An events.k8s.io event: a MicroTime and no lastTimestamp — compared as an instant.
                              {
                                  reason: 'Evicted',
                                  message: 'The node was low on resource: memory.',
                                  eventTime: '2026-10-08T13:44:28.500000Z',
                              },
                              { reason: 'Pulled', message: 'pulled', lastTimestamp: '2026-10-08T13:00:05Z' },
                          ],
                      }),
                  })
                : request(method, path, body);
        const runner = servicesRunner(events);
        await runner.run(job, { id: SESSION, resume: false });
        pods.length = 0; // the pod vanishes from the lease list

        expect(await runner.deadServices(job)).toMatchObject([
            { name: 'cache', state: 'missing', reason: 'Evicted: The node was low on resource: memory.' },
        ]);

        await runner.releaseServices(job);
    });

    it('names a vanished service pod as deleted when its events cannot be read (issue #560)', async () => {
        const { request, pods } = servicesFake(); // no events route: the read throws
        const runner = servicesRunner(request);
        await runner.run(job, { id: SESSION, resume: false });
        pods.length = 0; // the pod vanishes from the lease list

        expect(await runner.deadServices(job)).toMatchObject([
            { name: 'cache', state: 'missing', reason: 'pod deleted — evicted, drained or its node removed' },
        ]);

        await runner.releaseServices(job);
    });

    it('restartServices recreates the vanished fleet and waits until it runs (issue #560)', async () => {
        const { request, calls } = servicesFake();
        let listed = (): unknown[] => [];
        let lists = 0;
        const fleet = withServicePods(request, () => {
            lists += 1;
            return listed();
        });
        let posted = 0;
        const runner = servicesRunner((method, path, body) => {
            if (method === 'POST' && path === `/api/v1/namespaces/${namespace}/pods`) posted += 1;
            return fleet(method, path, body);
        });
        await runner.run(job, { id: SESSION, resume: false });
        // Gone at the restart; the replacement listed Pending on its first poll, then Running.
        let polls = 0;
        const replaced = posted;
        listed = () => (posted === replaced ? [] : polls++ === 0 ? [cachePod('Pending')] : [cachePod('Running')]);
        const before = calls.length;

        await runner.restartServices(job, live);

        const after = calls.slice(before).filter((c) => c.method === 'POST');
        // The DNS name first, then the service pod under it — startFleet's order, again.
        expect(after.map((c) => c.path)).toEqual([
            `/api/v1/namespaces/${namespace}/services`,
            `/api/v1/namespaces/${namespace}/pods`,
        ]);
        expect(lists).toBeGreaterThan(1);
        expect(await runner.deadServices(job)).toEqual([]);

        await runner.releaseServices(job);
    });

    it('restartServices throws when the old fleet never leaves the listing (issue #560)', async () => {
        const { request } = servicesFake();
        const runner = servicesRunner(withServicePods(request, () => [cachePod('Failed')]));
        await runner.run(job, { id: SESSION, resume: false });

        await expect(runner.restartServices(job, live)).rejects.toThrow(
            'the old service fleet was still terminating 300s on'
        );

        await runner.releaseServices(job);
    });

    it('restartServices throws naming the service that stays pending (issue #560)', async () => {
        const { request } = servicesFake();
        let posted = false;
        const fleet = withServicePods(request, () => (posted ? [cachePod('Pending')] : []));
        const runner = servicesRunner((method, path, body) => {
            if (method === 'POST' && path === `/api/v1/namespaces/${namespace}/pods`) posted = true;
            return fleet(method, path, body);
        });
        await runner.run(job, { id: SESSION, resume: false });
        posted = false;

        await expect(runner.restartServices(job, live)).rejects.toThrow(
            'service "cache" not running 300s after the restart'
        );

        await runner.releaseServices(job);
    });

    it('restartServices spends one timeout across the teardown and readiness waits (issue #560)', async () => {
        const { request } = servicesFake();
        let posted = false;
        let oldLists = 0;
        // The old pod leaves the listing on its fourth poll; the replacement never runs.
        const fleet = withServicePods(request, () => {
            if (posted) return [cachePod('Pending')];
            oldLists += 1;
            return oldLists > 3 ? [] : [cachePod('Failed')];
        });
        let slept = 0;
        const runner = asLoop(
            supervisedRunner(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' }),
                (method, path, body) => {
                    if (method === 'POST' && path === `/api/v1/namespaces/${namespace}/pods`) posted = true;
                    return fleet(method, path, body);
                },
                async (ms) => {
                    slept += ms;
                }
            )
        );
        await runner.run(job, { id: SESSION, resume: false });
        posted = false;
        oldLists = 0;
        slept = 0;

        await expect(runner.restartServices(job, live)).rejects.toThrow(
            'service "cache" not running 300s after the restart'
        );
        expect(slept).toBe(300_000);

        await runner.releaseServices(job);
    });

    it('restartServices fails at once on a replacement stuck on an unpullable image (issue #560)', async () => {
        const { request } = servicesFake();
        let posted = false;
        let lists = 0;
        const stuck = {
            ...cachePod('Pending'),
            status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ErrImagePull' } } }] },
        };
        const fleet = withServicePods(request, () => {
            if (posted) lists += 1;
            return posted ? [stuck] : [];
        });
        const runner = servicesRunner((method, path, body) => {
            if (method === 'POST' && path === `/api/v1/namespaces/${namespace}/pods`) posted = true;
            return fleet(method, path, body);
        });
        await runner.run(job, { id: SESSION, resume: false });
        posted = false;

        await expect(runner.restartServices(job, live)).rejects.toThrow('service "cache" failed after the restart');
        expect(lists).toBe(1);
    });

    it('restartServices names a lease listing that keeps failing, not a fleet still terminating (issue #560)', async () => {
        const { request } = servicesFake();
        let restarting = false;
        const runner = servicesRunner((method, path, body) => {
            const scoped = decodeURIComponent(path ?? '');
            if (restarting && method === 'GET' && scoped.includes(`factory.lease=${job.leaseToken}`)) {
                return Promise.reject(new Error('the API server is away'));
            }
            return request(method, path, body);
        });
        await runner.run(job, { id: SESSION, resume: false });
        restarting = true;

        await expect(runner.restartServices(job, live)).rejects.toThrow(
            'the old service fleet could not be listed 300s on: the API server is away'
        );
    });

    it('restartServices stops on a stand-down and takes the fleet it started down again (issue #560)', async () => {
        const { request, calls } = servicesFake();
        const stand = new AbortController();
        let posted = false;
        const fleet = withServicePods(request, () => {
            // The replacement is up but Pending when the Stop lands.
            if (posted) stand.abort();
            return posted ? [cachePod('Pending')] : [];
        });
        const runner = servicesRunner((method, path, body) => {
            if (method === 'POST' && path === `/api/v1/namespaces/${namespace}/pods`) posted = true;
            return fleet(method, path, body);
        });
        await runner.run(job, { id: SESSION, resume: false });
        posted = false;
        const before = calls.length;

        await expect(runner.restartServices(job, stand.signal)).rejects.toThrow(
            'the restart was abandoned: the attempt stood down'
        );
        // Swept again after the abort: the lease lists run once more after the pod create.
        const after = calls.slice(before);
        const create = after.findIndex((c) => c.method === 'POST' && c.path === `/api/v1/namespaces/${namespace}/pods`);
        expect(after.slice(create).some((c) => c.method === 'GET' && c.path?.includes('services?labelSelector='))).toBe(
            true
        );
        expect(await runner.deadServices(job)).toEqual([]);
    });

    it("reports a runner pod deleted mid-run as an infrastructure loss, not the agent's verdict (issue #560)", async () => {
        const { request } = servicesFake();
        const lost: K8sRequest = (method, path, body) => {
            const decoded = decodeURIComponent(path ?? '');
            if (method === 'GET' && path === `${jobsPath(namespace)}/${runnerJobName(job)}`) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        status: {
                            failed: 1,
                            conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }],
                        },
                    }),
                });
            }
            if (method === 'GET' && decoded.includes(`job-name=${runnerJobName(job)}`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            return request(method, path, body);
        };

        const runner = servicesRunner(lost);
        const outcome = await runner.run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({
            exitCode: null,
            started: true,
            infraLoss: 'the runner pod was deleted before it exited (evicted, drained or its node removed)',
        });

        await runner.releaseServices(job);
    });

    // Issue #769: the fleet is exactly the claim's services — nothing is read from a checkout.
    const podsPosted = (calls: Call[]) =>
        calls
            .filter((c) => c.method === 'POST' && c.path === `/api/v1/namespaces/${namespace}/pods`)
            .map((c) => c.body as ReturnType<typeof servicePodSpec>);
    const jobPosts = (calls: Call[]) =>
        calls
            .filter((c) => c.method === 'POST' && c.path === jobsPath(namespace))
            .map((c) => (c.body as { metadata: { name: string } }).metadata.name);

    it('starts every service the claim carries, a declared port changing no pod spec', async () => {
        const planned: BoardJob = {
            ...baseJob,
            services: [
                { name: 'postgres', image: 'postgres:1', environment: [], ports: [5432], user: { uid: 999, gid: 999 } },
                { name: 'redis', image: 'redis:1', environment: [] },
            ],
        };
        const { request, calls } = servicesFake();
        const outcome = await servicesRunner(request).run(planned, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        const pods = podsPosted(calls);
        const byImage = new Map(pods.map((p) => [p.spec.containers[0]!.image, p.spec.containers[0]!]));
        expect([...byImage.keys()].sort()).toEqual(['postgres:1', 'redis:1']);
        expect(byImage.get('postgres:1')!.securityContext).toMatchObject({ runAsUser: 999, runAsGroup: 999 });
        expect(byImage.get('redis:1')!.securityContext?.runAsUser).toBeUndefined();
        expect(JSON.stringify(pods)).not.toContain('5432');
        await servicesRunner(request).releaseServices(planned);
    });

    it('posts no readout Job: only the runner Job, the service pod and its DNS Service', async () => {
        const { request, calls } = servicesFake();
        await bareServicesRunner(request).startServices(job);

        expect(jobPosts(calls)).toEqual([]);
        expect(podsPosted(calls)).toHaveLength(1);
        expect(calls.filter((c) => c.method === 'POST' && c.path?.endsWith('/services'))).toHaveLength(1);
        await bareServicesRunner(request).releaseServices(job);
    });

    it('starts no pod and creates no DNS Service when the claim carries no services', async () => {
        const { request, calls } = servicesFake();
        const outcome = await servicesRunner(request).run(baseJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        expect(podsPosted(calls)).toEqual([]);
        expect(calls.some((c) => c.method === 'POST' && c.path?.endsWith('/services'))).toBe(false);
        expect(jobPosts(calls)).toContain(runnerJobName(baseJob));
        expect(jobPosts(calls).some((name) => name.startsWith('factory-bellows-'))).toBe(false);
    });
});

/**
 * An opencode-selected task under EXECUTOR=kubernetes: the same `run [--session <id>] <command>` argv
 * the docker runner composes, a session database persisted on the PVC, and the close-time
 * session scrape as an aux Job. The spec tests pin the shapes; the runner tests pin that the
 * scrape rides the run's outcome the way docker's verdict does.
 */
describe("scoping the kubernetes mounts to the job's own subtree", () => {
    // Every volumeMount this executor emits names the job's own `<orgId>/<userId>` subtree as
    // its subPath. That is what makes a missing target fail loud — the kubelet cannot start a
    // pod whose subPath does not exist and leaves it stuck in ContainerCreating — and what
    // makes a broader fallback mount structurally impossible: there is no spec shape here that
    // mounts the workspaces PVC without a subPath.
    // The supervisor runs the attempt's steps (the sync, the publish) on the task worktree (issue
    // #771), so it mounts the member's workspace — at the member's subtree like every other pod.
    it.each(JOB_POD_NAMES)(
        'mounts nothing broader than the member subtree on %s — it names the exact target',
        (name) => {
            const { pod } = everyPodSpec({ RUNNER_SERVICES: '0' })[name]();
            const mount = pod.containers[0]!.volumeMounts?.find((m) => m.name === 'workspaces');
            expect(mount?.subPath).toBe(`bellows/${USER}`);
            expect(mount?.subPath?.split('/').length).toBe(2);
        }
    );

    // A claim whose workspace path fails the segment assertions is refused before any pod spec
    // exists — the mount can never name a path the assertions did not clear.
    it.each(JOB_POD_NAMES.filter((name) => name !== 'the gate'))(
        'refuses to build %s for a claim with a malformed workspace path',
        (name) => {
            const build = everyPodSpec({ RUNNER_SERVICES: '0' }, { ...job, workspacePath: '../../etc' })[name];
            expect(build).toThrow(/workspace path/);
        }
    );
});

describe('the runner job spec under opencode', () => {
    const ocConfig = loadDriverConfig({
        EXECUTOR: 'kubernetes',
        K8S_NAMESPACE: namespace,
        RUNNER_SERVICES: '0',
    });

    // The plan is pinned in runner-plan.test.ts; this is the kubernetes rendering of opencode's:
    // the CLI args as the container's args, the env pairs as literal values, never a secretKeyRef.
    it('restores a follow-up session with run --session, the id the CLI itself minted', () => {
        const spec = runnerJobSpec(ocConfig, { ...opencodeJob, followUp: true }, { id: 'ses_abc123', resume: true });
        const container = spec.spec.template.spec.containers[0]!;
        expect(container.args).toEqual([
            'run',
            '--agent',
            'factory',
            '--session',
            'ses_abc123',
            'fix the failing build',
        ]);
        expect(container.env).toContainEqual({
            name: 'XDG_DATA_HOME',
            value: `/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}`,
        });
        expect(container.env).toContainEqual({ name: 'BELLOWS_SESSION_ID', value: 'ses_abc123' });
        expect(container.env).toContainEqual({ name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' });
    });
});

describe('the opencode session readout job', () => {
    const config = loadDriverConfig({
        EXECUTOR: 'kubernetes',
        K8S_NAMESPACE: namespace,
        RUNNER_SERVICES: '0',
    });

    it('runs the readout script by content, with the database path as an env value', () => {
        const spec = opencodeReadoutJobSpec(config, job, START);
        const container = spec.spec.template.spec.containers[0]!;
        expect(spec.metadata.name).toBe(opencodeReadoutJobName(job));
        expect(spec.metadata.name).toMatch(/^factory-ocread-/);
        expect(container.command).toEqual(['node', '-e', expect.stringContaining('node:sqlite')]);
        expect(container.env).toEqual([
            {
                name: 'OPENCODE_DB',
                value: `/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            },
            {
                // The scope: only the session that ran in this job's working directory — the
                // member root here, since the fixture names no repo. The session database is per
                // member, and without the scope two concurrent tasks scrape each other's runs.
                name: 'OPENCODE_DIR',
                value: `/workspaces/bellows/${USER}`,
            },
            { name: 'RUN_STARTED_MS', value: String(Date.parse(START)) },
            { name: 'EXPORT_LIMIT_BYTES', value: String(OPENCODE_EXPORT_LIMIT) },
        ]);
    });

    it('scopes the readout to the task worktree when the job names a repo', () => {
        const spec = opencodeReadoutJobSpec(config, { ...job, repo: 'Bellows-AI/factory' }, START);
        expect(spec.spec.template.spec.containers[0]!.env).toContainEqual({
            name: 'OPENCODE_DIR',
            value: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        });
    });

    it('mounts the workspaces volume READ-WRITE: a WAL needing recovery has to write it', () => {
        const spec = opencodeReadoutJobSpec(config, job, START);
        expect(spec.spec.template.spec.containers[0]!.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
        ]);
        expect(spec.spec.template.spec.containers[0]!.volumeMounts[0]!.readOnly).toBeUndefined();
    });

    it('refuses a job whose workspace path it cannot assert', () => {
        expect(() => opencodeReadoutJobSpec(config, { ...job, workspacePath: null }, START)).toThrow(/workspace path/);
    });
});

describe('the close-time claude-code turn read under kubernetes', () => {
    /**
     * The twin of docker's close-time read (executor parity): the same script, the same env
     * VALUES, one aux Job over the PVC instead of one throwaway container. The failure path —
     * the Job refused, deadlined, or answering nothing parseable — is exercised by every
     * runner test above, whose scripted logs parse as null: unmeasured, never zero.
     */
    const spec = claudeTurnsJobSpec(
        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
        job,
        SESSION,
        START
    );

    it('runs the static script as one aux Job, its inputs by env', () => {
        const container = spec.spec.template.spec.containers[0]!;
        expect(spec.metadata.name).toBe(claudeTurnsJobName(job));
        expect(spec.metadata.name).toMatch(/^factory-cturns-/);
        expect(container.command).toEqual(['node', '-e', claudeTurnsScript]);
        expect(container.env).toEqual([
            {
                name: 'CLAUDE_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'CLAUDE_SESSION_ID', value: SESSION },
            // The per-run delta bound: the transcript carries earlier runs' turns too.
            { name: 'RUN_STARTED_AT', value: START },
        ]);
        expect(container.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
        ]);
    });

    it('refuses a session id that is not a uuid', () => {
        expect(() =>
            claudeTurnsJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
                job,
                'not-a-uuid',
                START
            )
        ).toThrow(/not a session id/);
    });
});

describe('the transcript artifact Jobs under kubernetes (issue #325)', () => {
    /**
     * The twins of the two readout Jobs above (executor parity): the same aux-Job shape, the
     * same env-VALUES rule, exporting the run's transcript instead of counting it. Names are
     * distinct from the turns Jobs' — the hash key is the same (job, lease) pair, and one
     * attempt's transcript Job and its turn Job must not collide.
     */
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });

    it('claude: the exporter is a container of the run’s pod with the control pair by Secret reference, never a value', () => {
        const spec = runnerJobSpec(config, { ...job, ...SUPERVISED }, { id: SESSION, resume: false }, START);
        const container = spec.spec.template.spec.containers.find((c) => c.name === EXPORTER_CONTAINER)!;
        expect(container.command).toEqual(['node', '-e', claudeExportScript]);
        expect(container.env).toContainEqual({
            name: 'CLAUDE_TRANSCRIPT_DIR',
            value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
        });
        expect(container.env).toContainEqual({ name: 'RUN_STARTED_AT', value: START });
        expect(container.env).toContainEqual({ name: 'FACTORY_EXPORT_DIR', value: '/factory/export' });
        expect(container.env).toContainEqual({
            name: 'BELLOWS_CONTROL_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'SUPERVISOR_CONTROL_TOKEN' } },
        });
        expect(JSON.stringify(spec)).not.toMatch(/"value":"[^"]*tok-/);
        // The member's subtree and the one mailbox it shares with the supervisor — nothing else.
        expect(container.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
            { name: 'ctl-export', mountPath: '/factory/export' },
        ]);
    });

    it('opencode: exports through the readout Job, not a Job of its own', () => {
        const spec = opencodeReadoutJobSpec(config, job, START);
        const container = spec.spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'EXPORT_LIMIT_BYTES', value: String(OPENCODE_EXPORT_LIMIT) });
        expect(container.env).toContainEqual({
            name: 'OPENCODE_DB',
            value: `/workspaces/bellows/${USER}/.factory/opencode/${job.id}/opencode/opencode.db`,
        });
    });
});

describe('the kubernetes runner under opencode', () => {
    const ocreadName = opencodeReadoutJobName(job);
    const ocreadPod = `${ocreadName}-pod`;
    const ns = `/api/v1/namespaces/${namespace}`;

    const ok = (body: unknown) => Promise.resolve({ status: 200, body: JSON.stringify(body) });

    /**
     * A router scripted for one opencode run: the runner Job goes terminal succeeded, the
     * close-time readout Job runs and answers `readoutLog`. Every claim and teardown route
     * answers the boring way. The calls list is the audit.
     */
    const opencodeFake = (readout: { status?: 'failed'; log?: string; truncated?: true } = {}) => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (path === configmapsPath && method === 'POST') return Promise.resolve({ status: 201, body: '{}' });
            if (path === claimPathFor(job.id) && method === 'GET') {
                return ok({
                    metadata: { uid: 'u1' },
                    data: { holder: job.leaseToken, claimSeq: String(job.claimSeq) },
                });
            }
            if (path === claimPathFor(job.id) && method === 'DELETE') {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) return ok({ items: [] });
            if (path.startsWith(`${ns}/pods?`) && decodeURIComponent(path).includes('factory.job=')) {
                return ok({ items: [] });
            }
            if (path.startsWith(`${ns}/services?`) || path.startsWith(`${ns}/services/`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (path === jobsPath(namespace) && method === 'POST') {
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (path === jobPath(namespace, runnerJobName(job))) {
                return ok({ status: { succeeded: 1 } });
            }
            if (path === jobPath(namespace, ocreadName)) {
                return ok(readout.status === 'failed' ? { status: { failed: 1 } } : { status: { succeeded: 1 } });
            }
            if (path.startsWith(`${ns}/pods?`) && decodeURIComponent(path).includes(`job-name=${runnerJobName(job)}`)) {
                return ok({
                    items: [
                        {
                            metadata: { name: podName },
                            status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
                        },
                    ],
                });
            }
            if (path.startsWith(`${ns}/pods?`) && decodeURIComponent(path).includes(`job-name=${ocreadName}`)) {
                return ok({ items: [{ metadata: { name: ocreadPod } }] });
            }
            if (path === `${ns}/pods/${podName}/log`) return Promise.resolve({ status: 200, body: 'did the work\n' });
            if (path === `${ns}/pods/${ocreadPod}/log`) {
                return Promise.resolve({
                    status: 200,
                    body: readout.log ?? '',
                    ...(readout.truncated ? { truncated: readout.truncated } : {}),
                });
            }
            // The per-attempt Secret (the runner's attempt pair), created and reaped per attempt.
            if (path === `${ns}/secrets`) {
                if (method === 'DELETE') return Promise.resolve({ status: 200, body: '{}' });
                return Promise.resolve({ status: 201, body: '{}' });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        return { request, calls };
    };

    const ocRunner = (request: K8sRequest) =>
        supervisedRunner(
            loadDriverConfig({
                EXECUTOR: 'kubernetes',
                K8S_NAMESPACE: namespace,
                RUNNER_SERVICES: '0',
            }),
            request,
            async () => {}
        );

    it('flags the transcript a cut readout log lost its head of (#825)', async () => {
        const normalized = JSON.stringify({ stream: 'normalized', event: { n: 2 } });
        const { request } = opencodeFake({
            log: ['t":{"n":1}}', normalized, JSON.stringify({ id: 'ses_n3w' })].join('\n'),
            truncated: true,
        });

        const outcome = await ocRunner(request).run(opencodeJob, null);

        expect(outcome.transcript).toBe(normalized);
        expect(outcome.transcriptTruncated).toBe(true);
    });

    it('scrapes the session the run minted, and rides it on the outcome', async () => {
        const { request, calls } = opencodeFake({
            log: JSON.stringify({
                id: 'ses_n3w',
                finish: 'stop',
                tokens: 4321,
                cost: 0.12,
                turns: 9,
                summary: 'Fixed the flaky test',
            }),
        });
        const outcome = await ocRunner(request).run(opencodeJob, null);

        expect(outcome.sessionId).toBe('ses_n3w');
        expect(outcome.finishReason).toBe('stop');
        expect(outcome.contextTokens).toBe(4321);
        expect(outcome.costUsd).toBeCloseTo(0.12);
        // The turn count and the summary ride the same readout line, merged onto the outcome
        // exactly as the docker runner merges them (executor parity — the turn merge was once
        // missing here and opencode runs under this executor lost their count).
        expect(outcome.agentTurns).toBe(9);
        expect(outcome.summary).toBe('Fixed the flaky test');
        expect(outcome.readoutError).toBeUndefined();
        expect(outcome.exitCode).toBe(0);
        expect(outcome.started).toBe(true);

        // The readout Job was created, read, and reaped — after the runner Job existed.
        const created = calls.findIndex(
            (c) => c.method === 'POST' && (c.body as { metadata?: { name?: string } })?.metadata?.name === ocreadName
        );
        const deleted = calls.findIndex(
            (c) => c.method === 'DELETE' && c.path?.startsWith(jobPath(namespace, ocreadName))
        );
        expect(created).toBeGreaterThan(0);
        expect(deleted).toBeGreaterThan(created);
    });

    it('fails no verdict when the scrape cannot run: the error rides readoutError instead', async () => {
        const { request, calls } = opencodeFake({ status: 'failed' });
        const outcome = await ocRunner(request).run(opencodeJob, null);

        // The run's own verdict is untouched; only the follow-up-ability was lost, said out loud.
        expect(outcome.exitCode).toBe(0);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toContain('the session readout job failed');
        // Retried to the end before giving up: three attempts, every one a POST of the readout.
        const scrapePosts = calls.filter(
            (c) => c.method === 'POST' && (c.body as { metadata?: { name?: string } })?.metadata?.name === ocreadName
        );
        expect(scrapePosts.length).toBe(3);
    });

    // The readout poll can now THROW (poll exhaustion is infrastructure, never a verdict) — and
    // the scrape wraps that throw, because a completed run's verdict must never burn over its
    // close-time read.
    it('fails no verdict when the readout poll exhausts: the error rides readoutError instead', async () => {
        const base = opencodeFake();
        const request: K8sRequest = (method, path, body) =>
            path === jobPath(namespace, ocreadName)
                ? Promise.resolve({ status: 400, body: '400 Bad Request' })
                : base.request(method, path, body);
        const outcome = await ocRunner(request).run(opencodeJob, null);

        expect(outcome.exitCode).toBe(0);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toContain('in a row');
    });

    // The same guard one level down: a TRANSPORT rejection — the readout Job POST itself failing,
    // on the kind of connection the issue's 400s live on — is also the read's failure, never the
    // run's. (The runner Job's own POST rejecting is different: that run never started, and its
    // throw is what hands the job back to its lease.)
    it('fails no verdict when the readout Job POST rejects: the error rides readoutError instead', async () => {
        const base = opencodeFake();
        const request: K8sRequest = (method, path, body) =>
            method === 'POST' &&
            path === jobsPath(namespace) &&
            (body as { metadata?: { name?: string } })?.metadata?.name === ocreadName
                ? Promise.reject(new Error('the apiserver closed the connection'))
                : base.request(method, path, body);
        const outcome = await ocRunner(request).run(opencodeJob, null);

        expect(outcome.exitCode).toBe(0);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toContain('the apiserver closed the connection');
    });

    it('scrapes nothing for a claude-code run, whose session is known at spawn', async () => {
        const { request, calls } = opencodeFake({ log: 'irrelevant' });
        await runner(request).run(job, { id: SESSION, resume: false });
        expect(calls.some((c) => decodeURIComponent(c.path ?? '').includes('ocread'))).toBe(false);
        expect(
            calls.some(
                (c) =>
                    c.method === 'POST' &&
                    (c.body as { metadata?: { name?: string } })?.metadata?.name?.startsWith('factory-ocread-')
            )
        ).toBe(false);
    });
});

describe('the block-helper transport (issue #207)', () => {
    const NOOP_DESCRIPTOR = lookupHelper('noop')!;
    const NOOP_VERDICT = JSON.stringify({ schema: 'helper-noop/v1', version: 1, ok: true, output: { echoed: true } });
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 'claim-token' } };
    const WT = `/workspaces/bellows/${USER}/.worktrees/${job.id}`;
    const plan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: { a: 1 },
        githubWriting: false,
        ...over,
    });
    const secretsPathFor = `/api/v1/namespaces/${namespace}/secrets`;
    const helperStepsOf = (steps: { submitted: StepRequest[] }) =>
        steps.submitted.filter((step) => step.kind === 'helper');
    const answering = () => fakeSteps((step) => (step.kind === 'helper' ? stepOk(NOOP_VERDICT) : stepOk()));

    // Since #771 a helper is a step of the attempt's supervisor: the content-passed script, the
    // literal bounded input and the task worktree are the step's, not a Job spec's.
    it('submits one helper step: content-passed script, literal bounded input, task worktree', async () => {
        const steps = answering();
        await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper!(repoJob, plan());
        const [step] = helperStepsOf(steps);
        expect(step).toMatchObject({
            kind: 'helper',
            argv: ['node', '-e', NOOP_DESCRIPTOR.scriptBody],
            cwd: WT,
            env: { HELPER_INPUT: JSON.stringify({ a: 1 }) },
        });
        expect(steps.tokens).toEqual(new Set([CONTROL_TOKEN]));

        // A command-only job (no repo): no working directory, the member root's own mount.
        const bare = answering();
        await runner(fakeRequest().request, {}, undefined, bare.sink).runHelper!(job, plan());
        expect(helperStepsOf(bare)[0]!.cwd).toBeUndefined();
    });

    it('gives a read-only helper no claim env, and a github-writing one the fresh token over the claim env', async () => {
        const readOnly = answering();
        await runner(fakeRequest().request, {}, undefined, readOnly.sink).runHelper!(repoJob, plan());
        expect(helperStepsOf(readOnly)[0]!.env).toEqual({ HELPER_INPUT: JSON.stringify({ a: 1 }) });

        const writing = answering();
        await runner(fakeRequest().request, {}, undefined, writing.sink).runHelper!(
            repoJob,
            plan({ githubWriting: true }),
            'fresh-install-token'
        );
        expect(helperStepsOf(writing)[0]!.env).toMatchObject({ GITHUB_TOKEN: 'fresh-install-token' });
        expect(JSON.stringify(helperStepsOf(writing)[0]!.env)).not.toContain('claim-token');
    });

    it('fails an unknown helper id before any step is submitted', async () => {
        const steps = answering();
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper!(
            job,
            plan({ helperId: 'not-a-real-helper' })
        );
        expect(result).toEqual({
            ok: false,
            reason: 'unknown_helper',
            message: expect.stringContaining('not-a-real-helper'),
        });
        expect(helperStepsOf(steps)).toEqual([]);
    });

    it('runs the noop helper end to end as a step, creating no Job or Secret of its own', async () => {
        const steps = answering();
        const { request, calls } = fakeRequest();
        const result = await runner(request, {}, undefined, steps.sink).runHelper!(job, plan());
        expect(result).toEqual({ ok: true, output: { echoed: true } });
        // The attempt had no group (an adopted run): one supervisor-only group, and nothing per helper.
        const created = calls.filter((c) => c.method === 'POST' && c.path === jobsPath(namespace));
        expect(created.map((c) => (c.body as { metadata: { name: string } }).metadata.name)).toEqual([
            runnerJobName(job),
        ]);
        expect(
            (created[0]!.body as ReturnType<typeof runnerJobSpec>).spec.template.spec.containers.map((c) => c.name)
        ).toEqual([SUPERVISOR_CONTAINER]);
        expect(calls.filter((c) => c.method === 'POST' && c.path === secretsPathFor)).toHaveLength(1);
    });

    it('ends a cancelled helper without submitting it when the stand-down signal is already aborted (issue #488)', async () => {
        const steps = answering();
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper!(
            repoJob,
            plan({ githubWriting: true }),
            'fresh-install-token',
            AbortSignal.abort()
        );
        expect(result).toEqual({ ok: false, reason: 'runner_error', message: expect.stringContaining('cancelled') });
        expect(helperStepsOf(steps)).toEqual([]);
    });

    it('never puts the fresh token in a Job, a Secret or any request body — only in the step', async () => {
        const steps = answering();
        const { request, calls } = fakeRequest();
        await runner(request, {}, undefined, steps.sink).runHelper!(
            repoJob,
            plan({ githubWriting: true }),
            'super-secret-token'
        );
        expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('super-secret-token');
        expect(helperStepsOf(steps)[0]!.env.GITHUB_TOKEN).toBe('super-secret-token');
    });

    it('mints a fresh step identity on every call, even for the identical plan run twice in a row', async () => {
        const steps = answering();
        const r = runner(fakeRequest().request, {}, undefined, steps.sink);
        await r.runHelper!(job, plan());
        await r.runHelper!(job, plan());
        const ids = helperStepsOf(steps).map((step) => step.id);
        expect(ids).toHaveLength(2);
        expect(ids[0]).not.toBe(ids[1]);
    });

    it('reports a named timeout failure when the supervisor ends the step at its bound', async () => {
        const steps = fakeSteps(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper!(job, plan());
        expect(result).toEqual({ ok: false, reason: 'timeout', message: expect.any(String) });
    });

    it('reports runner_error for an ordinary non-zero exit, distinct from a timeout', async () => {
        const steps = fakeSteps(() => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }));
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper!(job, plan());
        expect(result).toEqual({ ok: false, reason: 'runner_error', message: expect.stringContaining('boom') });
    });

    it('reports runner_error for a step channel that fails, never letting it escape as an exception', async () => {
        const steps = fakeSteps(() => {
            throw new Error('the step channel connection reset');
        });
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper!(job, plan());
        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('connection reset'),
        });
    });
});

// A private registry is the normal case in a cluster, and every pod this driver specs pulls on its
// own: the runner, each aux Job (sync shown — they all share `auxJobSpec`) and each service pod.
describe('RUNNER_IMAGE_PULL_SECRETS', () => {
    it.each(POD_NAMES)('names every configured secret on %s', (name) => {
        const { pod } = everyPodSpec({ RUNNER_IMAGE_PULL_SECRETS: 'regcred, mirror ,' })[name]();
        expect(pod.imagePullSecrets).toEqual([{ name: 'regcred' }, { name: 'mirror' }]);
    });

    it.each(POD_NAMES)('leaves the field off %s entirely when none are configured', (name) => {
        expect(everyPodSpec()[name]().pod).not.toHaveProperty('imagePullSecrets');
    });
});

// Issue #361: the chart's scheduling knobs reach the chart's own pods only; these are the runner
// group's — the tainted node group agent-written code is meant to land on and nothing else. Every
// pod the driver specs carries them: the runner, each aux Job and each service pod, exactly as
// RUNNER_IMAGE_PULL_SECRETS above does.
describe('RUNNER NODE SELECTOR / TOLERATIONS / AFFINITY', () => {
    const scheduled = {
        RUNNER_NODE_SELECTOR: '{"dedicated":"factory-runners"}',
        RUNNER_TOLERATIONS: '[{"key":"dedicated","operator":"Equal","value":"factory-runners","effect":"NoSchedule"}]',
        RUNNER_AFFINITY:
            '{"podAntiAffinity":{"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":1,"podAffinityTerm":{"topologyKey":"topology.kubernetes.io/zone","labelSelector":{"matchLabels":{"app.kubernetes.io/name":"factory"}}}}]}}',
    };

    it.each(POD_NAMES)('schedules %s onto the configured node group', (name) => {
        const { pod } = everyPodSpec(scheduled)[name]();
        expect(pod.nodeSelector).toEqual({ dedicated: 'factory-runners' });
        expect(pod.tolerations).toEqual([
            { key: 'dedicated', operator: 'Equal', value: 'factory-runners', effect: 'NoSchedule' },
        ]);
        expect(pod.affinity).toMatchObject({ podAntiAffinity: expect.anything() });
    });

    it.each(POD_NAMES)('leaves the fields off %s entirely when none are configured', (name) => {
        const { pod } = everyPodSpec()[name]();
        expect(pod).not.toHaveProperty('nodeSelector');
        expect(pod).not.toHaveProperty('tolerations');
        expect(pod).not.toHaveProperty('affinity');
    });
});

// The chart's runner NetworkPolicy selects by release, so every pod the driver specs must carry
// the release label — not only the runner Job object, which is what bulk cleanup reads.
describe('K8S_RELEASE on pod templates', () => {
    it.each(POD_NAMES)('labels %s with the release', (name) => {
        expect(everyPodSpec({ K8S_RELEASE: 'dev' })[name]().meta.labels).toMatchObject({
            'app.kubernetes.io/instance': 'dev',
        });
    });
});

// Karpenter consolidation or a cluster-autoscaler scale-down voluntarily evicts a running runner
// pod mid-job (issue #362): nothing is corrupted — the lease expires, the board re-offers — but
// the work is redone, silently, visible only as a higher `attempts`. RUNNER_DO_NOT_DISRUPT is the
// opt-out from that voluntary disruption, and both annotation keys travel together: Karpenter
// reads the first, the cluster-autoscaler the second, and they are one switch. It is not a shield
// against everything: a Spot interruption or an external drain (a managed-nodegroup upgrade,
// kubectl drain) reclaims the pod regardless. Every pod the driver specs carries the annotations —
// a declared service's eviction ruins the attempt exactly like the runner's does.
describe('RUNNER_DO_NOT_DISRUPT on pod templates', () => {
    const ANNOTATIONS = {
        'karpenter.sh/do-not-disrupt': 'true',
        'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
    };

    // The annotations name the POD: Job specs carry them on the pod template (Karpenter reads
    // pods, not Job objects); the bare service Pod carries them on its own metadata.
    it.each(POD_NAMES)('annotates %s', (name) => {
        expect(everyPodSpec({ RUNNER_DO_NOT_DISRUPT: '1' })[name]().meta.annotations).toEqual(ANNOTATIONS);
    });

    // Annotating the Job object itself would be cargo cult — Karpenter reads pods. (The runner Job
    // carries its adoption marks, issue #792, and nothing of the disruption opt-out.)
    it.each(JOB_POD_NAMES)('leaves the Job object of %s without the disruption annotations', (name) => {
        const { job: jobObject } = everyPodSpec({ RUNNER_DO_NOT_DISRUPT: '1' })[name]();
        const annotations = (jobObject as { metadata: { annotations?: Record<string, string> } }).metadata.annotations;
        for (const key of Object.keys(ANNOTATIONS)) expect(annotations?.[key]).toBeUndefined();
    });

    it.each(POD_NAMES)('leaves the annotations off %s entirely when the switch is unset', (name) => {
        expect(everyPodSpec()[name]().meta).not.toHaveProperty('annotations');
    });
});

describe('the paused deadline for an agent question', () => {
    it('removes the deadline while waiting and restores it with the actual elapsed wait', async () => {
        const spec: { activeDeadlineSeconds: number | null } = { activeDeadlineSeconds: 7200 };
        const annotations: Record<string, string | null> = {};
        const patches: unknown[] = [];
        const request: K8sRequest = async (method, _path, body) => {
            if (method === 'PATCH') {
                const patch = body as { spec: typeof spec; metadata: { annotations: typeof annotations } };
                Object.assign(spec, patch.spec);
                Object.assign(annotations, patch.metadata.annotations);
                patches.push(body);
            }
            return { status: 200, body: JSON.stringify({ spec, metadata: { annotations } }) };
        };
        const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            const r = runner(request);
            await Promise.all([r.pauseDeadline?.(job, true), r.pauseDeadline?.(job, true)]);
            expect(spec.activeDeadlineSeconds).toBeNull();
            expect(patches).toHaveLength(1);
            now.mockReturnValue(1000 + 48 * 3600 * 1000);
            await r.pauseDeadline?.(job, false);
            expect(spec.activeDeadlineSeconds).toBe(7200 + 48 * 3600);
            await r.pauseDeadline?.(job, false);
            expect(patches).toHaveLength(2);
        } finally {
            now.mockRestore();
        }
    });

    it('does nothing when the runner Job is gone', async () => {
        const request = vi.fn(async () => ({ status: 404, body: '{}' }));
        await runner(request).pauseDeadline?.(job, true);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects a refused pause so it can be retried', async () => {
        const request: K8sRequest = async (method) =>
            method === 'PATCH'
                ? { status: 403, body: '{}' }
                : { status: 200, body: JSON.stringify({ spec: { activeDeadlineSeconds: 60 } }) };
        await expect(runner(request).pauseDeadline?.(job, true)).rejects.toThrow(/pausing or resuming/);
    });
});

describe('a Stop on kubernetes (issue #427)', () => {
    it('a Stop mid-run resolves run() as a killed outcome, as docker does', async () => {
        const base = fakeRequest({ job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) } });
        let deleted = false;
        let r: ReturnType<typeof runner> | null = null;
        const request: K8sRequest = (method, path, body) => {
            if (path.startsWith(jobPath(namespace, runnerJobName(job)))) {
                if (method === 'DELETE') {
                    deleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                if (method === 'GET') {
                    // The heartbeat's Stop lands while the run is polling: the loop calls kill().
                    if (!deleted) void r?.kill(job);
                    if (deleted) return Promise.resolve({ status: 404, body: '{"kind":"Status"}' });
                }
            }
            return base.request(method, path, body);
        };
        r = runner(request);
        // Expected for parity with docker (whose killed container resolves exit 137): an outcome
        // the loop's stopped path can park. Observed: a rejection, which the loop treats as
        // "could not run, leaving it to the lease" — no session report, no artifacts, no suspend.
        await expect(r.run(job, { id: SESSION, resume: false })).resolves.toMatchObject({ started: true });
    });

    // U2: on Stop the loop's raceStep abandons a pre-helper and the heartbeat calls kill(job),
    // which deletes the runner Job and the services only. The helper's aux Job is deleted in
    // runHelper's finally, i.e. only once helperVerdict returns — the Job runs to completion.
    it('a Stop (kill) during a pre-helper deletes its aux Job promptly', async () => {
        const base = fakeRequest();
        const helperJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
        let helperName: string | null = null;
        let helperDeleted = false;
        let finished = false;
        const request: K8sRequest = (method, path, body) => {
            if (method === 'POST' && path === jobsPath(namespace) && helperName === null) {
                helperName = (body as { metadata: { name: string } }).metadata.name;
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (helperName !== null && path.startsWith(jobPath(namespace, helperName))) {
                if (method === 'DELETE') {
                    helperDeleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                // The helper is still running: pending on every poll, answered as a macrotask.
                const answer = finished
                    ? { status: 404, body: '{"kind":"Status"}' }
                    : { status: 200, body: JSON.stringify({ status: { active: 1 } }) };
                return new Promise((resolve) => setTimeout(() => resolve(answer), 1));
            }
            return base.request(method, path, body);
        };
        const r = runner(request);
        const helperPlan: HelperPlan = { helperId: 'noop', phase: 'pre', input: null, githubWriting: true };
        const running = r.runHelper!(helperJob, helperPlan, 'ghs_fresh');
        try {
            while (helperName === null) await new Promise((resolve) => setTimeout(resolve, 1));
            await r.kill(helperJob); // the heartbeat's Stop
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(helperDeleted).toBe(true);
        } finally {
            finished = true;
            await running;
        }
    });
});

describe('runnerLossOf (issue #560)', () => {
    const exited = (exitCode: number) => ({
        metadata: { name: 'runner-pod' },
        status: { phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode } } }] },
    });

    it('is no loss when the live pod says the agent ended the run', () => {
        expect(runnerLossOf([exited(1)])).toBeNull();
    });

    it('names a pod the kubelet evicted, in its own words', () => {
        expect(
            runnerLossOf([
                { ...exited(137), status: { ...exited(137).status, reason: 'Evicted', message: 'low on memory' } },
            ])
        ).toBe('the runner pod was taken away before it exited (Evicted: low on memory)');
    });

    it('names a pod the control plane marked a disruption target', () => {
        const pod = {
            ...exited(137),
            status: {
                ...exited(137).status,
                conditions: [
                    {
                        type: 'DisruptionTarget',
                        status: 'True',
                        reason: 'DeletionByTaintManager',
                        message: 'node removed',
                    },
                ],
            },
        };
        expect(runnerLossOf([pod])).toBe(
            'the runner pod was taken away before it exited (DeletionByTaintManager: node removed)'
        );
    });

    it('names a runner with no live pod left as deleted', () => {
        expect(runnerLossOf([])).toBe(
            'the runner pod was deleted before it exited (evicted, drained or its node removed)'
        );
        expect(runnerLossOf([{ ...exited(137), metadata: { name: 'p', deletionTimestamp: 'now' } }])).toBe(
            'the runner pod was deleted before it exited (evicted, drained or its node removed)'
        );
    });
});

/*
 * Issue #792: a runner that outlived its driver. The claim that superseded it finds it by the job
 * label, and a FINISHED one is read — verdict, log, session — before anything of it is deleted;
 * the run is never redone. A runner still running, or one the platform took away, is not adopted.
 */
describe('adopting a finished runner of an earlier claim (#792)', () => {
    const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
    const priorName = runnerJobName(job);
    const priorItem = (status: Record<string, unknown>, seq = '1', name = priorName, lease = job.leaseToken) => ({
        metadata: {
            name,
            labels: { 'factory.job': job.id, 'factory.lease': lease },
            annotations: {
                'factory.claim-seq': seq,
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        status: { startTime: START, ...status },
    });

    const nameOf = (item: unknown): string => (item as { metadata: { name: string } }).metadata.name;
    /** A fake whose runner-Job listing answers `items`, each until its Job is deleted. */
    const withRunners = (items: unknown[], overrides: Record<string, unknown> = {}) => {
        let listed = items;
        return routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            const name =
                method === 'DELETE' ? listed.map(nameOf).find((n) => path.startsWith(jobPath(namespace, n))) : null;
            if (name) {
                listed = listed.filter((item) => nameOf(item) !== name);
                return { status: 200, body: '{}' };
            }
        }, overrides);
    };

    it('reads its verdict, log and session before deleting it, and holds the checkout', async () => {
        const { request, calls } = withRunners([priorItem({ succeeded: 1 })]);

        const adopted = await runner(request).adopt!(adopter);

        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, timedOut: false, sessionId: SESSION },
        });
        expect(adopted!.outcome.output).toContain('did the work');
        const logRead = calls.findIndex((call) =>
            call.path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)
        );
        const deleted = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName))
        );
        expect(logRead).toBeGreaterThanOrEqual(0);
        expect(deleted).toBeGreaterThan(logRead);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
    });

    // Issue #796: a run read but never swept is no adoption — the claim goes back, the Job stays.
    it('rejects and gives the checkout back when the read run cannot be swept', async () => {
        const { request: base, calls } = withRunners([priorItem({ succeeded: 1 })]);
        const priorDelete = (method: K8sMethod, path: string) =>
            method === 'DELETE' && path.startsWith(jobPath(namespace, priorName));
        const request: K8sRequest = (method, path, body) =>
            priorDelete(method, path)
                ? Promise.resolve({ status: 503, body: 'unavailable' })
                : base(method, path, body);

        await expect(runner(request).adopt!(adopter)).rejects.toThrow(/503/);

        expect(calls.some((call) => call.path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`))).toBe(
            true
        );
        const held = await request('GET', claimPathFor(job.id));
        expect(held.status).toBe(404);
        const listed = await request('GET', `${jobsPath(namespace)}?labelSelector=factory.job%3D${job.id}`);
        expect(JSON.parse(listed.body).items.map(nameOf)).toEqual([priorName]);
    });

    it('adopts the newest of two finished runners by claim sequence', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const { request } = withRunners([
            priorItem({ succeeded: 1 }, '3'),
            priorItem({ succeeded: 1 }, '1', runnerJobName({ ...job, leaseToken: OLDER }), OLDER),
        ]);

        expect((await runner(request).adopt!({ ...adopter, claimSeq: 4 }))?.claimSeq).toBe(3);
    });

    it("adopts the earlier runner's whole log, not a line tail (#825)", async () => {
        const whole = numberedLines(LOG_TAIL_LINES + 500);
        const { request: base } = withRunners([priorItem({ succeeded: 1 })]);
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && isAgentLogRead(path)
                ? Promise.resolve(kubeletLog(whole)(path))
                : base(method, path, body);

        const adopted = await runner(request).adopt!(adopter);

        expect(adopted?.outcome).toMatchObject({ fullLog: whole, logTruncated: false });
    });

    // Failure injection at the transport boundary: a runner-Job list too big for a log's stream
    // buffer is still one whole answer — never a cut body that parses as "no earlier runner".
    it('adopts the earlier runner when its Job list outgrows a pod log stream buffer (#825)', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const HEAD_PAD = 1_000;
        const padded = (item: ReturnType<typeof priorItem>, pad: number) => ({
            ...item,
            metadata: { ...item.metadata, annotations: { ...item.metadata.annotations, pad: 'p'.repeat(pad) } },
        });
        // A body cut to its head and tail would read the finished runner's name and claim sequence
        // with the still-running older runner's status — a runner never adopted.
        const { request } = withRunners([
            padded(priorItem({ succeeded: 1 }), HEAD_PAD),
            padded(priorItem({ active: 1 }, '0', runnerJobName({ ...job, leaseToken: OLDER }), OLDER), ARTIFACT_LIMIT),
        ]);

        const adopted = await runner(throughTransport(request)).adopt!(adopter);

        expect(adopted?.claimSeq).toBe(1);
    });

    // A runner marked at or after this claim's sequence is a newer contender's, never an earlier one.
    it('never adopts a runner of a claim at or after its own', async () => {
        const { request } = withRunners([priorItem({ succeeded: 1 }, '2')]);
        expect(await runner(request).adopt!(adopter)).toBeNull();
    });

    it('never adopts a runner that is still running, and deletes nothing', async () => {
        const { request, calls } = withRunners([priorItem({ active: 1 })]);

        expect(await runner(request).adopt!(adopter)).toBeNull();
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === configmapsPath)).toBe(false);
    });

    it('never adopts a runner the platform took away, leaving it to the launch sweep', async () => {
        const { request, calls } = withRunners([priorItem({ failed: 1 })], {
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [{ metadata: { name: podName, deletionTimestamp: 'now' }, status: {} }],
                }),
            },
        });

        expect(await runner(request).adopt!(adopter)).toBeNull();
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(held.status).toBe(404);
    });

    // A regression guard: the group's agent never ran, so its completed-looking end is no run to adopt.
    it('never adopts a group whose supervisor lost its driver before the agent was released', async () => {
        const { request, calls } = withRunners([priorItem({ failed: 1 })], {
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: 'agent', state: { terminated: { exitCode: 0 } } },
                                    { name: 'supervisor', state: { terminated: { exitCode: SUPERVISOR_EXIT.lost } } },
                                ],
                            },
                        },
                    ],
                }),
            },
        });

        expect(await runner(request).adopt!(adopter)).toBeNull();
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // A queued task's command can be edited after a handover: a run of the old command is not its run.
    it('never adopts a run of a command since edited', async () => {
        const { request } = withRunners([priorItem({ succeeded: 1 })]);
        expect(await runner(request).adopt!({ ...adopter, command: 'another command' })).toBeNull();
    });

    it('answers null when this job has no earlier runner', async () => {
        const { request } = withRunners([]);
        expect(await runner(request).adopt!(adopter)).toBeNull();
    });

    it('marks every runner Job with its claim sequence and session, for the next claim to read', () => {
        expect(spec().metadata.annotations).toEqual({
            'factory.claim-seq': '1',
            'factory.session': SESSION,
            'factory.command': commandMark(job.command),
        });
    });
});

describe('the bound a runner pod outlives a lost driver by', () => {
    it('is a quarter of the lease, clamped to [30 s, 90 s], so the group ends inside the lost driver’s lease', () => {
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '120' }))).toBe(30_000);
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '300' }))).toBe(75_000);
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '3600' }))).toBe(90_000);
    });

    it('reaches the supervisor as its orphan bound and the exporter as its drain give-up', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_LEASE_SECONDS: '120' });
        const bound = String(orphanBoundMs(config));
        const pod = runnerJobSpec(
            config,
            { ...job, executorType: 'claude-code', ...SUPERVISED },
            { id: SESSION, resume: false }
        ).spec.template.spec;
        const envOf = (name: string) => pod.containers.find((container) => container.name === name)?.env;
        expect(envOf(SUPERVISOR_CONTAINER)).toContainEqual({ name: 'SUPERVISOR_ORPHAN_MS', value: bound });
        expect(envOf(EXPORTER_CONTAINER)).toContainEqual({ name: 'EXPORT_DRAIN_GIVEUP_MS', value: bound });
    });
});
