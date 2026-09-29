import { useEffect, useId, useState } from 'react';
import type { MouseEvent } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useNavigate } from 'react-router-dom';
import {
    ADD_LABEL,
    executorEditorView,
    executorSavedMessage,
    formatConfig,
    INHERITED_NOTE,
    initialExecutorDraft,
    mergeExecutors,
    parseExecutorConfig,
    readModel,
    withModel,
    type ExecutorDraft,
    type ExecutorRow,
} from '../workspace/executors.js';
import { useDraftReturnHref } from './DraftReturnBanner.js';
import {
    AdvancedConfiguration,
    AgentField,
    CredentialsNote,
    ExecutorActions,
    ModelField,
    modelBlockedNote,
    NameField,
} from './executor-dialog-parts.js';
import { UnsavedChangesDialog } from './UnsavedChangesDialog.js';

/**
 * Add an executor, or edit an existing one (issue 261: guided first, JSON under Advanced).
 *
 * The Headless-UI bargain: the `Dialog` buys the top layer, focus trapping, focus restoration,
 * the backdrop and Escape without a hand-rolled trap; no `<form>` submits because CSP sends
 * `form-action 'none'`.
 *
 * The body reads Name, Agent, Model, then a collapsed Advanced configuration (the fields live in
 * executor-dialog-parts.tsx). A name and an agent save the inherited configuration, `{}`. The
 * guided Model control and the Advanced JSON edit ONE configuration text per agent
 * (`ExecutorDraft.configs`): the control writes `model` into that text with every other key kept,
 * and while the text does not parse the control is disabled with a sentence saying so — a guided
 * value never overwrites a raw draft. Switching agents switches which text is live; the other
 * agent's draft waits untouched.
 *
 * Every field's error sits beside the field, tied with `aria-describedby`, and none is a live
 * region — nothing is announced per keystroke. A disabled Save says why beside it. A failed save
 * keeps the dialog and every field and announces the failure; a successful one reports through
 * `onSaved` (the page's status region) and closes, and Headless restores focus to the trigger.
 *
 * Closing with unsaved work — Cancel, Escape, the backdrop, or the credentials link — raises the
 * settings area's discard confirmation, rendered INSIDE this panel: Headless nests a dialog only
 * when the child is in the parent's React tree, and a sibling would fight this panel's focus trap.
 *
 * The dialog receives the whole list as it opened — configs included, fetched on demand — because
 * the PUT is a whole-list replace: add appends to it, edit folds the changed row back in
 * (`mergeExecutors`), and the untouched rows travel through unchanged, defaults included.
 */

export interface ExecutorDialogProps {
    open: boolean;
    /** The whole executor list as the dialog opened it, configs included. */
    existing: readonly ExecutorRow[];
    /** The name of the row being edited, matched as it was when the dialog opened; null to add. */
    editing: string | null;
    onClose: () => void;
    onSave: (executors: ExecutorRow[]) => Promise<string | null>;
    /** Told the success sentence just before the dialog closes. */
    onSaved: (message: string) => void;
    saving: boolean;
}

/** What to do once the reader answers Discard changes. */
type PendingDiscard = { proceed: () => void };

export function ExecutorDialog({ open, existing, editing, onClose, onSave, onSaved, saving }: ExecutorDialogProps) {
    const [baseline, setBaseline] = useState<ExecutorDraft>(() => initialExecutorDraft(undefined));
    const [draft, setDraft] = useState<ExecutorDraft>(baseline);
    const [nameTouched, setNameTouched] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
    const navigate = useNavigate();
    const envHref = useDraftReturnHref('/settings/workspace');
    // One instance-scoped prefix for every id this dialog hands out: a literal id would be the same
    // label/help/error relationship twice once a second dialog exists.
    const ids = useId();

    // Add opens blank; edit opens pre-filled from the row it is editing. Re-keyed off `editing`
    // too, so switching rows without closing still lands on the right one.
    useEffect(() => {
        if (open) {
            const row = editing === null ? undefined : existing.find((executor) => executor.name === editing);
            const initial = initialExecutorDraft(row);
            setBaseline(initial);
            setDraft(initial);
            setNameTouched(false);
            setFailure(null);
            setPendingDiscard(null);
        }
        // `existing` is deliberately not a dependency: it is captured at open time and stays put
        // while the dialog is up, and re-seeding the fields mid-edit would discard typing.
    }, [open, editing]);

    const isEdit = editing !== null;
    const { type } = draft;
    const view = executorEditorView({ draft, baseline, existing, editing, nameTouched });

    const setConfig = (text: string, customModel: boolean) =>
        setDraft((current) => ({
            ...current,
            configs: { ...current.configs, [current.type]: text },
            customModel: { ...current.customModel, [current.type]: customModel },
        }));

    // Guided writes re-serialize the parsed object: every other key survives, in its order.
    const writeModel = (next: string | null, customModel: boolean) => {
        if (view.parsed.ok) setConfig(JSON.stringify(withModel(view.parsed.value, next), null, 2), customModel);
    };

    // A raw edit that parses decides the Model control's choice; one that does not leaves it be.
    const editJson = (text: string) => {
        const next = parseExecutorConfig(text);
        setConfig(text, next.ok ? readModel(next.value).kind === 'custom' : view.custom);
    };

    const format = () => {
        const formatted = formatConfig(draft.configs[type]);
        if (formatted !== null) setConfig(formatted, view.custom);
    };

    const requestClose = (proceed: () => void = onClose) => {
        if (saving) return;
        if (view.changes.anyChanged) setPendingDiscard({ proceed });
        else proceed();
    };

    // The credentials link leaves the dialog like any other close: never mid-save, and asking first.
    const followEnvLink = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        requestClose(() => navigate(envHref));
    };

    const save = async () => {
        if (!view.validation.ok) {
            setFailure(view.validation.error);
            return;
        }
        const merged = mergeExecutors(existing, editing, view.validation.value);
        if (!merged.ok) {
            setFailure(merged.error);
            return;
        }
        const message = await onSave(merged.value);
        setFailure(message);
        if (!message) {
            onSaved(executorSavedMessage(view.validation.value.name, isEdit));
            onClose();
        }
    };

    return (
        <Dialog open={open} onClose={() => requestClose()} className="dialog-layer" aria-labelledby={`${ids}-title`}>
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog picker">
                    <DialogTitle as="h2" id={`${ids}-title`}>
                        {isEdit ? 'Edit executor' : ADD_LABEL}
                    </DialogTitle>
                    <p className="muted">{INHERITED_NOTE}</p>

                    <NameField
                        ids={ids}
                        value={draft.name}
                        error={view.nameError}
                        onChange={(name) => setDraft({ ...draft, name })}
                        onBlur={() => setNameTouched(true)}
                    />
                    <AgentField ids={ids} value={type} onChange={(next) => setDraft({ ...draft, type: next })} />
                    <ModelField
                        ids={ids}
                        type={type}
                        custom={view.custom}
                        model={view.model}
                        blocked={modelBlockedNote(view.parsed.ok, view.modelUnsupported)}
                        error={view.modelError}
                        onDefault={() => writeModel(null, false)}
                        onCustom={() => setConfig(draft.configs[type], true)}
                        onModel={(value) => writeModel(value.trim() || null, true)}
                    />
                    <CredentialsNote href={envHref} onFollow={followEnvLink} />

                    <AdvancedConfiguration
                        ids={ids}
                        type={type}
                        json={draft.configs[type]}
                        jsonError={view.jsonError}
                        managed={view.managed}
                        rounds={draft.gateFixRounds}
                        roundsError={view.roundsError}
                        onJson={editJson}
                        onFormat={format}
                        onRounds={(gateFixRounds) => setDraft({ ...draft, gateFixRounds })}
                    />

                    <ExecutorActions
                        ids={ids}
                        failure={failure}
                        isEdit={isEdit}
                        saving={saving}
                        unavailable={view.unavailable}
                        onCancel={() => requestClose()}
                        onSave={() => void save()}
                    />

                    {pendingDiscard ? (
                        <UnsavedChangesDialog
                            labels={['this executor']}
                            onClose={() => setPendingDiscard(null)}
                            onConfirm={() => {
                                setPendingDiscard(null);
                                pendingDiscard.proceed();
                            }}
                        />
                    ) : null}
                </DialogPanel>
            </div>
        </Dialog>
    );
}
