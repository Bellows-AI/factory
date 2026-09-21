import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryPrLifecycleStore,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
    type MemoryPrLifecycleStore,
} from './helpers.js';

const SECRET = 'webhook-secret-for-the-installation-round-trip';
const ORG = '424242';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

/** A github-mode config, since the webhook deployment is a github one; the secret decides the route. */
async function build(
    webhookSecret: string | null = SECRET,
    prs: MemoryPrLifecycleStore = memoryPrLifecycleStore(),
    orgsFor?: readonly string[]
) {
    const store = memoryAuthStore();
    const config = testConfig({ auth: githubAuth(), webhookSecret });
    const instance = await buildApp({
        config,
        orgs: staticRegistry({
            config,
            telemetry: stubTelemetryClient(),
            prs,
            ...(orgsFor ? { orgsFor } : {}),
        }),
        auth: store,
    });
    app = instance;
    return { app: instance, store, prs };
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

describe('POST /api/github/webhook: PR families (036)', () => {
    const REPO = 'acme/widgets';
    const PR = 42;
    /** The shape GitHub sends for PR-family events; `overrides` swap fields for the case at hand. */
    const pr = (action: string, overrides: Record<string, unknown> = {}) =>
        JSON.stringify({
            action,
            installation: { id: Number(ORG) },
            repository: { full_name: REPO },
            pull_request: { number: PR },
            ...overrides,
        });
    const issueComment = (action: string, withPullRequest: boolean) =>
        JSON.stringify({
            action,
            installation: { id: Number(ORG) },
            repository: { full_name: REPO },
            issue: {
                number: PR,
                ...(withPullRequest ? { pull_request: { url: 'https://github.com/x/1/pull/2' } } : {}),
            },
        });
    const headersFor = (body: string, event: string, deliveryId: string) => ({
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': signature(body),
    });

    it('folds a pull_request synchronize into the orgs waits on that PR', async () => {
        const { prs } = await build();
        prs.seedWait(REPO, PR);

        const body = pr('synchronize');
        const response = await deliver(body, headersFor(body, 'pull_request', 'd1'));

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true });
        expect(prs.deliveries()).toEqual([
            {
                deliveryId: 'd1',
                event: 'pull_request',
                action: 'synchronize',
                repo: REPO,
                prNumber: PR,
                outcome: 'folded',
            },
        ]);
        expect(prs.waits().find((w) => w.repo === REPO && w.prNumber === PR)?.pending).toBe(1);
    });

    it('records the same delivery GUID once — a redelivery folds nothing', async () => {
        const { prs } = await build();
        prs.seedWait(REPO, PR);

        const body = pr('reopened');
        const headers = headersFor(body, 'pull_request', 'same-guid');
        await deliver(body, headers);
        await deliver(body, headers);

        // The ledger keeps ONE row per GUID, exactly as the delivery table does — the second
        // post folded nothing and changed nothing.
        expect(prs.deliveries()).toHaveLength(1);
        expect(prs.waits().find((w) => w.repo === REPO && w.prNumber === PR)?.pending).toBe(1);
    });

    it('cancels the waits addressed to a closed PR; a sibling PR is untouched', async () => {
        const { prs } = await build();
        prs.seedWait(REPO, PR);
        prs.seedWait(REPO, 43);

        await deliver(pr('closed'), headersFor(pr('closed'), 'pull_request', 'c1'));
        // The closed PR's wait is gone: a later delivery folds nothing and records unmatched.
        await deliver(pr('synchronize'), headersFor(pr('synchronize'), 'pull_request', 'd3'));
        // The sibling still wakes.
        const sibling = pr('synchronize', { pull_request: { number: 43 } });
        await deliver(sibling, headersFor(sibling, 'pull_request', 'd4'));

        expect(prs.cancellations()).toEqual([{ repo: REPO, prNumber: PR, terminalReason: 'pr closed' }]);
        expect(prs.deliveries().map((d) => [d.prNumber, d.outcome])).toEqual([
            [42, 'unmatched'],
            [43, 'folded'],
        ]);
    });

    it('folds review, review-comment and PR issue-comment events; bare issue chatter does not', async () => {
        const { prs } = await build();
        prs.seedWait(REPO, PR);

        const review = pr('submitted');
        await deliver(review, headersFor(review, 'pull_request_review', 'r1'));
        const comment = pr('created');
        await deliver(comment, headersFor(comment, 'pull_request_review_comment', 'c2'));
        const onPr = issueComment('created', true);
        await deliver(onPr, headersFor(onPr, 'issue_comment', 'i1'));
        const bare = issueComment('created', false);
        await deliver(bare, headersFor(bare, 'issue_comment', 'i2'));

        // The bare issue comment is issue chatter, not PR activity — recorded nowhere.
        expect(prs.deliveries().map((d) => `${d.event}:${d.action}:${d.outcome}`)).toEqual([
            'pull_request_review:submitted:folded',
            'pull_request_review_comment:created:folded',
            'issue_comment:created:folded',
        ]);
        expect(prs.waits().find((w) => w.repo === REPO && w.prNumber === PR)?.pending).toBe(3);
    });

    it('ignores unsupported actions and a delivery with no delivery GUID', async () => {
        const { prs } = await build();
        prs.seedWait(REPO, PR);

        const labeled = pr('labeled');
        await deliver(labeled, headersFor(labeled, 'pull_request', 'l1'));
        const edited = pr('edited');
        await deliver(edited, headersFor(edited, 'pull_request_review', 'x1'));

        const unsigned = pr('synchronize');
        const noGuid = await deliver(unsigned, {
            'x-github-event': 'pull_request',
            'x-hub-signature-256': signature(unsigned),
        });

        expect(noGuid.statusCode).toBe(200);
        expect(prs.deliveries()).toEqual([]);
        expect(prs.waits().find((w) => w.repo === REPO && w.prNumber === PR)?.pending).toBe(0);
    });

    it('acks a delivery with no clean installation, repo or PR number without a store call', async () => {
        const { prs } = await build();
        prs.seedWait(REPO, PR);

        // No repository.full_name — no wait of ours is addressed.
        const noRepo = JSON.stringify({
            action: 'synchronize',
            installation: { id: Number(ORG) },
            pull_request: { number: PR },
        });
        await deliver(noRepo, headersFor(noRepo, 'pull_request', 'n1'));
        // A delivery GUID longer than the column it would land in is refused, not truncated.
        const longId = 'x'.repeat(65);
        const body = pr('synchronize');
        await deliver(body, headersFor(body, 'pull_request', longId));

        expect(prs.deliveries()).toEqual([]);
    });

    it('never wakes another org: a delivery for a different installation is a no-op', async () => {
        // The registry answers only for the test's org — an event the App signed for a different
        // installation resolves to no runtime at all, so nothing is recorded.
        const { prs } = await build(SECRET, memoryPrLifecycleStore(), [ORG]);
        prs.seedWait(REPO, PR);

        const body = JSON.stringify({
            action: 'synchronize',
            installation: { id: 999999 },
            repository: { full_name: REPO },
            pull_request: { number: PR },
        });
        const response = await deliver(body, headersFor(body, 'pull_request', 'x1'));

        expect(response.statusCode).toBe(200);
        expect(prs.deliveries()).toEqual([]);
    });
});
