import { useCallback, useEffect, useRef, useState } from 'react';
import { useRepos } from '../api/useRepos.js';
import type { UseRepos } from '../api/useRepos.js';
import type { UseWorkspace } from '../api/useWorkspace.js';
import type { EnvVarView, UseEnv } from '../api/useEnv.js';
import { PageHeader } from '../components/PageHeader.js';
import { useGuardedDraft, useUnsavedChanges } from '../components/UnsavedChangesDialog.js';
import type { GuardApi } from '../components/UnsavedChangesDialog.js';
import { RepositoryConfigDetail, RepositorySetupList, RepositorySetupSummary } from '../components/RepositorySetup.js';
import {
    absentSelection,
    counts,
    isDirty,
    matchesSearch,
    nextDraftAfterSeed,
    orderByRecency,
    repoKey,
    selectionPayload,
    selectionSaveState,
    toggleSelection,
} from '../components/repository-setup.js';
import type { WorkspaceState } from '../components/repository-setup.js';
import { checkoutCell, checkoutText } from '../components/repository-setup.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/** The installation list's transient postures, worded like the page has always worded them: a
 * load in flight says so, and a hard failure is named rather than rendered as an empty list. */
function installationListNotice(repos: UseRepos): string | null {
    if (repos.data) return null;
    if (repos.loading) return 'Loading repositories…';
    if (repos.error) return `Could not reach GitHub: ${repos.error}`;
    return null;
}

/**
 * The configured repository's environment editor: a loading line while the org-wide env read is
 * still in flight, or the panel once it has landed. Split out of `SettingsRepositoriesPage` so
 * its own loading/data check does not add to the page's cognitive complexity.
 */
function ConfiguredRepoEnv({
    configured,
    owner,
    name,
    scope,
    env,
    onDirtyChange,
}: {
    configured: string;
    owner: string;
    name: string;
    scope: { vars: EnvVarView[] } | undefined;
    env: UseEnv;
    onDirtyChange: (dirty: boolean) => void;
}) {
    if (env.loading && !env.data) return <p className="status">Loading environment…</p>;
    if (!env.data) return null;
    return (
        <EnvVarsPanel
            key={configured}
            title={configured}
            hint=""
            initialVars={scope?.vars ?? []}
            onSave={(vars) => env.saveRepo({ owner, name }, vars)}
            draftId={`repo:${configured}`}
            draftLabel={configured}
            onDirtyChange={onDirtyChange}
        />
    );
}

/**
 * The whole-selection draft: seeded once from the workspace poll's answer, re-seeded only while
 * the member has not touched it (so the two-second poll never clobbers a click), and registered
 * with the area's unsaved-change guard. Split out of `SettingsRepositoriesPage` so its own state
 * and effect do not add to the page's line count.
 */
function useRepositorySelectionDraft(workspace: UseWorkspace) {
    const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
    /** The server's last known selection — the draft's baseline and dirty computation. */
    const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
    const [savedNote, setSavedNote] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const wsRepos = workspace.data?.repos;
    const seedKey = wsRepos ? wsRepos.map(repoKey).sort().join(',') : null;

    /*
     * The FIRST seed is adopted outright — an empty draft before the first answer is the initial
     * state, not a member edit — and afterwards the draft survives a re-seed only when it is
     * dirty against the PREVIOUS seed (nextDraftAfterSeed). The identity-key trick keeps the
     * two-second poll from re-running this and throwing away whatever the person had just
     * clicked.
     */
    const seededRef = useRef<ReadonlySet<string> | null>(null);
    useEffect(() => {
        if (seedKey === null) return;
        const seeded = seedKey ? new Set(seedKey.split(',')) : new Set<string>();
        const previous = seededRef.current;
        seededRef.current = seeded;
        setBaseline(seeded);
        setChosen((current) => nextDraftAfterSeed(previous, current, seeded));
    }, [seedKey]);

    const dirty = baseline !== null && isDirty(chosen, baseline);

    /** The guard's reset: the draft goes back to the server's last known selection. */
    const discardSelection = useCallback(() => {
        if (baseline) setChosen(new Set(baseline));
        setSavedNote(false);
        setFailure(null);
    }, [baseline]);
    useGuardedDraft({ id: 'workspace.repos', label: 'the repository selection', dirty, discard: discardSelection });

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

    return { wsRepos, chosen, baseline, savedNote, failure, dirty, onToggle, onDeselectAbsent, saveSelection };
}

/**
 * The configured-repository detail: which repository is open, its editor's dirty flag, the
 * narrow-widths focus handoff, and the guarded switch between repositories. Split out of
 * `SettingsRepositoriesPage` for the same reason as `useRepositorySelectionDraft`.
 */
function useConfiguredRepoDetail(guard: GuardApi | null) {
    const [configured, setConfigured] = useState<string | null>(null);
    /** The configured editor's dirty flag, mirrored by the panel's onDirtyChange: the switch
     * question must be asked BEFORE the panel unmounts and its draft dies with it. */
    const [detailDirty, setDetailDirty] = useState(false);
    const headingRef = useRef<HTMLHeadingElement | null>(null);

    // The narrow-widths handoff: Configure moved the reader to the detail, so the focus follows —
    // only where the detail is not already beside the list.
    useEffect(() => {
        if (!configured) return;
        if (!window.matchMedia('(max-width: 1099px)').matches) return;
        headingRef.current?.focus();
    }, [configured]);

    /**
     * Configure is a guarded detail switch (issue 182): swapping the editor while its draft is
     * dirty runs the same discard confirmation the route blocker runs. Continue editing changes
     * nothing; Discard lets the switch through, and the key-bumped panel starts fresh, which IS
     * the reset — so the draft it hands the dialog discards nothing itself.
     */
    const configure = async (key: string) => {
        if (configured && configured !== key && detailDirty && guard) {
            const discardConfirmed = await guard.confirmDiscard({
                id: `repo:${configured}`,
                label: configured,
                dirty: true,
                discard: () => {},
            });
            if (!discardConfirmed) return;
        }
        setConfigured(key);
        setDetailDirty(false);
    };

    return { configured, detailDirty, setDetailDirty, headingRef, configure };
}

/**
 * The Repositories section of the settings tree: the one place that answers everything about
 * repositories (issue 181) — what the installation reports, what this member checks out, what
 * state each checkout is in, and the organization-wide environment of one repository.
 *
 * The page owns the whole-selection draft. It seeds once from the workspace poll's answer and
 * re-seeds only while the member has not touched it, so the two-second poll never clobbers a
 * click; the save PUTs the WHOLE selection and adopts the draft as the new baseline on the 202,
 * while a failure keeps both the draft and the last-good statuses. The dirty selection registers
 * with the area's unsaved-change guard (issue 182), so leaving the page with an unsaved draft
 * meets the one discard confirmation; discarding reseeds the draft from the baseline.
 *
 * Configuration does not require personal checkout enablement: the repository env scope is
 * organization-wide and any member edits it — the server validates installation visibility. The
 * removed role gate here was web-only decoration over that contract.
 */

/**
 * Every value the page renders from, derived once from the poll answers and the draft. Split out
 * of `SettingsRepositoriesPage` so its own derivations do not add to the page's cognitive
 * complexity.
 */
function deriveRepositoryPageView(input: {
    workspace: UseWorkspace;
    repos: UseRepos;
    env: UseEnv;
    chosen: ReadonlySet<string>;
    baseline: ReadonlySet<string> | null;
    search: string;
    configured: string | null;
}) {
    const { workspace, repos, env, chosen, baseline, search, configured } = input;
    const workspaceState: WorkspaceState = workspace.data ? 'ready' : workspace.error ? 'error' : 'loading';
    const rootNull = workspace.data !== null && workspace.data.root === null;
    const reported = repos.data?.repos ?? [];
    const loaded = repos.data !== null;
    const shown = matchesSearch(orderByRecency(reported), search);
    const rowsByKey = new Map((workspace.data?.repos ?? []).map((row) => [repoKey(row), row]));
    const absent = loaded ? absentSelection(chosen, reported) : [];
    const loadingCheckouts = workspaceState !== 'ready';
    const countsValue = loaded && workspace.data ? counts(reported, workspace.data.repos, chosen) : null;
    const reposNotice = installationListNotice(repos);
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
    const configuredRepo = configured ? rowsByKey.get(configured) : undefined;
    const configuredCheckout = configured ? checkoutText(checkoutCell(true, configuredRepo, workspaceState)) : '';
    const [configuredOwner, configuredName] = configured?.split('/') ?? [];
    const configuredScope = env.data?.repos.find(
        (scope) => configuredOwner !== undefined && scope.owner === configuredOwner && scope.name === configuredName
    );
    return {
        workspaceState,
        rootNull,
        reported,
        loaded,
        shown,
        rowsByKey,
        absent,
        loadingCheckouts,
        countsValue,
        reposNotice,
        saveState,
        saveDisabled,
        configuredOwner,
        configuredName,
        configuredCheckout,
        configuredScope,
    };
}

export function SettingsRepositoriesPage() {
    const { workspace, env } = useSettingsPage();
    const repos = useRepos(true);
    const [search, setSearch] = useState('');
    const guard = useUnsavedChanges();
    const { chosen, baseline, savedNote, failure, dirty, onToggle, onDeselectAbsent, saveSelection } =
        useRepositorySelectionDraft(workspace);
    const { configured, setDetailDirty, headingRef, configure } = useConfiguredRepoDetail(guard);
    const view = deriveRepositoryPageView({ workspace, repos, env, chosen, baseline, search, configured });

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
            <div className={configured ? 'repo-columns has-detail' : 'repo-columns'}>
                <div>
                    <RepositorySetupSummary
                        counts={view.countsValue}
                        installation={repos.data?.installation ?? null}
                        cachedError={repos.data?.meta.error ?? null}
                        fetchedAt={repos.data?.meta.fetchedAt ?? null}
                        listNotice={view.reposNotice}
                        rootNull={view.rootNull}
                        staleError={workspace.data ? workspace.error : null}
                    />
                    <RepositorySetupList
                        repos={view.reported}
                        shown={view.shown}
                        search={search}
                        onSearch={setSearch}
                        chosen={chosen}
                        onToggle={onToggle}
                        workspaceState={view.workspaceState}
                        rows={view.rowsByKey}
                        configured={configured}
                        onConfigure={(key) => void configure(key)}
                        loadingCheckouts={view.loadingCheckouts}
                        rootNull={view.rootNull}
                        saving={workspace.saving}
                        absent={view.absent}
                        onDeselectAbsent={onDeselectAbsent}
                        loaded={view.loaded}
                        dirty={dirty}
                        saveState={{ disabled: view.saveDisabled, reason: view.saveState.reason }}
                        savedNote={savedNote}
                        failure={failure}
                        onSave={() => void saveSelection()}
                    />
                </div>
                <div>
                    <RepositoryConfigDetail
                        repo={configured ? { owner: view.configuredOwner!, name: view.configuredName! } : null}
                        checkout={view.configuredCheckout}
                        headingRef={headingRef}
                    >
                        {configured && view.configuredOwner !== undefined ? (
                            <ConfiguredRepoEnv
                                configured={configured}
                                owner={view.configuredOwner}
                                name={view.configuredName!}
                                scope={view.configuredScope}
                                env={env}
                                onDirtyChange={setDetailDirty}
                            />
                        ) : null}
                    </RepositoryConfigDetail>
                </div>
            </div>
        </>
    );
}
