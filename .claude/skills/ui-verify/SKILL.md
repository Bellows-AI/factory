---
name: ui-verify
description: Verify the Factory Stats dashboard in a real browser with Playwright. Use after any change to web/src, to the /api/stats payload shape, or to core aggregation that panels render — and whenever a change "typechecks and the tests pass" but has never been looked at. Catches blank panels, NaN leaking from a null metric, console errors, and charts that render absurdly at small data volumes. Trigger phrases: "verify the UI", "check it in a browser", "does the dashboard still render", "/ui-verify".
---

# Verify the dashboard in a browser

`npm test` renders the panels with `react-dom/server` — it proves they do not throw. It does not
prove they look right, and several past defects (a scatter filtered down to nothing, a `null`
reaching a chart coordinate as `NaN`) passed types, tests and the fixture while being visibly
broken. This skill closes that gap.

## Run it

```bash
npm run verify:ui                       # all specs, chromium, headless
npx playwright test -g 'custom picker'  # one spec by name
npx playwright test --headed            # watch it drive
npx playwright test --ui                # pick and step through interactively
```

`playwright.config.ts` builds all four packages and serves the built SPA from the API on
127.0.0.1:8123 with `TELEMETRY_SOURCE=postgres` against a seeded `factory_e2e` database, so the
run needs a running timescale but no token, no quota and no network. The server is never reused
between runs — a leftover process would verify stale code, which is the one failure this exists
to catch.

Full-page screenshots land in `artifacts/ui/*.png` (gitignored). **Read them.** A passing
assertion means the DOM was right; the screenshot is the only thing that shows the layout was.
Traces for failures are written next to them and open with
`npx playwright show-trace artifacts/ui/trace/<name>/trace.zip`.

## What the specs assert

- Every range preset re-renders the six headline cards and more than five panels.
- No `NaN`, `undefined`, `Infinity` or `[object Object]` anywhere in `main` — that is what a
  missing null guard looks like on screen, and it is invisible to `tsc`.
- No console errors, page errors or failed requests during the whole walk.
- A narrowed range changes the headline numbers *and* states its scope, and degrades the revert
  rate to "unavailable" rather than showing a full-window figure beside range-scoped metrics.
- The custom picker sends both bounds, widens an inclusive day into the exclusive `to`, and
  sends nothing at all while it has no date yet.
- The sparsest range (one merged PR) renders empty rather than broken.

## Extending it

Specs live in `e2e/`. `vitest.config.ts` lists its includes explicitly, so nothing in `e2e/`
leaks into `npm test` — keep it that way; the default suite must stay offline and browser-free.

Two things to know before adding assertions:

- **`.cards` is not unique.** The headline cards and the AI usage panel both use it. Scope to
  `.cards` `.first()`, as `headlineCards()` does.
- **A preset that resolves to the query already on screen does not refetch.** `useStats` keys on
  the query string, so clicking the active preset — or "Custom" before a date is entered — fires
  no request. Waiting on a response there hangs until the timeout.

Prefer asserting on what a reader would notice (a number changed, a caveat is present, a panel is
not empty) over asserting on markup. When a defect is found: reproduce it with a failing
assertion here first, then fix it.
