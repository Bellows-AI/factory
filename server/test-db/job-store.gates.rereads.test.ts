import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
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

/** The chained follow-ups must land; a refusal here is a setup failure, not a branch under test. */
const followUp = (target: JobStore, root: string, command: string, userId: string): Promise<{ id: string }> =>
    target.createFollowUp(root, command, userId).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

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

describe.runIf(enabled)('gates on the job store: re-reads', () => {
    // The driver syncs the checkout after the claim, so the claim's gates answer can predate the
    // tree the run will actually see. The re-read is the freshness channel, lease-guarded like
    // every worker route.
    it('re-reads the gates for the lease holder, from the same checkout the claim read', async () => {
        const GATE_BAT_GITHUB_ID = 6007;
        const userId = await account(GATE_BAT_GITHUB_ID, 'gate-bat');
        // First answer: the stale tree the claim saw. Second: what the synced tree holds.
        const answers = [
            { config: null, error: null },
            { config: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] }, error: null },
        ];
        let call = 0;
        const reader = createJobStore({
            sql,
            orgId: ORG,
            gates: {
                readFor: async () => answers[Math.min(call++, answers.length - 1)]!,
            },
        });
        await reader.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        const claim = await reader.claim('driver-1', LEASE_SECONDS);

        // A stale-tree read of nothing omits gates from the claim entirely — the shape every
        // ungated job carries.
        expect(claim?.gates).toBeUndefined();
        const reread = await reader.rereadGates(claim!.id, claim!.leaseToken);
        expect(reread).toEqual({
            result: 'ok',
            gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
            gateError: null,
        });
    });

    it('guards the gates re-read with the lease, like every other worker route', async () => {
        const GATE_HARE_GITHUB_ID = 6008;
        const userId = await account(GATE_HARE_GITHUB_ID, 'gate-hare');
        await store.create('fix the bug', userId, { repo: 'acme/web', executor: null });
        await store.claim('driver-1', LEASE_SECONDS);

        // A stale token is a lost lease, not a missing row; an absent job is missing.
        expect(await store.rereadGates(ABSENT, TOKEN)).toEqual({ result: 'missing' });
    });

    // The gates the run satisfies live in the thread's worktree (issue #35), which is keyed by
    // the thread's ROOT job — so both the claim's read and the re-read must resolve the root
    // through the follow-up chain and hand THAT id to the reader.
    it('reads the gates of the thread root’s worktree, on the claim and on the re-read', async () => {
        const GATE_WOLF_GITHUB_ID = 6009;
        const userId = await account(GATE_WOLF_GITHUB_ID, 'gate-wolf');
        const seen: { workspacePath: string; repo: string; worktreeId: string | null }[] = [];
        const reader = createJobStore({
            sql,
            orgId: ORG,
            gates: {
                readFor: async (workspacePath, repo, worktreeId) => {
                    seen.push({ workspacePath, repo, worktreeId: worktreeId ?? null });
                    return { config: null, error: null };
                },
            },
        });
        // A finished root with a session, a finished follow-up on it, and a follow-up on the
        // follow-up — a three-row thread.
        await reader.create('root task', userId, { repo: 'acme/web', executor: null });
        const rootClaim = await reader.claim('driver-1', LEASE_SECONDS);
        const root = rootClaim!.id;
        await reader.session(root, rootClaim!.leaseToken, '33333333-3333-4333-8333-333333333333');
        await reader.complete(root, rootClaim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const child = await followUp(reader, root, 'adjust', userId);
        const childClaim = await reader.claim('driver-1', LEASE_SECONDS);
        await reader.session(child.id, childClaim!.leaseToken, '33333333-3333-4333-8333-333333333333');
        await reader.complete(child.id, childClaim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const grand = await followUp(reader, child.id, 'again', userId);

        // The grandchild is the only claimable row now; its claim reads the ROOT's worktree.
        seen.length = 0;
        const claim = await reader.claim('driver-1', LEASE_SECONDS);
        expect(claim?.id).toBe(grand.id);
        expect(claim?.rootJobId).toBe(root);
        expect(seen).toEqual([{ workspacePath: `${ORG}/${userId}`, repo: 'acme/web', worktreeId: root }]);

        // And the re-read resolves the same root, inside the lease guard.
        seen.length = 0;
        await reader.rereadGates(grand.id, claim!.leaseToken);
        expect(seen).toEqual([{ workspacePath: `${ORG}/${userId}`, repo: 'acme/web', worktreeId: root }]);
    });
});
