import { EventEmitter } from 'node:events';
import type { readFileSync } from 'node:fs';
import type { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_LIMIT } from '../src/docker.js';
import { inClusterRequest } from '../src/k8s-transport.js';

interface TransportCall {
    options: RequestOptions;
    writes: string[];
    request: EventEmitter;
}

const OK_STATUS = 200;

function fakeTransport(plans: { status?: number; chunks?: string[]; timeout?: boolean }[]) {
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
                Object.assign(response, { statusCode: plan.status ?? OK_STATUS, setEncoding: vi.fn() });
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

    it('keeps only a bounded response tail when the API sends an oversized log line', async () => {
        const OVERSIZED_MULTIPLIER = 4;
        const transport = fakeTransport([{ chunks: [`prefix-${'x'.repeat(OVERSIZED_MULTIPLIER * OUTPUT_LIMIT)}`] }]);
        const readFile = (() => 'credential') as typeof readFileSync;
        const request = inClusterRequest({
            env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
            readFile,
            request: transport.request,
        });

        const response = await request('GET', '/api/v1/pods/runner/log');

        expect(response.body).toHaveLength(2 * OUTPUT_LIMIT);
        expect(response.body).toBe('x'.repeat(2 * OUTPUT_LIMIT));
    });
});
