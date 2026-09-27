# Bellows application redesign plan

Date: 2026-09-26. Source baseline: checkout `e19fce1`. Status: implementation proposal; no application code changed.

## 1. Outcome and scope

Redesign Bellows around the supplied task-oriented concepts: clear page identity, readable task rows, explicit execution readiness, understandable outcomes, and consistent light/dark surfaces. A user should be able to identify what needs attention, start a task, understand its result, and take the next action without interpreting runner internals.

This covers the entire existing application: shell, task inbox, composer, detail, dashboard, all settings routes, account, sign-in, onboarding, dialogs, and responsive states. Keep the existing React, Tailwind, Headless UI, Floating UI, routing, and polling architecture. Implement the visual redesign against existing contracts first; separately specified data extensions can follow. Do not introduce compatibility aliases or parallel legacy components.

Recommended direction: use images 01–06 for Bellows screen composition and blue accent; use 07–09 only to inform light/dark surface separation and responsive density. The latter images depict unrelated commerce and knowledge products. Their purple branding, navigation, knowledge graphs, notifications, and document features are not Bellows requirements.

## 2. Evidence and reference map

All nine original images were visually inspected. Unmodified copies are in `references/`, alongside the archive's README. Their text and sample numbers are concept content, not verified product facts.

| Reference | Adopt | Adapt to Bellows behavior |
| --- | --- | --- |
| [01 — Tasks](references/01-bellows-tasks-dark.png) | Strong heading, summary strip, aligned filters, readable rows, clear states | Keep supported state buckets and cursor loading; checks, publication columns, bulk actions, and numbered pagination require additional contracts |
| [02 — New task](references/02-bellows-new-task-dark.png) | Numbered sections, spacious request field, context selectors, explicit blockers | Show the actual two optional workflow preferences; do not make mandatory execution stages optional |
| [03 — Review detail](references/03-bellows-task-detail-review-dark.png) | Conversation plus outcome rail, clear publication, follow-up | Separate intentional review wait from completed run; only show recorded events and measured data |
| [04 — Failed detail](references/04-bellows-task-detail-failed-dark.png) | Failure diagnosis, expanded failed gates, actionable next step | Gate reports currently describe gates, not structured individual test cases; use actual output |
| [05 — Dashboard](references/05-bellows-dashboard-dark.png) | Compact toolbar, stronger metric hierarchy, large chart, supporting tables | Retain cache accounting, per-task usage, partial-period marks, and independent recent-task scope; defer unsupported comparisons/cost |
| [06 — Repositories](references/06-bellows-repositories-dark.png) | Readiness overview, wide table, selected repository detail | Workspace root is operator configuration; UI links must not promise to edit it |
| [07 — Theme board](references/07-light-dark-theme-board.png) | Matching component geometry across themes | Ignore commerce content and its unrelated palette |
| [08 — Split concept](references/08-light-dark-split-concept.png) | Readable conversation hierarchy and supporting rail | Ignore knowledge-search features and graph |
| [09 — System board](references/09-light-dark-system-board.png) | Cohesive surfaces and deliberate phone composition | Retain Bellows drawer navigation and blue brand; do not add another product model |

Current implementation evidence:

- [Design system](../../design-system.md), [architecture](../../architecture.md), [jobs](../../jobs.md), [workflows](../../workflows.md), [workspace](../../workspace.md), [repositories](../../repos.md), [environment](../../env.md), and [date range](../../date-range.md).
- [Current UI brief](../../ui-designer/2026-09-26-ui-kit/BRIEF.md), [component inventory](../../ui-designer/2026-09-26-ui-kit/COMPONENTS.md), and [capture notes](../../ui-designer/2026-09-26-ui-kit/CAPTURE.md).
- Visually compared the current desktop inbox, composer, rich task detail, light dashboard, and authenticated repository screenshots with the supplied concepts.
- Inspected route composition, task/workspace API types, status derivation, composer preferences, and test inventory. Existing UI-designer documents are untracked workspace material; this plan does not alter them.

The existing capture notes report **78 passing and 13 failing browser tests**. That is historical evidence from that capture, not a test result produced for this plan. Missing captured states include running, intentional review wait, and failed verification. No live application run or fresh browser verification was performed during planning.

## 3. Current-to-target assessment

| Area | Current baseline | Target |
| --- | --- | --- |
| Foundations | Semantic themes and accessible controls already exist; small condensed headings and low-emphasis metadata dominate | Larger hierarchy, clearer groupings, consistent iconography and spacing, more legible row content |
| Shell | Sidebar, bounded task previews, organization/account controls, mobile drawer already implemented | Stable compact navigation, clearer active state, reduced competition between previews and task inbox |
| Inbox | URL filters, incremental loading, activity/summary fields; visually sparse rows | Scannable title/summary pairs, explicit status, supported summary counts, cohesive filter bar |
| Composer | Guided inputs and blockers exist inside one broad panel | Distinct request/context/workflow/readiness sections and a clear launch footer |
| Task detail | Conversation, raw output, checks, outcome and actions exist | Clear run-result versus verification versus task-closure hierarchy; failures reveal useful evidence |
| Dashboard | Metrics, token chart, per-task usage, user usage, recent tasks exist | Horizontal desktop toolbar, stronger summary layout, balanced chart/table composition |
| Repositories | Selection/readiness and environment editor exist; narrow columns wrap actions awkwardly | Full-width selection table and dedicated selected-repository detail region |
| Other settings | Working scope, environment, executor and workflow surfaces | One consistent editor pattern with clear save state, scope and recovery |

The older improvement roadmap describes several features now implemented. Do not rebuild the inbox, theme engine, page headers, or outcome model simply because the earlier roadmap listed them as future work.

## 4. Product rules and data boundaries

### Task state is multidimensional

Keep the distinction between run result, verification result, review wait, and user closure. Use the existing `task-tree.ts` and `task-outcome.ts` derivations as the starting point, with any deliberate semantic change documented and tested.

| Situation | Presentation | Primary next action |
| --- | --- | --- |
| Queued | Neutral queued label | View context; existing supported cancellation behavior |
| Running | Working label and current activity | Stop, with the existing permission/state rules |
| Stop requested | Stopping, visibly pending | Await confirmation; do not show a completed stop early |
| Open structured review wait | Waiting for review; explain no executor is occupied | Open published work when known; existing completion/follow-up actions only when allowed |
| Succeeded, still open | Succeeded · Needs review | Review result and mark done |
| Failed/dead | Failed result with recorded reason | Inspect evidence, then follow up if supported |
| Verification failed | Separate verification warning, even when the agent completed | Inspect failed gate; request another pass |
| Stopped | Stopped, with available attribution | Existing follow-up or completion action |
| Marked done | Done, with attribution | Read the record and available actions |

Never infer a review wait from output prose. Preserve precedence when a follow-up is actually running. “Needs review” is an inbox grouping; “Waiting for review” is a durable workflow state. A zero failure count and exit code zero must not render as red errors.

### Concept features and implementation boundary

| Concept feature | Verified current contract | Delivery decision |
| --- | --- | --- |
| Inbox count cards | `navigation.counts` exposes running, review, past | First release uses these three labels; no invented failed/done totals |
| Search across branches/descriptions | Inbox `q` searches root command | Label it “Search task requests”; expanding search is a separate API change |
| Task row checks, branch/PR, duration | `TaskSummary` lacks gate reports, publication and duration | Exclude these columns initially; do not fetch every thread to fill a row |
| Page numbers and total filtered results | List returns `items` and `nextCursor` | Keep Load more; show loaded count without asserting a total |
| Author dropdown | Current filter accepts login text; no complete author directory established | Keep a labeled author input initially |
| Select-all and bulk actions | No bulk task action contract established | Omit selection checkboxes from task rows |
| Attachments, mentions, prompt templates | Text request and workflow parameters supported | No decorative attachment/mention buttons; an example may fill only an empty draft |
| Six optional workflow stages | Mandatory prompt → gates → publish, plus two optional preferences | Display mandatory process as explanatory text; expose review reconciliation and merge-conflict autofix only |
| Detailed change list/diff | No typed per-file diff in inspected task payload | Link to known published work; defer native diff UI |
| Per-check durations/test tree | `GateCheck` has name, status, exitCode, output | Render expandable gate output; omit unrecorded duration and individual-test counts |
| Full event timeline | Job timestamps and structured wait fields exist; arbitrary stage events do not | Build a modest run history from recorded facts only |
| Dashboard cost and previous-period deltas | Not present in the inspected summary UI; task runtime cost has separate semantics | Retain existing metrics; specify aggregation and comparison contracts before adding these cards |
| Repository branch/commit/size | `WorkspaceRepo` exposes nullable measured fields | Show known values; use “Not available” for unmeasured values, never zero |
| Repository environment/health summary | Environment is scope-specific; no aggregate health contract established | Show known checkout facts and selected repo environment; defer aggregate filters |
| Configure workspace root | Root is deployment/operator configuration | Link to workspace explanation; name operator action without offering an ineffective edit button |
| Agents navigation | Existing surface manages executor profiles | Use “Executors” within Settings; a fleet/agents page is separate product work |

Preserve the no-repository task path when the real launch preconditions are satisfied. A repository choice is not universally required. Organization-wide counts must remain independent of page filters and loaded depth. Unknown data, unavailable data, loading, empty data, and real zero values remain distinct.

## 5. Visual foundation specification

The following dimensions are proposed implementation targets, not measurements extracted from the images. Validate them against real content during the first component review.

| Foundation | Proposed specification |
| --- | --- |
| Surface | Flat blue-charcoal canvas in dark mode; cool off-white canvas in light mode; raised cards and sunken inputs through existing semantic tokens |
| Accent | Retain Bellows blue; distinct foreground-on-accent values per theme; reserve red for failure/destruction and green for success |
| Status | Existing status token families and text labels; neutral review-wait treatment initially, rather than contradictory colors across images 01 and 03 |
| Type | Use Barlow sans for body and page headings to reduce condensation; retain IBM Plex Mono for identifiers/logs; remove an unused display face if all callers move |
| Type scale | Page title 28–32px desktop / 24px phone; section title 18px; body and controls 14–16px; supporting labels 12–13px; metrics 28–32px |
| Spacing | Shared 4/8/12/16/24/32/48px scale; page gutters 24–32px desktop and 16px phone; panel padding 20–24px desktop, 16px phone |
| Radius | Retain 4px small primitives and 6px controls; add an 8px panel token only when used; no arbitrary per-page rounding |
| Controls | 40px desktop target, preserving the existing 36px minimum; at least 44px compact/mobile targets |
| Rows | Approximately 64–76px for two-line desktop task rows, growing with content; wrap rather than truncate critical status/recovery text |
| Icons | Consistent 16–20px stroke icons; 24px section icons; decorative icons hidden from assistive technology; no emoji as the icon system |
| Elevation | Borders/fill distinguish ordinary surfaces; shadow reserved for existing floating menus/dialogs |
| Motion | Preserve instantaneous theme/state changes and the existing reduced-motion behavior; do not add gradients, glow animation or transitions from concept artwork |

Retain the three-rung surface ladder and the distinction between accent and chart-primary. Color literals belong only in the two theme token blocks. Every text-bearing fill needs a matching foreground token. New tokens must have callers. Update `docs/design-system.md` and the pinned styles tests with each deliberate token or primitive change.

Theme behavior stays System/Light/Dark through the current provider and bootstrap. Preserve first-paint resolution, cross-tab updates, OS changes in System mode, and accessible theme selection. Use one appearance control; do not reproduce the redundant System dropdown plus moon toggle in the concepts.

Use existing dependencies. Add a small shared SVG icon component/file with only used glyphs if necessary; no bitmap UI controls or generated logo asset is needed. Keep the Bellows wordmark until a deliberate brand mark is designed.

## 6. Shell and information architecture

Keep existing routes: `/`, `/tasks`, `/tasks/new`, `/tasks/:id`, `/settings`, its five subsections, `/account`, and `/onboarding`.

- Desktop: approximately 224px sidebar, 56–64px top bar, remaining width for content. Content max-width around 1440px; prose within wide pages should still have a readable line length.
- Primary navigation remains Dashboard, Tasks, Settings. Task count and primary New task action should be easy to find. Do not duplicate Repositories at two navigation levels as the concepts do.
- Preserve bounded task previews; make their secondary grouping quieter and collapsible on desktop. The drawer continues to show navigation/counts, without copying a full task list.
- Settings expands to Overview, Organization, Workspace, Repositories, Executors, Workflows. Account remains accessible through the user menu.
- Global chrome contains organization, appearance, and account. Analytics range, scope, and freshness stay on the dashboard.
- Keep one page `h1`, a working skip link, route-aware active states, and focus management after navigation. Breadcrumbs on composer/detail return to the inbox; preserve its filters through the existing navigation model where available.

Source anchors: `components/AppShell.tsx`, `SideNav.tsx`, `AppBar.tsx`, `NavItems.tsx`, `MobileNavDialog.tsx`, `PageHeader.tsx`, `nav-model.ts`, `App.tsx` under `web/src/`.

## 7. Page implementation specifications

### 7.1 Task inbox

Compose the screen as heading/actions → three supported count cards → filters → active-filter chips → task list → Load more.

Count cards link to the corresponding URL state and explicitly describe organization totals. Keep the existing Needs attention view alongside Running, Needs review, and Past. Do not assume these views are disjoint when explaining totals.

Desktop row columns: task title and summary/activity, state, repository, author, updated time. Put the title link first; give the current activity priority while running and terminal summary priority after completion. Use initials only from known identity, with an explicit unknown fallback. Keep title links and future row controls separate; avoid nested interactive elements.

Use the existing request search, repository select, author input, and newest/oldest sort. Chips remove one filter; Clear filters restores the documented default view. Preserve URL round trips, browser Back, selected repository fallback, stale-data warnings, and incremental loading. Polling must retain focus and loaded depth.

Acceptance: long repository names and titles do not hide state/actions; filters survive reload/Back; counts do not change when filters narrow; every loaded row appears once; zero results differ from an empty board; stale rows remain visible with a warning.

Primary files: `pages/TaskInboxPage.tsx`, `api/useTasks.ts`, `task-tree.ts`. Prefer a small presentational row/count-card extraction only if it improves reuse; leave fetching in the existing hooks.

### 7.2 New task

Use four visible sections:

1. Request: label, concise help, large textarea, optional non-destructive example action.
2. Execution context: repository, executor and workflow, each with a full label and helper; stack on narrow screens.
3. Workflow details: actual named-workflow parameter inputs, or default process explanation and the two optional preferences. Preserve preference loading and per-task override semantics.
4. Readiness and launch: show actual blockers, direct links to the relevant settings section, and Start task with keyboard shortcut.

Display current blockers before submission and validation errors beside fields. Readiness must come from existing composer logic; do not invent a repository-access probe. A blocked button has a nearby explanation linked through accessible description. While submitting, prevent duplicate launch and keep the draft after failure. Existing repository/executor/workflow selection behavior and parameter validation remain authoritative.

On phones, place launch actions after readiness; any sticky footer must reserve layout space and remain usable with the software keyboard. An optional character counter must use the real command limit, not the image's “4000”.

Acceptance: valid repo and no-repo launch paths; missing executor; missing/invalid named parameters; delayed workflow preferences; API rejection; keyboard launch; draft retained after a failed request.

Primary files: `pages/TaskComposerPage.tsx`, `panels/TaskComposer.tsx`, composer logic helpers, `components/WorkflowParameterFields.tsx`.

### 7.3 Task detail, review and failure

Desktop uses a fluid main column and approximately 320px outcome rail when space allows. Header: title, state, author/repository/time metadata, one context-appropriate primary action and a secondary menu. The rail summarizes result, verification, publication, execution context and attribution.

Main content order: request/agent response → recorded run history → verification/services → published work → follow-up. Keep raw output in an accessible disclosure. If no summary was captured, say so and reveal useful output; never fabricate an agent response.

For review wait, explain why the task is waiting and show published-work links when available. Preserve existing workflow action restrictions. Mark done closes the task; it must not imply PR approval or merge.

For failure, expand failed gate output initially, keep passed gates collapsed, and show accurate counts. Asking for another pass focuses the existing follow-up composer; it does not silently launch an invented retry. Preserve stopping/removal pending states, cancellation attribution, and refusal messages in destructive dialogs. Gate status and agent exit status remain separate.

Recorded history can show run created/started/finished and wait timestamps; it must not guess implementation/publish timestamps. Missing cost, duration, files or publication stays absent or explicitly unavailable. Preserve service status display for both execution platforms.

Acceptance: queued, running, stopping, stopped, succeeded/open, done, failed, gate-failed and review-wait scenarios; multiple follow-ups; missing summaries; long logs; unsafe publication URL rejection; no stale action result applied after navigating to another task.

Primary files: `pages/TaskDetailPage.tsx`, `panels/TaskHeader.tsx`, `TaskDetail.tsx`, `TaskRun.tsx`, `TaskOutcome.tsx`, `task-outcome.ts`, `task-tree.ts`, `components/TaskRemoveDialog.tsx`.

### 7.4 Repositories and settings

Repositories: header with scope → availability warning → supported readiness summary → search/selection table → selected repository detail. Give the table full width so owner/name and Configure do not break awkwardly. Distinguish persisted checkout selection from the repository currently open for editing.

Show measured branch, commit and size where available. Preserve the 20-repository selection limit, queued/cloning/ready/failed states, unavailable root behavior, stale lists, and orphaned checkout explanation. Link to GitHub using known repository identity. The selected repository section contains checkout facts and its existing environment editor; no nonfunctional Health tab.

Root-unavailable messaging explains the operator dependency and links to Workspace. It must not instruct a user to configure `ORG_WORKSPACE_ROOT` through a nonexistent UI field. Environment status must not imply that an empty configuration is unhealthy; repositories may need no variables.

Apply the same settings composition everywhere:

- Overview: readiness, scope and next corrective links.
- Organization: existing identity/configuration permissions and organization environment.
- Workspace: personal checkout context, root explanation, personal environment and orphaned checkouts.
- Executors: profile name/type/default state, clear add/edit/remove actions and existing configuration dialog; credentials stay out of summary/poll payloads.
- Workflows: clearly separate default optional preferences from named workflow definitions; retain the existing definition editor rather than inventing a graph editor.

Environment editing keeps separate Variables/Secrets treatment, table/raw modes, validation, reveal/copy behavior, save errors, and dirty-draft protection. Keep scope visible: organization < workspace < repository. Changing repository, organization, editor mode, or route must respect the existing unsaved-change rules.

Acceptance: no wrapping inside action words, no lost dirty edits, successful and refused saves, no secret values in list summaries, correctly scoped updates, preserved selection ceiling and root-null state.

Primary files: `pages/Settings*`, `components/RepositorySetup.tsx`, `repository-setup.ts`, `ConfigurationScope.tsx`, `ExecutorDialog.tsx`, `UnsavedChangesDialog.tsx`, and related `panels/` editors.

### 7.5 Dashboard

Create a compact desktop analytics toolbar with range, scope, known repository coverage, freshness and refresh. Current repository coverage is informational; do not style it as a working repository filter unless that filter is implemented end to end.

Keep sessions, input/output token usage with cache detail, active time and edit acceptance with denominators. Use metric hierarchy and spacing from image 05 without introducing its unsupported dollar card or trend arrows. Preserve telemetry-off, unavailable, empty, partial and stale states.

Make the token/session chart the main visual; retain separate axes, legend interaction, keyboard inspection, partial-bucket hatching and calculation disclosure. Do not add chart-type or aggregation controls without supported behavior. Keep per-task distributions and measured-task denominators, even though the concept omits that panel.

Place user usage and recent tasks side by side only at widths where their columns remain readable; otherwise stack them. Explicitly label recent tasks as board data unaffected by the analytics range/scope. Preserve input/output/cache distinctions and the difference between job turns and agent turns.

Acceptance: all range presets, custom range validation, scope changes, unavailable identity, partial periods, chart focus/legend, sparse data and stale-data recovery. No decorative trend is allowed to imply a measured comparison.

Primary files: `pages/DashboardPage.tsx`, `components/AnalyticsToolbar.tsx`, `RangeSelector.tsx`, `ScopeToggle.tsx`, usage/recent-task panels, and `charts/`.

### 7.6 Account, authentication and onboarding

Extend the same visual language to `AccountPage`, `LoginGate`, `PublicPageHeader`, `OnboardingPage` and organization selection. Account groups identity, tracked organizations and access tokens. Preserve token creation/reveal/revoke behavior without exposing secrets in decorative summaries.

Onboarding presents the actual organization and repository choices, the consequences of continuing, and disabled-state explanations. Reuse selection primitives and distinguish missing selection from loading or permission errors. Open-mode screens must remain honest about unavailable identity/workspace features.

Acceptance: light/dark/system on public pages, sign-in return route, organization selection, disabled Continue reason, token reveal/revoke flow, and narrow-screen dialogs.

## 8. Responsive and accessibility contract

| Width | Behavior |
| --- | --- |
| Above 1200px | Full sidebar; multi-column filters; task outcome rail; supporting dashboard tables may share a row |
| 901–1200px | Retain sidebar; wrap filters; collapse detail rail to a summary above the conversation when needed |
| 641–900px | Existing compact shell/mobile drawer; two-column summaries where content fits; stacked detail and settings |
| 320–640px | Single-column forms; one/two count cards per row according to fit; task metadata stacks; full-width dialog with contained scroll |

Keep the existing 900px compact-shell breakpoint to limit navigation churn. At narrow widths, move the outcome summary before detailed run content without creating conflicting keyboard and visual order. Native data tables/logs may scroll within their own labeled region; the page must not scroll horizontally. Do not hide the only access to an action or critical status in a clipped column.

Validation targets: 320, 390, 768, 1024 and 1440px; both themes for each redesigned route family; 200% zoom; keyboard-only use; reduced motion; forced colors; long names and unbroken log lines. Essential text remains at least 12px and controls 14px, with 44px compact targets. Check text contrast at 4.5:1 for normal text and 3:1 for large text; distinguish meaningful control boundaries and focus. These are acceptance targets, not an accessibility certification.

Every icon-only button needs a name, every form control a label, and every dialog focus containment/return. Use status text plus icon/tone. Keep polled count updates out of noisy live regions; announce user-triggered action results appropriately. Preserve the deliberate static skip-link, navigation and chart pattern anchors described in repository instructions.

## 9. Delivery sequence and reviewable work packages

Effort ranges below are planning estimates in focused engineering days, assuming one engineer familiar with this repository, existing dependencies, and no new backend product features. They include targeted tests and visual iteration, exclude review queues and deployment delays, and are not measured throughput.

| Package | Dependencies | Deliverable and exit condition | Estimate |
| --- | --- | --- | --- |
| R0 — Baseline and contracts | None | Diagnose the existing capture failures; align selector/fixture assumptions with real behavior; deterministic running/wait/failed fixtures; baseline screenshots and documented data omissions | 1–2 days |
| R1 — Foundations and shell | R0 | Both-theme tokens/type/spacing, shared controls/status styles, revised shell/navigation; docs and styles tests updated; keyboard/phone shell reviewed | 2–3 days |
| R2 — Task inbox | R1 | Three truthful counts, row hierarchy, cohesive filters/chips, cursor loading, stale/empty states; URL/poll behavior verified | 2–3 days |
| R3 — Task creation | R1 | Four-section composer, actual optional preferences, parameter fields and readiness; valid/blocked/error launch flows verified | 2–3 days |
| R4 — Task result and recovery | R1, R2, R3 | Outcome rail, run history, failed-gate evidence, review wait and follow-up/action states; complete task journey reviewed | 3–4 days |
| R5 — Configuration | R1 | Repositories plus overview/workspace/org/executors/workflows share editor rules; dirty drafts and scope tests pass | 3–4 days |
| R6 — Analytics | R1 | Toolbar, existing metrics/chart/tables restyled; partial data and independent recent-task scope preserved | 2–3 days |
| R7 — Entry and account | R1, R5 | Sign-in/onboarding/account/dialogs brought into the same system; auth/open-mode journeys verified | 1–2 days |
| R8 — Integrated quality pass | R2–R7 | Responsive/contrast/focus matrix, full regression checks, before/after gallery, obsolete styles removed | 2–3 days |

Estimated first-release total: **18–27 focused engineering days**. Sequence for one engineer: R0 → R1 → R2 → R3 → R4 → R5 → R6 → R7 → R8. R5–R7 share R1 foundations and can be reordered; task execution stays the first complete journey. Re-estimate after R0 if the baseline failures expose deeper application defects.

Each package should be a small reviewable PR or a short series: state the visible behavior, include representative before/after screenshots in both themes, list intentional design-contract changes, and name tests actually run. Do not hide failing tests by replacing behavior assertions with screenshot-only checks. Remove superseded styles/components within the corresponding package.

### R0 concrete checklist

1. Reproduce the capture-noted failures rather than assuming all are stale selectors.
2. Update obsolete native-select assumptions to the current accessible selector roles where warranted.
3. Supply valid executor/workspace/organization fixtures for launch and onboarding flows.
4. Add deterministic task fixtures for running, review wait, failed gate, done and follow-up; use offline seeded/stub data.
5. Capture baseline screens with provenance: route, viewport, theme, fixture state, commit and timestamp.
6. Record pass/fail status; avoid resetting a real database. Browser suites use their documented disposable databases.

## 10. Optional follow-on data work

These features are excluded from the 18–27 day first-release estimate. They may be scheduled after the visual task journey is complete.

| Extension | Required design/engineering work | Completion criterion |
| --- | --- | --- |
| Rich inbox columns | Add a bounded server summary projection for latest verification, publication and duration; update route/schema/types together; preserve org isolation and cursor order | One list fetch, no per-row thread requests, correct null/stale behavior and database tests |
| Failed/done summary cards | Define whether failure means agent failure or verification failure and how open waits/follow-ups interact; calculate full-org counts server-side | Counts/filters agree from the same task model and do not depend on loaded rows |
| Changed files/native diff | Establish structured persisted change metadata and an authorized bounded diff read; handle binary/large files and safe rendering | Accurate run/thread attribution, valid empty states, bounded payloads; Docker and Kubernetes parity for any collected runner data |
| Rich stage timeline | Persist actual stage/check timestamps if needed, including wait/retry transitions | No reconstructed fictional chronology; event ordering and repeated attempts tested |
| Analytics comparisons/cost | Define comparison windows, partial/custom/all-time behavior, cost coverage and missing-value policy; extend aggregation/API | Proven denominators and cost provenance; no average price multiplied across unlike models |
| Bulk task actions | Specify eligible states, permissions, partial failure and selection across loaded pages before API/UI implementation | Explicit per-item results and safe confirmation; no ambiguous select-all scope |

Do not add database migrations, driver telemetry or a fleet-management subsystem just to reproduce decorative fields. If a follow-on touches `driver/`, read Kubernetes and executor-testing docs first and ship both executor implementations together. Driver remains independent of core; do not introduce a cross-package type dependency.

## 11. Verification and definition of done

Use existing tests as behavior contracts and add coverage only for new semantics or meaningful interaction risks. Primary suites:

| Surface | Relevant current tests |
| --- | --- |
| Tokens/shell/themes | `web/test/styles.test.ts`, `theme.test.tsx`, `shell.test.tsx`, `nav-model.test.ts`, `mobile-nav.test.tsx`; `e2e/navigation.spec.ts`, `polish.spec.ts` |
| Inbox | `web/test/task-inbox.render.test.tsx`, `use-tasks.test.ts`, `task-tree.test.ts`; navigation browser scenarios |
| Composer/workflows | `web/test/task-composer-logic.test.ts`, `task-composer.render.test.tsx`, `default-workflow.render.test.tsx`, preference/draft tests; `e2e/composer.spec.ts` |
| Task detail | `web/test/task-header.render.test.tsx`, `task-detail.render.test.tsx`, `task-run.render.test.tsx`, `task-outcome.render.test.tsx`, `task-derivations.test.ts`; `e2e/task-detail.spec.ts` |
| Configuration | Repository setup, settings, executor dialog, environment and unsaved-change suites; `e2e/workspace.spec.ts`, `env.spec.ts` |
| Analytics | Dashboard summary/telemetry, charts, ranges and recent-task suites; `e2e/dashboard.spec.ts` |
| Identity/entry | Onboarding/account-related render coverage; `e2e/auth.spec.ts` |

For implementation: build core before server/web checks (`npm run build -w core`), run focused Vitest/browser suites per package, then `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and the complete `npm run verify:ui` matrix at integration. Use the documented disposable `factory_e2e` and `factory_auth_e2e` databases. Never point reset/seed tooling at `factory_dev`. Add database/executor checks only if follow-on backend/runner changes require them.

Static render tests do not prove layout. Review actual screenshots at desktop and phone widths, with both themes and representative long-content/error states. A passing DOM assertion alone is insufficient. Preserve synthetic-data labels and record actual command outcomes; do not inherit the old gallery's pass claims.

Release criteria:

- Every existing route and essential action has a coherent implementation in both themes.
- Launch → execution → review/failure → follow-up → done is understandable and tested.
- No unsupported control, fabricated metric, or status conflation from the concepts remains.
- No page-level horizontal overflow at the target widths; logs/tables scroll locally where necessary.
- Theme bootstrap, keyboard focus, dialog behavior, scope/URL state, polling and dirty drafts remain correct.
- New classes/components are documented in the design-system inventory; unused tokens and superseded markup/styles are removed.
- Tests pass, or any externally blocked check is explicitly documented with its actual evidence before release decisions.
- A final screenshot manifest shows route/theme/viewport/state and links to reviewed images.

## 12. Risks and decisions carried into implementation

| Risk | Mitigation |
| --- | --- |
| Treating generated concepts as complete requirements | Use the feature-boundary table before adding UI controls or new data work |
| CSS changes breaking pinned design contracts | Update the relevant documented contract and meaningful assertion together; keep global accessibility floors |
| Regressing task-state semantics | Reuse shared derivations; test review wait, verification and closure independently |
| Hiding stale data under new loading visuals | Keep last-good data and visible stale explanation; reserve loading placeholders for unresolved data |
| Making settings look writable when permissions/configuration forbid it | Render real capabilities and operator dependencies; preserve scope and draft guards |
| Expanding a redesign into backend/runner reconstruction | Deliver the existing-data first release; estimate each optional data extension separately |
| Approving only dark desktop screens | Require both themes, compact widths and error states within each package |

Working decisions: blue Bellows identity; existing routes and drawer; sans page headings; mandatory workflow stages preserved; three existing count buckets; cursor pagination; no task bulk actions, native diff, fleet page, or unsupported metrics in the first release. These defaults make the proposal implementable without waiting for further product choices. The first concrete implementation task is R0, followed by the shared foundation and the task inbox.
