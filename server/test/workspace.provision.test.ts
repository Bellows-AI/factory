import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureUserWorkspace } from '../src/workspace/provision.js';

/**
 * The provisioning half of the volume-mount boundary (openspec scope-runner-volume-mounts): a
 * job's container mounts `<root>/<orgId>/<userId>` as its subPath, and the kubelet refuses a pod
 * whose subPath does not exist. Provisioning is what makes that unreachable: the directory is
 * created at sign-in, and the board reports a claim `workspacePath` only for an author — who must
 * have signed in. These pins hold the ordering's first half: the tree the claim names is the tree
 * provisioning creates. The claim-shape half (`workspacePath === <orgId>/<userId>`, and only with
 * `hasWorkspaces`) is pinned in server/test-db/job-store.test.ts.
 *
 * Offline throughout: temp directories under tmpdir, no network, no database.
 */

const USER = '11111111-2222-3333-4444-555555555555';

const provision = (root: string | null, userId: string = USER) =>
    ensureUserWorkspace({ root, orgId: 'acme', userId, login: 'someone', githubUserId: 1 });

describe('ensureUserWorkspace', () => {
    it('creates the <root>/<orgId>/<userId> tree a job mount will name as its subPath', () => {
        const dir = mkdtempSync(join(tmpdir(), 'factory-provision-'));
        const root = join(dir, 'workspaces');

        const created = provision(root);

        expect(created).toBe(join(root, 'acme', USER));
        expect(existsSync(join(root, 'acme', USER))).toBe(true);
    });

    it('is idempotent — the polled read path calls it on every request', () => {
        const dir = mkdtempSync(join(tmpdir(), 'factory-provision-'));
        const root = join(dir, 'workspaces');

        provision(root);
        expect(provision(root)).toBe(join(root, 'acme', USER));
        expect(existsSync(join(root, 'acme', USER))).toBe(true);
    });

    it('is a no-op without a configured root, creating nothing', () => {
        expect(provision(null)).toBeNull();
    });
});
