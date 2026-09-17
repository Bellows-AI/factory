import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';

const SECRET = 'webhook-secret-for-the-installation-round-trip';
const ORG = '424242';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

/** A github-mode config, since the webhook deployment is a github one; the secret decides the route. */
async function build(webhookSecret: string | null = SECRET) {
    const store = memoryAuthStore();
    const config = testConfig({ auth: githubAuth(), webhookSecret });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
        auth: store,
    });
    app = instance;
    return { app: instance, store };
}

const signature = (body: string, secret = SECRET) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** The shape GitHub sends for organization.member_removed. */
const memberRemoved = (githubUserId: number) =>
    JSON.stringify({
        action: 'member_removed',
        membership: { role: 'member', user: { id: githubUserId, login: 'octocat' } },
        installation: { id: Number(ORG) },
        organization: { login: 'acme' },
        sender: { login: 'someone-else' },
    });

const deliver = (body: string, headers: Record<string, string>) =>
    app!.inject({
        method: 'POST',
        url: '/api/github/webhook',
        payload: body,
        headers: { 'content-type': 'application/json', ...headers },
    });

describe('POST /api/github/webhook', () => {
    it('deletes the membership the moment GitHub reports member_removed', async () => {
        const { store } = await build();
        const caller = store.seedMember(ORG, 'octocat');
        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);

        const body = memberRemoved(caller.user.githubUserId);
        const response = await deliver(body, {
            'x-github-event': 'organization',
            'x-hub-signature-256': signature(body),
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        // The deletion IS the revocation: every credential joins through this row.
        expect(await store.membershipsOf(caller.user.id)).toEqual([]);
    });

    it('ignores a member_removed whose installation or user id is not a number', async () => {
        // A payload without the App's installation id names no org of ours, and a membership
        // without a numeric user id names no account — both are a 200 no-op, never a deletion.
        const { store } = await build();
        const caller = store.seedMember(ORG, 'octocat');
        const body = JSON.stringify({
            action: 'member_removed',
            membership: { role: 'member', user: { login: 'octocat' } },
            organization: { login: 'acme' },
        });

        const response = await deliver(body, {
            'x-github-event': 'organization',
            'x-hub-signature-256': signature(body),
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
    });

    it('401s a body signed with the wrong secret, and deletes nothing', async () => {
        const { store } = await build();
        const caller = store.seedMember(ORG, 'octocat');
        const body = memberRemoved(caller.user.githubUserId);

        const response = await deliver(body, {
            'x-github-event': 'organization',
            'x-hub-signature-256': signature(body, 'a-secret-nobody-configured'),
        });

        expect(response.statusCode).toBe(401);
        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
    });

    it('401s a missing signature header, and deletes nothing', async () => {
        const { store } = await build();
        const caller = store.seedMember(ORG, 'octocat');
        const body = memberRemoved(caller.user.githubUserId);

        const response = await deliver(body, { 'x-github-event': 'organization' });

        expect(response.statusCode).toBe(401);
        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
    });

    it('ignores other events with a 200 — GitHub retries a non-2xx forever', async () => {
        const { store } = await build();
        const caller = store.seedMember(ORG, 'octocat');
        const body = memberRemoved(caller.user.githubUserId);

        const push = await deliver(body, {
            'x-github-event': 'push',
            'x-hub-signature-256': signature(body),
        });
        const noEvent = await deliver(body, { 'x-hub-signature-256': signature(body) });

        expect(push.statusCode).toBe(200);
        expect(noEvent.statusCode).toBe(200);
        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
    });

    it('ignores other organization actions', async () => {
        const { store } = await build();
        const caller = store.seedMember(ORG, 'octocat');
        const body = JSON.stringify({
            action: 'member_added',
            membership: { user: { id: caller.user.githubUserId, login: 'octocat' } },
            installation: { id: Number(ORG) },
        });

        const response = await deliver(body, {
            'x-github-event': 'organization',
            'x-hub-signature-256': signature(body),
        });

        expect(response.statusCode).toBe(200);
        expect(await store.membershipsOf(caller.user.id)).toEqual([{ id: ORG, name: ORG }]);
    });

    it('answers a signed body it cannot parse with 200, never a 5xx', async () => {
        // Documented choice: the signature proved the sender, and a redelivery of bytes that did
        // not parse the first time will not parse the second — a 4xx/5xx would only loop GitHub.
        const { store } = await build();
        store.seedMember(ORG, 'octocat');
        const body = '{"action": "member_removed", broken';

        const response = await deliver(body, {
            'x-github-event': 'organization',
            'x-hub-signature-256': signature(body),
        });

        expect(response.statusCode).toBe(200);
    });

    it('does not exist when no secret is configured', async () => {
        // A route that answered without a secret would be a membership-deleting endpoint whose
        // credential nobody ever chose.
        const { app: server } = await build(null);

        const response = await server.inject({
            method: 'POST',
            url: '/api/github/webhook',
            payload: memberRemoved(1),
            headers: { 'content-type': 'application/json', 'x-github-event': 'organization' },
        });

        expect(response.statusCode).toBe(404);
    });
});
