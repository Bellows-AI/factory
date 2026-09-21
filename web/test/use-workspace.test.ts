import { afterEach, describe, expect, it, vi } from 'vitest';
import { listExecutorConfigs } from '../src/api/useWorkspace.js';
import * as useSession from '../src/api/useSession.js';

/**
 * The one on-demand executor read, pinned at the wire (#183): the dialog is its only caller, and
 * everything the member pasted — credentials included — rides in this response and no other. The
 * poll (/api/workspace) carries name/type/timestamps only; this is the read that carries the
 * config, so its shape and error handling are asserted here rather than trusted.
 */

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('listExecutorConfigs', () => {
    it('issues exactly one GET /api/workspace/executors and lands the full rows', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValue(
                json({ executors: [{ name: 'main', type: 'claude-code', createdAt: 'x', config: {} }] })
            );
        vi.stubGlobal('fetch', fetch);
        const result = await listExecutorConfigs();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('/api/workspace/executors');
        expect(result).toEqual({
            ok: true,
            executors: [{ name: 'main', type: 'claude-code', createdAt: 'x', config: {} }],
        });
    });

    it('refuses a malformed success body instead of handing garbage to the dialog', async () => {
        // The page calls .some() on the rows and the dialog pre-fills from them — a 2xx body
        // without a real row list would throw in the render, not just look wrong.
        const unexpected = 'Could not load the executors: unexpected response shape.';
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({})));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: unexpected });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ executors: 'two' })));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: unexpected });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ executors: [{ name: 'main', type: 'claude-code' }] })));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: unexpected });
    });

    it('hands a 401 to the session gate instead of rendering an error', async () => {
        const report = vi.spyOn(useSession, 'reportUnauthenticated').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
        const result = await listExecutorConfigs();
        expect(report).toHaveBeenCalled();
        expect(result).toEqual({ ok: false, error: 'Your session expired' });
    });

    it('prefers the server error message and falls back to the status line', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Workspace is disabled' }, 409)));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: 'Workspace is disabled' });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 500)));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: 'Could not load the executors (500)' });
    });

    it('survives a network failure with an error result, not a throw', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: 'offline' });
    });
});
