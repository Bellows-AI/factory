import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    createConnectionOfLease,
    createConnectionStore,
    type ConnectionOfLease,
    type ConnectionStore,
} from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/job-store.js';
import type { Claim, JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';

/** The managed connections (051, issue #546): scoping and the proxy's per-call check, on a real database. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = 'test-org';
const OTHER_ORG = 'other-org';
const LEASE_SECONDS = 300;
const OWNER = { id: '00000000-0000-4000-8000-0000000c0001', githubUserId: 91001, login: 'conn-owner' };
const STRANGER = { id: '00000000-0000-4000-8000-0000000c0002', githubUserId: 91002, login: 'conn-stranger' };
const API_TOKEN = 'db-test-token';

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [OWNER, STRANGER] });

let sql: Sql;
let store: ConnectionStore;
let otherOrgStore: ConnectionStore;
let jobs: JobStore;
let check: ConnectionOfLease;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createConnectionStore({ sql, orgId: ORG });
    otherOrgStore = createConnectionStore({ sql, orgId: OTHER_ORG });
    jobs = createJobStore({ sql, orgId: ORG });
    check = createConnectionOfLease({ sql });
});

const newConnection = (ownerUserId: string | null, access: 'read' | 'write' = 'read') =>
    store.create({
        ownerUserId,
        site: 'example.atlassian.net',
        cloudId: 'cloud-1',
        email: 'agent@example.com',
        apiToken: API_TOKEN,
        access,
    });

const join = (user: { id: string; login: string }) =>
    sql`insert into org_membership (org_id, github_login, user_id) values (${ORG}, ${user.login}, ${user.id})
        on conflict do nothing`;

/** A running task authored by OWNER that selected `connectionId`, under a live lease. */
async function running(connectionId: string | null): Promise<{ id: string; claim: Claim }> {
    await join(OWNER);
    const ref = await jobs.create('look at ABC-1', OWNER.id, {
        repo: null,
        executor: null,
        jiraConnectionId: connectionId,
    });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim };
}

describe.skipIf(!enabled)('connection store — scoping', () => {
    it('lists org-owned connections and the caller own, never another member own or another org', async () => {
        const orgOwned = await newConnection(null);
        const mine = await newConnection(OWNER.id);
        const theirs = await newConnection(STRANGER.id);
        const foreign = await otherOrgStore.create({
            ownerUserId: null,
            site: 'other.atlassian.net',
            cloudId: 'cloud-2',
            email: 'x@example.com',
            apiToken: API_TOKEN,
            access: 'read',
        });

        const ids = (await store.list(OWNER.id)).map((c) => c.id);
        expect(ids).toEqual(expect.arrayContaining([orgOwned.id, mine.id]));
        expect(ids).not.toContain(theirs.id);
        expect(ids).not.toContain(foreign.id);
        expect(JSON.stringify(await store.list(OWNER.id))).not.toContain(API_TOKEN);
    });

    it('authorizes org-owned for anyone, personal only for its owner, and nothing across orgs', async () => {
        const orgOwned = await newConnection(null);
        const mine = await newConnection(OWNER.id);
        expect(await store.authorizedFor(STRANGER.id, orgOwned.id)).toBe(true);
        expect(await store.authorizedFor(OWNER.id, mine.id)).toBe(true);
        expect(await store.authorizedFor(STRANGER.id, mine.id)).toBe(false);
        expect(await otherOrgStore.authorizedFor(OWNER.id, orgOwned.id)).toBe(false);
    });

    it("defaults to the user's newest own connection, else the org's newest, never another member's or org's", async () => {
        const [row] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login)
            values (${Math.floor(Math.random() * 1e9) + 1e6}, ${`conn-newcomer-${crypto.randomUUID()}`})
            returning id
        `;
        const newcomer = row!.id;
        await otherOrgStore.create({
            ownerUserId: newcomer,
            site: 'other.atlassian.net',
            cloudId: 'cloud-2',
            email: 'x@example.com',
            apiToken: API_TOKEN,
            access: 'read',
        });
        await newConnection(STRANGER.id);
        const olderOrg = await newConnection(null);
        const newerOrg = await newConnection(null);
        expect(await store.defaultFor(newcomer)).toBe(newerOrg.id);
        expect(olderOrg.id).not.toBe(newerOrg.id);
        const own = await store.create({
            ownerUserId: newcomer,
            site: 'example.atlassian.net',
            cloudId: 'cloud-1',
            email: 'agent@example.com',
            apiToken: API_TOKEN,
            access: 'read',
        });
        await newConnection(null);
        expect(await store.defaultFor(newcomer)).toBe(own.id);
    });

    it('deletes personal for its owner and org-owned only for an admin', async () => {
        const orgOwned = await newConnection(null);
        const mine = await newConnection(OWNER.id);
        expect(await store.remove(mine.id, { userId: STRANGER.id, admin: true })).toBe(false);
        expect(await store.remove(orgOwned.id, { userId: OWNER.id, admin: false })).toBe(false);
        expect(await store.remove(mine.id, { userId: OWNER.id, admin: false })).toBe(true);
        expect(await store.remove(orgOwned.id, { userId: OWNER.id, admin: true })).toBe(true);
    });
});

describe.skipIf(!enabled)('connection of lease — the proxy check', () => {
    it('resolves the root selection for a live attempt, with the credential', async () => {
        const connection = await newConnection(null, 'write');
        const { id, claim } = await running(connection.id);
        expect(await check(id, claim.leaseToken)).toEqual({
            ok: true,
            cloudId: 'cloud-1',
            email: 'agent@example.com',
            apiToken: API_TOKEN,
            access: 'write',
        });
    });

    it('refuses an unselected task, a wrong token and an unknown job', async () => {
        const { id, claim } = await running(null);
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'unselected' });
        expect(await check(id, crypto.randomUUID())).toEqual({ ok: false, reason: 'lease' });
        expect(await check(crypto.randomUUID(), claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
    });

    it('stops at once when the connection is deleted, even under a live lease', async () => {
        const connection = await newConnection(null);
        const { id, claim } = await running(connection.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);
        await store.remove(connection.id, { userId: OWNER.id, admin: true });
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'unselected' });
    });

    // Each case is its own test: an expired job is claimable again, so a second `running()` in one
    // test would re-claim it instead of the job the case just created.
    it('refuses the superseded attempt once a reclaim rotates the lease token', async () => {
        const connection = await newConnection(null);
        const first = await running(connection.id);
        await sql`update job set lease_expires_at = now() - interval '1 second' where id = ${first.id}`;
        expect(await check(first.id, first.claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });

        const second = (await jobs.claim('w2', LEASE_SECONDS)) as Claim;
        expect(second.id).toBe(first.id);
        expect(second.leaseToken).not.toBe(first.claim.leaseToken);
        expect(await check(first.id, first.claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
        expect((await check(second.id, second.leaseToken)).ok).toBe(true);
    });

    it('refuses an attempt that was asked to stop', async () => {
        const connection = await newConnection(null);
        const stopped = await running(connection.id);
        await sql`update job set cancel_requested_at = now() where id = ${stopped.id}`;
        expect(await check(stopped.id, stopped.claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
    });

    it('refuses a finished attempt at once, with no tail grace', async () => {
        const connection = await newConnection(null);
        const done = await running(connection.id);
        await sql`update job set finished_at = now() where id = ${done.id}`;
        expect(await check(done.id, done.claim.leaseToken)).toEqual({ ok: false, reason: 'lease' });
    });

    it('refuses an org-owned connection too once the task author is no longer a member', async () => {
        const connection = await newConnection(null, 'write');
        const { id, claim } = await running(connection.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);
        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${OWNER.id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });

    it('refuses a personal connection once its owner is no longer a member, and for another author', async () => {
        await join(OWNER);
        const mine = await newConnection(OWNER.id);
        const { id, claim } = await running(mine.id);
        expect((await check(id, claim.leaseToken)).ok).toBe(true);

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${OWNER.id}`;
        expect(await check(id, claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });

        await join(OWNER);
        const strangers = await newConnection(STRANGER.id);
        await join(STRANGER);
        const other = await running(strangers.id);
        expect(await check(other.id, other.claim.leaseToken)).toEqual({ ok: false, reason: 'revoked' });
    });
});
