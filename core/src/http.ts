/** The JSON media type and the request header that carries it — one spelling for every caller. */
export const JSON_CONTENT_TYPE = 'application/json';

export const CONTENT_TYPE_HEADER = 'content-type';

export const JSON_HEADERS = { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE } as const;
