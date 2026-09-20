import { useEffect, useRef, useState } from 'react';
import { useRepos } from '../api/useRepos.js';
import { PageHeader } from '../components/PageHeader.js';
import { RepositoryConfigDetail, RepositorySetupList, RepositorySetupSummary } from '../components/RepositorySetup.js';
import {
    absentSelection,
    counts,
    isDirty,
    matchesSearch,
    orderByRecency,
    repoKey,
    selectionPayload,
    selectionSaveState,
    seedSelection,
    toggleSelection,
} from '../components/repository-setup.js';
import type { WorkspaceState } from '../components/repository-setup.js';
import { checkoutCell, checkoutText } from '../components/repository-setup.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { leaveReason } from '../unsaved.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Repositories section of the settings tree: the one place that answers everything about
 * repositories (issue 181) — what the installation reports, what this member checks out, what
 * state each checkout is in, and the organization-wide environment of one repository.
 *
 * The page owns the whole-selection draft. It seeds once from the workspace poll's answer and
 * re-seeds only while the member has not touched it, so the two-second poll never clobbers a
 * click; the save PUTs the WHOLE selection and adopts the draft as the new baseline on the 202,
 * while a failure keeps both the draft and the last-good statuses. The dirty selection and the
 * dirty configuration detail register against the area's shared unsaved-change registry; the
 * detail's dirty guard is what stops one repository's environment being swapped for another's
 * without a word.
 *
 * Configuration does not require personal checkout enablement: the repository env scope is
 * organization-wide and any member edits it — the server validates installation visibility. The
 * removed role gate here was web-only decoration over that contract.
 */
export function SettingsRepositoriesPage() {
    const { workspace, env, unsaved } = useSettingsPage();
    // The page's guard effects bind to `setGuard` alone — the coordinator object's identity moves
    // with every guard change, and an effect keyed on it would chase its own writes forever.
    const { setGuard } = unsaved;
    const repos = useRepos(true);
    const [search, setSearch] = useState('');
    const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
    /** The server's last known selection — the draft's baseline and dirty computation. */
    const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
    const [configured, setConfigured] = useState<string | null>(null);
    const [savedNote, setSavedNote] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [detailDirty, setDetailDirty] = useState(false);
    const [blockedReason, setBlockedReason] = useState<string | null>(null);
    const headingRef = useRef<HTMLHeadingElement | null>(null);

    const wsRepos = workspace.data?.repos;
    const seedKey = wsRepos ? wsRepos.map(repoKey).sort().join(',') : null;

    /*
     * Seeded from the workspace poll's answer, and re-seeded only while the draft is clean — the
     * same identity-key trick the old picker used: depending on the polled array directly would
     * re-run this every tick and throw away whatever the person had just clicked.
     */
    useEffect(() => {
        if (seedKey === null) return;
        const seeded = seedKey ? new Set(seedKey.split(',')) : new Set<string>();
        setBaseline(seeded);
        setChosen((current) => (isDirty(current, seeded) ? current : seeded));
    }, [seedKey]);

    const dirty = baseline !== null && isDirty(chosen, baseline);

    useEffect(() => {
        setGuard('workspace.repos', dirty ? 'Selection changed — save to update your workspace' : null);
        return () => setGuard('workspace.repos', null);
    }, [dirty, setGuard]);

    useEffect(() => {
        if (!configured) return;
        const id = `repo-env:${configured}`;
        if (detailDirty) setGuard(id, 'Repository environment has unsaved changes.');
        else setGuard(id, null);
        return () => setGuard(id, null);
    }, [configured, detailDirty, setGuard]);

    // The narrow-widths handoff:Configure moved the reader to the detail, so the focus follows —
    // only where the detail is not already beside the list.
    useEffect(() => {
        if (!configured) return;
        if (!window.matchMedia('(max-width: 1099px)').matches) return;
        headingRef.current?.focus();
    }, [configured]);

    const workspaceState: WorkspaceState = workspace.data ? 'ready' : workspace.error ? 'error' : 'loading';
    const rootNull = workspace.data !== null && workspace.data.root === null;
    const reported = repos.data?.repos ?? [];
    const loaded = repos.data !== null;
    const ordered = orderByRecency(reported);
    const shown = matchesSearch(ordered, search);
    const rowsByKey = new Map((wsRepos ?? []).map((row) => [repoKey(row), row]));
    const absent = loaded ? absentSelection(chosen, reported) : [];
    const loadingCheckouts = workspaceState !== 'ready';
    const countsValue = loaded && workspace.data ? counts(reported, workspace.data.repos, chosen) : null;
    // The installation list's transient postures, worded like the page has always worded them: a
    // load in flight says so, and a hard failure is named rather than rendered as an empty list.
    const reposNotice = !repos.data
        ? repos.loading
            ? 'Loading repositories…'
            : repos.error
              ? `Could not reach GitHub: ${repos.error}`
              : null
        : null;
    const saveState = selectionSaveState({
        saving: workspace.saving,
        reposLoading: repos.loading,
        reposData: repos.data,
        absentCount: absent.length,
        rootNull,
    });
    // The save is a full replacement: until the workspace poll has answered, the draft is empty
    // for lack of an answer, not because the member deselected everything — so it stays blocked.
    const saveDisabled = saveState.disabled || baseline === null;

    const onToggle = (key: string) => {
        setSavedNote(false);
        setFailure(null);
        setChosen((current) => toggleSelection(current, key));
    };

    const onDeselectAbsent = (key: string) => {
        setSavedNote(false);
        setFailure(null);
        setChosen((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
        });
    };

    const configure = (key: string) => {
        if (configured && configured !== key) {
            const reason = leaveReason(unsaved.guards, `repo-env:${configured}`);
            if (reason) {
                setBlockedReason(reason);
                return;
            }
        }
        setConfigured(key);
        setBlockedReason(null);
        setDetailDirty(false);
    };

    const saveSelection = async () => {
        setSavedNote(false);
        const message = await workspace.save(selectionPayload(chosen));
        if (message === null) {
            // 202: the clones have not started yet. The draft becomes the baseline, the poll the
            // hook re-armed carries the queued/cloning statuses in, and the note explains it.
            setBaseline(chosen);
            setFailure(null);
            setSavedNote(true);
        } else {
            setFailure(message);
        }
    };

    const configuredRepo = configured ? rowsByKey.get(configured) : undefined;
    const configuredCheckout = configured ? checkoutText(checkoutCell(true, configuredRepo, workspaceState)) : '';
    const [configuredOwner, configuredName] = configured?.split('/') ?? [];
    const configuredScope = env.data?.repos.find(
        (scope) => configuredOwner !== undefined && scope.owner === configuredOwner && scope.name === configuredName
    );

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Repositories"
                description="Choose which repositories are checked out for your workspace and configure repository-wide environment."
            />
            {/* A failed poll with no data has no last-good facts to mark stale — the named error is
                the whole story. With data, the summary carries the stale marker instead. */}
            {!workspace.data && workspace.error ? <p className="status">{workspace.error}</p> : null}
            {env.error ? <p className="status">{env.error}</p> : null}
            <div className="repo-columns">
                <div>
                    <RepositorySetupSummary
                        counts={countsValue}
                        installation={repos.data?.installation ?? null}
                        cachedError={repos.data?.meta.error ?? null}
                        fetchedAt={repos.data?.meta.fetchedAt ?? null}
                        listNotice={reposNotice}
                        rootNull={rootNull}
                        dirty={dirty}
                        saveState={{ disabled: saveDisabled, reason: saveState.reason }}
                        saving={workspace.saving}
                        savedNote={savedNote}
                        failure={failure}
                        staleError={workspace.data ? workspace.error : null}
                        onSave={() => void saveSelection()}
                    />
                    <RepositorySetupList
                        repos={reported}
                        shown={shown}
                        search={search}
                        onSearch={setSearch}
                        chosen={chosen}
                        onToggle={onToggle}
                        workspaceState={workspaceState}
                        rows={rowsByKey}
                        configured={configured}
                        onConfigure={configure}
                        loadingCheckouts={loadingCheckouts}
                        saving={workspace.saving}
                        absent={absent}
                        onDeselectAbsent={onDeselectAbsent}
                        loaded={loaded}
                    />
                </div>
                <div>
                    <RepositoryConfigDetail
                        repo={configured ? { owner: configuredOwner!, name: configuredName! } : null}
                        checkout={configuredCheckout}
                        blockedReason={blockedReason}
                        headingRef={headingRef}
                    >
                        {configured && configuredOwner !== undefined ? (
                            env.loading && !env.data ? (
                                <p className="status">Loading environment…</p>
                            ) : env.data ? (
                                <EnvVarsPanel
                                    key={configured}
                                    title={configured}
                                    hint=""
                                    initialVars={configuredScope?.vars ?? []}
                                    onSave={(vars) =>
                                        env.saveRepo({ owner: configuredOwner, name: configuredName! }, vars)
                                    }
                                    onDirtyChange={(dirtyNow) => {
                                        setDetailDirty(dirtyNow);
                                        // A saved or reverted detail releases the switch blocker too.
                                        if (!dirtyNow) setBlockedReason(null);
                                    }}
                                />
                            ) : null
                        ) : null}
                    </RepositoryConfigDetail>
                </div>
            </div>
        </>
    );
}
