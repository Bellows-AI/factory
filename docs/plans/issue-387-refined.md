## Problem

In Settings → Executors → Add/Edit executor → Advanced configuration, the caret does not reliably
land on the visible character clicked in Configuration JSON. This makes selection and edits feel
unpredictable.

## Reproduction and cause

1. Open Advanced configuration and enter a multiline JSON object with a long string value.
2. Click the start of a displayed character, including characters farther along the line.
3. Type or select text; the native insertion/selection position differs from the painted text.

Playwright reproduced this before the fix: clicking the first painted character expected
`selectionStart = 0` but returned `1`.

`JsonEditor.tsx` overlays a transparent textarea on highlighted text inside `<pre><code>`.
The shared inline-code primitive gives `<code>` a `0.92em` font and `1px 4px` padding, while the
textarea uses the full inherited font without that inset. The visible text and native hit testing
therefore use different geometry; the discrepancy grows along the line.

## Resolution

Reset the highlighted code element's font to inherit, remove its inline-code padding, background
and radius, and preserve the textarea's native editing behavior. Keep the shared inline-code
primitive intact for its other callers.

Add repeatable browser regressions that click actual painted glyph coordinates and assert the
native caret/selection and resulting text. Repair the disposable E2E reset's foreign-key handling
so the suite can rerun after the artifact-table migration, and update the existing executor test's
stale default-caption assertion.

## Acceptance criteria

- Painted text and textarea font metrics match; clicks land on the expected character across
  tokens, lines and both scroll axes.
- Drag/double-click selection, replacement, arrows, deletion, Enter indentation, undo/redo and
  clipboard paste preserve text and selection.
- Empty drafts, trailing newlines, tabs and Unicode remain editable and lossless.
- Formatting and switching agent drafts keep highlight/gutter scrolling aligned.
- Tab exits normally; composing Enter is not intercepted; forced colors show one readable layer.
- Deterministic gremlins verify the text after every edit, covering both themes at 1440px and 390px.

## Local verification (2026-10-02)

- `e2e/json-editor.spec.ts`: 32 Chromium tests passed, including 312 randomized edits, seed 387.
- Existing signed-in guided setup and advanced save/recovery tests: 2 passed.
- Focused executor/editor/style unit suites: 94 tests passed.
- Full build, typecheck and repository lint passed; desktop/phone screenshots inspected.

Evidence: `artifacts/ui/json-editor/` contains the reproduction log, passing browser log and
screenshots. Real OS IME sessions, touch gestures, Firefox and WebKit were not exercised; the
composition test checks the browser event guard.

The implementation and tests are prepared for review. Keep the issue open until the fix is merged.
