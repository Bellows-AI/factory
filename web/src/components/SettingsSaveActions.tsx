/** The dirty indicator's words — the one place they are spelled. */
export const UNSAVED_CHANGES_LABEL = 'Unsaved changes';

/**
 * The footer every settings editor ends with (issue 282): an "Unsaved changes" indicator while
 * the draft differs from what is stored, Cancel (back to the stored rows) and Save, the panel's
 * one primary action. Presentational — the editor owns the draft, the guard and the request; this
 * only draws what they decided. The indicator is text, never color alone, and is not a live
 * region: every keystroke would announce it.
 */
export function SettingsSaveActions({
    dirty,
    saving,
    canSave,
    onSave,
    onCancel,
}: {
    dirty: boolean;
    saving: boolean;
    canSave: boolean;
    onSave: () => void;
    onCancel: () => void;
}) {
    return (
        <div className="settings-actions">
            {dirty ? <span className="settings-dirty">{UNSAVED_CHANGES_LABEL}</span> : null}
            <button type="button" onClick={onCancel} disabled={!dirty || saving}>
                Cancel
            </button>
            <button type="button" className="primary" onClick={onSave} disabled={!canSave}>
                {saving ? 'Saving changes…' : 'Save changes'}
            </button>
        </div>
    );
}
