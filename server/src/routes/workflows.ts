import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import type { WorkflowStore } from '../db/workflow-store.js';
import { blockCatalog } from '../db/workflow-blocks/index.js';
import { UUID, bad, badSegment, body } from './helpers.js';

export interface WorkflowRouteDeps {
    /**
     * The per-org runtimes; the store a request touches is the CALLER's org's. Workflows are
     * org-scoped rows, so the resolution is the same one every org-scoped route makes.
     */
    orgs: OrgRegistry;
}

const BODY_LIMIT = 64 * 1024;

/**
 * The repository context a list or a repo-scoped create names: `owner/name`, the same label a job
 * row carries. Shape only — the same discipline as the job's repo label; a repo nobody can see
 * simply has no workflows.
 */
function repoReason(value: string): string | null {
    const parts = value.split('/');
    if (parts.length !== 2) return 'repo must be owner/name';
    for (const [label, part] of [
        ['owner', parts[0]!],
        ['name', parts[1]!],
    ] as const) {
        if (part.length === 0 || part.length > 100) return `${label} must be 1..100 characters`;
        const reason = badSegment(label, part);
        if (reason) return reason;
    }
    return null;
}

/**
 * Workflow definitions: the process a task walks, stored per scope and validated strictly by the
 * store (docs/workflows.md). A person's surface, like every task route: the board secret never gets
 * past the auth wall here, because workflow selection is a human's decision, never a driver's.
 *
 * - `GET /api/workflows?repo=owner/name` — the caller-visible list (the org's, their own, the
 *   named repository's), the composer's dropdown feed.
 * - `POST /api/workflows` — create; org-level is an admin's move, user- and repo-level are any
 *   member's. A `kind: "block"` node is compiled (registry lookup, availability, config, expansion)
 *   before storage — an unknown/unavailable/misconfigured block refuses the same way a schema
 *   error does (issue #204, docs/workflows.md "Built-in blocks").
 * - `GET /api/workflow-blocks` — the board-owned catalog every `uses` may reference: id,
 *   description, config schema, availability. Never a prompt or script body — those stay inside
 *   the registry, unserialized. Static, org-independent metadata; gated the same as the other
 *   routes here because block selection is the same human authoring surface.
 * - `DELETE /api/workflows/:id` — an admin, the owning member, or any member within repo scope.
 *
 * Refusals carry named codes: a pasted foreign pipeline fails loudly (UNKNOWN_KEY, UNKNOWN_NODE,
 * BAD_RULE, … are the validator's own), and NAME_TAKEN answers 409 — the request was
 * well-formed, the name was gone.
 */
export const workflowRoutes =
    ({ orgs }: WorkflowRouteDeps): FastifyPluginAsync =>
    async (app) => {
        /**
         * The workflow definitions a request touches are its caller's org's (#99) — the same
         * resolution the job board makes. Absent in the route-test mode with no stores behind
         * the registry.
         */
        const storeOf = async (request: FastifyRequest): Promise<WorkflowStore | null> => {
            const rt = await orgs.for(orgOf(request));
            return rt?.workflows ?? null;
        };

        app.get('/api/workflows', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'WORKFLOWS_UNAVAILABLE', 'No workflow store for this organization', 503);
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);

            const repoField = body(request.query as unknown).repo;
            if (repoField !== undefined && (typeof repoField !== 'string' || repoReason(repoField))) {
                return bad(
                    reply,
                    'BAD_REPO',
                    typeof repoField === 'string'
                        ? (repoReason(repoField) ?? 'repo must be owner/name')
                        : 'repo must be a string'
                );
            }
            const workflows = await store.listVisible({
                userId: caller.user.id,
                repo: typeof repoField === 'string' ? repoField : null,
            });
            return reply.code(200).send({ workflows });
        });

        // Board-owned, org-independent metadata — no `storeOf` gate. Auth-gated anyway: block
        // selection is part of the same human workflow-authoring surface as the routes above.
        app.get('/api/workflow-blocks', { bodyLimit: 4096 }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            return reply.code(200).send({ blocks: blockCatalog() });
        });

        app.post('/api/workflows', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'WORKFLOWS_UNAVAILABLE', 'No workflow store for this organization', 503);
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);

            const fields = body(request.body);
            const { name, definition } = fields;
            if (typeof name !== 'string') return bad(reply, 'BAD_NAME', 'name must be a string');

            // Exactly one scope, named in the body like an env-var PUT names its path. Org-level
            // is admin-gated here — a member's private process must not quietly become everyone's
            // default. Repo- and user-level are any member's: a member's own process, for their
            // own tasks or a repository they already queue against.
            const scopeName = fields.scope;
            if (scopeName !== 'org' && scopeName !== 'user' && scopeName !== 'repo') {
                return bad(reply, 'BAD_SCOPE', 'scope must be "org", "user" or "repo"');
            }
            if (scopeName === 'org' && caller.role !== 'admin') {
                return bad(reply, 'FORBIDDEN', 'Only an admin can publish an org-level workflow', 403);
            }
            let repo: string | null = null;
            if (scopeName === 'repo') {
                if (typeof fields.repo !== 'string')
                    return bad(reply, 'BAD_SCOPE', 'repo scope must name a repository');
                const reason = repoReason(fields.repo);
                if (reason) return bad(reply, 'BAD_SCOPE', reason);
                repo = fields.repo;
            }

            const created = await store.create({
                name,
                scope:
                    scopeName === 'org'
                        ? { kind: 'org' }
                        : scopeName === 'user'
                          ? { kind: 'user', userId: caller.user.id }
                          : { kind: 'repo', owner: repo!.split('/')[0]!, name: repo!.split('/')[1]! },
                definition,
                createdBy: caller.user.id,
            });
            if ('refused' in created) {
                const taken = created.code === 'NAME_TAKEN';
                return bad(reply, created.code, created.message, taken ? 409 : 400);
            }
            const record = await store.get(created.id);
            return reply.code(201).send(record);
        });

        app.delete('/api/workflows/:id', { bodyLimit: 4096 }, async (request, reply) => {
            const store = await storeOf(request);
            if (!store) return bad(reply, 'WORKFLOWS_UNAVAILABLE', 'No workflow store for this organization', 503);
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            const { id } = request.params as { id: string };
            if (!UUID.test(id)) return bad(reply, 'BAD_ID', 'id must be a uuid');

            const record = await store.get(id);
            if (!record) return reply.code(404).send({ error: 'No such workflow' });
            if (
                caller.role !== 'admin' &&
                (record.scope === 'org' || (record.scope === 'user' && record.userId !== caller.user.id))
            ) {
                return bad(reply, 'FORBIDDEN', 'You cannot delete this workflow', 403);
            }
            const removed = await store.remove(id);
            return reply.code(200).send({ id, removed });
        });
    };
