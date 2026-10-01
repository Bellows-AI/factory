Part **1 of 4** of Slice D — *Make configuration diagnosable, scoped, and safe to edit* (P2).

Full spec: `docs/ui-designer/ISSUE-SLICE-D-CONFIGURATION.md` — sections **1. Settings overview**,
**2. Shared scope and permission context**, **3. Organization page**, **Data/API work**,
**Accessibility requirements**, and **Test plan → Readiness / Scope and permission**.

**Baseline:** Slice A issue #160 and Slice B issue #168.

## Summary

Replace the `/settings` redirect with a real configuration overview, make scope and editability
explicit, remove the Organization placeholder, and align the UI with the environment routes'
actual permission contract.

This issue establishes the information architecture and permission language every later Slice D
editor uses. It does not recompose repository selection or environment-row interactions yet.

## 1. Settings overview

Add `SettingsOverviewPage` at `/settings`.

Header:

- eyebrow **Settings**;
- title **Configuration overview**;
- description **Review what is configured for {organization name} and your workspace.**

Render identity followed by five ordered readiness items:

1. Organization;
2. Workspace;
3. Repositories;
4. Executors;
5. Environment.

Every item has a text status, supporting facts, and a direct action link. Do not add a generic
top-level Fix button.

### Organization

- Show organization display name and current **Admin** / **Member** role.
- Do not expose an internal id or infer undocumented powers from the role.
- Link **Review organization settings** → `/settings/organization`.

### Workspace

Derive from the existing shared `useWorkspace()` result:

- pending/no data: **Checking workspace…**;
- initial request failure: **Workspace status unavailable** plus the named error;
- `root === null`: **Workspace is not configured; tasks cannot run** and
  **Review workspace setup** → `/settings/workspace`;
- root present: **Workspace available**, quiet path value, and
  **Open workspace settings** → `/settings/workspace`.

Root-null is deliberate deployment configuration, not an HTTP outage, but the driver refuses a
claim without `workspacePath`; do not call the system runnable.

### Repositories

Derive from `workspace.data.repos`; Overview must not fetch `/api/repos`:

- no selected repos with a root: **No repositories enabled for your workspace**;
- any failed repo: **{n} repositories need attention**, with failed names/reasons;
- queued/cloning and none failed: **Setting up {n} repositories**;
- all selected ready: **{n} repositories ready**;
- root null: **Repository checkouts require a workspace root**.

Use the exact action destination for the state: `/settings/repos` for selection/status,
`/settings/workspace` for missing root.

### Executors

- Root null: personal executors unavailable and tasks cannot run; link Workspace.
- Zero executors with a root: **Using the deployment default** and explain that no personal rows
  are required.
- One or more: **{n} personal executors available** and **{first name} is selected first on new
  tasks.**
- Link **Manage executors** → `/settings/executors` when workspace is available.

Zero rows is neutral, not an error.

### Environment

Derive from the existing non-polling `useEnv()` result:

- loading: **Checking environment scopes…**;
- initial failure: **Environment status unavailable**;
- successful empty payload: **No custom environment values** and mark it optional;
- populated: separate variable and secret counts across organization, workspace, and repository
  scopes without showing names or values.

Link each scope directly to Organization, Workspace, or Repositories.

### Pure derivation

Add `web/src/settings/readiness.ts`. It returns presentation-neutral items with stable ids, status,
detail, tone, and action. No JSX, fetch effects, icons, or color names.

Pin precedence:

- failed repository outranks queued/cloning;
- root-null executor/workspace state outranks empty arrays;
- initial loading never reports zero;
- stale data stays visible with its error rendered separately.

## 2. Scope and permission context

Add `ConfigurationScope`; do not reuse the interactive analytics `ScopeToggle`.

It renders:

- scope label;
- impact sentence;
- editability sentence;
- optional environment-precedence help.

Required language:

- **Organization** — applies to every member's tasks in the organization; any member can edit.
- **My workspace** — applies only to tasks the current member starts; only that member edits.
- **Repository · owner/name** — applies to every task using the repository in the organization;
  any member can edit.

Required environment precedence:

- organization < workspace < repository;
- say which more-specific scope can override the current one.

Scope is readable text before controls, never a tooltip, disabled input, or color-only badge.

## 3. Permission truth

The server/domain contract is authoritative:

- `PUT /api/env/org` accepts any organization member;
- `PUT /api/env/workspace` writes the caller's own rows;
- `PUT /api/env/repo` accepts any member when the installation can see the repository;
- route tests pin those rules;
- every secret read remains `value: null`, including for admins.

Remove the web-only `disabled={!isAdmin}` gate from organization and repository environment
editors. A disabled browser control is not authorization.

If product policy changes, implement/document/test a server `403` first, then render a readable
read-only view. Do not silently introduce that policy here.

## 4. Organization page

Replace **Organization settings are not built yet.**

Render:

1. route-aware PageHeader;
2. compact identity definition list (organization and current role);
3. Organization scope context;
4. **Organization environment** section using existing rows/save behavior.

Do not add membership, invitation, billing, or other placeholder surfaces.

## State and polling rules

- Keep exactly one workspace hook and one environment hook in `SettingsLayout`.
- Overview starts no `/api/repos` request and no executor-config request.
- Initial failure with no data differs from stale-data warning.
- Keep last-good facts visible on a later failure; do not replace them with zeros.
- Do not poll environment state.
- Do not move executor configs into `GET /api/workspace`.

## Implementation map

- `web/src/App.tsx`
  - replace Settings index redirect with `SettingsOverviewPage`;
- `web/src/nav-model.ts`
  - keep parent Settings at `/settings` as Overview;
  - keep four existing child links and no duplicate Overview child;
- `web/src/pages/SettingsLayout.tsx`
  - preserve one shared workspace/environment owner;
- `web/src/pages/SettingsOverviewPage.tsx` (new)
  - identity, readiness items, exact action links;
- `web/src/settings/readiness.ts` (new)
  - pure state/status derivation;
- `web/src/components/ConfigurationScope.tsx` (new)
  - shared scope/impact/editability presentation;
- `web/src/pages/SettingsOrganizationPage.tsx`
  - remove placeholder and false admin disablement;
- `web/src/styles.css` and `docs/design-system.md`
  - readiness/scope primitives and exact inventory;
- `docs/env.md`
  - preserve and accurately describe current write policy.

No endpoint, migration, driver, Docker, or Kubernetes change is expected.

## Accessibility and responsive requirements

- Exactly one `h1` on Overview and Organization.
- Readiness items use ordered headings.
- Every action link names its fix/destination; no repeated generic **Fix**.
- Scope, role, status, and editability are text, not color alone.
- Status changes do not announce on every workspace poll.
- Overview is two columns only when content fits; one column at 700px and below.
- No page-level horizontal scroll at 390×844, 900×800, or 1280×900.

## Tests

Add/update:

- `web/test/settings-overview.test.tsx`
  - every readiness branch and action target;
  - failed repos outrank in-progress repos;
  - root null blocks tasks;
  - zero executor/env neutral behavior;
  - no false zeros while loading;
  - initial error versus stale-data warning;
- `web/test/settings-pages.render.test.tsx`
  - placeholder removed;
  - one heading and identity/scope content;
- `web/test/settings.wiring.test.tsx`
  - shared hooks and no Overview repo/config request;
- focused `ConfigurationScope` render tests;
- `web/test/nav-model.test.ts` and `web/test/sidenav.test.tsx`
  - exact `/settings` current state and child expansion;
- `server/test/routes.env.test.ts`
  - retain member org/repo write and secret masking cases.

Browser:

- open Overview from the parent Settings item;
- follow every fix link;
- verify signed-out deep link gate;
- capture populated, sparse, loading/error, and narrow Overview screenshots.

## Acceptance criteria

- [ ] `/settings` renders Configuration overview instead of redirecting.
- [ ] Identity shows organization and current role without unsupported permission claims.
- [ ] Five readiness items use existing session/workspace/env data only.
- [ ] Every attention/unavailable state links to the exact explanatory/fix page.
- [ ] Root-null says tasks cannot run; zero executors/env remain accurately neutral when a root
      exists.
- [ ] Organization, My workspace, and Repository scope context states impact and editability.
- [ ] Organization/repository env remains writable to members under the current API policy.
- [ ] Organization placeholder and client-only admin restriction are gone.
- [ ] Loading, empty, stale, error, and unavailable remain distinct.
- [ ] Overview starts no repository or executor-config fetch.
- [ ] Keyboard, heading, responsive, design-system, and screenshot checks pass.

## Verification

```bash
npx vitest run web/test/settings-overview.test.tsx web/test/settings-pages.render.test.tsx
npx vitest run web/test/settings.wiring.test.tsx web/test/nav-model.test.ts web/test/sidenav.test.tsx
npx vitest run server/test/routes.env.test.ts
npm run typecheck
npm run lint
npm run build
npm run verify:ui
```

Inspect every Overview/Organization screenshot at full size.

## Out of scope

- repository page recomposition;
- environment-row draft/undo/navigation behavior;
- executor dialog guidance;
- role administration or new authorization policy;
- backend readiness state.
