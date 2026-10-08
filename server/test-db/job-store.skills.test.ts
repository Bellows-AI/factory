import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

/**
 * Issue 545: a task selects skills at creation; the selection lives on the root row, every claim of
 * the thread (retry, follow-up, reclaim) reads it, and the claim refuses — by name, never by value —
 * a selection whose connection the task does not carry: env names for GitHub, the selected managed
 * connection for Jira (docs/connections.md).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const WORKER = 'worker-1';
const LEASE_SECONDS = 60;
const db = useTestDb({ orgs: [ORG], max: 8 });

const GITHUB_ENV = { GITHUB_TOKEN: 'token-sentinel' };

let sql: Sql;
let plain: JobStore;

/** A store whose claim resolves exactly `env` for every job, the board's stacked env in miniature. */
const storeWithEnv = (env: Record<string, string>): JobStore =>
    createJobStore({ sql, orgId: ORG, env: { resolveFor: async () => ({ ...env }) } });

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    plain = createJobStore({ sql, orgId: ORG });
});

/** An org-owned managed Jira connection (054) the route would have authorized; its id is the selection. */
async function jiraConnection(): Promise<string> {
    const created = await createConnectionStore({ sql, orgId: ORG }).create({
        ownerUserId: null,
        site: 'example.atlassian.net',
        cloudId: 'cloud-1',
        email: 'agent@example.com',
        apiToken: 'never-in-a-refusal',
        access: 'read',
    });
    return created.id;
}

async function queue(store: JobStore, skills?: string[], jiraConnectionId?: string): Promise<string> {
    const created = await store.create('do the work', null, {
        repo: null,
        executor: null,
        ...(skills ? { skills } : {}),
        ...(jiraConnectionId ? { jiraConnectionId } : {}),
    });
    if (typeof created === 'string') throw new Error(created);
    return created.id;
}

async function claim(store: JobStore): Promise<Claim> {
    const claimed = (await store.claim(WORKER, LEASE_SECONDS)) as Claim | null;
    expect(claimed).not.toBeNull();
    return claimed!;
}

describe.skipIf(!enabled)('skill selection — database', () => {
    it('stores the selection on the root and hands the claim a prompt naming it', async () => {
        const store = storeWithEnv(GITHUB_ENV);
        const id = await queue(store, ['jira', 'gates'], await jiraConnection());
        const [row] = await sql<{ skills: string[] }[]>`select skills from job where id = ${id}`;
        expect(row?.skills).toEqual(['jira', 'gates']);

        const claimed = await claim(store);
        expect(claimed.skillRefusal).toBeNull();
        expect(claimed.masterPrompt).toContain('- Selected skills: jira, gates');
    });

    it('a task with no skills renders no line and has no refusal', async () => {
        await queue(plain);
        const claimed = await claim(plain);
        expect(claimed.skillRefusal).toBeNull();
        expect(claimed.masterPrompt).not.toContain('Selected skills');
    });

    it('refuses a Jira skill on a task that selected no connection, even with ATLASSIAN_* in the env', async () => {
        const store = storeWithEnv({ ATLASSIAN_SITE: 'site-sentinel' });
        await queue(store, ['jira']);

        const claimed = await claim(store);
        expect(claimed.skillRefusal).toContain('skill "jira" needs the jira connection');
        expect(claimed.skillRefusal).toContain('select one (jiraConnection)');
        expect(claimed.skillRefusal).toContain('retry the task');
        expect(claimed.skillRefusal).not.toContain('site-sentinel');
    });

    it('refuses an env connection the environment lacks, naming env names and no value', async () => {
        const store = storeWithEnv({ OTHER: 'other-sentinel' });
        await queue(store, ['github']);

        const claimed = await claim(store);
        expect(claimed.skillRefusal).toContain('GITHUB_TOKEN');
        expect(claimed.skillRefusal).not.toContain('other-sentinel');
    });

    it('refuses a connection on a board that resolves no environment at all', async () => {
        await queue(plain, ['github']);
        expect((await claim(plain)).skillRefusal).toContain('GITHUB_TOKEN');
    });

    it('selecting a skill never changes the claim env', async () => {
        const store = storeWithEnv(GITHUB_ENV);
        await queue(store);
        const without = (await claim(store)).env;
        await sql`delete from job`;
        await queue(store, ['jira', 'github', 'gates']);
        const withSkills = (await claim(store)).env;
        expect(withSkills).toEqual(without);
        expect(withSkills).toEqual(GITHUB_ENV);
    });

    it('refuses a stored name the catalog no longer has, listing what is installed', async () => {
        const id = await queue(plain);
        await sql`update job set skills = ${sql.array(['retired-skill'])}::text[] where id = ${id}`;
        const refusal = (await claim(plain)).skillRefusal;
        expect(refusal).toContain('skill "retired-skill" is not installed');
        expect(refusal).toContain('installed: ');
    });

    it('a retry keeps the root selection and sees the same refusal until the environment is fixed', async () => {
        const broken = storeWithEnv({});
        const root = await queue(broken, ['github']);
        const first = await claim(broken);
        expect(first.skillRefusal).not.toBeNull();
        await broken.complete(first.id, first.leaseToken, {
            status: 'failed',
            exitCode: null,
            output: first.skillRefusal!,
            failureKind: 'config',
        });

        const retry = await broken.createRetry(root, null);
        if (typeof retry === 'string') throw new Error(`retry refused: ${retry}`);
        const [retryRow] = await sql<{ skills: string[] }[]>`select skills from job where id = ${retry.id}`;
        // The root decides: the retry row itself carries the default, and its claim reads the root.
        expect(retryRow?.skills).toEqual([]);

        const stillBroken = await claim(broken);
        expect(stillBroken.id).toBe(retry.id);
        expect(stillBroken.skillRefusal).toContain('GITHUB_TOKEN');
        expect(stillBroken.masterPrompt).toContain('- Selected skills: github');

        // The member fixes the environment: a fresh retry now runs, with the same prompt.
        await broken.complete(stillBroken.id, stillBroken.leaseToken, {
            status: 'failed',
            exitCode: null,
            output: 'x',
            failureKind: 'config',
        });
        const fixed = storeWithEnv(GITHUB_ENV);
        const again = await fixed.createRetry(root, null);
        if (typeof again === 'string') throw new Error(`retry refused: ${again}`);
        const ok = await claim(fixed);
        expect(ok.skillRefusal).toBeNull();
        expect(ok.masterPrompt).toBe(first.masterPrompt);
    });

    it('a retry of a Jira task still sees the root’s connection, so its claim passes', async () => {
        const store = plain;
        const root = await queue(store, ['jira'], await jiraConnection());
        const first = await claim(store);
        expect(first.skillRefusal).toBeNull();
        await store.complete(first.id, first.leaseToken, { status: 'failed', exitCode: 1, output: 'red' });

        const retry = await store.createRetry(root, null);
        if (typeof retry === 'string') throw new Error(`retry refused: ${retry}`);
        const [retryRow] = await sql<{ jira_connection_id: string | null }[]>`
            select jira_connection_id from job where id = ${retry.id}`;
        // Only the root carries the selection; the retry's claim reads it from there.
        expect(retryRow?.jira_connection_id).toBeNull();
        expect((await claim(store)).skillRefusal).toBeNull();
    });

    it('a follow-up claims with the root selection', async () => {
        const store = storeWithEnv(GITHUB_ENV);
        const root = await queue(store, ['gates']);
        const first = await claim(store);
        await store.session(first.id, first.leaseToken, randomUUID());
        await store.complete(first.id, first.leaseToken, { status: 'succeeded', exitCode: 0, output: 'ok' });

        const followUp = await store.createFollowUp(root, 'and also this', null);
        if (typeof followUp === 'string') throw new Error(`follow-up refused: ${followUp}`);
        const claimed = await claim(store);
        expect(claimed.id).toBe(followUp.id);
        expect(claimed.masterPrompt).toBe(first.masterPrompt);
        expect(claimed.masterPrompt).toContain('- Selected skills: gates');
    });

    it('an expired-lease reclaim of the same row still carries the selection', async () => {
        const store = storeWithEnv(GITHUB_ENV);
        const id = await queue(store, ['github']);
        const first = await claim(store);
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${id}`;

        const second = await claim(store);
        expect(second.id).toBe(id);
        expect(second.attempts).toBe(first.attempts + 1);
        expect(second.masterPrompt).toBe(first.masterPrompt);
        expect(second.masterPrompt).toContain('- Selected skills: github');
    });
});
