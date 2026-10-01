# Factory UI improvement roadmap

## Executive diagnosis

Factory has the right functional ingredients, but the interface presents them as an implementation inventory rather than a product. The dominant visual pattern is a bordered panel containing labels, explanatory text, and controls. That keeps the UI consistent, but it flattens hierarchy: creating a task, reading telemetry, editing a secret, and seeing an empty placeholder all feel equally important.

The redesign should optimize three recurring user loops:

1. **Understand:** Is agent usage healthy, changing, and attributable?
2. **Act:** What needs attention, and how do I start or continue work?
3. **Configure:** Is this organization ready to run tasks safely?

The most important shift is not a new color palette. It is making the current context, next action, and system state obvious within a few seconds.

## Evidence from the current build

- The global heading remains **Factory stats** on Tasks and Settings pages, with a telemetry repository subtitle even when the page is not about telemetry. Page identity is therefore weaker than global status.
- In the task screenshots, **Need review (38)** produces a near page-height list of almost identical rows in a 220px sidebar. It crowds out navigation and makes task triage difficult.
- The populated dashboard reaches roughly 2,400px tall. Long explanatory paragraphs precede data, and an unbounded Recently completed table dominates the lower half.
- The dashboard uses five equal stat cards even though users are likely to care about sessions, cost/usage, active time, and acceptance for different reasons. No card provides comparison or trend context.
- The task composer is visually a large empty textarea followed by tiny selector controls. Repository, executor, and workflow are critical execution choices but read like metadata.
- Workflow validation exposes a raw regular expression across the panel. The error is technically precise but not actionable in normal language.
- A successful task with no output looks almost the same as an empty record. The task detail page does not strongly separate user prompt, agent result, verification, and completion outcome.
- Settings pages mostly consist of large panels with small amounts of content. Scope and ownership are described in prose rather than carried by layout and labels.
- Onboarding is a small anonymous form in a large empty canvas. It does not explain what tracking enables, what access is required, or what happens next.
- The responsive CSS primarily collapses columns. At less than 900px the whole sidenav becomes a top region while its task tree remains conceptually attached, which will not scale for dozens of tasks.
- Several labels use 10–11px text, controls are visually small, and the stylesheet has no explicit `:focus-visible` or reduced-motion treatment. Native/library behavior may cover some cases, but the visual system does not make those guarantees explicit.

## Strengths to preserve

- Telemetry data and board data fail independently and are labeled honestly.
- A dash means unmeasured, not zero; blank sidebar values have a separate meaning.
- Status color and motion have stable semantics across task dots, pills, and checks.
- Disabled actions explain why; refused actions render near their source.
- Workflow fields announce validation state, and dialogs already use keyboard-aware primitives.
- Repo context is explicit because the analytics are meaningless without it.
- In open mode, controls that can never work are absent rather than decorative.

These are product semantics, not styling details. Every increment below assumes they remain intact.

## Priority roadmap

### P0 — Fix orientation and task-list scalability

These changes unblock every later visual improvement.

#### 1. Make page identity route-aware

Replace the universal **Factory stats** heading with a real page header:

- Dashboard: **Usage overview**, repo coverage, range/scope controls, last refresh.
- Tasks index: **Tasks**, concise queue summary, primary **New task** action.
- Task detail: task title, status, elapsed time, and task actions.
- Settings: **Settings** plus the current subsection and its scope.
- Account: **Account** and signed-in identity.

Keep only organization switching and the user menu in persistent global chrome. Move telemetry-only refresh and “data as of” into the dashboard header. This immediately removes misleading context from every non-dashboard page.

**Acceptance check:** a cropped screenshot of any page still identifies the page, organization, and primary action without relying on the sidenav.

#### 2. Turn the task tree into a task inbox

Do not render an unbounded review queue in global navigation. Keep the sidebar compact:

- Tasks top-level item with Running and Review count badges.
- Pinned **New task** action.
- At most 3–5 running/recent attention items.
- **View all tasks** opens a dedicated inbox in the main content area.

The inbox should support status filters (Running, Needs review, Done/Stopped), search, repository, author, and newest/oldest activity. Rows need title first, then status, repository, author, and relative update time. Live activity belongs on running rows only. Past tasks should be paginated or incrementally loaded.

This preserves the current automatic grouping while moving browsing and triage into a surface with enough width.

**Acceptance check:** 100 tasks do not increase global navigation height, and a user can find an assigned or recently finished task in two actions.

#### 3. Establish a page hierarchy instead of “panels everywhere”

Create three clear elevation levels:

- Page canvas for navigation, headings, filters, and empty space.
- Sections for related information; these do not always need borders.
- Raised panels only for bounded data, editors, dialogs, or actionable states.

Standardize a page header, section header, toolbar, empty state, alert, form field, and data table. Increase normal body text to a reliably readable size, reserve 10–11px text for exceptional metadata, and give primary controls a consistent height and hit area.

**Acceptance check:** squinting at a page reveals one heading, one primary action, and a small number of clear sections—not a stack of equally weighted rectangles.

#### 4. Design responsive navigation deliberately

Below desktop width, use a compact app bar with a menu/drawer. Do not place the full task tree above page content. In task detail, move status into a collapsible summary below the title and above the conversation. In analytics, let filters wrap as labeled groups and make tables scroll inside their own regions.

Define and visually verify at least 360px, 768px, 1024px, and 1440px widths.

**Acceptance check:** the primary content begins within the first viewport at every target width.

### P1 — Make the dashboard answer questions quickly

#### 5. Replace the filter strip with a compact analytics toolbar

Group Range, Scope, and Repository coverage as labeled controls. Keep common presets, but move Custom into a date-range popover so half-completed dates do not expand the whole page. Show the selected time window in plain language, for example **Sep 13–19 · Org · 1 repository**.

Keep “Last updated” beside Refresh. Use relative time first with the precise timestamp available on hover/focus.

#### 6. Redesign the metric summary around decisions

Keep the five measures but improve hierarchy:

- Make sessions and token usage the leading measures.
- Pair input/output tokens as one usage group while preserving cache read/write detail.
- Keep active time and edit acceptance as effectiveness measures.
- Put denominators and caveats directly under the value in shorter language.
- Add prior-period deltas only when the backend can provide a valid comparable window; do not derive misleading trends for All time or partial custom ranges.

Empty metrics should become one coherent empty-state block rather than five cards filled with dashes.

#### 7. Make the usage chart readable before explanatory text

Lead with the chart, then offer a one-line caption and a **How this is calculated** disclosure. Clarify the dual axis, label the partial bucket visually, and make series togglable from the legend. Give hover/focus detail for exact input, output, and session values.

For a one-day range, use a compact daily summary or a single-bar treatment rather than stretching one bar across a large chart frame.

#### 8. Convert supporting analytics into concise, sortable tables

- Per-task usage: a comparison table with rows for tokens, runs, turns, and wall clock; columns for average, median, p95, and measured tasks.
- Usage by user: sortable columns, avatar/name, totals, and a compact proportional usage bar.
- Recently completed: show 5–10 rows, meaningful task titles, relative completion time, and **View all tasks**. Remove it from the telemetry visual frame because it is board data.

This cuts page length and makes the distinction between telemetry and board data clearer.

**P1 outcome:** a user can identify volume, efficiency, an outlier, and the freshest completed work without scrolling through prose.

### P1 — Make starting a task feel safe and intentional

#### 9. Recompose the task composer as a guided execution form

Use this order:

1. Prompt, with example text that describes the expected level of detail.
2. Repository and executor as clearly labeled required execution context when the system requires them; otherwise use explicit **No repository** / **Default executor** language rather than bare `none`.
3. Optional workflow, labeled as a reusable process.
4. Workflow parameters grouped under the selected workflow, with human-readable hints.
5. A summary line: **Will run in bellows.ai using Main executor, with Fix issue workflow**.
6. Primary action: **Start task**, with the keyboard shortcut nearby.

The current raw regex should move behind **Format details**. The inline message should say something actionable, such as **Enter an issue number like 123 or paste a GitHub issue URL**.

When workspace setup is incomplete, replace a disabled mystery control with a linked remediation message such as **Select repositories in Settings to run tasks**.

**Acceptance check:** before submission, a user can state where the agent will run, how it will run, and whether their prompt will be transformed.

### P1 — Make task detail a trustworthy work record

#### 10. Create a strong conversation hierarchy

Render each run as an exchange with four recognizable layers:

- User request.
- Agent activity/output.
- Checks and publication result.
- Run metadata in a quiet footer.

Do not lead with timestamps or status chips. Use monospace only for logs, identifiers, branches, and code—not normal prose. Preserve output scroll wells for long logs, but let normal agent summaries flow at reading width.

When no output was recorded, explain the implication: **This run finished without a captured agent response. Check its exit status and checks below.**

#### 11. Replace the sparse status sidebar with an outcome summary

Show status, repository/worktree, executor/workflow, cost/context, duration, branch, pull request, and checks only when meaningful. Group branch and PR under **Published work**. Turn real URLs into labeled links. Omit absent optional rows rather than leaving a column of blanks, while preserving the specified blank-vs-dash measurement semantics where a labeled row is required.

On narrow screens, the summary becomes a disclosure above the conversation.

#### 12. Clarify task actions

Use one primary action based on state:

- Running: **Stop run** as a clearly destructive secondary action, not a generic primary.
- Finished and open: **Mark done** as primary.
- Closed: show the closure attribution as status, not a disabled button.

Move **Remove task** into an overflow/danger area and replace the native confirm with an accessible confirmation dialog that names the task and consequences. Keep follow-up submission visually attached to the conversation and label it **Send follow-up**.

**P1 outcome:** the page makes it obvious what was asked, what the agent produced, whether verification passed, and what the human should do next.

### P2 — Turn settings into a setup and maintenance experience

#### 13. Add setup health to the Settings landing page

Replace “Organization settings are not built yet” as the first impression with a readiness summary:

- Organization identity and current role.
- Workspace configured / unavailable.
- Repositories selected and checked out.
- Executors available.
- Environment scopes with unsaved/error state.

Each issue should link to its exact fix. Keep unbuilt organization features out of the primary content rather than presenting a large placeholder panel.

#### 14. Make settings scope visible in the page structure

Every editor should show a scope breadcrumb or badge: **Organization**, **My workspace**, or **Repository · owner/name**. State who is affected and who can edit before the form. Admin-only read-only views should look like readable configuration, not disabled forms.

#### 15. Improve the environment editor

- Treat Variables and Secrets as tabs with counts.
- Use an actual editable row table with Name, Value/State, and row actions.
- Make add/edit/save states explicit and keep the primary Save action close to changed content.
- Mark unsaved changes and warn before navigating away.
- Show secrets as **Set** / **Not set**, with clear “leave blank to keep” behavior.
- Put Raw mode under an **Advanced** disclosure with a warning and parse help. Label it **Edit as .env** rather than `raw`.
- Replace the × remove control with an accessible row action and an undo opportunity before save.

#### 16. Improve repository and executor configuration

The repository page should be a selectable list with checkout status, search, and a summary such as **3 of 18 repositories enabled**. Selecting a repository should open its configuration without turning the whole page into an empty selector panel.

The executor list should explain which executor is the default or commonly used. In the dialog, provide type-specific config help and examples; keep raw JSON available for precision, but not as the only mental model.

**P2 outcome:** an admin can diagnose why tasks cannot run and reach the exact fix without understanding the backend's configuration model.

### P2 — Make onboarding explain value and consequences

#### 17. Turn onboarding into a short setup flow

Keep it one page if the data set is small, but add:

- Factory brand and one-sentence purpose.
- Progress/context: **Choose organizations and repositories**.
- A clear distinction between tracking all current/future repositories and selecting specific repositories.
- Selected counts per organization.
- Permission and privacy note in plain language.
- A final summary near Continue.

Use organization identity (avatar/name) rather than installation-like identifiers when available. The Continue button should remain disabled with the existing inline reason when no organization is selected.

### P3 — Refine the visual and interaction system

#### 18. Increase legibility and reduce visual noise

- Raise small metadata text; avoid 10px labels for navigation and task information.
- Increase contrast for muted explanatory text and chart labels.
- Use fewer borders. Prefer spacing, background shifts, and typography for grouping.
- Use sentence case consistently; reserve monospace for machine-originated content.
- Keep one blue accent for interactive focus and selection, but do not use it as the only status signal.
- Standardize 36–40px minimum control height and 44px touch targets where mobile use is expected.

#### 19. Make interaction states explicit

Define hover, active, selected, disabled, loading, error, success, and `:focus-visible` styles for every shared control. Add a reduced-motion rule for breathing status lamps while preserving a non-motion state cue. Ensure chart series and task statuses remain distinguishable without color.

#### 20. Add theme switching only after hierarchy is stable

The light tokens already exist, but a theme toggle will not solve the current structural issues. Add system preference and persistence after the core layouts and component states work in both palettes.

## Recommended delivery slices

### Slice A — Navigation and hierarchy

Route-aware page headers, dashboard-only refresh metadata, compact task navigation, task inbox, typography/control sizing, and responsive shell.

### Slice B — Dashboard

Analytics toolbar, summary redesign, chart caption/disclosure, bounded recent tasks, sortable shared table, and coherent empty/degraded states.

### Slice C — Task execution

Guided composer, plain-language validation, conversation hierarchy, outcome summary, state-based actions, and confirmation dialog.

### Slice D — Configuration

Settings readiness overview, visible scopes/permissions, environment editor cleanup, repository selection, and executor guidance.

### Slice E — Onboarding and polish

Onboarding explanation/summary, complete focus and motion states, contrast audit, light theme, and final responsive pass.

Each slice should ship with updated visual regression screenshots for populated, sparse, loading, error-with-stale-data, empty, read-only, in-flight, validation-error, and narrow-screen states.

## Success measures

Track product outcomes rather than only visual consistency:

- Time from opening Tasks to finding a task needing review.
- Time and error rate from opening the composer to a successfully queued task.
- Percentage of composer failures caused by missing setup or invalid workflow parameters.
- Time from opening a finished task to locating its outcome, checks, branch, or PR.
- Time from a setup warning to the corresponding settings fix.
- Dashboard comprehension tests: selected scope/range, session volume, usage direction, and freshest data.
- Keyboard completion of onboarding, task creation, task review, and environment editing.
- No horizontal page overflow at target widths; scroll is contained to data tables and log wells.

## Avoid during the first increments

- A cosmetic rebrand without changing page hierarchy.
- A Kanban board before search/filter task triage is solved.
- More dashboard charts before the existing chart and metrics answer clear questions.
- Animations beyond meaningful live status.
- A theme switch as a headline feature.
- Hiding explanatory semantics in tooltips only; critical scope, stale-data, permission, and validation information must remain visible.

