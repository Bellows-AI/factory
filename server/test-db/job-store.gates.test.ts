import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { GateReport } from '../src/db/job-store-contract.js';
import type { JobStore } from '../src/db/job-store-read-model.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
const ORG = 'test-org';
const ABSENT = '00000000-0000-4000-8000-000000000000';
const TOKEN = '22222222-2222-4222-8222-222222222222';

const db = useTestDb({ max: 4 });

/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
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
        const GATE_CAT_GITHUB_ID = 6001;
        const userId = await account(GATE_CAT_GITHUB_ID, 'gate-cat');
        const gated = gatedStore({
            config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            error: null,
        });
        await gated.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await gated.claim('driver-1', LEASE_SECONDS);

        expect(claim?.repo).toBe('acme/web');
        expect(claim?.gates).toEqual({ image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] });
        expect(claim?.gateError).toBeNull();
    });

    it('carries a gateError value — not a throw — when the file cannot be honoured', async () => {
        const GATE_DOG_GITHUB_ID = 6002;
        const userId = await account(GATE_DOG_GITHUB_ID, 'gate-dog');
        const broken = gatedStore({ config: null, error: '.bellows.yaml line 3: unknown key "timeout"' });
        await broken.create('fix the bug', userId, { repo: 'acme/web', executor: null });

        const claim = await broken.claim('driver-1', LEASE_SECONDS);

        expect(claim?.gates).toBeNull();
        expect(claim?.gateError).toBe('.bellows.yaml line 3: unknown key "timeout"');
    });

    it('carries no gates at all for a repository that declares none', async () => {
        const PLAIN_CAT_GITHUB_ID = 6003;
        const userId = await account(PLAIN_CAT_GITHUB_ID, 'plain-cat');
        await store.create('echo hi', userId, { repo: 'acme/web', executor: null });

        const claim = await store.claim('driver-1', LEASE_SECONDS);

        // A store built without a gates reader — the state of every deployment and test that
        // predates the feature — reads as "no gates", not as an error.
        expect(claim?.gates).toBeUndefined();
        expect(claim?.gateError).toBeUndefined();
    });

    it('replaces the gate state on every report, and answers the last one on read', async () => {
        const GATE_OWL_GITHUB_ID = 6004;
        const userId = await account(GATE_OWL_GITHUB_ID, 'gate-owl');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', LEASE_SECONDS);
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
        const GATE_FOX_GITHUB_ID = 6005;
        const userId = await account(GATE_FOX_GITHUB_ID, 'gate-fox');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        await store.claim('driver-1', LEASE_SECONDS);
        const report: GateReport[] = [{ name: 'test', status: 'passed', exitCode: 0, output: null }];

        // A stale token is a lost lease, not a missing row; an absent job is missing.
        expect(await store.gates(ABSENT, TOKEN, report)).toBe('missing');
    });

    it('omits gates from the list projection, like output', async () => {
        const GATE_EMU_GITHUB_ID = 6006;
        const userId = await account(GATE_EMU_GITHUB_ID, 'gate-emu');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        await store.gates(claim!.id, claim!.leaseToken, [
            { name: 'test', status: 'passed', exitCode: 0, output: 'all green' },
        ]);

        const listed = await store.list({ limit: 10 });
        expect(listed).toHaveLength(1);
        expect(listed[0]?.gates).toBeNull();
    });
});
