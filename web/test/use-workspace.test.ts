import { afterEach, describe, expect, it, vi } from 'vitest';
import { listExecutorConfigs, payloadSettled, purgeOrphan } from '../src/api/useWorkspace.js';
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
        const fetch = vi.fn().mockResolvedValue(
            json({
                executors: [
                    {
                        name: 'main',
                        type: 'claude-code',
                        createdAt: 'x',
                        isDefault: false,
                        gateFixRounds: 3,
                        config: {},
                    },
                ],
            })
        );
        vi.stubGlobal('fetch', fetch);
        const result = await listExecutorConfigs();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('/api/workspace/executors');
        expect(result).toEqual({
            ok: true,
            executors: [
                { name: 'main', type: 'claude-code', createdAt: 'x', isDefault: false, gateFixRounds: 3, config: {} },
            ],
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

    it('refuses a row whose isDefault is not a boolean', async () => {
        const unexpected = 'Could not load the executors: unexpected response shape.';
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                json({
                    executors: [{ name: 'main', type: 'claude-code', createdAt: 'x', isDefault: 'yes', config: {} }],
                })
            )
        );
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: unexpected });
    });

    it('hands a 401 to the session gate instead of rendering an error', async () => {
        const report = vi.spyOn(useSession, 'reportUnauthenticated').mockImplementation(() => {});
        const HTTP_STATUS_UNAUTHORIZED = 401;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, HTTP_STATUS_UNAUTHORIZED)));
        const result = await listExecutorConfigs();
        expect(report).toHaveBeenCalled();
        expect(result).toEqual({ ok: false, error: 'Your session expired' });
    });

    it('prefers the server error message and falls back to the status line', async () => {
        const HTTP_STATUS_CONFLICT = 409;
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(json({ error: 'Workspace is disabled' }, HTTP_STATUS_CONFLICT))
        );
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: 'Workspace is disabled' });

        const HTTP_INTERNAL_SERVER_ERROR = 500;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, HTTP_INTERNAL_SERVER_ERROR)));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: 'Could not load the executors (500)' });
    });

    it('survives a network failure with an error result, not a throw', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        expect(await listExecutorConfigs()).toEqual({ ok: false, error: 'offline' });
    });
});

describe('purgeOrphan', () => {
    it('issues DELETE /api/workspace/repos/:owner/:name and accepts both success answers', async () => {
        // 202: the removal child is running; 204: nothing to remove. Both are success — the poll
        // decides what the member sees next.
        const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
        vi.stubGlobal('fetch', fetch);
        expect(await purgeOrphan('acme', 'gone')).toEqual({ ok: true });
        expect(fetch).toHaveBeenCalledWith('/api/workspace/repos/acme/gone', { method: 'DELETE' });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
        expect(await purgeOrphan('acme', 'gone')).toEqual({ ok: true });
    });

    it('surfaces a refusal\u2019s message and hands a 401 to the session gate', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: '"acme/gone" has 2 unfinished tasks', code: 'TASKS_IN_FLIGHT' }), {
                    status: 409,
                    headers: { 'content-type': 'application/json' },
                })
            )
        );
        expect(await purgeOrphan('acme', 'gone')).toEqual({ ok: false, error: '"acme/gone" has 2 unfinished tasks' });

        const report = vi.spyOn(useSession, 'reportUnauthenticated').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
        expect(await purgeOrphan('acme', 'gone')).toEqual({ ok: false, error: 'Your session expired' });
        expect(report).toHaveBeenCalled();
    });

    it('survives a network failure with an error result, not a throw', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        expect(await purgeOrphan('acme', 'gone')).toEqual({ ok: false, error: 'offline' });
    });
});

describe('payloadSettled', () => {
    const payload = (orphaned: { status: string }[]): Parameters<typeof payloadSettled>[0] => ({
        root: '/workspaces',
        repos: [],
        orphaned: orphaned as never,
        checkoutTotalBytes: null,
        executors: [],
    });

    it('keeps polling while an orphan is being deleted — disappearance is the completion', () => {
        expect(payloadSettled(payload([{ status: 'purging' }]))).toBe(false);
        expect(payloadSettled(payload([{ status: 'queued' }, { status: 'failed' }]))).toBe(true);
        // No payload is nothing to wait for — the hook's pre-existing contract.
        expect(payloadSettled(null)).toBe(true);
    });
});
