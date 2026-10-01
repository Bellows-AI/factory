# G6 · Component-state specimen (issue #275)

The reference sheet R2–R7 match (IMPLEMENTATION-PLAN §1.7, FINAL-REPORT H1): every shared primitive in every state
it has, rendered from `web/src/styles.css` and the real components (`Icon`, `PageHeader`, `OrgSelector`).

## What is here

`specimen-{dark,light}-{1440,390}.png`, full page. Rows are the primitives; columns are Default, Selected, Invalid,
Disabled, Busy and Long content (a 60-character unbroken label). A dash means the primitive has no such state. At
390 the grid reflows to one block per primitive, each state labelled, dashes dropped. The "Selector (open)" row is
shot with its listbox open.

Hover and focus-visible are not on these sheets — nothing on the page fakes them. The spec reaches them with the
pointer and the Tab key and writes element shots to `artifacts/ui/specimen-states/`
(`<primitive>-{hover,focus}-<theme>-<width>.png`), which are not committed.

## How they are produced

```bash
npx playwright test --project specimen   # boots every webServer, so the e2e databases must exist
cp artifacts/ui/specimen-{dark,light}-{1440,390}.png docs/plans/bellows-redesign-2026-09-26/specimen/
```

The page is `e2e/specimen/main.tsx` on a test-only Vite server at `E2E_PORT_BASE + 3` (default 8126). It is served,
never built, so nothing reaches `web/dist`. `npx vite --config e2e/specimen/vite.config.ts` serves it for a look by
hand. Re-shoot and re-commit the four sheets when a shared primitive changes.

## Gaps the sheets show

These are not specimen bugs. The §1.5 rule for each has not landed in `styles.css` yet:

- **Table row, hover and selected:** there is no row-hover fill and no selected-row outline. The selected row is
  marked `aria-current` and looks like the default.
- **Disclosure:** no `Icon` chevron rotates on `[open]`. The browser's native marker shows.
- **Selector chevron:** still the `::after ▾` glyph, not `Icon chevron-down`.
- **Long content:** a primitive that cannot wrap is cut off at its cell edge. Buttons, the checkbox label, pills,
  the chip, banner titles, `kbd` and the disclosure summary all run past it.
