/**
 * The driver's configuration, read from the environment only.
 *
 * No shared config with the server: that process carries a GitHub App private key and describes a
 * dashboard. This one runs somewhere else — on the host, or in a container holding the docker
 * socket — and the two have nothing in common at all: the board tells this process which
 * workspace a job belongs to, so it does not even need to know the organization.
 */
export interface DriverConfig {
    /** Where the board is. The driver is a client of it, never of the database. */
    boardUrl: string;
    /**
     * The worker token the board authenticates this process by, or '' against an open board.
     *
     * Environment only — there is no config file here, and a credential that decides whether a
     * process may run shell commands does not belong on a command line. It is also what tells the
     * board which organization this driver works for, which is why it is minted per organization by
     * `npm run worker-token` rather than shared between deployments.
     */
    boardToken: string;
    /** Names this driver on every claim, so a stuck job can be traced back to a process. */
    worker: string;
    /*
     * `orgId` used to live here, and its only job was building the runner's WORKDIR as
     * `<workspaceMount>/<orgId>`. The board sends `workspacePath` on the claim now — it owns the
     * layout, because it is what created the directory — so this process builds nothing and no
     * longer has to be told which organization it is working for. The worker token already says
     * that, and said it more reliably.
     */
    image: string;
    /**
     * Which CLI the runner image speaks: claude-code's `--session-id <uuid>` / `-p <prompt>` form,
     * or opencode's headless `run <prompt>` form. The union is COPIED, not imported from core's
     * EXECUTOR_TYPES: this package depends on nothing, deliberately (see AGENTS.md), and one string
     * union does not change that.
     */
    cli: 'claude-code' | 'opencode';
    /**
     * The docker volume holding the checkouts — a NAME, not a host path. The dashboard writes them
     * into a named volume precisely so no host directory is involved, and a runner spawned from
     * inside a container could not resolve a host path anyway.
     */
    workspaceVolume: string;
    /** Where that volume is mounted inside the runner. */
    workspaceMount: string;
    /**
     * Where a runner's telemetry is pointed, as `OTEL_EXPORTER_OTLP_ENDPOINT`. Defaults to
     * `http://collector:4318` when `RUNNER_OTEL_ENDPOINT` is not set, so the endpoint is always
     * provided to the runner container.
     *
     * The docker runner forwards the env var and the kubernetes runner names it in the pod spec.
     * Both executors are pointed at the collector this way, regardless of whether the compose
     * network is available. The image's baked default also resolves on the compose network, but a
     * kubernetes runner has no network to join and would silently drop telemetry without this.
     */
    otelEndpoint: string;
    /**
     * Where the runner's branch reporter posts its `session -> (repo, branch)` samples: the
     * board's own base URL, because `/api/sessions/branch` is a board route and the runner's
     * OTLP metrics carry a session id and nothing else — attribution needs this side channel.
     * Defaults to JOB_BOARD_URL (validated identically): on compose and in the chart the runner
     * can already reach the board, so zero configuration is the common case. RUNNER_STATS_URL
     * overrides it for a split topology the default cannot name — and where it cannot reach the
     * board, the reporter's reports silently no-op, exactly as its other failures do.
     */
    statsUrl: string;
    /**
     * The board's optional ingest token, forwarded so the reporter's reports authenticate on a
     * board that requires one. Empty forwards nothing. A credential: it travels the env file
     * (docker) or the per-attempt Secret (kubernetes), never an argv — and never under Remote
     * Control, where no forwarded credential of any kind rides (docs/jobs.md).
     */
    ingestToken: string;
    /** Joins the runner to a docker network, which is what lets its telemetry reach the collector. */
    network: string | null;
    concurrency: number;
    pollMs: number;
    leaseSeconds: number;
    /**
     * The wall-clock cap on a headless run. **Not armed under Remote Control**, where idleMs is the
     * bound instead: an interactive session has no meaningful total duration — being driven for
     * three hours is the feature — and arming both would mean the shorter one always won, killing a
     * drivable job before it could ever be parked.
     */
    jobTimeoutMs: number;
    /**
     * Appends --dangerously-skip-permissions. Off by default and deliberately a separate switch: a
     * headless agent cannot answer a permission prompt, so without it most useful jobs stall until
     * the timeout — and with it the agent edits and runs whatever it likes inside the container.
     * Making that a decision someone types is the whole point.
     */
    skipPermissions: boolean;
    /**
     * Runs the job as an interactive Remote Control session instead of a headless `-p` prompt, so it
     * can be driven from claude.ai/code and the mobile app.
     *
     * This changes what a job is. An interactive session does not end when the agent stops talking,
     * so the container lives until somebody ends the session or idleMs parks it, and a drivable job
     * holds its worker slot for that whole time. Off by default for that reason.
     */
    remoteControl: boolean;
    /**
     * How long a Remote Control runner may produce nothing before it is parked. Silence is the
     * signal because it is the one the driver already has: it reads every chunk the container
     * writes, and asking the board or the telemetry store instead would make this process a client
     * of something other than the HTTP board.
     *
     * Only armed under Remote Control. A headless run is bounded by jobTimeoutMs and has nobody to
     * come back to it, so parking one would strand it.
     */
    idleMs: number;
    /**
     * The volume holding a full-scope claude.ai login, mounted over the runner's CLAUDE_CONFIG_DIR.
     * Only used in Remote Control mode, which is the only mode that cannot work without one — see
     * docker/claude-executor/run.sh, which writes it.
     */
    authVolume: string;
    /**
     * Names of environment variables forwarded to the runner. Names only: the values are passed as
     * `-e NAME`, which makes docker read them from this process's environment rather than putting a
     * credential in a command line every `ps` on the host can read.
     */
    passEnv: readonly string[];
    /**
     * What spawns the runner: the host's docker daemon (default, the original path), or the
     * Kubernetes API server the driver's own pod talks to — see k8s.ts. An explicit enum, fatal on
     * an unknown value, because a typo must not read as "docker is fine" and quietly spawn nothing.
     */
    executor: 'docker' | 'kubernetes';
    /**
     * The namespace the kubernetes executor creates runner Jobs in. Meaningless under docker. The
     * chart sets it through the downward API, so the driver follows whichever namespace it lands in.
     */
    k8sNamespace: string;
    /**
     * The name of a Secret holding the runner credentials under the kubernetes executor — one key
     * per RUNNER_ENV name. The k8s form of `-e NAME`: the names travel, the values live in a Secret
     * the cluster already holds, and nothing readable lands in the pod spec. Null forwards nothing.
     */
    credentialsSecret: string | null;
    /**
     * The runner image's pull policy, under the kubernetes executor. Kubernetes defaults to
     * `Always` for an untagged or :latest image, which would reach past the node's local images to
     * a registry that has never heard of `claude-executor` — where the docker runner would simply
     * have used what the daemon holds. `IfNotPresent` is that behavior, stated.
     */
    imagePullPolicy: string;
    /**
     * How long a gate environment container outlives the task that started it. The issue's
     * cooldown: a container that stays up across a coding task's turns saves each turn the
     * environment's startup, and ten minutes is the default because that is what the issue
     * names. Zero tears the container down as soon as the task ends.
     */
    gateCooldownMs: number;
    /**
     * Where the ad-hoc gate server binds. Loopback by default — this endpoint runs shell
     * commands, and the bind address is the access control, exactly as it is for the dashboard.
     */
    gateListenHost: string;
    /**
     * The URL the runner is told to reach the gate server by, when loopback will not do — the
     * driver in a container, the runner on the host network, or any split like that. Null builds
     * `http://host.docker.internal:<port>` from the bound port, which the runner reaches through
     * the `--add-host` dockerArgs adds for gated jobs. A URL with no port of its own has the
     * bound port appended (`gateAdvertiseUrlFor`), because the bind is ephemeral; one that
     * carries a port stays verbatim. Never defaulted to something reachable: a wrong guess is a
     * gate that hangs, which reads as a broken test rather than as configuration.
     */
    gateAdvertiseUrl: string | null;
    /**
     * The wall-clock cap on ONE gate run. The runner's own timeout covers the agent; a gate that
     * outlives it (a watch-mode test, a dev server) would otherwise stall the verdict forever.
     * A timed-out gate is a failed gate, exit 124 — the convention `timeout` itself uses.
     */
    gateTimeoutMs: number;
    /**
     * Honors `.bellows.yaml` in the author's checkouts: before a run, the driver reads the file
     * (through a throwaway container over the workspaces volume — it has no host path), starts
     * each declared service as a sibling container on a per-job network, and joins the runner to
     * it, so `redis://cache:6379` resolves for the duration of one job. Off by default, so that
     * turning repo-defined containers on is something somebody typed — see docs/jobs.md.
     */
    servicesEnabled: boolean;
    /**
     * Watches the run's prompt-cache health and kills the job when the provider stops serving
     * cache hits: N consecutive completed turns with no cached input, over a real context, each
     * turn itself slow. The observed failure mode is a model provider that silently drops its
     * cache mid-run — every turn then re-ingests the whole context at a fraction of the speed,
     * and the run grinds into the job timeout having done a fraction of the work. Killing early
     * names the cause while the timeout would have reported only a corpse. Off by default, so
     * that arming a kill switch over provider quality is something somebody typed.
     */
    cacheWatch: boolean;
    /**
     * How often the cache watch polls the session database. Each poll is one throwaway container
     * over the workspaces volume, so the period keeps the same order as the poll interval —
     * frequent enough to catch a collapse minutes into the turns that reveal it, rare enough
     * that the daemon never notices.
     */
    cacheWatchPollMs: number;
}

const DEFAULTS = {
    boardUrl: 'http://127.0.0.1:8080',
    image: 'claude-executor',
    workspaceVolume: 'factory-ai_workspaces',
    workspaceMount: '/workspaces',
    concurrency: 2,
    pollMs: 5_000,
    leaseSeconds: 300,
    jobTimeoutMs: 30 * 60_000,
    idleMs: 60 * 60_000,
    authVolume: 'claude-executor-auth',
    otelEndpoint: 'http://collector:4318',
    passEnv: 'CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY',
} as const;

function int(raw: string | undefined, label: string, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be an integer ${min}..${max}, got "${raw}"`);
    }
    return value;
}

function flag(raw: string | undefined): boolean {
    return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}

function text(raw: string | undefined, label: string, fallback: string): string {
    const value = (raw ?? '').trim() || fallback;
    if (!value) throw new Error(`${label} must not be empty`);
    return value;
}

export function loadDriverConfig(env: NodeJS.ProcessEnv): DriverConfig {
    const boardUrl = text(env.JOB_BOARD_URL, 'JOB_BOARD_URL', DEFAULTS.boardUrl).replace(/\/+$/, '');
    // The protocol is checked, not just the parse: `new URL('dashboard:8080')` succeeds with
    // 'dashboard:' as the scheme, and the first symptom would be every claim failing against a
    // value that reads perfectly well.
    const scheme = (() => {
        try {
            return new URL(boardUrl).protocol;
        } catch {
            return null;
        }
    })();
    if (scheme !== 'http:' && scheme !== 'https:') {
        throw new Error(`JOB_BOARD_URL must be an http(s) URL, got "${boardUrl}"`);
    }

    // The branch reporter's endpoint, defaulted to the board itself — one URL, already checked
    // and already trailing-slash-stripped. An explicit RUNNER_STATS_URL is validated under its
    // own name (strip included, for the same reason: agents concatenate request paths onto this
    // string, and a double slash 404s into the reporter's silence), so a bad override is blamed
    // on the variable that caused it, not on the board URL it displaced.
    const statsUrl = ((env.RUNNER_STATS_URL ?? '').trim() || boardUrl).replace(/\/+$/, '');
    const statsScheme = (() => {
        try {
            return new URL(statsUrl).protocol;
        } catch {
            return null;
        }
    })();
    if (statsScheme !== 'http:' && statsScheme !== 'https:') {
        throw new Error(`RUNNER_STATS_URL must be an http(s) URL, got "${statsUrl}"`);
    }

    // Which CLI the runner speaks. An explicit enum, fatal on an unknown value: a typo must not
    // read as claude-code and hand every prompt to a CLI that exits on "unknown flag" — the job
    // would burn its attempts looking like a command that keeps failing.
    const CLIS = ['claude-code', 'opencode'] as const;
    const cliRaw = (env.RUNNER_CLI ?? '').trim() || 'claude-code';
    if (!CLIS.includes(cliRaw as (typeof CLIS)[number])) {
        throw new Error(`RUNNER_CLI must be one of ${CLIS.join(', ')}, got "${cliRaw}"`);
    }
    const cli = cliRaw as (typeof CLIS)[number];

    // Two combinations that cannot work, refused at startup rather than discovered mid-job.
    //
    // Remote Control is claude-code's bridge: the tty, the login volume and the idle-parking loop
    // all exist to serve a session drivable from claude.ai, and opencode has nothing that answers
    // to `--remote-control`. And skip-permissions appends a claude-code flag; opencode takes its
    // permissions from the opencode.json baked into its image, so the flag would be a no-op that
    // reads as a decision made.
    if (cli === 'opencode') {
        if (flag(env.RUNNER_REMOTE_CONTROL)) {
            throw new Error(
                'RUNNER_REMOTE_CONTROL is not supported under RUNNER_CLI=opencode: Remote Control is ' +
                    "claude-code's bridge, and opencode has nothing that answers to it. Only " +
                    'RUNNER_CLI=claude-code can be driven.',
            );
        }
        if (flag(env.RUNNER_SKIP_PERMISSIONS)) {
            throw new Error(
                'RUNNER_SKIP_PERMISSIONS is not supported under RUNNER_CLI=opencode: it appends a ' +
                    'claude-code flag, and opencode takes its permissions from the opencode.json ' +
                    'baked into its image.',
            );
        }
    }

    const leaseSeconds = int(env.DRIVER_LEASE_SECONDS, 'DRIVER_LEASE_SECONDS', DEFAULTS.leaseSeconds, 10, 3600);
    const jobTimeoutMs = int(
        env.DRIVER_JOB_TIMEOUT_MS,
        'DRIVER_JOB_TIMEOUT_MS',
        DEFAULTS.jobTimeoutMs,
        1_000,
        24 * 3600_000,
    );

    // An explicit enum, like the server's AUTH_MODE: a value this process does not know is fatal,
    // never a fallback to docker — the first symptom of a fallback would be a driver that claims
    // jobs and runs nothing, forever.
    const EXECUTORS = ['docker', 'kubernetes'] as const;
    const executorRaw = (env.EXECUTOR ?? '').trim() || 'docker';
    if (!EXECUTORS.includes(executorRaw as (typeof EXECUTORS)[number])) {
        throw new Error(`EXECUTOR must be one of ${EXECUTORS.join(', ')}, got "${executorRaw}"`);
    }
    const executor = executorRaw as (typeof EXECUTORS)[number];

    const remoteControl = flag(env.RUNNER_REMOTE_CONTROL);
    if (remoteControl && executor === 'kubernetes') {
        throw new Error(
            'RUNNER_REMOTE_CONTROL is not supported under EXECUTOR=kubernetes: it needs a tty, an auth ' +
                'volume and an idle-parking loop that only the docker runner has. Run Remote Control ' +
                'workloads on EXECUTOR=docker.',
        );
    }

    // Auxiliary services run under both executors: docker networks and sibling containers
    // there, service pods with headless DNS Services here. The RUNNER_SERVICES flag decides
    // whether they run at all, on either platform.

    const servicesEnabled = flag(env.RUNNER_SERVICES);

    // An explicit enum, like EXECUTOR: the API server would reject a bad policy only at job-create
    // time, which is attempt-burning — the failure this whole loader exists to move to startup.
    const PULL_POLICIES = ['Always', 'IfNotPresent', 'Never'] as const;
    const pullPolicyRaw = (env.RUNNER_IMAGE_PULL_POLICY ?? '').trim() || 'IfNotPresent';
    if (!PULL_POLICIES.includes(pullPolicyRaw as (typeof PULL_POLICIES)[number])) {
        throw new Error(`RUNNER_IMAGE_PULL_POLICY must be one of ${PULL_POLICIES.join(', ')}, got "${pullPolicyRaw}"`);
    }

    // The cache watch is opencode's — refused at startup rather than discovered mid-job. The
    // probe reads the opencode session database, whose message rows record per-turn input and
    // cache tokens; a claude-code transcript answers nothing to the query. And it stays
    // docker-only: each tick is one throwaway container on an already-warm daemon, while the
    // kubernetes equivalent would be a Job per tick — pod admission every poll period is a tax
    // no watch is worth paying the cluster.
    const cacheWatch = flag(env.RUNNER_CACHE_WATCH);
    if (cacheWatch && cli === 'claude-code') {
        throw new Error(
            'RUNNER_CACHE_WATCH is not supported under RUNNER_CLI=claude-code: the watch reads the ' +
                'opencode session database, which records per-turn input and cache tokens. Only ' +
                'RUNNER_CLI=opencode runs can be watched.',
        );
    }
    if (cacheWatch && executor === 'kubernetes') {
        throw new Error(
            'RUNNER_CACHE_WATCH is not supported under EXECUTOR=kubernetes: each watch tick is one ' +
                'throwaway container on the docker daemon, and a Job per tick would put the cluster ' +
                'under pod-admission load no watch is worth. Run the cache watch on EXECUTOR=docker.',
        );
    }

    return {
        boardUrl,
        boardToken: (env.JOB_BOARD_TOKEN ?? '').trim(),
        worker: text(env.DRIVER_WORKER, 'DRIVER_WORKER', `driver-${process.pid}`),
        image: text(env.EXECUTOR_IMAGE, 'EXECUTOR_IMAGE', cli === 'opencode' ? 'opencode-executor' : DEFAULTS.image),
        cli,
        workspaceVolume: text(env.WORKSPACE_VOLUME, 'WORKSPACE_VOLUME', DEFAULTS.workspaceVolume),
        workspaceMount: text(env.WORKSPACE_MOUNT, 'WORKSPACE_MOUNT', DEFAULTS.workspaceMount),
        // Empty is unset, like every other optional value here: default to the collector on the
        // compose network, so the endpoint is always provided to the runner.
        otelEndpoint: (env.RUNNER_OTEL_ENDPOINT ?? '').trim() || DEFAULTS.otelEndpoint,
        statsUrl,
        ingestToken: (env.RUNNER_INGEST_TOKEN ?? '').trim(),
        network: (env.RUNNER_NETWORK ?? '').trim() || null,
        concurrency: int(env.DRIVER_CONCURRENCY, 'DRIVER_CONCURRENCY', DEFAULTS.concurrency, 1, 32),
        pollMs: int(env.DRIVER_POLL_MS, 'DRIVER_POLL_MS', DEFAULTS.pollMs, 250, 300_000),
        leaseSeconds,
        jobTimeoutMs,
        skipPermissions: flag(env.RUNNER_SKIP_PERMISSIONS),
        remoteControl,
        idleMs: int(env.RUNNER_IDLE_MS, 'RUNNER_IDLE_MS', DEFAULTS.idleMs, 1_000, 24 * 3600_000),
        authVolume: text(env.RUNNER_AUTH_VOLUME, 'RUNNER_AUTH_VOLUME', DEFAULTS.authVolume),
        passEnv: text(env.RUNNER_ENV, 'RUNNER_ENV', DEFAULTS.passEnv)
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean),
        executor,
        k8sNamespace: text(env.K8S_NAMESPACE, 'K8S_NAMESPACE', 'default'),
        credentialsSecret: (env.RUNNER_CREDENTIALS_SECRET ?? '').trim() || null,
        imagePullPolicy: pullPolicyRaw as (typeof PULL_POLICIES)[number],
        gateCooldownMs: int(env.GATE_COOLDOWN_MS, 'GATE_COOLDOWN_MS', 600_000, 0, 24 * 3600_000),
        gateListenHost: text(env.GATE_LISTEN_HOST, 'GATE_LISTEN_HOST', '127.0.0.1'),
        gateAdvertiseUrl: (env.GATE_ADVERTISE_URL ?? '').trim() || null,
        gateTimeoutMs: int(env.GATE_TIMEOUT_MS, 'GATE_TIMEOUT_MS', 600_000, 1_000, 24 * 3600_000),
        servicesEnabled,
        cacheWatch,
        cacheWatchPollMs: int(env.RUNNER_CACHE_WATCH_POLL_MS, 'RUNNER_CACHE_WATCH_POLL_MS', 30_000, 250, 300_000),
    };
}

/**
 * The URL handed to a runner as `BELLOWS_GATE_URL`. Null keeps the host-gateway default. A
 * configured URL with no port has the bound one appended — the listener binds an ephemeral port
 * (`listen(0)`), so no fixed URL could name it in advance; a URL that already carries a port is
 * the operator's word and stays verbatim. Trailing slashes are stripped, because agents build
 * request paths by string concatenation and `…:44685//run` must not happen. An unparseable URL
 * is passed through untouched: the run reaches the same dead string it would have before, and
 * the failure stays at the fetch rather than gaining a second, config-shaped explanation.
 */
export function gateAdvertiseUrlFor(advertiseUrl: string | null, port: number): string {
    if (!advertiseUrl) return `http://host.docker.internal:${port}`;
    try {
        const url = new URL(advertiseUrl);
        if (url.port) return advertiseUrl;
        url.port = String(port);
        return url.toString().replace(/\/+$/, '');
    } catch {
        return advertiseUrl;
    }
}
