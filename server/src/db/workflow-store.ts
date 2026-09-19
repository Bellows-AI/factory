import type { Sql, TransactionSql } from 'postgres';
import {
    type DefinitionRefusal,
    type WorkflowDefinition,
    type WorkflowParam,
    WORKFLOW_NAME,
    SCOPE_SEGMENT,
    validateDefinition,
} from './workflow-schema.js';
import { BASE_WORKFLOW } from './workflow-templates.js';

/**
 * Which scope a workflow belongs to — exactly one, the env-var scopes: the organization, a member,
 * or a repository label. Org-level creation is an admin's move; a member may create user-level and
 * repo-level definitions (the route decides, from the live caller — the store only shapes rows).
 */
export type WorkflowScope =
    | { kind: 'org' }
    | { kind: 'user'; userId: string }
    | { kind: 'repo'; owner: string; name: string };

/** What the list route serves: enough for the composer's dropdown, never the 16 KiB body. */
export interface WorkflowSummary {
    id: string;
    name: string;
    scope: 'org' | 'user' | 'repo';
    /** The scope's own labels — the owning account, or the `owner/name` the repo row names. */
    userId: string | null;
    repo: string | null;
    /**
     * The declared launch parameters — what the composer renders as explicit inputs and what
     * `POST /api/jobs` requires beside the command. [] on a param-less definition.
     */
    params: WorkflowParam[];
    createdAt: string;
    updatedAt: string;
}

/** The full record: the summary plus the stored (validated) definition, served verbatim. */
export interface WorkflowRecord extends WorkflowSummary {
    definition: WorkflowDefinition;
}

/** The caller a list or resolution is scoped to. Null members degrade on their own, like resolveFor. */
export interface WorkflowTarget {
    userId: string | null;
    /** `owner/name`, the same label a job row carries. Null reads no repo level. */
    repo: string | null;
}

/** Why a create was refused. Every code is named — a bad definition is diagnosable from the answer. */
export interface WorkflowRefusal {
    code: 'BAD_NAME' | 'BAD_SCOPE' | 'NAME_TAKEN' | DefinitionRefusal['code'];
    message: string;
}

export type CreateResult = { id: string } | ({ refused: true } & WorkflowRefusal);

interface WorkflowRow {
    id: string;
    name: string;
    user_id: string | null;
    repo_owner: string | null;
    repo_name: string | null;
    definition: WorkflowDefinition;
    created_at: Date;
    updated_at: Date;
}

const toSummary = (row: WorkflowRow): WorkflowSummary => ({
    id: row.id,
    name: row.name,
    scope: row.user_id !== null ? 'user' : row.repo_owner !== null ? 'repo' : 'org',
    userId: row.user_id,
    repo: row.repo_owner !== null && row.repo_name !== null ? `${row.repo_owner}/${row.repo_name}` : null,
    // `?? []` is the grammar's own normalization (absent in the JSON = []), applied to rows whose
    // jsonb was stored before parameters existed.
    params: row.definition.params ?? [],
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

// The same grammar normalization as toSummary, applied to the definition itself: rows whose
// jsonb predates 030 carry no `params` key, and checkWorkflowParams iterates it at launch.
const toRecord = (row: WorkflowRow): WorkflowRecord => ({
    ...toSummary(row),
    definition: { ...row.definition, params: row.definition.params ?? [] },
});

/**
 * The organization is bound at construction, the way every store is: one deployment, one org, and
 * a per-call parameter is one more thing a write path can forget. `ready` gates every query the
 * same way — migrations retry with backoff while the database container starts.
 */
export function createWorkflowStore({ sql, orgId, ready }: { sql: Sql; orgId: string; ready?: Promise<unknown> }): {
    create(input: {
        name: string;
        scope: WorkflowScope;
        definition: unknown;
        createdBy: string | null;
    }): Promise<CreateResult>;
    listVisible(target: WorkflowTarget): Promise<WorkflowSummary[]>;
    get(id: string): Promise<WorkflowRecord | null>;
    remove(id: string): Promise<boolean>;
    findByName(name: string, target: WorkflowTarget): Promise<WorkflowRecord | null>;
    seedBase(): Promise<void>;
} {
    const gate = async () => {
        if (ready) await ready;
    };

    /**
     * Caller visibility: the org's definitions, the caller's own user-level ones, and the
     * repo-scoped ones for the requested repository context. A null userId or repo degrades its
     * own level away — the resolveFor precedent — so an unattributed caller reads org rows only.
     */
    const visibleWhere = (exec: Sql | TransactionSql, target: WorkflowTarget) => {
        const [owner, name] = target.repo ? target.repo.split('/') : [null, null];
        return exec`
            and (
                (user_id is null and repo_owner is null)
                or user_id = ${target.userId}
                or (repo_owner = ${owner} and repo_name = ${name})
            )`;
    };

    /** Repo over user over org — the one precedence rule, findByName's tie-break. */
    const PRECEDENCE = sql`
        order by case
            when repo_owner is not null then 0
            when user_id is not null then 1
            else 2
        end asc`;

    return {
        async create({ name, scope, definition, createdBy }) {
            await gate();
            if (typeof name !== 'string' || !WORKFLOW_NAME.test(name.trim()) || name.trim() !== name) {
                return { refused: true, code: 'BAD_NAME', message: 'name must be 1..100 characters without padding' };
            }
            if (scope.kind === 'user' && !SCOPE_SEGMENT.test(scope.userId)) {
                return { refused: true, code: 'BAD_SCOPE', message: 'user scope must name an account id' };
            }
            if (scope.kind === 'repo') {
                for (const [label, part] of [
                    ['owner', scope.owner],
                    ['name', scope.name],
                ] as const) {
                    if (!SCOPE_SEGMENT.test(part)) {
                        return {
                            refused: true,
                            code: 'BAD_SCOPE',
                            message: `repo scope ${label} must be a checkout-safe segment`,
                        };
                    }
                }
            }
            // The base workflow's org slot is the board's: seedBase refreshes that one row to the
            // shipped template every boot, so an admin definition here would be silently replaced
            // on the next start. The name stays reserved in the org scope; sibling scopes keep
            // their own same-named definitions untouched.
            if (scope.kind === 'org' && name.trim() === BASE_WORKFLOW.name) {
                return {
                    refused: true,
                    code: 'NAME_TAKEN',
                    message: `"${BASE_WORKFLOW.name}" is reserved for the board's own org-level workflow`,
                };
            }
            const check = validateDefinition(definition);
            if (!check.ok) return { refused: true, code: check.refusal.code, message: check.refusal.message };

            const values = {
                org_id: orgId,
                name: name.trim(),
                user_id: scope.kind === 'user' ? scope.userId : null,
                repo_owner: scope.kind === 'repo' ? scope.owner : null,
                repo_name: scope.kind === 'repo' ? scope.name : null,
                definition: check.definition as never,
                created_by: createdBy,
            };
            try {
                const rows = await sql`
                    insert into workflow ${sql([values], 'org_id', 'name', 'user_id', 'repo_owner', 'repo_name', 'definition', 'created_by')}
                    returning id
                `;
                return { id: (rows as unknown as { id: string }[])[0]!.id };
            } catch (e) {
                const err = e as { code?: string };
                if (err.code === '23505') {
                    return {
                        refused: true,
                        code: 'NAME_TAKEN',
                        message: `a workflow named "${name.trim()}" already exists in this scope`,
                    };
                }
                throw e;
            }
        },

        async listVisible(target) {
            await gate();
            const rows = await sql<WorkflowRow[]>`
                select id, name, user_id, repo_owner, repo_name, definition, created_at, updated_at
                from workflow
                where org_id = ${orgId} ${visibleWhere(sql, target)}
                order by name asc
            `;
            return rows.map(toSummary);
        },

        async get(id) {
            await gate();
            const rows = await sql<WorkflowRow[]>`
                select * from workflow where org_id = ${orgId} and id = ${id}
            `;
            return rows[0] ? toRecord(rows[0]) : null;
        },

        async remove(id) {
            await gate();
            const rows = await sql<{ id: string }[]>`
                delete from workflow where org_id = ${orgId} and id = ${id} returning id
            `;
            return rows.length > 0;
        },

        async findByName(name, target) {
            await gate();
            // An explicit name resolves within the caller's VISIBLE scopes, repo over user over
            // org — the same name in two scopes resolves to the more specific. A name matching
            // nothing visible answers null, which the route turns into the named refusal the
            // selection spec asks for.
            const rows = await sql<WorkflowRow[]>`
                select * from workflow
                where org_id = ${orgId}
                  and name = ${name}
                  ${visibleWhere(sql, target)}
                  ${PRECEDENCE}
                limit 1
            `;
            return rows[0] ? toRecord(rows[0]) : null;
        },

        async seedBase() {
            await gate();
            // The base workflow ships with the board, org-level. Its row is the board's, so it
            // tracks the board's code: a definition an older boot seeded (a pre-parameter shape,
            // say) refreshes to what this build ships instead of serving a stale process forever
            // — the name is reserved in the org scope (create refuses it), so there is no edit
            // path and no admin row for the refresh to run over. A running thread is safe
            // regardless, having frozen its snapshot at creation. A member's own same-named
            // definition in another scope is never touched. Idempotent by name — the
            // `is distinct from` guard makes a matching row a no-op, and the insert populates
            // only an absent row.
            await sql`
                update workflow
                set definition = ${sql.json(BASE_WORKFLOW.definition as never)}, updated_at = now()
                where org_id = ${orgId}
                  and name = ${BASE_WORKFLOW.name}
                  and user_id is null and repo_owner is null and repo_name is null
                  and definition is distinct from ${sql.json(BASE_WORKFLOW.definition as never)}
            `;
            await sql`
                insert into workflow (org_id, name, definition)
                values (${orgId}, ${BASE_WORKFLOW.name}, ${BASE_WORKFLOW.definition as never})
                on conflict do nothing
            `;
        },
    };
}

export type WorkflowStore = ReturnType<typeof createWorkflowStore>;
