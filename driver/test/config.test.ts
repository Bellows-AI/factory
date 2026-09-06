import { describe, expect, it } from 'vitest';
import { loadDriverConfig } from '../src/config.js';

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
            jobTimeoutMs: 1_800_000,
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
});
