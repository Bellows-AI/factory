import type { FastifyPluginAsync } from 'fastify';

const HTTP_UNAVAILABLE = 503;

type MigrationState = 'pending' | 'done' | 'failed';

/**
 * `/api/health` never calls GitHub, and never queries the database either: a container that is
 * rate-limited, or whose database is still starting, is still *healthy* — it is up and answering.
 * Probing either from here would make the compose healthcheck fail during the ~1 minute the
 * migrations retry through, and restart the container that was about to succeed.
 *
 * It names no organization any more (#99): there is no configured one to name, and finding the
 * directory's would need the database, which this route deliberately never touches.
 *
 * `/api/ready` is the other question: has the schema landed? It answers 503 until the migrations
 * resolve and 503 forever if they gave up — a server whose retry exhausted keeps serving every
 * DB-backed route as a 500, and only a restart retries. The chart's startupProbe reads it, so a
 * pod whose migrations gave up is restarted instead of left Ready. It reads the migration promise
 * main.ts already holds; it queries nothing itself. Absent a promise (the route tests), it is ready.
 */
export const healthRoutes =
    (ready?: Promise<unknown>): FastifyPluginAsync =>
    async (app) => {
        let migrations: MigrationState = ready ? 'pending' : 'done';
        ready?.then(
            () => {
                migrations = 'done';
            },
            () => {
                migrations = 'failed';
            }
        );

        app.get('/api/health', async () => ({
            status: 'ok',
            uptimeSeconds: Math.floor(process.uptime()),
        }));

        app.get('/api/ready', async (_request, reply) => {
            if (migrations !== 'done') reply.code(HTTP_UNAVAILABLE);
            return { status: migrations === 'done' ? 'ready' : 'unready', migrations };
        });
    };
