import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REPOS_PER_USER } from '../src/routes/workspace.js';
import {
    githubAuth,
    harness,
    memoryAuthStore,
    memoryUserExecutorStore,
    memoryUserRepoStore,
    signedIn,
    type MemoryUserRepoStore,
} from './helpers.js';
import { MAX_EXECUTORS_PER_USER } from '../src/routes/workspace.js';
import { createFactsCache } from '../src/workspace/facts.js';
import { createPurger, type Purger } from '../src/workspace/purge.js';

/**
 * Offline: nothing here clones. `PUT` only writes rows and answers 202 — the clone happens in the
 * queue, which this app is built without, and which has its own suite.
 */

const HTTP_OK = 200;
const HTTP_ACCEPTED = 202;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

let root: string;
let store: MemoryUserRepoStore;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-ws-routes-'));
    store = memoryUserRepoStore();
});

const REPOS = [
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'api' },
    { owner: 'other-owner', name: 'api' },
];

async function boot(
    options: {
        withRoot?: boolean;
        purger?: Purger;
        facts?: ReturnType<typeof createFactsCache>;
        store?: MemoryUserRepoStore;
    } = {}
) {
    const auth = memoryAuthStore();
    const caller = auth.seedMember('test-org', 'octocat');
    const executors = memoryUserExecutorStore();
    const h = await harness({
        auth,
        userRepos: options.store ?? store,
        userExecutors: executors,
        repos: REPOS,
        ...(options.purger ? { purger: options.purger } : {}),
        ...(options.facts ? { facts: options.facts } : {}),
        config: {
            workspaceRoot: options.withRoot === false ? null : root,
            // github mode, so the cookie is what identifies the caller. Under `none` the resolver
            // returns the stand-in local account regardless of what cookie arrives, and a test
            // about per-member workspaces needs two members to be distinguishable.
            auth: githubAuth(),
        },
    });
    app = h.app;
    return { app: h.app, caller, cookie: await signedIn(auth, caller), executors };
}

describe('GET /api/workspace', () => {
    it('provisions the directory on first read, and reports it', async () => {
        // Idempotent, and deliberately duplicated with the sign-in callback: this covers
        // AUTH_MODE=none, whose caller never passes through that callback, and every session that
        // predates the deploy.
        const { app, caller, cookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().root).toBe(join(root, 'test-org', caller.user.id));
        expect(existsSync(join(root, 'test-org', caller.user.id))).toBe(true);
    });

    it('writes a breadcrumb naming the owner, so the directory is not a wall of uuids', async () => {
        const { app, caller, cookie } = await boot();
        await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        const path = join(root, 'test-org', caller.user.id, '.factory-workspace.json');
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
            userId: caller.user.id,
            login: 'octocat',
        });
    });

    it('answers 200 with a null root when workspaces are switched off', async () => {
        // Not a 503. "No workspace root configured" is a choice an operator made, and the page
        // renders a sentence about it rather than an error nobody can act on.
        const { app, cookie } = await boot({ withRoot: false });
        const response = await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({
            root: null,
            repos: [],
            orphaned: [],
            executors: [],
            checkoutTotalBytes: null,
        });
    });

    it('needs a session', async () => {
        const { app } = await boot();
        expect((await app.inject({ method: 'GET', url: '/api/workspace' })).statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('reports a queued repo with no on-disk facts, never with zeroes', async () => {
        // The null-not-zero contract. A repo that has not cloned has no size and no branch, and
        // `0 B` would be a claim rather than an absence.
        const { app, cookie } = await boot();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.repos).toEqual([
            expect.objectContaining({
                owner: 'acme',
                name: 'web',
                status: 'queued',
                error: null,
                branch: null,
                lastCommit: null,
                sizeBytes: null,
            }),
        ]);
    });

    it('lists a deselected repo as orphaned rather than forgetting it', async () => {
        // Nothing prunes, so the row is the only record that the directory exists. Deleting it
        // would make unbounded disk growth invisible.
        const { app, caller, cookie } = await boot();
        const put = (repos: unknown) =>
            app.inject({ method: 'PUT', url: '/api/workspace/repos', headers: { cookie }, payload: { repos } });

        await put([{ owner: 'acme', name: 'web' }]);
        await put([]);
        // The row survives, whatever happened to the tree; the LIST shows what is on disk, so the
        // checkout has to be there to be listed.
        mkdirSync(join(root, 'test-org', caller.user.id, 'web'), { recursive: true });

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.repos).toEqual([]);
        expect(body.orphaned).toEqual([
            expect.objectContaining({ owner: 'acme', name: 'web', status: 'queued', sizeBytes: null }),
        ]);
        // And the row itself is still there underneath.
        expect((await store.orphaned(caller.user.id)).map((r) => r.name)).toEqual(['web']);
    });
});

describe('GET /api/workspace: orphan sizes and the checkout total', () => {
    const put = (app: FastifyInstance, cookie: string, repos: unknown) =>
        app.inject({ method: 'PUT', url: '/api/workspace/repos', headers: { cookie }, payload: { repos } });

    const settle = async () => {
        for (let i = 0; i < 100; i += 1) await new Promise((r) => setTimeout(r, 5));
    };

    it('reports an orphan that exists on disk with a measured size, however it last cloned', async () => {
        // A failed clone can still have left a tree; the orphan list is about what is ON DISK.
        const { app, caller, cookie } = await boot();
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);
        await put(app, cookie, []);
        const checkout = join(root, 'test-org', caller.user.id, 'web');
        mkdirSync(checkout, { recursive: true });
        writeFileSync(join(checkout, 'block'), 'x'.repeat(4096));

        // First read schedules the walk (never awaited); the second reads what it measured.
        await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });
        await settle();
        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.orphaned).toHaveLength(1);
        expect(body.orphaned[0]).toMatchObject({ owner: 'acme', name: 'web', sizeBytes: expect.any(Number) });
        expect(body.orphaned[0].sizeBytes).toBeGreaterThan(0);
    });

    it('drops an orphan whose directory is gone, but keeps it deletable', async () => {
        const { app, cookie } = await boot();
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);
        await put(app, cookie, []);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        // The row exists; its directory never did (nothing cloned). A stat — never a walk — says so.
        expect(body.orphaned).toEqual([]);
    });

    it('sums the checkout total only when every included checkout has a measurement', async () => {
        const facts = createFactsCache();
        const { app, caller, cookie } = await boot({ facts });
        await put(app, cookie, [
            { owner: 'acme', name: 'web' },
            { owner: 'acme', name: 'api' },
        ]);
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);
        const orphanA = join(root, 'test-org', caller.user.id, 'api');
        mkdirSync(orphanA, { recursive: true });
        writeFileSync(join(orphanA, 'block'), 'y'.repeat(2048));

        // A read the instant the orphan appeared measures nothing yet: the total must be null
        // rather than a partial sum that would read as the whole truth.
        let body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.orphaned[0].sizeBytes).toBeNull();
        expect(body.checkoutTotalBytes).toBeNull();

        // Measured now: one included checkout, one measurement, one total.
        await settle();
        body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.checkoutTotalBytes).toBe(body.orphaned[0].sizeBytes);
        expect(body.checkoutTotalBytes).toBeGreaterThan(0);

        // A second orphan resets the total to null until ITS walk lands, then the total is the sum.
        // Seeded at the store directly: `other` is not in the installation's list, and this test
        // is about the total, not visibility.
        const orphanB = join(root, 'test-org', caller.user.id, 'other');
        mkdirSync(orphanB, { recursive: true });
        writeFileSync(join(orphanB, 'block'), 'z'.repeat(1024));
        await store.select(caller.user.id, [{ owner: 'acme', name: 'other' }]);
        await store.select(caller.user.id, []);
        body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.orphaned).toHaveLength(2);
        expect(body.checkoutTotalBytes).toBeNull();

        await settle();
        body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.checkoutTotalBytes).toBe(
            body.orphaned.reduce((sum: number, o: { sizeBytes: number | null }) => sum + (o.sizeBytes ?? 0), 0)
        );
        expect(body.checkoutTotalBytes).toBeGreaterThan(0);
    });

    it('counts a selected ready clone in the total once its walk lands', async () => {
        // The total is the checkouts, selected and orphaned alike — this is the selected half,
        // which only a `ready` row contributes (a queued row has no tree to measure).
        const facts = createFactsCache();
        const { app, caller, cookie } = await boot({ facts });
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });
        const checkout = join(root, 'test-org', caller.user.id, 'web');
        mkdirSync(checkout, { recursive: true });
        writeFileSync(join(checkout, 'block'), 'w'.repeat(2048));
        // Promote the row to `ready` the way the queue would — the state whose directory is real.
        await store.markReady(caller.user.id, { owner: 'acme', name: 'web' });

        await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });
        await settle();
        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.repos[0]).toMatchObject({ status: 'ready', sizeBytes: expect.any(Number) });
        expect(body.checkoutTotalBytes).toBe(body.repos[0].sizeBytes);
        expect(body.checkoutTotalBytes).toBeGreaterThan(0);
    });

    it('excludes a purging orphan from the total while still listing it', async () => {
        const { app, caller, cookie } = await boot();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });
        const checkout = join(root, 'test-org', caller.user.id, 'web');
        mkdirSync(checkout, { recursive: true });
        writeFileSync(join(checkout, 'block'), 'z'.repeat(1024));
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [] },
        });

        // A deletion stamped but not finished — the state the UI polls as "Deleting".
        await store.stampPurge(caller.user.id, { owner: 'acme', name: 'web' });

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.orphaned[0]).toMatchObject({ name: 'web', status: 'purging' });
        // A checkout being deleted is on its way out: it is not part of "what you use". Nothing
        // else is included either, and an empty inclusion set is a measured zero.
        expect(body.checkoutTotalBytes).toBe(0);
    });
});

describe('DELETE /api/workspace/repos/:owner/:name', () => {
    const del = (app: FastifyInstance, cookie: string, owner: string, name: string) =>
        app.inject({ method: 'DELETE', url: `/api/workspace/repos/${owner}/${name}`, headers: { cookie } });

    async function bootWithPurger() {
        const facts = createFactsCache();
        const purger = createPurger({ store, root, orgId: 'test-org', facts });
        const booted = await boot({ purger, facts });
        return { ...booted, purger };
    }

    const settlePurge = async (purger: Purger) => {
        for (let i = 0; i < 100; i += 1) {
            await purger.settle();
            await new Promise((r) => setTimeout(r, 5));
        }
    };

    it('answers 202, stamps the row purging, and removes the checkout in the background', async () => {
        const { app, caller, cookie, purger } = await bootWithPurger();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });
        const checkout = join(root, 'test-org', caller.user.id, 'web');
        mkdirSync(checkout, { recursive: true });
        writeFileSync(join(checkout, 'file.txt'), 'work\n');
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [] },
        });

        const response = await del(app, cookie, 'acme', 'web');
        expect(response.statusCode).toBe(HTTP_ACCEPTED);
        // Stamped: the row is the spinner, the directory is still coming down.
        expect((await store.orphaned(caller.user.id))[0]?.status).toBe('purging');

        await settlePurge(purger);
        expect(existsSync(checkout)).toBe(false);
        expect(await store.orphaned(caller.user.id)).toHaveLength(0);
    });

    it('answers 204 for a replay after the row is gone, touching no filesystem', async () => {
        const { app, caller, cookie, purger } = await bootWithPurger();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [] },
        });
        await del(app, cookie, 'acme', 'web');
        await settlePurge(purger);

        const response = await del(app, cookie, 'acme', 'web');
        expect(response.statusCode).toBe(HTTP_NO_CONTENT);
        expect(await store.orphaned(caller.user.id)).toHaveLength(0);
    });

    it('answers 204 for a row that never existed, and says nothing about other members', async () => {
        const { app, cookie } = await bootWithPurger();
        const response = await del(app, cookie, 'acme', 'no-such-repo');
        expect(response.statusCode).toBe(HTTP_NO_CONTENT);
    });

    it('refuses a selected row, whatever its clone status', async () => {
        const { app, cookie } = await bootWithPurger();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });

        const response = await del(app, cookie, 'acme', 'web');
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('REPO_SELECTED');
        expect(store.rows().find((r) => r.name === 'web')?.deselected).toBe(false);
    });

    it('refuses a row a clone still owns', async () => {
        const { app, cookie } = await bootWithPurger();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });
        await store.claimPending(1);
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [] },
        });

        const response = await del(app, cookie, 'acme', 'web');
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('REPO_CLONING');
    });

    it('refuses a duplicate with PURGE_IN_PROGRESS', async () => {
        const { app, caller, cookie } = await bootWithPurger();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [] },
        });
        // Stamp by hand and hold it: the duplicate must meet the stamp, not the finished state.
        mkdirSync(join(root, 'test-org', caller.user.id, 'web'), { recursive: true });
        await store.stampPurge(caller.user.id, { owner: 'acme', name: 'web' });

        const response = await del(app, cookie, 'acme', 'web');
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('PURGE_IN_PROGRESS');
    });

    it('refuses with TASKS_IN_FLIGHT and the count when unfinished tasks use the checkout', async () => {
        const blocking = memoryUserRepoStore({ blockingTasks: () => 2 });
        const facts = createFactsCache();
        const purger = createPurger({ store: blocking, root, orgId: 'test-org', facts });
        const { app, cookie } = await boot({ store: blocking, purger, facts });

        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [] },
        });

        const response = await del(app, cookie, 'acme', 'web');
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('TASKS_IN_FLIGHT');
        expect(response.json().count).toBe(2);
    });

    it('refuses a segment that cannot be a directory name', async () => {
        const { app, cookie } = await bootWithPurger();
        // What routing lets through, the handler shape-checks.
        for (const name of ['-x', '.']) {
            const response = await del(app, cookie, 'acme', name);
            expect(response.statusCode, name).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code, name).toBe('BAD_REPO_NAME');
        }
        // What routing refuses outright — a traversal-shaped URL never reaches a handler at all.
        for (const [owner, name] of [
            ['acme', 'a/b'],
            ['..', 'web'],
        ]) {
            const response = await del(app, cookie, owner, name);
            expect(response.statusCode, `${owner}/${name}`).toBe(404);
        }
        // And the purger was never asked about any of them.
        expect(store.rows().filter((r) => r.status === 'purging')).toHaveLength(0);
    });

    it('needs a session', async () => {
        const { app } = await bootWithPurger();
        expect((await app.inject({ method: 'DELETE', url: '/api/workspace/repos/acme/web' })).statusCode).toBe(
            HTTP_UNAUTHORIZED
        );
    });

    it('answers 409 when workspaces are switched off', async () => {
        const { app, cookie } = await boot({ withRoot: false });
        const response = await del(app, cookie, 'acme', 'web');
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('WORKSPACE_DISABLED');
    });
});

describe('PUT /api/workspace/repos', () => {
    const put = (app: FastifyInstance, cookie: string, repos: unknown) =>
        app.inject({ method: 'PUT', url: '/api/workspace/repos', headers: { cookie }, payload: { repos } });

    it('answers 202, because a clone is minutes and no request may wait for one', async () => {
        const { app, cookie } = await boot();
        const response = await put(app, cookie, [{ owner: 'acme', name: 'web' }]);

        expect(response.statusCode).toBe(HTTP_ACCEPTED);
        expect(response.json().repos).toEqual([{ owner: 'acme', name: 'web' }]);
    });

    it('replaces the whole selection, so replaying the same body changes nothing', async () => {
        // What makes it a PUT: the browser's retry after a dropped connection is safe.
        const { app, cookie } = await boot();
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.repos).toHaveLength(1);
    });

    it('refuses a repo the installation cannot see', async () => {
        // The clone would use the App's installation token, so a repo outside it is one this
        // deployment has no business fetching — and the row would fail forever with a 404.
        const { app, cookie } = await boot();
        const response = await put(app, cookie, [{ owner: 'stranger', name: 'private-thing' }]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('UNKNOWN_REPO');
    });

    it('refuses a name that cannot become a directory, by name', async () => {
        /*
         * These rules used to be `checkWorkspaceNames` in loadConfig, refusing to BOOT over an
         * ORG_REPOS entry. That worked while an operator typed the list. It cannot now — the list
         * comes from a GitHub App installation and a bad name is one nobody here can rename — so
         * the answer became a 400 about one repository.
         */
        const { app, cookie } = await boot();
        for (const name of ['-x', '.', '..', 'a/b']) {
            const response = await put(app, cookie, [{ owner: 'acme', name }]);
            expect(response.statusCode, name).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code, name).toBe('BAD_REPO_NAME');
        }
    });

    it('refuses two repos that would share one checkout directory', async () => {
        // The directory is the bare repo name, so two owners' same-named repos are one directory.
        // Caught by name here rather than as a unique-index violation, which would be a 503.
        const { app, cookie } = await boot();
        const response = await put(app, cookie, [
            { owner: 'acme', name: 'api' },
            { owner: 'other-owner', name: 'api' },
        ]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('REPO_NAME_CONFLICT');
        expect(response.json().error).toMatch(/share the checkout directory "api"/);
    });

    it('caps how much one member can clone onto a shared volume', async () => {
        // Nothing prunes, and per-member checkouts multiply that by the number of members. This is
        // the only bound there is.
        const { app, cookie } = await boot();
        const many = Array.from({ length: MAX_REPOS_PER_USER + 1 }, (_, i) => ({ owner: 'acme', name: `r${i}` }));
        const response = await put(app, cookie, many);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('TOO_MANY_REPOS');
    });

    it('rejects a body that is not a list of { owner, name }', async () => {
        const { app, cookie } = await boot();
        expect((await put(app, cookie, 'web')).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await put(app, cookie, [{ owner: 'acme' }])).statusCode).toBe(HTTP_BAD_REQUEST);
    });

    it('answers 409 rather than writing rows when workspaces are switched off', async () => {
        const { app, cookie } = await boot({ withRoot: false });
        const response = await put(app, cookie, [{ owner: 'acme', name: 'web' }]);

        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('WORKSPACE_DISABLED');
        expect(store.rows()).toEqual([]);
    });

    it('refuses a selection that would change a purging row, leaving the selection untouched', async () => {
        const { app, caller, cookie } = await boot();
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);
        await put(app, cookie, []);
        mkdirSync(join(root, 'test-org', caller.user.id, 'web'), { recursive: true });
        await store.stampPurge(caller.user.id, { owner: 'acme', name: 'web' });

        const response = await put(app, cookie, [{ owner: 'acme', name: 'web' }]);
        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('PURGE_IN_PROGRESS');
        // The deletion is undisturbed: nothing was re-selected behind its back.
        expect(await store.list(caller.user.id)).toHaveLength(0);
        expect((await store.orphaned(caller.user.id))[0]?.status).toBe('purging');
    });

    it('needs a session', async () => {
        const { app } = await boot();
        const response = await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            payload: { repos: [] },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

const putExecutors = (app: FastifyInstance, cookie: string, executors: unknown) =>
    app.inject({
        method: 'PUT',
        url: '/api/workspace/executors',
        headers: { cookie },
        payload: { executors },
    });

const CLAUDE_CODE = { name: 'main', type: 'claude-code', config: { model: 'sonnet' } };

describe('executors: listing and replacing', () => {
    it('lists executors in the GET payload, without their config', async () => {
        // The config may hold credentials the member pasted, and this payload is a poll that can
        // run every two seconds.
        const { app, cookie, executors } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE]);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.executors).toEqual([expect.objectContaining({ name: 'main', type: 'claude-code' })]);
        expect(JSON.stringify(body)).not.toContain('sonnet');
        expect(executors.rows()[0]?.config).toEqual({ model: 'sonnet' });
    });

    it('replaces the whole list, so replaying the same body changes nothing', async () => {
        const { app, cookie, executors } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE]);
        await putExecutors(app, cookie, [{ name: 'second', type: 'claude-code', config: {} }]);

        expect(executors.rows().map((row) => row.name)).toEqual(['second']);
    });

    it('keeps members apart', async () => {
        const auth = memoryAuthStore();
        const a = auth.seedMember('test-org', 'octocat');
        const b = auth.seedMember('test-org', 'scallop');
        const executors = memoryUserExecutorStore();
        const h = await harness({
            auth,
            userRepos: store,
            userExecutors: executors,
            repos: REPOS,
            config: { workspaceRoot: root, auth: githubAuth() },
        });
        app = h.app;
        const cookieA = await signedIn(auth, a);
        const cookieB = await signedIn(auth, b);

        await putExecutors(h.app, cookieA, [CLAUDE_CODE]);
        await putExecutors(h.app, cookieB, []);

        expect(executors.rows().map((row) => row.userId)).toEqual([a.user.id]);
    });

    it('persists the default and echoes it on the poll, the PUT response and the config read', async () => {
        const { app, cookie } = await boot();
        const put = await putExecutors(app, cookie, [
            CLAUDE_CODE,
            { name: 'oc', type: 'opencode', config: {}, isDefault: true },
        ]);
        expect(put.json().executors).toEqual([
            expect.objectContaining({ name: 'main', isDefault: false }),
            expect.objectContaining({ name: 'oc', isDefault: true }),
        ]);

        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.executors).toEqual([
            expect.objectContaining({ name: 'main', isDefault: false }),
            expect.objectContaining({ name: 'oc', isDefault: true }),
        ]);

        const config = (
            await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } })
        ).json();
        expect(config.executors).toEqual([
            expect.objectContaining({ name: 'main', isDefault: false }),
            expect.objectContaining({ name: 'oc', isDefault: true }),
        ]);
    });

    it('a row sent without isDefault is not the default', async () => {
        const { app, cookie } = await boot();
        const put = await putExecutors(app, cookie, [CLAUDE_CODE]);
        expect(put.json().executors).toEqual([expect.objectContaining({ name: 'main', isDefault: false })]);
    });

    it('a later PUT moves the default', async () => {
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [
            { ...CLAUDE_CODE, isDefault: true },
            { name: 'oc', type: 'opencode', config: {} },
        ]);
        const second = await putExecutors(app, cookie, [
            { ...CLAUDE_CODE, isDefault: false },
            { name: 'oc', type: 'opencode', config: {}, isDefault: true },
        ]);
        expect(second.json().executors).toEqual([
            expect.objectContaining({ name: 'main', isDefault: false }),
            expect.objectContaining({ name: 'oc', isDefault: true }),
        ]);
    });

    it('dropping the default row clears it, rather than reviving it on another row', async () => {
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [{ ...CLAUDE_CODE, isDefault: true }]);
        await putExecutors(app, cookie, [{ name: 'oc', type: 'opencode', config: {} }]);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.executors).toEqual([expect.objectContaining({ name: 'oc', isDefault: false })]);
    });

    it('persists gateFixRounds and echoes it on the PUT response, the poll and the config read', async () => {
        const { app, cookie, executors } = await boot();
        const put = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, gateFixRounds: 5 }]);

        expect(put.statusCode).toBe(HTTP_OK);
        expect(executors.rows()[0]?.gateFixRounds).toBe(5);
        expect(put.json().executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 5 })]);

        const poll = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(poll.executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 5 })]);

        const config = (
            await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } })
        ).json();
        expect(config.executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 5 })]);
    });

    it('a row sent without gateFixRounds gets the default of 3', async () => {
        const { app, cookie, executors } = await boot();
        const put = await putExecutors(app, cookie, [CLAUDE_CODE]);

        expect(put.statusCode).toBe(HTTP_OK);
        expect(executors.rows()[0]?.gateFixRounds).toBe(3);
        expect(put.json().executors).toEqual([expect.objectContaining({ name: 'main', gateFixRounds: 3 })]);
    });
});

describe('executors: validation', () => {
    it('refuses an unknown type', async () => {
        const { app, cookie } = await boot();
        const response = await putExecutors(app, cookie, [{ name: 'x', type: 'codex', config: {} }]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_EXECUTOR_TYPE');
    });

    it('accepts an opencode executor', async () => {
        const { app, cookie, executors } = await boot();
        const response = await putExecutors(app, cookie, [{ name: 'oc', type: 'opencode', config: {} }]);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'oc', type: 'opencode' })]);
    });

    it('refuses a config that is not a JSON object', async () => {
        const { app, cookie } = await boot();
        const NON_OBJECT_NUMBER = 7;
        for (const config of [[], 'text', NON_OBJECT_NUMBER, null]) {
            const response = await putExecutors(app, cookie, [{ name: 'x', type: 'claude-code', config }]);
            expect(response.statusCode, String(config)).toBe(HTTP_BAD_REQUEST);
        }
    });

    it('refuses duplicate names, by name rather than as a key violation', async () => {
        const { app, cookie } = await boot();
        const response = await putExecutors(app, cookie, [
            CLAUDE_CODE,
            { name: 'main', type: 'claude-code', config: {} },
        ]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('EXECUTOR_NAME_CONFLICT');
    });

    it('refuses a name that cannot become a directory, by name', async () => {
        const { app, cookie } = await boot();
        for (const name of ['-x', '.', '..', 'a/b', '']) {
            const response = await putExecutors(app, cookie, [{ name, type: 'claude-code', config: {} }]);
            expect(response.statusCode, name).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code, name).toBe('BAD_EXECUTOR_NAME');
        }
    });

    it('caps how many executors one member can configure', async () => {
        const { app, cookie } = await boot();
        const many = Array.from({ length: MAX_EXECUTORS_PER_USER + 1 }, (_, i) => ({
            name: `e${i}`,
            type: 'claude-code',
            config: {},
        }));
        const response = await putExecutors(app, cookie, many);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('TOO_MANY_EXECUTORS');
    });

    it('rejects a body that is not a list of { name, type, config }', async () => {
        const { app, cookie } = await boot();
        expect((await putExecutors(app, cookie, 'main')).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await putExecutors(app, cookie, [{ name: 'x', type: 'claude-code' }])).statusCode).toBe(
            HTTP_BAD_REQUEST
        );
    });

    it('refuses two defaults as BAD_BODY, not TOO_MANY_EXECUTORS', async () => {
        const { app, cookie, executors } = await boot();
        const response = await putExecutors(app, cookie, [
            { ...CLAUDE_CODE, isDefault: true },
            { name: 'oc', type: 'opencode', config: {}, isDefault: true },
        ]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_BODY');
        expect(executors.rows()).toEqual([]);
    });

    it('refuses a non-boolean isDefault', async () => {
        const { app, cookie } = await boot();
        for (const isDefault of ['yes', 1]) {
            const response = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, isDefault }]);
            expect(response.statusCode, String(isDefault)).toBe(HTTP_BAD_REQUEST);
            expect(response.json().code, String(isDefault)).toBe('BAD_BODY');
        }
    });

    it.each([
        ['a negative number', -1],
        ['over the ceiling', 11],
        ['a fraction', 2.5],
        ['a numeric string', '3'],
        ['null', null],
        ['an object', { rounds: 3 }],
    ])('refuses a gateFixRounds that is not a nonnegative bounded integer (%s)', async (_label, gateFixRounds) => {
        const { app, cookie, executors } = await boot();
        const response = await putExecutors(app, cookie, [{ ...CLAUDE_CODE, gateFixRounds }]);

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_EXECUTOR_ROUNDS');
        expect(executors.rows()).toEqual([]);
    });
});

describe('executors: PUT lifecycle', () => {
    it('answers 409 rather than writing rows when workspaces are switched off', async () => {
        const { app, cookie, executors } = await boot({ withRoot: false });
        const response = await putExecutors(app, cookie, [CLAUDE_CODE]);

        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('WORKSPACE_DISABLED');
        expect(executors.rows()).toEqual([]);
    });

    it('answers 200, because nothing runs in the background', async () => {
        // Unlike the repos route's 202 there is no clone to wait out; the rows are written by the
        // time the response is sent.
        const { app, cookie } = await boot();
        const response = await putExecutors(app, cookie, [CLAUDE_CODE]);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().executors[0]).toMatchObject({ name: 'main', type: 'claude-code' });
    });

    it('needs a session', async () => {
        const { app } = await boot();
        const response = await app.inject({
            method: 'PUT',
            url: '/api/workspace/executors',
            payload: { executors: [] },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});

describe('executors: GET /api/workspace/executors', () => {
    it('reads the whole list back with configs, for the edit dialog', async () => {
        // The on-demand read the dialog opens with: the member's own rows, config included — the
        // poll never carries it, but an edit cannot pre-fill without it.
        const { app, cookie } = await boot();
        await putExecutors(app, cookie, [CLAUDE_CODE]);

        const response = await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().executors).toEqual([
            expect.objectContaining({ name: 'main', type: 'claude-code', config: { model: 'sonnet' } }),
        ]);
    });

    it('keeps members apart on the config read too', async () => {
        // The one route that hands back pasted credentials: a scoping regression here would leak
        // one member's config into another member's edit dialog.
        const auth = memoryAuthStore();
        const a = auth.seedMember('test-org', 'octocat');
        const b = auth.seedMember('test-org', 'scallop');
        const executors = memoryUserExecutorStore();
        const h = await harness({
            auth,
            userRepos: store,
            userExecutors: executors,
            repos: REPOS,
            config: { workspaceRoot: root, auth: githubAuth() },
        });
        app = h.app;
        const cookieA = await signedIn(auth, a);
        const cookieB = await signedIn(auth, b);

        await putExecutors(h.app, cookieA, [CLAUDE_CODE]);
        const response = await h.app.inject({
            method: 'GET',
            url: '/api/workspace/executors',
            headers: { cookie: cookieB },
        });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().executors).toEqual([]);
    });

    it('answers 409 rather than reading rows when workspaces are switched off', async () => {
        const { app, cookie } = await boot({ withRoot: false });
        const response = await app.inject({ method: 'GET', url: '/api/workspace/executors', headers: { cookie } });

        expect(response.statusCode).toBe(HTTP_CONFLICT);
        expect(response.json().code).toBe('WORKSPACE_DISABLED');
    });

    it('needs a session for the config read', async () => {
        const { app } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/workspace/executors' });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });
});
