import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { versionRoutes } from '../src/routes/version.js';
import { readVersion, VERSION_PATTERN } from '../src/version.js';

const HTTP_OK = 200;
const root = fileURLToPath(new URL('../../', import.meta.url));
const INVALID = ['v1.2.3', '1.2', '1.2.3-rc.1', '01.2.3', '', '1.2.3\n1.2.4\n'];

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempVersionPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'version-'));
    dirs.push(dir);
    return join(dir, 'VERSION');
}

function versionFile(contents: string): string {
    const path = tempVersionPath();
    writeFileSync(path, contents);
    return path;
}

describe('the version route', () => {
    it('serves the version it was given', async () => {
        const app = Fastify();
        await app.register(versionRoutes('1.2.3'));
        const response = await app.inject({ method: 'GET', url: '/api/version' });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ version: '1.2.3' });
    });

    it.each(INVALID)('refuses to register %j rather than serve it', async (version) => {
        const app = Fastify();
        await expect(app.register(versionRoutes(version))).rejects.toThrow(/version/i);
    });
});

describe('readVersion', () => {
    it('reads the committed root VERSION by default', () => {
        const committed = readFileSync(join(root, 'VERSION'), 'utf8').trim();
        expect(committed).toMatch(VERSION_PATTERN);
        expect(readVersion()).toBe(committed);
    });

    it('accepts a trailing newline', () => {
        expect(readVersion(versionFile('1.2.3\n'))).toBe('1.2.3');
    });

    it('throws naming the path when the file is missing', () => {
        const path = tempVersionPath();
        expect(() => readVersion(path)).toThrow(path);
    });

    it.each(INVALID)('throws on %j rather than fall back', (contents) => {
        const path = versionFile(contents);
        expect(() => readVersion(path)).toThrow(path);
    });
});

describe('the runtime image', () => {
    // server/dist/version.js resolves ../../VERSION; in the image that is /app/VERSION.
    it('carries VERSION where server/dist resolves it', () => {
        const dockerfile = readFileSync(join(root, 'docker/Dockerfile'), 'utf8');
        const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
        expect(runtime).toMatch(/^WORKDIR \/app$/m);
        expect(runtime).toMatch(/^COPY VERSION \.\/$/m);
        expect(runtime).toContain('COPY --from=build /app/server/dist server/dist');
    });
});
