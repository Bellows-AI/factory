import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { JOB_LABEL, LEASE_LABEL } from '../src/labels.js';
import {
    configmapsPath,
    podsPath,
    publishEnvSecretName,
    secretsPath,
    servicesPath,
    syncEnvSecretName,
} from '../src/k8s-auxspec.js';
import { gateEnvSecretName, secretName } from '../src/k8s-podspec.js';
import { createKubernetesReaper } from '../src/k8s-reaper.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import type { OrphanGroup } from '../src/reaper.js';

/**
 * The kubernetes reaper arm, offline: the request function is injected (the way every k8s suite
 * here does it), so the test is a router over (method, path) that records what the arm asked the
 * API server for. No cluster, no RBAC, no kubelet.
 */

const JOB = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const NAMESPACE = 'factory';

interface Recorded {
    method: K8sMethod;
    path: string;
    body?: unknown;
}

/** A router that answers each (method, path) from a table and records every call. */
const router = (
    answers: readonly (readonly [K8sMethod, string, K8sResponse])[],
    // A status every unlisted GET answers, so a test can model a 500 without listing every path.
    fallbackStatus = 404
): { request: K8sRequest; calls: Recorded[] } => {
    const calls: Recorded[] = [];
    return {
        calls,
        request: async (method, path, body) => {
            calls.push({ method, path, body });
            const hit = answers.find(([m, p]) => m === method && p === path);
            return hit ? hit[2] : { status: fallbackStatus, body: '' };
        },
    };
};

const pod = (name: string, jobId: string, lease: string, created: string) => ({
    metadata: {
        name,
        labels: { [JOB_LABEL]: jobId, [LEASE_LABEL]: lease, 'factory.service': 'postgres' },
        creationTimestamp: created,
    },
});

const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE });

const LIST_PODS = `${podsPath(NAMESPACE)}?labelSelector=${encodeURIComponent('factory.job,factory.service')}`;
const LIST_SERVICES = `${servicesPath(NAMESPACE)}?labelSelector=${encodeURIComponent('factory.job,factory.service')}`;

const deleteCalls = (calls: readonly Recorded[]) =>
    calls.filter((call) => call.method === 'DELETE').map((call) => call.path);

const group = (overrides: Partial<OrphanGroup> = {}): OrphanGroup => ({
    jobId: JOB,
    leaseToken: LEASE,
    createdAtMs: 0,
    objects: [
        { kind: 'pod', name: `${JOB}-${LEASE}-svc-postgres` },
        { kind: 'service', name: `factory-svc-abc` },
    ],
    ...overrides,
});

describe('the kubernetes reaper arm: scan', () => {
    it('lists pods and services by the factory.job + factory.service pair', async () => {
        const body = JSON.stringify({ items: [] });
        const { request, calls } = router([
            ['GET', LIST_PODS, { status: 200, body }],
            ['GET', LIST_SERVICES, { status: 200, body }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        await arm.scan();

        expect(calls).toEqual([
            { method: 'GET', path: LIST_PODS },
            { method: 'GET', path: LIST_SERVICES },
        ]);
    });

    it('scopes the selector to this release when one is configured', async () => {
        const scoped = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NAMESPACE, K8S_RELEASE: 'factory' });
        const expected = `${podsPath(NAMESPACE)}?labelSelector=${encodeURIComponent(
            'factory.job,factory.service,app.kubernetes.io/instance=factory'
        )}`;
        const body = JSON.stringify({ items: [] });
        const { request, calls } = router([
            ['GET', expected, { status: 200, body }],
            [
                'GET',
                `${servicesPath(NAMESPACE)}?labelSelector=${encodeURIComponent(
                    'factory.job,factory.service,app.kubernetes.io/instance=factory'
                )}`,
                { status: 200, body },
            ],
        ]);
        const arm = createKubernetesReaper({ config: scoped, request });

        await arm.scan();

        // The release term is load-bearing: two releases sharing a namespace against different
        // boards must never reap each other's fleets as "unknown jobs".
        expect(calls[0]?.path).toBe(expected);
    });

    it('groups by job and lease, keeping the oldest creationTimestamp of the group', async () => {
        const pods = JSON.stringify({
            items: [
                pod('old-pod', JOB, LEASE, '2026-09-01T00:00:00Z'),
                pod('new-pod', JOB, LEASE, '2026-09-02T00:00:00Z'),
            ],
        });
        const services = JSON.stringify({ items: [] });
        const { request } = router([
            ['GET', LIST_PODS, { status: 200, body: pods }],
            ['GET', LIST_SERVICES, { status: 200, body: services }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const groups = await arm.scan();

        expect(groups).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                // The OLDEST creationTimestamp — the grace window is measured from the moment
                // the fleet began to exist, not from the youngest pod in it.
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [
                    { kind: 'pod', name: 'old-pod' },
                    { kind: 'pod', name: 'new-pod' },
                ],
            },
        ]);
    });

    it('skips rows missing either label, and objects the API has not named', async () => {
        const pods = JSON.stringify({
            items: [
                pod('good', JOB, LEASE, '2026-09-01T00:00:00Z'),
                // A runner pod: factory.job + factory.lease but no factory.service — never reaped here.
                {
                    metadata: { name: 'runner-pod', labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE } },
                },
                // Unlabelled junk never becomes somebody's orphan.
                { metadata: { name: 'junk' } },
                { metadata: { labels: { [JOB_LABEL]: JOB, [LEASE_LABEL]: LEASE } } },
            ],
        });
        const { request } = router([
            ['GET', LIST_PODS, { status: 200, body: pods }],
            ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const groups = await arm.scan();

        expect(groups).toEqual([
            {
                jobId: JOB,
                leaseToken: LEASE,
                createdAtMs: Date.parse('2026-09-01T00:00:00Z'),
                objects: [{ kind: 'pod', name: 'good' }],
            },
        ]);
    });

    it('answers nothing when either list cannot be read — inconclusive reaps nothing', async () => {
        const failing = router([['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }]], 500);
        const arm = createKubernetesReaper({ config, request: failing.request });
        await expect(arm.scan()).resolves.toEqual([]);

        const throwing: K8sRequest = async () => {
            throw new Error('connection reset');
        };
        const arm2 = createKubernetesReaper({ config, request: throwing });
        await expect(arm2.scan()).resolves.toEqual([]);
    });
});

describe('the kubernetes reaper arm: reap', () => {
    const emptyLists: readonly (readonly [K8sMethod, string, K8sResponse])[] = [
        ['GET', LIST_PODS, { status: 200, body: JSON.stringify({ items: [] }) }],
        ['GET', LIST_SERVICES, { status: 200, body: JSON.stringify({ items: [] }) }],
    ];

    it('deletes each pod and Service by name with Foreground propagation, tolerating 404/409', async () => {
        const { request, calls } = router([
            ...emptyLists,
            [
                'DELETE',
                `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
                { status: 200, body: '' },
            ],
            [
                'DELETE',
                `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
                { status: 200, body: '' },
            ],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        expect(removed).toEqual([`pod ${JOB}-${LEASE}-svc-postgres`, 'service factory-svc-abc']);
        const fleet = deleteCalls(calls).filter((path) => !path.startsWith(secretsPath(NAMESPACE)));
        expect(fleet).toEqual([
            `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
            `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
            // The checkout claim is pinned in full below — here the read answers nothing (this
            // router models a claim that was already released), so nothing is deleted on a maybe.
        ]);
    });

    it('reads 404 and 409 as the object already going away, and keeps the answer honest', async () => {
        const { request } = router([
            ...emptyLists,
            ['DELETE', `${podsPath(NAMESPACE)}/svc-postgres?propagationPolicy=Foreground`, { status: 404, body: '' }],
            [
                'DELETE',
                `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
                { status: 409, body: '' },
            ],
        ]);
        const arm = createKubernetesReaper({ config, request });

        expect(await arm.reap(group(), 'gone')).toEqual([]);
    });

    it('deletes the attempt-scoped env Secrets by their derived names, and answers them to the log', async () => {
        const runnerSecret = `${secretsPath(NAMESPACE)}/${secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`;
        const { request, calls } = router([
            ...emptyLists,
            [
                'DELETE',
                `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
                { status: 200, body: '' },
            ],
            ['DELETE', runnerSecret, { status: 200, body: '' }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        const secrets = deleteCalls(calls).filter((path) => path.startsWith(secretsPath(NAMESPACE)));
        expect(secrets).toEqual([
            runnerSecret,
            `${secretsPath(NAMESPACE)}/${syncEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`,
            `${secretsPath(NAMESPACE)}/${gateEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`,
            `${secretsPath(NAMESPACE)}/${publishEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob)}`,
        ]);
        // A 2xx Secret delete is a removal like any other; the three 404s are not.
        expect(removed).toContain(`secret ${runnerSecret.split('/').pop()}`);
    });

    it('deletes the checkout claim only when the job is gone, by uid precondition, never while a replacement lives', async () => {
        const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
        const { request, calls } = router([
            ...emptyLists,
            // The read the precondition is built from — the fence's own release shape.
            ['GET', claimPath, { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-1' } }) }],
            ['DELETE', `${claimPath}?propagationPolicy=Foreground`, { status: 200, body: '' }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        await arm.reap(group(), 'gone');
        expect(deleteCalls(calls)).toContainEqual(`${claimPath}?propagationPolicy=Foreground`);
        // The delete can only ever reach the exact incarnation this call read.
        const claimDelete = calls.find((call) => call.method === 'DELETE' && call.path.startsWith(`${claimPath}?`));
        expect(claimDelete?.body).toEqual({
            apiVersion: 'v1',
            kind: 'DeleteOptions',
            preconditions: { uid: 'claim-uid-1' },
        });

        const superseded = router([...emptyLists], 404);
        const arm2 = createKubernetesReaper({ config, request: superseded.request });
        await arm2.reap(group(), 'superseded');
        // A live replacement attempt holds the claim; the reaper must never touch it.
        expect(deleteCalls(superseded.calls).some((path) => path.startsWith(configmapsPath(NAMESPACE)))).toBe(false);
    });

    it('defers the claim when the read cannot identify an incarnation — never a delete on a maybe', async () => {
        const claimPath = `${configmapsPath(NAMESPACE)}/factory-job-${JOB}-claim`;
        const { request, calls } = router([
            ...emptyLists,
            // 2xx but no uid: garbage is never proof of anything, and an UNCONDITIONED delete
            // could reach a newer claim. Nothing is deleted; the next round reads again.
            ['GET', claimPath, { status: 200, body: JSON.stringify({ metadata: {} }) }],
        ]);
        const arm = createKubernetesReaper({ config, request });

        await arm.reap(group(), 'gone');

        expect(deleteCalls(calls).some((path) => path.startsWith(configmapsPath(NAMESPACE)))).toBe(false);
    });

    it('deletes the derived Secrets BEFORE the Pod and Service, and stops the round when one fails', async () => {
        // Once the listed Pod and Service are gone, no next scan can rediscover the (job, lease)
        // pair to re-derive these names — a Secret has no ownerReferences. So a failed Secret
        // delete must hold back the fleet: here the FIRST Secret answers 500, and nothing but
        // that one Secret may be deleted all round.
        const names = [
            secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            syncEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            gateEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            publishEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
        ].map((name) => `${secretsPath(NAMESPACE)}/${name}`);
        const { request, calls } = router([['DELETE', names[0]!, { status: 500, body: '' }]]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        expect(removed).toEqual([]);
        expect(deleteCalls(calls)).toEqual([names[0]]);
    });

    it('deletes Secrets ahead of the fleet, and 404 Secrets do not block teardown', async () => {
        const names = [
            secretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            syncEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            gateEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
            publishEnvSecretName({ id: JOB, leaseToken: LEASE } as unknown as BoardJob),
        ].map((name) => `${secretsPath(NAMESPACE)}/${name}`);
        const { request, calls } = router([
            ...names.map((path): readonly [K8sMethod, string, K8sResponse] => [
                'DELETE',
                path,
                { status: 404, body: '' },
            ]),
            ...[
                `${podsPath(NAMESPACE)}/${JOB}-${LEASE}-svc-postgres?propagationPolicy=Foreground`,
                `${servicesPath(NAMESPACE)}/factory-svc-abc?propagationPolicy=Foreground`,
            ].map((path): readonly [K8sMethod, string, K8sResponse] => ['DELETE', path, { status: 200, body: '' }]),
        ]);
        const arm = createKubernetesReaper({ config, request });

        const removed = await arm.reap(group(), 'gone');

        // Ordering is the point: the four Secret deletes are the FIRST four calls, before any
        // fleet object — and already-gone Secrets never hold the round back.
        expect(deleteCalls(calls).slice(0, names.length)).toEqual(names);
        expect(removed).toEqual([`pod ${JOB}-${LEASE}-svc-postgres`, 'service factory-svc-abc']);
    });

    it('answers what it removed without throwing on any single delete failure', async () => {
        const failing: K8sRequest = async (method) => {
            if (method === 'DELETE') throw new Error('connection reset');
            return { status: 200, body: JSON.stringify({ items: [] }) };
        };
        const arm = createKubernetesReaper({ config, request: failing });

        expect(await arm.reap(group(), 'gone')).toEqual([]);
    });
});
