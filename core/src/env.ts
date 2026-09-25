/**
 * The env-var rules the server's PUT enforces and the web editors check before Save. One list
 * both render from — the editors used to carry hand-kept copies, and the reserved-name copy had
 * already drifted (it lacked CLAUDE_CODE_CONFIG_CONTENT). The driver keeps its own
 * RESERVED_ENV_NAMES in driver/src/claim.ts, copied rather than imported per that package's
 * zero-dependency rule, and deliberately different (see below).
 */

/** A bound on one scope's list, like MAX_EXECUTORS_PER_USER: a ceiling, not a policy. */
export const MAX_ENV_VARS_PER_SCOPE = 100;

/**
 * The names the driver's own contract with the runner claims. A claim env named WORKDIR would be
 * two different paths to one runner's working directory; CRED_HELPER is the credential-helper CODE the sync
 * fetch runs — a member value there would be member-controlled code executed by the sync
 * container's git; RESTORE is the sync's restore-mode switch — a member value there would flip
 * starting claims into restore mode, silently skipping the fetch and rebase (issue #58). The
 * three reporter names steer the branch reporter — where it posts, which
 * attempt it speaks for, and which session it claims — and a member value in any of them is a
 * cross-tenant write into the telemetry store. `FACTORY_TRANSCRIPT_DIR` is where the
 * transcript store lives: the driver composes it from the claim (transcriptDir in
 * driver/src/claim.ts), and a member value would steer transcripts — and, through the runner
 * entrypoint's redirect, the CLI's whole config dir — somewhere else. `OPENCODE_CONFIG_CONTENT` and
 * `CLAUDE_CODE_CONFIG_CONTENT` are not the driver's names to reserve but the BOARD's: the claim
 * synthesizes each from the author's own executor row (docs/workspace.md), and a member env var of
 * the same name would be silently shadowed by the synthesized value — refusing the PUT says so
 * instead. Reserved at the route; the driver's list deliberately does NOT carry either, because
 * the synthesized value must flow `claimEnv` to reach the runner.
 */
export const RESERVED_ENV_NAMES: readonly string[] = [
    'WORKDIR',
    'BELLOWS_GATE_URL',
    'BELLOWS_GATE_TOKEN',
    'CRED_HELPER',
    'RESTORE',
    'FACTORY_TRANSCRIPT_DIR',
    'FACTORY_STATS_URL',
    'RUNNER_JOB_ID',
    'RUNNER_LEASE_TOKEN',
    'BELLOWS_SESSION_ID',
    'OPENCODE_CONFIG_CONTENT',
    'CLAUDE_CODE_CONFIG_CONTENT',
];

/**
 * A per-value ceiling (32 KiB). Far past any real variable, and the bound that keeps one value
 * from being an essay. Newlines are refused outright: the driver delivers values in a docker
 * `--env-file`, which is line-structured and has no quoting — a newline would arrive in the runner
 * truncated, with no error anywhere.
 */
export const ENV_VALUE_LIMIT = 32_768;

/**
 * A per-name ceiling, under the 2048-per-entry structure allowance the server's BODY_LIMIT
 * arithmetic assumes — and far under the kernel's per-environment-string limit, which a name past
 * it would turn every later `docker run` for this scope into an E2BIG.
 */
export const ENV_NAME_LIMIT = 255;

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
