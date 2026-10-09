import type { Sql } from 'postgres';

/** What a list or create answers: the connection without its token, which no read ever returns. */
export interface ConnectionView {
    id: string;
    kind: 'jira';
    site: string;
    email: string;
    access: ConnectionAccess;
    /** `org` is usable by every member's task; `user` only by its owner's. */
    scope: 'org' | 'user';
    createdAt: string;
}

export type ConnectionAccess = 'read' | 'write';

export interface NewConnection {
    ownerUserId: string | null;
    site: string;
    cloudId: string;
    email: string;
    apiToken: string;
    access: ConnectionAccess;
}

export interface ConnectionStore {
    /** The org's own connections plus the caller's, newest first. */
    list(userId: string): Promise<ConnectionView[]>;
    create(input: NewConnection): Promise<ConnectionView>;
    /** True when `userId` may select the connection for a task: org-owned in this org, or their own. */
    authorizedFor(userId: string, connectionId: string): Promise<boolean>;
    /** The connection a task injects when it names none: the user's newest own, else the org's newest. */
    defaultFor(userId: string): Promise<string | null>;
    /** Deletes an org-owned connection (`admin`) or the caller's own; false when neither matches. */
    remove(connectionId: string, actor: { userId: string; admin: boolean }): Promise<boolean>;
}

interface Row {
    id: string;
    site: string;
    email: string;
    access: ConnectionAccess;
    owner_user_id: string | null;
    created_at: Date;
}

const toView = (row: Row): ConnectionView => ({
    id: row.id,
    kind: 'jira',
    site: row.site,
    email: row.email,
    access: row.access,
    scope: row.owner_user_id === null ? 'org' : 'user',
    createdAt: row.created_at.toISOString(),
});

export function createConnectionStore({
    sql,
    orgId,
    ready,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
}): ConnectionStore {
    const gate = async () => {
        if (ready) await ready;
    };
    return {
        async list(userId) {
            await gate();
            const rows = await sql<Row[]>`
                select id, site, email, access, owner_user_id, created_at from connector_connection
                where org_id = ${orgId} and (owner_user_id is null or owner_user_id = ${userId})
                order by created_at desc
            `;
            return rows.map(toView);
        },
        async create(input) {
            await gate();
            const rows = await sql<Row[]>`
                insert into connector_connection (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access)
                values (${orgId}, ${input.ownerUserId}, 'jira', ${input.site}, ${input.cloudId}, ${input.email},
                        ${input.apiToken}, ${input.access})
                returning id, site, email, access, owner_user_id, created_at
            `;
            return toView(rows[0]!);
        },
        async authorizedFor(userId, connectionId) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                select id from connector_connection
                where id = ${connectionId} and org_id = ${orgId}
                  and (owner_user_id is null or owner_user_id = ${userId})
            `;
            return rows.length > 0;
        },
        async defaultFor(userId) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                select id from connector_connection
                where org_id = ${orgId} and (owner_user_id is null or owner_user_id = ${userId})
                order by owner_user_id is null, created_at desc, id
                limit 1
            `;
            return rows[0]?.id ?? null;
        },
        async remove(connectionId, { userId, admin }) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                delete from connector_connection
                where id = ${connectionId} and org_id = ${orgId}
                  and (owner_user_id = ${userId} or (owner_user_id is null and ${admin}))
                returning id
            `;
            return rows.length > 0;
        },
    };
}

/** Why the proxy refused a call — each one names what the member fixes. */
export type ConnectionRefusal = 'lease' | 'unselected' | 'revoked';

export type LiveConnection =
    | { ok: true; cloudId: string; email: string; apiToken: string; access: ConnectionAccess }
    | { ok: false; reason: ConnectionRefusal };

export type ConnectionOfLease = (jobId: string, leaseToken: string) => Promise<LiveConnection>;

interface LiveRow {
    selected: string | null;
    owner_user_id: string | null;
    author: string | null;
    cloud_id: string | null;
    email: string | null;
    api_token: string | null;
    access: ConnectionAccess | null;
    author_is_member: boolean | null;
}

/**
 * The proxy's per-call check, org-less like `createOrgOfLease` (the pair names the org) but
 * deliberately WITHOUT its tail grace: a connector call is live work, so the attempt must be
 * unfinished, unexpired and not asked to stop. A reclaim or retry rotates the lease token, so a
 * superseded attempt's pair resolves nothing. The connection is the thread ROOT's selection,
 * re-authorized now: the root's author must still be a member of the org, and a personal
 * connection must be theirs — deleting the connection or removing the author ends access on the
 * next call.
 */
export function createConnectionOfLease({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown> | undefined;
}): ConnectionOfLease {
    return async (jobId, leaseToken) => {
        if (ready) await ready;
        const rows = await sql<LiveRow[]>`
            select root.jira_connection_id as selected, c.owner_user_id, root.created_by as author,
                   c.cloud_id, c.email, c.api_token, c.access,
                   exists (
                       select 1 from org_membership m
                       where m.org_id = j.org_id and m.user_id = root.created_by
                   ) as author_is_member
            from job j
            join job root on root.org_id = j.org_id and root.id = j.root_job_id
            left join connector_connection c on c.id = root.jira_connection_id and c.org_id = j.org_id
            where j.id = ${jobId} and j.lease_token = ${leaseToken}
              and j.finished_at is null and j.lease_expires_at > now() and j.cancel_requested_at is null
        `;
        const row = rows[0];
        if (!row) return { ok: false, reason: 'lease' };
        if (row.selected === null && row.cloud_id === null) return { ok: false, reason: 'unselected' };
        if (row.cloud_id === null || row.email === null || row.api_token === null || row.access === null) {
            return { ok: false, reason: 'revoked' };
        }
        // The task's author must still be a member whichever way the connection is owned, and a
        // personal connection must be the author's own.
        const ownedByAuthor = row.owner_user_id === null || row.owner_user_id === row.author;
        if (!ownedByAuthor || !row.author_is_member) return { ok: false, reason: 'revoked' };
        return { ok: true, cloudId: row.cloud_id, email: row.email, apiToken: row.api_token, access: row.access };
    };
}
