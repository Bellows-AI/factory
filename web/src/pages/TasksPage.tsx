import { useCallback, useEffect, useState } from 'react';
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
    const { jobs, loading, error, queue, resume, followUp, markDone } = useJobs(repo);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [followUpTarget, setFollowUpTarget] = useState<string | null>(null);
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

    // A tab switch is a different conversation: an adjustment armed for one repository's task must
    // not fire from another tab. (The panel also disarms when the armed task is simply absent
    // from the list it is handed — this covers the tab switch before the next poll lands.)
    useEffect(() => {
        setFollowUpTarget(null);
    }, [repo]);

    // When a target is armed, the next Send continues that task instead of starting a new one;
    // clearing only on success keeps the armed state honest if the board refuses.
    const send = async (command: string, executor: string | null): Promise<string | null> => {
        setActionError(null);
        setSending(true);
        try {
            const target = followUpTarget;
            const message =
                target !== null ? await followUp(target, command, executor) : await queue(command, executor);
            if (message !== null) setActionError(message);
            else if (target !== null) setFollowUpTarget(null);
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

    const doneTask = async (id: string) => {
        setActionError(null);
        const message = await markDone(id);
        if (message !== null) setActionError(message);
    };

    // Stable, because the panel's disarm effect names it in its dependencies.
    const cancelFollowUp = useCallback(() => setFollowUpTarget(null), []);

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
                followUpTarget={followUpTarget}
                onFollowUp={setFollowUpTarget}
                onCancelFollowUp={cancelFollowUp}
                onDone={doneTask}
            />
        </main>
    );
}
