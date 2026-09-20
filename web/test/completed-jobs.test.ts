import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollCompletedJobs } from '../src/api/useCompletedJobs.js';
import type { Job } from '../src/api/useJobs.js';
import * as useSession from '../src/api/useSession.js';

/**
 * The board poll the dashboard's task section runs, pinned at the wire: the EIGHT-row bound
 * travels in the request (the server bounds the list; the panel renders what it gets), a
 * failed tick keeps the last good rows, and the server's own error message wins over the
 * status-line fallback.
 */

const job = (id: string): Job =>
    ({
        id,
        command: 'do the thing',
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        claimedBy: null,
        createdBy: null,
        author: null,
        stoppedBy: null,
        doneBy: null,
        sessionId: null,
        remoteSessionId: null,
        exitCode: 0,
        output: null,
        summary: null,
        gates: null,
        runtime: null,
        repo: null,
        executor: null,
        followUpTo: null,
        rootJobId: id,
        doneAt: null,
        cancelRequestedAt: null,
        workspacePath: null,
        createdAt: '2026-08-21T12:00:00.000Z',
        startedAt: null,
        finishedAt: '2026-08-21T12:20:00.000Z',
        wallClockMs: null,
        taskWallClockMs: null,
    }) as Job;

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('pollCompletedJobs', () => {
    it('requests the terminal list bounded at eight rows', async () => {
        const fetch = vi.fn().mockResolvedValue(json({ jobs: [] }));
        vi.stubGlobal('fetch', fetch);
        const rearm = vi.fn();
        await pollCompletedJobs(new AbortController().signal, vi.fn(), vi.fn(), rearm);
        expect(fetch).toHaveBeenCalledWith('/api/jobs?status=terminal&limit=8', expect.anything());
        expect(rearm).toHaveBeenCalledWith(30_000);
    });

    it('lands the rows and clears no error it was not given', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ jobs: [job('j1')] })));
        const land = vi.fn();
        const fail = vi.fn();
        await pollCompletedJobs(new AbortController().signal, land, fail, vi.fn());
        expect(land).toHaveBeenCalledWith([expect.objectContaining({ id: 'j1' })]);
        expect(fail).not.toHaveBeenCalled();
    });

    it('keeps the last good rows when a later tick fails', async () => {
        // Two rounds over the SAME land/fail accumulators: the hook holds `jobs` across ticks,
        // so a failure must ADD an error without taking the rows away.
        const responses = [json({ jobs: [job('good')] }), json({ error: 'board exploded' }, 500)];
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(() => Promise.resolve(responses.shift() ?? json({ jobs: [] })))
        );
        const landed: Job[][] = [];
        const failed: string[] = [];
        const signal = new AbortController().signal;
        await pollCompletedJobs(
            signal,
            (jobs) => landed.push(jobs),
            (e) => failed.push(e),
            vi.fn()
        );
        await pollCompletedJobs(
            signal,
            (jobs) => landed.push(jobs),
            (e) => failed.push(e),
            vi.fn()
        );
        expect(landed).toHaveLength(1);
        expect(landed[0]?.[0]?.id).toBe('good');
        expect(failed).toEqual(['board exploded']);
    });

    it('falls back to the status line when the body names no error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 503)));
        const fail = vi.fn();
        await pollCompletedJobs(new AbortController().signal, vi.fn(), fail, vi.fn());
        expect(fail).toHaveBeenCalledWith('Request failed (503)');
    });

    it('does nothing when the signal is already aborted', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        const controller = new AbortController();
        controller.abort();
        await pollCompletedJobs(controller.signal, vi.fn(), vi.fn(), vi.fn());
        expect(fetch).not.toHaveBeenCalled();
    });

    it('hands a 401 to the session gate and stops polling', async () => {
        // An expired session is not a board failure: the gate takes over, and the poll must
        // NOT rearm — a dead session must not become an infinite re-auth loop.
        const report = vi.spyOn(useSession, 'reportUnauthenticated').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
        const rearm = vi.fn();
        await pollCompletedJobs(new AbortController().signal, vi.fn(), vi.fn(), rearm);
        expect(report).toHaveBeenCalled();
        expect(rearm).not.toHaveBeenCalled();
    });
});
