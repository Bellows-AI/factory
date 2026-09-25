import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDefaultWorkflowSettings, putDefaultWorkflowSettings } from '../src/api/useDefaultWorkflowSettings.js';
import * as useSession from '../src/api/useSession.js';

/**
 * The wire-level halves of the default-workflow settings hook, pinned directly the way
 * `listExecutorConfigs` is (`use-workspace.test.ts`): each is a plain async function the hook
 * wires state around, so the request/response contract is asserted here rather than only through
 * a page-level render that never runs an effect.
 */

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('fetchDefaultWorkflowSettings', () => {
    it('issues exactly one GET and lands the stored pair', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValue(
                json({ reviewReconciliation: false, mergeConflictAutofix: true, updatedAt: '2026-09-01T00:00:00Z' })
            );
        vi.stubGlobal('fetch', fetch);
        const result = await fetchDefaultWorkflowSettings();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith('/api/workflows/default-settings');
        expect(result).toEqual({
            ok: true,
            data: { reviewReconciliation: false, mergeConflictAutofix: true, updatedAt: '2026-09-01T00:00:00Z' },
        });
    });

    it('reads the missing-row defaults exactly as served: both steps on, updatedAt null', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(json({ reviewReconciliation: true, mergeConflictAutofix: true, updatedAt: null }))
        );
        const result = await fetchDefaultWorkflowSettings();
        expect(result).toEqual({
            ok: true,
            data: { reviewReconciliation: true, mergeConflictAutofix: true, updatedAt: null },
        });
    });

    it('marks the store unavailable on a 503, distinct from a transient error', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValue(
                    json({ error: 'No workflow settings store', code: 'WORKFLOW_SETTINGS_UNAVAILABLE' }, 503)
                )
        );
        expect(await fetchDefaultWorkflowSettings()).toEqual({ ok: false, unavailable: true, error: null });
    });

    it('hands a 401 to the session gate instead of rendering an error', async () => {
        const report = vi.spyOn(useSession, 'reportUnauthenticated').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
        const result = await fetchDefaultWorkflowSettings();
        expect(report).toHaveBeenCalled();
        expect(result).toEqual({ ok: false, unavailable: false, error: null });
    });

    it('carries any other refusal as a transient error, not unavailable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'boom' }, 500)));
        expect(await fetchDefaultWorkflowSettings()).toEqual({ ok: false, unavailable: false, error: 'boom' });

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 500)));
        expect(await fetchDefaultWorkflowSettings()).toEqual({
            ok: false,
            unavailable: false,
            error: 'Could not load the workflow defaults (500)',
        });
    });

    it('survives a network failure with an error result, not a throw', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        expect(await fetchDefaultWorkflowSettings()).toEqual({ ok: false, unavailable: false, error: 'offline' });
    });
});

describe('putDefaultWorkflowSettings', () => {
    it('PUTs exactly the complete pair and adopts the echoed response', async () => {
        const fetch = vi
            .fn()
            .mockResolvedValue(
                json({ reviewReconciliation: false, mergeConflictAutofix: false, updatedAt: '2026-09-02T00:00:00Z' })
            );
        vi.stubGlobal('fetch', fetch);
        const result = await putDefaultWorkflowSettings({ reviewReconciliation: false, mergeConflictAutofix: false });
        expect(fetch).toHaveBeenCalledWith('/api/workflows/default-settings', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reviewReconciliation: false, mergeConflictAutofix: false }),
        });
        expect(result).toEqual({
            ok: true,
            data: { reviewReconciliation: false, mergeConflictAutofix: false, updatedAt: '2026-09-02T00:00:00Z' },
        });
    });

    it('marks the store unavailable on a 503', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValue(
                    json({ error: 'No workflow settings store', code: 'WORKFLOW_SETTINGS_UNAVAILABLE' }, 503)
                )
        );
        expect(await putDefaultWorkflowSettings({ reviewReconciliation: true, mergeConflictAutofix: true })).toEqual({
            ok: false,
            unavailable: true,
            error: 'No workflow settings store',
        });
    });

    it('hands a 401 to the session gate and reports the expired session as the refusal', async () => {
        const report = vi.spyOn(useSession, 'reportUnauthenticated').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
        const result = await putDefaultWorkflowSettings({ reviewReconciliation: true, mergeConflictAutofix: true });
        expect(report).toHaveBeenCalled();
        expect(result).toEqual({ ok: false, unavailable: false, error: 'Your session expired' });
    });

    it('carries the board refusal as the save error', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValue(
                    json({ error: 'reviewReconciliation must be a boolean', code: 'BAD_DEFAULT_WORKFLOW' }, 400)
                )
        );
        expect(await putDefaultWorkflowSettings({ reviewReconciliation: true, mergeConflictAutofix: true })).toEqual({
            ok: false,
            unavailable: false,
            error: 'reviewReconciliation must be a boolean',
        });
    });

    it('survives a network failure with an error result, not a throw', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        expect(await putDefaultWorkflowSettings({ reviewReconciliation: true, mergeConflictAutofix: true })).toEqual({
            ok: false,
            unavailable: false,
            error: 'offline',
        });
    });
});
