import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { createJobStore, type GateReport, type JobStore } from '../src/db/job-store.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES the job table before every test. Requiring a `_test` database name is the
 * guard, because the failure is silent: the tests pass and the queue is simply gone.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite truncates its tables, and "${name}" is not a test database.`,
        );
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;
let store: JobStore;
const ORG = 'test-org';
const ABSENT = '00000000-0000-4000-8000-000000000000';
const TOKEN = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 4 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    store = createJobStore({ sql, orgId: ORG });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    await sql`truncate job`;
});

/** A real account for created_by to point at — a gates claim needs an author for a workspace. */
const account = async (githubUserId: number, login: string): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
        on conflict (github_user_id) do update set github_login = excluded.github_login
        returning id
    `;
    return row!.id;
};

/** A store whose gates reader answers from memory: the SQL is under test here, not the file read. */
const gatedStore = (answer: { config: unknown; error: string | null }): JobStore =>
    createJobStore({
        sql,
        orgId: ORG,
        gates: {
            readFor: async () => answer as { config: null; error: string | null },
        },
    });

describe.runIf(enabled)('gates on the job store', () => {
    it('carries the parsed declaration and the repo label on a gated claim', async () => {
        const userId = await account(6001, 'gate-cat');
        const gated = gatedStore({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
        });
        await gated.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await gated.claim('driver-1', 300);

        expect(claim?.repo).toBe('acme/web');
        expect(claim?.gates).toEqual({ image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });
        expect(claim?.gateError).toBeNull();
    });

    it('carries a gateError value — not a throw — when the file cannot be honoured', async () => {
        const userId = await account(6002, 'gate-dog');
        const broken = gatedStore({ config: null, error: '.bellows.yaml line 3: unknown key "timeout"' });
        await broken.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await broken.claim('driver-1', 300);

        expect(claim?.gates).toBeNull();
        expect(claim?.gateError).toBe('.bellows.yaml line 3: unknown key "timeout"');
    });

    it('carries no gates at all for a repository that declares none', async () => {
        const userId = await account(6003, 'plain-cat');
        await store.create('echo hi', userId, { repo: 'acme/web', executor: null });

        const claim = await store.claim('driver-1', 300);

        // A store built without a gates reader — the state of every deployment and test that
        // predates the feature — reads as "no gates", not as an error.
        expect(claim?.gates).toBeUndefined();
        expect(claim?.gateError).toBeUndefined();
    });

    it('replaces the gate state on every report, and answers the last one on read', async () => {
        const userId = await account(6004, 'gate-owl');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', 300);
        const running: GateReport[] = [{ name: 'test', status: 'running', exitCode: null, output: null }];
        const finished: GateReport[] = [{ name: 'test', status: 'failed', exitCode: 3, output: 'boom' }];

        expect(await store.gates(claim!.id, claim!.leaseToken, running)).toBe('ok');
        expect((await store.get(claim!.id))?.gates).toEqual(running);
        expect(await store.gates(claim!.id, claim!.leaseToken, finished)).toBe('ok');
        // REPLACE, never append: the second report is the whole truth, current/last only.
        expect((await store.get(claim!.id))?.gates).toEqual(finished);
        expect((await store.thread(claim!.id))?.[0]?.gates).toEqual(finished);
    });

    it('guards gate reports with the lease, like every other worker write', async () => {
        const userId = await account(6005, 'gate-fox');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        await store.claim('driver-1', 300);
        const report: GateReport[] = [{ name: 'test', status: 'passed', exitCode: 0, output: null }];

        // A stale token is a lost lease, not a missing row; an absent job is missing.
        expect(await store.gates(ABSENT, TOKEN, report)).toBe('missing');
    });

    it('omits gates from the list projection, like output', async () => {
        const userId = await account(6006, 'gate-emu');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', 300);
        await store.gates(claim!.id, claim!.leaseToken, [
            { name: 'test', status: 'passed', exitCode: 0, output: 'all green' },
        ]);

        const listed = await store.list({ limit: 10 });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.gates).toBeNull();
    });
});
