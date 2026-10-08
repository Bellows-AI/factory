import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The JSON media type and the header that carries it. Copied from core/src/http.ts rather than
 * imported, for the same reason as ./executors.ts.
 */
export const JSON_CONTENT_TYPE = 'application/json';

export const CONTENT_TYPE_HEADER = 'content-type';

/**
 * The error codes the board's answer bodies carry that the driver branches on, where one status
 * means two things (a 409 is a lost lease or a refusal; a 404 a removed thread or an unknown key).
 * Copied from core/src/error-codes.ts, for the same reason.
 */
export const LEASE_LOST_CODE = 'LEASE_LOST';
export const NOT_FOUND_CODE = 'NOT_FOUND';

/** What the kubernetes API requires of a PATCH body that is a JSON merge patch. */
export const MERGE_PATCH_CONTENT_TYPE = 'application/merge-patch+json';

/** Writes one JSON answer. */
export const respondJson = (reply: ServerResponse, status: number, body: unknown): void => {
    reply.statusCode = status;
    reply.setHeader(CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE);
    reply.end(JSON.stringify(body));
};

/** The request body as text, or null when it outgrew `limit` bytes — declared or streamed. */
export const readBody = async (request: IncomingMessage, limit: number): Promise<string | null> => {
    const declared = Number(request.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > limit) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
        total += (chunk as Buffer).length;
        if (total > limit) return null;
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
};
