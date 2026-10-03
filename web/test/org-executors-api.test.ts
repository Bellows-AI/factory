import { afterEach, describe, expect, it, vi } from 'vitest';
import { changeOrgExecutorScope, deleteOrgExecutor } from '../src/api/orgExecutors.js';

/**
 * The org CRUD's wire shape. DELETE carries no body, and a request that declares
 * `content-type: application/json` and then sends nothing is refused by Fastify before any handler
 * sees it (`FST_ERR_CTP_EMPTY_JSON_BODY`, 400) — so the header has to go with the body, not travel
 * on its own. Driving it through a browser is what found this; this is the cheap guard that keeps
 * it found.
 */

const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => {
    vi.unstubAllGlobals();
});

const captureRequest = () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: RequestInit) => {
            calls.push(init);
            return Promise.resolve(ok());
        })
    );
    return calls;
};

describe('the organization executor writes', () => {
    it('sends a bodyless DELETE with no JSON content type', async () => {
        const calls = captureRequest();
        expect(await deleteOrgExecutor('row-1')).toBe(null);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.method).toBe('DELETE');
        expect(calls[0]!.body).toBeUndefined();
        expect(calls[0]!.headers).toBeUndefined();
    });

    it('still declares JSON on a write that carries one', async () => {
        const calls = captureRequest();
        expect(await changeOrgExecutorScope('row-1', 'user')).toBe(null);
        expect(calls[0]!.method).toBe('POST');
        expect(calls[0]!.body).toBe(JSON.stringify({ scope: 'user' }));
        expect(calls[0]!.headers).toBeDefined();
    });
});
