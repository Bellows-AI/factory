import type { FastifyPluginAsync } from 'fastify';

/**
 * Never calls GitHub, and never queries the database either: a container that is rate-limited, or
 * whose database is still starting, is still *healthy* — it is up and answering. Probing either
 * from here would make the compose healthcheck fail during the ~1 minute the migrations retry
 * through, and restart the container that was about to succeed.
 *
 * It names no organization any more (#99): there is no configured one to name, and finding the
 * directory's would need the database, which this route deliberately never touches.
 */
export const healthRoutes = (): FastifyPluginAsync => async (app) => {
    app.get('/api/health', async () => ({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
    }));
};
