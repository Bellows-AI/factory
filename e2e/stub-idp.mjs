/**
 * A stand-in for github.com's OAuth endpoints, so the browser check can drive a real sign-in.
 *
 * There is no way to complete a genuine GitHub round trip offline, and the alternative — seeding a
 * session cookie straight into the browser context — would need a test-only login route, i.e. a back
 * door living in production code. A stub the server is pointed at through three environment
 * variables keeps the whole flow real on this side of the wire while nothing leaves the machine.
 *
 * The server logs loudly at boot when these overrides are in use, because a configurable authorize
 * URL that reached a real deployment would be a phishing vector.
 */
import { createServer } from 'node:http';

const port = Number(process.env.STUB_IDP_PORT ?? 8125);
const login = process.env.STUB_IDP_LOGIN ?? 'e2e-user';
const userId = Number(process.env.STUB_IDP_USER_ID ?? 424242);
// The installations the account can see (#99) — the membership decision. Comma-separated ids;
// each becomes an organization named after `stub-org-<id>` at sign-in.
const installations = (process.env.STUB_IDP_INSTALLATIONS ?? '999999')
    .split(',')
    .map((id) => id.trim())
    .filter(/\d+/.test.bind(/\d+/));

const json = (response, body) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
};

createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    // GitHub's consent screen. Nobody is here to consent, so it redirects straight back — echoing
    // the state it was given, which is what the callback checks against the browser's cookie.
    if (url.pathname === '/login/oauth/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', 'stub-code');
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { location: back.toString() });
        response.end();
        return;
    }

    if (url.pathname === '/login/oauth/access_token') {
        json(response, { access_token: 'stub-access-token', token_type: 'bearer' });
        return;
    }

    if (url.pathname === '/user') {
        // The numeric id is the identity; the login is only a label. Both are pinned here so the
        // seeded data and the account that signs in are the same person.
        json(response, { id: userId, login, name: 'E2E User', avatar_url: null });
        return;
    }

    // The membership decision itself: what the callback asks with the exchanged token (#99).
    if (url.pathname === '/user/installations') {
        json(response, {
            installations: installations.map((id) => ({ id: Number(id), account: { login: `stub-org-${id}` } })),
        });
        return;
    }

    // The App slug, for building the install-page redirect. The offline board never asks (it has
    // no App client), but the seam keeps a future online check honest.
    if (url.pathname === '/app') {
        json(response, { slug: 'stub-app' });
        return;
    }

    response.writeHead(404);
    response.end();
}).listen(port, '127.0.0.1', () => {
    console.log(`[stub-idp] listening on 127.0.0.1:${port} as ${login} (#${userId})`);
});
