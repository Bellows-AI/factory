import type { WorkspaceRepo } from '../api/useWorkspace.js';
import { RepoStatus } from '../components/RepoStatus.js';
import { bytes, commitDate } from '../format.js';

/**
 * One row per selected repository: what is on disk.
 *
 * Every cell that could be absent renders an em dash rather than a zero.
 */
export function WorkspaceReposPanel({ repos }: { repos: readonly WorkspaceRepo[] }) {
    return (
        <section className="panel">
            <h2>Repositories</h2>
            <table className="table">
                <thead>
                    <tr>
                        <th>Repository</th>
                        <th>Status</th>
                        <th>Branch</th>
                        <th>Last commit</th>
                        <th className="right">Size</th>
                    </tr>
                </thead>
                <tbody>
                    {repos.map((repo) => (
                        <tr key={`${repo.owner}/${repo.name}`}>
                            <td>
                                {repo.owner}/{repo.name}
                            </td>
                            <td>
                                <RepoStatus status={repo.status} error={repo.error} />
                            </td>
                            <td>{repo.branch ?? '—'}</td>
                            <td title={repo.lastCommit?.headline ?? ''}>
                                {commitDate(repo.lastCommit?.at)}
                            </td>
                            <td className="right">{bytes(repo.sizeBytes)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
}
