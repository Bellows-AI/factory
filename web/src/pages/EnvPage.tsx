import { useState } from 'react';
import { useEnv, type EnvVarInput } from '../api/useEnv.js';
import { useRepos } from '../api/useRepos.js';
import { useSession } from '../api/useSession.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';

/**
 * The runner environment: three stacked scopes on one page — Core (organization), My workspace, and
 * one chosen repository. Resolution happens on the board at claim time; this page only writes the
 * scopes.
 *
 * Org and repository scopes are admin-written (they reach other members' runners); the workspace
 * scope is the member's own. A member sees the first two read-only, with a sentence saying why —
 * the `root: null` posture: a state with an explanation, not an error.
 */
export function EnvPage() {
    const { session } = useSession();
    const { data, loading, error, saving, saveOrg, saveWorkspace, saveRepo } = useEnv();
    // Enabled only while the member is actually editing a repository, so opening this page does
    // not become an installation request for somebody who never gets there.
    const [pickingRepo, setPickingRepo] = useState(false);
    const repos = useRepos(pickingRepo);
    const [selectedRepo, setSelectedRepo] = useState<{ owner: string; name: string } | null>(null);
    /**
     * Bumped after every successful save so the editors remount from the refetched payload —
     * otherwise the draft survives the save (typed secret values linger in their inputs) and
     * another admin's concurrent edit never appears. The key is what makes the panel's
     * initialize-once state honest.
     */
    const [version, setVersion] = useState(0);
    /** Wraps a save so a success also bumps the remount key — see the comment above. */
    const saved =
        (save: (vars: EnvVarInput[]) => Promise<string | null>) =>
        async (vars: EnvVarInput[]): Promise<string | null> => {
            const failure = await save(vars);
            if (failure === null) setVersion((v) => v + 1);
            return failure;
        };

    const isAdmin = session?.role === 'admin';
    const repoScope = data?.repos.find(
        (scope) => selectedRepo && scope.owner === selectedRepo.owner && scope.name === selectedRepo.name,
    );

    if (loading && !data) {
        return (
            <main>
                <p className="status">Loading environment…</p>
            </main>
        );
    }

    return (
        <main>
            {error ? <p className="status">{error}</p> : null}

            <section className="panel">
                <h2>Environment</h2>
                <p className="muted">
                    Variables and secrets a runner starts with. They stack — core first, then your
                    workspace, then the repository, the most specific winning — and they are injected
                    when a task is claimed.
                </p>
            </section>

            <EnvVarsPanel
                key={`org-${version}`}
                title="Core (organization)"
                hint={
                    isAdmin
                        ? 'Injected into every runner in this deployment. The place for shared credentials — GITHUB_TOKEN, for one.'
                        : 'An admin configures the core environment; it is shown here read-only.'
                }
                initialVars={data?.org ?? []}
                onSave={saved(saveOrg)}
                disabled={!isAdmin}
            />

            <EnvVarsPanel
                key={`workspace-${version}`}
                title="My workspace"
                hint="Your own defaults, on every task you queue."
                initialVars={data?.workspace ?? []}
                onSave={saved(saveWorkspace)}
            />

            <section className="panel">
                <div className="panel-head">
                    <h2>Per repository</h2>
                    <select
                        aria-label="Repository"
                        value={selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : ''}
                        onChange={(e) => {
                            setPickingRepo(true);
                            const [owner, name] = e.target.value.split('/');
                            setSelectedRepo(owner && name ? { owner, name } : null);
                        }}
                    >
                        <option value="">Choose a repository…</option>
                        {(data?.repos ?? []).map((scope) => (
                            <option key={`${scope.owner}/${scope.name}`} value={`${scope.owner}/${scope.name}`}>
                                {scope.owner}/{scope.name}
                            </option>
                        ))}
                        {(repos.data?.repos ?? [])
                            .filter((repo) => !(data?.repos ?? []).some((s) => s.owner === repo.owner && s.name === repo.name))
                            .map((repo) => (
                                <option key={`${repo.owner}/${repo.name}`} value={`${repo.owner}/${repo.name}`}>
                                    {repo.owner}/{repo.name}
                                </option>
                            ))}
                    </select>
                </div>
                <p className="muted">
                    {isAdmin
                        ? 'Applies to every member\u2019s runs in the chosen repository.'
                        : 'An admin configures repository environment; it is shown here read-only.'}
                </p>
                {selectedRepo ? (
                    <EnvVarsPanel
                        key={`${selectedRepo.owner}/${selectedRepo.name}-${version}`}
                        title={`${selectedRepo.owner}/${selectedRepo.name}`}
                        hint=""
                        initialVars={repoScope?.vars ?? []}
                        onSave={saved((vars) => saveRepo(selectedRepo, vars))}
                        disabled={!isAdmin}
                    />
                ) : null}
            </section>
        </main>
    );
}
