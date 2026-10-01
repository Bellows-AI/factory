# [UI] Slice B — Make the dashboard answer usage questions quickly

## Issue metadata

- **Type:** Feature / dashboard information design
- **Priority:** P1
- **Size:** Large; land as the ordered PR sequence at the end of this issue
- **Areas:** Core telemetry contract, web dashboard, charts, shared tables, responsive layout,
  accessibility, tests, visual regression, documentation
- **Depends on:** Slice A — Navigation and hierarchy
- **Blocks:** Slice E's final visual, contrast, focus-state, and theme audit

## Summary

Recompose the dashboard into a compact decision surface. A member should be able to identify the
selected data set, session volume, token use, effectiveness, an outlier, and the freshest completed
task without reading long explanations or scanning a 2,400px page.

This slice adds a labeled analytics toolbar, a hierarchical metric summary, an interactive and
accessible usage chart, concise sortable tables, a bounded recent-tasks section, and one coherent
state model for loading, empty, stale, and independently degraded data.

This is not a new analytics product. Use the measurements and range semantics that already exist.
Do not invent trend data, costs, repository filters, or comparisons that the server cannot support.

## Baseline and dependency assumptions

Implement this issue after Slice A. Rebase the file list below onto Slice A's final names rather
than recreating superseded shell work.

Slice B assumes Slice A has already delivered:

- `PageHeader` and a dashboard page title of **Usage overview**;
- dashboard-local repository coverage, last-successful-fetch metadata, and Refresh action;
- `/tasks` as the task inbox, `/tasks/new` as the composer, and `/tasks/:id` as task detail;
- responsive application navigation at 360px, 768px, 1024px, and 1440px;
- global control sizing and base `:focus-visible` treatment.

Slice B owns the controls and content below the dashboard page header. It may tighten the header's
timestamp presentation, but it must not reopen application-shell, navigation, or task-inbox work.

## Problem statement

### The selected data set is difficult to read

Range and scope are unlabeled segmented controls. Custom dates expand the page inline. Repository
coverage lives elsewhere, and the page does not summarize the actual range, scope, and repository
set represented by the currently rendered payload.

Because `useStats` intentionally keeps the last successful payload during a new request or error,
the requested controls can temporarily differ from the data on screen. A redesign that describes
only the requested values would make stale-but-valid figures look current for the wrong range.

### Equal cards hide the decisions behind the numbers

The five existing measures have identical visual weight. Input and output tokens are separated even
though they form one usage decision, cache context is relegated to notes, and edit acceptance has no
visible measured-decision denominator. An empty store becomes five cards of dashes.

### The chart explains itself before showing the data

The usage panel leads with a long paragraph. Its dual axis is not explicit enough, partial buckets
are only described in prose, the legend is not interactive, and there is no hover or keyboard path
to exact bucket values. A single bucket sits in a full-size chart.

### Supporting analytics are verbose and inconsistent

Per-task usage uses cards, while usage by user and recently completed tasks hand-roll separate table
markup. The existing shared `DataTable` is unused and its clickable `<th>` sorting is not keyboard
accessible. Recently completed fetches and renders up to 30 rows, which dominates the page and
blurs the boundary between telemetry and task-board data.

## Goals

1. Make the exact rendered range, scope, and repository coverage readable in one place.
2. Keep range changes compact and commit custom dates atomically from a popover.
3. Preserve five measures while making Sessions and Token usage the leading decisions.
4. Put numeric denominators and short caveats beside the values they qualify.
5. Make the token/session chart understandable from its marks, labels, caption, and controls.
6. Make exact chart values available by pointer and keyboard without requiring color perception.
7. Use one accessible, sortable table primitive for per-task, per-user, and recent-task data.
8. Bound recently completed work to eight tasks and link to the complete task inbox.
9. Preserve usable last-good telemetry and board data when either source fails independently.
10. Keep primary dashboard content within the first viewport where practical and prevent page-level
    horizontal overflow at 360px, 768px, 1024px, and 1440px.

## Non-goals

- Do not add per-repository analytics filtering. `repoFilter` describes the configured coverage; it
  is not a request parameter. Repository selection remains a Settings concern.
- Do not add prior-period deltas. There is no comparable-window payload, and All time or partially
  bounded custom ranges cannot produce an honest comparison by client-side arithmetic.
- Do not add cost estimates, forecasts, goals, anomaly scoring, or additional charts.
- Do not change the ≤92-day daily / >92-day weekly bucketing rule.
- Do not change rolling range semantics, session-overlap filtering, task run filtering, or the
  exclusive custom `to` bound.
- Do not combine cache reads with input/output tokens into a single usage total.
- Do not move completed tasks into `/api/stats` or filter them by analytics range/scope.
- Do not redesign the task inbox, task composer, task detail, settings, onboarding, or app shell.
- Do not add a theme switch or decorative animation.
- Do not keep old dashboard component or payload shapes as aliases. Update callers and delete the
  replaced path in the same change.

## Product and measurement constraints to preserve

- Telemetry and task-board data are independent. `RecentTasksPanel` remains mounted when stats are
  cold or unavailable, and a board failure must not remove telemetry.
- A failed stats refresh preserves the last successful payload. UI copy must identify that payload,
  not imply the newly requested filters already apply.
- `meta.range` and `meta.scope` are the authority for figures already on screen. Component state is
  only the requested next selection.
- Presets are rolling lookbacks. Use truthful labels: **Today**, **7 days**, **14 days**, **30 days**,
  **All time**, and **Custom**.
- The server's custom `to` is exclusive. Human copy presents the inclusive calendar end selected by
  the member.
- Daily and weekly series keep quiet buckets. Never close gaps or remove the partial current bucket.
- Input + output is the only valid combined token total. Cache read and cache creation remain
  separate detail because cached context would otherwise be counted again.
- Null means unmeasured and renders as an em dash. A measured zero renders as `0`.
- **Runs per task** and **agent turns per task** remain distinct terms and distributions.
- Every percentile remains accompanied by its measured-task count.
- Synthetic fixture telemetry keeps a prominent badge wherever the metric summary is introduced.
- `AUTH_MODE=none` has no personal scope. Do not render a dead **Me** control.
- The completed-task list remains one row per task/thread, newest completion first. Context and task
  wall clock keep their current null-not-zero semantics.

## Target page structure

Render the dashboard in this order:

1. Slice A `PageHeader`: **Usage overview**, exact repository context, relative last update, Refresh.
2. Analytics toolbar: Range, Scope, Repository coverage, and a plain-language rendered-data summary.
3. One page-level loading/refresh/error/stale status region.
4. Metric summary.
5. AI token usage chart.
6. Supporting analytics grid: Per-task usage and Usage by user.
7. Separate **Task board** section containing Recently completed and **View all tasks**.

Do not wrap the whole page in one panel. Headings and spacing define sections; panels are reserved for
content that benefits from a bounded surface.

At desktop widths, Sessions and Token usage must be visible before Active time and Edit acceptance.
At narrow widths, DOM order remains the same and every group stacks without reordering content for
presentation.

## 1. Analytics toolbar

Add a dashboard-specific toolbar with three visibly labeled groups.

### Range

- Render common presets as a segmented radio group.
- Label the group **Range** with a real `<fieldset>` / `<legend>` or an equivalent accessible group.
- Selecting a common preset commits immediately.
- **Custom** opens a Headless UI popover; it does not expand the toolbar inline.
- The popover holds draft `from` and `to` values. Opening, typing, cancelling, clicking outside, or
  pressing Escape must not issue a stats request.
- **Apply range** commits both draft values once. Permit either bound on its own because the API
  supports half-open custom ranges. Disable Apply only when both fields are empty or the bounds are
  invalid.
- Keep `from <= to <= today` through input bounds and explicit validation. Do not silently swap dates.
- **Clear** returns to All time and closes the popover.
- Reopening the popover starts from the last committed custom values, not an abandoned draft.
- The trigger uses `aria-expanded`, restores focus on close, and is fully operable by keyboard.

`rangeQuery()` and `statsQuery()` remain pure and keep their existing request semantics. The popover
changes when state is committed, not how a committed range is encoded.

### Scope

- Label the group **Scope**.
- In GitHub mode, retain the **Org** / **Me** radio group.
- In open mode, render a non-interactive value **Organization** so the selected scope remains visible;
  do not render or disable a **Me** option that can never work.
- When `meta.scope === 'mine'`, include `meta.scopeLogin` in accessible summary text when available.

### Repository coverage

- Label the group **Repositories**.
- This is read-only coverage, not a filter. Render **No repositories configured**, one exact repo,
  or **N tracked repositories**.
- Keep exact repository names visibly available in the Slice A page-header description or an inline
  disclosure. Do not hide critical coverage solely in a tooltip.
- Do not add a picker, query parameter, or local selection state in this slice.

### Rendered-data summary

Below the groups, render one compact sentence based on the successful payload, for example:

> Sep 13–19 · Organization · 1 repository

Rules:

- Derive the date window from `data.meta.range`, scope from `data.meta.scope`, and coverage from
  `data.meta.telemetry.repoFilter`.
- Format dates in UTC so the sentence agrees with UTC chart buckets.
- Render open custom bounds as **Since Sep 13** or **Through Sep 19**; render unbounded as **All time**.
- Use singular/plural repository grammar.
- If requested range/scope differs from `data.meta`, keep describing the visible payload and append
  **Updating to …**. If that request fails, the error state must say the last successful selection
  remains visible.
- Mark the summary as a polite live region, but do not announce every date-field keystroke.

Put comparison and formatting logic in pure helpers with frozen-time tests. Do not duplicate
exclusive-end or UTC normalization inside JSX.

## 2. Last updated and Refresh

Keep these in Slice A's dashboard page header and render them as one action cluster:

- Relative copy first: **Updated just now**, **Updated 4 min ago**, **Updated 2 hr ago**.
- Use `data.meta.fetchedAt`, the last successful stats response, not the current wall clock or the
  telemetry store's inner timestamp.
- Make the precise localized timestamp available on pointer hover and keyboard focus, and expose it
  through `<time dateTime>` for assistive technology.
- The precise value cannot exist only in a native `title`; use a small tooltip or described text that
  appears on both hover and focus.
- Refresh stays disabled and reads **Refreshing…** while in flight.
- With no successful payload, render **Not updated yet**.
- Relative text may update once per minute. Do not start one timer per table row; share the page's
  current-time tick or refresh relative task labels from their existing 30-second poll.

## 3. Metric summary

Keep five measures in four visual groups:

1. **Sessions** — leading measure.
2. **Token usage** — leading group containing separate **Input** and **Output** measures.
3. **Active time** — supporting effectiveness measure.
4. **Edit acceptance** — supporting effectiveness measure.

The token group may span more grid space, but Input and Output remain individually labeled and must
not be summed into the displayed value. Directly below them show Cache read and Cache write values.

Required supporting copy:

| Measure | Supporting line |
| --- | --- |
| Sessions | Selected range and rendered scope; do not repeat repository names here. |
| Input | `N read from cache`; cache read remains separate from input. |
| Output | `N written to cache`; use the payload's `cacheCreation` measurement. |
| Active time | `Across N sessions · idle time excluded`. |
| Edit acceptance | `A of D measured edit decisions accepted`; if partially/unmeasured, say so instead of fabricating a denominator. |

Do not add trend arrows or comparison colors. Reserve layout space for values, not hypothetical
future deltas.

### Empty summary behavior

Never render five dashes as the empty state.

- If there are no telemetry sessions and no task distribution has measured rows, replace all four
  telemetry sections with one analytics empty state.
- If task distributions contain measurements but telemetry sessions are empty, render one compact
  summary empty state, omit the empty usage chart and user table, and still render Per-task usage.
- If sessions exist but one measure is unavailable, retain the summary and render only that measure
  as an em dash with a short **Not measured** note.
- A measured zero remains a real value.

The whole-analytics empty state names the rendered selection and gives one appropriate next action:
broaden the range when coverage exists outside it, or run an agent session when the store is empty.
Do not guess configuration health from a zero result.

## 4. Edit-acceptance payload contract

The current payload exposes only `acceptRatio`, so the UI cannot show the measured denominator. Make
one clean core contract change and update all callers; do not preserve `acceptRatio` as an alias.

Replace:

```ts
acceptRatio: number | null;
```

with:

```ts
editAcceptance: {
    accepted: number | null;
    rejected: number | null;
    decisions: number | null;
    ratio: number | null;
};
```

Aggregation rules:

- Reuse the existing null-aware `sum()` for accepted, rejected, and decisions.
- `decisions` is the null-aware sum of accepted + rejected, never a client-derived guess.
- Keep the existing ratio rule. If the numerator was not measured, ratio remains null even when a
  rejected measurement exists.
- `0` accepted out of `0` measured decisions remains distinguishable from wholly unmeasured input.
- Keep ratio bounded to `[0, 1]` and keep the no-NaN invariant.

This is an aggregation output change only. Do not change telemetry ingestion, storage, caching,
range filtering, or the `/api/stats` route shape outside this nested total.

Update `docs/metrics.md` and the `GET /api/stats` contract in `docs/api.md` in the same PR.

## 5. Usage chart

### Content order

The section order is:

1. Heading and synthetic-fixture badge when applicable.
2. Interactive legend.
3. Chart.
4. One-line caption.
5. `<details>` disclosure with summary **How this is calculated**.

Do not render a paragraph before the chart.

Caption examples:

- Daily: **Input and output tokens by day; sessions use the right axis.**
- Weekly: **Input and output tokens by ISO week; sessions use the right axis.**

The disclosure explains, in concise prose:

- stacked Input/Output bars use the left **Tokens** axis;
- the Sessions line uses the right **Sessions** axis;
- cache reads/writes are excluded from bars;
- quiet buckets are retained;
- daily buckets are used through 92 days and weekly after that;
- the marked current day/week is partial.

### Series toggles

- Replace decorative legend swatches with buttons for **Input**, **Output**, and **Sessions**.
- Each button uses `aria-pressed` and a visible mark plus text; color is not the only series cue.
- Toggling a bar series recomputes the visible left-axis scale. Toggling Sessions removes its line
  and right axis.
- An all-hidden state is allowed but must render **All series hidden** instead of a broken chart.
- Do not mutate the payload or lose the raw values used by tooltips when a series is hidden.

### Exact bucket detail

Pointer hover and keyboard focus expose:

- the full bucket date/range;
- whether the bucket is partial;
- exact, un-abbreviated Input, Output, and Sessions values;
- which series are currently hidden.

Implement one roving tab stop over bucket hit regions. Left/Right moves one bucket; Home/End moves
to the first/last bucket. Pointer movement updates the same active-bucket model. The visible tooltip
is referenced by the active target's `aria-describedby`, and each target has a complete `aria-label`.
Do not add up to 92 independent stops to the page's tab order.

### Partial bucket

- Pass `TelemetryPoint.partial` into the chart; it is currently discarded.
- Distinguish partial bars with a non-color treatment such as a hatch/outline.
- Add **Partial** to the bucket tooltip and a visible `* Partial period` chart key/caption when one is
  present.
- The series remains visually identifiable in grayscale.

### One-bucket range

For one point, use the same chart semantics in a compact single-bar treatment: reduce the chart's
maximum inline size and height, keep a real bar rather than a filled panel, and keep exact detail.
Do not stretch one bar across a 900px plot. Preserve the existing short-range width tests.

### Chart API direction

Keep `BarChart` generic enough for `Histogram`, but give series stable IDs and labels rather than
encoding meaning only in CSS classes. A suitable contract is:

```ts
interface BarSeries {
    id: string;
    label: string;
    values: readonly number[];
    className: string;
}

interface LineSeries {
    id: string;
    label: string;
    values: readonly (number | null)[];
}

interface BarChartProps {
    ariaLabel: string;
    labels: readonly string[];
    bucketLabels: readonly string[];
    partial: readonly boolean[];
    series: readonly BarSeries[];
    line?: LineSeries;
    hiddenSeries?: ReadonlySet<string>;
    // existing dimensions and label density remain
}
```

The final type may vary, but stable IDs, human labels, partial metadata, and exact bucket access are
required. CSS class names alone are not a data contract.

## 6. Shared sortable table

Replace `DataTable`'s current whole-header click behavior with a reusable accessible contract. It
must support rich cells and computed sort values:

```ts
interface DataTableColumn<T> {
    key: string;
    label: ReactNode;
    cell: (row: T) => ReactNode;
    sortValue?: (row: T) => string | number | null;
    align?: 'start' | 'end';
}

interface DataTableProps<T> {
    labelledBy: string;
    rows: readonly T[];
    columns: readonly DataTableColumn<T>[];
    rowKey: (row: T) => Key;
    initialSort?: { key: string; direction: 'ascending' | 'descending' };
    empty: ReactNode;
}
```

Required behavior:

- A sortable `<th>` contains a real `<button type="button">`; the `<th>` owns `aria-sort` only when
  its column is active.
- First activation uses a column-appropriate default direction; subsequent activation toggles it.
- Nulls always sort last in both directions. Do not reproduce the current `-Infinity` inversion bug.
- Equal values keep original order through an explicit source-index tie-breaker.
- Strings use locale comparison; numbers and timestamps sort numerically.
- Renderers return `ReactNode`; sorting never reads formatted strings such as `1.2M` or `4 min ago`.
- Rows use stable domain keys, never array indices.
- Numeric columns align consistently.
- The wrapper is a labeled, keyboard-focusable horizontal-scroll region. The page itself never
  gains horizontal overflow.
- The active sort indicator uses text/shape as well as color.

Export pure comparison/sort helpers for unit tests. The component owns only sort state and markup.

## 7. Per-task usage table

Replace distribution cards with one `DataTable`.

| Row | Average | Median | P95 | Measured tasks |
| --- | ---: | ---: | ---: | ---: |
| Tokens per task | token formatter | token formatter | token formatter | `tasks` |
| Runs per task | number formatter | number formatter | number formatter | `tasks` |
| Agent turns per task | number formatter | number formatter | number formatter | `tasks` |
| Wall clock per task | duration formatter | duration formatter | duration formatter | `tasks` |

Requirements:

- Use **Median** in the UI while continuing to read the `p50` field.
- Keep all four measured-task counts; the distributions can have different denominators.
- Put the unmeasured-run caveat for agent turns and wall clock in a short disclosure below the
  table, not a paragraph above it.
- Default order is the semantic order above. Sorting is available but not pre-applied.
- If all four counts are zero, render one table-region empty state instead of zero/dash rows.

## 8. Usage-by-user table

Use `DataTable` and derive a view model without changing `TelemetryStats.byUser`.

Columns:

1. **User** — avatar, display name, and login fallback.
2. **Sessions**.
3. **New tokens** — null-aware Input + Output only, with a compact proportional bar in the same
   cell.
4. **Input**.
5. **Output**.
6. **Cache read**.
7. **Cache write**.

Rules:

- Default sort is New tokens descending.
- The proportional bar compares New tokens with the largest measured user total in the rendered
  rows. Its accessible name states the exact total; width is decorative and hidden from assistive
  technology.
- Do not include cache values in New tokens.
- If both Input and Output are null, New tokens is null and sorts last. If either is measured, use
  the same null-aware partial-total rule as core rather than converting every null to zero.
- Preserve the explicit **No attributed sessions…** state when telemetry exists but no user can be
  resolved.

## 9. Recently completed task-board section

This section is board data, not telemetry.

- Add a visible **Task board** section label or heading above it.
- Replace the long explanation with one sentence: **Latest finished tasks from the board; analytics
  range and scope do not filter this list.**
- Change `useCompletedJobs`'s request limit from 30 to 8. The server already returns newest completed
  tasks and groups follow-ups into one task row; do not fetch 30 and slice in JSX.
- Use the root command's first non-empty line as the task title, truncated visually after two lines.
  The agent's closing summary is outcome text, not task identity.
- Link each title to `/tasks/:id`.
- Use a shared relative-time formatter/component for completion time, with the precise timestamp
  available on hover/focus.
- Keep Status, Author, Context, Wall clock, and Finished. Sorting is available; initial order remains
  the server's newest-first order.
- Add **View all tasks** linking to `/tasks` after the table.
- Preserve `taskWallClockMs` and `contextTokens` null-as-unmeasured rendering.
- When a board poll fails after a successful response, show a compact alert and keep the last good
  rows visible. With no successful response, show the board error in place.
- Keep this component outside the stats-data branch in `DashboardPage`.

## 10. Shared state model

| State | Analytics behavior | Recently completed behavior |
| --- | --- | --- |
| Initial loading | One loading status; no zero/dash cards | Own loading sentence |
| Refreshing same selection | Keep data visible; Refresh says Refreshing… | Unchanged |
| Changing range/scope | Keep old data and label it; show Updating to… | Unchanged and explicitly unfiltered |
| Stats error, no data | One actionable error region; no metric shells | Continues independently |
| Stats error, last-good data | Keep data; banner names stale/last successful selection | Continues independently |
| Empty analytics selection | One coherent analytics empty state | Continues independently |
| Telemetry disabled | Omit telemetry analytics as today | Continues independently |
| Synthetic fixture | Show prominent synthetic badge | No synthetic label |
| Board loading/error/empty | Analytics unaffected | Local loading/error/empty state |
| Board error with last-good rows | Analytics unaffected | Alert plus retained rows |

Status copy must be visible text, not color alone. Avoid skeletons that resemble invented values.

## Implementation instructions by file

### Core telemetry contract

#### `core/src/types.ts`

- Replace `totals.acceptRatio` with the `editAcceptance` object defined above.
- Keep token and series contracts unchanged.

#### `core/src/telemetry.ts`

- Return accepted, rejected, decisions, and ratio from values already computed at read time.
- Preserve all null/zero and ratio invariants.

#### `core/test/telemetry.stats.test.ts`

- Assert every field against independently computed fixture totals.
- Add wholly unmeasured, partially measured, measured zero/zero, and mixed accepted/rejected cases.
- Keep bounds and no-NaN assertions on `editAcceptance.ratio`.

#### `core/test/telemetry.independent.test.ts` and affected fixtures

- Update direct field reads and exact-object assertions.
- Do not make the independent test call the production aggregation helper to compute expectations.

#### `docs/metrics.md` and `docs/api.md`

- Document the new nested total and denominator/null behavior.
- State that no comparable-window/delta contract exists.

Build core before diagnosing server or web type errors:

```bash
npm run build -w core
```

### Dashboard state and formatting

#### `web/src/components/AppShell.tsx`

- Keep one stats polling chain.
- Publish whatever loading/refreshing state `DashboardPage` needs; do not create a second `useStats`.
- Preserve range and scope across each other's changes.

#### `web/src/format.ts`

- Add pure helpers for exact integer values, relative time, precise timestamp text, UTC range text,
  and nullable Input + Output totals.
- Accept an injectable `now` in time helpers.
- Keep `taskTime()` for machine-like task detail if it remains used; do not silently change unrelated
  pages to relative time.

#### Dashboard selection helper (new root helper or colocated pure module)

- Normalize requested `RangeSelection` against returned `DateRange` for mismatch detection.
- Convert the returned exclusive custom `to` into an inclusive display date.
- Build the rendered-data summary from payload meta, never from request state alone.
- Keep helpers outside component files when they need direct unit coverage.

### Toolbar and header

#### `web/src/components/RangeSelector.tsx`

- Change preset copy to rolling-window labels.
- Move custom dates into a controlled-draft Headless UI popover with Apply/Clear/Cancel behavior.
- Keep `rangeQuery()` and `statsQuery()` exported and pure.

#### `web/src/components/ScopeToggle.tsx`

- Keep the GitHub-mode radio behavior and make the labeled group usable inside the toolbar.
- Do not add open-mode behavior here if the toolbar can render its read-only scope itself.

#### `web/src/components/AnalyticsToolbar.tsx` (new)

- Compose labeled range, scope, and repository groups.
- Render payload-based summary and request/payload mismatch state.
- Do not fetch or own stats request state.

#### Slice A dashboard header component / `web/src/pages/DashboardPage.tsx`

- Render the shared relative/precise timestamp beside Refresh.
- Keep exact repository coverage without duplicating long names in every metric note.

### Metric and panel components

#### `web/src/panels/AiUsagePanel.tsx`

- Rename to `UsageSummaryPanel.tsx` and delete the old import/path in the same change.
- Render four groups/five measures and the summary-level synthetic fixture badge.
- Read the new edit-acceptance object.
- Render the local partial-measurement state; do not own whole-dashboard emptiness.

#### `web/src/panels/TelemetryFrame.tsx`

- Remove the mandatory before-content `blurb` shape.
- Keep heading, synthetic badge, broken-state behavior, and content slots.
- Let each panel place chart/table first and caption/disclosure afterward.
- Do not make it know range, scope, or dashboard page state.

#### `web/src/panels/TokenUsagePanel.tsx`

- Own legend visibility state and content ordering.
- Pass stable series IDs, full labels, partial flags, and raw values to `BarChart`.
- Select compact dimensions for a single bucket.
- Add the caption and calculation disclosure.

#### `web/src/panels/TaskUsagePanel.tsx`

- Replace cards with a table view model and `DataTable`.
- Use exact terminology and format values by row.

#### `web/src/panels/ByUserPanel.tsx`

- Replace hand-written table markup with `DataTable`.
- Add New tokens and its proportional bar without including cache.

#### `web/src/panels/RecentTasksPanel.tsx`

- Replace hand-written markup with `DataTable`.
- Use command-derived titles, task-detail links, relative completion time, bounded copy, and retained
  last-good rows during a local error.

#### `web/src/pages/DashboardPage.tsx`

- Compose the target page order.
- Decide whole-analytics versus partial empty states once, above the panels.
- Keep `RecentTasksPanel` outside the stats branch.
- Keep one `<h1>` from `PageHeader`; section headings start at `<h2>`.

### Shared table and chart

#### `web/src/components/DataTable.tsx`

- Implement the contract and sorting/accessibility rules above.
- Delete the old `sortable` boolean and `keyof T` formatter API once callers migrate.

#### `web/src/charts/BarChart.tsx`

- Add stable labeled series, visibility, partial styling, exact-detail state, and roving keyboard
  navigation.
- Preserve responsive SVG scaling and short-range bar-width behavior.

#### `web/src/charts/Axes.tsx`

- Label the left axis **Tokens** and the right axis **Sessions** when present.
- Ensure axis labels remain legible and do not rely only on series colors.

#### `web/src/api/useCompletedJobs.ts`

- Change the server limit to 8.
- Keep one abortable 30-second chain, hidden-tab slowdown, 401 handling, and last-good state.
- Continue returning both `jobs` and `error` so the panel can show stale rows with an alert.

### Styling and design-system documentation

#### `web/src/styles.css`

Add or revise primitives for:

- analytics toolbar, labeled groups, popover, and rendered-data summary;
- metric hierarchy and grouped token values;
- interactive legend buttons and pressed/focus states;
- chart tooltip, bucket hit region, partial hatch/outline, and compact one-bucket layout;
- table header buttons, sort indicator, numeric alignment, focusable scroll region;
- proportional usage bars;
- analytics and board empty/degraded states;
- supporting analytics grid and bounded task-title cells.

Use existing tokens only. Introduce a token only when no semantic token can express the role, and use
it in both theme blocks. Do not add raw color literals outside token blocks. Prefer spacing,
background shifts, and typography over additional borders.

#### `docs/design-system.md`

- Document every new/renamed class and component/panel inventory row in the same PR.
- Remove rows for deleted paths/classes such as `AiUsagePanel` or obsolete card hooks.
- If `Card.tsx` becomes unused after both dashboard card migrations, delete it and its inventory row;
  do not retain an unused primitive for hypothetical future use.

## Accessibility requirements

- Exactly one page `<h1>`; analytics and Task board sections use ordered headings.
- Range and Scope expose group names. Repository coverage is readable text, not a disabled control.
- Custom range popover has focus management, Escape/outside dismissal, explicit validation, and no
  background interaction trap.
- Relative times use `<time dateTime>` and precise hover/focus content.
- Legend buttons use `aria-pressed`; visible series remain distinguishable in grayscale.
- The chart has an accessible name, explicit axis labels, roving bucket focus, arrow-key navigation,
  and exact text alternatives.
- Partial state is conveyed by words and shape/pattern, not color alone.
- Sort controls are real buttons; `aria-sort` follows the active column.
- Scrollable tables are labeled and keyboard focusable, with visible focus treatment.
- Status, empty, stale, synthetic, and error meaning is not communicated by color alone.
- Dynamic filter/refresh status uses a polite live region and avoids duplicate announcements.
- Touch targets are at least 44px where toolbar or legend controls are expected on mobile.
- No new motion is required. Any tooltip transition respects `prefers-reduced-motion`.

## Responsive acceptance matrix

| Width | Required behavior |
| --- | --- |
| 360px | Toolbar groups stack; presets wrap; custom popover stays inside viewport and date fields stack; metric groups are one column; chart and tables do not widen the page; View all tasks remains visible. |
| 768px | Toolbar wraps as labeled groups; summary uses up to two columns; chart uses full available width; supporting tables remain one column with contained horizontal scroll. |
| 1024px | Leading metrics keep priority; chart labels and tooltip fit without clipping; supporting grid uses one or two columns only when each table remains readable. |
| 1440px | Sessions and Token usage lead; supporting analytics may share a row; recent tasks remains eight rows; explanatory prose does not dominate page height. |

At every width:

- the dashboard's primary content begins within the first viewport;
- the body has no horizontal scrollbar;
- only table/chart regions may scroll or clip intentionally;
- focus order follows DOM order;
- open popovers/tooltips remain within the viewport.

## Test plan

### Core tests

Update and run:

- `core/test/telemetry.stats.test.ts`;
- `core/test/telemetry.independent.test.ts`;
- any range/scope fixture assertions that compare full totals.

Pin accepted, rejected, decisions, ratio, null, zero, partial-measurement, and no-NaN behavior.

### Web unit/render tests

#### Range and selection

- Update `web/test/range-selector.test.tsx` for rolling labels and popover markup.
- Test pure draft/commit helpers: Cancel issues no change; Apply commits once; Clear selects All time;
  invalid crossed dates cannot apply; one-sided bounds remain valid.
- Test UTC/inclusive summary text for presets, bounded custom, one-sided custom, and All time.
- Test requested-versus-rendered mismatch copy.

#### Metric and state rendering

- Update `web/test/panels.render.test.tsx` for four groups/five measures.
- Assert numeric edit-decision denominator copy.
- Assert one coherent full empty state and the task-measurements-without-telemetry partial state.
- Keep tests for null-not-zero, synthetic fixture, unreachable reason, daily/weekly wording, task
  distribution names/counts, and no PR vocabulary.

#### Table

- Add `web/test/data-table.test.tsx` or a pure sorter suite.
- Cover string/number/date sorting, both directions, nulls always last, stable ties, default sort,
  rich-cell rendering, stable row keys, button headers, and `aria-sort` markup.
- Assert per-task and per-user view models sort by raw values, not formatted strings.

#### Chart

- Extend `web/test/bar-chart.test.tsx` for single-bucket compact dimensions, visible partial marker,
  axis labels, stable series IDs, hidden series, and all-hidden state.
- Unit-test the roving-index reducer for Left/Right/Home/End bounds.
- Render-test full exact bucket labels and partial copy.
- Preserve the existing near-full short bands, single-bar cap, dense-range width, and 92-point label
  density tests.

#### Recently completed

- Update `web/test/recent-tasks.render.test.tsx` for command-derived linked titles, eight-row maximum,
  relative + exact time, View all tasks, and alert-plus-last-good rows.
- Keep thread wall-clock, command fallback, null-as-dash, empty, and cold-error assertions.
- Add a hook test or request assertion that the endpoint uses `limit=8`.

#### Design system

- Update `web/test/styles.test.ts` inventory expectations.
- Keep the no-color-literal, every-token-used, and every-class-documented gates green.

### Browser and visual verification

Extend `e2e/dashboard.spec.ts`; do not add a production-only test route.

Use the existing seeded database plus Playwright request interception where a transient state is
needed:

- populated dashboard at 1440px;
- sparse/one-bucket range;
- custom-range popover open and applied;
- initial loading by delaying `/api/stats`;
- refreshing in flight after a successful payload;
- error with stale data by failing a subsequent request;
- empty analytics range;
- board error while telemetry remains visible;
- 360px and 768px toolbar/chart/table layouts.

Interaction assertions:

- preset and scope changes update the request and later the rendered-data summary;
- custom draft/cancel causes no stats request; Apply causes one;
- legend toggles update chart visibility and `aria-pressed`;
- Tab enters the chart once and arrow keys change bucket detail;
- sorting works by keyboard and updates `aria-sort`;
- a recent task opens `/tasks/:id`; View all tasks opens `/tasks`;
- body `scrollWidth <= clientWidth` at every target width;
- the primary content begins in the first viewport.

Read every generated image in `artifacts/ui/`; passing DOM assertions do not verify hierarchy,
clipping, tooltip placement, or table overflow.

## Acceptance criteria

### Toolbar and freshness

- [ ] Range, Scope, and Repositories are visibly labeled in one compact toolbar.
- [ ] Custom dates live in a popover and commit once through Apply.
- [ ] Rendered-data summary describes payload meta, including during a pending or failed filter change.
- [ ] Repository coverage is clearly read-only and exact names remain visibly available.
- [ ] Last updated is relative first and reveals a precise timestamp on hover and focus.
- [ ] Refresh stays beside freshness metadata and reports its in-flight state.

### Summary and chart

- [ ] Sessions and Token usage are the leading measures.
- [ ] Input/Output are grouped but remain separate; cache read/write remain separate detail.
- [ ] Active time and acceptance show short caveats and real denominators.
- [ ] No-data summary is one state, not five dash cards.
- [ ] Chart appears before its caption/explanation.
- [ ] Both axes are named; partial bucket is visibly and textually marked.
- [ ] Input, Output, and Sessions can be toggled from accessible legend buttons.
- [ ] Pointer and keyboard users can inspect exact bucket values.
- [ ] A one-bucket range renders as a compact chart treatment.

### Supporting analytics and board data

- [ ] Per-task usage is a four-row Average/Median/P95/Measured tasks table.
- [ ] Usage by user sorts by New tokens and shows a proportional bar without counting cache.
- [ ] All sortable headers are keyboard buttons with correct `aria-sort`.
- [ ] Nulls sort last, formatted strings do not drive sorting, and rows have stable keys.
- [ ] Recently completed requests and renders at most eight task rows.
- [ ] Recent titles are meaningful task titles linked to task detail; finish time is relative.
- [ ] View all tasks links to `/tasks`.
- [ ] Recent board data remains independent of analytics filters and failures.

### States, responsive behavior, and quality

- [ ] Loading, empty, stale-with-data, cold error, refreshing, telemetry-disabled, synthetic, and
  board-only failure states are explicit and coherent.
- [ ] Last-good telemetry and board rows remain visible with their respective error notices.
- [ ] No page-level horizontal overflow at 360px, 768px, 1024px, or 1440px.
- [ ] Focus order, focus visibility, touch targets, chart navigation, and popover behavior meet the
  accessibility requirements above.
- [ ] `docs/design-system.md`, `docs/metrics.md`, and `docs/api.md` match the shipped implementation.
- [ ] No obsolete dashboard component, payload alias, CSS class, or unused Card primitive remains.

## Verification commands

Run focused feedback first:

```bash
npm run build -w core
npx vitest run core/test/telemetry.stats.test.ts core/test/telemetry.independent.test.ts
npx vitest run web/test/range-selector.test.tsx web/test/panels.render.test.tsx
npx vitest run web/test/bar-chart.test.tsx web/test/recent-tasks.render.test.tsx
npx vitest run web/test/data-table.test.tsx web/test/styles.test.ts
```

Then repository gates:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Visual verification requires the disposable databases and Chromium described in the root
`AGENTS.md`:

```bash
docker compose up -d timescale
npm run verify:ui
```

Inspect `artifacts/ui/` at 360px, 768px, 1024px, and 1440px before declaring the slice done.

## Suggested PR sequence

Keep every PR deployable. Do not land a payload shape that the web consumer does not understand.

### PR 1 — Metric contract and shared presentation primitives

- Replace `acceptRatio` with `editAcceptance` across core, server fixtures, web fixtures, and docs.
- Rebuild core.
- Rewrite `DataTable` with pure sorting helpers and accessible headers.
- Add range/relative/exact formatting helpers and focused tests.

### PR 2 — Toolbar, metric hierarchy, and state model

- Add AnalyticsToolbar and custom-range popover.
- Tighten last-updated/Refresh behavior in the Slice A page header.
- Replace AiUsagePanel with UsageSummaryPanel.
- Centralize full/partial empty and stale-selection behavior in DashboardPage.
- Land responsive toolbar/summary styling and screenshots.

### PR 3 — Chart interaction and accessibility

- Refactor TelemetryFrame content ordering.
- Add labeled/togglable series, dual-axis labels, partial treatment, tooltip, roving keyboard focus,
  calculation disclosure, and single-bucket layout.
- Update chart render/unit/browser coverage.

### PR 4 — Supporting tables, bounded board work, and visual matrix

- Migrate TaskUsage, ByUser, and RecentTasks to DataTable.
- Limit recent tasks to eight, add task links/relative time/View all tasks, and retain rows on error.
- Finish responsive layout, browser interactions, all applicable visual states, docs inventory, and
  full repository gates.

## Definition of done

This slice is complete when a member can open the dashboard and, without reading introductory
paragraphs, correctly state:

1. which time window, scope, and repositories the visible data covers;
2. how many sessions ran and how much new input/output usage they produced;
3. how much active time was measured and what denominator supports edit acceptance;
4. which chart bucket is partial and the exact values in any bucket;
5. which per-task or per-user value is an outlier; and
6. what the freshest completed board task is and where to see all tasks.

The result must remain truthful while refreshing, empty, stale, partially measured, telemetry-down,
or board-down; be keyboard operable; fit the target widths without page overflow; pass focused and
repository-wide gates; and include reviewed visual artifacts for every applicable dashboard state.
