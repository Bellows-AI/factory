import { useCallback, useMemo, useState } from 'react';
import type { DefaultWorkflowSaveResult, DefaultWorkflowSettings } from '../api/useDefaultWorkflowSettings.js';
import { useGuardedDraft } from '../components/UnsavedChangesDialog.js';
import { isDirty } from './default-workflow-draft.js';
import type { DefaultWorkflowDraft } from './default-workflow-draft.js';

export interface DefaultWorkflowPanelProps {
    /** The member's stored pair (or the missing-row defaults) — seeded once, never re-adopted from a poll. */
    initialSettings: DefaultWorkflowSettings;
    onSave: (pair: DefaultWorkflowDraft) => Promise<DefaultWorkflowSaveResult>;
}

const pairOf = (settings: DefaultWorkflowSettings): DefaultWorkflowDraft => ({
    reviewReconciliation: settings.reviewReconciliation,
    mergeConflictAutofix: settings.mergeConflictAutofix,
});

/**
 * The `/settings/workflows` panel (issue 208): the mandatory prompt → gates → publish spine as
 * read-only prose, and the two optional-step switches — checkboxes, the one boolean-control
 * primitive this design system has (no dedicated toggle/switch family exists; see
 * docs/design-system.md).
 *
 * The seed-once, mount-gated pattern `EnvVarsPanel` uses: the caller (`SettingsWorkflowsPage`)
 * mounts this only once `initialSettings` exists, and the local draft is captured in a state
 * initializer, so a background poll refetch — a new `initialSettings` object on every parent
 * render — never stomps a typing hand mid-edit.
 */
export function DefaultWorkflowPanel({ initialSettings, onSave }: DefaultWorkflowPanelProps) {
    const [baseline, setBaseline] = useState<DefaultWorkflowDraft>(() => pairOf(initialSettings));
    const [draft, setDraft] = useState<DefaultWorkflowDraft>(() => pairOf(initialSettings));
    const [saving, setSaving] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [saveError, setSaveError] = useState<string | null>(null);

    const dirty = isDirty(baseline, draft);
    const canSave = !saving && dirty;

    const clearConfirmation = () => {
        setStatusText('');
        setSaveError(null);
    };

    const set = (patch: Partial<DefaultWorkflowDraft>) => {
        clearConfirmation();
        setDraft((current) => ({ ...current, ...patch }));
    };

    const discard = useCallback(() => setDraft(baseline), [baseline]);
    const guardedDraft = useMemo(
        () => ({ id: 'default-workflow', label: 'Default workflow', dirty, discard }),
        [dirty, discard]
    );
    useGuardedDraft(guardedDraft);

    const save = async () => {
        if (!canSave) return;
        setSaving(true);
        setSaveError(null);
        try {
            const result = await onSave(draft);
            if (!result.ok) {
                setStatusText('');
                setSaveError(result.error);
            } else {
                const adopted = pairOf(result.data);
                setBaseline(adopted);
                setDraft(adopted);
                setStatusText('Changes saved.');
            }
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>Default workflow</h2>
                <div className="panel-actions">
                    <button type="button" className="primary" onClick={() => void save()} disabled={!canSave}>
                        {saving ? 'Saving changes…' : 'Save changes'}
                    </button>
                </div>
            </div>
            <p className="muted">Prompt → Gates → Publish, on every task that runs the default workflow.</p>
            {saveError ? (
                <p className="status" role="alert">
                    {saveError}
                </p>
            ) : null}
            <p className="muted" role="status">
                {statusText}
            </p>
            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={draft.reviewReconciliation}
                    disabled={saving}
                    onChange={(e) => set({ reviewReconciliation: e.target.checked })}
                />
                Iterate on PR review comments
            </label>
            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={draft.mergeConflictAutofix}
                    disabled={saving}
                    onChange={(e) => set({ mergeConflictAutofix: e.target.checked })}
                />
                Repair merge conflicts
            </label>
            <p className="muted">
                Saved defaults apply to new task drafts; running tasks keep their launch configuration.
            </p>
        </section>
    );
}
