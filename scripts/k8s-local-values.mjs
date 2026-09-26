// The credential half of the local Kubernetes profile (charts/factory/values-local.yaml): reads the
// repo-root .env — the same file compose reads — and prints the auth and App values as a helm
// values document (JSON is YAML) on stdout, for `helm ... -f -`. Piped, so no secret lands in a
// file or on a command line, where `ps` would show it.
//
// The chart always runs GitHub sign-in, so every value below is required and a missing one exits
// non-zero naming it — before helm renders anything. Variables already in the environment win
// over .env, as with `node --env-file`.
//
// PUBLIC_URL is deliberately not read: .env's points at the dev stack. The cluster is reached
// through `make start`'s port-forward, so the origin is K8S_PUBLIC_URL, defaulting to that
// forward. GitHub accepts any port on a loopback redirect, so the OAuth App registered for the dev
// stack's 127.0.0.1 callback serves this one too.
import { existsSync, readFileSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const privateKey =
    env.GITHUB_APP_PRIVATE_KEY?.trim() ||
    (env.GITHUB_APP_PRIVATE_KEY_FILE?.trim() ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE.trim(), 'utf8') : '');

const required = {
    GITHUB_APP_ID: env.GITHUB_APP_ID?.trim(),
    'GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_FILE)': privateKey,
    GITHUB_OAUTH_CLIENT_ID: env.GITHUB_OAUTH_CLIENT_ID?.trim(),
    GITHUB_OAUTH_CLIENT_SECRET: env.GITHUB_OAUTH_CLIENT_SECRET?.trim(),
    SESSION_SECRET: env.SESSION_SECRET?.trim(),
    JOB_BOARD_TOKEN: env.JOB_BOARD_TOKEN?.trim(),
};
const missing = Object.keys(required).filter((name) => !required[name]);
if (missing.length > 0) {
    process.stderr.write(
        `k8s-local-values: the local cluster runs GitHub sign-in and needs these in .env: ${missing.join(', ')}\n`
    );
    process.exit(1);
}

const values = {
    auth: {
        publicUrl: env.K8S_PUBLIC_URL?.trim() || `http://127.0.0.1:${env.K8S_PORT?.trim() || '8081'}`,
        oauthClientId: required.GITHUB_OAUTH_CLIENT_ID,
    },
    github: {
        appId: required.GITHUB_APP_ID,
        appPrivateKey: privateKey,
    },
    secret: {
        oauthClientSecret: required.GITHUB_OAUTH_CLIENT_SECRET,
        sessionSecret: required.SESSION_SECRET,
        jobBoardToken: required.JOB_BOARD_TOKEN,
        githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() ?? '',
    },
    // The model credential the real runner images need, into the chart's runner Secret. Optional:
    // a board env var can carry it instead, and an unset one stays the chart's empty value.
    runner: {
        credentials: {
            CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? '',
            ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY?.trim() ?? '',
        },
    },
};
process.stdout.write(`${JSON.stringify(values)}\n`);
