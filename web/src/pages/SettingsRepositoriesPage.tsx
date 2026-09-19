import { useState } from 'react';
import { useRepos } from '../api/useRepos.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Repositories section of the settings tree: every repository the GitHub App installation
 * reports, and the per-repository environment editor (issue 150).
 *
 * The editor is the "Per repository" scope of the old environment page, moved whole: org-wide and
 * per-repository scopes are admin-written because they reach other members' runners, and a member
 * sees the editor read-only with the sentence saying why — the `root: null` posture.
 *
 * `useRepos` is armed on mount here, where the installation list IS the page's content — the
 * arm-on-focus caution of the old environment page existed only because the list was incidental
 * there.
 */
export function SettingsRepositoriesPage() {
    const { env, session } = useSettingsPage();
    const repos = useRepos(true);
    const [selectedRepo, setSelectedRepo] = useState<{ owner: string; name: string } | null>(null);

    const isAdmin = session?.role === 'admin';
    const repoScope = env.data?.repos.find(
        (scope) => selectedRepo && scope.owner === selectedRepo.owner && scope.name === selectedRepo.name
    );

    return (
        <main>
            <section className="panel">
                <div className="panel-head">
                    <h2>Available repositories</h2>
                </div>
                <p className="muted">
                    Every repository the GitHub App installation reports. Select the ones to check out under Settings →
                    Workspace.
                </p>
                {repos.loading ? <p className="status">Loading repositories…</p> : null}
                {repos.error ? <p className="status">Could not reach GitHub: {repos.error}</p> : null}
                {repos.data?.meta.error ? (
                    <p className="status">Showing a cached list: {repos.data.meta.error}</p>
                ) : null}
                {repos.data === null && !repos.loading && !repos.error ? (
                    <p className="muted">No repositories reported yet.</p>
                ) : null}
                {repos.data && repos.data.repos.length === 0 ? (
                    <p className="status">
                        This GitHub App is not installed on any repositories yet. Ask an administrator to install it on
                        the organization you work in.
                    </p>
                ) : null}
                {repos.data && repos.data.repos.length ? (
                    <ul>
                        {repos.data.repos.map((repo) => (
                            <li key={`${repo.owner}/${repo.name}`}>
                                {repo.owner}/{repo.name}
                                {repo.private ? <span className="pill">private</span> : null}
                            </li>
                        ))}
                    </ul>
                ) : null}
            </section>

            <section className="panel">
                <div className="panel-head">
                    <h2>Per repository</h2>
                    <select
                        aria-label="Repository"
                        value={selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : ''}
                        onChange={(e) => {
                            const [owner, name] = e.target.value.split('/');
                            setSelectedRepo(owner && name ? { owner, name } : null);
                        }}
                    >
                        <option value="">Choose a repository…</option>
                        {(env.data?.repos ?? []).map((scope) => (
                            <option key={`${scope.owner}/${scope.name}`} value={`${scope.owner}/${scope.name}`}>
                                {scope.owner}/{scope.name}
                            </option>
                        ))}
                        {(repos.data?.repos ?? [])
                            .filter(
                                (repo) =>
                                    !(env.data?.repos ?? []).some((s) => s.owner === repo.owner && s.name === repo.name)
                            )
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
                {env.error ? <p className="status">{env.error}</p> : null}
                {selectedRepo ? (
                    env.loading && !env.data ? (
                        <p className="status">Loading environment…</p>
                    ) : (
                        <EnvVarsPanel
                            key={`${selectedRepo.owner}/${selectedRepo.name}`}
                            title={`${selectedRepo.owner}/${selectedRepo.name}`}
                            hint=""
                            initialVars={repoScope?.vars ?? []}
                            onSave={(vars) => env.saveRepo(selectedRepo, vars)}
                            disabled={!isAdmin}
                        />
                    )
                ) : null}
            </section>
        </main>
    );
}
