import type { FastifyPluginAsync } from 'fastify';
import { VERSION_PATTERN } from '../version.js';

/** `/api/version` is open: build metadata a probe or support person reads with no credential. */
export const versionRoutes =
    (version: string): FastifyPluginAsync =>
    async (app) => {
        if (!VERSION_PATTERN.test(version)) throw new Error(`invalid release version ${JSON.stringify(version)}`);
        app.get('/api/version', async () => ({ version }));
    };
