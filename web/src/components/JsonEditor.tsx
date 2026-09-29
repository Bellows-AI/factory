import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { type JsonTokenKind, tokenizeJson } from '../workspace/executors.js';

/**
 * The Advanced configuration editor (issue 261): a plain textarea with a line-number gutter and a
 * highlighted copy of its text drawn underneath. The textarea is the one control — its text is
 * transparent, its caret is not — so selection, undo, paste and assistive technology all see an
 * ordinary field; the gutter and the highlight are `aria-hidden` paint that follows its scroll.
 *
 * Tab is never intercepted: a keyboard user leaves the editor the way they leave any field.
 * Indentation comes from Enter, which carries the current line's leading whitespace (through the
 * browser's own editing, so undo keeps working), and from
 * the dialog's Format JSON. Scroll sync assigns scroll offsets through refs, never a `style` prop
 * — the CSP refuses inline style. Under forced colors the highlight layer is hidden
 * (platform.css), because the system repaint makes the textarea's own text visible.
 */

/** The class each token kind paints with; whitespace needs none. */
const JSON_TOKEN_CLASS: Record<JsonTokenKind, string | undefined> = {
    key: 'json-token-key',
    string: 'json-token-string',
    number: 'json-token-number',
    literal: 'json-token-literal',
    punct: 'json-token-punct',
    invalid: 'json-token-invalid',
    space: undefined,
};

export interface JsonEditorProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
    invalid: boolean;
    describedBy: string;
}

export function JsonEditor({ id, value, onChange, invalid, describedBy }: JsonEditorProps) {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const gutterRef = useRef<HTMLDivElement>(null);
    const highlightRef = useRef<HTMLPreElement>(null);
    // Where the caret belongs after an Enter that re-rendered the controlled value — React moves
    // it to the end when it writes the new text.
    const caret = useRef<number | null>(null);

    useEffect(() => {
        if (caret.current === null || !inputRef.current) return;
        inputRef.current.setSelectionRange(caret.current, caret.current);
        caret.current = null;
    }, [value]);

    const syncScroll = () => {
        const input = inputRef.current;
        if (!input) return;
        if (gutterRef.current) gutterRef.current.scrollTop = input.scrollTop;
        if (highlightRef.current) {
            highlightRef.current.scrollTop = input.scrollTop;
            highlightRef.current.scrollLeft = input.scrollLeft;
        }
    };

    const keepIndent = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
        if (event.nativeEvent.isComposing) return;
        const input = event.currentTarget;
        const { selectionStart, selectionEnd } = input;
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const indent = /^[ \t]*/.exec(value.slice(lineStart, selectionStart))![0];
        event.preventDefault();
        // insertText goes through the browser's own editing, so undo still steps back over it and
        // over everything typed before; only where it is refused does the value get replaced.
        if (document.execCommand('insertText', false, `\n${indent}`)) return;
        caret.current = selectionStart + 1 + indent.length;
        onChange(`${value.slice(0, selectionStart)}\n${indent}${value.slice(selectionEnd)}`);
    };

    const lineNumbers = Array.from({ length: value.split('\n').length }, (_, index) => String(index + 1));
    // Each token keyed by where it starts in the text, which no two tokens share.
    let offset = 0;
    const tokens = tokenizeJson(value).map((token) => {
        const start = offset;
        offset += token.text.length;
        return { ...token, start };
    });

    return (
        <div className="json-editor">
            <div className="json-editor-gutter" ref={gutterRef} aria-hidden="true">
                {lineNumbers.map((line) => (
                    <span key={line}>{line}</span>
                ))}
            </div>
            <div className="json-editor-area">
                <pre className="json-editor-highlight" ref={highlightRef} aria-hidden="true">
                    <code>
                        {tokens.map((token) => (
                            <span key={token.start} className={JSON_TOKEN_CLASS[token.kind]}>
                                {token.text}
                            </span>
                        ))}
                        {/* A trailing newline collapses in a <pre>; the space keeps the textarea's
                            last empty line as tall as the highlight's. */}
                        {'\n '}
                    </code>
                </pre>
                <textarea
                    id={id}
                    ref={inputRef}
                    className="json-editor-input"
                    value={value}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    wrap="off"
                    aria-invalid={invalid ? true : undefined}
                    aria-describedby={describedBy}
                    onChange={(event) => onChange(event.target.value)}
                    onKeyDown={keepIndent}
                    onScroll={syncScroll}
                />
            </div>
        </div>
    );
}
