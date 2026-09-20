import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * What pins the compose driver to the working tree (issue #174). The compose `driver` service
 * used to build the baked `runtime` stage of docker/driver.Dockerfile — `driver/dist` inside the
 * image — so a plain `docker compose up` or restart kept running whatever publisher code was
 * baked last, and `/fix N` PRs went out without the closing keyword the current source appends.
 * The dashboard solved the same class by running the tree from a bind mount; these assertions
 * hold the driver to the same contract, and hold `runtime` to remaining the last stage — the
 * chart and scripts/test-k8s.sh build it with no --target, so a new stage inserted after it
 * would silently become what kubernetes ships.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const compose = read('docker-compose.yml');
const driverDockerfile = read('docker/driver.Dockerfile');
const dashboardDockerfile = read('docker/Dockerfile');

// The service blocks only: later services reuse names like `volumes:`, and `    timescale:` also
// matches the dashboard's depends_on entry, so the markers are line starts.
const between = (from: string, to: string): string => {
    const start = compose.indexOf(from);
    const end = compose.indexOf(to);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return compose.slice(start, end);
};
const dashboardBlock = between('\n    dashboard:', '\n    driver:');
const driverBlock = between('\n    driver:', '\n    timescale:');

describe('the compose driver service', () => {
    it('runs the working tree, not a baked dist', () => {
        expect(driverBlock).toContain('dockerfile: docker/driver.Dockerfile');
        // NOT the default (last) stage — the same comment the dashboard's build carries.
        expect(driverBlock).toContain('target: dev');
        expect(driverBlock).toContain('npm run dev -w driver');
    });

    it('bind-mounts the working tree, with every workspace node_modules shadowed', () => {
        expect(driverBlock).toContain('- .:/app');
        // `npm install` reconciles every workspace, so each node_modules needs a shadow or the
        // install lands in the HOST tree through the bind mount — darwin binaries replaced on
        // the macOS dev host.
        const shadows: Array<[path: string, volume: string]> = [
            ['', 'driver-root-node-modules'],
            ['core/', 'driver-root-core-node-modules'],
            ['server/', 'driver-root-server-node-modules'],
            ['web/', 'driver-root-web-node-modules'],
            ['driver/', 'driver-root-driver-node-modules'],
        ];
        for (const [path, volume] of shadows) {
            expect(driverBlock).toContain(`- ${volume}:/app/${path}node_modules`);
        }
    });

    it("shadows its own volumes, not the dashboard's", () => {
        // The driver runs as root (docker socket) and the dashboard as node; root-owned files in
        // a shared volume would wedge the dashboard's next npm install on EACCES. Held in both
        // directions: the driver mounts nothing of the dashboard's, the dashboard nothing of the
        // driver's — either direction alone would let a "dedupe the volume sets" cleanup wedge
        // the stack silently.
        for (const volume of [
            'node-modules',
            'core-node-modules',
            'server-node-modules',
            'web-node-modules',
            'driver-node-modules',
        ]) {
            expect(driverBlock).not.toContain(`- ${volume}:/app/`);
        }
        expect(dashboardBlock).not.toContain('driver-root-');
        expect(dashboardBlock).toContain('- node-modules:/app/node_modules');
    });

    it('still mounts the docker socket', () => {
        // The freshness fix must not regress the one mount the driver exists for.
        expect(driverBlock).toContain('/var/run/docker.sock:/var/run/docker.sock');
    });

    it('leaves the dashboard running its own tree', () => {
        // Asserted on the dashboard's own block: a `target: dev` anywhere in the file would be
        // satisfied by the driver alone, and the dashboard losing its target is the sibling of
        // the bug this issue fixes.
        expect(dashboardBlock).toContain('target: dev');
        expect(dashboardBlock).toContain("command: sh -c 'npm install && npm run dev'");
    });
});

describe('the driver image stages', () => {
    it('has a dev stage with the docker CLI', () => {
        expect(driverDockerfile).toMatch(/^FROM deps AS dev$/m);
        expect(driverDockerfile).toContain('COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker');
    });

    it('keeps runtime as the last stage — what the chart ships', () => {
        // scripts/test-k8s.sh builds with no --target, so the LAST stage is what kubernetes
        // runs. `dev` must sit before it, runtime must still bake dist and run it, and nothing
        // may follow runtime — a stage appended after it would silently become what ships.
        const dev = driverDockerfile.indexOf('FROM deps AS dev');
        const runtime = driverDockerfile.indexOf('FROM node:24-alpine AS runtime');
        expect(dev).toBeGreaterThan(-1);
        expect(runtime).toBeGreaterThan(dev);
        expect(driverDockerfile.slice(runtime).match(/^FROM/gm)).toHaveLength(1);
        expect(driverDockerfile).toContain('COPY --from=build /app/driver/dist driver/dist');
        expect(driverDockerfile).toContain('CMD ["node", "driver/dist/index.js"]');
    });

    it('leaves the dashboard image alone', () => {
        expect(dashboardDockerfile).toMatch(/^FROM deps AS dev$/m);
    });
});
