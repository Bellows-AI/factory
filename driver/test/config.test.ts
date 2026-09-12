import { describe, expect, it } from 'vitest';
import { gateAdvertiseUrlFor, loadDriverConfig } from '../src/config.js';

describe('the driver config', () => {
    it('runs on defaults, so a driver next to the dashboard needs no environment at all', () => {
        const config = loadDriverConfig({});

        expect(config).toMatchObject({
            boardUrl: 'http://127.0.0.1:8080',
            // No orgId. It only ever built the runner's WORKDIR, and the board sends that path now.
            image: 'claude-executor',
            workspaceVolume: 'factory-ai_workspaces',
            workspaceMount: '/workspaces',
            network: null,
            concurrency: 2,
            pollMs: 5_000,
            leaseSeconds: 300,
            jobTimeoutMs: 7_200_000,
            skipPermissions: false,
            remoteControl: false,
            idleMs: 3_600_000,
            authVolume: 'claude-executor-auth',
        });
        expect(config.passEnv).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    });

    it('trims the trailing slash, so a board url pastes in either form', () => {
        expect(loadDriverConfig({ JOB_BOARD_URL: 'http://dashboard:8080/' }).boardUrl).toBe(
            'http://dashboard:8080',
        );
    });

    it.each([
        ['JOB_BOARD_URL', { JOB_BOARD_URL: 'dashboard:8080' }],
        ['DRIVER_CONCURRENCY', { DRIVER_CONCURRENCY: '0' }],
        ['DRIVER_CONCURRENCY', { DRIVER_CONCURRENCY: '2.5' }],
        ['DRIVER_POLL_MS', { DRIVER_POLL_MS: '10' }],
        ['DRIVER_LEASE_SECONDS', { DRIVER_LEASE_SECONDS: '5' }],
        ['DRIVER_JOB_TIMEOUT_MS', { DRIVER_JOB_TIMEOUT_MS: 'soon' }],
    ])('refuses a bad %s rather than falling back to the default', (label, env) => {
        expect(() => loadDriverConfig(env)).toThrow(label);
    });

    // The switch that decides whether an agent may edit and run things unsupervised. A typo in it
    // must not read as "on".
    it('treats only an explicit value as permission to skip permissions', () => {
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: '1' }).skipPermissions).toBe(true);
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: '0' }).skipPermissions).toBe(false);
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: 'false' }).skipPermissions).toBe(false);
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: '' }).skipPermissions).toBe(false);
    });

    // Turning this on stops a job being run-to-completion: the container lives until the session is
    // ended or the timeout kills it. A typo must not read as "on".
    it('treats only an explicit value as a request for Remote Control', () => {
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '1' }).remoteControl).toBe(true);
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '0' }).remoteControl).toBe(false);
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: 'false' }).remoteControl).toBe(false);
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '' }).remoteControl).toBe(false);
    });

    it('reads RUNNER_ENV as a list of names', () => {
        expect(loadDriverConfig({ RUNNER_ENV: 'A, B ,,C' }).passEnv).toEqual(['A', 'B', 'C']);
    });

    // The executor choice is a runner selection, not a tuning knob: docker on the host, kubernetes
    // against the API server the driver's own pod talks to. A typo in it must not read as "docker
    // is fine" and silently spawn nothing — hence a fatal, explicit enum.
    it('defaults EXECUTOR to docker', () => {
        expect(loadDriverConfig({}).executor).toBe('docker');
        expect(loadDriverConfig({ EXECUTOR: 'kubernetes' }).executor).toBe('kubernetes');
    });

    it('refuses an unknown EXECUTOR rather than falling back to docker', () => {
        for (const executor of ['k8s', 'KUBERNETES', 'kube']) {
            expect(() => loadDriverConfig({ EXECUTOR: executor }), `"${executor}"`).toThrow(/EXECUTOR/);
        }
        // Empty means unset, as it does for every other variable here — the default, not a refusal.
        expect(loadDriverConfig({ EXECUTOR: '' }).executor).toBe('docker');
    });

    it('defaults K8S_NAMESPACE to default', () => {
        expect(loadDriverConfig({}).k8sNamespace).toBe('default');
        expect(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory' }).k8sNamespace).toBe('factory');
    });

    // RUNNER_OTEL_ENDPOINT defaults to the compose collector exactly like the compose driver service
    // sets it, so the endpoint is always provided to the runner — a pod that keeps a baked default
    // (http://collector:4318) resolves nothing on kubernetes, and "ensure telemetry reaches the
    // collector" cannot both run every job and opt out of naming it. The override wins, for a
    // collector the compose network cannot name.
    it('defaults RUNNER_OTEL_ENDPOINT to the compose collector, overridable', () => {
        expect(loadDriverConfig({}).otelEndpoint).toBe('http://collector:4318');
        expect(loadDriverConfig({ RUNNER_OTEL_ENDPOINT: '' }).otelEndpoint).toBe('http://collector:4318');
        expect(
            loadDriverConfig({ EXECUTOR: 'kubernetes', RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' })
                .otelEndpoint,
        ).toBe('http://telemetry.internal:4318');
    });

    // The branch reporter posts to the board's own API. Defaulting it to JOB_BOARD_URL means a
    // compose or chart driver needs zero configuration — the runner can already reach the board,
    // which is what JOB_BOARD_URL is for. The override is for the split topology (host driver,
    // containerized runners) where only a host-gateway address reaches the API.
    it('defaults RUNNER_STATS_URL to the board url, overridable', () => {
        expect(loadDriverConfig({}).statsUrl).toBe('http://127.0.0.1:8080');
        expect(loadDriverConfig({ JOB_BOARD_URL: 'http://dashboard:8080/' }).statsUrl).toBe(
            'http://dashboard:8080',
        );
        expect(loadDriverConfig({ RUNNER_STATS_URL: 'http://stats.internal:8080' }).statsUrl).toBe(
            'http://stats.internal:8080',
        );
        // The reporter concatenates request paths onto this string — a trailing slash would 404
        // every report into the silence its error handling promises.
        expect(loadDriverConfig({ RUNNER_STATS_URL: 'http://stats.internal:8080/' }).statsUrl).toBe(
            'http://stats.internal:8080',
        );
        // Same scheme rule as JOB_BOARD_URL: a URL without a scheme parses as a path, and a
        // reporter pointed at a path posts nowhere, silently.
        expect(() => loadDriverConfig({ RUNNER_STATS_URL: 'stats:8080' })).toThrow(/RUNNER_STATS_URL/);
    });

    // The credential the reporter presents to the board's ingest route. A value, not a name list
    // like RUNNER_ENV: there is exactly one consumer. Empty is unset, so compose can pass it
    // through unconditionally.
    it('takes RUNNER_INGEST_TOKEN trimmed, empty meaning unset', () => {
        expect(loadDriverConfig({}).ingestToken).toBe('');
        expect(loadDriverConfig({ RUNNER_INGEST_TOKEN: '  tok  ' }).ingestToken).toBe('tok');
        expect(loadDriverConfig({ RUNNER_INGEST_TOKEN: '' }).ingestToken).toBe('');
    });

    // The kubernetes executor forwards runner credentials the way the docker one forwards `-e NAME`:
    // the NAMES travel, the values live in a Secret the cluster already holds. Off unless named.
    it('leaves RUNNER_CREDENTIALS_SECRET off unless set', () => {
        expect(loadDriverConfig({}).credentialsSecret).toBeNull();
        expect(
            loadDriverConfig({ EXECUTOR: 'kubernetes', RUNNER_CREDENTIALS_SECRET: 'claude-credentials' })
                .credentialsSecret,
        ).toBe('claude-credentials');
    });

    // An explicit enum, like EXECUTOR: the API server would reject a bad policy only at
    // job-create time, which is attempt-burning — this loader exists to move failures to startup.
    it('accepts only a real image pull policy', () => {
        expect(loadDriverConfig({}).imagePullPolicy).toBe('IfNotPresent');
        expect(loadDriverConfig({ RUNNER_IMAGE_PULL_POLICY: 'Always' }).imagePullPolicy).toBe('Always');
        expect(() => loadDriverConfig({ RUNNER_IMAGE_PULL_POLICY: 'ifnotpresent' })).toThrow(
            /RUNNER_IMAGE_PULL_POLICY/,
        );
        expect(() => loadDriverConfig({ RUNNER_IMAGE_PULL_POLICY: 'sometimes' })).toThrow(
            /RUNNER_IMAGE_PULL_POLICY/,
        );
    });

    /**
     * Remote Control needs a tty held open, a login volume and an idle-parking loop — three things
     * that are decided in docker terms inside the docker runner and have no k8s counterpart yet.
     * A config that half-works is worse than one that refuses to start: the session would run and
     * simply never appear at claude.ai/code.
     */
    it('refuses Remote Control under the kubernetes executor', () => {
        expect(() => loadDriverConfig({ EXECUTOR: 'kubernetes', RUNNER_REMOTE_CONTROL: '1' })).toThrow(
            /RUNNER_REMOTE_CONTROL.*EXECUTOR|EXECUTOR.*RUNNER_REMOTE_CONTROL/s,
        );
        // And the same combination is fine under docker, which is the only executor that has it.
        expect(() => loadDriverConfig({ RUNNER_REMOTE_CONTROL: '1' })).not.toThrow();
    });

    // The gate environment cooldown: how long a container outlives the task that started it, so
    // the task's NEXT turn does not pay startup again. The issue names ten minutes as the default.
    it('keeps gate environments alive for a configurable cooldown, ten minutes by default', () => {
        expect(loadDriverConfig({}).gateCooldownMs).toBe(600_000);
        expect(loadDriverConfig({ GATE_COOLDOWN_MS: '0' }).gateCooldownMs).toBe(0);
        expect(loadDriverConfig({ GATE_COOLDOWN_MS: '60000' }).gateCooldownMs).toBe(60_000);
        expect(() => loadDriverConfig({ GATE_COOLDOWN_MS: '-1' })).toThrow(/GATE_COOLDOWN_MS/);
        expect(() => loadDriverConfig({ GATE_COOLDOWN_MS: 'later' })).toThrow(/GATE_COOLDOWN_MS/);
    });

    // The ad-hoc gate channel binds loopback by default — the dashboard's rule: the bind address
    // is the access control, and this endpoint runs shell commands.
    it('binds the gate server to loopback unless told otherwise, and advertises nowhere by default', () => {
        expect(loadDriverConfig({}).gateListenHost).toBe('127.0.0.1');
        expect(loadDriverConfig({ GATE_LISTEN_HOST: '0.0.0.0' }).gateListenHost).toBe('0.0.0.0');
        expect(loadDriverConfig({}).gateAdvertiseUrl).toBeNull();
        expect(loadDriverConfig({ GATE_ADVERTISE_URL: 'http://driver:9099' }).gateAdvertiseUrl).toBe(
            'http://driver:9099',
        );
    });

    // The listener binds an ephemeral port, so a configured URL without one cannot name it in
    // advance — the bound port is appended. One with a port is the operator's word and stays.
    it('appends the bound port to a portless advertise URL and leaves a ported one verbatim', () => {
        expect(gateAdvertiseUrlFor(null, 44_685)).toBe('http://host.docker.internal:44685');
        expect(gateAdvertiseUrlFor('http://driver', 44_685)).toBe('http://driver:44685');
        expect(gateAdvertiseUrlFor('http://driver:9099', 44_685)).toBe('http://driver:9099');
        // Agents concatenate request paths onto this string, so no trailing slash may survive.
        expect(gateAdvertiseUrlFor('http://driver/', 44_685)).toBe('http://driver:44685');
        // An unparseable URL is passed through: the failure stays at the fetch, unchanged.
        expect(gateAdvertiseUrlFor('not a url', 44_685)).toBe('not a url');
    });

    // The cap on ONE gate: the runner's timeout covers the agent, this covers a gate that hangs.
    // A timed-out gate is a failed gate, not a stalled verdict.
    it('bounds each gate with a configurable timeout, ten minutes by default', () => {
        expect(loadDriverConfig({}).gateTimeoutMs).toBe(600_000);
        expect(loadDriverConfig({ GATE_TIMEOUT_MS: '30000' }).gateTimeoutMs).toBe(30_000);
        expect(() => loadDriverConfig({ GATE_TIMEOUT_MS: '500' })).toThrow(/GATE_TIMEOUT_MS/);
        expect(() => loadDriverConfig({ GATE_TIMEOUT_MS: 'whenever' })).toThrow(/GATE_TIMEOUT_MS/);
    });
});
