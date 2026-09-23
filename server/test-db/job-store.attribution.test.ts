import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import { createOrgOfLease } from '../src/db/job-store-org-resolvers.js';
import type { JobStore } from '../src/db/job-store-read-model.js';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: JobStore;
/** The org-less lease resolver the branch-ingest credential is verified against. */
let orgOfLease: (jobId: string, leaseToken: string) => Promise<string | null>;

const ORG = 'test-org';
const OTHER_ORG = 'other-org';
/** A well-formed uuid, only ever used where the job or the lease is expected not to exist. */
const ABSENT = '00000000-0000-4000-8000-000000000000';
const SESSION = '33333333-3333-4333-8333-333333333333';
/** A second session, for proving a follow-up chains the NEWEST session and not the root's. */
const CHAIN = '55555555-5555-4555-8555-555555555555';
/** Shaped like a real one: opaque, prefixed, and not a uuid. */
const REMOTE = 'cse_015tb2nHhHNrBuL7ZDhn9Wx5';
/** A lease long enough that nothing in this suite outlives it by accident. */
const LEASE_SECONDS = 300;

/**
 * The env-forwarding cases write env_var rows, whose org is foreign-keyed — hence the seeded org.
 * `max: 8` is higher than the app pool's 4: the claim exclusivity test needs real parallelism,
 * and a pool of two would serialise it into a test that passes for the wrong reason.
 */
const db = useTestDb({ max: 8, orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
    orgOfLease = createOrgOfLease({ sql });
});

/**
 * Queues an unattributed job — the state every job written before accounts existed is in.
 *
 * `created_by` is a required parameter rather than an optional one, so that the route has to name
 * the authenticated caller rather than defaulting quietly; these cases are about leases, not
 * attribution, so they pass null explicitly. The attribution cases below pass a real account.
 */
const queue = (command: string) => store.create(command, null, { repo: null, executor: null });

/**
 * Chains a follow-up that MUST be created. The refusal branches get their own dedicated cases
 * below; everywhere else a refusal is a failure of the setup, so it throws instead of hiding in
 * the union the store honestly returns.
 */
const mustFollowUp = (root: string, command: string, userId: string | null): Promise<{ id: string }> =>
    store.createFollowUp(root, command, userId).then((ref) => {
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref;
    });

/** Reads the stamped moment off a markDone answer, refusing the refusal strings. */
const doneAt = (result: Awaited<ReturnType<JobStore['markDone']>>): string => {
    if (typeof result === 'string') throw new Error(`markDone refused: ${result}`);
    return result.doneAt;
};

/** Ages a lease into the past. Deterministic where sleeping for a one-second lease is not. */
const expireLease = (id: string) => sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

const row = (id: string) =>
    sql<{ status: string; attempts: number; claimed_by: string | null; started_at: Date | null }[]>`
        select status, attempts, claimed_by, started_at from job where id = ${id}
    `;
describe.runIf(enabled)('attribution', () => {
    /**
     * A real account for created_by to point at. Written directly rather than through the auth
     * store: this file is about the job table, and going through a sign-in would make these cases
     * fail for reasons that have nothing to do with them.
     */
    const account = async (githubUserId: number, login: string): Promise<string> => {
        const [row] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login) values (${githubUserId}, ${login})
            on conflict (github_user_id) do update set github_login = excluded.github_login
            returning id
        `;
        return row!.id;
    };

    it('records who queued a job and reports it back on read', async () => {
        const OCTOCAT_GITHUB_ID = 5001;
        const userId = await account(OCTOCAT_GITHUB_ID, 'octocat');

        const { id } = await store.create('echo hi', userId, { repo: null, executor: null });

        expect((await store.get(id))?.createdBy).toBe(userId);
    });

    it('reports the author and their workspace to the worker that claims it', async () => {
        const OCTODOG_GITHUB_ID = 5002;
        const userId = await account(OCTODOG_GITHUB_ID, 'octodog');
        await store.create('echo hi', userId, { repo: null, executor: null });

        const claim = await store.claim('driver-1', LEASE_SECONDS);
        // `userId` is still the seam the per-user credential work will read; `workspacePath` is
        // what the workspace half of it turned into, and the driver runs the job there.
        expect(claim?.userId).toBe(userId);
        expect(claim?.workspacePath).toBe(`${ORG}/${userId}`);
    });

    it('claims an unattributed job with a null author rather than refusing it', async () => {
        // Every job written before this migration is in this state, and they must still run.
        await queue('echo hi');
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        expect(claim?.userId).toBeNull();
        // No member, so no workspace. The driver fails such a job rather than choosing a directory.
        expect(claim?.workspacePath).toBeNull();
    });

    it('reports no workspace path when the deployment has no workspace root', async () => {
        /*
         * Naming a directory that was never created would be worse than saying nothing: `docker
         * run -w` CREATES a missing workdir, so the runner would start in an empty directory and
         * the job would look like it ran. The driver's null check only catches that if the board
         * is honest here.
         */
        const rootless = createJobStore({ sql, orgId: ORG, hasWorkspaces: false });
        const NOWHERE_GITHUB_ID = 5004;
        const userId = await account(NOWHERE_GITHUB_ID, 'nowhere');
        await rootless.create('echo hi', userId, { repo: null, executor: null });

        const claim = await rootless.claim('driver-1', LEASE_SECONDS);
        expect(claim?.userId).toBe(userId);
        expect(claim?.workspacePath).toBeNull();
    });

    it('carries the stacked environment on the claim, resolved for the author and repo label', async () => {
        const ENV_CAT_GITHUB_ID = 5005;
        const userId = await account(ENV_CAT_GITHUB_ID, 'env-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await envStore.replaceOrg([{ name: 'CORE', value: 'org-value', isSecret: true }]);
        await envStore.replaceWorkspace(userId, [{ name: 'CORE', value: 'workspace-value', isSecret: false }]);
        await envStore.replaceRepo('Bellows-AI', 'bellows.ai', [
            { name: 'CORE', value: 'repo-value', isSecret: false },
            { name: 'REPO_ONLY', value: 'repo-only-value', isSecret: true },
        ]);
        const envAware = createJobStore({ sql, orgId: ORG, env: envStore });

        await envAware.create('echo hi', userId, { repo: 'Bellows-AI/bellows.ai', executor: null });
        const claim = await envAware.claim('driver-1', LEASE_SECONDS);
        // Repo beats workspace beats org on the collision, and the secrets travel as values —
        // injection is what they are for.
        expect(claim?.env).toEqual({ CORE: 'repo-value', REPO_ONLY: 'repo-only-value' });

        // A job with no repo label gets org + workspace only.
        await envAware.create('echo hi', userId, { repo: null, executor: null });
        const second = await envAware.claim('driver-2', LEASE_SECONDS);
        expect(second?.env).toEqual({ CORE: 'workspace-value' });
    });

    it('carries no environment when the board was built without a resolver', async () => {
        const PLAIN_CAT_GITHUB_ID = 5006;
        const userId = await account(PLAIN_CAT_GITHUB_ID, 'plain-cat');
        await store.create('echo hi', userId, { repo: null, executor: null });
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        expect(claim?.env).toBeUndefined();
    });

    it('leaves a job claimable when the env resolver fails, without burning an attempt', async () => {
        /*
         * The claim's UPDATE is only safe to keep if the resolver answers: a half-claim — running,
         * with a lease nobody holds and an attempt already burned — would strand the job until the
         * lease expired on every retry, walking it to dead on an infrastructure blip.
         */
        const FLAKY_CAT_GITHUB_ID = 5007;
        const userId = await account(FLAKY_CAT_GITHUB_ID, 'flaky-cat');
        let fail = true;
        const flaky = createJobStore({
            sql,
            orgId: ORG,
            env: {
                resolveFor: async () => {
                    if (fail) throw new Error('env store down');
                    return {};
                },
            },
        });
        await flaky.create('echo hi', userId, { repo: null, executor: null });

        await expect(flaky.claim('driver-1', LEASE_SECONDS)).rejects.toThrow('env store down');

        // The store is back: the job is still queued, still attempt 0, and the very next claim
        // takes it with a full environment.
        fail = false;
        const claim = await flaky.claim('driver-2', LEASE_SECONDS);
        expect(claim?.id).toBeTruthy();
        expect(claim?.attempts).toBe(1);
    });

    /** Unique per run — a shared factory_test database must not let one suite's accounts collide with another's. */
    const mintedAccountId = (() => {
        const BASE = 50_000;
        const SPREAD = 100_000;
        let next = BASE + Math.floor(Math.random() * SPREAD);
        return () => ++next;
    })();

    it('mints the installation token onto the claim, under the stacked environment', async () => {
        // Issue #28: executors orchestrate github workflows (PRs, commits, CI reads). Under an
        // app-mode board the installation token rides the claim's env, minted at claim time — the
        // seam docs/env.md reserved for exactly this.
        const userId = await account(mintedAccountId(), 'minted-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await envStore.replaceOrg([{ name: 'CORE', value: 'org-value', isSecret: true }]);
        const minted = createJobStore({
            sql,
            orgId: ORG,
            env: envStore,
            githubToken: { fresh: async () => 'ghs_example' },
        });

        await minted.create('echo hi', userId, { repo: null, executor: null });
        const claim = await minted.claim('driver-1', LEASE_SECONDS);
        // The mint is the base layer: configured values ride above it.
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'ghs_example', CORE: 'org-value' });
    });

    it('lets a configured GITHUB_TOKEN beat the mint', async () => {
        /*
         * A credential an operator configured in a scope is deliberate; the mint fills only the
         * gap. Silently replacing it with a different token would be a failure nobody notices.
         */
        const userId = await account(mintedAccountId(), 'tokened-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await envStore.replaceOrg([{ name: 'GITHUB_TOKEN', value: 'operator-pat', isSecret: true }]);
        const minted = createJobStore({
            sql,
            orgId: ORG,
            env: envStore,
            githubToken: { fresh: async () => 'ghs_example' },
        });

        await minted.create('echo hi', userId, { repo: null, executor: null });
        const claim = await minted.claim('driver-1', LEASE_SECONDS);
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'operator-pat' });
    });

    it('leaves a job claimable when the mint fails, without burning an attempt', async () => {
        /*
         * The resolver-failure precedent, one layer down: the mint is a remote call on the claim
         * path, and a half-claim taken before it failed must roll back exactly the same way.
         */
        const userId = await account(mintedAccountId(), 'flaky-mint');
        let fail = true;
        const flaky = createJobStore({
            sql,
            orgId: ORG,
            githubToken: {
                fresh: async () => {
                    if (fail) throw new Error('mint down');
                    return 'ghs_late';
                },
            },
        });
        await flaky.create('echo hi', userId, { repo: null, executor: null });

        await expect(flaky.claim('driver-1', LEASE_SECONDS)).rejects.toThrow('mint down');

        // The provider is back: the job is still queued, still attempt 0, and the very next claim
        // takes it with the minted token.
        fail = false;
        const claim = await flaky.claim('driver-2', LEASE_SECONDS);
        expect(claim?.id).toBeTruthy();
        expect(claim?.attempts).toBe(1);
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'ghs_late' });
    });

    it('mints the token even when the board has no env resolver', async () => {
        const userId = await account(mintedAccountId(), 'bare-mint');
        const bare = createJobStore({ sql, orgId: ORG, githubToken: { fresh: async () => 'ghs_example' } });
        await bare.create('echo hi', userId, { repo: null, executor: null });

        const claim = await bare.claim('driver-1', LEASE_SECONDS);
        expect(claim?.env).toEqual({ GITHUB_TOKEN: 'ghs_example' });
    });

    it('mints a fresh token for every claim, so the credential outlives the claim', async () => {
        /*
         * Served from the provider's cache, a token can carry the five-minute refresh margin into
         * a run capped at thirty minutes, and the runner has no refresh path — its env file is
         * written once. So each claim mints for itself, and the credential starts with a full hour.
         */
        const userId = await account(mintedAccountId(), 'fresh-mint');
        let mints = 0;
        const counting = createJobStore({
            sql,
            orgId: ORG,
            githubToken: {
                fresh: async () => `ghs_${++mints}`,
            },
        });

        await counting.create('echo hi', userId, { repo: null, executor: null });
        const first = await counting.claim('driver-1', LEASE_SECONDS);
        expect(first?.env).toEqual({ GITHUB_TOKEN: 'ghs_1' });

        // The first job holds a live lease, so the second claim takes the new one — and mints again.
        await counting.create('echo hi', userId, { repo: null, executor: null });
        const second = await counting.claim('driver-2', LEASE_SECONDS);
        expect(second?.env).toEqual({ GITHUB_TOKEN: 'ghs_2' });
    });

    /**
     * The publish-time credential (job 43379d3a, 2026-09-13): a claim's installation token is an
     * hour old at best, and a run that outlives it publishes with a dead credential — the work
     * done, the gates green, the push rejected 401. The store re-answers the claim's environment
     * assembly NOW, to the lease holder only.
     */
    describe('publishToken', () => {
        const publishAccountId = (() => {
            const BASE = 150_000;
            const SPREAD = 100_000;
            let next = BASE + Math.floor(Math.random() * SPREAD);
            return () => ++next;
        })();

        it('answers a fresh mint to the lease holder, not the claim-time token', async () => {
            const userId = await account(publishAccountId(), 'publish-mint');
            let mints = 0;
            const store = createJobStore({
                sql,
                orgId: ORG,
                githubToken: { fresh: async () => `ghs_publish_${++mints}` },
            });
            await store.create('echo hi', userId, { repo: null, executor: null });
            const claim = await store.claim('driver-1', LEASE_SECONDS);
            expect(claim?.env).toEqual({ GITHUB_TOKEN: 'ghs_publish_1' });

            const answer = await store.publishToken(claim!.id, claim!.leaseToken);
            expect(answer).toEqual({ result: 'ok', token: 'ghs_publish_2' });
        });

        it('lets a configured GITHUB_TOKEN win, and does not mint for it', async () => {
            const userId = await account(publishAccountId(), 'publish-operator');
            const envStore = createEnvVarStore({ sql, orgId: ORG });
            await envStore.replaceOrg([{ name: 'GITHUB_TOKEN', value: 'operator-pat', isSecret: true }]);
            let mints = 0;
            const store = createJobStore({
                sql,
                orgId: ORG,
                env: envStore,
                githubToken: { fresh: async () => `ghs_${++mints}` },
            });
            await store.create('echo hi', userId, { repo: null, executor: null });
            const claim = await store.claim('driver-1', LEASE_SECONDS);

            const answer = await store.publishToken(claim!.id, claim!.leaseToken);
            // The deliberate credential, and no mint spent beside it — the claim-time rule.
            expect(answer).toEqual({ result: 'ok', token: 'operator-pat' });
            expect(mints).toBe(0);
        });

        it('answers null — nothing fresher than the claim env — with no provider and no configured value', async () => {
            const userId = await account(publishAccountId(), 'publish-bare');
            const store = createJobStore({ sql, orgId: ORG });
            await store.create('echo hi', userId, { repo: null, executor: null });
            const claim = await store.claim('driver-1', LEASE_SECONDS);

            expect(await store.publishToken(claim!.id, claim!.leaseToken)).toEqual({ result: 'ok', token: null });
        });

        it('is lease-guarded: a lost lease and a missing job are different answers', async () => {
            const userId = await account(publishAccountId(), 'publish-lease');
            const store = createJobStore({ sql, orgId: ORG, githubToken: { fresh: async () => 'ghs_x' } });
            await store.create('echo hi', userId, { repo: null, executor: null });
            const claim = await store.claim('driver-1', LEASE_SECONDS);

            expect(await store.publishToken(claim!.id, '33333333-3333-4333-8333-333333333333')).toEqual({
                result: 'lost',
            });
            expect(await store.publishToken('44444444-4444-4444-8444-444444444444', claim!.leaseToken)).toEqual({
                result: 'missing',
            });
        });
    });

    /**
     * The executor label a task was queued with names a row in the author's own executor list, and
     * for an opencode row the pasted config is how the member's model and provider reach the run:
     * the claim hands it over as `OPENCODE_CONFIG_CONTENT`, the env name the pinned opencode
     * runner merges over its baked configuration. Everything here is the claim side of
     * docs/workspace.md's executor wiring.
     */
    describe('the claim carries the author’s opencode executor config', () => {
        /** Unique github_user_id per run, like mintedAccountId above. */
        const executorAccountId = (() => {
            const BASE = 90_000;
            const SPREAD = 100_000;
            let next = BASE + Math.floor(Math.random() * SPREAD);
            return () => ++next;
        })();
        // Built in beforeAll, not at collection: `sql` does not exist until the outer hook ran.
        let executors: ReturnType<typeof createUserExecutorStore>;
        const configured = () => createJobStore({ sql, orgId: ORG, executorConfig: executors });
        beforeAll(() => {
            if (enabled) executors = createUserExecutorStore({ sql, orgId: ORG });
        });

        it('hands an opencode row’s config over, with the permission fence stripped', async () => {
            const userId = await account(executorAccountId(), 'executor-cat');
            await executors.replace(userId, [
                {
                    name: 'main',
                    type: 'opencode',
                    config: {
                        model: 'zai-coding-plan/glm-5.3-flash',
                        small_model: 'zai-coding-plan/glm-5.3-flash',
                        provider: { 'zai-coding-plan': { options: { apiKey: 'zk_test' } } },
                        // A pasted fence would open the other members' trees to this run; the
                        // runner's baked fence is the only authority.
                        permission: { external_directory: { '*': 'allow' } },
                    },
                },
            ]);
            await configured().create('echo hi', userId, { repo: null, executor: 'main' });

            const claim = await configured().claim('driver-1', LEASE_SECONDS);

            expect(claim?.executorType).toBe('opencode');
            const content = JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '') as Record<string, unknown>;
            expect(content).toMatchObject({ model: 'zai-coding-plan/glm-5.3-flash' });
            expect(content).toHaveProperty('provider');
            expect(content).not.toHaveProperty('permission');
            // The value must be one env-file line: JSON.stringify emits no raw newline.
            expect(claim?.env?.OPENCODE_CONFIG_CONTENT).not.toMatch(/[\r\n]/);
        });

        it('routes by the selected executor type and leaves unresolved selections explicit', async () => {
            const userId = await account(executorAccountId(), 'executor-dog');
            await executors.replace(userId, [
                { name: 'claude', type: 'claude-code', config: { model: 'x' } },
                { name: 'main', type: 'opencode', config: { model: 'y' } },
            ]);
            const store = configured();

            await store.create('claude task', userId, { repo: null, executor: 'claude' });
            await store.create('ghost task', userId, { repo: null, executor: 'deleted' });
            await store.create('unlabelled task', userId, { repo: null, executor: null });

            // Each claim takes the oldest claimable row; three claims, three answers. A missing
            // selection is null rather than a Claude/OpenCode fallback for the driver to guess at.
            const claude = await store.claim('driver-1', LEASE_SECONDS);
            expect(claude?.executorType).toBe('claude-code');
            expect(claude?.env).toEqual({
                CLAUDE_CODE_CONFIG_CONTENT: '{"model":"x"}',
            });
            const deleted = await store.claim('driver-2', LEASE_SECONDS);
            expect(deleted?.executorType).toBeNull();
            expect(deleted?.env).toBeUndefined();
            const unlabelled = await store.claim('driver-3', LEASE_SECONDS);
            expect(unlabelled?.executorType).toBeNull();
            expect(unlabelled?.env).toBeUndefined();
        });

        it('strips hooks, enabledPlugins and extraKnownMarketplaces from a claude-code row’s config', async () => {
            const userId = await account(executorAccountId(), 'executor-cat');
            await executors.replace(userId, [
                {
                    name: 'claude',
                    type: 'claude-code',
                    config: {
                        model: 'x',
                        hooks: { PreToolUse: [] },
                        enabledPlugins: { 'evil@evil': true },
                        extraKnownMarketplaces: { evil: { source: { source: 'github', repo: 'x/evil' } } },
                    },
                },
            ]);
            const store = configured();

            await store.create('claude task', userId, { repo: null, executor: 'claude' });

            expect((await store.claim('driver-1', LEASE_SECONDS))?.env).toEqual({
                CLAUDE_CODE_CONFIG_CONTENT: '{"model":"x"}',
            });
        });

        it('lets the synthesized value win a collision with a member env var of the same name', async () => {
            // The route refuses the name at PUT; this row is the store-level stand-in for one that
            // predates the reservation. The executor config is the member's deliberate choice for
            // the run — it must not lose to a scope that exists for other things.
            const userId = await account(executorAccountId(), 'executor-owl');
            const envStore = createEnvVarStore({ sql, orgId: ORG });
            await envStore.replaceWorkspace(userId, [
                { name: 'OPENCODE_CONFIG_CONTENT', value: '{"model":"stale"}', isSecret: false },
            ]);
            await executors.replace(userId, [{ name: 'main', type: 'opencode', config: { model: 'fresh' } }]);
            const store = createJobStore({ sql, orgId: ORG, env: envStore, executorConfig: executors });

            await store.create('echo hi', userId, { repo: null, executor: 'main' });
            const claim = await store.claim('driver-1', LEASE_SECONDS);

            expect(claim?.env).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"fresh"}' });
        });

        it('leaves the job claimable when the executor reader fails, without burning an attempt', async () => {
            const userId = await account(executorAccountId(), 'executor-fox');
            let fail = true;
            const flaky = createJobStore({
                sql,
                orgId: ORG,
                executorConfig: {
                    configFor: async () => {
                        if (fail) throw new Error('executor store down');
                        return null;
                    },
                },
            });
            await flaky.create('echo hi', userId, { repo: null, executor: 'main' });

            await expect(flaky.claim('driver-1', LEASE_SECONDS)).rejects.toThrow('executor store down');

            fail = false;
            const claim = await flaky.claim('driver-2', LEASE_SECONDS);
            expect(claim?.id).toBeTruthy();
            expect(claim?.attempts).toBe(1);
        });
    });

    it('keeps the job when the account that queued it is deleted', async () => {
        // `on delete set null`, never cascade: removing a person must not erase the record of what
        // they ran, on the one route that runs shell commands.
        const DEPARTING_GITHUB_ID = 5003;
        const userId = await account(DEPARTING_GITHUB_ID, 'departing');
        const { id } = await store.create('echo hi', userId, { repo: null, executor: null });

        await sql`delete from app_user where id = ${userId}`;

        const job = await store.get(id);
        expect(job).not.toBeNull();
        expect(job?.createdBy).toBeNull();
    });

    it('reports the workspace directory on reads, not only on the claim', async () => {
        /*
         * The task view's status sidebar shows where the run's checkout lives, and a reader of the
         * board has no other way to learn it: the layout is the board's own knowledge
         * (`<orgId>/<author>`), so the same derivation the claim makes travels on the reads the
         * dashboard polls. An unattributed job answers null — the same null the claim reports,
         * for the same reason.
         */
        const READING_CAT_GITHUB_ID = 5008;
        const userId = await account(READING_CAT_GITHUB_ID, 'reading-cat');
        const { id } = await store.create('echo hi', userId, { repo: null, executor: null });

        expect((await store.get(id))?.workspacePath).toBe(`${ORG}/${userId}`);
        expect((await store.thread(id))?.[0]?.workspacePath).toBe(`${ORG}/${userId}`);

        const unattributed = await queue('echo hi');
        expect((await store.get(unattributed.id))?.workspacePath).toBeNull();

        // The list projection carries the derivation too — the sidenav and any list view read it
        // like the detail, and never `null`-because-unselected.
        const listed = await store.list({ limit: 10 });
        expect(listed.find((job) => job.id === id)?.workspacePath).toBe(`${ORG}/${userId}`);
        expect(listed.find((job) => job.id === unattributed.id)?.workspacePath).toBeNull();
    });

    it('reports no workspace directory on reads when the deployment has no workspace root', async () => {
        /*
         * The claim refuses to name a directory that was never created; the reads must not either,
         * or the sidebar would show a path that does not exist.
         */
        const rootless = createJobStore({ sql, orgId: ORG, hasWorkspaces: false });
        const UNREAD_CAT_GITHUB_ID = 5009;
        const userId = await account(UNREAD_CAT_GITHUB_ID, 'unread-cat');
        const { id } = await rootless.create('echo hi', userId, { repo: null, executor: null });

        expect((await rootless.get(id))?.workspacePath).toBeNull();
    });
});
