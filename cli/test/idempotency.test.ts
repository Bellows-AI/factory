import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';

const ENV = { FACTORY_URL: 'http://board', FACTORY_TOKEN: 'fat_abc' };
const KEY = 'attempt-0001-abcd';

interface Sent {
    url: string;
    key: string | null;
}

/** One CLI run against a board that answers with `respond`, recording the key header of each request. */
async function cli(argv: string[], respond: () => Response | Promise<Response>) {
    const out: string[] = [];
    const err: string[] = [];
    const sent: Sent[] = [];
    const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        sent.push({ url: String(url), key: new Headers(init?.headers).get('idempotency-key') });
        return respond();
    }) as unknown as typeof globalThis.fetch;
    const code = await run(argv, {
        env: ENV,
        fetch,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join(''), sent };
}

const created = (headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ id: 'job-1', status: 'queued' }), {
        status: 201,
        headers: { 'content-type': 'application/json', ...headers },
    });

describe('--idempotency-key', () => {
    it('sends the key on a create and on a follow-up, and nothing when none is named', async () => {
        const create = await cli(['job', 'create', 'echo hi', '--idempotency-key', KEY], () => created());
        const followUp = await cli(['job', 'follow-up', 'job-1', 'again', '--idempotency-key', KEY], () => created());
        const keyless = await cli(['job', 'create', 'echo hi'], () => created());

        expect(create.sent).toEqual([{ url: 'http://board/api/jobs', key: KEY }]);
        expect(followUp.sent).toEqual([{ url: 'http://board/api/jobs/job-1/follow-up', key: KEY }]);
        expect(keyless.sent[0]!.key).toBeNull();
    });

    it('keeps stdout the same on a replay and says so on stderr and in the json data', async () => {
        const replay = await cli(['job', 'create', 'echo hi', '--idempotency-key', KEY], () =>
            created({ 'idempotency-replayed': 'true' })
        );
        expect(replay.code).toBe(0);
        expect(replay.out).toBe('queued job-1\n');
        expect(replay.err).toMatch(/^replayed:/);

        const asJson = await cli(['job', 'create', 'echo hi', '--idempotency-key', KEY, '--json'], () =>
            created({ 'idempotency-replayed': 'true' })
        );
        expect(JSON.parse(asJson.out).data).toEqual({ id: 'job-1', status: 'queued', replayed: true });
        expect(asJson.err).toBe('');
    });

    it('does not mark a first answer as a replay', async () => {
        const first = await cli(['job', 'create', 'echo hi', '--idempotency-key', KEY, '--json'], () => created());
        expect(JSON.parse(first.out).data).toEqual({ id: 'job-1', status: 'queued' });
    });

    it('surfaces the board refusing a key reused for a different request', async () => {
        const refused = await cli(['job', 'create', 'echo other', '--idempotency-key', KEY], () =>
            Response.json(
                {
                    error: 'This Idempotency-Key was already used for a different request',
                    code: 'IDEMPOTENCY_KEY_REUSED',
                },
                { status: 409 }
            )
        );
        expect(refused.code).toBe(1);
        expect(refused.err).toContain('[IDEMPOTENCY_KEY_REUSED]');
        expect(refused.err).not.toContain('may have been applied');
    });

    describe('an uncertain write outcome', () => {
        const unreachable = () => {
            throw new TypeError('fetch failed');
        };

        it.each([
            ['no answer', unreachable],
            ['a 503', () => Response.json({ error: 'down', code: 'UNAVAILABLE' }, { status: 503 })],
            ['an unreadable 201', () => new Response('<html>', { status: 201 })],
        ])('after %s, names the key to repeat the command with', async (_label, respond) => {
            const result = await cli(['job', 'create', 'echo hi', '--idempotency-key', KEY], respond);
            expect(result.code).not.toBe(0);
            expect(result.err).toContain(`repeat the same command with --idempotency-key ${KEY}`);
        });

        it('on a follow-up too', async () => {
            const result = await cli(['job', 'follow-up', 'job-1', 'again', '--idempotency-key', KEY], unreachable);
            expect(result.err).toContain(`--idempotency-key ${KEY}`);
        });

        it('without a key, warns that a repeat could queue a second task', async () => {
            const result = await cli(['job', 'create', 'echo hi'], unreachable);
            expect(result.err).toContain('may have been applied');
            expect(result.err).toContain('pass --idempotency-key');
        });

        it('does not claim uncertainty about a refusal the board decided', async () => {
            const result = await cli(['job', 'create', 'echo hi'], () =>
                Response.json({ error: 'bad', code: 'BAD_COMMAND' }, { status: 400 })
            );
            expect(result.err).not.toContain('may have been applied');
        });
    });
});
