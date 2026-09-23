import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { TelemetrySource } from './telemetry/client.js';

export interface Repo {
    readonly owner: string;
    readonly name: string;
}

/**
 * "owner/name" — the form every repo identity takes in this system, and the key sessions are
 * scoped by.
 *
 * Next to the type rather than in `github/`, because `db/` and `routes/` need it too and reaching
 * into the GitHub adapter for a string join would be a layering inversion.
 */
export const fullName = (repo: Repo): string => `${repo.owner}/${repo.name}`;

/**
 * The credential the repo-read path uses, and the source of the repo list itself.
 *
 * A union for the same reason AuthConfig is one: "half-configured App" is unrepresentable rather
 * than merely rejected. The environment can only ever produce the `app` arm — `loadGitHub`
 * requires the id and the key — so a deployment cannot arrive at "fetches nothing", by forgetting
 * a variable or by any variable at all.
 *
 * This replaced a personal access token. The App is not just a different credential: an installation
 * also *reports* which repositories it can see, which is what removed ORG_REPOS. There is no longer
 * an operator-maintained repo list to drift from what the credential can actually reach.
 */
export type GitHubConfig =
    | {
          /**
           * Nothing is fetched from GitHub and nothing is cloned; whatever is already in the
           * database still renders.
           *
           * Reachable ONLY IN CODE, never from the environment: the offline tooling constructs it
           * directly, because there is no offline way to obtain an App private key. `npm run seed`
           * and the admin CLIs pass it to `resolveConfig`, the route-test harness builds it into
           * its own `AppConfig`, and the env-booted harnesses (`npm run verify:ui`,
           * `npm run test:jobs`) run the compiled offline entry, `server/dist/offline.js`.
           */
          readonly mode: 'none';
      }
    | {
          readonly mode: 'app';
          /**
           * A string, not a number. GitHub now issues client ids of the form `Iv23li…` that are
           * accepted as the JWT `iss`, and the numeric form has to survive being one too.
           */
          readonly appId: string;
          /**
           * The PEM itself, never a path — `loadConfig` does no I/O. `GITHUB_APP_PRIVATE_KEY_FILE`
           * is read by `resolveConfig`, which already does every byte of I/O in this system, and
           * merged in before this validator sees it.
           *
           * Only the shape is checked here. `createPrivateKey()` runs when the token provider is
           * constructed, so a well-shaped but invalid key is still fatal at boot rather than at the
           * first fetch.
           */
          readonly privateKeyPem: string;
          readonly apiUrl: string;
      };

/**
 * How a request names its caller.
 *
 * A union rather than a record of optionals, so "half-configured auth" is unrepresentable rather
 * than merely rejected: there is no value of this type that has a client id and no secret, and no
 * call site has to re-check. The mode is also an EXPLICIT enum, never inferred from whether a client
 * id happens to be set — a mode reached by typo is exactly what docs/persistence.md warns about,
 * where "the service used to have a second, silent behaviour reachable by forgetting DATABASE_URL".
 */
export type AuthConfig =
    | {
          /**
           * Every route is open to anyone who can reach the port, as it was before accounts existed.
           * Kept because four things depend on it — `npm run seed`, `npm run verify:ui`,
           * `npm run test:jobs` and the route-test harness — and because there is no offline way to
           * obtain an OAuth client id, so requiring auth would make `git clone && npm run dev`
           * impossible. Same argument docs/configuration.md already makes for GITHUB_TOKEN.
           */
          readonly mode: 'none';
          readonly ingestToken: string | null;
      }
    | {
          readonly mode: 'github';
          readonly clientId: string;
          readonly clientSecret: string;
          /** Signs the session cookie, so rotating it logs everyone out. */
          readonly sessionSecret: string;
          readonly sessionTtlMs: number;
          /**
           * Whether the session cookie carries `Secure`.
           *
           * Configured rather than derived. Hard-coding it breaks every `http://127.0.0.1` boot;
           * relying on the browsers that except loopback is a trap, because Chromium does and Safari
           * does not, so `verify:ui` (which drives Chromium) would pass while a Safari developer
           * cannot sign in; and deriving it from `X-Forwarded-Proto` requires trusting a header from
           * anyone.
           */
          readonly cookieSecure: boolean;
          /**
           * The absolute origin GitHub redirects back to, e.g. `https://factory.example.com`.
           *
           * Explicit, never derived from the `Host` header: an attacker-controlled Host would then
           * choose the `redirect_uri`, which is redirect poisoning.
           */
          readonly publicUrl: string;
          readonly ingestToken: string | null;
          /**
           * The shared secret the driver presents on the worker routes (JOB_BOARD_TOKEN on both
           * sides — the same variable name on the board and the driver is what makes "the same
           * value" verifiable at a glance). The deployment's one driver credential: whoever holds
           * it can claim work and report results, so it is required in this mode — a board that
           * cannot authenticate its own driver is the silent 401 loop this variable exists to
           * prevent, and fatal-at-boot is what names it.
           */
          readonly jobBoardToken: string;
          /** Overridable so the browser check can drive a stub. Environment only — see loadAuth. */
          readonly authorizeUrl: string;
          readonly tokenUrl: string;
          readonly userUrl: string;
      };

export interface AppConfig {
    /**
     * There is no `orgId`/`orgName` here any more. The organizations are the GitHub App
     * installations, upserted at sign-in (#99) — the org is a property of the caller, resolved
     * from the session or the token on every request, never of the process. AUTH_MODE=none keeps
     * the single `default` org, named by LOCAL_ORG_ID.
     *
     * There is no `repos` here either. The list is whatever the App installation reports, which
     * is a network read and therefore async — see `RepoSource`.
     */
    readonly github: GitHubConfig;
    readonly port: number;
    readonly host: string;
    readonly webRoot: string | null;
    readonly telemetrySource: TelemetrySource;
    /**
     * Required. The database is the only place figures come from, so there is no mode that runs
     * without one, and therefore no `null` to branch on at 30-odd call sites.
     */
    readonly databaseUrl: string;
    readonly dbPoolMax: number;
    readonly telemetryTtlMs: number;
    /**
     * Where a member's checkouts live: one clone per repo they selected, at
     * `<workspaceRoot>/<orgId>/<userId>/<name>`.
     *
     * `null` — the feature off — is the default, not a path under `$HOME`. A default would make an
     * upgrade start cloning gigabytes for an operator who changed nothing, and would turn a
     * no-network boot into a network boot; nothing on the read path needs a checkout, so there is
     * no case where having one silently is better than not having one.
     *
     * Absolute, with `~` already expanded. See `workspaceRootOf` for why it is rejected rather than
     * resolved.
     */
    readonly workspaceRoot: string | null;
    readonly auth: AuthConfig;
    /**
     * The GitHub App webhook's HMAC secret (GITHUB_WEBHOOK_SECRET), or null — and with it the
     * webhook route that secret enables. Mode-independent, like the route: the deployment that
     * receives webhooks is the github one, but the webhook's credential is the signature it
     * verifies, not the session machinery, so this does not live inside `[auth]`.
     */
    readonly webhookSecret: string | null;
}

// A telemetry read is a local query with no quota to protect, so this floor exists only to stop a
// hot loop.
const MIN_TELEMETRY_TTL_SECONDS = 5;
const DEFAULT_TELEMETRY_TTL_SECONDS = 30;

/**
 * A database whose name ends here is disposable — the db suite truncates it, and `npm run seed`
 * fills it with synthetic agent sessions. Either would destroy or counterfeit real history.
 */
const DISPOSABLE_DATABASE = /_(test|seed|synthetic|demo|e2e)$/;

/**
 * The one organization AUTH_MODE=none has.
 *
 * With no GitHub sign-in there is nothing to derive an installation id from, so the offline and
 * local tooling — seed, verify:ui, test-jobs, the route tests — all live in this one partition.
 * Github mode never uses it: there the org ids are the installation ids GitHub reports.
 */
export const LOCAL_ORG_ID = 'default';

/**
 * A uuid, as `app_user.id` and `job.id` are.
 *
 * The shape of an identifier that ends up in a path, a URL and a shell command; both `routes/`
 * and `workspace/` legitimately depend on this module, where neither should depend on the other.
 * `driver/` keeps its own copy, deliberately: that package depends on nothing.
 */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function databaseName(url: string): string | null {
    try {
        return new URL(url).pathname.replace(/^\//, '') || null;
    } catch {
        return null;
    }
}

function int(raw: string | undefined, fallback: number, label: string): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer, got "${raw}"`);
    }
    return value;
}

const DEFAULT_PORT = 8080;
const DEFAULT_DB_POOL_MAX = 50;

/**
 * `~` expands against `env.HOME` rather than `os.homedir()`, and a relative path is rejected rather
 * than resolved. Both keep `loadConfig` a pure function of its argument: `homedir()` reads the
 * environment behind the validator's back, and a relative root means two different trees on one
 * machine — `npm run dev -w server` has cwd `server/` while the container has `/app`. Resolving
 * against the config file's directory instead would give one key two meanings depending on whether
 * it arrived from the file or the environment, and `loadConfig` is not allowed to know a file
 * exists at all.
 */
function workspaceRootOf(env: NodeJS.ProcessEnv): string | null {
    const raw = env.ORG_WORKSPACE_ROOT?.trim();
    if (!raw) return null;

    let path = raw;
    if (raw === '~' || raw.startsWith('~/')) {
        const home = env.HOME?.trim();
        if (!home) {
            throw new Error(`ORG_WORKSPACE_ROOT is "${raw}" but HOME is not set, so "~" cannot be expanded`);
        }
        path = raw === '~' ? home : join(home, raw.slice(2));
    }

    if (!isAbsolute(path)) {
        throw new Error(
            `ORG_WORKSPACE_ROOT must be an absolute path (or start with "~/"), got "${raw}" — a relative one would mean a different directory when run from the repo root, from server/, and in the container`
        );
    }
    return path;
}

/**
 * The one GitHub configuration there is: the App, which is what every process reaching the
 * environment builds.
 *
 * Pure, like the rest of loadConfig. In particular the private key arrives here already read:
 * GITHUB_APP_PRIVATE_KEY_FILE is resolved by resolveConfig, so this validator never learns that a
 * file exists — the same rule that keeps `loadConfig({})` meaning one thing on every machine.
 */
function loadGitHub(env: NodeJS.ProcessEnv): Extract<GitHubConfig, { mode: 'app' }> {
    // Named individually rather than as "the App is incomplete": the operator has one key to fix
    // and should not have to diff the example file to find out which.
    const appId = env.GITHUB_APP_ID?.trim();
    const privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
    for (const [label, value] of [
        ['GITHUB_APP_ID', appId],
        ['GITHUB_APP_PRIVATE_KEY', privateKey],
    ] as const) {
        if (!value) {
            throw new Error(
                `${label} is not set. Every deployment fetches through the GitHub App, so the id and the private key are required — a process without them would render an empty dashboard that reads as data loss rather than as a missing credential. See docs/configuration.md.`
            );
        }
    }

    // Base64 is accepted because a PEM is multi-line and both `--env-file` and compose handle a
    // one-line value far better. Discriminated by the header rather than by a flag: a value that
    // already looks like a PEM is one, and there is no third thing it could be.
    let pem = privateKey!;
    if (!pem.includes('-----BEGIN')) {
        pem = Buffer.from(pem, 'base64').toString('utf8').trim();
    }
    if (!pem.startsWith('-----BEGIN') || !pem.includes('PRIVATE KEY-----')) {
        throw new Error(
            'GITHUB_APP_PRIVATE_KEY is not a PEM private key. Paste the contents of the .pem GitHub gave you when you generated the key, or its base64, or point GITHUB_APP_PRIVATE_KEY_FILE at the file.'
        );
    }

    return Object.freeze({
        mode: 'app' as const,
        appId: appId!,
        privateKeyPem: pem,
        // Environment only, and deliberately not a documented variable, for the same reason
        // the three GITHUB_OAUTH_*_URL overrides are: a configurable API host in a file that ships
        // with a deployment is somewhere to send a credential. main.ts logs it when it is set.
        apiUrl: (env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, ''),
    });
}

/**
 * Long enough that the cookie signature is not the weak link. Fatal rather than padded: a secret
 * silently stretched to length is a secret nobody chose.
 */
const MIN_SESSION_SECRET_LENGTH = 32;

const HOURS_PER_DAY = 24;
const SESSION_TTL_DEFAULT_DAYS = 14;
const DEFAULT_SESSION_TTL_HOURS = HOURS_PER_DAY * SESSION_TTL_DEFAULT_DAYS;
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;

/**
 * Addresses that are only reachable from the machine itself, which is the entire access control an
 * `AUTH_MODE=none` deployment has.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function bool(raw: string | undefined, fallback: boolean, label: string): boolean {
    const value = raw?.trim();
    if (value === undefined || value === '') return fallback;
    if (['1', 'true', 'yes'].includes(value)) return true;
    if (['0', 'false', 'no'].includes(value)) return false;
    throw new Error(`${label} must be a boolean ("1"/"true" or "0"/"false"), got "${raw}"`);
}

/**
 * Refusing the pairing is stronger than warning about it: it makes "open to the network"
 * inexpressible rather than merely discouraged, which is more than docs/security.md guaranteed
 * when the bind address was the only protection there was.
 *
 * The hatch is required, not decorative. docker/Dockerfile sets HOST=0.0.0.0, because inside a
 * container that is normal and the isolation is compose's `127.0.0.1:8080:8080` publish —
 * something loadConfig cannot see and must not guess at. Compose pins AUTH_MODE=github instead, so
 * a human who sets the hatch has typed the sentence once.
 */
function assertNoneModeBindable(env: NodeJS.ProcessEnv, host: string): void {
    if (LOOPBACK_HOSTS.has(host) || bool(env.AUTH_ALLOW_PUBLIC_BIND, false, 'AUTH_ALLOW_PUBLIC_BIND')) return;
    throw new Error(
        `AUTH_MODE is "none" but HOST is "${host}", which is reachable from off this machine. With no auth every route is open to anyone who can reach the port, including POST /api/jobs, which runs shell commands. Set AUTH_MODE=github, or bind to 127.0.0.1, or set AUTH_ALLOW_PUBLIC_BIND=1 if something else in front of this port is doing the authenticating.`
    );
}

/**
 * Named individually rather than as "auth is incomplete": the operator has one key to fix and
 * should not have to diff the example file to find out which.
 */
function requireGithubAuthFields(env: NodeJS.ProcessEnv): {
    clientId: string;
    clientSecret: string;
    sessionSecret: string;
} {
    const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim();
    const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
    const sessionSecret = env.SESSION_SECRET?.trim();
    for (const [label, value] of [
        ['GITHUB_OAUTH_CLIENT_ID', clientId],
        ['GITHUB_OAUTH_CLIENT_SECRET', clientSecret],
        ['SESSION_SECRET', sessionSecret],
    ] as const) {
        if (!value) {
            throw new Error(
                `AUTH_MODE is "github" but ${label} is not set. Half-configured auth is fatal rather than falling back to an open deployment, which would be the one failure nobody notices.`
            );
        }
    }
    if (sessionSecret!.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(
            `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters, got ${sessionSecret!.length}`
        );
    }
    return { clientId: clientId!, clientSecret: clientSecret!, sessionSecret: sessionSecret! };
}

/**
 * Required in this mode, not optional: a github-mode board authenticates its driver with this one
 * secret, and a board that boots without it fails every claim with 401s the driver logs forever
 * and nobody reads — the exact silent-forever failure fatal-at-boot replaces. The length floor is
 * the webhook secret's: a short shared secret is an enumerable credential however constant-time
 * the comparison is.
 */
function requireJobBoardToken(env: NodeJS.ProcessEnv): string {
    const jobBoardToken = env.JOB_BOARD_TOKEN?.trim();
    if (!jobBoardToken) {
        throw new Error(
            'AUTH_MODE is "github" but JOB_BOARD_TOKEN is not set. It is the secret the driver presents on the worker routes — the same value in the driver\'s environment and this one. Generate one with: openssl rand -hex 32.'
        );
    }
    if (jobBoardToken.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(
            `JOB_BOARD_TOKEN must be at least ${MIN_SESSION_SECRET_LENGTH} characters, got ${jobBoardToken.length}. Generate one with: openssl rand -hex 32.`
        );
    }
    return jobBoardToken;
}

/**
 * Defaulted only for a loopback bind, where the origin is unambiguous. A deployment reachable from
 * elsewhere has to say what its origin is, because `http://0.0.0.0:8080` is not a URL any browser
 * will ever be redirected back to and a wrong one fails at GitHub with an opaque error.
 */
function resolvePublicOrigin(env: NodeJS.ProcessEnv, host: string, port: number): URL {
    const publicUrl = env.PUBLIC_URL?.trim() || (LOOPBACK_HOSTS.has(host) ? `http://${host}:${port}` : '');
    if (!publicUrl) {
        throw new Error(
            `AUTH_MODE is "github" and HOST is "${host}", so PUBLIC_URL must be set: it is the origin GitHub redirects back to, and it cannot be derived from the request's Host header without letting the caller choose the redirect target.`
        );
    }
    let origin: URL;
    try {
        origin = new URL(publicUrl);
    } catch {
        throw new Error(`PUBLIC_URL must be an absolute URL, got "${publicUrl}"`);
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
        throw new Error(`PUBLIC_URL must be http or https, got "${publicUrl}"`);
    }
    return origin;
}

/**
 * Every key of `[auth]`, or the one field `none` mode has.
 *
 * Pure, like the rest of loadConfig: no I/O, and the GitHub endpoints are read from the environment
 * rather than reached.
 */
function loadAuth(env: NodeJS.ProcessEnv, host: string, port: number): AuthConfig {
    const ingestToken = env.INGEST_TOKEN?.trim() || null;
    const mode = env.AUTH_MODE?.trim() || 'none';
    if (mode !== 'none' && mode !== 'github') {
        throw new Error(`AUTH_MODE must be "github" or "none", got "${env.AUTH_MODE}"`);
    }

    if (mode === 'none') {
        assertNoneModeBindable(env, host);
        return Object.freeze({ mode, ingestToken });
    }

    const { clientId, clientSecret, sessionSecret } = requireGithubAuthFields(env);
    const jobBoardToken = requireJobBoardToken(env);
    const origin = resolvePublicOrigin(env, host, port);
    const sessionTtlHours = int(env.SESSION_TTL_HOURS, DEFAULT_SESSION_TTL_HOURS, 'SESSION_TTL_HOURS');

    return Object.freeze({
        mode,
        clientId,
        clientSecret,
        sessionSecret,
        sessionTtlMs: sessionTtlHours * SECONDS_PER_HOUR * MS_PER_SECOND,
        cookieSecure: bool(env.COOKIE_SECURE, false, 'COOKIE_SECURE'),
        publicUrl: origin.origin,
        ingestToken,
        jobBoardToken,
        // Environment only. A configurable authorize URL in a file that ships with a deployment is
        // a phishing vector; as an environment variable it stays a test seam that main.ts logs
        // loudly when it is used.
        authorizeUrl: env.GITHUB_OAUTH_AUTHORIZE_URL?.trim() || 'https://github.com/login/oauth/authorize',
        tokenUrl: env.GITHUB_OAUTH_TOKEN_URL?.trim() || 'https://github.com/login/oauth/access_token',
        userUrl: env.GITHUB_OAUTH_USER_URL?.trim() || 'https://api.github.com/user',
    });
}

/**
 * The second parameter is the code-only injection point: the offline tooling passes the `none`
 * arm here, in code, because the environment must not be able to select it. Defaults to reading
 * the environment, which always yields the App — deliberately evaluated in the body, after the
 * retired-variable refusals.
 */
/**
 * The keys retired variables that must fail loudly rather than be silently ignored — each one used
 * to decide what the page was made of or which organization the process served, so an ignored one
 * boots a deployment whose operator believes it is reading something else. Grouped in one function
 * purely to keep `loadConfig` under the repo's complexity ceiling; the order and the messages are
 * unchanged.
 */
function assertNoRetiredEnvVars(env: NodeJS.ProcessEnv): void {
    // DATA_SOURCE selected between the live API and a replayed 203-PR payload. It is gone, and
    // fatal rather than ignored for the same reason GITHUB_REPOS is: it used to change what the
    // whole page was made of, so an ignored one would boot a dashboard the operator believes is
    // showing something else. Synthetic data now arrives by seeding a disposable database
    // (`npm run seed`), where it is at least visible as rows somebody chose to write.
    if (env.DATA_SOURCE) {
        throw new Error(
            `DATA_SOURCE is no longer supported (got "${env.DATA_SOURCE}"). The database is the only source the dashboard reads. For data without a GitHub token, seed a disposable database: npm run seed.`
        );
    }

    /*
     * The keys the GitHub App replaced, and the keys the pull-request statistics pipeline used.
     *
     * Fatal rather than ignored, like GITHUB_REPOS and CACHE_TTL_SECONDS before them and for the
     * same reason: each one used to decide what the page was made of, so an ignored one boots a
     * dashboard whose operator believes it is reading something else. An empty value is not an
     * override, here as everywhere, or a bare `GITHUB_TOKEN=` left in .env would refuse to boot.
     */
    if (env.GITHUB_TOKEN) {
        throw new Error(
            'GITHUB_TOKEN is no longer supported: the repo-read credential is a GitHub App installation now, which also reports which repositories it can see. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE). See docs/configuration.md.'
        );
    }
    if (env.GITHUB_REPOS || env.ORG_REPOS) {
        throw new Error(
            `${env.ORG_REPOS ? 'ORG_REPOS' : 'GITHUB_REPOS'} is no longer supported: the repo list is whatever the GitHub App installation reports, and each member chooses which of those to check out from the dashboard. Remove the line; install the App on the repositories you want measured instead. See GET /api/repos.`
        );
    }
    if (env.GITHUB_OWNER) {
        throw new Error(
            "GITHUB_OWNER is no longer supported: the installation reports each repository with its own owner, and the organizations are the App's installations. Remove the line."
        );
    }
    if (env.SYNC_TTL_SECONDS) {
        throw new Error(
            'SYNC_TTL_SECONDS is no longer supported: the pull-request sync it throttled is gone, and the only cache floor left is TELEMETRY_TTL_SECONDS. Remove the line; rename to TELEMETRY_TTL_SECONDS if you meant the telemetry slot.'
        );
    }
    if (env.BASE_BRANCH) {
        throw new Error(
            'BASE_BRANCH is no longer supported: it parameterised the pull-request statistics, which are removed. Remove the line.'
        );
    }
    if (env.BOTS) {
        throw new Error(
            'BOTS is no longer supported: it classified pull-request authors, which are removed. Remove the line.'
        );
    }

    /*
     * The keys the multi-org sign-in replaced (#99).
     *
     * Same register as the block above: each one used to decide what the process served, so an
     * ignored one boots a deployment that silently reports on the wrong organization — or only
     * one of the organizations it now could.
     */
    if (env.ORG_ID?.trim()) {
        throw new Error(
            'ORG_ID is no longer supported: organizations are the GitHub App installations now — one installation per org, created at sign-in and named after its account. Remove the line.'
        );
    }
    if (env.ORG_NAME?.trim()) {
        throw new Error(
            "ORG_NAME is no longer supported: an organization's name is the installation account's GitHub login, reported at sign-in. Remove the line."
        );
    }
    if (env.GITHUB_APP_INSTALLATION_ID?.trim()) {
        throw new Error(
            'GITHUB_APP_INSTALLATION_ID is no longer supported: installation tokens are minted per organization from organization.installation_id, and the organizations are the installations the App reports at sign-in. Remove the line.'
        );
    }
    if (env.AUTH_AUTO_JOIN_GITHUB_ORG?.trim()) {
        throw new Error(
            'AUTH_AUTO_JOIN_GITHUB_ORG is no longer supported: installation access is membership — anyone who can see an installation signs into its org, and nobody else does. Remove the line.'
        );
    }
    if (env.AUTH_BOOTSTRAP_ADMIN?.trim()) {
        throw new Error(
            'AUTH_BOOTSTRAP_ADMIN is no longer supported: there is no first-admin problem when membership comes from GitHub — the first person who can see the installation signs in. Remove the line.'
        );
    }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, injectedGitHub?: GitHubConfig): AppConfig {
    assertNoRetiredEnvVars(env);

    const workspaceRoot = workspaceRootOf(env);

    // CACHE_TTL_SECONDS used to floor the PR slot at 300s per repo, then SYNC_TTL_SECONDS at
    // 60s; both slots are gone with the pipeline they throttled. Fatal rather than ignored: a
    // deployment that had raised one to protect its quota would otherwise silently drop to the
    // 5s telemetry floor.
    if (env.CACHE_TTL_SECONDS) {
        throw new Error(
            'CACHE_TTL_SECONDS is no longer supported: the pull-request sync it throttled is gone. Rename it to TELEMETRY_TTL_SECONDS if you meant the telemetry slot.'
        );
    }

    const telemetrySource = (env.TELEMETRY_SOURCE ?? 'postgres') as TelemetrySource;
    if (!['postgres', 'fixture', 'off'].includes(telemetrySource)) {
        throw new Error(`TELEMETRY_SOURCE must be "postgres", "fixture", or "off", got "${env.TELEMETRY_SOURCE}"`);
    }

    const telemetryTtlSeconds = int(env.TELEMETRY_TTL_SECONDS, DEFAULT_TELEMETRY_TTL_SECONDS, 'TELEMETRY_TTL_SECONDS');
    if (telemetryTtlSeconds < MIN_TELEMETRY_TTL_SECONDS) {
        throw new Error(`TELEMETRY_TTL_SECONDS must be at least ${MIN_TELEMETRY_TTL_SECONDS}`);
    }

    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error(
            'DATABASE_URL is required: the database is the only source the dashboard reads. Start one with `docker compose up -d timescale`, then let it sync from GitHub, or fill a disposable one with `npm run seed`.'
        );
    }

    // Parsed like INGEST_TOKEN: trim, empty meaning unset. Unset, the installation webhook route
    // does not exist and a GitHub-side removal waits for the removed account's next sign-in.
    const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim() || null;
    // The secret IS the webhook's credential — its HMAC decides whose memberships get deleted —
    // so a short one is an enumerable credential however constant-time the comparison is. The
    // same floor SESSION_SECRET sits behind, and the same reason.
    if (webhookSecret !== null && webhookSecret.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(
            `GITHUB_WEBHOOK_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters, got ${webhookSecret.length}. Generate one with: openssl rand -hex 32.`
        );
    }

    // The App, unless the caller injected the code-only none arm — the offline tooling's seam.
    const github = injectedGitHub ?? loadGitHub(env);

    /*
     * The disposable-database guard.
     *
     * Every process that reaches the environment fetches — the App is the only configuration
     * there is — so the pairing below is simply refused. A disposable database is one that
     * `npm run test:db` truncates and `npm run seed` fills with invented sessions; pointing a
     * fetching process at one means real history is either destroyed on the next test run or
     * interleaved with synthetic rows that no later query can tell apart. The offline tooling is
     * exempt by construction, because it never reaches here: its config carries the code-only
     * `none` arm, which is what "this process does not fetch" means now.
     */
    const name = databaseName(databaseUrl) ?? '';
    if (github.mode === 'app' && DISPOSABLE_DATABASE.test(name)) {
        throw new Error(
            `DATABASE_URL points at "${name}", which is disposable: the db suite truncates it and \`npm run seed\` writes synthetic sessions into it. Refusing to persist real fetched history there. Use a database without a _test/_seed/_synthetic/_demo/_e2e suffix.`
        );
    }

    // Bound before the return because loadAuth reads both: whether a deployment is reachable from
    // off the machine is what decides if running without auth is allowed at all.
    const port = int(env.PORT, DEFAULT_PORT, 'PORT');
    const host = env.HOST ?? '127.0.0.1';
    const dbPoolMax = int(env.DB_POOL_MAX, DEFAULT_DB_POOL_MAX, 'DB_POOL_MAX');

    return Object.freeze({
        github,
        port,
        host,
        webRoot: env.WEB_ROOT ?? null,
        telemetrySource,
        databaseUrl,
        dbPoolMax,
        telemetryTtlMs: telemetryTtlSeconds * MS_PER_SECOND,
        workspaceRoot,
        auth: loadAuth(env, host, port),
        webhookSecret,
    });
}

/**
 * The entry point every process uses. Environment only: there is no config file, so what reaches
 * the validator is the process environment.
 *
 * The one piece of I/O allowed here is GITHUB_APP_PRIVATE_KEY_FILE, read into
 * GITHUB_APP_PRIVATE_KEY before the validator runs — so `loadConfig` stays a pure function of its
 * argument and never learns that a file exists. An inline key wins over a FILE path, and an
 * explicit path that cannot be read is fatal and says why; the usual cause is a host file at mode
 * 600 bind-mounted into a container running as `node`.
 *
 * `github` is the tooling's injection point: the offline CLIs pass the code-only `none` arm so
 * they never need a credential and never trip the disposable-database guard. Nothing env-reachable
 * can produce it.
 */
export function resolveConfig(options: { env?: NodeJS.ProcessEnv; github?: GitHubConfig } = {}): {
    readonly config: AppConfig;
} {
    const env = options.env ?? process.env;
    const path = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
    if (options.github) return { config: loadConfig(env, options.github) };
    if (!path || env.GITHUB_APP_PRIVATE_KEY) return { config: loadConfig(env) };
    try {
        return { config: loadConfig({ ...env, GITHUB_APP_PRIVATE_KEY: readFileSync(path, 'utf8').trim() }) };
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(
            `GITHUB_APP_PRIVATE_KEY_FILE points at ${path}, which could not be read (${code ?? 'unknown error'})`
        );
    }
}
