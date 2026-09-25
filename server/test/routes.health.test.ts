import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { healthRoutes } from '../src/routes/health.js';

async function serve(ready?: Promise<unknown>) {
    const app = Fastify();
    await app.register(healthRoutes(ready));
    return app;
}

describe('the readiness route', () => {
    // The chart's startupProbe reads it: a pod must not report Ready before its schema exists.
    it('answers 503 while the migrations are still running', async () => {
        const app = await serve(new Promise(() => {}));
        const response = await app.inject({ method: 'GET', url: '/api/ready' });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ status: 'unready', migrations: 'pending' });
    });

    it('answers 200 once the migrations resolve', async () => {
        const app = await serve(Promise.resolve());
        const response = await app.inject({ method: 'GET', url: '/api/ready' });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: 'ready', migrations: 'done' });
    });

    // A server whose migration retry gave up serves every DB-backed route as a 500 until it is
    // restarted — so it stays unready for good, and the probe restarts it.
    it('stays 503 after the migrations gave up', async () => {
        const app = await serve(Promise.reject(new Error('gave up')));
        const response = await app.inject({ method: 'GET', url: '/api/ready' });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({ status: 'unready', migrations: 'failed' });
    });

    it('keeps /api/health answering 200 regardless — liveness is not readiness', async () => {
        const app = await serve(new Promise(() => {}));
        expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    });
});
