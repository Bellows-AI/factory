import { EventEmitter } from 'node:events';
import type { readFileSync } from 'node:fs';
import { Agent, globalAgent } from 'node:https';
import type { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_LIMIT } from '../src/runner.js';
import {
    DIAGNOSIS_BODY_CHARS,
    inClusterRequest,
    isMalformedRequest400,
    refusalDiagnosis,
} from '../src/k8s-transport.js';

const METRICS_PATH = '/apis/metrics.k8s.io/v1beta1/namespaces/factory/pods/runner-1';
const LOG_PATH = '/api/v1/namespaces/factory/pods/runner-1/log?tailLines=1000';
const status = (message: string, reason?: string) => JSON.stringify({ kind: 'Status', message, reason, code: 400 });
const CREATING = status('container "runner" in pod "runner-1" is waiting to start: ContainerCreating', 'BadRequest');

describe('refusalDiagnosis', () => {
    it('stays quiet for the expected metrics 404 and ContainerCreating log 400 only', () => {
        expect(refusalDiagnosis('GET', METRICS_PATH, 404, status('not found', 'NotFound'))).toBeNull();
        expect(refusalDiagnosis('GET', METRICS_PATH, 404, '')).toBeNull();
        expect(refusalDiagnosis('GET', LOG_PATH, 400, CREATING)).toBeNull();
        expect(refusalDiagnosis('GET', LOG_PATH, 200, 'ok')).toBeNull();
    });

    it('keeps every look-alike diagnosable', () => {
        const cases: [string, string, number, string][] = [
            ['GET', '/api/v1/namespaces/factory/pods/runner-1', 404, status('pod not found', 'NotFound')],
            ['DELETE', METRICS_PATH, 404, ''],
            ['GET', METRICS_PATH, 403, status('forbidden', 'Forbidden')],
            ['GET', METRICS_PATH, 500, 'boom'],
            ['GET', LOG_PATH, 400, status('previous terminated container not found', 'BadRequest')],
            ['GET', LOG_PATH, 400, '400 Bad Request'],
            ['GET', LOG_PATH, 400, 'ContainerCreating'],
            ['GET', LOG_PATH, 404, CREATING],
            ['POST', LOG_PATH, 400, CREATING],
            ['GET', '/api/v1/namespaces/factory/pods/runner-1/status', 400, CREATING],
        ];
        for (const [method, path, code, body] of cases) {
            expect(refusalDiagnosis(method, path, code, body), `${method} ${path} ${code}`).toContain(
                `${method} ${path} answered ${code}`
            );
        }
    });

    it('reduces a Status to its message and reason, without the raw JSON', () => {
        const line = refusalDiagnosis('GET', '/api/v1/pods', 403, status('pods is forbidden', 'Forbidden'));

        expect(line).toBe('GET /api/v1/pods answered 403: pods is forbidden (Forbidden)');
    });

    it('previews plain text and invalid JSON, bounded', () => {
        const long = `{"kind":"Status","message":"${'z'.repeat(2 * DIAGNOSIS_BODY_CHARS)}`;
        const hugeMessage = status('m'.repeat(2 * DIAGNOSIS_BODY_CHARS));

        expect(refusalDiagnosis('GET', '/x', 502, 'bad gateway')).toBe('GET /x answered 502 body=bad gateway');
        expect(refusalDiagnosis('GET', '/x', 502, long)).toHaveLength(
            'GET /x answered 502 body='.length + DIAGNOSIS_BODY_CHARS
        );
        expect(refusalDiagnosis('GET', '/x', 400, hugeMessage)).toHaveLength(
            'GET /x answered 400: '.length + DIAGNOSIS_BODY_CHARS
        );
    });
});

interface TransportCall {
    options: RequestOptions;
    writes: string[];
    request: EventEmitter;
}

const OK_STATUS = 200;

function fakeTransport(
    plans: { status?: number; chunks?: string[]; timeout?: boolean; headers?: Record<string, string> }[]
) {
    const calls: TransportCall[] = [];
    const request = ((options: RequestOptions, respond: (response: EventEmitter) => void) => {
        const plan = plans[calls.length] ?? {};
        const req = new EventEmitter();
        const call = { options, writes: [] as string[], request: req };
        calls.push(call);
        Object.assign(req, {
            write(chunk: string) {
                call.writes.push(chunk);
                return true;
            },
            end() {
                if (plan.timeout) {
                    queueMicrotask(() => req.emit('timeout'));
                    return req;
                }
                const response = new EventEmitter();
                Object.assign(response, {
                    statusCode: plan.status ?? OK_STATUS,
                    setEncoding: vi.fn(),
                    headers: plan.headers ?? {},
                });
                respond(response);
                queueMicrotask(() => {
                    for (const chunk of plan.chunks ?? []) response.emit('data', chunk);
                    response.emit('end');
                });
                return req;
            },
            destroy(error: Error) {
                queueMicrotask(() => req.emit('error', error));
                return req;
            },
        });
        return req;
    }) as unknown as typeof httpsRequest;
    return { request, calls };
}

const CLUSTER_ENV = { KUBERNETES_SERVICE_HOST: '10.0.0.1' };
const CREDENTIALS = (() => 'credential') as typeof readFileSync;

describe('the malformed-request classifier', () => {
    it('names the API server pre-handler 400 Bad Request answer', () => {
        expect(isMalformedRequest400(400, '400 Bad Request')).toBe(true);
        expect(isMalformedRequest400(400, '400 Bad Request: Client sent an HTTP request to an HTTPS server.')).toBe(
            true
        );
        expect(isMalformedRequest400(400, '400 Bad Request\n')).toBe(true);
    });

    it('never names a genuine API Status refusal or any other answer', () => {
        expect(
            isMalformedRequest400(
                400,
                '{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Invalid","code":400}'
            )
        ).toBe(false);
        expect(isMalformedRequest400(503, 'unavailable')).toBe(false);
        expect(isMalformedRequest400(400, 'container "sync" in pod "x" has not started')).toBe(false);
        expect(isMalformedRequest400(200, '400 Bad Request')).toBe(false);
    });
});

describe('the in-cluster kubernetes transport', () => {
    it('fails at construction when the driver is not running in a cluster', () => {
        expect(() => inClusterRequest({ env: {} })).toThrow(/KUBERNETES_SERVICE_HOST is not set/);
    });

    it('pins the cluster CA, rotates the bearer token per call, and preserves raw responses', async () => {
        const transport = fakeTransport([
            { status: 201, chunks: ['cre', 'ated'] },
            { status: 200, chunks: ['read'] },
        ]);
        let tokenReads = 0;
        const readFile = ((path: string) => {
            if (path.endsWith('/ca.crt')) return 'cluster-ca';
            tokenReads += 1;
            return ` token-${tokenReads} \n`;
        }) as typeof readFileSync;
        const request = inClusterRequest({
            env: { KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '6443' },
            readFile,
            request: transport.request,
            serviceAccountDir: '/service-account',
        });

        await expect(request('POST', '/apis/batch/v1/jobs', { name: 'runner' })).resolves.toEqual({
            status: 201,
            body: 'created',
        });
        await expect(request('GET', '/apis/batch/v1/jobs/runner')).resolves.toEqual({ status: 200, body: 'read' });

        expect(transport.calls.map((call) => call.options)).toMatchObject([
            {
                host: '10.0.0.1',
                port: 6443,
                method: 'POST',
                path: '/apis/batch/v1/jobs',
                ca: 'cluster-ca',
                headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
            },
            { headers: { authorization: 'Bearer token-2' } },
        ]);
        expect(transport.calls[0]?.writes).toEqual(['{"name":"runner"}']);
        expect(transport.calls[1]?.writes).toEqual([]);
        expect(tokenReads).toBe(2);
    });

    it('destroys a timed-out request so a half-open API connection cannot hold a lease forever', async () => {
        const transport = fakeTransport([{ timeout: true }]);
        const readFile = (() => 'credential') as typeof readFileSync;
        const request = inClusterRequest({
            env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
            readFile,
            request: transport.request,
        });

        await expect(request('GET', '/version')).rejects.toThrow(/API server did not answer within/);
    });

    it('keeps the classification prefix ahead of a bounded response tail for an oversized log line', async () => {
        const OVERSIZED_MULTIPLIER = 4;
        const transport = fakeTransport([{ chunks: [`prefix-${'x'.repeat(OVERSIZED_MULTIPLIER * OUTPUT_LIMIT)}`] }]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

        const response = await request('GET', '/api/v1/pods/runner/log');

        expect(response.body).toHaveLength(DIAGNOSIS_BODY_CHARS + 2 * OUTPUT_LIMIT);
        expect(response.body.startsWith('prefix-')).toBe(true);
        expect(response.body.endsWith('x'.repeat(2 * OUTPUT_LIMIT))).toBe(true);
    });

    it('preserves the 400 Bad Request prefix of an oversized refusal for classification and the log', async () => {
        const refusal = `400 Bad Request: label does not match selector ${'x'.repeat(4 * OUTPUT_LIMIT)}`;
        const transport = fakeTransport([
            {
                status: 400,
                chunks: [refusal.slice(0, 17), refusal.slice(17)],
                headers: { 'content-type': 'text/plain' },
            },
        ]);
        const logs: string[] = [];
        const request = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
            log: (message) => logs.push(message),
        });

        const response = await request('GET', '/apis/batch/v1/namespaces/default/jobs/factory-sync-x');

        expect(isMalformedRequest400(response.status, response.body)).toBe(true);
        expect(response.body).toHaveLength(DIAGNOSIS_BODY_CHARS + 2 * OUTPUT_LIMIT);
        expect(response.body).not.toContain('x'.repeat(4 * OUTPUT_LIMIT));
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain(refusal.slice(0, DIAGNOSIS_BODY_CHARS));
    });

    it('answers every call through one dedicated agent, never the global one', async () => {
        const transport = fakeTransport([{ status: 200 }, { status: 200 }]);
        const sentinel = new Agent({ keepAlive: false });
        const injected = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
            agent: sentinel,
        });
        await injected('GET', '/version');

        expect(transport.calls[0]?.options.agent).toBe(sentinel);

        const defaulted = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
        });
        await defaulted('GET', '/version');
        await defaulted('GET', '/version');

        const agent = transport.calls[1]?.options.agent;
        expect(agent).toBeDefined();
        expect(agent).not.toBe(globalAgent);
        expect((agent as Agent).keepAlive).toBe(false);
        expect(transport.calls[2]?.options.agent).toBe(agent);
    });

    it('logs method, path, status, headers and a bounded body on refused answers (400, 500)', async () => {
        const oversized = `boom-${'y'.repeat(DIAGNOSIS_BODY_CHARS + 50)}`;
        const transport = fakeTransport([
            { status: 400, chunks: ['400 ', 'Bad Request'], headers: { 'content-type': 'text/plain' } },
            { status: 200, chunks: ['ok'] },
            { status: 500, chunks: [oversized], headers: {} },
        ]);
        const logs: string[] = [];
        const request = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
            log: (message) => logs.push(message),
        });

        await request('GET', '/apis/batch/v1/namespaces/default/jobs/factory-sync-x');
        await request('GET', '/version');
        await request('POST', '/apis/batch/v1/namespaces/default/jobs');

        expect(logs).toHaveLength(2);
        expect(logs[0]).toContain('GET');
        expect(logs[0]).toContain('/apis/batch/v1/namespaces/default/jobs/factory-sync-x');
        expect(logs[0]).toContain('400');
        expect(logs[0]).toContain('400 Bad Request');
        expect(logs[0]).not.toContain('headers');
        expect(logs[1]).toContain('POST');
        expect(logs[1]).toContain('500');
        expect(logs[1]).toContain(oversized.slice(0, DIAGNOSIS_BODY_CHARS));
        expect(logs[1]).not.toContain(oversized.slice(0, DIAGNOSIS_BODY_CHARS + 1));
    });
});
