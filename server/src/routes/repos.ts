import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { RepoAccessScope } from '../github/access-scope.js';
import type { RepoSource } from '../github/repo-source.js';

export interface RepoRouteDeps {
    repos: RepoSource;
    /**
     * The per-user repo scope. Absent — or a caller with no computed set — and the picker serves
     * the full installation list. An organization token is not a person, so it is never scoped.
     */
    scope?: RepoAccessScope | undefined;
}

/**
 * What the App installation can see, for the repository picker.
 *
 * A route rather than a field on `/api/stats`'s `meta`, even though both describe repositories, and
 * the distinction is worth keeping straight: `meta.repos` is what the figures on the page were
 * *measured over*, while this is what a member could *choose to check out*. They come from the same
 * installation today and could still diverge tomorrow, and conflating them would make the picker's
 * contents depend on a stats fetch having succeeded.
 */
export const repoRoutes =
    ({ repos, scope }: RepoRouteDeps): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/repos', async (request, reply) => {
            const { repos: list, installation } = await repos.detail();
            const error = repos.lastError();

            // The caller's own intersection, at read time: the stored set is what GitHub said at
            // their last sign-in, the installation list is what the App can see right now, and
            // only what appears in both is checkable — a clone needs the App's token, so the
            // narrower of the two is the honest answer. Compared case-insensitively, because
            // GitHub owner and repo names are.
            const caller = callerOf(request);
            let visible = list;
            if (scope && caller) {
                const allowed = await scope.scopedNames(caller.user.id);
                if (allowed !== null) {
                    const reach = new Set(allowed.map((name) => name.toLowerCase()));
                    visible = list.filter((repo) => reach.has(`${repo.owner}/${repo.name}`.toLowerCase()));
                }
            }

            // 200 with a named error and the last good list, never 503. Same rule /api/stats
            // follows: a failed refresh must keep the last good answer on screen and explain
            // itself, because an empty picker and an unreachable GitHub look identical otherwise.
            return reply.code(200).send({
                repos: visible.map((repo) => ({
                    owner: repo.owner,
                    name: repo.name,
                    private: repo.private,
                    defaultBranch: repo.defaultBranch,
                    pushedAt: repo.pushedAt,
                })),
                installation,
                meta: {
                    fetchedAt: repos.fetchedAt() === null ? null : new Date(repos.fetchedAt()!).toISOString(),
                    // An empty list with no error is a real state, and the SPA renders a different
                    // thing for it: the App is installed nowhere, or on no repositories yet.
                    error,
                },
            });
        });
    };
