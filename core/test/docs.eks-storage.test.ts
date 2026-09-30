import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The workspaces claim's platform prerequisites, pinned to the two documents that state them.
 * The chart's defaults — `ReadWriteMany` on the cluster's default StorageClass, with nothing
 * setting `fsGroup` — are correct for the shared-volume design and wrong for a stock EKS cluster,
 * where the default class is single-AZ `ReadWriteOnce` EBS and a dynamically provisioned EFS
 * access point is `root:root 0700`. Neither failure reaches a UI: the PVC simply never binds, or
 * the member tree is never created and every runner pod hangs in `ContainerCreating` on a
 * `subPath` that does not exist. The prerequisites are the only thing standing between an
 * operator and that silence, so a document that loses them is the bug returning.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const kubernetes = read('../../docs/kubernetes.md');
const chartReadme = read('../../charts/factory/README.md');
const values = read('../../charts/factory/values.yaml');
const limits = read('../../docs/limits.md');

/**
 * Every pod spec this release writes that carries a pod-level `securityContext`: the three chart
 * Deployments, plus the driver module that specs every pod mounting the claim. An `fsGroup` can
 * only land in one of these, so these are what the document's claim is checked against.
 */
const podSpecSources = [
    '../../charts/factory/templates/deployment.yaml',
    '../../charts/factory/templates/driver-deployment.yaml',
    '../../charts/factory/templates/collector.yaml',
    '../../driver/src/k8s-podspec.ts',
];

describe('the workspaces volume prerequisites', () => {
    it('names the EFS StorageClass parameters in docs/kubernetes.md', () => {
        expect(kubernetes).toContain('provisioningMode: efs-ap');
        expect(kubernetes).toContain('uid: "1000"');
        expect(kubernetes).toContain('gid: "1000"');
        expect(kubernetes).toContain('directoryPerms: "0775"');
    });

    it('names the EFS CSI driver, its IRSA role and the mount-target requirement', () => {
        expect(kubernetes).toContain('EFS CSI driver');
        expect(kubernetes).toContain('IRSA');
        expect(kubernetes).toContain('mount target');
    });

    it('states why fsGroup is not the answer on an RWX NFS mount', () => {
        expect(kubernetes).toContain('fsGroup');
        expect(kubernetes).toContain("access point's POSIX user");
    });

    it('states the single-AZ EBS fallback and that runner scheduling blocks it', () => {
        expect(kubernetes).toContain('ReadWriteOnce');
        expect(kubernetes).toContain('no scheduling knob');
    });

    it('does not claim the EFS path has been observed from this repository', () => {
        expect(kubernetes).toContain('not been observed on a real EKS cluster');
        expect(limits).toContain('The EFS path for the workspaces claim is stated, never observed');
    });

    /**
     * The one claim in the prose that a code change can falsify. Everything else the document says
     * about this repository is structural; this is a fact about four files, so it is asserted
     * against those four files rather than against the sentence that reports them.
     */
    it('is telling the truth that no pod spec sets fsGroup', () => {
        for (const source of podSpecSources) {
            expect(read(source), source).not.toContain('fsGroup');
        }
    });

    it('points an operator at the same prerequisites from the chart README', () => {
        expect(chartReadme).toContain('efs-ap');
        expect(chartReadme).toContain('workspaces.storageClass');
    });

    /**
     * Not RED — it passes today, and that is the point: it is the drift guard that keeps the six
     * assertions above from documenting a shape the chart no longer has.
     */
    it('still defaults to the shape those prerequisites exist for', () => {
        expect(values).toContain('- ReadWriteMany');
        expect(values).toContain("storageClass: ''");
    });
});
