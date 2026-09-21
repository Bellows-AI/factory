import { useState } from 'react';
import { useRepos } from '../api/useRepos.js';
import { ConfigurationScope } from '../components/ConfigurationScope.js';
import { PageHeader } from '../components/PageHeader.js';
import { useUnsavedChanges } from '../components/UnsavedChangesDialog.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Repositories section of the settings tree: every repository the GitHub App installation
 * reports, and the per-repository environment editor (issue 150).
 *
 * The page header carries the section sentence — what the list is and where selections land —
 * so the panels below name only themselves. The per-repository editor is enabled for every role,
 * because that is the server's contract: `PUT /api/env/repo` accepts any member of the
 * installation, for repositories the installation can actually see (UNKNOWN_REPO otherwise,
 * pinned by server/test/routes.env.test.ts). The disabled control a member used to see was not
 * authorization; it was a false claim about the API (issue 180).
 *
 * `useRepos` is armed on mount here, where the installation list IS the page's content — the
 * arm-on-focus caution of the old environment page existed only because the list was incidental
 * there.
 */
export function SettingsRepositoriesPage() {
    const { env } = useSettingsPage();
    const repos = useRepos(true);
    const [selectedRepo, setSelectedRepo] = useState<{ owner: string; name: string } | null>(null);
    // The current editor's dirty flag, mirrored by the panel's onDirtyChange: the switch question
    // must be asked BEFORE the panel unmounts and its draft dies with it.
    const [repoDirty, setRepoDirty] = useState(false);
    const guard = useUnsavedChanges();

    const repoScope = env.data?.repos.find(
        (scope) => selectedRepo && scope.owner === selectedRepo.owner && scope.name === selectedRepo.name
    );

    /**
     * The select is a guarded detail switch (issue 182): swapping the editor — or clearing the
     * selection — while its draft is dirty runs the same discard confirmation the route blocker
     * runs. Continue editing changes nothing (the controlled select keeps its value); Discard
     * lets the switch through, and the key-bumped panel starts fresh, which IS the reset.
     */
    const changeRepo = async (value: string) => {
        const [owner, name] = value.split('/');
        const next = owner && name ? { owner, name } : null;
        const switching =
            selectedRepo !== null &&
            (next === null || next.owner !== selectedRepo.owner || next.name !== selectedRepo.name);
        if (switching && selectedRepo && repoDirty && guard) {
            const discardConfirmed = await guard.confirmDiscard({
                id: `repo:${selectedRepo.owner}/${selectedRepo.name}`,
                label: `${selectedRepo.owner}/${selectedRepo.name}`,
                dirty: true,
                // The switch itself is the reset: the old editor unmounts with its draft.
                discard: () => {},
            });
            if (!discardConfirmed) return;
        }
        setSelectedRepo(next);
        setRepoDirty(false);
    };

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Repositories"
                description="Every repository the GitHub App installation reports. Select the ones to check out under Settings → Workspace."
            />
            <section className="panel">
                <div className="panel-head">
                    <h2>Available repositories</h2>
                </div>
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
                            void changeRepo(e.target.value);
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
                {selectedRepo ? <ConfigurationScope scope="repository" repository={selectedRepo} /> : null}
                {env.error ? <p className="status">{env.error}</p> : null}
                {selectedRepo ? (
                    env.loading && !env.data ? (
                        <p className="status">Loading environment…</p>
                    ) : env.data ? (
                        <EnvVarsPanel
                            key={`${selectedRepo.owner}/${selectedRepo.name}`}
                            title={`${selectedRepo.owner}/${selectedRepo.name}`}
                            hint=""
                            initialVars={repoScope?.vars ?? []}
                            onSave={(vars) => env.saveRepo(selectedRepo, vars)}
                            draftId={`repo:${selectedRepo.owner}/${selectedRepo.name}`}
                            draftLabel={`${selectedRepo.owner}/${selectedRepo.name}`}
                            onDirtyChange={setRepoDirty}
                        />
                    ) : null
                ) : null}
            </section>
        </>
    );
}
