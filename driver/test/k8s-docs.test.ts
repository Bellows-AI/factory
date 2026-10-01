import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/*
 * Issue #363: the EKS prerequisites live in four places — the docs section that carries them,
 * the ownership sentence that closes the standalone-pod caveat, and the pointers from the chart
 * surfaces an operator actually reads first (the NetworkPolicy template comment, the values
 * comments, the chart README). Each pin below is a fact the issue demands be stated; a docs edit
 * that drops one fails here instead of at an operator's cluster.
 */
const kubernetesDocs = readFileSync(join(ROOT, 'docs/kubernetes.md'), 'utf8');
const netpolTemplate = readFileSync(join(ROOT, 'charts/factory/templates/runner-networkpolicy.yaml'), 'utf8');
const chartValues = readFileSync(join(ROOT, 'charts/factory/values.yaml'), 'utf8');
const chartReadme = readFileSync(join(ROOT, 'charts/factory/README.md'), 'utf8');

describe('the EKS prerequisites record', () => {
    it('states the node and add-on prerequisites in docs/kubernetes.md', () => {
        expect(kubernetesDocs).toContain('EKS prerequisites');
        // The node-level IMDS defence the blockedCidrs rule cannot make on its own.
        expect(kubernetesDocs).toContain('httpPutResponseHopLimit');
        // The VPC CNI add-on flag without which the NetworkPolicy object is inert.
        expect(kubernetesDocs).toContain('enableNetworkPolicy');
        // The metrics API provider absent from EKS by default; vitals degrade to null without it.
        expect(kubernetesDocs).toContain('metrics-server');
        // Fargate is out entirely: no network policy, no metrics API, no node.
        expect(kubernetesDocs).toContain('Fargate');
    });

    it('states the VPC-endpoint answer for the blocked private ranges', () => {
        expect(kubernetesDocs).toContain('VPC endpoint');
        expect(kubernetesDocs).toContain('allowedCidrs');
    });

    it('records that declared-service pods are owned, closing the standalone-pod caveat', () => {
        expect(kubernetesDocs).toContain('ownerReference');
        expect(kubernetesDocs).toContain('standalone');
    });

    it('points the NetworkPolicy surfaces at the EKS enforcement prerequisite', () => {
        // The template header comment, the values comment and the chart README row all name the
        // add-on flag and the doc that carries the rest.
        for (const surface of [netpolTemplate, chartValues, chartReadme]) {
            expect(surface).toContain('enableNetworkPolicy');
            expect(surface).toContain('docs/kubernetes.md');
        }
    });
});
