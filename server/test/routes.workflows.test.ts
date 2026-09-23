import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { WorkflowDefinition } from '../src/db/workflow-schema.js';
import type { WorkflowRecord, WorkflowStore } from '../src/db/workflow-store.js';
import { githubAuth, memoryAuthStore, signedIn, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

/**
 * Offline: the HTTP contract of the workflow routes against an in-memory store double. The store's
 * own rules — the strict validator, the scope uniqueness — are covered by
 * server/test-db/workflow-store.test.ts, which needs a container.
 */

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const WF_ID = '99999999-9999-4999-8999-999999999999';

const definition: WorkflowDefinition = {
    entry: 'a',
    params: [],
    nodes: [
        { name: 'a', kind: 'agent', session: 'resume', prompt: 'work' },
        { name: 'b', kind: 'agent', session: 'fresh', prompt: 'check', publish: true },
    ],
    edges: [{ from: 'a', to: 'b', when: 'succeeded' }],
};

const record: WorkflowRecord = {
    id: WF_ID,
    name: 'fix-issue',
    scope: 'org',
    userId: null,
    repo: null,
    params: [{ name: 'issue', pattern: '#\\d+', description: 'ref', example: '#1' }],
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    definition,
};

/** The in-memory double: the route tests are about the HTTP contract, not the SQL. */
function stubWorkflows(options: { get?: WorkflowRecord | null; remove?: boolean } = {}): WorkflowStore & {
    created: { name: string; scope: string; createdBy: string | null }[];
    removed: string[];
} {
    const stub = {
        created: [] as { name: string; scope: string; createdBy: string | null }[],
        removed: [] as string[],
        async create(input: { name: string; scope: { kind: string }; createdBy: string | null }) {
            stub.created.push({
                name: input.name,
                scope: input.scope.kind,
                createdBy: input.createdBy,
            });
            return { id: WF_ID };
        },
        async listVisible() {
            return [record];
        },
        async get(id: string) {
            return options.get === undefined ? record : options.get;
        },
        async remove(id: string) {
            stub.removed.push(id);
            return options.remove ?? true;
        },
        async findByName() {
            return null;
        },
        async seedBase() {},
    };
    return stub as unknown as WorkflowStore & typeof stub;
}

async function boot(workflows: WorkflowStore & { created: unknown[]; removed: string[] }) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const config = testConfig({ auth: githubAuth() });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, workflows, telemetry: stubTelemetryClient() }),
        auth,
    });
    app = instance;
    return {
        instance,
        admin,
        member,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

describe('GET /api/workflows', () => {
    it("needs a session — workflow selection is a person's decision", async () => {
        const workflows = stubWorkflows();
        const { instance } = await boot(workflows);
        expect((await instance.inject({ method: 'GET', url: '/api/workflows' })).statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('refuses a worker-style bearer token at the wall', async () => {
        const workflows = stubWorkflows();
        const { instance } = await boot(workflows);
        const response = await instance.inject({
            method: 'GET',
            url: '/api/workflows',
            headers: { authorization: 'Bearer fwt_not-a-worker-token' },
        });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('lists the caller-visible workflows with their scopes', async () => {
        const workflows = stubWorkflows();
        const { instance, memberCookie } = await boot(workflows);
        const response = await instance.inject({
            method: 'GET',
            url: '/api/workflows?repo=acme/web',
            headers: { cookie: memberCookie },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json().workflows).toEqual([record]);
    });

    it('refuses a repo context that is not owner/name', async () => {
        const workflows = stubWorkflows();
        const { instance, memberCookie } = await boot(workflows);
        const response = await instance.inject({
            method: 'GET',
            url: '/api/workflows?repo=not-a-repo',
            headers: { cookie: memberCookie },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_REPO');
    });
});

describe('POST /api/workflows', () => {
    it('needs a session', async () => {
        const workflows = stubWorkflows();
        const { instance } = await boot(workflows);
        const response = await instance.inject({ method: 'POST', url: '/api/workflows', payload: {} });
        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
    });

    it('gates org-level creation to an admin', async () => {
        const workflows = stubWorkflows();
        const { instance, memberCookie, admin, adminCookie } = await boot(workflows);
        const payload = { name: 'fix-issue', scope: 'org', definition };

        const memberPost = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload,
            headers: { cookie: memberCookie },
        });
        expect(memberPost.statusCode).toBe(HTTP_FORBIDDEN);

        const adminPost = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload,
            headers: { cookie: adminCookie },
        });
        expect(adminPost.statusCode).toBe(HTTP_CREATED);
        expect(workflows.created[0]).toMatchObject({ name: 'fix-issue', scope: 'org', createdBy: admin.user.id });
    });

    it('lets a member create a user-level and a repo-level workflow', async () => {
        const workflows = stubWorkflows();
        const { instance, memberCookie } = await boot(workflows);
        const userPost = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'mine', scope: 'user', definition },
            headers: { cookie: memberCookie },
        });
        expect(userPost.statusCode).toBe(HTTP_CREATED);
        const repoPost = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'repo-process', scope: 'repo', repo: 'acme/web', definition },
            headers: { cookie: memberCookie },
        });
        expect(repoPost.statusCode).toBe(HTTP_CREATED);
        expect(workflows.created.map((row) => row.scope)).toEqual(['user', 'repo']);
    });

    it("refuses a repo scope outside the caller's access, like POST /api/jobs does", async () => {
        const workflows = stubWorkflows();
        const { instance, memberCookie } = await boot(workflows);
        const response = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'x', scope: 'repo', repo: 'no owner', definition },
            headers: { cookie: memberCookie },
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('BAD_SCOPE');
    });

    it("serves the validator's named refusals as 400 and a taken name as 409", async () => {
        const workflows = stubWorkflows();
        const { instance, adminCookie } = await boot(workflows);
        workflows.create = (async () => ({
            refused: true as const,
            code: 'UNKNOWN_KEY' as const,
            message: 'unknown definition key "trigger"',
        })) as never;
        const badPost = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'x', scope: 'org', definition: { trigger: true } },
            headers: { cookie: adminCookie },
        });
        expect(badPost.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(badPost.json().code).toBe('UNKNOWN_KEY');

        workflows.create = (async () => ({
            refused: true as const,
            code: 'NAME_TAKEN' as const,
            message: 'a workflow named "fix-issue" already exists in this scope',
        })) as never;
        const takenPost = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'fix-issue', scope: 'org', definition },
            headers: { cookie: adminCookie },
        });
        expect(takenPost.statusCode).toBe(HTTP_CONFLICT);
        expect(takenPost.json().code).toBe('NAME_TAKEN');
    });

    it("serves the compiler's block refusals as 400, same as a schema refusal — the store surfaces both alike", async () => {
        const workflows = stubWorkflows();
        const { instance, adminCookie } = await boot(workflows);
        workflows.create = (async () => ({
            refused: true as const,
            code: 'BLOCK_UNAVAILABLE' as const,
            message: 'node "review-comments" uses "builtin/github-review-reconcile", which is not yet available',
        })) as never;
        const response = await instance.inject({
            method: 'POST',
            url: '/api/workflows',
            payload: { name: 'x', scope: 'org', definition },
            headers: { cookie: adminCookie },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BLOCK_UNAVAILABLE');
    });
});

describe('GET /api/workflow-blocks', () => {
    it('needs a session — same surface as workflow selection', async () => {
        const workflows = stubWorkflows();
        const { instance } = await boot(workflows);
        const response = await instance.inject({ method: 'GET', url: '/api/workflow-blocks' });
        expect(response.statusCode).toBe(401);
    });

    it('serves the catalog for a signed-in caller — metadata only, never a prompt or script body', async () => {
        const workflows = stubWorkflows();
        const { instance, memberCookie } = await boot(workflows);
        const response = await instance.inject({
            method: 'GET',
            url: '/api/workflow-blocks',
            headers: { cookie: memberCookie },
        });
        expect(response.statusCode).toBe(200);
        const { blocks } = response.json();
        expect(blocks.map((b: { id: string }) => b.id).sort()).toEqual(
            ['builtin/github-review-reconcile', 'builtin/merge-conflict-autofix'].sort()
        );
        for (const block of blocks) {
            expect(typeof block.description).toBe('string');
            expect(Array.isArray(block.configSchema)).toBe(true);
            expect(block).not.toHaveProperty('expand');
            expect(block).not.toHaveProperty('prompt');
            expect(block).not.toHaveProperty('script');
        }
        // Both reserved ids are real and available: merge-conflict-autofix (issue #122) and
        // github-review-reconcile (issue #133).
        expect(blocks.find((b: { id: string }) => b.id === 'builtin/github-review-reconcile')?.available).toBe(true);
        expect(blocks.find((b: { id: string }) => b.id === 'builtin/merge-conflict-autofix')?.available).toBe(true);
    });
});

describe('DELETE /api/workflows/:id', () => {
    it('refuses a member deleting an org-level workflow, and answers an admin', async () => {
        const workflows = stubWorkflows();
        const { instance, memberCookie, adminCookie } = await boot(workflows);
        const memberDelete = await instance.inject({
            method: 'DELETE',
            url: `/api/workflows/${WF_ID}`,
            headers: { cookie: memberCookie },
        });
        expect(memberDelete.statusCode).toBe(HTTP_FORBIDDEN);

        const adminDelete = await instance.inject({
            method: 'DELETE',
            url: `/api/workflows/${WF_ID}`,
            headers: { cookie: adminCookie },
        });
        expect(adminDelete.statusCode).toBe(HTTP_OK);
        expect(workflows.removed).toEqual([WF_ID]);
    });

    it('answers 404 for an id that resolves nothing', async () => {
        const workflows = stubWorkflows({ get: null });
        const { instance, adminCookie } = await boot(workflows);
        const response = await instance.inject({
            method: 'DELETE',
            url: `/api/workflows/${WF_ID}`,
            headers: { cookie: adminCookie },
        });
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(workflows.removed).toEqual([]);
    });
});
