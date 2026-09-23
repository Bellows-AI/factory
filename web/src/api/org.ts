import { JSON_HEADERS } from '@factory-ai/core';
/**
 * The one organization switch. The app bar's selector and the mobile drawer's both call this —
 * the switch is a server-side session change, and on success the reload makes every org-scoped
 * read re-probe from scratch. A refusal (403/400 — the membership moved under the selector)
 * leaves the page untouched: the select's value is bound to the payload, so the next poll
 * renders it back on the org the session still holds.
 */
export function switchOrg(orgId: string): void {
    void fetch('/api/auth/org', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ orgId }),
    })
        .then((response) => {
            if (response.ok) window.location.reload();
        })
        .catch(() => {});
}
