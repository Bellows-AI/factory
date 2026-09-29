/**
 * The JSON media type and the header that carries it. Copied from core/src/http.ts rather than
 * imported: this package depends on nothing, core included — the same rule driver/ runs under,
 * for the same reason (a board client needs only fetch, not the server's dependency tree).
 */
export const JSON_CONTENT_TYPE = 'application/json';

export const CONTENT_TYPE_HEADER = 'content-type';
