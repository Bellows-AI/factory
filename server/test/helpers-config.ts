import { readFileSync } from 'node:fs';
import type { TelemetryInput } from '@factory-ai/core';
import type { AppConfig, AuthConfig } from '../src/config.js';

const TELEMETRY_FIXTURE = new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url);

export const TEST_REPO = 'Bellows-AI/bellows.ai';

let telemetryPayload: TelemetryInput | null = null;
export function sampleTelemetry(): TelemetryInput {
    if (!telemetryPayload) {
        telemetryPayload = JSON.parse(readFileSync(TELEMETRY_FIXTURE, 'utf8')) as TelemetryInput;
    }
    return telemetryPayload;
}

export const EMPTY_TELEMETRY: TelemetryInput = {
    sessions: [],
    coverage: { from: null, to: null },
};

const DEFAULT_TELEMETRY_TTL_MS = 30_000;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        // `none` — the code-only no-fetch arm — so the offline suite never constructs a token
        // provider or an App client. The repo list reaches the service through `staticRepoSource`
        // in `harness` instead — which is the same seam `npm run seed` and `verify:ui` use, rather
        // than a test-only one. There is no orgId/orgName any more (#99): the orgs live in the
        // store and the registry, and the tests that name one use 'test-org' explicitly.
        github: { mode: 'none' },
        port: 0,
        host: '127.0.0.1',
        webRoot: null,
        telemetrySource: 'fixture',
        // Never connected to: the harness injects a telemetry stub directly. It is a literal here
        // because AppConfig requires one, not because anything opens it.
        databaseUrl: 'postgres://factory:factory@127.0.0.1:5432/factory_test',
        telemetryTtlMs: DEFAULT_TELEMETRY_TTL_MS,
        workspaceRoot: null,
        // Matches loadConfig's default. Note that this is only what the *config* says: the app is
        // built with no auth store at all unless a test passes one, so by default no hook runs.
        auth: { mode: 'none', ingestToken: null },
        // No webhook secret, so no installation webhook route — the tests that want one set it.
        webhookSecret: null,
        ...overrides,
    };
}

export const TEST_SESSION_SECRET = 'test-session-secret-of-at-least-32-chars';

/** The shared board secret github-mode tests present as `Bearer $JOB_BOARD_TOKEN`. */
export const TEST_JOB_BOARD_TOKEN = 'test-job-board-token-of-at-least-32-chars';

const DAYS_PER_FORTNIGHT = 14;
const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const FORTNIGHT_MS = DAYS_PER_FORTNIGHT * HOURS_PER_DAY * SECONDS_PER_HOUR * MS_PER_SECOND;

/** A github-mode [auth] block, so a test does not have to restate eleven fields to change one. */
export function githubAuth(overrides: Partial<Extract<AuthConfig, { mode: 'github' }>> = {}): AuthConfig {
    return {
        mode: 'github',
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        sessionSecret: TEST_SESSION_SECRET,
        sessionTtlMs: FORTNIGHT_MS,
        cookieSecure: false,
        publicUrl: 'http://127.0.0.1:8080',
        ingestToken: null,
        jobBoardToken: TEST_JOB_BOARD_TOKEN,
        authorizeUrl: 'https://github.test/login/oauth/authorize',
        tokenUrl: 'https://github.test/login/oauth/access_token',
        userUrl: 'https://api.github.test/user',
        ...overrides,
    };
}
