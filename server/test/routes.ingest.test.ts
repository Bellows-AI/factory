import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createStatsService } from '../src/stats-service.js';
import type { MetricRow } from '../src/telemetry/otlp.js';
import type { SessionBranchReport, TelemetryStore } from '../src/telemetry/store.js';
import { githubAuth, memoryAuthStore, stubTelemetryClient, testConfig } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

interface Recorded {
    report: SessionBranchReport;
    orgId: string;
}

interface StoreStub extends TelemetryStore {
    metrics: MetricRow[];
    branches: Recorded[];
}

function stubStore(options: { fail?: boolean } = {}): StoreStub {
    const stub: StoreStub = {
        metrics: [],
        branches: [],
        async insertMetrics(rows) {
            if (options.fail) throw new Error('database is down');
            stub.metrics.push(...rows);
            return rows.length;
        },
        // The org is a parameter now, not a resolver's answer: it arrives from the credential
        // verified at the ingest boundary, and these assertions pin that it did.
        async recordBranch(report, orgId) {
            if (options.fail) throw new Error('database is down');
            stub.branches.push({ report, orgId });
        },
    };
    return stub;
}

async function harnessWith(store?: StoreStub) {
    const config = testConfig();
    const service = createStatsService({
        config,
        telemetry: stubTelemetryClient(),
        now: () => Date.parse('2026-08-21T12:00:00.000Z'),
    });
    const instance = await buildApp({ config, service, store });
    app = instance;
    return instance;
}

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL_ORG = 'credential-org';

/**
 * A github-mode build: no credential reaches the route without passing the hook, and the
 * injected verifier answers exactly one attempt — the constants above. This is the harness
 * the credential-first ordering is asserted against.
 */
async function githubHarnessWith(
    store?: StoreStub,
    orgOfLease?: (jobId: string, lease: string) => Promise<string | null>
) {
    const config = testConfig({ auth: githubAuth() });
    const service = createStatsService({
        config,
        telemetry: stubTelemetryClient(),
        now: () => Date.parse('2026-08-21T12:00:00.000Z'),
    });
    const instance = await buildApp({
        config,
        service,
        store,
        auth: memoryAuthStore(),
        orgOfLease:
            orgOfLease ??
            (async (jobId, leaseToken) => (jobId === JOB_ID && leaseToken === LEASE ? CREDENTIAL_ORG : null)),
    });
    app = instance;
    return instance;
}

const NANOS = '1787308800000000000';
const otlpBody = {
    resourceMetrics: [
        {
            resource: { attributes: [{ key: 'session.id', value: { stringValue: 's1' } }] },
            scopeMetrics: [
                {
                    metrics: [
                        {
                            name: 'claude_code.token.usage',
                            sum: {
                                aggregationTemporality: 1,
                                dataPoints: [
                                    {
                                        asInt: '1200',
                                        timeUnixNano: NANOS,
                                        attributes: [{ key: 'type', value: { stringValue: 'input' } }],
                                    },
                                ],
                            },
                        },
                    ],
                },
            ],
        },
    ],
};

const json = { 'content-type': 'application/json' };

describe('POST /api/otlp/v1/metrics', () => {
    it('accepts an export and stores the flattened rows', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const res = await instance.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: json,
            payload: otlpBody,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ partialSuccess: {} });
        expect(store.metrics).toHaveLength(1);
        expect(store.metrics[0]?.field).toBe('tokens_input');
        expect(store.metrics[0]?.sessionId).toBe('s1');
    });

    it('answers 200 on an empty export rather than 400', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const res = await instance.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: json,
            payload: { resourceMetrics: [] },
        });
        expect(res.statusCode).toBe(200);
        expect(store.metrics).toEqual([]);
    });

    it('rejects a non-JSON content type', async () => {
        const instance = await harnessWith(stubStore());
        const res = await instance.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: { 'content-type': 'application/x-protobuf' },
            payload: 'binary',
        });
        expect(res.statusCode).toBe(415);
    });

    it('rejects a body over the limit', async () => {
        const instance = await harnessWith(stubStore());
        const res = await instance.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: json,
            payload: { blob: 'x'.repeat(1_100_000) },
        });
        expect(res.statusCode).toBe(413);
    });

    it('answers 503 only for a genuine write failure', async () => {
        // 5xx is the one signal that means "resend", so it is reserved for the case a retry
        // can actually fix. A body the parser cannot read must never get one.
        const instance = await harnessWith(stubStore({ fail: true }));
        const res = await instance.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: json,
            payload: otlpBody,
        });
        expect(res.statusCode).toBe(503);
    });

    it('answers 200, not 5xx, for a body it cannot understand', async () => {
        // An exporter retries 5xx forever, so an unparseable shape would become a loop.
        const store = stubStore();
        const instance = await harnessWith(store);
        for (const payload of [{}, { resourceMetrics: 'nonsense' }, { resourceMetrics: [{}] }]) {
            const res = await instance.inject({
                method: 'POST',
                url: '/api/otlp/v1/metrics',
                headers: json,
                payload,
            });
            expect(res.statusCode).toBe(200);
        }
        expect(store.metrics).toEqual([]);
    });

    it('does not exist when there is nowhere to write', async () => {
        // A route that accepts data and then drops it is worse than no route.
        const instance = await harnessWith(undefined);
        const res = await instance.inject({
            method: 'POST',
            url: '/api/otlp/v1/metrics',
            headers: json,
            payload: otlpBody,
        });
        expect(res.statusCode).toBe(404);
    });
});

describe('POST /api/sessions/branch', () => {
    const report = {
        agent: 'claude-code',
        sessionId: 's1',
        repo: 'acme/app',
        branch: 'feat/x',
        headSha: 'abc123',
        at: '2026-08-21T10:40:00Z',
    };
    const pair = { 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE };

    it('accepts a valid report', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const res = await instance.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: json,
            payload: report,
        });
        expect(res.statusCode).toBe(202);
        expect(store.branches[0]?.report).toEqual(report);
        // No auth hook in this harness (the route-test mode): the org is the LOCAL_ORG_ID
        // semantic orgOf answers for a null principal.
        expect(store.branches[0]?.orgId).toBe('default');
    });

    it('records with the credential’s org, never one derived from the report’s repo', async () => {
        // The finding (CWE-862): a caller-controlled repo field used to select session_branch
        // .org_id by owner match, so reporting a repo owned by another organization poisoned
        // that org's telemetry. The org now arrives from the verified credential; the repo is
        // payload, and naming somebody else's changes nothing.
        const store = stubStore();
        const instance = await githubHarnessWith(store);
        const res = await instance.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: { ...json, ...pair },
            payload: { ...report, repo: 'someone-elses/poisoned-repo' },
        });
        expect(res.statusCode).toBe(202);
        expect(store.branches[0]?.orgId).toBe(CREDENTIAL_ORG);
        expect(store.branches[0]?.report.repo).toBe('someone-elses/poisoned-repo');
    });

    it('checks the credential before the body: 401, never 400, for an unauthenticated caller', async () => {
        // An unauthenticated caller learns nothing — not even which shapes the parser takes.
        const instance = await githubHarnessWith(stubStore());
        const res = await instance.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: json,
            payload: { garbage: true },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json().code).toBe('UNAUTHENTICATED');
    });

    it('answers 400 on a malformed body from an authenticated caller', async () => {
        const instance = await githubHarnessWith(stubStore());
        const res = await instance.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: { ...json, ...pair },
            payload: { ...report, at: 'not-a-date' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('accepts a null branch for a detached HEAD', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const res = await instance.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: json,
            payload: { ...report, branch: null, headSha: null },
        });
        expect(res.statusCode).toBe(202);
        expect(store.branches[0]?.report.branch).toBeNull();
    });

    it('rejects the literal HEAD, which is not a branch name', async () => {
        // It would join to nothing while looking like a real branch.
        const instance = await harnessWith(stubStore());
        const res = await instance.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: json,
            payload: { ...report, branch: 'HEAD' },
        });
        expect(res.statusCode).toBe(400);
    });

    it('answers 400, never 5xx, on a malformed body', async () => {
        // The hook is fire-and-forget; a 5xx would make a well-behaved client retry a body it
        // can never fix.
        const instance = await harnessWith(stubStore());
        const bad = [
            {},
            { ...report, sessionId: '' },
            { ...report, repo: undefined },
            { ...report, at: 'not-a-date' },
            { ...report, branch: 42 },
        ];
        for (const payload of bad) {
            const res = await instance.inject({
                method: 'POST',
                url: '/api/sessions/branch',
                headers: json,
                payload,
            });
            expect(res.statusCode).toBe(400);
        }
    });

    it('defaults the agent so a tool that omits it still lands', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const { agent: _agent, ...withoutAgent } = report;
        await instance.inject({
            method: 'POST',
            url: '/api/sessions/branch',
            headers: json,
            payload: withoutAgent,
        });
        expect(store.branches[0]?.report.agent).toBe('claude-code');
    });
});

describe('POST /api/otlp/v1/logs', () => {
    it('accepts and drops log records, so a configured exporter does not retry forever', async () => {
        const instance = await harnessWith(stubStore());
        const res = await instance.inject({
            method: 'POST',
            url: '/api/otlp/v1/logs',
            headers: json,
            payload: { resourceLogs: [] },
        });
        expect(res.statusCode).toBe(200);
    });
});
