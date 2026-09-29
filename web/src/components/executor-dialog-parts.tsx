import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { EXECUTOR_TYPES, type ExecutorType } from '@factory-ai/core';
import {
    ADD_LABEL,
    ADVANCED_LABEL,
    AGENT_HELP,
    CONFIG_JSON_LABEL,
    CONFIG_TESTED_NOTE,
    CREDENTIALS_NOTE,
    EXECUTOR_TYPE_META,
    executorTypeLabel,
    FORMAT_JSON_LABEL,
    GATE_FIX_ROUNDS_HELP,
    MODEL_BLOCKED_NOTE,
    MODEL_CUSTOM_LABEL,
    MODEL_DEFAULT_LABEL,
    MODEL_NOT_TEXT,
    NAME_HELP,
    RUNNER_MANAGED_NOTE,
    SAVE_LABEL,
} from '../workspace/executors.js';
import { JsonEditor } from './JsonEditor.js';

/**
 * The executor dialog's fields (issue 261), presentational only: ExecutorDialog.tsx owns the draft
 * and hands each part its value, its error and its callbacks. Every part mints its ids from the
 * dialog's one `useId` prefix, and every error is a described-by paragraph, never a live region.
 */

/** Joins the dialog-scoped ids a control is described by, skipping the absent ones. */
export function describedBy(ids: string, ...parts: (string | null | false)[]): string {
    return parts
        .filter(Boolean)
        .map((part) => `${ids}-${part}`)
        .join(' ');
}

/** A field's own error, below its help. */
function FieldError({ id, error }: { id: string; error: string | null }) {
    return error ? (
        <p className="status" id={id}>
            {error}
        </p>
    ) : null;
}

export function NameField(props: {
    ids: string;
    value: string;
    error: string | null;
    onChange: (value: string) => void;
    onBlur: () => void;
}) {
    const { ids, value, error } = props;
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-name`}>Name</label>
            <input
                id={`${ids}-name`}
                className="field"
                type="text"
                value={value}
                placeholder="Code review"
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(ids, 'name-help', error !== null && 'name-error')}
                onChange={(event) => props.onChange(event.target.value)}
                onBlur={props.onBlur}
            />
            <p className="picker-help" id={`${ids}-name-help`}>
                {NAME_HELP}
            </p>
            <FieldError id={`${ids}-name-error`} error={error} />
        </div>
    );
}

export function AgentField({
    ids,
    value,
    onChange,
}: {
    ids: string;
    value: ExecutorType;
    onChange: (value: ExecutorType) => void;
}) {
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-agent`}>Agent</label>
            <select
                id={`${ids}-agent`}
                className="field"
                value={value}
                aria-describedby={describedBy(ids, 'agent-help')}
                onChange={(event) => onChange(event.target.value as ExecutorType)}
            >
                {/* Rendered from the shared list, so a future type needs no JSX change. */}
                {EXECUTOR_TYPES.map((type) => (
                    <option key={type} value={type}>
                        {executorTypeLabel(type)}
                    </option>
                ))}
            </select>
            <p className="picker-help" id={`${ids}-agent-help`}>
                {AGENT_HELP}
            </p>
        </div>
    );
}

/**
 * The Model choice: the runner's default, or a custom identifier written into the configuration's
 * `model`. `blocked` is the configuration not parsing (or holding a non-text model) — the control
 * waits, disabled, with the sentence that says where to fix it.
 */
export function ModelField(props: {
    ids: string;
    type: ExecutorType;
    custom: boolean;
    model: string;
    blocked: string | null;
    error: string | null;
    onDefault: () => void;
    onCustom: () => void;
    onModel: (value: string) => void;
}) {
    const { ids, custom, blocked, error } = props;
    const meta = EXECUTOR_TYPE_META[props.type];
    return (
        <fieldset
            className="picker-field picker-model"
            aria-describedby={describedBy(
                ids,
                'model-help',
                blocked !== null && 'model-blocked',
                error !== null && 'model-error'
            )}
        >
            <legend>Model</legend>
            <label className="settings-toggle">
                <input
                    type="radio"
                    name={`${ids}-model`}
                    checked={!custom}
                    disabled={blocked !== null}
                    onChange={props.onDefault}
                />
                {MODEL_DEFAULT_LABEL}
            </label>
            <label className="settings-toggle">
                <input
                    type="radio"
                    name={`${ids}-model`}
                    checked={custom}
                    disabled={blocked !== null}
                    onChange={props.onCustom}
                />
                {MODEL_CUSTOM_LABEL}
            </label>
            {custom ? (
                <input
                    className="field"
                    type="text"
                    aria-label={MODEL_CUSTOM_LABEL}
                    value={props.model}
                    // A blocked control cannot read the model, and an example would pass for it.
                    placeholder={blocked === null ? meta.modelExample : undefined}
                    disabled={blocked !== null}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(ids, 'model-help', error !== null && 'model-error')}
                    onChange={(event) => props.onModel(event.target.value)}
                />
            ) : null}
            <p className="picker-help" id={`${ids}-model-help`}>
                {meta.modelHelp} For example: {meta.modelExample}
            </p>
            {blocked ? (
                <p className="picker-help" id={`${ids}-model-blocked`}>
                    {blocked}
                </p>
            ) : null}
            <FieldError id={`${ids}-model-error`} error={error} />
        </fieldset>
    );
}

/** Why the Model control is disabled, or null while it can edit the configuration. */
export function modelBlockedNote(parsedOk: boolean, unsupported: boolean): string | null {
    if (!parsedOk) return MODEL_BLOCKED_NOTE;
    return unsupported ? `${MODEL_NOT_TEXT}. ${MODEL_BLOCKED_NOTE}` : null;
}

/** Where credentials go instead of the configuration, with the composer's return forwarded. */
export function CredentialsNote({
    href,
    onFollow,
}: {
    href: string;
    onFollow: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
    return (
        <p className="picker-help">
            {CREDENTIALS_NOTE}{' '}
            <Link to={href} onClick={onFollow}>
                Workspace settings
            </Link>
            .
        </p>
    );
}

/** The settings in the configuration the runner will not honor, by key path — never by value. */
function RunnerManaged({ keys }: { keys: readonly string[] }) {
    if (keys.length === 0) return null;
    return (
        <div className="banner-warn picker-managed">
            <p>{RUNNER_MANAGED_NOTE}</p>
            <ul>
                {keys.map((key) => (
                    <li key={key}>
                        <code>{key}</code>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function AdvancedConfiguration(props: {
    ids: string;
    type: ExecutorType;
    json: string;
    jsonError: string | null;
    managed: readonly string[];
    rounds: string;
    roundsError: string | null;
    onJson: (value: string) => void;
    onFormat: () => void;
    onRounds: (value: string) => void;
}) {
    const { ids, jsonError, roundsError } = props;
    return (
        <details className="picker-advanced">
            <summary>{ADVANCED_LABEL}</summary>

            <div className="picker-field">
                <label htmlFor={`${ids}-config`}>{CONFIG_JSON_LABEL}</label>
                <JsonEditor
                    id={`${ids}-config`}
                    value={props.json}
                    onChange={props.onJson}
                    invalid={jsonError !== null}
                    describedBy={describedBy(ids, 'config-help', jsonError !== null && 'config-error')}
                />
                <p className="picker-help" id={`${ids}-config-help`}>
                    {EXECUTOR_TYPE_META[props.type].configHelp} {CONFIG_TESTED_NOTE}
                </p>
                <FieldError id={`${ids}-config-error`} error={jsonError} />
                <div className="picker-field-actions">
                    <button type="button" onClick={props.onFormat} disabled={jsonError !== null}>
                        {FORMAT_JSON_LABEL}
                    </button>
                </div>
            </div>

            <RunnerManaged keys={props.managed} />

            <div className="picker-field">
                <label htmlFor={`${ids}-rounds`}>Gate repair rounds</label>
                <input
                    id={`${ids}-rounds`}
                    className="field"
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={props.rounds}
                    placeholder="3"
                    aria-invalid={roundsError ? true : undefined}
                    aria-describedby={describedBy(ids, 'rounds-help', roundsError !== null && 'rounds-error')}
                    onChange={(event) => props.onRounds(event.target.value)}
                />
                <p className="picker-help" id={`${ids}-rounds-help`}>
                    {GATE_FIX_ROUNDS_HELP}
                </p>
                <FieldError id={`${ids}-rounds-error`} error={roundsError} />
            </div>
        </details>
    );
}

/**
 * A failed save's announcement, then Cancel and the save, with the reason a disabled save is
 * unavailable on the row's leading edge.
 */
export function ExecutorActions(props: {
    ids: string;
    failure: string | null;
    isEdit: boolean;
    saving: boolean;
    unavailable: string | null;
    onCancel: () => void;
    onSave: () => void;
}) {
    const { ids, saving } = props;
    const hint = saving ? null : props.unavailable;
    return (
        <>
            {props.failure ? (
                <p className="status" role="alert">
                    {props.failure}
                </p>
            ) : null}
            {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
            <div className="picker-actions">
                {hint ? (
                    <p className="picker-save-hint" id={`${ids}-save-hint`}>
                        {hint}
                    </p>
                ) : null}
                <button type="button" onClick={props.onCancel} disabled={saving}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="primary"
                    onClick={props.onSave}
                    disabled={saving || hint !== null}
                    aria-describedby={hint ? `${ids}-save-hint` : undefined}
                >
                    {saving ? 'Saving…' : props.isEdit ? SAVE_LABEL : ADD_LABEL}
                </button>
            </div>
        </>
    );
}
