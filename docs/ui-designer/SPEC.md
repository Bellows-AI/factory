# Factory — functional spec for UI design

This document describes **what the Factory web app does today**: every page, panel, control,
action, and the states each can be in. It is written for a designer producing new wireframes,
layout, and a visual language. It deliberately does **not** prescribe pixels, colors, or type —
those are yours. The one exception is the appendix, which records semantic conventions (status
colors, "a dash means unmeasured") that the interface's meaning currently depends on.

Everything here is grounded in the current implementation (`web/src`). Where the text says
"today" or "currently", that is a fact about the present build, not a constraint on your redesign.

---

## 1. Product overview

Factory is a self-hosted dashboard for teams that run **AI coding agents** (Claude Code, opencode)
against their GitHub repositories. It has two functional halves:

1. **Telemetry dashboard** — usage analytics over agent sessions: token consumption, session
   counts, edit-acceptance ratio, per-task cost, per-user attribution. Data arrives from agents'
   OpenTelemetry metrics and is scoped to organizations and repositories.
2. **Task board** — members queue coding tasks for agents. Each task runs in an isolated
   checkout (git workspace), streams its live output into the browser, can be followed up like a
   chat conversation, and ends with a verdict (Done / Stopped) and, when the run published one, a
   branch and pull request.

The two halves are independent data sources and the UI says so: telemetry panels and board panels
degrade separately, and the board keeps working when telemetry is down.

### Glossary

| Term | Meaning |
| --- | --- |
| **Organization (org)** | A GitHub App installation. Members sign in with GitHub; the orgs they can see are the installations they belong to. Everything is org-scoped. |
| **Member / Admin** | The two roles inside an org. Admins write org-wide and per-repo configuration; members see those read-only, with a sentence saying why. |
| **Workspace** | A directory holding git clones of the org's selected repositories. Agents run inside it. |
| **Repository** | A repo checked out into the workspace. The org picks which ones. |
| **Executor** | A named runner configuration — what actually executes the agent (e.g. a CLI plus model config). Members add/edit these. |
| **Task** | One conversation with an agent, started from a prompt. A task is stamped with a repository, an executor, and optionally a workflow. |
| **Run (turn)** | One delivered prompt's execution. A follow-up creates a new run; a task's history is a chain of runs (root + follow-ups) rendered as one conversation. |
| **Workflow** | A named, parametrized process a task can walk (scoped per repo / user / org). Declared parameters must be filled before the task can start. |
| **Checks (gates)** | Verification steps a run reports: name, status (passed / failed / running), exit code, output. |
| **Telemetry vs board data** | Telemetry = OTEL-derived usage statistics. Board = the task system's own audit rows. Panels label which source they speak for. |

---

## 2. User model and entry flows

### 2.1 Authentication modes

Two modes a deployment can run in; the UI adapts in specific, visible ways (see "Open-mode
variations" under §6):

- **GitHub mode** (production): sign-in is GitHub OAuth. The organizations a person can see are
  the App's installations. Roles come from org membership. A first sign-in passes through the
  onboarding screen (§2.3).
- **Open mode (`AUTH_MODE=none`)**: no authentication — one local org, everything attributed to a
  stand-in account. There is no sign-in screen and no way to end a "session". Personal/token
  features are hidden because nothing would honour them.

### 2.2 Login screen

Shown instead of the app to anyone without a session. Functionally minimal:

- Product name, one explanatory sentence ("Sign in with GitHub. The organizations you can see are
  the App installations.").
- A single **Sign in with GitHub** button.
- An error line when the OAuth round trip came back with a reason. Known reasons, each with its
  own human sentence: sign-in cancelled; link expired; GitHub unreachable; no installation found
  for the account ("Install the App, then sign in again"); returned without installing.

Design note: the screen must render before any data exists — it is the only thing a signed-out
visitor ever sees.

### 2.3 Onboarding — "Choose what to track"

The step between GitHub sign-in and the first session. Purpose: pick which of the caller's
installations (orgs) this dashboard tracks, and optionally narrow each org to specific
repositories.

- A centered panel titled **Choose what to track**, addressed by display name.
- **Org checklist** — one checkbox per installation. Everything arrives pre-checked (a returning
  user arrives with their stored choice pre-checked). Continue is disabled while nothing is
  checked, with the sentence "Choose at least one organization to sign in."
- **Per-org repository narrowing** — a checked org expands to a "Repositories" disclosure that
  lazy-loads the repo list on first open (loading state per org). Repos render as checkboxes,
  seeded from the org's stored narrowing intersected with the live list. Sub-rules worth knowing:
  - Untouched orgs keep "track everything, future repos included".
  - Unchecking every repo of a *touched* org is refused with a sentence: "At least one repository
    stays tracked. Deselect the organization instead to track none of it."
  - If listing is unavailable for an org, a sentence says everything it reports will be tracked.
- **Continue** submits and enters the app (button label becomes "Signing in…" while in flight).
- Failure states: expired pending sign-in (a "Start again" link that restarts OAuth, carrying the
  original destination); a repo list that changed mid-selection (lists refresh, error explains,
  user reviews and retries); a save refusal when a chosen org's repos couldn't be listed.

---

## 3. Global chrome

The app is a two-column shell: a **sticky left sidenav** and a scrolling **main column** topped
by a **topbar**. Both are present on every page except the login and onboarding screens.
Responsive today: below ~900px the sidenav becomes a static bar across the top (items in a
horizontal row); below ~1100px the task page's two columns collapse to one.

### 3.1 Sidenav (left)

- Brand at top: "Factory".
- Three top-level items: **Dashboard** (`/`), **Settings** (`/settings`), **Tasks** (`/tasks`).
  The current page is marked; a parent section is "open and lit" without claiming to be the
  current page when one of its children is.
- **Settings sub-links** (Organization, Workspace, Repositories, Executors) render only while the
  member is inside the settings area — navigation for the section you're in, not a permanent
  second table of contents.
- **Task tree** under Tasks, rendered only while inside the tasks area:
  - A pinned **"+ New task"** link (opens the composer; never displaced by activity ordering).
    It renders only when the board holds at least one task — the zero-tasks state is the
    sentence "No tasks yet" with no link (the Tasks nav item itself opens the composer).
  - Three automatic sections, computed from live task state — nothing is arranged by hand:
    **Running (n)**, **Need review (n)**, **Past tasks (n)**. "Past" is collapsed behind a
    toggle until the reader opens it, so history can't push live work off screen.
  - Each row: **status dot + title + author + (while running) a live activity summary line**.
    Only thread roots are listed; a follow-up never becomes a second row.
  - Rows are links into `/tasks/:id`; the active task is marked.
  - Empty states are sentences: "No tasks yet", "Nothing running", "Nothing to review",
    "No past tasks".
  - A task finishing simply moves it from Running to the top of Need review — the tree is always
    the same in every open browser.

### 3.2 Topbar

Left side:

- Page heading "Factory stats" with a subtitle that **names the exact repositories** the figures
  cover (e.g. `acme/{api, web} — AI usage telemetry`), or "no repositories configured", or
  "loading…". Repos are named, never counted — the numbers below are only interpretable if you
  know what went into them.

Right side (a control cluster):

- **Org selector** — a dropdown of the orgs the member belongs to; switching is a full page
  reload (every org-scoped read re-probes). In open mode it is disabled with an explanatory
  tooltip: "This deployment reports on one organization. Sign in with GitHub to see the
  installations you belong to."
- **"data as of" timestamp** of the last successful stats fetch.
- **Refresh** button — disabled while refreshing, label becomes "Refreshing…". The only action
  button in the bar; it stays in the far corner.
- **User menu** — avatar (or an initial chip when no avatar), login name, opens a small menu:
  **Account**, and **Sign out** (absent in open mode). Hidden entirely until the session check
  answers, so an empty chip never flashes.

---

## 4. Pages

### 4.1 Dashboard (`/`)

The analytics surface. Structure top to bottom:

**Controls row**

- **Range selector** — a segmented radio row: Today / This week / Two weeks / Month / All time /
  Custom. Custom reveals from/to date inputs (bounded: from ≤ to ≤ today). A custom range with no
  dates yet behaves as All time and says so ("pick a date — showing all time until then").
- **Scope toggle** (GitHub mode only) — segmented **Org / Me** beside the range selector. It
  does not render at all in open mode rather than rendering disabled.

**Status banner** — one line, only when meaningful: "Preparing telemetry…" / "Waiting for
telemetry…" while the first read lands; on error, the error plus "showing the last successful
fetch below." Quiet when everything is fine.

**Panels** (each is a titled card; telemetry panels share a frame with an explanatory blurb):

1. **AI usage summary** — five stat cards:
   - input tokens (note: how much was read from cache),
   - output tokens (note: cache writes),
   - agent sessions (note: the repo filter, or "synthetic fixture data"),
   - active session time (note: excludes idle),
   - file edits accepted, % (note: lines written, or "lines written not recorded" for
     backfilled history).
2. **AI token usage** — the main chart: stacked bars (input / output) per **day** up to ~92 days
   of window, per **ISO week** beyond (the payload names its granularity and the blurb repeats
   it), with a line overlay for sessions started on a right axis. Legend with swatches.
   Explanatory blurb (why cache reads are excluded from bars; quiet days kept; last bucket
   partial). Empty state: "No sessions in the coverage window yet. Start a Claude Code session in
   …".
3. **Per-task usage** — four distribution cards: **Tokens / Runs / Agent turns / Wall clock per
   task**, each showing avg · p50 · p95 plus "N tasks measured" (a p95 over five tasks must not
   masquerade as a settled statistic) and a one-line definition (what counts as a run; what is
   excluded). Empty state: "No attributed tasks in this range yet."
4. **Usage by user** — a table: User (avatar + name), Sessions, Input, Output, Cache read,
   Cache writes. Attribution is resolved by joining sessions to board tasks. Empty state.
5. **Recently completed** — the board's finished tasks, newest first, one row per task thread:
   Task (the agent's closing summary, or the command's first line), Status, Author, Context
   tokens, Wall clock, Finished. This panel is **independent of telemetry** and renders even when
   telemetry is down — it is the degraded-mode surface of the page. States: loading / board
   unreachable / "No completed tasks yet."

**Visibility rules a redesign must preserve:**

- When the deployment has telemetry switched off, panels 1–4 are **absent entirely** — no empty
  frames for a feature nobody enabled.
- When telemetry replays synthetic data, every telemetry panel wears a loud **"synthetic fixture"
  badge** — invented numbers must never pass as real.
- When the telemetry store is unreachable, panels render their frame with a reason line and no
  numbers — never dashes (a dash reads as "measured, unavailable"; nothing was measured).

### 4.2 Tasks — composer (`/tasks`)

The tasks area's index: where a task is written and started. The task list itself lives in the
sidenav (§3.1).

**Composer panel "Tasks"**:

- A large prompt **textarea** ("Describe the task…"); **Cmd/Ctrl+Enter** submits.
- A control row of three dropdowns, each with a visible "none" option:
  - **Repository** — the member's selected repos. Defaults to the first selected repo until the
    member explicitly picks none/other; an explicit "none" sticks, while a repository that
    disappears from the list clamps back to the first.
  - **Executor** — configured executors; same first-is-default and clamp rules.
  - **Workflow** — rendered **only if the board serves workflows at all** (otherwise the
    composer looks exactly as before the feature existed). Nothing auto-selects a workflow: no
    choice means the prompt runs verbatim. Options collapse to the effective definition per name
    (repo beats user beats org scope).
- **Send** (primary). Disabled — with reasons surfaced, not hidden — while: the draft is empty,
  a send is in flight, or a chosen workflow's parameters aren't valid yet.
- **Workflow parameters** — choosing a workflow with declared parameters renders one labeled
  input per parameter beneath the row. Invalid values are marked per-field (with screen-reader
  hints), and a live line names what's still blocking: `needs: issue (must match \d+), lang`.
  Values are capped (512 chars) and pattern-validated as you type; switching workflow or
  repository clears the draft rather than carrying stale values into another process.
- Errors from a refused send render in place above the composer.
- Loading state: "Loading your workspace…" with an inline **Retry** when the workspace poll
  failed (repos/executor lists come from it).
- On success the app navigates straight to the new task's detail page.

### 4.3 Task detail (`/tasks/:id`)

One task, whole: the follow-up chain rendered as **one conversation**, plus a status sidebar.
Any run's id resolves to the same view. Two-column layout on wide screens.

**Head row**

- Title: `Task - <first line of the root command>`.
- **Wall clock** readout — the board-banked execution time for the whole thread, ticking live
  while the newest run goes; a dash for a task that never ran.
- Actions, all at the top (the transcript itself carries no controls):
  - **Stop** while running (becomes a "Stopping…" pill once the stop is requested and the run
    hasn't settled; "stopped by <login>" appears on the run once settled).
  - **Done** when the newest run is finished and nobody has closed the task yet ("done by
    <login>" afterwards).
  - **Remove** whenever the thread isn't running — behind a confirmation ("Remove this task?
    Every run of the thread and its worktree are deleted."), then navigates back to the
    composer.
- The **live activity line** (what the agent is doing right now) under the head, when running.

**Conversation** — one exchange per run, oldest first. Each exchange:

- The **prompt** (full text, as asked).
- A **meta line**. On history runs: status pill, workflow node, executor, done, exit code. On
  every run: stopped-by / stop-requested-by and done-by attributions when present; created time;
  context size and cost when the run reported them (`ctx 90,433 tok · $0.1234`); a "parked"
  marker on standby runs. (The newest run's status deliberately does not repeat here — the
  sidebar is the one status surface for the live run.)
- The **detail block**:
  - While running: sampled **container vitals** as pills — `cpu 167%`, `mem 512 MiB (12%)` —
    rendered only while they're actually readable (no lying zeros).
  - **Checks** — a collapsible list when the run reported gates: summary line with counts
    (`3 passed / 1 failed / 2 running` as tinted pills), one row per gate (name + status pill +
    exit code), each expanding to the gate's raw output.
  - **Output** — the run's raw output in a bounded-height scroll well (~320px max; never
    rendered as HTML). While the newest run is live it auto-scrolls to follow the tail.
    Finished runs with no output say "No output recorded."; a run with no output yet — queued,
    or running before the first tail arrives — says "Waiting for the executor…".

**Follow-up composer** at the bottom, offered exactly when the newest run is finished, the task
isn't closed, and the run has an agent session to continue (otherwise an explanatory sentence
appears instead: the run cannot take a follow-up; queue a new task). Textarea ("Describe the
adjustment…") + Send; the follow-up appears as the newest message of the same conversation; no
executor choice — it inherits the run's.

**Status sidebar** — one status surface for the whole thread:

- Pills: current status, executor, done, exit code.
- Key–value list: **Queued by** (avatar + name, or "unknown"), **Workspace** path, **Context**
  (newest closed turn's tokens), **Cost** (summed over turns; the value stays blank when nothing
  was billed), **Task** (live activity, while running), **Running time** (none while
  queued/parked).
- **Services** section (when the run reported service containers): name → last observed state.
- **Connections**: **Issue** `#n` parsed from the task's command; **PR** — the branch the driver
  published, linked when a URL exists; **PR state** is a literal "—" today (no source records
  it) — a deliberate honest gap.

### 4.4 Settings (`/settings/…`)

The organization's settings tree: one sidenav item, four sections. Layout default is the
Workspace section. Shared vocabulary: every section stacks titled panels; async regions have
loading/error sentences; env editors are admin-editable and member read-only with a sentence
saying who configures it — except "My workspace", which is each member's own scope to edit.

#### 4.4.1 Organization (`/settings/organization`)

- A stub panel: "Organization settings are not built yet." — the honest placeholder, kept so the
  section exists.
- **Core (organization) environment editor** — the env scope injected into every runner in the
  deployment. Admins edit; members see it read-only with the hint "An admin configures the core
  environment; it is shown here read-only."

#### 4.4.2 Workspace (`/settings/workspace`)

- **Workspace panel** — states where checkouts live ("Your checkouts live at `<path>`. Agents
  you start run here.") and the **Select repositories** button (opens the picker dialog).
  If the deployment has no workspace root configured, this panel (and the ones below) are
  replaced by one sentence saying so (`ORG_WORKSPACE_ROOT`) — a deliberate configuration, not an
  error.
- **Repositories table** — one row per selected repo: Repository, **Status pill** (with the
  clone lifecycle: queued / cloning / ready / failed + the failure reason travelling in the
  pill), Branch, Last commit (date; hover shows the commit headline), Size. Absent cells render
  an em dash, never zero.
- **Empty state** — "Nothing checked out yet. Choose repositories and they are cloned in the
  background."
- **Still on disk** — a panel listing orphaned repos (deselected but not deleted, because they
  may hold uncommitted work): makes disk growth visible on the page.
- **Repo picker dialog** (modal): title "Select repositories", one explanatory line, a **filter
  input** (`owner/name`), a scrollable checkbox list of every repo the installation reports
  (most recently pushed first; private repos marked), a running "**N selected**" count, and
  **Save** (whole-selection replace; disabled until the list has actually loaded) beside **Not
  now** — no Cancel button; Escape and a click on the backdrop close. States: loading, GitHub
  unreachable, a cached-list notice ("Showing a cached list: …"), and the dead-end empty state
  ("This GitHub App is not installed on any repositories yet. Ask an administrator…"). The
  dialog auto-opens on the first visit when nothing is selected — only then; dismissal is
  remembered for the page view.
- **My workspace env editor** — the member's own defaults, applied to every task they queue.
  Always the member's to edit.

#### 4.4.3 Repositories (`/settings/repos`)

- **Available repositories** — every repo the installation reports, as a list with a "private"
  pill where applicable. States: loading, "Could not reach GitHub: …", the cached-list notice,
  "No repositories reported yet.", and the not-installed-on-anything sentence.
- **Per repository env editor** — a repository select (chosen from scopes that have env rows plus
  the installation list) above an env editor for that repo's scope. Admin-editable; member
  read-only with the sentence. Switching repos swaps the editor.

#### 4.4.4 Executors (`/settings/executors`)

- **Executors table** — Name, Type pill, Added date, and an **Edit** action per row; plus
  **Add executor**. Empty state: "No executors configured."
- **Executor dialog** (modal, add or edit): **type** select, **name** input, **config (JSON)**
  textarea — validated live on every keystroke with the error rendered under the field (raw JSON
  paste is only usable because the message appears before Save is pressed). Cancel / Add-Save;
  the save replaces the whole list. A row that vanished elsewhere while the panel sat open gets
  a sentence (`"main" no longer exists — refresh the page.`) instead of silently confirming the
  delete.

### 4.5 Account (`/account`)

The member's own page — reached from the topbar user menu, deliberately outside the settings
tree (settings are the organization's). Stacked panels:

- **Account / identity** — large avatar (or initial fallback), display name, a role sentence
  ("Administrator / Member of this organization"). In open mode instead: a sentence explaining
  everything is attributed to a local stand-in account. Key–values: Login (linked to GitHub when
  real), Name, GitHub id, Role, First seen, Member since, Account created, Last sign-in,
  Workspace path.
- **Tracked organizations** (GitHub mode) — a sentence listing the tracked orgs, a sentence
  explaining the choice can only be changed by re-running GitHub sign-in, and a
  **Change what you track** button that restarts OAuth into the onboarding screen pre-checked
  with the stored choice.
- **Personal access tokens** (GitHub mode) — create form (label input + **Create token**) and a
  table: Label, Created, Last used, Revoke. **The minted token is shown exactly once**, in a
  highlighted block with a **Copy** button and **Done**; the plaintext never renders again (only
  its hash is stored; a lost token is revoked and reissued). States: loading / "No tokens." /
  failure line.
- **Organization access tokens** (GitHub mode) — same UI for admins; members see the single
  sentence "Organization tokens are minted by an administrator."
- In open mode everything but the identity panel is absent.

---

## 5. Shared components inventory

The recurring units a wireframe will assemble. (Names are functional, not CSS.)

| Component | Where used | Behavior worth preserving |
| --- | --- | --- |
| **Panel** | every page | Titled card; optional action cluster in the head; optional warning/error tint on the edge. The universal container. |
| **Stat card** | dashboard, per-task usage | Big figure + label + one-line note. Distributions show `avg · p50 · p95` plus "N tasks measured". |
| **Data table** | by-user, recent tasks, workspace repos, executors, tokens | Horizontally scrollable wrap, never shrinking columns. A shared `DataTable` with optional column sorting exists as a primitive but is unused today — panels hand-roll their tables. |
| **Environment editor** | settings ×3 scopes | Two tabs — Variables / Secrets; `raw` toggle swaps the table for a `.env` textarea (strict parse on toggle-back, errors in place); secret values are write-only ("set — leave blank to keep"); whole-list save with "Saved." confirmation; read-only mode for members on admin-owned scopes. |
| **Key–value list** | sidebars, identity, services | Definition grid; absent values render blank beside their label — never a dash, never a zero (§8). |
| **Pills / status chips** | task meta, gates, repo status, executors | Loud inline state; variant for failure reasons; tinted variants for passed/failed/running gates and stop/done verdicts. |
| **Status dots** | sidenav task tree | One dot per task; semantic states (appendix); the alive states breathe (running and stopping). |
| **Status lines** | everywhere | One-line feedback: info (`status`), error (`error`), neutral secondary (`muted`), panel-level alert. |
| **Badge** | telemetry panels | Reserved for the "synthetic fixture" marker — loud by design. |
| **Buttons** | everywhere | Default + `primary` marking the main action. In-flight labels swap ("Refreshing…", "Saving…", "Stopping…", "Signing in…", "Creating…"). Note: more than one primary can coexist on a page today (e.g. "Select repositories" and the env editor's "Add variable" on the Workspace section) — "one primary per view" is an aspiration the current UI does not fully hold. |
| **Segmented radio rows** | range presets, scope toggle | Button-like radios with a marked active option. |
| **Date inputs** | custom range | Native date pickers, mutually bounded. |
| **Dropdown select (listbox)** | composer repo/executor/workflow, org selector | Anchored popover of options; keyboard-navigable; selected/focused states. |
| **Combobox picker** | repo picker list | Search-filtered option list. |
| **Modal dialog** | repo picker, executor editor | Backdrop overlay, centered panel, focus trap + restoration, Escape and outside-click close. No page underneath stays interactive. |
| **Popover menu** | user menu | Small anchored menu; closes on pick and on navigation. |
| **Avatar** | topbar, tables, sidebars, identity | Image with an initial-letter fallback at several sizes. |
| **Bar chart** | token usage | Stacked series + optional line overlay (right axis), legend with swatches, gridlines, thinned x labels. |
| **Horizontal bar / scatter / histogram** | available primitives | Exist as chart primitives; unused on any page today — available to a redesign, not load-bearing. |
| **Empty / loading / error sentence** | every async region | Every region that can be empty, loading, or failed says which, in words, in place. |

---

## 6. States to design for

Every one of these occurs somewhere today and needs an intentional treatment.

1. **First load** — nothing has answered yet: subtitle says "loading…", panels wait, no flash of
   an empty state that would read as a bug.
2. **Refresh** — the dashboard's telemetry figures do not silently update: once a read lands it
   stays until the member changes range/scope or presses Refresh; the "data as of" stamp is the
   honesty device. The **Recently completed** table is the exception — board data, and it
   quietly refreshes itself every 30s. Tasks pages are the same exception (§7).
3. **Fetch error with data** — banner: the error plus "showing the last successful fetch below."
4. **Degraded mode** — telemetry down, board up: dashboard hides telemetry panels, keeps
   "Recently completed".
5. **Empty** — no sessions in range; no attributed tasks; no users; no tasks yet; nothing running;
   no tokens; no repos reported; no output recorded; nothing checked out.
6. **Read-only** — a member viewing admin-owned scopes (core env, per-repo env, org tokens):
   editor disabled **plus the sentence saying who configures it**.
7. **In-flight actions** — every mutating control disables itself and says so.
8. **Destructive confirm** — task Remove (native confirm dialog today).
9. **Refused actions** — errors render in place near the control that caused them, never as
   toasts-only, never silent.
10. **Long content** — run output in scroll wells; tables scroll horizontally; long titles clip
    (tooltip carries the full text); the prompt line clamps at 120 chars with an ellipsis in
    list contexts.

### Open-mode (`AUTH_MODE=none`) variations, summarized

- No login gate; no Sign out in the user menu; identity panel explains the stand-in account.
- No Org/Me scope toggle (the filter would be unanswerable); org selector locked with a tooltip
  explanation; no token panels; no tracked-orgs panel.
- The rule behind all of these: **a control that can never work must not render** — absence is
  the honest shape, not a disabled control.

---

## 7. Data refresh model (behavior the design must accommodate)

Each surface has its own cadence, and the differences are deliberate:

- **Dashboard stats** — fetched once per range/scope selection; **not** continuously polled.
  While the server is still computing a cold read, the page re-checks every 2s and shows a
  progress line ("Preparing telemetry…"); the first complete answer settles it. The manual
  **Refresh** button forces a server-side re-fetch and re-read. The "data as of" timestamp
  anchors freshness.
- **Recently completed** (dashboard) — a separate, slower poll of the board's finished tasks:
  every 30s (60s in a hidden tab), torn down when the member leaves the dashboard. The
  statistics figures stay put; this table keeps itself current.
- **Task list** (sidenav tree) — polled only while the member is in the tasks area: every 3s
  while anything on the board can still move (queued/running/parked), slowing to a 30s floor
  once everything is terminal — it never stops outright, because the board is shared and another
  member's new task must appear on its own. A failed tick shows its error and retries.
- **Task thread** (detail page) — polled every 2s while any run in the conversation is live,
  and **stops entirely** once every run is terminal: a finished conversation changes only by
  the member's own follow-up, and sending one re-arms the poll.
- **Live output** arrives as polled tails, so the output well's auto-scroll is the "streaming"
  experience.
- **Workspace** reads poll only while something is unsettled (a clone in flight) and stop once
  settled.
- **Hidden tabs throttle**: every poll slows (15–60s depending on surface) while the tab is in
  the background — a deliberate battery/courtesy behavior.
- The org switch and sign-in completion are full page loads by design (every cache re-probes).

---

## 8. Appendix — current semantic model (constraints worth preserving)

These are conventions the interface's *meaning* currently rides on. A redesign may restyle all
of it, but breaking these silently changes what users read:

- **Lamp semantics** — one color family carries state everywhere (dots, pills, chart marks).
  As rendered today on the sidenav's task dots: **green, breathing = running**; **grey,
  breathing = stopping**; **grey, static = queued / parked (standby)**; **red, static =
  failed / dead**; **green, static = succeeded or done**; and a **stopped** task renders no dot
  at all — the member ended it themselves, so neither failure-red nor done-green would be true.
  The only motion on the page is the two breathing dots; nothing else animates by itself.
  (Amber exists in the palette for wait-state pills and banners, but the task dots do not use
  it.)
- **A dash means unmeasured, never zero.** Two conventions coexist, both deliberate: in tables
  and stat cards, every formatter renders an absent metric as an em dash — `0` is a real value
  and must never stand in for "not measured"; in the task sidebar's key–value rows, an absent
  value renders **blank** beside its label — never a dash, never a zero (a blank says "nothing
  here", a dash there would read as a measurement). The PR-state row's dash is the one place a
  dash is hardcoded as data rather than produced by a formatter — no source records PR state.
- **Numbers carry their denominator.** "N tasks measured" beside percentile figures; charts name
  their bucket (day vs ISO week) in words; the topbar names the repos, never a count.
- **Two data sources are visually distinct in provenance**: telemetry panels speak only for
  telemetry, board panels only for the board, and synthetic data is badged loudly.
- **Theme** — the app renders **dark only** today. A complete light palette is already carried
  in the stylesheet's tokens (swapped via a `data-theme="light"` attribute on the root), but no
  switcher, persistence, or system-preference handling exists in the UI yet — a redesign that
  assumes a visible theme toggle would be assuming unbuilt work.
- **Current typography** (identity only — replaceable): Barlow for body, Barlow Semi Condensed
  for headings, IBM Plex Mono for identifiers/logs/output.
- **Accessibility already load-bearing**: current-page marking (`aria-current`), invalid fields
  announce *which* field blocks Send and why (`aria-invalid` + described-by, polite live
  region), dialogs trap and restore focus, icon-only actions carry accessible names
  (aria-labels or visually-hidden text). A redesign should keep or improve all of these.

---

## 9. Screenshots of the current build

Captured by the offline browser check (`npm run verify:ui`) against seeded disposable data —
real rendered pages, not mockups. The usage numbers are synthetic; layout and structure are what
matter. The screenshots are bundled with this document in `screenshots/` — one `.png` per name
in the table below. (The suite regenerates them into `artifacts/ui/` on every run; this folder
is a frozen copy.) Each caption describes exactly what the capturing spec drove before the shot,
so it can be trusted without opening the file. One exception: `task-detail.png` was captured
separately against the same seeded database (a seeded succeeded task), not by the suite.

| File | Shows |
| --- | --- |
| `day/week/2w/month/all.png`, `custom-jul.png` | The dashboard under each range preset, then a custom Jul 1 → Aug 1 range — populated seeded data, all five usage cards. |
| `today-sparse.png` | The dashboard on "Today" with almost no sessions — panels stand up, and metrics with no basis read as unavailable rather than as zero. |
| `daily-month.png` | The token chart at daily granularity (Month preset; the blurb says "tokens per day"). |
| `per-task.png` | All-time range (weekly chart, "per ISO week" blurb) with the per-task usage distributions beside it. |
| `scope-mine.png` | GitHub mode, signed in, scoped to "Me" (Org/Me toggle visible): the member's org holds no seeded rows, so panels render their explicit empty states. |
| `topbar-org.png` | The topbar in open mode: the org selector inert/disabled ("default") beside Refresh. |
| `topbar-user-menu.png` | The topbar's user menu button (open mode — the menu carries no Sign out item); captured with the menu closed. |
| `composer-unchosen-raw-prompt.png` | The composer with a draft typed, no workflow chosen ("— none —"), Send enabled, no parameter inputs. |
| `composer-params.png` | A workflow chosen, its `issue` parameter valid (`#12`), Send enabled. |
| `composer-send-dark-reason.png` | Send disabled with the reason on screen: the parameter fails the pattern, "needs: issue" visible. |
| `composer-default-needs-param.png` | The same workflow after the parameter is satisfied — Send lit, the reason line retired. |
| `task-detail.png` | A task's detail page: head actions (Wall clock / Done / Remove), the conversation turn with "No output recorded.", the follow-up composer, and the status sidebar with connections. |
| `onboarding.png` | The "Choose what to track" screen with two installations checked; the per-org repo disclosures collapsed. |
| `settings-organization.png` | Organization section: the stub sentence + Core env editor (empty scope). |
| `settings-workspace-env.png` | Workspace section in its no-root configuration, with the "My workspace" env editor (Variables/Secrets tabs). |
| `settings-repos.png` | Repositories section: available list + per-repo env editor. |
| `env-row-edit.png` / `env-row-saved.png` | The env editor's table mode: a row typed, then after Save ("Saved." visible). |
| `env-raw-edit.png` / `env-raw-saved.png` | The env editor's raw `.env` textarea mode, then after parsing back to the table and saving. |

Two current surfaces have no screenshot in this set: the **repo picker dialog** and the
**executor dialog** (their spec drove them behind a sign-in flow that failed on a pre-existing
test drift, unrelated to the app itself). Both are fully described in §4.4.2 and §4.4.4; the
modeled dialogs are Headless-UI modals with backdrop, centered panel, focus trap, a dismiss
button ("Not now" in the picker, "Cancel" in the executor dialog) and the primary action.
