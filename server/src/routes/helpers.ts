import type { FastifyReply } from 'fastify';

/**
 * The shapes every route here repeats.
 *
 * Extracted when `routes/workspace.ts` arrived and copied them out of `routes/jobs.ts` — at which
 * point the 503 body existed in four places and would have drifted in one of them.
 */

export { UUID } from '../config.js';

/** A JSON body, or an empty object for anything that is not one. Never throws. */
export const body = (raw: unknown): Record<string, unknown> =>
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

/** A refusal with a machine-readable code. 400 unless the caller says otherwise. */
export const bad = (reply: FastifyReply, code: string, error: string, status = 400) =>
    reply.code(status).send({ error, code });

/**
 * The path-segment rules, applied where a name actually becomes a directory.
 *
 * These used to be `checkWorkspaceNames` in config.ts, run at boot against ORG_REPOS. That worked
 * while an operator typed the list; it cannot now, because the list comes from a GitHub App
 * installation and a name this rejects is one nobody here can rename. So the answer moved from "the
 * deployment will not boot" to "this one repository is refused, by name" — and `user_repo_name_ck`
 * says the same thing a third time, at the row.
 *
 * Shared with the jobs route, which applies the same rules to the repo/executor labels a task is
 * queued with — display metadata, but a name that cannot be a directory cannot be a checkout or an
 * executor either.
 */
export function badSegment(label: string, value: string): string | null {
    if (!value) return `${label} is empty`;
    if (/[/\\]/.test(value)) return `${label} contains a path separator`;
    // A leading '-' is read by git as an option rather than a path; '.' and '..' are not names.
    if (/^[-.]/.test(value)) return `${label} starts with "-" or "."`;
    return null;
}

/**
 * Every store call funnels through here: a failure is a 503, matching the ingest routes.
 *
 * The result is wrapped rather than nullable because several store methods return null for a
 * perfectly good answer — no work waiting, no such job — and a bare null could not tell that from
 * a database that is down.
 */
export async function guard<T>(
    reply: FastifyReply,
    log: (e: Error) => void,
    run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
        return { ok: true, value: await run() };
    } catch (e) {
        log(e as Error);
        await reply.code(503).send({ error: (e as Error).message, code: 'UNAVAILABLE' });
        return { ok: false };
    }
}
