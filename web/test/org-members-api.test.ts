import { afterEach, describe, expect, it, vi } from 'vitest';
import { listMembers, setMemberRole } from '../src/api/orgMembers.js';

/**
 * The member roster's wire shape (issue 410): the PUT is the section's whole write surface, and
 * the GET's body is shape-checked before it reaches a render — a 2xx body that is not the roster
 * is refused as an error result, never handed on to throw in the component.
 */

const okWith = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => {
    vi.unstubAllGlobals();
});

const captureRequest = () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init: RequestInit) => {
            calls.push({ url, init });
            return Promise.resolve(okWith({ userId: 'u-1', role: 'admin' }));
        })
    );
    return calls;
};

describe('the member role write', () => {
    it('PUTs the role word with JSON headers', async () => {
        const calls = captureRequest();
        expect(await setMemberRole('00000000-0000-4000-8000-000000000001', 'admin')).toBe(null);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('/api/org/members/00000000-0000-4000-8000-000000000001/role');
        expect(calls[0]!.init.method).toBe('PUT');
        expect(calls[0]!.init.body).toBe(JSON.stringify({ role: 'admin' }));
        expect(calls[0]!.init.headers).toBeDefined();
    });

    it('reports a refusal instead of throwing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({ error: 'An organization must keep at least one admin', code: 'LAST_ADMIN' }),
                        {
                            status: 409,
                            headers: { 'content-type': 'application/json' },
                        }
                    )
                )
            )
        );
        const message = await setMemberRole('00000000-0000-4000-8000-000000000001', 'member');
        expect(message).toContain('at least one admin');
    });

    it('reports an expired session', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(new Response('', { status: 401 })))
        );
        const message = await setMemberRole('00000000-0000-4000-8000-000000000001', 'member');
        expect(message).toBe('Your session expired');
    });
});

describe('the roster read', () => {
    const member = {
        githubLogin: 'octocat',
        userId: '00000000-0000-4000-8000-000000000002',
        role: 'member',
        invitedAt: null,
        claimedAt: '2026-09-01T00:00:00.000Z',
        lastLoginAt: '2026-10-01T00:00:00.000Z',
    };

    it('returns the validated roster', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(okWith({ members: [member] })))
        );
        const result = await listMembers();
        expect(result).toEqual({ ok: true, members: [member] });
    });

    it('refuses a body that is not the roster shape', async () => {
        for (const body of [{}, { members: 'all of them' }, { members: [{ githubLogin: 7 }] }]) {
            vi.stubGlobal(
                'fetch',
                vi.fn(() => Promise.resolve(okWith(body)))
            );
            const result = await listMembers();
            expect(result.ok, JSON.stringify(body)).toBe(false);
        }
    });

    it('reports a refusal instead of throwing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            error: 'Only an organization admin can manage member roles',
                            code: 'FORBIDDEN',
                        }),
                        {
                            status: 403,
                            headers: { 'content-type': 'application/json' },
                        }
                    )
                )
            )
        );
        const result = await listMembers();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('admin');
    });
});
