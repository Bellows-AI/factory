# [UI] Slice D — Make configuration diagnosable, scoped, and safe to edit

## Issue metadata

- **Type:** Feature / configuration UX
- **Priority:** P2
- **Size:** Large; land as the ordered PR sequence at the end of this issue
- **Areas:** Settings information architecture, readiness, scope and permissions, repository
  selection, workspace state, environment variables and secrets, executor guidance, responsive
  layout, accessibility, tests, visual regression, documentation
- **Depends on:** Slice A — Navigation and hierarchy; rebase onto Slice B's final design-system
  primitives and Slice C's final task-composer terminology before styling
- **Blocks:** Slice E's final onboarding, focus-state, contrast, theme, and responsive audit

## Summary

Turn Settings from four disconnected implementation surfaces into one setup and maintenance
experience.

A member should be able to open `/settings`, understand which organization and personal workspace
they are configuring, see whether repositories are ready, understand what happens when no executor
is configured, and reach the exact control that fixes a problem. Every editor must name its scope,
who it affects, and who can edit it before presenting controls.

This slice delivers:

- a real Settings overview at `/settings`, derived from the existing session, workspace, and
  environment payloads;
- explicit **Organization**, **My workspace**, and **Repository · owner/name** scope context;
- a repository setup page that combines availability, personal checkout selection, checkout
  status, search, and per-repository configuration;
- environment-variable and secret editing with count-bearing tabs, explicit drafts, removal undo,
  save feedback, advanced `.env` editing, and navigation protection;
- executor guidance that explains the effective first selection, the deployment-controlled runner,
  and the real behavior of `claude-code` and `opencode` configuration.

This is primarily a web information-architecture and interaction change. The existing APIs already
expose the required facts. Do not add a readiness endpoint, duplicate server state in the browser,
or change Docker/Kubernetes runner behavior for this slice.

## Baseline and dependency assumptions

Implement this issue after Slice A. Keep the settings tree inside `AppShell`, keep the global
Settings navigation item, and preserve one route-aware page heading per section.

Slice D assumes Slice A has delivered:

- a functional `/settings/*` route tree inside the authenticated shell;
- `PageHeader` with one page-level `h1`;
- a compact desktop sidenav and focus-managed mobile navigation;
- shared surface, form-control, alert, empty-state, and table primitives;
- a global skip link and visible `:focus-visible` treatment.

Slice D assumes Slice B has delivered the final spacing, status, disclosure, table, dialog, and
responsive conventions in `web/src/styles.css`. Reuse those conventions instead of creating a
second settings-only visual language.

Slice D assumes Slice C has made the task composer honest about repository and executor choices.
The settings copy in this issue must use the same terms as the composer: **Repository**,
**Executor**, **No repository**, and the selected executor name.

The current implementation already contains behavior this issue must evolve rather than discard:

- `SettingsLayout` owns one `useWorkspace()` poll and one non-polling `useEnv()` request for the
  entire settings subtree.
- `GET /api/workspace` deliberately omits executor configs from its poll; the edit dialog fetches
  them only on demand from `GET /api/workspace/executors`.
- `GET /api/repos` distinguishes an empty installation from a refresh failure and can return a
  cached list with `meta.error`.
- workspace repository selection and executor configuration are whole-list `PUT`s.
- repository cloning is asynchronous; `PUT /api/workspace/repos` returns `202`, and polling reports
  `queued`, `cloning`, `ready`, or `failed`.
- deselected repositories remain on disk and appear in `orphaned`; this is visible maintenance
  information, not garbage to hide.
- environment secrets are write-only through the API. Every read returns `value: null`, including
  for admins.
- environment precedence remains organization < workspace < repository, with the most specific
  value winning.

Do not move network effects into presentational components while recomposing these surfaces.

## Required reading before implementation

Read these files before editing the corresponding code:

- `docs/design-system.md` for tokens, primitives, responsive rules, and the required class
  inventory;
- `docs/organizations.md` and `docs/auth.md` for organization membership and the current role
  model;
- `docs/repos.md` for installation repository discovery and cached-error semantics;
- `docs/workspace.md` for personal checkout selection, clone states, orphaned checkouts, executor
  storage, and on-demand config reads;
- `docs/jobs.md` for the required workspace path, deployment-controlled runner CLI, executor-label
  resolution, and image-default behavior;
- `docs/env.md` for scope, precedence, whole-list saves, secret masking, and actual write
  permissions;
- `docs/api.md` before changing any request or response behavior;
- `docs/security.md` before changing secret or executor-config exposure;
- `docs/ui-designer/PRIORITY-IMPROVEMENTS.md`, items 13–16 and Slice D;
- `docs/ui-designer/ISSUE-SLICE-A-NAVIGATION-HIERARCHY.md` for shell, route, heading, and responsive
  assumptions;
- `docs/ui-designer/ISSUE-SLICE-B-DASHBOARD.md` for final status, table, disclosure, and stale-data
  conventions;
- `docs/ui-designer/ISSUE-SLICE-C-TASK-EXECUTION.md` for repository/executor terminology and
  destructive-confirmation conventions.

## Problem statement

### Settings has no landing experience

`/settings` currently redirects directly to `/settings/workspace`. The first settings section a
member can open, Organization, leads with **Organization settings are not built yet.** There is no
place that summarizes the organization, personal workspace, selected repositories, executor
availability, or environment state.

The member must already know which backend concept is wrong before they can choose the correct
section.

### Scope and permissions are implicit or contradictory

Organization, personal, and per-repository values are presented with similar panels and little
explanation of their blast radius. Repository availability belongs to the organization; checkout
selection belongs to the member; repository environment applies organization-wide. Those are three
different scopes on one page today.

The web currently disables organization and repository environment controls for `role ===
'member'`, but `PUT /api/env/org` and `PUT /api/env/repo` deliberately accept every organization
member and route tests pin that behavior. A browser-only restriction is not authorization and is
misleading.

### Repository setup is split across two mental models

The Repositories page lists installation repositories but sends members to Workspace to choose
checkouts. Workspace opens a modal picker, while per-repository environment starts as an empty
selector panel on Repositories. Checkout status appears on a different page from the choice that
caused it.

Members cannot answer “which repositories can I use, which did I enable, and are they ready?” in
one place.

### Environment editing is easy to lose or misread

The current editor already separates variables and secrets and supports raw text, but:

- tab labels omit counts;
- the controls use pressed-button semantics instead of a complete tabs contract;
- `raw` is implementation vocabulary and applying raw text is coupled to toggling it closed;
- removals disappear immediately with no undo;
- there is no canonical dirty state or navigation warning;
- “Saved.” does not distinguish a clean editor from an untouched one;
- a secret's blank input needs clearer **leave blank to keep** and state language;
- the client-only admin disablement makes a writable API appear read-only.

### Executor configuration overstates what the row controls

The add/edit dialog says an executor “runs your agents' work” and offers raw JSON as the only model.
The actual contract is narrower:

- the deployment's `RUNNER_CLI` chooses the CLI and image;
- an executor row is a personal name plus configuration for that deployment-controlled runner;
- `opencode` JSON is supplied only when the deployment runs OpenCode;
- `claude-code` JSON is stored but has no consumer yet;
- `permission` is stripped from OpenCode config;
- no configured row means the task uses the image default;
- the first returned executor is preselected for a new task.

The page must explain these facts without exposing polled configs or implying a capability that does
not exist.

## Goals

1. Give `/settings` a useful overview with exact links to every relevant fix.
2. Make scope, impact, ownership, and editability explicit before every configuration surface.
3. Put repository availability, personal selection, checkout status, search, and repository
   configuration on one page.
4. Make environment drafts safe to understand, save, discard, and recover from accidental removal.
5. Make secrets' write-only behavior legible without ever revealing a stored value.
6. Explain executor defaults and type behavior using facts the system actually enforces.
7. Preserve last-good data during refresh or save failures and distinguish it from empty data.
8. Work at wide and narrow widths without hiding the fix action or requiring pointer input.
9. Keep every current API secrecy, whole-list, polling, and clone-lifecycle invariant intact.

## Non-goals

- Do not add organization membership management, invitations, or role editing.
- Do not redefine which environment scopes a member may write in this slice.
- Do not add a client-only authorization rule. Real restrictions require a server response and a
  documented policy.
- Do not add a readiness database table or a `/api/settings/readiness` endpoint.
- Do not add repository deletion or automatic cleanup of orphaned checkouts.
- Do not make repository selection organization-wide; it remains per member.
- Do not make executor configuration organization-wide; it remains per member.
- Do not add an executor `default` column, reorder API, or migration. Describe the existing first
  selection honestly.
- Do not claim that an executor row switches the deployment's CLI or image.
- Do not add a visual JSON schema editor or silently discard unknown executor keys.
- Do not reveal stored environment-secret values or move executor configs into the workspace poll.
- Do not modify runner env forwarding, driver claims, Docker behavior, Kubernetes behavior, clone
  mechanics, or workspace paths.
- Do not add theme switching; Slice E owns the final theme and contrast pass.

## Product and behavior constraints to preserve

### Permissions are server facts

For this slice, the following table is authoritative:

| Surface | Scope | Current writer | Required UI statement |
| --- | --- | --- | --- |
| Organization environment | Organization | Any member | Applies to every member's tasks in this organization. Any member can edit. |
| Workspace environment | My workspace | Current member | Applies to tasks you start. Only you edit this scope. |
| Repository environment | Repository | Any member of the installation | Applies to every task using this repository in the organization. Any member can edit. |
| Checkout selection | My workspace | Current member | Controls only your checkouts. |
| Executors | My workspace | Current member | Controls only the executor labels and config on tasks you start. |

Remove `disabled={!isAdmin}` from organization and repository environment editors. Keep the role
visible as identity metadata, but do not use it to invent a restriction the routes do not enforce.

If product policy changes before this slice lands, authorization must be implemented server-first:
the affected `PUT` routes return a documented `403 FORBIDDEN`, route and database tests pin it, and
the UI derives a readable view from that contract. Do not land a disabled form as the only gate.

### Secrets remain write-only

- A stored secret is represented by `isSecret: true` and `value: null`.
- Render its state as **Set**.
- Its value input stays blank with **Leave blank to keep the current secret**.
- A blank save for an existing secret sends `null` and preserves the stored value.
- Omitting the row from the whole-list `PUT` deletes it.
- Never put a stored secret in an input value, DOM attribute, status message, log, screenshot,
  fixture, or test assertion.

### Whole-list writes remain explicit

Repository selection, executor lists, and one environment scope are each replaced as a whole.
Draft code must preserve entries that a filter or inactive tab does not currently render. A search,
tab switch, repository-detail switch, or cached-list warning must never silently shrink the next
request body.

### Empty, unavailable, and stale are different states

- Empty means a successful request returned zero items.
- Unavailable means the deployment deliberately has no workspace root or store.
- Error means the request failed.
- Stale means last-good content remains visible with a named refresh/save error.
- Loading means there is no answer yet; do not render zero counts while loading.

Never turn any of these into the others for visual convenience.

## Information architecture

### Route map

Use the existing settings tree and replace only its index behavior:

| Route | Page | Responsibility |
| --- | --- | --- |
| `/settings` | Settings overview | Identity plus configuration/readiness summary and exact fix links |
| `/settings/organization` | Organization | Organization identity and organization environment |
| `/settings/workspace` | Workspace | Personal workspace root, personal environment, and orphaned checkout maintenance |
| `/settings/repos` | Repositories | Installation availability, personal checkout selection/status, and repository environment |
| `/settings/executors` | Executors | Personal executor list, effective first selection, and add/edit guidance |

Replace the `/settings` index redirect with `SettingsOverviewPage`. The parent Settings nav item is
the Overview link; keep the existing four nested section links. Do not add a duplicate Overview
sub-link.

### Page hierarchy

Each route renders, in order:

1. `PageHeader` with eyebrow **Settings**, a route-specific `h1`, and one concise sentence.
2. A scope/impact block when the page edits one scope.
3. A status or action summary.
4. The bounded list, editor, or maintenance surface.

Do not wrap every paragraph in a panel. Use raised panels only for a bounded readiness item, table,
editor, dialog, or actionable warning.

## 1. Settings overview

Add `SettingsOverviewPage` at `/settings`.

### Header

- Eyebrow: **Settings**
- Title: **Configuration overview**
- Description: **Review what is configured for {organization name} and your workspace.**
- No generic primary action. Each readiness item owns its exact fix link.

### Identity summary

Lead with readable identity, not a placeholder panel:

- organization display name;
- current account display name/login;
- role rendered as **Admin** or **Member**;
- one plain sentence: **Permissions are stated on each setting because scope, not page location,
  determines who is affected.**

Do not infer extra powers from the role. Do not expose organization IDs unless the display name is
absent; the session always has a name in the current contract.

### Readiness items

Render five ordered items. Every item has a heading, a text status, supporting facts, and a direct
link whose label names the action.

#### Organization

Always show the active organization and role from the authenticated session. Link
**Review organization settings** → `/settings/organization`.

#### Workspace

Derive from `useWorkspace()`:

- no response yet: **Checking workspace…**;
- request failed with no data: **Workspace status unavailable** and the request error;
- `root === null`: **Workspace is not configured; tasks cannot run** with
  **Review workspace setup** → `/settings/workspace`;
- non-null root: **Workspace available** and a quiet path value with
  **Open workspace settings** → `/settings/workspace`.

`root === null` is a deliberate deployment configuration rather than a request failure, but the
driver refuses a claim without a usable `workspacePath`. Use an unavailable/attention state and say
that tasks cannot run; do not describe the API response itself as an outage.

#### Repositories

Derive from `workspace.data.repos`, not a new installation-list fetch:

- zero selected with a workspace root: **No repositories enabled for your workspace** with
  **Choose repositories** → `/settings/repos`;
- any `failed`: **{n} repositories need attention** with failed names/reasons and
  **Review repository status** → `/settings/repos`;
- any `queued` or `cloning`, none failed: **Setting up {n} repositories** with
  **View checkout progress** → `/settings/repos`;
- all selected repos ready: **{n} repositories ready** with
  **Manage repositories** → `/settings/repos`;
- workspace unavailable: **Repository checkouts require a workspace root** with the fix link to
  `/settings/workspace`.

Do not report a cloning repo as zero bytes or ready.

#### Executors

Derive from `workspace.data.executors`:

- workspace root unavailable: **Personal executors are unavailable without a workspace root, and
  tasks cannot run.** Link **Review workspace setup** →
  `/settings/workspace`;
- zero: **Using the deployment default** and **No personal executors configured. Tasks can still
  use the runner's image default.**;
- one or more: **{n} personal executors available** and **{first name} is selected first on new
  tasks.**

Link **Manage executors** → `/settings/executors`. Zero executors is optional/neutral, not a red
error.

#### Environment

Derive from `useEnv()`:

- no response yet: **Checking environment scopes…**;
- request failed with no data: **Environment status unavailable** and the error;
- successful empty payload: **No custom environment values** and note that configuration is
  optional;
- populated: report separate non-secret and secret row counts across organization, workspace, and
  repository scopes without showing names or values.

Provide scoped links:

- **Organization environment** → `/settings/organization`;
- **My workspace environment** → `/settings/workspace`;
- **Repository environment** → `/settings/repos`.

### Readiness derivation

Put readiness derivation in a pure module. It accepts settled session/workspace/environment inputs
and returns presentation-neutral items with:

```ts
type ReadinessTone = 'ready' | 'working' | 'attention' | 'neutral' | 'unavailable';

interface ReadinessItem {
    id: 'organization' | 'workspace' | 'repositories' | 'executors' | 'environment';
    label: string;
    status: string;
    detail: string;
    tone: ReadinessTone;
    action: { to: string; label: string };
}
```

Do not put JSX, fetch state, or icons into the derivation. Test all precedence rules, especially
failed repositories outranking cloning and stale content staying visible with a separate error.

## 2. Shared scope and permission context

Add a small shared `ConfigurationScope` primitive. It is explanatory content, not an interactive
scope selector and not the analytics `ScopeToggle`.

It accepts:

- a scope label;
- one impact sentence;
- one editability sentence;
- optional precedence help for environment scopes.

Render examples exactly in this style:

- **Organization** — Applies to every member's tasks in Bellows AI. Any member can edit.
- **My workspace** — Applies only to tasks you start. Only you can edit.
- **Repository · owner/name** — Applies to every task using this repository in Bellows AI. Any
  member can edit.

The scope label must be text, not color alone. Keep it near the section heading and before the
controls. Do not use breadcrumbs that imply a route hierarchy the router does not have.

For environment scopes, add quiet precedence copy:

- Organization: **Workspace and repository values override matching names.**
- Workspace: **Repository values override matching names.**
- Repository: **Repository values take precedence for this repository.**

## 3. Organization page

Replace **Organization settings are not built yet.**

Render:

1. `PageHeader`: eyebrow **Settings**, title **Organization**, description **Shared configuration
   for {organization name}.**
2. A compact identity definition list: organization name and current role.
3. `ConfigurationScope` for **Organization**.
4. A section heading **Organization environment**.
5. `EnvVarsPanel` with the organization rows and `saveOrg`.

Do not render unbuilt membership or billing placeholders. Do not disable the editor for members
under the current API contract.

## 4. Workspace page

Keep workspace-specific information on `/settings/workspace`, but move checkout selection and the
selected-repository table to `/settings/repos`.

Render:

1. `PageHeader`: eyebrow **Settings**, title **Workspace**.
2. `ConfigurationScope` for **My workspace**.
3. Workspace availability/root summary.
4. **My workspace environment** editor.
5. **Still on disk** orphaned-checkout maintenance list when non-empty.

When `root === null`, show:

**This deployment has no workspace root. Tasks cannot run until an operator sets
`ORG_WORKSPACE_ROOT`.**

Keep personal environment configuration available if the environment store exists; do not hide it
behind workspace-root availability.

Replace **Select repositories** with a text link **Manage repository checkouts** →
`/settings/repos`. Remove first-visit modal auto-open behavior from Workspace.

Keep orphaned checkouts truthful:

- name the repository;
- say it is no longer enabled but remains on disk;
- do not offer deletion;
- do not call it selected, failed, or ready.

## 5. Repository setup and configuration

Recompose `/settings/repos` as the complete repository surface.

### Header and summaries

- Eyebrow: **Settings**
- Title: **Repositories**
- Description: **Choose which repositories are checked out for your workspace and configure
  repository-wide environment.**

Above the list show:

- **{enabled} of {available} repositories enabled** after both payloads settle;
- ready, setting-up, and failed counts for enabled repositories;
- the installation account and whether GitHub reports `all` or `selected` access when present;
- a cached-list warning when `meta.error` exists;
- the workspace-unavailable explanation when `root === null`.

Do not show `0 of 0` while either required answer is loading.

### Search

Add one labeled search field:

- label: **Search repositories**;
- match case-insensitively against `owner/name`;
- show **No repositories match “{query}”** when the loaded list has no match;
- never change the draft selection when filtering;
- provide a clear action only when the field has text.

### Repository list

Use one named, keyboard-focusable table/list region. Each available repository row contains:

- a checkbox labeled **Enable owner/name in my workspace**;
- the linked/selectable repository name;
- checkout status: **Not checked out**, **Queued**, **Cloning**, **Ready**, or
  **Failed · {reason}**;
- branch and last commit only when known;
- checkout size only when known, with an em dash for unmeasured rather than `0 B`;
- a **Configure** action that selects the repository environment detail.

Do not make the whole `<tr>` clickable and do not nest a button inside a link. Checkbox activation
changes the checkout draft; repository name or **Configure** changes the configuration detail.

The selected configuration row carries `aria-current="true"` or an equivalent named selected
state. Selection must remain distinguishable without color.

### Checkout draft and save

Initialize the draft from `workspace.data.repos`. The draft is a full set keyed by `owner/name`.

- Preserve selected repositories hidden by search.
- Preserve selected repositories temporarily absent from the installation response; show them in a
  separate **No longer reported by GitHub** group instead of silently dropping them.
- Allow an absent selected repository to be deselected, but do not allow it to be newly selected.
- While an absent selected repository remains enabled, disable the whole-list save and say
  **Remove repositories GitHub no longer reports before saving other selection changes.** The
  server validates the entire body and would reject that stale entry; do not wait for a generic
  `UNKNOWN_REPO` response to explain it.
- Enforce the current 20-repository ceiling in the UI. Once 20 are selected, leave selected boxes
  enabled for deselection and disable only additional selections with **You can enable up to 20
  repositories.**
- Show **Selection changed — save to update your workspace** when dirty.
- Primary action: **Save repository selection** next to the summary, not at the page bottom.
- During the request: **Saving selection…** and controls disabled.
- On `202`: adopt the saved full selection, clear dirty state, show **Repository selection saved.
  Checkout status will update here.**, and keep polling.
- On failure: retain the draft, retain last-good status, and show the server message near the
  action.

Use the same route-leave and browser-leave protection as the environment editor for an unsaved
repository selection.

### Loading, error, empty, and cached states

- Installation list loading: keep last-good rows if present; otherwise show **Loading repositories…**.
- Workspace loading: show availability rows if known, but use **Checking checkout status…** rather
  than unchecked boxes until the personal selection is known.
- Hard installation error with no data: show **Could not load repositories from GitHub** and the
  error. Do not render an empty list.
- Cached installation error: show the cached rows, timestamp when available, and the named warning.
- Successful empty installation: show **This GitHub App is not installed on any repositories.
  Ask an administrator to update the installation on GitHub.**
- Workspace root unavailable: render repository availability and configuration, but disable the
  checkout checkboxes with the visible reason and link to Workspace.

### Repository configuration detail

Selecting a repository renders a real configuration section on the same page. Do not render an
empty selector panel before a choice.

The detail starts with:

- heading **Environment for owner/name**;
- `ConfigurationScope` label **Repository · owner/name**;
- repository checkout state as supporting context;
- `EnvVarsPanel` initialized from that repository's scope, or an empty successful scope.

Choosing a different repository while this editor is dirty opens the unsaved-changes dialog. A
confirmed discard switches the detail; continuing returns focus to the editor. Selection does not
require that the repository be enabled in the member's workspace because the environment scope is
organization-wide and the server validates installation visibility, not personal checkout state.

At wide widths the repository list and selected detail may form a master/detail grid. At narrow
widths they stack in DOM order: search and list first, selected detail second. After a narrow-screen
**Configure** activation, move focus to the detail heading without forcing a scroll on desktop.

Delete `RepoPickerDialog` after all callers and tests move. Do not keep a second checkout-selection
implementation.

## 6. Environment editor

Refactor `EnvVarsPanel` into an explicit draft editor while preserving one whole-list save per
scope.

### Scope header

The page owns `ConfigurationScope`; the panel owns:

- a section heading;
- optional hint;
- draft status;
- tabs and editor;
- local save/error feedback.

Do not duplicate the page `h1` inside the panel.

### Variables and Secrets tabs

Use the complete WAI-ARIA tabs pattern:

- one `role="tablist"` with an accessible label based on the section;
- tabs **Variables ({n})** and **Secrets ({n})**;
- `role="tab"`, `aria-selected`, `aria-controls`, and roving tab focus;
- Left/Right arrow navigation, Home, and End;
- associated `role="tabpanel"` elements with stable IDs;
- both panels may stay mounted so one merged draft survives tab changes.

Counts exclude rows pending removal and include valid unsaved additions. The accessible tab name
must include the count.

### Variable rows

Render an editable table with columns:

- **Name**;
- **Value**;
- **Actions**.

Each input has a visible column label plus a row-specific accessible name. Adding a variable appends
one row, focuses its Name input, and marks the draft dirty.

Validate client-side using the same name, count, and value constraints as the server where those
rules already exist. The server remains authoritative. Associate row errors with their inputs and
also render a concise save-level summary.

### Secret rows

Render columns:

- **Name**;
- **State / new value**;
- **Actions**.

For a stored secret:

- state text: **Set**;
- blank password input;
- placeholder/help: **Leave blank to keep the current secret**;
- typed replacement state: **Will replace when saved**.

For a new blank secret:

- state text: **Not set**;
- prevent save until name and value are valid, or let the member remove the incomplete row.

Never render bullets that imply the length of a stored value. Never offer reveal/copy for a value
the browser does not possess.

Adding a row from the Variables tab creates a variable; adding from Secrets creates a secret. Do
not let a stored masked secret become a non-secret without a newly entered value.

### Remove and undo

Replace the icon-only disappearing removal with a pending-removal state:

1. **Remove {name}** marks an existing row for removal.
2. Keep a compact row/message in place: **{name} will be removed when you save.**
3. Offer **Undo** in that row.
4. Exclude the row from tab counts and the save payload while removal is pending.
5. Announce removal and undo through a polite live region.

An untouched, unsaved blank row may disappear immediately because it has no stored effect; return
focus to the Add button or nearest remaining row.

### Advanced `.env` editing

Replace the **raw** toggle with an **Advanced** disclosure inside the Variables tab.

- Disclosure label: **Edit variables as .env**.
- Warning: **This replaces the variable draft for this scope. Secrets are never shown here.**
- Textarea label: **Variables in .env format**.
- Help: one `NAME=value` pair per line; deleting a line removes that variable from the draft after
  apply; comments and invalid lines follow the existing parser rules.
- Action: **Apply .env draft**.
- Secondary action: **Cancel .env changes**.

Opening or closing the disclosure alone does not mutate the table draft. **Apply .env draft** parses
the text; on success it replaces only non-secret draft rows and keeps secret rows. On parse failure,
keep the text, keep the disclosure open, associate the error with the textarea, and do not change
the table draft.

The scope's primary **Save changes** action remains disabled while unapplied `.env` text differs
from the seeded text. Explain why beside the button.

### Dirty, saving, saved, and failed states

Derive dirty state from a canonical comparison of the baseline rows and current effective draft:

- trim only where the API already trims;
- preserve row identity locally, but compare the API payload shape;
- distinguish `null` (keep stored secret) from `''` (new/replacement input);
- exclude pending-removal rows;
- ignore ordering only if the server and UI already treat ordering as non-semantic.

Render:

- dirty: **Unsaved changes**;
- saving: **Saving changes…** and lock the current scope controls;
- success: **Changes saved** in a polite live region, then adopt the echoed `{ vars }` as the new
  baseline;
- failure: named error in an alert, keep the draft and focus the alert without erasing inputs.

Keep the save action next to the edited table/disclosure. Disable it when clean, invalid, saving,
or holding unapplied `.env` text.

Do not remount `EnvVarsPanel` after a save; the current hook's echoed rows must be adopted inside the
mounted editor so success feedback is not lost.

### Unsaved-change protection

Protect all dirty environment editors and the repository-selection draft:

- register `beforeunload` while any active draft is dirty;
- block in-app route navigation with React Router's blocker API;
- block a repository-detail switch when that repository editor is dirty;
- show an accessible dialog titled **Discard unsaved changes?**;
- body: **Your changes to {scope label} have not been saved.**;
- primary safe action: **Continue editing**;
- destructive action: **Discard changes**;
- Escape and outside click behave like **Continue editing**;
- after continue, return focus to the initiating link/control;
- after discard, reset the draft to its baseline and continue the original navigation/switch.

One shared owner coordinates blockers so two nested dialogs cannot open. Do not use a silent
`window.confirm` for in-app navigation.

## 7. Executor page and dialog

### Page

Render:

1. `PageHeader`: eyebrow **Settings**, title **Executors**, description **Name the personal runner
   configuration offered when you start a task.**
2. `ConfigurationScope` for **My workspace**.
3. One explanatory callout:
   **The deployment chooses the runner CLI and image. An executor stores your label and config; it
   does not switch the deployment between Claude Code and OpenCode.**
4. Executor list.
5. Page-header action **Add executor**.

When the list is empty, say:

**No personal executors configured. New tasks use the deployment's image default.**

When `workspace.data.root === null`, replace the add/list surface with:

**Personal executors are unavailable because this deployment has no workspace root. Tasks cannot
run until workspace setup is complete.** Link **Review workspace setup** to
`/settings/workspace`. Do not open the dialog and discover the existing
`409 WORKSPACE_DISABLED` only after input.

When non-empty, mark only the first returned row with **Selected first on new tasks**. Phrase this as
current composer behavior, not a persisted default policy. Do not add reordering or **Make default**
in this slice.

Each row shows:

- name;
- type with a human label (**Claude Code** or **OpenCode**);
- added date;
- first-selection marker when applicable;
- **Edit** action.

Do not poll or render raw config in the list.

### Add/edit dialog

Keep Name, Type, and raw JSON, but add type-specific help before the textarea.

For **Claude Code**:

- help: **This JSON is stored with the executor but is not consumed by the current Claude Code
  runner. Use `{}` unless your deployment documents another consumer.**
- example: `{}`.

For **OpenCode**:

- help: **When the deployment runs OpenCode, this object is merged over its baked configuration.
  Model and provider settings apply; permission rules are ignored to preserve the runner fence.**
- example containing only documented non-secret illustrative keys such as `model` and `provider`;
- never put a real token or credential in fixtures/screenshots.

Common help:

- **The selected Type describes this config. It does not change the deployment's runner CLI.**
- unknown JSON keys remain accepted;
- the object must obey the current byte limit and name/type structural validation;
- credentials pasted into config are sensitive and are fetched only when this dialog opens.

Use **Add executor** for create and **Save executor** for edit. Keep inline parse/shape errors linked
to the textarea. During save, retain the dialog content. On failure, keep focus in the dialog and
show the server error; on success, close and return focus to the triggering Add/Edit button.

Preserve whole-list merge behavior, rename audit semantics, the ten-executor ceiling, and the
on-demand `GET /api/workspace/executors` read.

## 8. Shared state and failure behavior

### Last-good data

For workspace, repository, and environment content:

- initial failure with no data renders an error state, not an empty state;
- a refresh/save failure after successful data keeps the last-good content visible;
- put the warning before the affected content and state that shown data may be stale;
- never zero a count solely because the newest request failed.

### Mutations

Every mutation has one visible lifecycle:

- idle/clean;
- dirty when applicable;
- validation error;
- in flight;
- success;
- server failure with draft retained.

Disable only the controls whose concurrent mutation would be ambiguous. Keep navigation available
unless a dirty-state blocker is active.

### Polling

- Keep one workspace poll in `SettingsLayout`.
- Do not start a second workspace poll on Overview or Repositories.
- Keep environment non-polling so remote writes cannot race local drafts.
- Keep repository discovery fetch-on-mount for the Repositories page only; Overview uses workspace
  selection counts.
- Keep executor configs out of all polling and overview payloads.

## Data/API work

No new endpoint or migration is expected.

Use the existing contracts:

| Request | Slice D use |
| --- | --- |
| `GET /api/auth/me` | Identity, organization, role |
| `GET /api/workspace` | Root, personal repo selection/status, orphaned rows, executor summaries |
| `GET /api/repos` | Installation repository availability and cached error metadata |
| `GET /api/env` | Organization, workspace, and repository environment rows |
| `PUT /api/workspace/repos` | Whole personal checkout selection; `202` |
| `GET /api/workspace/executors` | On-demand full executor configs for add/edit only |
| `PUT /api/workspace/executors` | Whole personal executor list |
| `PUT /api/env/org` | Whole organization environment scope |
| `PUT /api/env/workspace` | Whole personal workspace environment scope |
| `PUT /api/env/repo` | Whole organization-wide repository environment scope |

If implementation discovers a missing fact, stop and prove why it cannot be derived from these
responses before expanding the API. Any API change must update `docs/api.md`, route tests, frontend
types, fixtures, and error-state behavior in the same PR.

## Implementation instructions by file

### Routes and settings context

#### `web/src/App.tsx`

- Add `SettingsOverviewPage`.
- Replace the settings index `<Navigate>` with the overview component.
- Keep existing child paths and the catch-all behavior.

#### `web/src/nav-model.ts`

- Keep the top-level Settings item at `/settings` and the four existing section links.
- Ensure exact `/settings` marks the parent current; child routes keep the parent expanded without
  falsely marking it as the current page.
- Do not add Overview to `SETTINGS_SECTIONS`.

#### `web/src/pages/SettingsLayout.tsx`

- Continue to own exactly one workspace hook and one environment hook.
- Add the smallest shared dirty-draft coordinator needed for route blocking.
- Expose registration by stable scope ID, dirty label, reset callback, and optional pending
  navigation continuation.
- Do not lift every input value into route context.

#### `web/src/pages/SettingsOverviewPage.tsx` (new)

- Read session/workspace/env through `useSettingsPage()`.
- Render identity and readiness items.
- Never fetch repositories or executor configs.
- Keep error banners separate from derived item content so stale facts remain visible.

#### `web/src/settings/readiness.ts` (new)

- Implement the pure readiness derivation and count formatting.
- Keep status precedence and copy testable without React.

### Shared configuration primitives

#### `web/src/components/ConfigurationScope.tsx` (new)

- Render scope label, impact, editability, and optional precedence help.
- Do not reuse the interactive analytics `ScopeToggle`.
- Use semantic text/definition structure, not a disabled control.

#### `web/src/components/UnsavedChangesDialog.tsx` (new)

- Implement the shared accessible confirmation dialog using the project's existing dialog
  conventions.
- Support route navigation and repository-detail switching through one contract.
- Own focus entry, Escape/outside behavior, and focus return.

### Organization and workspace pages

#### `web/src/pages/SettingsOrganizationPage.tsx`

- Remove the placeholder description.
- Render organization identity and scope context.
- Remove `isAdmin`-based disabling under the current route contract.
- Preserve initial environment load/error gating.

#### `web/src/pages/SettingsWorkspacePage.tsx`

- Add scope context and the precise workspace-unavailable message.
- Remove picker state, first-visit auto-open, and selected-repository table.
- Add **Manage repository checkouts** link.
- Keep personal environment and orphaned checkout content.

### Repository page

#### `web/src/pages/SettingsRepositoriesPage.tsx`

- Combine `useRepos(true)` with the shared workspace and environment state.
- Own repository search, checkout draft, dirty/save feedback, and selected-config identity.
- Preserve last-good content and cached-list warnings.
- Do not key/remount `EnvVarsPanel` after save; repository switching is an explicit guarded state
  transition.

#### `web/src/components/RepositorySetup.tsx` (new) or equivalent split

- Render summary, search, named list/table region, checkout controls, status, and configure actions.
- Keep filtering and whole-selection helpers pure and exported for tests.
- Preserve hidden and temporarily unreported selected keys.

#### `web/src/components/RepoPickerDialog.tsx`

- Delete after the inline repository setup surface owns all checkout selection.
- Move still-useful pure ordering/selection helpers into the repository setup module; do not retain
  a dead dialog wrapper.

#### `web/src/panels/WorkspaceReposPanel.tsx`

- Fold its branch, commit, size, and clone-status presentation into the repository setup list, or
  refactor it into a reusable row/table body with no page-specific panel wrapper.
- Delete it if no caller remains.

#### `web/src/api/useRepos.ts`

- Preserve data on refresh failure when last-good data exists.
- Keep `meta.error` distinct from request failure and successful empty installation.
- Do not add polling.

#### `web/src/api/useWorkspace.ts`

- Preserve the existing poll, backoff, full-selection save, clone statuses, and error messages.
- Expose no executor config in the poll.
- If a save-success announcement needs structured state, return it from the mutation rather than
  encoding it in a timeout.

### Environment editor

#### `web/src/panels/EnvVarsPanel.tsx`

- Add baseline/draft identity, canonical dirty comparison, pending removals, tab semantics, counts,
  explicit `.env` apply/cancel, and save lifecycle.
- Register/unregister dirty state with the settings coordinator.
- Replace `disabled` permission use with an explicit read-only mode only if a real server-backed
  permission exists; saving alone may still lock controls.
- Preserve write-only secret semantics and echoed-row adoption.

#### `web/src/panels/env-raw.ts`

- Keep parsing and serialization pure.
- Add focused helpers only if the advanced apply/cancel flow requires canonical comparison.
- Preserve current strict validation and line-specific errors.

#### `web/src/api/useEnv.ts`

- Keep one load and explicit refetch after a successful save.
- Preserve last-good data on save/refetch failure.
- Keep per-editor echoed `{ vars }` as the source of the new baseline.
- Do not poll and do not synthesize secret values.

### Executors

#### `web/src/pages/SettingsExecutorsPage.tsx`

- Add scope context and deployment-controlled-runner guidance.
- Mark the first summary row as selected first by the composer.
- Preserve on-demand config loading before opening edit.
- Keep last-good executor summaries visible when config fetch/save fails.

#### `web/src/panels/WorkspaceExecutorsPanel.tsx`

- Use the shared data-table contract.
- Add human type labels and the first-selection marker.
- Keep config out of the row model.

#### `web/src/components/ExecutorDialog.tsx`

- Add type-specific help/examples and honest deployment-runner copy.
- Use **Save executor** for edit.
- Preserve raw JSON, structural validation, unknown keys, whole-list merge, and focus return.

#### `web/src/workspace/executors.ts`

- Keep validation pure and aligned with server limits.
- Add human labels and example/help metadata here only if doing so avoids copy drift between the
  dialog and tests; do not pretend the metadata is a server schema.

### Styling and design-system documentation

#### `web/src/styles.css`

- Reuse existing tokens only; add a token only with a demonstrated semantic gap and a call site.
- Add component-layer classes for readiness items, scope context, repository setup/master-detail,
  environment tabs/draft/removal state, and executor help.
- Use `--surface`, `--surface-raised`, and `--surface-sunken` according to the documented elevation
  ladder.
- Use status text plus existing status fills/edges; never color alone.
- Keep controls at the shared hit-area height.
- Add no new ambient animation.
- Add narrow-screen rules beside the component primitives, not as JSX utility classes.

#### `docs/design-system.md`

- Document every new class and primitive in the inventory.
- Record scope context, readiness items, editable configuration tables, dirty state, pending removal,
  and repository master/detail semantics.
- Keep `web/test/styles.test.ts` green: no color literal outside token blocks, no unused token, and
  no undocumented class.

### Product documentation

#### `docs/workspace.md`

- Move repository selection/status description from Settings → Workspace to Settings →
  Repositories.
- Keep orphaned checkout and executor truth current.
- Document the first executor's composer preselection without calling it a persisted default.

#### `docs/env.md`

- Update editor language from raw toggle to **Edit variables as .env**.
- Document dirty protection and pending-removal behavior only as UI behavior.
- Preserve current any-member organization/repository write policy unless server authorization is
  deliberately changed in the same PR.

#### `docs/repos.md`

- Document the inline repository setup surface, cached-list state, and distinction between
  installation availability and personal checkout selection.

#### `docs/api.md`

- No edit is required if request/response/status behavior is unchanged.
- Update it in the same PR if any route contract changes during implementation.

## Accessibility requirements

- Exactly one page-level `h1` on every Settings route.
- Readiness items use ordered headings and links whose accessible name states the destination or
  fix; no generic repeated **Fix** links.
- Scope and editability are readable text, not tooltip-only or color-only metadata.
- Environment tabs implement roving focus and ArrowLeft/ArrowRight/Home/End behavior.
- Every editable row input has a unique accessible name and associated error.
- Removal, undo, save success, and asynchronous checkout status changes have appropriate polite
  announcements; validation/server errors use an alert.
- Repository search has a visible label and clear action.
- Checkout checkboxes include the full `owner/name` in their accessible names.
- A repository table row is not itself an interactive control.
- Checkout status always includes text; queued, cloning, ready, and failed do not rely on lamp color.
- Table wrappers are named, keyboard-focusable regions when horizontal scrolling is possible.
- Dirty-navigation and executor dialogs trap focus, close safely on Escape, and return focus.
- On narrow screens, configuring a repository moves focus to the detail heading; on desktop it does
  not produce a surprising scroll jump.
- Disabled checkout controls expose the workspace-unavailable or 20-repository reason in visible
  text associated with the control group.
- Loading copy is not announced on every workspace poll. Announce meaningful transitions, not the
  polling mechanism.

## Responsive acceptance matrix

At every width:

- one `h1`, one coherent content order, and no clipped primary action;
- scope and permission text appears before its controls;
- dirty/error/success messages remain adjacent to the affected editor;
- tables either reflow deliberately or scroll inside a named region; the viewport never scrolls
  horizontally;
- dialogs fit within the viewport and keep actions reachable.

### Wide desktop, greater than 1100px

- Overview readiness items may use a two-column grid, but DOM order remains Organization,
  Workspace, Repositories, Executors, Environment.
- Repository setup uses a list/detail grid when both sides fit without compressing editable fields.
- Environment tables keep aligned columns and their save action near the table.

### Standard desktop/tablet, 701–1100px

- Overview may use one or two columns based on available content width.
- Repository list and configuration detail stack; do not squeeze them into narrow columns.
- Page-header actions wrap under the heading without overlapping status copy.

### Narrow, 700px and below

- Readiness items are one column.
- Repository summary, search, save action, list, and selected configuration follow DOM order.
- Editable environment rows reflow to labeled row groups if the table would make Name/Value inputs
  unusably narrow; action labels remain visible.
- Tab labels retain counts and do not truncate the only distinction between Variables and Secrets.
- Dialog actions stack with **Continue editing** first in focus order.
- Sticky actions are optional; if used, they must not cover the focused row or mobile navigation.

Test at least 1280×900, 900×800, and 390×844.

## Test plan

### Server route and database invariants

No new backend behavior is expected, but run the focused suites that protect the contracts this UI
depends on:

- `server/test/routes.env.test.ts`
  - member writes remain accepted for organization and repository scopes;
  - all secret reads remain nulled;
  - `UNKNOWN_REPO`, `UNAVAILABLE`, count, name, and value validation remain named;
- `server/test/routes.workspace.test.ts`
  - workspace-disabled response;
  - whole repository/executor list replacement;
  - `202` repository selection and clone-state response;
  - repository and executor ceilings;
  - on-demand executor configs only;
- `server/test/routes.repos.test.ts`
  - successful empty list versus cached last-good list with `meta.error`;
- `server/test-db/env-var-store.test.ts`
  - secret keep/delete semantics and precedence;
- `server/test-db/user-repo-store.test.ts`
  - personal selection, reselect/requeue, and orphan behavior;
- `server/test-db/user-executor-store.test.ts`
  - stored config and allowed type constraints.

If the implementation changes none of these contracts, do not rewrite server code merely to make
the slice appear full-stack.

### Readiness and page render tests

Add `web/test/settings-overview.test.tsx` and update `settings-pages.render.test.tsx`:

- `/settings` renders overview rather than redirecting;
- organization identity and role appear without internal IDs;
- each readiness rule and action target is correct;
- failed repository outranks queued/cloning in the summary;
- zero executors is neutral and names the deployment default;
- workspace root null is unavailable, not failed;
- environment empty is optional, not failed;
- initial loading does not render zero counts;
- initial error differs from error with last-good data;
- organization placeholder copy is gone;
- every page has the expected eyebrow/title/description and one `h1`.

Update `settings.wiring.test.tsx` to prove Overview, Repositories, Workspace, and Executors share the
same workspace hook instance and Overview starts no repository/config request.

### Scope and permission tests

Add focused render tests for `ConfigurationScope`:

- each scope label, impact, and editability sentence;
- environment precedence help;
- member organization/repository editors are writable under the current API policy;
- no disabled form masquerades as authorization;
- a future real read-only mode, if added server-first, renders readable values rather than disabled
  inputs.

### Repository selection tests

Replace `repo-picker.test.ts` with `repository-setup.test.ts` or equivalent:

- search is case-insensitive and does not mutate selection;
- hidden selected keys survive a save payload;
- temporarily unreported selected repositories remain visible and can be deselected;
- absent repositories cannot be newly enabled;
- the 20-repository ceiling disables only additional selections;
- summary counts distinguish available, enabled, ready, setting up, and failed;
- failed status includes its reason;
- root null disables checkouts but not repository configuration;
- dirty comparison ignores filtering and selected config identity;
- successful save adopts the baseline; failed save retains the draft;
- selecting a different repository invokes the dirty-editor guard;
- selected configuration is announced and its scope label includes `owner/name`.

Update `workspace.render.test.tsx` for the moved repository table and preserved orphaned list. Delete
modal-only tests when `RepoPickerDialog` is removed.

### Environment pure/render tests

Expand `env.render.test.tsx` and `env-raw.test.ts`:

- tabs expose roles, relationships, roving focus, and counts;
- counts include additions and exclude pending removals;
- a stored secret renders **Set**, no value, and **Leave blank to keep**;
- a new blank secret renders **Not set** and cannot save;
- a typed secret replacement says **Will replace when saved**;
- no secret appears in `.env` text;
- remove creates a pending row and Undo restores it;
- a blank unsaved row can be removed without a false pending-delete message;
- canonical dirty comparison covers values, additions, removals, and `null` secret keeps;
- save is disabled when clean, invalid, saving, or holding unapplied raw text;
- applying valid `.env` replaces only variables;
- invalid `.env` keeps text and does not mutate the table draft;
- canceling `.env` changes restores the seeded text/table draft;
- successful save adopts the echo and clears dirty state without remounting;
- failed save retains the draft;
- a member can edit organization and repository scopes under the current route policy.

Add blocker/dialog tests:

- route navigation proceeds when clean;
- dirty navigation opens one dialog;
- Continue editing cancels navigation and returns focus;
- Discard resets and resumes navigation;
- repository-detail switch uses the same contract;
- `beforeunload` is registered only while dirty and removed on cleanup.

### Executor tests

Update `executors.test.ts`, `workspace.render.test.tsx`, and dialog render tests:

- every supported executor type has a human label, honest help, and a safe example;
- Claude Code help says config is not currently consumed;
- OpenCode help says deployment CLI is authoritative and permission is ignored;
- first row is marked **Selected first on new tasks**;
- zero rows names the deployment default rather than an error;
- raw config remains absent from list/poll rendering;
- config fetch happens only when add/edit opens;
- JSON parse, object shape, name, type, size, duplicate, and count errors stay inline;
- edit action says **Save executor**;
- failure retains dialog input and success restores focus.

### Navigation and accessibility tests

Update `nav-model.test.ts`, `sidenav.test.tsx`, and shared dialog/tab tests:

- exact `/settings` is the parent Overview destination/current page;
- child settings routes expand the tree and mark only the child current;
- no duplicate Overview child appears;
- one `h1` per settings route;
- repository controls have full accessible names and no clickable-row nesting;
- tabs pass keyboard behavior tests;
- dialogs pass focus entry, Escape, outside-click, and focus-return tests.

### Browser and visual verification

Add or update `e2e/settings.spec.ts`, `e2e/env.spec.ts`, and `e2e/workspace.spec.ts`.

Drive real behavior:

- open `/settings` from the parent nav item;
- follow every readiness fix link;
- search repositories, enable/disable one, save, and observe queued/cloning/ready or the seeded state;
- select a repository configuration without changing its checkout checkbox;
- create a variable, switch tabs, remove/undo it, and save;
- open advanced `.env`, show a parse error, correct it, apply, and save;
- attempt navigation with a dirty editor and exercise Continue/Discard;
- add/edit an executor and verify type help changes without losing JSON;
- verify member-role environment controls are writable under the current API policy;
- verify signed-out deep links still render the login gate, not a 404.

Capture deterministic screenshots for this state matrix:

| State | Route/surface | Required evidence |
| --- | --- | --- |
| Populated | `/settings` | identity plus five readiness items and exact links |
| Sparse | `/settings` | no selected repos, no executors, no env; neutral versus attention states |
| Loading | `/settings` or `/settings/repos` | no false zero counts |
| Error with stale data | `/settings/repos` | cached rows retained with named warning |
| Empty | `/settings/repos` | successful zero-repository installation message |
| Read-only/unavailable | `/settings/repos` | root-null checkout controls with visible reason; do not fabricate member authorization |
| In flight | repository or environment save | locked affected controls and explicit progress copy |
| Validation error | environment advanced editor or executor dialog | input-associated error with draft retained |
| Removal undo | environment editor | pending-removal row and Undo |
| Narrow screen | overview and repository detail at 390×844 | no horizontal viewport scroll; correct focus/content order |

Use names such as:

- `settings-overview-populated.png`;
- `settings-overview-sparse.png`;
- `settings-repositories-stale.png`;
- `settings-repositories-empty.png`;
- `settings-repositories-saving.png`;
- `settings-env-validation.png`;
- `settings-env-remove-undo.png`;
- `settings-unsaved-dialog.png`;
- `settings-executor-help.png`;
- `settings-overview-narrow.png`;
- `settings-repositories-narrow.png`.

Inspect the images. A passing DOM assertion does not prove hierarchy, wrapping, or action
placement.

## Acceptance criteria

### Overview and navigation

- [ ] `/settings` renders Configuration overview and does not redirect.
- [ ] The Settings parent link reaches Overview; four child links remain Organization, Workspace,
      Repositories, and Executors.
- [ ] Organization identity and current role are visible without implying unsupported powers.
- [ ] Workspace, repository, executor, and environment states are derived from existing payloads.
- [ ] Every attention/unavailable item links directly to the page that can explain or fix it.
- [ ] Loading, empty, stale, error, and unavailable never collapse into a false zero/ready state.

### Scope and permissions

- [ ] Every editor names Organization, My workspace, or Repository · owner/name before controls.
- [ ] Impact and actual editor permissions are stated in plain language.
- [ ] Organization and repository environment remain writable by any member under the current
      server policy.
- [ ] No client-only disabled control is treated as authorization.
- [ ] Environment precedence is explained at each scope.

### Repository setup

- [ ] The Repositories page shows availability, personal enablement, checkout status, search, and
      configuration together.
- [ ] The summary says **n of m repositories enabled** only after both answers settle.
- [ ] Search never changes the full selection.
- [ ] Hidden or temporarily unreported selected repositories are never silently dropped.
- [ ] The 20-repository limit is explained before a failing request.
- [ ] Whole-selection save has dirty, in-flight, success, and retained-failure states.
- [ ] Per-repository configuration opens on the same page and does not require personal enablement.
- [ ] Workspace links to repository management and still exposes root/personal env/orphaned state.
- [ ] `RepoPickerDialog` and duplicate selection logic are deleted.

### Environment editing

- [ ] Variables and Secrets are accessible tabs with live counts.
- [ ] Editable rows have Name, Value/State, and Actions with unique labels.
- [ ] Stored secrets show Set and never reveal a value.
- [ ] Blank stored-secret input clearly means keep; new blank secret clearly means not set.
- [ ] Removal is pending until save and can be undone.
- [ ] Advanced mode is labeled **Edit variables as .env**, never exposes secrets, and applies
      explicitly.
- [ ] Dirty state is canonical, visible, and guarded for route/browser/repository switches.
- [ ] Save is adjacent, stateful, and preserves the draft on validation/server failure.
- [ ] Successful save adopts echoed rows without remounting the editor.

### Executors

- [ ] The page explains that deployment config chooses the runner CLI/image.
- [ ] Zero executors is a supported deployment-default state.
- [ ] The first executor is labeled selected first without claiming a persisted default.
- [ ] Claude Code and OpenCode help reflect their actual consumers and limitations.
- [ ] OpenCode permission configuration is explicitly described as ignored.
- [ ] Raw JSON remains precise and validated, but is not the dialog's only explanation.
- [ ] Executor config remains absent from polling and overview content.

### Responsive, accessibility, and quality

- [ ] Every settings route has one accurate `h1` and ordered section headings.
- [ ] Scope, status, selected state, and errors do not rely on color.
- [ ] Tabs, checkboxes, links, row actions, dialogs, and save controls work from the keyboard.
- [ ] Dialogs and narrow repository-detail transitions manage and restore focus.
- [ ] No tested width has viewport-level horizontal scrolling or hidden actions.
- [ ] Existing API, security, workspace, and environment invariants remain covered.
- [ ] Design-system docs and class inventory match the stylesheet.
- [ ] Required screenshots cover populated, sparse, loading, stale error, empty,
      unavailable/read-only, in-flight, validation, undo, and narrow states.

## Verification commands

Run focused feedback first:

```bash
npx vitest run web/test/settings-overview.test.tsx
npx vitest run web/test/settings-pages.render.test.tsx web/test/settings.wiring.test.tsx
npx vitest run web/test/repository-setup.test.ts web/test/workspace.render.test.tsx
npx vitest run web/test/env.render.test.tsx web/test/env-raw.test.ts
npx vitest run web/test/executors.test.ts
npx vitest run web/test/nav-model.test.ts web/test/sidenav.test.tsx
```

Run protected server invariants:

```bash
npx vitest run server/test/routes.env.test.ts server/test/routes.workspace.test.ts server/test/routes.repos.test.ts
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test \
  npx vitest run server/test-db/env-var-store.test.ts \
  server/test-db/user-repo-store.test.ts server/test-db/user-executor-store.test.ts
```

Run repository gates:

```bash
npm run build -w core
npm run typecheck
npm test
npm run lint
```

Run the real-browser matrix after the disposable databases and Chromium are available:

```bash
npm run verify:ui
```

Inspect every new/updated image under `artifacts/ui/` at full size.

## Suggested PR sequence

This is one product slice, but review and rollback are safer as four ordered PRs. Keep each PR
deployable and do not land a route that depends on a later data contract.

### PR 1 — Overview, scopes, and permission truth

- Add Settings Overview and pure readiness derivation.
- Replace `/settings` redirect.
- Add `ConfigurationScope`.
- Replace Organization placeholder.
- Remove false client-only admin disabling while preserving/pinning route policy.
- Add overview/scope/navigation tests and baseline screenshots.

### PR 2 — Repository setup consolidation

- Move checkout selection/status to Repositories.
- Add search, counts, draft/save lifecycle, ceiling help, and selected configuration detail.
- Simplify Workspace to root, personal env, and orphaned maintenance.
- Delete `RepoPickerDialog` and duplicate picker tests/styles.
- Update workspace/repos docs and browser coverage.

### PR 3 — Safe environment editing

- Add canonical drafts, counts, accessible tabs, pending removal/undo, and explicit advanced `.env`
  apply/cancel.
- Add route/browser/repository-switch dirty protection.
- Preserve secret masking and whole-list semantics.
- Update unit/render/browser tests and design-system inventory.

### PR 4 — Executor guidance and final visual matrix

- Add scope/default/deployment guidance to Executors.
- Add type-specific dialog help and examples.
- Complete stale, empty, in-flight, validation, unavailable, and narrow screenshots.
- Run full test/typecheck/lint/UI gates and inspect screenshots.

## Definition of done

Slice D is complete when a member can open Settings and answer, without understanding the backend
model:

1. which organization and personal workspace am I configuring;
2. which repositories are available, enabled for me, and ready;
3. which values affect everyone, only me, or one repository;
4. whether a secret is set without seeing it;
5. whether I have unsaved changes and how to discard or recover them;
6. what executor is selected first and what its type/config actually controls;
7. where to go to fix every attention or unavailable state.

The slice is not done if Settings still starts on a section by redirect, repository choice and
status remain split across pages, the browser claims permissions the server does not enforce,
secret values can be inferred or exposed, raw JSON/`.env` is the only explanation, dirty edits can
be lost silently, or the narrow layout hides the action needed to recover.
