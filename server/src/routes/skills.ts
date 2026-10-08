import { connectionEnvNames, MANAGED_CONNECTIONS, type Skill } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';

/**
 * `GET /api/skills`: what a task may select. Name, description and the declared requirements —
 * with each connection's env NAMES — and never the SKILL.md body or any env value. Reading the
 * catalog at registration means a broken catalog fails boot rather than the first request.
 */
export const skillRoutes =
    (catalog: () => Skill[]): FastifyPluginAsync =>
    async (app) => {
        const skills = catalog().map((skill) => ({
            name: skill.name,
            description: skill.description,
            requires: {
                tools: skill.requires.tools,
                connections: skill.requires.connections.map((name) => ({
                    name,
                    env: connectionEnvNames(name),
                    // A managed connection holds no env: the task selects it by this body field.
                    selectedBy: Object.hasOwn(MANAGED_CONNECTIONS, name)
                        ? MANAGED_CONNECTIONS[name as keyof typeof MANAGED_CONNECTIONS]
                        : null,
                })),
            },
        }));
        app.get('/api/skills', async () => ({ skills }));
    };
