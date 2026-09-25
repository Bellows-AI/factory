/**
 * The ONE read of a failed response's body, shared by every hook in `web/src/api`. Twenty-two
 * hand-rolled copies of `(await response.json().catch(() => ({}))) as { error?: string }` lived
 * here before, and twenty-one of them dropped `code` — the machine-readable half of the API's
 * refusal shape (`core/src/error-codes.ts`) that exists precisely so a validator refusal is
 * diagnosable rather than only readable.
 */

/** A refusal as the SPA carries it: the sentence to show, and the API's code when it named one. */
export interface Refusal {
    error: string;
    code?: string;
}

/**
 * Reads a failed response's refusal, best-effort: never throws on a non-JSON or empty body, and
 * never reads a body twice — call it once per response, on the `!response.ok` arm only.
 *
 * `verb` is the caller's own fallback wording for a server that named nothing; the status is
 * appended, so pass `'Could not save'`, not `'Could not save (500)'`. Callers whose result shape
 * has no room for a code take `.error` alone; the rest spread the whole object.
 */
export async function refusalOf(response: Response, verb = 'Request failed'): Promise<Refusal> {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    const error = body.error ?? `${verb} (${response.status})`;
    return body.code ? { error, code: body.code } : { error };
}
