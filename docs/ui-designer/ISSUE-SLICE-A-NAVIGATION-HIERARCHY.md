# [UI] Slice A — Rebuild navigation, task inbox, page hierarchy, and responsive shell

## Issue metadata

- **Type:** Feature / UX architecture
- **Priority:** P0
- **Size:** Large; land as the ordered PR sequence at the end of this issue
- **Areas:** Web, job-board read API, database query, responsive layout, accessibility, tests, documentation
- **Depends on:** None
- **Blocks:** Dashboard redesign, task composer redesign, task detail redesign, settings redesign

## Summary

Replace the current universal “Factory stats” topbar and unbounded task tree with a route-aware application shell, a compact global navigation, a dedicated task inbox, consistent page headers, and a real mobile navigation drawer.

This is an information-architecture change, not a visual reskin. It must make these questions answerable from every route:

1. Where am I?
2. Which organization am I acting in?
3. What needs attention?
4. What is the primary action on this page?

The task inbox must remain correct beyond the newest 50 run rows. The current browser-side thread reconstruction cannot provide stable counts or pagination, so this issue also adds an organization-scoped task-summary read endpoint with keyset pagination. Existing run/thread and mutation routes remain run-oriented.

## Problem statement

### Global context is misleading

`AppShell` renders `TopBar` on every authenticated page. `TopBar` always renders the heading **Factory stats**, the telemetry repository subtitle, a stats timestamp, and Refresh. The same telemetry heading therefore appears above Tasks, Settings, and Account even though those pages have different primary jobs and refresh models.

Consequences:

- Non-dashboard pages do not have a clear page-level heading.
- Telemetry freshness appears globally relevant when it is dashboard-only.
- The organization selector and identity controls are mixed with page-specific analytics controls.
- A cropped page cannot be identified without reading the sidenav.

### Navigation does not scale with task volume

While the user is under `/tasks*`, `AppShell` polls `GET /api/jobs?limit=50`, and `SideNav` renders every reconstructed Running and Need review task. The seeded screenshot already shows **Need review (38)** filling nearly the entire page height with visually similar rows.

Consequences:

- Work navigation is displaced by work content.
- Review triage has no search, filters, or room for meaningful metadata.
- A root task can disappear when it falls outside the newest 50 run rows; `taskSections()` deliberately ignores a follow-up when its root is absent.
- Counts describe only the fetched window, not the organization.
- Long queues make mobile navigation unusable.

### The layout has only one level of hierarchy

Most content is a bordered `.panel`. Page headings, filters, editors, placeholders, conversations, and analytics all sit in visually similar containers. The stylesheet has a responsive column collapse, but no mobile navigation interaction. Below 900px the full sidenav becomes a top region; a task tree of dozens of rows would appear before the page content.

## Goals

1. Give every application route exactly one accurate page heading and a visible primary action when one exists.
2. Keep organization switching and account identity global while moving telemetry-only metadata/actions onto the dashboard.
3. Keep global navigation bounded regardless of task count.
4. Add a dedicated, searchable, filterable, paginated task inbox.
5. Preserve the current task-thread grouping, status, ordering, and live polling semantics.
6. Preserve a single task-overview polling chain within the tasks area; do not create one poll per component.
7. Make the shell usable at 360px, 768px, 1024px, and 1440px widths.
8. Introduce reusable page/layout primitives that later slices can build on.
9. Preserve existing auth, organization scoping, degraded-state honesty, and accessibility behavior.

## Non-goals

- Redesigning dashboard cards or charts; only their page header/chrome moves in this slice.
- Redesigning the task composer fields or workflow validation; only route, page heading, and surrounding hierarchy change.
- Redesigning the task conversation, checks, or outcome sidebar; only the page-level task header and responsive placement change.
- Redesigning settings forms or environment editors.
- Adding Kanban, drag-and-drop, task assignment, bulk actions, notifications, or saved views.
- Adding light-theme controls, new animation, or an icon library.
- Changing job execution, queue claiming, Kubernetes/docker drivers, or runner behavior.
- Preserving `/tasks` as the composer route. This repository does not retain obsolete route shapes.

## Product and behavior constraints to preserve

- Telemetry and board data remain independent. A telemetry failure must not remove task navigation.
- The organization is still the scoping boundary for all task reads.
- Only thread roots appear as tasks. Follow-ups remain runs inside one conversation.
- A task’s section is determined from the newest run in the thread:
  - `queued`, `running`, or `standby` → Running.
  - terminal status with `doneAt === null` → Needs review.
  - terminal status with `doneAt !== null` → Past.
- A follow-up on a previously done task can move the task back to Running.
- Within a section, tasks sort by newest head activity, then root id descending as a stable tie-breaker.
- Status-lamp semantics do not change: running breathes green; stopping breathes grey; queued/standby is static grey; failed/dead is static red; succeeded/done is static green; stopped has no task dot.
- Task polling remains fast while anything can move and slows when everything is terminal.
- The last successful task response remains visible after a failed poll.
- `aria-current="page"` belongs to exactly one leaf route. A parent may look open without claiming to be the page.
- GitHub/open-mode differences remain unchanged. Controls that can never work must not render.

## Information-architecture decisions

### Route map

Change the tasks routes to the following. Update every caller and test in the same change; do not add a compatibility redirect for the old composer location.

| Route | Page | Primary action |
| --- | --- | --- |
| `/` | Usage overview | Refresh |
| `/tasks` | Task inbox | New task |
| `/tasks/new` | Task composer | Start task (existing Send behavior; copy can remain for Slice C) |
| `/tasks/:id` | Task detail | State-dependent existing task action |
| `/settings/organization` | Organization settings | Existing page action, if any |
| `/settings/workspace` | Workspace settings | Existing page action, if any |
| `/settings/repos` | Repository settings | Existing page action, if any |
| `/settings/executors` | Executor settings | Add executor |
| `/account` | Account | Existing page action, if any |

`/settings` continues to redirect to `/settings/workspace`. `/onboarding` remains outside `AppShell` and is unchanged by this slice.

### Global versus page-local chrome

The persistent shell contains only:

- Factory brand.
- Primary navigation.
- Organization selector.
- User menu.
- Mobile navigation trigger.

The following become page-local:

- Page title and description.
- Primary action.
- Telemetry repository coverage.
- “Data as of” timestamp.
- Refresh action.
- Task status, elapsed time, and task actions.

### Desktop navigation order

Use this order:

1. Dashboard
2. Tasks
3. Settings

Keep Account in the user menu. The order reflects observe → act → configure. Settings subsection links continue to render only while Settings is active.

## Target UX specification

### 1. Application shell

#### Desktop, greater than 900px

- Use a two-column shell: a 240px sticky sidebar and a `minmax(0, 1fr)` content column.
- Sidebar height is `100dvh`; its own contents may scroll, but normal pages must not increase its height.
- The main column begins with a compact global app bar, followed by the routed page.
- The app bar is sticky at the top, uses the raised surface, and contains the organization selector and user menu aligned to the end.
- The app bar does not contain an `h1`.
- Page content uses a shared `.page` container with a 1400px maximum width, consistent horizontal padding, and `min-width: 0`.
- Add a keyboard-visible **Skip to main content** link as the first focusable element in `AppShell`.
- The routed main region has a stable `id="main-content"` and receives focus only when explicitly navigated via the skip link; do not steal focus on ordinary client-side navigation.

#### Mobile/tablet, 900px and below

- Remove the persistent sidebar from layout rather than stacking it above content.
- Show a compact app bar containing:
  - Menu button with accessible name **Open navigation**.
  - Factory brand link.
  - User menu.
- Put organization switching inside the navigation drawer when horizontal room is limited.
- Open navigation in a Headless UI `Dialog` so focus trapping, Escape, backdrop click, and focus restoration are not reimplemented.
- Close the drawer after any navigation link is activated.
- The drawer shows top-level navigation, Settings sublinks when relevant, task counts, and New task. It does not render task preview rows.
- Use a 44px minimum touch target for menu, links, close, organization, and account controls.
- The page content must begin in the first viewport; no task list may render above it.

### 2. Global app bar

Replace `TopBar` with `AppBar`; delete the old component and old class names after callers/tests move.

Desktop contents:

- Organization selector, when its data is available.
- User menu, when the session check has completed.

Mobile contents:

- Navigation trigger.
- Factory brand.
- User menu.

Do not move organization membership data to a new endpoint in this slice. Continue using the current stats/meta source used by `OrgSelector`. Before it is available, reserve no empty interactive control; the user menu may render independently after the session check. Avoid layout shift with normal flex alignment rather than a fake disabled selector.

### 3. Page header primitive

Add `components/PageHeader.tsx` with an intentionally small API:

```ts
interface PageHeaderProps {
    eyebrow?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    meta?: ReactNode;
    actions?: ReactNode;
}
```

Required behavior:

- Renders a semantic `<header className="page-header">`.
- Renders exactly one `<h1>` for the page.
- Title and description occupy the leading column.
- Meta and actions are separate slots; actions do not become children of the heading.
- Actions wrap below title/meta at narrow widths without changing DOM order.
- The primitive does not fetch data, inspect routes, or know about Factory-specific pages.
- Empty slots do not leave blank wrappers.

Page-specific content:

| Route | Eyebrow | Title | Description/meta | Actions |
| --- | --- | --- | --- | --- |
| `/` | none | Usage overview | Exact repository coverage; selected range/scope remains in existing controls below; last successful stats timestamp | Refresh / Refreshing… |
| `/tasks` | none | Tasks | Running and Needs review counts; stale/error state if applicable | New task |
| `/tasks/new` | Tasks | New task | Short sentence explaining that the task runs in the selected workspace context | none outside the composer |
| `/tasks/:id` | Tasks | First line of root command | Status, task wall clock, live activity where applicable | Existing Stop/Done/Remove behavior |
| Settings pages | Settings | Organization / Workspace / Repositories / Executors | Scope/ownership sentence already available to the page | Existing primary action |
| `/account` | none | Account | Signed-in identity / mode | none unless already present |

Dashboard rules:

- Move `describeRepos()` out of `TopBar` into a reusable formatting helper.
- Render **loading…**, **no repositories configured**, or the exact repository names as today.
- Move the `data as of` timestamp and Refresh button into the dashboard `PageHeader`.
- Keep Range and Scope controls in their current row for now; Slice B will redesign that toolbar.

Task-detail rules:

- Move the current task title, status, wall clock, live activity, and action cluster out of the inner conversation panel into the page header.
- Keep callback behavior and confirmation behavior unchanged in this slice.
- Remove any duplicate inner title after the move.
- Do not redesign transcript, checks, follow-up composer, or sidebar until Slice C.

### 4. Compact desktop sidenav

The persistent sidenav must have a bounded DOM and height.

#### Top-level Tasks item

- The link goes to `/tasks`.
- Show count badges for Running and Needs review only when their values are greater than zero.
- Badge accessible names must include the meaning, for example **3 running tasks** and **38 tasks need review**; do not expose a bare number to assistive technology.
- Counts must come from the full organization task set, not the current inbox page or search.
- Do not use `aria-live` on polled counts; changing counts every three seconds must not interrupt screen-reader users.

#### Tasks-area expansion

Render this expansion only under `/tasks*`:

1. Pinned **New task** link to `/tasks/new`, always present even when there are no tasks.
2. Compact attention preview with at most five task rows total.
3. **View all tasks** link to `/tasks`.

Preview allocation:

- Include up to three Running tasks first.
- Fill remaining slots with newest Needs review tasks.
- If fewer than three Running tasks exist, use the remaining capacity for Needs review, up to five total.
- Never preview Past tasks.
- If the currently open task is Running or Needs review but outside the normal top-five selection, inject it and evict the last non-active preview. This keeps the active route visible without growing the list.
- If more tasks exist than are shown, render a plain summary such as **+12 more need review**; it links to the corresponding filtered inbox.

Each preview row contains:

- Existing semantic status dot.
- One-line task title.
- Author.
- Live activity summary only for a moving task and only when non-null.

Do not add row actions to the sidenav.

#### Settings expansion

Keep Organization, Workspace, Repositories, and Executors as conditional sublinks. Preserve the current rule that a parent looks active/open without incorrectly carrying `aria-current="page"` when a subsection is the page.

### 5. Task inbox

Add `pages/TaskInboxPage.tsx` at `/tasks`.

#### Header

- Title: **Tasks**.
- Description/meta: **N running · M need review**. Omit zero-valued clauses rather than reading “0 running · 0 need review”.
- Primary action: **New task**, linking to `/tasks/new`.

#### Filters

Use URL query parameters so filtered views are linkable and browser Back/Forward works:

| Query | Values | Default |
| --- | --- | --- |
| `state` | `attention`, `running`, `review`, `past` | `attention` |
| `q` | trimmed task-title search, max 200 characters | absent |
| `repo` | exact `owner/name` | absent |
| `author` | exact case-insensitive login | absent |
| `sort` | `newest`, `oldest` | `newest` |

UI behavior:

- State is a tab/segmented group: **Needs attention**, **Running**, **Needs review**, **Past**.
- Needs attention means Running plus Needs review; it is the default because it answers “what needs action?” without mixing in history.
- Search uses a labeled text field and an explicit submit action. Do not issue a network request on every keystroke.
- Repository uses selected workspace repositories plus the currently selected value, if it has disappeared from workspace configuration.
- Author is a text filter in this slice; do not build a separate people-directory endpoint.
- Sort is a labeled select.
- Changing state/repo/author/sort or submitting search resets loaded pages and removes any cursor state.
- Unknown query values clamp to defaults in the UI and are not sent to the API.

#### Rows

Use a semantic list with responsive grid rows, not a wide table that requires page-level horizontal scrolling.

Desktop row order:

1. Status mark and visible status label.
2. Task title as the link to `/tasks/:id`.
3. Repository.
4. Author.
5. Relative last activity, backed by `<time dateTime="…">` and a precise accessible/hover value.

Running tasks may add one live activity line beneath the title. Metadata wraps under the title on small screens. The entire title is the link; do not put nested buttons inside it.

Visible labels must distinguish workflow state and execution result. Examples:

- Running
- Queued
- Parked
- Stopping
- Succeeded · Needs review
- Failed · Needs review
- Stopped · Needs review
- Done

Color is supplementary; every state is present as text.

#### Pagination

- First page contains at most 30 task summaries.
- Use an explicit **Load more** button when `nextCursor` is non-null.
- Loading another page appends without moving focus.
- After append, update a polite status message such as **30 more tasks loaded**.
- Do not use infinite scroll.
- Disable Load more while its request is in flight and change its label to **Loading…**.
- An older-page failure leaves existing rows in place and renders Retry next to the failure.

#### Page states

1. **First load:** stable row skeletons or **Loading tasks…**; do not show the empty CTA first.
2. **Empty organization:** title plus **No tasks yet** and a primary **Start your first task** link.
3. **No filter results:** **No tasks match these filters** plus **Clear filters**; do not show the first-task CTA.
4. **Fetch error without data:** inline error block with Retry.
5. **Fetch error with data:** keep rows and show **Couldn’t refresh tasks; showing the last successful update.**
6. **Loading more:** keep existing rows.
7. **Task movement:** on the next poll, a task can move between Running, Needs review, and Past without a page reload.

## Task-summary API

### Why a new read model is required

The current `GET /api/jobs?limit=50` response is a run list. `taskSections()` reconstructs threads only from those rows. That cannot provide:

- Correct organization-wide task counts.
- A root for a follow-up whose root is outside the window.
- One row per task without overfetching runs.
- Stable task pagination.
- Server-side search/filtering across history.

Do not raise `LIST_LIMIT` and call the result scalable. Add a task-oriented read model while keeping job/run endpoints for audit threads and driver operations.

### Endpoint

Add a human-session route:

```text
GET /api/tasks?state=attention&q=&repo=&author=&sort=newest&limit=30&cursor=
```

Authentication and scoping:

- Accept the same person/org credential forms as `GET /api/jobs`.
- Never accept the shared worker token.
- Resolve `org_id` from the authenticated request; never accept an org id in the query.
- Return `503 JOBS_UNAVAILABLE` when the selected organization has no job board, matching existing job read behavior.

Query validation:

- `state`: one of `attention`, `running`, `review`, `past`; otherwise `400 BAD_TASK_STATE`.
- `q`: string, trim it, reject more than 200 characters with `400 BAD_QUERY`.
- `repo`: reuse `repoReason()` validation and `400 BAD_REPO`.
- `author`: string, trim it, max 100 characters; normalize case for comparison; invalid shape is `400 BAD_AUTHOR`.
- `sort`: `newest` or `oldest`; otherwise `400 BAD_SORT`.
- `limit`: integer 1–50, default 30; invalid is `400 BAD_LIMIT`.
- `cursor`: opaque base64url JSON issued by this endpoint; malformed, version-mismatched, filter-mismatched, or sort-mismatched values return `400 BAD_CURSOR`.

### Response contract

```ts
interface TaskSummary {
    id: string; // root job id; the route target
    command: string; // root command; UI derives the first-line title
    status: JobStatus; // newest run status
    cancelRequestedAt: string | null;
    doneAt: string | null;
    repo: string | null;
    executor: string | null;
    author: AuthorRef | null; // root author
    activity: string | null; // newest run live activity
    summary: string | null; // newest run terminal summary
    createdAt: string; // root creation
    activityAt: string; // newest of head created/started/finished/done stamps
}

interface TaskListResponse {
    navigation: {
        counts: {
            running: number;
            review: number;
            past: number;
        };
        running: TaskSummary[]; // max 3, newest first
        review: TaskSummary[]; // max 5, newest first
    };
    page: {
        items: TaskSummary[];
        nextCursor: string | null;
    };
}
```

Rules:

- `navigation.counts` and previews are organization-wide and do not change with `q`, repo, author, state, or sort filters.
- `page.items` obey all filters.
- Search is case-insensitive and matches the root command. Repository and author have dedicated filters; do not make `q` an undocumented global search.
- A task response contains no output body, gate output, session transcript, or secret-bearing runtime config.
- `nextCursor` is null when no additional row exists.
- Fetch `limit + 1`, return at most `limit`, and derive `nextCursor` from the last returned row.
- Cursor ordering uses `(activity_at, root_id)` and the comparison direction matches `sort`. Never use `OFFSET`.
- Encode cursor version, sort, normalized filters, `activityAt`, and root id so a cursor cannot silently be reused with different filters.

### Store/query semantics

Add a task-summary query to the job store instead of reconstructing task threads in the route.

Recommended shape:

1. Restrict every CTE/subquery by `org_id`.
2. Select root jobs (`id = root_job_id`).
3. Resolve the newest run per root with `ORDER BY created_at DESC, id DESC LIMIT 1`, matching `chainHead()`.
4. Join the root creator as the task author.
5. Compute `activity_at` from the same head timestamps currently used by `activityKey()`.
6. Derive section from the head status and head `done_at` exactly as `taskSections()` does.
7. Apply state/search/repo/author filters to the task summary, not individual runs.
8. Apply keyset cursor predicate and stable order.
9. Compute navigation counts from the full, unfiltered task-summary set.
10. Select navigation previews from the same derived set so preview and counts cannot disagree.

Do not edit an applied migration. Existing indexes include organization/root, status/created, repo/created, and creator/created. Run `EXPLAIN (ANALYZE, BUFFERS)` against a disposable test database with many threads and follow-ups. Add a new numbered migration only if the measured query needs another index; do not add a speculative index to this issue.

### Polling and frontend state

Add `web/src/api/useTasks.ts` for task-summary data. Keep run/thread types and `useThread()` in `useJobs.ts` unless a clean mechanical split is made in the same PR.

The hook must:

- Be instantiated once by `AppShell` and enabled only for `/tasks`, `/tasks/new`, and `/tasks/:id`.
- Accept normalized inbox filters from the current URL only when the exact route is `/tasks`; use default attention filters on composer/detail routes.
- Abort the prior request when disabled or filters change.
- Poll the first page every 3 seconds while `navigation.counts.running > 0`.
- Poll every 30 seconds when nothing can move.
- Use 15 seconds / 60 seconds respectively in a hidden tab, preserving the current cadence.
- Retain the last good response after a failed poll and expose an error beside it.
- Reset page data when filters change, but keep navigation data until the new response lands.
- Implement Load more as one-off cursor reads appended by task id.
- Refresh the first page immediately after queue, follow-up, done, stop, or remove succeeds.
- Never run a second task-summary poll from `SideNav` or `TaskInboxPage`.

`useThread()` remains a separate detail poll because it serves full conversation data and has a different 2-second/live-then-stop cadence.

## Implementation instructions by file

### Server/API

#### `server/src/db/job-store.ts`

- Add `TaskSummary`, `TaskListFilters`, `TaskNavigation`, and cursor-facing store types near the job list types.
- Add `listTasks(filters)` to the store interface and both PostgreSQL and in-memory implementations.
- Keep the SQL organization predicate inside every root/head/actor subquery.
- Reuse existing row mappers only when the shapes actually match; do not coerce a task summary into `Job` with synthetic fields.
- Keep title derivation in the web layer from the root command so the API does not introduce a second truncation rule.
- Add a pure bucket helper for memory-store parity and unit tests.

#### `server/src/routes/tasks.ts` (new)

- Register `GET /api/tasks` as a human read route.
- Parse/validate every query parameter before calling the store.
- Implement cursor encode/decode as small pure helpers with a version field.
- Return structured existing-style `{ error: { code, message } }` failures via the shared route helpers.
- Log unexpected store failure as **task list failed**, without logging query text that could contain a task prompt.
- Return exactly `{ navigation, page }` on success.

#### `server/src/main.ts`

- Register the tasks route beside the existing human job-board routes.
- Apply the same authentication requirement as the current job list/thread reads.
- Do not expose the route through worker-token authorization.

#### Documentation

- Update `docs/jobs.md` with the distinction between task summaries and run/job threads, bucket semantics, polling consumer, and cursor ordering.
- Update `docs/api.md` with the new route, query parameters, response, and 400 codes.
- If a measured index is required, add a new migration and update `docs/persistence.md` only if it introduces a new cross-cutting persistence rule.

### Web data/model

#### `web/src/api/useTasks.ts` (new)

- Define the response types above without importing server source.
- Implement normalization and serialization of inbox filters.
- Export a `UseTasks` shape containing navigation, first-page/loaded items, next cursor, initial/loading-more/refreshing states, error states, retry, loadMore, and refresh.
- Move queue/follow-up/done/stop/remove action access into a clearly named task action object or keep the current action methods on the shell context. Do not keep a polling `useJobs()` hook in parallel with `useTasks()`.
- After all callers move, delete the obsolete 50-run list poll and `LIST_LIMIT` from `useJobs.ts`; keep only types/thread behavior still used.

#### `web/src/task-tree.ts`

- Preserve `taskDotClass()` and any task-status formatting needed by list/detail UI.
- Remove browser-side thread grouping once no caller uses `taskSections()`.
- Move first-line title derivation to a pure `taskTitleFromCommand(command)` helper used by sidenav, inbox, and detail.
- Keep tests for lamp semantics and title normalization.

### Web shell/navigation

#### `web/src/App.tsx`

- Add `TaskInboxPage` as the `/tasks` index.
- Move `TaskComposerPage` to the `new` child route.
- Keep `:id` after the explicit `new` route for clarity even though React Router ranks routes.
- Update comments that still describe `/tasks` as the composer.

#### `web/src/components/AppShell.tsx`

- Replace `TopBar` with `AppBar`.
- Keep one `useTasks()` instance gated to the tasks area and publish it through `ShellContext`.
- Include current location search in normalized inbox filters only on exact `/tasks`.
- Own mobile drawer open/closed state here because both app bar and sidenav need it.
- Render skip link, desktop sidebar, app bar, drawer, and main outlet in stable DOM order.
- Preserve existing stats/session ownership; Dashboard still consumes stats through shell context and OrgSelector still receives its current data source.

#### `web/src/components/AppBar.tsx` (new; replaces `TopBar.tsx`)

- Implement only global controls described above.
- Reuse `OrgSelector` and `UserMenu`.
- Do not accept Refresh, stats timestamp, repo description, or page-title props.
- Provide the mobile menu trigger callback and expanded state.
- Delete `TopBar.tsx` once no caller/test imports it.

#### `web/src/components/SideNav.tsx`

- Accept task navigation summary rather than raw `Job[]`.
- Split pure preview selection into a tested helper so active-task injection and five-row maximum are deterministic.
- Change Tasks/New task/View all links to the new routes.
- Remove Past expansion and the unbounded Running/Review rendering.
- Preserve conditional Settings subnavigation and `aria-current` rules.
- Expose a callback used by the mobile drawer to close after navigation without changing desktop behavior.

#### `web/src/components/MobileNavDialog.tsx` (new)

- Use Headless UI `Dialog`/`DialogPanel`/`DialogBackdrop`.
- Render the same navigation model as `SideNav`, in compact mode, rather than maintaining a second route array.
- Do not render task preview rows in compact mode.
- Label the dialog **Navigation** and its close control **Close navigation**.

#### `web/src/components/PageHeader.tsx` (new)

- Implement the slot contract and responsive ordering defined above.
- Keep it presentational and render-to-static-markup friendly.

### Web pages

#### `web/src/pages/DashboardPage.tsx`

- Add dashboard `PageHeader` before existing controls.
- Move repository coverage, timestamp, and Refresh here.
- Keep telemetry/board degraded behavior and existing panel order unchanged.

#### `web/src/pages/TaskInboxPage.tsx` (new)

- Read task data/actions from `useTasksPage()`; do not instantiate the task hook.
- Parse and write URL filters through shared pure helpers.
- Render header, filter form, state tabs, rows, page states, and Load more behavior.
- Keep the component declarative; query normalization and fetch logic belong in `useTasks.ts`.

#### `web/src/pages/TaskComposerPage.tsx`

- Add PageHeader.
- Update success navigation only if needed; it should still navigate directly to `/tasks/:id`.
- Remove/rename the inner generic **Tasks** panel heading so the page does not contain two competing headings.
- Do not otherwise redesign composer fields.

#### `web/src/pages/TaskDetailPage.tsx` and `web/src/panels/TaskDetail.tsx`

- Derive PageHeader data from the loaded thread.
- Lift current head actions/status/clock/activity to the page level.
- Keep mutation callbacks in the page.
- After removal, navigate to `/tasks` (the inbox).
- Leave conversation and sidebar markup otherwise unchanged.

#### Settings and Account pages

- Add page headers with the labels in the route table.
- Keep existing panels/forms below them.
- Do not duplicate an inner panel title when it is only restating the page title.
- Keep read-only role explanations next to the affected editor; page headers do not replace them.

### Styling and design-system documentation

#### `web/src/styles.css`

- Replace `topbar` primitives with app-bar primitives.
- Add documented primitives for page, page header, navigation counts/preview, task inbox, filters, rows, mobile dialog, and skip link.
- Use only existing color tokens. If a genuinely missing semantic role is discovered, add it to both dark and light token blocks in the same change.
- Do not apply page padding/max-width through a global `main` selector; use `.page` so dialogs/nested main regions are not coupled accidentally.
- Keep `min-width: 0` on every grid/flex child that contains tables, task titles, or logs.
- Use the existing 900px shell breakpoint and 1100px task-detail breakpoint unless a screenshot demonstrates a specific failure.
- Add visible `:focus-visible` treatment to navigation links, menu buttons, task rows, filters, and Load more.
- Preserve the status lamp animation and semantic classes.
- Ensure all new body/navigation text is at least the normal body size; do not create new 10px navigation labels.

#### `docs/design-system.md`

- Update the shell/topbar/sidenav primitive descriptions.
- Add every new component and class family to the inventory required by `web/test/styles.test.ts`.
- Document desktop/sidebar and mobile/drawer behavior.
- Document PageHeader slot usage and one-`h1` rule.

## Accessibility requirements

- Exactly one page-level `h1` on every routed page.
- Persistent navigation uses `<nav aria-label="Primary">`.
- Settings subsections may use a nested list; task preview is a separate labeled list.
- Task state is always written as text in the inbox, never color/dot only.
- Count badges have meaningful accessible names and are not live regions.
- Mobile drawer traps focus, closes with Escape/backdrop/link activation, and restores focus to the trigger.
- The menu trigger exposes `aria-expanded` and `aria-controls` where supported by the chosen primitive.
- Skip link becomes visible on focus and lands on the main content region.
- All interactive elements have a visible focus state in both themes.
- Tab order follows visual order: global controls → page heading/action → filters → task rows → pagination.
- Loading/error updates use a polite status region only when initiated in the page. Background polling must not repeatedly announce.
- Relative times retain precise machine-readable `dateTime` values and accessible full timestamps.
- No hover-only information is required to identify route, task status, counts, or action consequences.
- At 200% zoom and 320 CSS pixels, no page-level horizontal scrolling is introduced.

## Responsive acceptance matrix

| Width | Required behavior |
| --- | --- |
| 1440px | 240px sticky sidebar; five-row maximum preview; app bar actions on one line; task inbox shows all metadata columns. |
| 1024px | Sidebar remains; page-header actions may wrap; task rows keep title dominant; no clipped controls. |
| 768px | Sidebar absent; app bar menu visible; drawer contains nav/counts but no preview; task metadata wraps below title. |
| 360px | Single-column page; 16px page gutters; 44px touch targets; filters stack; no page horizontal overflow. |

## Test plan

### Server route tests

Extend `server/test/routes.jobs.test.ts` or add `server/test/routes.tasks.test.ts` when separation makes the suite clearer.

Cover:

- Default attention query and response contract.
- Every state filter.
- Search, repository, author, and sort filters alone and in combination.
- Limit bounds and every invalid query error code.
- Malformed, stale-version, wrong-sort, and wrong-filter cursors.
- Human session/access-token authorization and worker-token refusal.
- Organization isolation.
- `JOBS_UNAVAILABLE` behavior.
- Navigation counts/previews remaining global while page filters change.
- Response omitting output/gates/runtime config.

### Database tests

Add `server/test-db/job-store.tasks.test.ts` using the shared destructive-test harness.

Cover:

- One summary per root with multiple follow-ups.
- Root command/author plus newest-head status/activity/summary.
- Running, review, and past bucket boundaries.
- Done task resurrected by a queued follow-up.
- Stable activity ordering and id tie-break.
- Forward pagination without duplicates or omissions.
- Oldest ordering with its own cursor direction.
- More than 50 interleaved runs where roots are older than the previous web limit.
- Repository, author, and search filtering at task rather than run level.
- Counts and previews across the complete organization.
- Cross-organization rows never contributing to count, preview, page, or search.

### Web unit/render tests

Update or add:

- `web/test/sidenav.test.tsx`
  - Top-level order.
  - Counts.
  - Five-row hard maximum.
  - Running-first allocation.
  - Active task injection.
  - No Past preview.
  - New task and View all routes.
  - Settings parent/leaf `aria-current` behavior.
- `web/test/task-tree.test.ts`
  - Keep title/status/dot semantics; remove obsolete client grouping expectations.
- `web/test/tasks.wiring.test.tsx`
  - One shell task-overview instance republished with workspace context.
  - Inbox does not instantiate another poll.
- `web/test/tasks.render.test.tsx`
  - Inbox rows and all page states.
  - URL filter controls.
  - Visible status text.
  - New composer route.
- New `web/test/page-header.test.tsx`
  - Slot omission.
  - Exactly one `h1`.
  - Action/meta ordering.
- Replace TopBar assumptions in `web/test/org-selector.test.tsx` with AppBar/dashboard header assertions.
- Update settings/account/panel render snapshots for one page heading and no duplicate inner title.
- Update `web/test/styles.test.ts` inventory expectations and keep token parity checks passing.

### Browser verification

Add `e2e/navigation.spec.ts` and update routes in `e2e/composer.spec.ts`.

Browser assertions:

- Dashboard, task inbox, composer, task detail, every Settings section, and Account expose the correct heading.
- Refresh/timestamp/repo coverage exist on Dashboard and nowhere else.
- Desktop sidenav never renders more than five task preview links even with at least 100 seeded tasks.
- Task inbox can find a task outside the former newest-50-run window.
- State filter, search, repository, author, sort, Back, and Forward work.
- Load more appends and keeps existing rows.
- At 768px and 360px, menu opens, traps focus, closes with Escape and navigation, and restores focus.
- No horizontal page overflow at all four target widths.
- Capture full-page screenshots for dashboard, task inbox populated, task inbox empty, task inbox filtered-empty, composer, task detail, Settings, and mobile drawer.

Read the screenshots. Passing DOM assertions alone is not visual acceptance.

## Acceptance criteria

### Navigation and hierarchy

- [ ] Every routed application page has exactly one accurate `h1`.
- [ ] The global app bar contains no telemetry-specific heading, timestamp, or Refresh action.
- [ ] Dashboard retains exact repo coverage, freshness timestamp, and Refresh behavior in its page header.
- [ ] Primary desktop navigation is Dashboard → Tasks → Settings.
- [ ] Global navigation height is bounded independently of task count.
- [ ] The desktop task preview contains at most five task links and never Past tasks.
- [ ] Running and Needs review badges reflect the full organization, not the current page/filter.
- [ ] `/tasks` is the inbox; `/tasks/new` is the composer; every internal caller/test uses the new routes.
- [ ] No obsolete route alias or duplicate composer path remains.

### Task inbox/data correctness

- [ ] The inbox shows one row per thread root.
- [ ] A root remains discoverable when its newest run is beyond the former 50-run window.
- [ ] Section classification and ordering match the current task-tree semantics.
- [ ] Needs attention, Running, Needs review, and Past views work through URL state.
- [ ] Search/repository/author/sort filters work across the full organization result set.
- [ ] Keyset pagination produces no duplicates or omissions.
- [ ] Background refresh preserves the last successful data on error.
- [ ] Only one task-summary polling hook exists in the tasks area.
- [ ] Detail thread polling remains independently scoped and stops when terminal as before.

### Responsive/accessibility

- [ ] Persistent sidebar is removed from layout at 900px and below.
- [ ] Mobile navigation is a focus-managed dialog and contains no task preview rows.
- [ ] Main content starts in the first viewport at 360px and 768px.
- [ ] No page-level horizontal overflow occurs at 360/768/1024/1440px.
- [ ] All task statuses are understandable without color.
- [ ] Skip link and visible keyboard focus work in dark and light token palettes.
- [ ] Background polling does not create repeated screen-reader announcements.
- [ ] Existing dialog, menu, and `aria-current` behavior remains correct.

### Repository quality

- [ ] `docs/design-system.md`, `docs/jobs.md`, and `docs/api.md` describe the shipped implementation.
- [ ] New files/classes are present in the design-system inventory.
- [ ] No applied migration is edited.
- [ ] No dead TopBar, old task-tree rendering, old `/tasks` composer assumption, or duplicate polling path remains.
- [ ] Offline unit tests, typecheck, lint, database tests, and browser verification pass.

## Verification commands

Run the cheapest checks first:

```bash
npx vitest run web/test/task-tree.test.ts web/test/sidenav.test.tsx web/test/tasks.render.test.tsx web/test/tasks.wiring.test.tsx web/test/page-header.test.tsx
npx vitest run server/test/routes.tasks.test.ts
npm run typecheck
npm run lint
npm test
npm run build
```

Then run database-backed coverage against a disposable `_test` database:

```bash
docker compose up -d timescale
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db
```

Finally run the browser suite and inspect generated images:

```bash
npm run verify:ui
```

If test filenames differ after implementation, keep the same coverage rather than creating placeholder files solely to match these commands.

## Suggested PR sequence

The issue is one product slice, but review and rollback are safer as four ordered PRs.

### PR 1 — Task-summary read model

- Store query and in-memory parity.
- `/api/tasks` route, validation, cursor helpers, auth wiring.
- Route and DB tests.
- Jobs/API documentation.
- No visible UI change.

### PR 2 — Task inbox and route migration

- `useTasks` and shell context.
- `/tasks` inbox and `/tasks/new` composer.
- Remove the obsolete 50-run list poll and client thread grouping.
- Compact task preview/count data wired into existing nav markup.
- Unit/render tests and composer E2E route updates.

### PR 3 — App shell and page hierarchy

- AppBar, PageHeader, route-aware page headings.
- Dashboard metadata/Refresh move.
- Task-detail page-head lift.
- Settings/Account headers.
- Delete TopBar and duplicate headings.
- Design-system documentation and render tests.

### PR 4 — Responsive navigation and visual verification

- Desktop shell sizing and bounded sidebar.
- Mobile drawer and skip link.
- Focus states, task-row responsiveness, overflow fixes.
- Four-width browser coverage and screenshots.
- Final dead-code/docs audit.

Do not merge a temporary compatibility route, duplicate task poll, or second navigation implementation between PRs. Each intermediate PR must compile and pass its updated tests.

## Definition of done

This slice is done when navigation remains compact with 100+ tasks, `/tasks` functions as a real triage inbox, every route identifies itself without the sidenav, telemetry controls appear only where they apply, mobile users reach content without crossing a task wall, and the implementation has one documented task-summary data flow with full route/DB/UI test coverage.
