import type { ReactElement } from 'react';
import { humanizeParamName, paramFieldVerdict, type WorkflowParamChoice } from '../task-composer.js';

const PARAM_VALUE_MAX_LENGTH = 512;

/**
 * One declared parameter's field: label, optional author helper, the input itself, its error
 * when invalid, and the raw pattern tucked behind Format details. Split out of
 * `WorkflowParameterFields` so its own id-wiring and verdict logic stays under the complexity
 * limit.
 */
function ParameterField({
    param,
    value,
    touched,
    onInput,
    onBlur,
}: {
    param: WorkflowParamChoice;
    value: string | undefined;
    touched: boolean;
    onInput: (name: string, value: string) => void;
    onBlur: (name: string) => void;
}) {
    const id = `composer-param-${param.name}`;
    const verdict = paramFieldVerdict(param, value, touched);
    const failed =
        verdict.kind === 'required' ||
        verdict.kind === 'too-long' ||
        verdict.kind === 'mismatch' ||
        verdict.kind === 'uncompilable';
    const describedBy =
        [param.description ? `${id}-helper` : null, failed ? `${id}-error` : null]
            .filter((part) => part !== null)
            .join(' ') || undefined;
    return (
        <div className="composer-field">
            <label className="composer-label" htmlFor={id}>
                {humanizeParamName(param.name)}
            </label>
            {param.description ? (
                <p className="composer-helper" id={`${id}-helper`}>
                    {param.description}
                </p>
            ) : null}
            <input
                id={id}
                className="composer-select"
                placeholder={param.example ? `Example: ${param.example}` : 'Required'}
                maxLength={PARAM_VALUE_MAX_LENGTH}
                aria-invalid={failed || undefined}
                aria-describedby={describedBy}
                value={value ?? ''}
                onChange={(e) => onInput(param.name, e.target.value)}
                onBlur={() => onBlur(param.name)}
            />
            {failed ? (
                <p className="composer-param-error" id={`${id}-error`}>
                    {verdict.message}
                </p>
            ) : null}
            {param.pattern !== undefined ? (
                <details className="composer-param-details">
                    <summary>Format details</summary>
                    <code>{param.pattern}</code>
                </details>
            ) : null}
        </div>
    );
}

/**
 * The chosen workflow's declared parameters: one labelled input each, in words a member can act
 * on. Props in, markup out — no fetching, no effects; the touched map is owned by the composer
 * and handed in, so every state a blur or a keyboard submission can produce is renderable in the
 * offline suite.
 *
 * The copy rules the guided composer lives by: the author's `description` renders beside the
 * field and their `example` becomes the empty input's placeholder; a field the member has not
 * reached says "Required" without being painted failed; and the raw pattern source appears ONLY
 * inside the field's Format details — never in a title, a helper, an error, or the Start
 * blocker. Errors reference their own unique ids, so two invalid fields never share a
 * description.
 */
export function WorkflowParameterFields({
    params,
    values,
    touched,
    onInput,
    onBlur,
}: {
    /** The declared parameters of the chosen workflow, one field each. */
    params: readonly WorkflowParamChoice[];
    /** The member's typed values so far, keyed by parameter name. */
    values: Readonly<Record<string, string>>;
    /** Which fields the member has left (or the keyboard submission has marked) — keyed by name. */
    touched: Readonly<Record<string, boolean>>;
    /** One keystroke: the parameter's name, and the field's new value. */
    onInput: (name: string, value: string) => void;
    /** Leaving a field: its first chance to be told what is still wrong with it. */
    onBlur: (name: string) => void;
}): ReactElement {
    return (
        <div className="composer-fields">
            {params.map((param) => (
                <ParameterField
                    key={param.name}
                    param={param}
                    value={values[param.name]}
                    touched={touched[param.name] === true}
                    onInput={onInput}
                    onBlur={onBlur}
                />
            ))}
        </div>
    );
}
