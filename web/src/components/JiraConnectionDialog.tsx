import { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import {
    CONNECTION_ACCESS,
    type ConnectionAccess,
    type ConnectionScope,
    type NewConnectionInput,
} from '../api/connections.js';
import { UnsavedChangesDialog } from './UnsavedChangesDialog.js';

export const CONNECTION_DIALOG_TITLE = 'Add Jira connection';
export const SAVE_CONNECTION_LABEL = 'Add connection';
export const SCOPED_TOKEN_HINT =
    'The API token must be a scoped (service-account) token. A classic token is stored without being tried and then answers 401 on every call.';
export const SITE_HELP = 'Your Atlassian site, without https://.';
export const EMAIL_HELP = 'The account the API token belongs to.';
export const ACCESS_HELP = 'read lets tasks only look Jira up; write also lets them change it.';

const BLANK_DRAFT = { site: '', email: '', apiToken: '', access: 'read' as ConnectionAccess };

/**
 * Add one Jira connection: Site, Email, API token and Access stacked one per row in the executor
 * dialog's field layout. Headless UI owns the focus trap, Escape, the backdrop and focus
 * restoration; no `<form>` because the CSP sends `form-action 'none'`. A refused save keeps the
 * dialog and every field and shows the route's message as sent; a saved one closes. Closing with
 * anything typed raises the settings discard confirmation, rendered inside this panel so Headless
 * nests it (ExecutorDialog's arrangement). The token field is write-only and the draft is blanked
 * on every open.
 */
export function JiraConnectionDialog({
    open,
    scope,
    saving,
    onClose,
    onCreate,
}: {
    open: boolean;
    scope: ConnectionScope;
    saving: boolean;
    onClose: () => void;
    /** Resolves to the refusal message, or null when the connection saved. */
    onCreate: (input: NewConnectionInput) => Promise<string | null>;
}) {
    const [draft, setDraft] = useState(BLANK_DRAFT);
    const [failure, setFailure] = useState<string | null>(null);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    const ids = useId();
    const siteRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) {
            setDraft(BLANK_DRAFT);
            setFailure(null);
            setConfirmingDiscard(false);
        }
    }, [open]);

    const complete = draft.site.trim() !== '' && draft.email.trim() !== '' && draft.apiToken !== '';
    const dirty =
        draft.site !== '' || draft.email !== '' || draft.apiToken !== '' || draft.access !== BLANK_DRAFT.access;
    const close = () => {
        if (saving) return;
        if (dirty) setConfirmingDiscard(true);
        else onClose();
    };
    const save = async () => {
        const message = await onCreate({ scope, ...draft, site: draft.site.trim(), email: draft.email.trim() });
        setFailure(message);
        if (message === null) onClose();
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            className="dialog-layer"
            aria-labelledby={`${ids}-title`}
            initialFocus={siteRef}
        >
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog picker">
                    <DialogTitle as="h2" id={`${ids}-title`}>
                        {CONNECTION_DIALOG_TITLE}
                    </DialogTitle>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-site`}>Jira site</label>
                        <input
                            ref={siteRef}
                            id={`${ids}-site`}
                            className="field"
                            type="text"
                            placeholder="example.atlassian.net"
                            value={draft.site}
                            disabled={saving}
                            aria-describedby={`${ids}-site-help`}
                            onChange={(e) => setDraft({ ...draft, site: e.target.value })}
                        />
                        <p className="picker-help" id={`${ids}-site-help`}>
                            {SITE_HELP}
                        </p>
                    </div>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-email`}>Jira email</label>
                        <input
                            id={`${ids}-email`}
                            className="field"
                            type="email"
                            placeholder="bot@example.com"
                            value={draft.email}
                            disabled={saving}
                            aria-describedby={`${ids}-email-help`}
                            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                        />
                        <p className="picker-help" id={`${ids}-email-help`}>
                            {EMAIL_HELP}
                        </p>
                    </div>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-token`}>Jira API token</label>
                        <input
                            id={`${ids}-token`}
                            className="field"
                            type="password"
                            autoComplete="off"
                            value={draft.apiToken}
                            disabled={saving}
                            aria-describedby={`${ids}-token-help`}
                            onChange={(e) => setDraft({ ...draft, apiToken: e.target.value })}
                        />
                        <p className="picker-help" id={`${ids}-token-help`}>
                            {SCOPED_TOKEN_HINT}
                        </p>
                    </div>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-access`}>Jira access</label>
                        <select
                            id={`${ids}-access`}
                            className="field"
                            value={draft.access}
                            disabled={saving}
                            aria-describedby={`${ids}-access-help`}
                            onChange={(e) => setDraft({ ...draft, access: e.target.value as ConnectionAccess })}
                        >
                            {CONNECTION_ACCESS.map((access) => (
                                <option key={access} value={access}>
                                    {access}
                                </option>
                            ))}
                        </select>
                        <p className="picker-help" id={`${ids}-access-help`}>
                            {ACCESS_HELP}
                        </p>
                    </div>

                    {failure ? (
                        <p className="status" role="alert">
                            {failure}
                        </p>
                    ) : null}
                    {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
                    <div className="picker-actions">
                        <button type="button" onClick={close} disabled={saving}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className="primary"
                            disabled={saving || !complete}
                            onClick={() => void save()}
                        >
                            {saving ? 'Saving…' : SAVE_CONNECTION_LABEL}
                        </button>
                    </div>

                    {confirmingDiscard ? (
                        <UnsavedChangesDialog
                            labels={['this Jira connection']}
                            onClose={() => setConfirmingDiscard(false)}
                            onConfirm={() => {
                                setConfirmingDiscard(false);
                                onClose();
                            }}
                        />
                    ) : null}
                </DialogPanel>
            </div>
        </Dialog>
    );
}
