import { useEffect, useState } from 'react';
import { useJob, useJobs } from '../api/useJobs.js';
import { useWorkspace } from '../api/useWorkspace.js';
import { TasksPanel } from '../panels/TasksPanel.js';

/**
 * The tasks chat.
 *
 * The repository tabs come from the same workspace poll the Workspace page uses — the tabs ARE the
 * member's selection, so a deselected repository's tab goes away while its jobs stay reachable
 * under All. The executor dropdown comes from the same payload. Both are configuration the member
 * already owns; the page adds only the tab and thread selection.
 */
export function TasksPage() {
    const workspace = useWorkspace();
    const [repo, setRepo] = useState<string | null>(null);
    const { jobs, loading, error, queue, resume } = useJobs(repo);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const detail = useJob(selectedId);

    // A deselected repository must not keep filtering invisibly: when the active tab's repo leaves
    // the selection, the page falls back to All, which is where its jobs remain reachable.
    useEffect(() => {
        const repos = workspace.data?.repos;
        if (repos === undefined || repo === null) return;
        if (!repos.some(({ owner, name }) => `${owner}/${name}` === repo)) setRepo(null);
    }, [workspace.data, repo]);

    const send = async (command: string, executor: string | null): Promise<string | null> => {
        setActionError(null);
        setSending(true);
        try {
            const message = await queue(command, executor);
            if (message !== null) setActionError(message);
            return message;
        } finally {
            setSending(false);
        }
    };

    const resumeTask = async (id: string) => {
        setActionError(null);
        const message = await resume(id);
        if (message !== null) setActionError(message);
    };

    return (
        <main>
            {error ? <p className="status">{error}</p> : null}
            {actionError ? <p className="status">{actionError}</p> : null}
            <TasksPanel
                repos={workspace.data?.repos ?? null}
                workspaceError={workspace.error}
                onRetryWorkspace={workspace.refresh}
                executors={workspace.data?.executors ?? []}
                repo={repo}
                onRepo={setRepo}
                jobs={loading && jobs === null ? null : jobs}
                detail={detail.job}
                detailError={detail.error}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onResume={resumeTask}
                onSend={send}
                sending={sending}
            />
        </main>
    );
}
