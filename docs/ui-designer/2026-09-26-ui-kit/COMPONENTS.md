# Reusable UI kit — components and states

Use this alongside [the narrative brief](BRIEF.md) and [screenshots](index.html). Component names below are proposed design-library names; source mappings identify existing implementations and do not imply that every pattern already has a standalone React component.

## Foundations

| Family | Required decisions |
| --- | --- |
| Semantic color | Canvas, raised/sunken surface, text/secondary text, border, accent, selection, focus, positive/warning/negative/neutral, chart series; dark and light pairs |
| Typography | Page/section titles, body and long-form response, labels/help, dense metadata, tabular numbers, monospace identifiers and logs; wrapping and line height |
| Space and density | Shared spacing scale; page gutters; panel padding; row/control heights; comfortable mobile targets and deliberate desktop density |
| Shape and layering | Control/panel/dialog radii; border hierarchy; hover/selected treatment; menu/dialog elevation and backdrop |
| Icons and motion | Consistent icon vocabulary and accessible icon-button labels; optional running indicator; reduced-motion equivalent |

Current fonts are Barlow, Barlow Semi Condensed, and IBM Plex Mono. Current styles use semantic CSS tokens in `web/src/styles.css`. The designer may propose a different visual treatment while retaining semantic roles and accessible contrast.

## Core component library

| Proposed component | Contents and variants | Required states / behavior | Existing source anchor under `web/src/` |
| --- | --- | --- | --- |
| App shell | Sidebar, sticky app bar, page canvas, mobile drawer | Active route, nested settings route, long org name, drawer open/closed, keyboard focus | `components/AppShell.tsx`, `SideNav.tsx`, `AppBar.tsx`, `MobileNavDialog.tsx` |
| Page header | Eyebrow, title, description, metadata, actions | Long title; multiple actions; mobile stacking; one primary heading | `components/PageHeader.tsx` |
| Navigation item / task preview | Icon/status, label, count, task metadata | Current/hover/focus; clipped title with full meaning accessible; bounded task previews | `components/NavItems.tsx`, `SideNav.tsx` |
| Button / icon button | Primary, secondary, quiet, destructive; icon+text | Default/hover/pressed/focus/disabled/busy; reason for blocked primary action | Shared stylesheet; task header/composer and dialogs |
| Selector / menu | Trigger, selected value, options, grouped actions, separator | Open/closed, selected, keyboard-active, disabled, long labels, viewport-aware placement | `OrgSelector.tsx`, `ThemeSelector.tsx`, `RangeSelector.tsx`, `ScopeToggle.tsx`, `UserMenu.tsx` in `components/` |
| Form field | Label, text input/textarea/select, description, example, validation | Empty/filled/focused/invalid/disabled/read-only; required/optional; long content | `components/WorkflowParameterFields.tsx`, `ExecutorDialog.tsx`; composer |
| Checkbox / toggle | Boolean option plus explanation | On/off/focus/disabled/saving; saved preference versus per-task override | `panels/DefaultWorkflowPanel.tsx`, `TaskComposer.tsx` |
| Tabs / segmented navigation | Task state, editor mode, sorting choice | Selected/focused, count, overflow/wrap on mobile; distinguish route navigation from local tabs | `pages/TaskInboxPage.tsx`, `panels/env-vars-panel-parts.tsx` |
| Dialog | Title, body, form or consequence, footer actions | Open, invalid, busy, server refusal; contained scrolling; Escape/backdrop rules; focus return | `components/ExecutorDialog.tsx`, `TaskRemoveDialog.tsx`, `UnsavedChangesDialog.tsx`, `RangeSelector.tsx` |
| Status / badge / banner | Compact state label, contextual message, recovery action | Informational, working, waiting, success, failed, stale; text and icon alongside tone | `components/StatusBanner.tsx`, `panels/TelemetryFrame.tsx`, task status patterns |
| Section / panel / disclosure | Heading, description, action slot, body | Plain/raised; expanded/collapsed; loading/empty/error; avoid repeated page titles | `components/Card.tsx`; shared panel primitives |
| Data table / responsive row | Headers, sortable values, aligned numbers, row action | Sorting, empty, loading, long cells, local scroll, selected/editing row | `components/DataTable.tsx`, `pages/TaskInboxPage.tsx`, analytics and configuration tables |
| Key/value / identity / timestamp | Label/value pairs, avatar+name, relative time | Missing value, long identifier, link, exact-time access; wrap values | `components/KeyValues.tsx`, `RelativeTime.tsx`, `panels/IdentityPanel.tsx` |
| Empty / error / loading block | State, explanation, action | First use, no matching results, cold failure, refresh failure with retained data; avoid fake zeros | Inbox, telemetry frame, readiness, configuration panels |

## Product patterns built from the core kit

| Pattern | Reusable pieces | Designer must resolve | Source anchor |
| --- | --- | --- | --- |
| Analytics toolbar | Selectors + range dialog + applied-data summary | Draft versus applied dates; scope; loading/refresh without filter jumps | `components/AnalyticsToolbar.tsx` |
| Metric summary | Value, unit, label, coverage note | Missing versus zero; precision; source badge; hierarchy across metrics | `panels/UsageSummaryPanel.tsx` |
| Usage chart | Plot, axis, legend controls, tooltip, caption | Both themes, focusable data, partial intervals, sparse data, mobile scrolling | `panels/TokenUsagePanel.tsx`, `charts/` |
| Supporting analytics table | Shared table + numbers + usage bar/identity | Sorting and comparable units; keep attribution and coverage clear | `panels/ByUserPanel.tsx`, `TaskUsagePanel.tsx`, `RecentTasksPanel.tsx` |
| Task inbox | Filter bar + responsive task rows + Load more | Status/title first, repo/author/age second; long titles; empty filters versus no tasks | `pages/TaskInboxPage.tsx` |
| Task composer | Request field + context selectors + parameters + preflight + start | Required input, workflow-specific fields, default-step options, blocker with repair action | `panels/TaskComposer.tsx`, `components/WorkflowParameterFields.tsx` |
| Task conversation / run | Request, metadata, response, activity disclosure, verification, publication | Multiple turns, readable summaries, active run, unavailable summary, long logs | `panels/TaskDetail.tsx`, `TaskRun.tsx` |
| Outcome summary | Result + execution + verification + publication + services | Desktop side column/mobile summary; optional/missing fields; “Waiting for review” | `panels/TaskOutcome.tsx` |
| Task actions | Contextual primary action + secondary actions + overflow | Follow-up, stop, mark done, resume, remove; availability depends on actual state | `panels/TaskHeader.tsx` |
| Check tree / output well | Status row + expandable output + code/log text | Passed/failed/running, exit code, truncation, scroll and keyboard access | `panels/TaskRun.tsx` |
| Readiness item | Status, concrete fact, next action | Checking/ready/needs attention/unavailable; actionable setup rather than unexplained red badges | `pages/SettingsOverviewPage.tsx`, `settings/readiness.ts` |
| Configuration scope | Scope label, affected audience, precedence, editability | Org/workspace/repo identity; permission explanation before editing | `components/ConfigurationScope.tsx` |
| Environment editor | Scope + mode tabs + row fields/raw editor + save state | Mask/reveal, add/remove, invalid input, dirty/saving/saved/error, discard guard | `panels/EnvVarsPanel.tsx`, `env-vars-panel-parts.tsx` |
| Repository selection | Search + summary + selectable rows + status + save | Available/selected/cloning/failed; selected repo detail; unavailable listing | `components/RepositorySetup.tsx`, `pages/SettingsRepositoriesPage.tsx` |
| Executor editor | Profile table + configuration dialog | Create/edit, executor-specific config, invalid JSON, help, read-only/unavailable context | `panels/WorkspaceExecutorsPanel.tsx`, `components/ExecutorDialog.tsx` |
| Workflow settings | Default-step controls + named workflow table + editor | Saved defaults, dirty preferences, named workflow scope, protected built-in definition, validation | `panels/DefaultWorkflowPanel.tsx`, `WorkflowsPanel.tsx` |
| Entry / account | Public header + identity + organization choices + token controls | Signed out, first selection, no selection, unavailable repositories, existing account | `components/LoginGate.tsx`, `OnboardingOrganization.tsx`, `pages/OnboardingPage.tsx`, `AccountPage.tsx` |

## State coverage contract

Create the following state examples even when the gallery does not contain one. Use realistic synthetic content and label proposed additions.

| Area | State set |
| --- | --- |
| Shared controls | Default, hover, keyboard focus, selected/expanded, disabled with reason, busy, invalid, read-only |
| Data surfaces | Initial loading, loaded, true zero, no data, no search matches, cold failure, stale retained data, retry |
| Task lifecycle | Queued, running, stopping, intentional review wait, failed run/check, stopped, succeeded but open, marked done, follow-up |
| Setup/editors | Unconfigured, checking, ready, permission-limited, clean, dirty, saving, saved, save failed, navigation with unsaved changes |
| Overlays | Open on desktop/mobile, long content, focused action, submitting, server refusal, focus restored on close |
| Content stress | Long task/repository/workflow names, large values, multiline prompts, long output, missing optional metadata |

Do not merge “Waiting for review” (workflow waiting for external review) and the inbox's “Need review” grouping into one undifferentiated spinner. Ask whether the user must act, whether an executor is occupied, and which event resumes progress.

## How to assemble and hand off

Build foundations → controls → patterns → pages. A task inbox row and a recent-task table row should reuse identity/status/time treatments; they need not be the same layout. A workflow JSON editor and environment raw editor should share code-field behavior without pretending their validation rules are identical.

For every component, provide anatomy, variant/property names, content rules, interaction behavior, and desktop/mobile examples. Specify which information wraps, truncates, collapses, or scrolls. Show both themes on representative composed pages and all semantic states. Provide a source mapping for reusable components and clearly identify any new component the engineering team must create.
