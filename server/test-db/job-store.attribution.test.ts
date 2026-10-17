import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { CreateJobStoreDeps, JobStore } from '../src/db/job-store-types.js';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { useTestDb } from './harness.js';
import { account, lapseDeferral, mustCreate, randomGithubId, testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = testOrg();
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
});

/**
 * Queues an unattributed job — the state every job written before accounts existed is in.
 *
 * `created_by` is a required parameter rather than an optional one, so that the route has to name
 * the authenticated caller rather than defaulting quietly; these cases are about leases, not
 * attribution, so they pass null explicitly. The attribution cases below pass a real account.
 */
const queue = async (command: string) => {
    const ref = await store.create(command, null, { repo: null, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    return ref;
};
describe.runIf(enabled)('attribution', () => {
    it('records who queued a job and reports it back on read', async () => {
        const OCTOCAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, OCTOCAT_GITHUB_ID, 'octocat');

        const { id } = await mustCreate(store.create('echo hi', userId, { repo: null, executor: null }));

        expect((await store.get(id))?.createdBy).toBe(userId);
    });

    it('reports the author and their workspace to the worker that claims it', async () => {
        const OCTODOG_GITHUB_ID = randomGithubId();
        const userId = await account(sql, OCTODOG_GITHUB_ID, 'octodog');
        await mustCreate(store.create('echo hi', userId, { repo: null, executor: null }));

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
        const NOWHERE_GITHUB_ID = randomGithubId();
        const userId = await account(sql, NOWHERE_GITHUB_ID, 'nowhere');
        await mustCreate(rootless.create('echo hi', userId, { repo: null, executor: null }));

        const claim = await rootless.claim('driver-1', LEASE_SECONDS);
        expect(claim?.userId).toBe(userId);
        expect(claim?.workspacePath).toBeNull();
    });

    it('carries the stacked environment on the claim, resolved for the author and repo label', async () => {
        const ENV_CAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, ENV_CAT_GITHUB_ID, 'env-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await envStore.replaceOrg([{ name: 'CORE', value: 'org-value', isSecret: true }]);
        await envStore.replaceWorkspace(userId, [{ name: 'CORE', value: 'workspace-value', isSecret: false }]);
        await envStore.replaceRepo('Bellows-AI', 'bellows.ai', [
            { name: 'CORE', value: 'repo-value', isSecret: false },
            { name: 'REPO_ONLY', value: 'repo-only-value', isSecret: true },
        ]);
        const envAware = createJobStore({ sql, orgId: ORG, env: envStore });

        await mustCreate(envAware.create('echo hi', userId, { repo: 'Bellows-AI/bellows.ai', executor: null }));
        const claim = await envAware.claim('driver-1', LEASE_SECONDS);
        // Repo beats workspace beats org on the collision, and the secrets travel as values —
        // injection is what they are for.
        expect(claim?.env).toEqual({ CORE: 'repo-value', REPO_ONLY: 'repo-only-value' });

        // A job with no repo label gets org + workspace only.
        await mustCreate(envAware.create('echo hi', userId, { repo: null, executor: null }));
        const second = await envAware.claim('driver-2', LEASE_SECONDS);
        expect(second?.env).toEqual({ CORE: 'workspace-value' });
    });

    it('carries no environment when the board was built without a resolver', async () => {
        const PLAIN_CAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, PLAIN_CAT_GITHUB_ID, 'plain-cat');
        await mustCreate(store.create('echo hi', userId, { repo: null, executor: null }));
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        expect(claim?.env).toBeUndefined();
    });

    /*
     * The claim's UPDATE is only safe to keep if every dependency it calls answers: a half-claim —
     * running, with a lease nobody holds and an attempt already burned — would strand the job until
     * the lease expired on every retry, walking it to dead on an infrastructure blip. The env
     * resolver and the executor reader roll back alike, and the candidate stays deferred (issue
     * #822) so the next poll takes other work first.
     */
    it.each<{
        name: string;
        failing: (fail: () => boolean) => Partial<CreateJobStoreDeps>;
        executor: string | null;
        error: string;
        env?: Record<string, string>;
    }>([
        {
            name: 'the env resolver',
            failing: (fail) => ({
                env: {
                    resolveFor: async () => {
                        if (fail()) throw new Error('env store down');
                        return {};
                    },
                },
            }),
            executor: null,
            error: 'env store down',
        },
        {
            name: 'the executor reader',
            failing: (fail) => ({
                executorConfig: {
                    configFor: async () => {
                        if (fail()) throw new Error('executor store down');
                        return null;
                    },
                },
            }),
            executor: 'main',
            error: 'executor store down',
        },
    ])('leaves a job claimable when $name fails, without burning an attempt', async ({ failing, executor, error }) => {
        const userId = await account(sql, randomGithubId(), 'flaky-cat');
        let fail = true;
        const flaky = createJobStore({ sql, orgId: ORG, ...failing(() => fail) });
        const { id } = await mustCreate(flaky.create('echo hi', userId, { repo: null, executor }));

        await expect(flaky.claim('driver-1', LEASE_SECONDS)).rejects.toThrow(error);
        expect(await flaky.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
        const [deferral] = await sql<{ deferred: boolean }[]>`
            select claim_deferred_until > now() as deferred from job where id = ${id}
        `;
        expect(deferral?.deferred).toBe(true);

        // The dependency is back and the deferral has lapsed: still attempt 0 until the next claim
        // takes it.
        fail = false;
        await lapseDeferral(sql, id);
        const claim = await flaky.claim('driver-2', LEASE_SECONDS);
        expect(claim?.id).toBeTruthy();
        expect(claim?.attempts).toBe(1);
    });

    it('carries no GitHub credential on the claim, even from a stored row', async () => {
        // GitHub is the App's: the runner obtains a renewing token from the board's credential
        // endpoint (docs/connections.md), so neither name reaches the claim env, whatever scope
        // holds it — the PUT refuses both, and this is the claim's own guarantee.
        const userId = await account(sql, randomGithubId(), 'no-pat-cat');
        const envStore = createEnvVarStore({ sql, orgId: ORG });
        await envStore.replaceOrg([
            { name: 'CORE', value: 'org-value', isSecret: true },
            { name: 'GITHUB_TOKEN', value: 'ghp_member', isSecret: true },
        ]);
        await envStore.replaceWorkspace(userId, [{ name: 'GH_TOKEN', value: 'ghp_mine', isSecret: true }]);
        const store = createJobStore({ sql, orgId: ORG, env: envStore, githubApp: true });

        await mustCreate(store.create('echo hi', userId, { repo: null, executor: null }));
        const claim = await store.claim('driver-1', LEASE_SECONDS);
        expect(claim?.env).toEqual({ CORE: 'org-value' });
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
            const userId = await account(sql, executorAccountId(), 'executor-cat');
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
            const userId = await account(sql, executorAccountId(), 'executor-dog');
            await executors.replace(userId, [
                { name: 'claude', type: 'claude-code', config: { model: 'x' } },
                { name: 'main', type: 'opencode', config: { model: 'y' } },
            ]);
            const store = configured();

            await mustCreate(store.create('claude task', userId, { repo: null, executor: 'claude' }));
            await mustCreate(store.create('ghost task', userId, { repo: null, executor: 'deleted' }));
            await mustCreate(store.create('unlabelled task', userId, { repo: null, executor: null }));

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
            const userId = await account(sql, executorAccountId(), 'executor-cat');
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

            await mustCreate(store.create('claude task', userId, { repo: null, executor: 'claude' }));

            expect((await store.claim('driver-1', LEASE_SECONDS))?.env).toEqual({
                CLAUDE_CODE_CONFIG_CONTENT: '{"model":"x"}',
            });
        });

        it('lets the synthesized value win a collision with a member env var of the same name', async () => {
            // The route refuses the name at PUT; this row is the store-level stand-in for one that
            // predates the reservation. The executor config is the member's deliberate choice for
            // the run — it must not lose to a scope that exists for other things.
            const userId = await account(sql, executorAccountId(), 'executor-owl');
            const envStore = createEnvVarStore({ sql, orgId: ORG });
            await envStore.replaceWorkspace(userId, [
                { name: 'OPENCODE_CONFIG_CONTENT', value: '{"model":"stale"}', isSecret: false },
            ]);
            await executors.replace(userId, [{ name: 'main', type: 'opencode', config: { model: 'fresh' } }]);
            const store = createJobStore({ sql, orgId: ORG, env: envStore, executorConfig: executors });

            await mustCreate(store.create('echo hi', userId, { repo: null, executor: 'main' }));
            const claim = await store.claim('driver-1', LEASE_SECONDS);

            expect(claim?.env).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"fresh"}' });
        });
    });

    it('keeps the job when the account that queued it is deleted', async () => {
        // `on delete set null`, never cascade: removing a person must not erase the record of what
        // they ran, on the one route that runs shell commands.
        const DEPARTING_GITHUB_ID = randomGithubId();
        const userId = await account(sql, DEPARTING_GITHUB_ID, 'departing');
        const { id } = await mustCreate(store.create('echo hi', userId, { repo: null, executor: null }));

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
        const READING_CAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, READING_CAT_GITHUB_ID, 'reading-cat');
        const { id } = await mustCreate(store.create('echo hi', userId, { repo: null, executor: null }));

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
        const UNREAD_CAT_GITHUB_ID = randomGithubId();
        const userId = await account(sql, UNREAD_CAT_GITHUB_ID, 'unread-cat');
        const { id } = await mustCreate(rootless.create('echo hi', userId, { repo: null, executor: null }));

        expect((await rootless.get(id))?.workspacePath).toBeNull();
    });
});
