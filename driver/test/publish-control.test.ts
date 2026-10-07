import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { createGateServer } from '../src/gates.js';
import { newJobState } from '../src/loop-attempt.js';
import { createPublishRelay } from '../src/loop-publish.js';
import type { LoopRuntime } from '../src/loop-types.js';
import type { PublishResult } from '../src/publish.js';
import type { PublishRelay, PublishVerdict } from '../src/publish-control.js';
import type { PublishOptions } from '../src/publish.js';

const OK_STATUS = 200;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const CONFLICT_STATUS = 409;
const PAYLOAD_TOO_LARGE_STATUS = 413;
const NOT_IMPLEMENTED_STATUS = 501;
const BAD_GATEWAY_STATUS = 502;

const JOB = {
    id: '00000001-1111-4111-8111-111111111111',
    command: 'job 1',
    leaseToken: '00000001-2222-4222-8222-222222222222',
} as BoardJob;

const LANDED: PublishResult = {
    ok: true,
    published: true,
    branch: 'fix/10',
    prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
    reason: null,
    repository: 'Bellows-AI/factory',
    baseBranch: 'main',
    prNumber: 42,
};

const manager = { acquire: async () => {}, runGate: async () => ({ exitCode: 0, output: '' }) };

describe('the control server: POST /publish', () => {
    const post = (port: number, token: string, body = '') =>
        fetch(`http://127.0.0.1:${port}/publish`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body,
        });

    async function opened(relay: PublishRelay | undefined) {
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.openControl('tok-p', undefined, relay);
        return { server, port: await server.listen() };
    }

    it('answers what the relay published', async () => {
        const { server, port } = await opened({ publish: async () => LANDED });
        const answer = await post(port, 'tok-p');
        expect(answer.status).toBe(OK_STATUS);
        await expect(answer.json()).resolves.toEqual({
            published: true,
            branch: 'fix/10',
            prUrl: LANDED.prUrl,
            prNumber: 42,
            reason: null,
        });
        await server.close();
    });

    it.each<[PublishVerdict, number]>([
        ['forbidden', FORBIDDEN_STATUS],
        ['unsupported', NOT_IMPLEMENTED_STATUS],
        ['gone', UNAUTHORIZED_STATUS],
        [{ ...LANDED, ok: false, published: false, reason: 'git push: rejected' }, BAD_GATEWAY_STATUS],
    ])('maps %j to %i', async (verdict, status) => {
        const { server, port } = await opened({ publish: async () => verdict });
        expect((await post(port, 'tok-p')).status).toBe(status);
        await server.close();
    });

    it('answers a failed publish with its reason, and a nothing-to-publish as 200 unpublished', async () => {
        const failing = await opened({ publish: async () => ({ ...LANDED, ok: false, reason: 'git push: nope' }) });
        await expect((await post(failing.port, 'tok-p')).json()).resolves.toEqual({ error: 'git push: nope' });
        await failing.server.close();

        const nothing = await opened({
            publish: async () => ({ ...LANDED, published: false, prUrl: null, reason: 'nothing unpushed' }),
        });
        const answer = await post(nothing.port, 'tok-p');
        expect(answer.status).toBe(OK_STATUS);
        await expect(answer.json()).resolves.toMatchObject({ published: false, reason: 'nothing unpushed' });
        await nothing.server.close();
    });

    it('refuses an unknown token, a gate token and a closed one', async () => {
        const server = createGateServer({ host: '127.0.0.1', manager });
        server.register('gate-tok', { key: 'k', image: 'node:24', job: JOB, gates: [] });
        server.openControl('tok-p', undefined, { publish: async () => LANDED });
        const port = await server.listen();

        expect((await post(port, 'nope')).status).toBe(UNAUTHORIZED_STATUS);
        expect((await post(port, 'gate-tok')).status).toBe(UNAUTHORIZED_STATUS);
        server.closeControl('tok-p');
        expect((await post(port, 'tok-p')).status).toBe(UNAUTHORIZED_STATUS);
        await server.close();
    });

    it('says unsupported when the attempt has no publisher, and only POST is the route', async () => {
        const { server, port } = await opened(undefined);
        expect((await post(port, 'tok-p')).status).toBe(NOT_IMPLEMENTED_STATUS);
        const get = await fetch(`http://127.0.0.1:${port}/publish`, { headers: { authorization: 'Bearer tok-p' } });
        expect(get.status).toBe(NOT_FOUND_STATUS);
        await server.close();
    });

    it('refuses a body past the limit', async () => {
        const { server, port } = await opened({ publish: async () => LANDED });
        expect((await post(port, 'tok-p', 'x'.repeat(4096))).status).toBe(PAYLOAD_TOO_LARGE_STATUS);
        await server.close();
    });

    it('runs one publish at a time per token: a second call is told, never queued', async () => {
        let release = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        const { server, port } = await opened({
            publish: async () => {
                calls += 1;
                await held;
                return LANDED;
            },
        });

        const first = post(port, 'tok-p');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect((await post(port, 'tok-p')).status).toBe(CONFLICT_STATUS);
        release();
        expect((await first).status).toBe(OK_STATUS);
        expect((await post(port, 'tok-p')).status).toBe(OK_STATUS);
        expect(calls).toBe(2);
        await server.close();
    });
});

describe('the publish relay: what an attempt may publish', () => {
    interface Calls {
        asks: number;
        published: { token: string | undefined; options: PublishOptions | undefined }[];
    }
    const relayFor = (
        over: { job?: Partial<BoardJob>; publishGit?: LoopRuntime['runner']['publishGit']; token?: string | null } = {},
        onAsk: () => void = () => {}
    ) => {
        const calls: Calls = { asks: 0, published: [] };
        const state = newJobState();
        const runner = {
            publishGit:
                'publishGit' in over
                    ? over.publishGit
                    : async (_job: BoardJob, token?: string, options?: PublishOptions) => {
                          calls.published.push({ token, options });
                          return LANDED;
                      },
        };
        const rt = {
            runner,
            board: {
                publishToken: async () => {
                    calls.asks += 1;
                    onAsk();
                    return 'token' in over ? over.token : 'ghs_fresh';
                },
            },
            log: () => {},
        } as unknown as LoopRuntime;
        return { relay: createPublishRelay(rt, { ...JOB, ...over.job }, state), state, calls };
    };

    it('publishes a draft with the fresh credential and remembers what landed', async () => {
        const { relay, state, calls } = relayFor();
        await expect(relay.publish()).resolves.toEqual(LANDED);
        expect(calls.published).toEqual([{ token: 'ghs_fresh', options: { draft: true } }]);
        expect(state.draftPublication).toEqual(LANDED);
    });

    it('falls back to the claim env when the board has no fresh credential', async () => {
        const { relay, calls } = relayFor({ token: null });
        await relay.publish();
        expect(calls.published[0]?.token).toBeUndefined();
    });

    it('is the board’s on a workflow task whose publication belongs to another step', async () => {
        const { relay, calls } = relayFor({ job: { publish: false } });
        await expect(relay.publish()).resolves.toBe('forbidden');
        expect(calls.asks).toBe(0);
        expect(calls.published).toEqual([]);
    });

    it('is unsupported on a runner that cannot push', async () => {
        const { relay } = relayFor({ publishGit: undefined });
        await expect(relay.publish()).resolves.toBe('unsupported');
    });

    it.each(['stopped', 'lost', 'removed', 'draining', 'finished'] as const)(
        'publishes nothing once the attempt is %s',
        async (flag) => {
            const { relay, state, calls } = relayFor();
            state[flag] = true;
            await expect(relay.publish()).resolves.toBe('gone');
            expect(calls.asks).toBe(0);
            expect(calls.published).toEqual([]);
        }
    );

    it('publishes nothing when the lease is lost while the credential is asked for', async () => {
        const holder: { state?: ReturnType<typeof newJobState> } = {};
        const made = relayFor({}, () => {
            if (holder.state) holder.state.lost = true;
        });
        holder.state = made.state;
        await expect(made.relay.publish()).resolves.toBe('gone');
        expect(made.calls.published).toEqual([]);
        expect(made.state.draftPublication).toBeNull();
    });

    it('answers a publish that throws as a failure, and keeps no draft', async () => {
        const { relay, state } = relayFor({
            publishGit: async () => {
                throw new Error('daemon gone');
            },
        });
        await expect(relay.publish()).resolves.toMatchObject({ ok: false, reason: 'the publish threw: daemon gone' });
        expect(state.draftPublication).toBeNull();
    });

    it('keeps no draft for a publish that landed nothing', async () => {
        const nothing: PublishResult = { ...LANDED, published: false, prUrl: null, reason: 'nothing unpushed' };
        const { relay, state } = relayFor({ publishGit: async () => nothing });
        await expect(relay.publish()).resolves.toEqual(nothing);
        expect(state.draftPublication).toBeNull();
    });
});
