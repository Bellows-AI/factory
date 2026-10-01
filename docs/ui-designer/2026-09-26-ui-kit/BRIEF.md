# Bellows — designer brief for the next UI kit

Prepared 26 September 2026 · source revision `c503351`.

The current product name in the interface is **Bellows**. The repository and older handoff use Factory / factory-ai; this brief follows the current UI branding.

Start here, then read [the component inventory](COMPONENTS.md) and open [the screenshot gallery](index.html). This is a new handoff; the earlier `docs/ui-designer/SPEC.md` and `PRIORITY-IMPROVEMENTS.md` remain historical context in the repository. Current source and new captures take precedence over their older route names and behavior.

## What we are building

Bellows is a shared workspace for delegating software work to AI coding agents and understanding what happened afterward. A developer describes a change, chooses the repository and execution setup, and starts a task. Bellows runs the work in an isolated checkout, records the conversation and checks, and can publish a branch and pull request. The developer returns to review the result, ask for another pass, or close the task.

The central promise is **delegation with a readable work record**. A person should be able to leave a task running and return knowing what changed, what passed, what needs attention, and which action moves the work forward. Long-running work, failed checks, review waits, and incomplete setup are ordinary product states.

Bellows also gives teams a view of agent usage: tokens, sessions, estimated costs where available, and attribution across people and tasks. This helps a team understand its operation. Usage is not a measure of developer quality or proof of business value. Task-board records and agent telemetry are separate sources, with different coverage and failure states.

The product is self-hosted and connected to GitHub organizations. Its users are technically capable, but should not have to infer the system's state from raw logs or internal vocabulary.

## Who we serve

| Person | Main question | Experience to support |
| --- | --- | --- |
| Developer delegating work | “Can I start this safely, and what needs my attention?” | Task creation, inbox triage, progress, checks, follow-up, published work |
| Team lead or maintainer | “What is happening across our team's agent work?” | Organization context, task ownership, usage trends, source and coverage explanations |
| Workspace administrator | “Is the team ready to run tasks, and what is missing?” | Setup readiness, repository access, environment scopes, actionable failures |

These are usage perspectives, not three new permission roles. The app currently distinguishes members and admins; editability varies by resource and scope.

## The story the interface should tell

1. **Get oriented.** Sign in with GitHub, select the organizations/repositories to track, and know which organization is active. Explain what the selection changes.
2. **Get ready.** Configuration shows whether the workspace, repositories, executors, and environment are usable. A missing prerequisite has a reason and a path to repair it.
3. **Delegate.** Start a task with a clear request. Understand the selected repository, executor, workflow, required parameters, and any optional default-workflow steps before starting.
4. **Stay informed.** The inbox answers what is running, waiting, needing review, failed, or done. Task detail separates the request, agent response, activity, verification, and published result.
5. **Review and continue.** Inspect checks and the PR, send a follow-up, stop work when appropriate, or mark the task done. Removing a task is a distinct destructive action.
6. **Learn from usage.** Change time range and scope, see the data those filters actually produced, and understand missing or partial coverage.

An illustrative task: “Fix the failing password-reset flow.” The user chooses the repository, starts the configured workflow, follows implementation and checks, opens the published PR, and asks for a correction if needed. The same task remains a readable sequence of runs.

## Current product map

| Area | Route | Design responsibility |
| --- | --- | --- |
| Dashboard | `/` | Usage summary, range/scope, token chart, supporting tables, recent tasks |
| Task inbox | `/tasks` | State filters, search, repository/author filters, sort, incremental loading |
| New task | `/tasks/new` | Guided request, execution context, workflow parameters and launch readiness |
| Task detail | `/tasks/:id` | Conversation, activity, result summary, checks, services, branch/PR, follow-up/actions |
| Configuration overview | `/settings` | Readiness and next corrective action |
| Organization / workspace / repositories | `/settings/organization`, `/settings/workspace`, `/settings/repos` | Scope, identity/setup, repository selection and environment editing |
| Executors | `/settings/executors` | Named execution profiles and configuration dialog |
| Workflows | `/settings/workflows` | Default-step preferences and named workflow management |
| Account | `/account` | Identity, tracked organizations, personal access-token controls |
| Entry | Sign-in gate and `/onboarding` | Authentication, organization/repository selection, first-use guidance |

The task inbox has its own page; the sidebar is a bounded preview. Default workflow preferences and “Waiting for review” are now part of the product. A review wait can be intentional and occupies no executor; it must not look like a crashed or indefinitely busy agent.

## What we want from the designer

Create a coherent, reusable UI kit and demonstrate it on the main workflows. The current implementation is behavioral evidence, not a requirement to preserve every border, font, or arrangement.

The proposed direction is calm, legible, and precise: strong page identity; a restrained surface hierarchy; clear differences between actions, navigation, status, and metadata; readable prose; compact technical details with disclosure when useful. Preserve useful information density while making the next decision obvious.

Prioritize these design problems:

- **Attention hierarchy:** make active work, intentional waits, failures, and human review easy to scan without turning the entire screen into alerts.
- **Task readability:** give the request and response a clear rhythm; separate raw activity from the result; keep checks and PR access easy to find.
- **Control consistency:** unify buttons, selectors, fields, menus, tabs, and dialogs across analytics, task creation, and configuration.
- **Setup clarity:** show scope, affected users/tasks, permission limits, saved state, and recovery paths close to the controls they explain.
- **Responsive density:** reorganize information for phones rather than shrinking the desktop table or hiding critical actions.

Concrete examples from the new screenshots: the dashboard's range/scope controls consume a tall strip above the metrics; the repository configuration action wraps within a word beside the environment panel; the successful task example still colors “exit 0” and “0 failed” red; and the phone inbox becomes a long stack of sparse rows. These are starting points for hierarchy, semantic color, control sizing, and density work. They are observations of this build, not measured usability findings.

## Constraints worth preserving

- Run success, verification success, publication, and the user's “Done” decision are separate facts. No single green badge should imply all four.
- A task contains multiple runs. A follow-up belongs to the existing work record.
- Named workflows and the built-in default are different. Default optional-step switches do not silently customize a named workflow. Workflow edits affect future tasks; existing tasks retain their launch snapshot.
- Organization, personal workspace, and repository configuration have different scope and editability. Display effective scope explicitly; do not imply every member can edit every setting.
- Refresh failures retain the last good data when available, with a visible stale-data explanation. Loading, empty, unavailable, and zero are different states.
- Dark, light, and system appearance are supported. Semantic status meaning must survive both palettes and cannot depend on color alone.
- Preserve keyboard navigation, visible focus, dialog focus return, accessible names, reduced motion, and forced-color support. Target WCAG AA; specify 44px touch targets for mobile actions.
- Support narrow screens down to 320px and 200% zoom. Tables/charts/logs may have deliberate local scrolling; page-wide horizontal scrolling is not the intended behavior.
- Environment values and access tokens need deliberate reveal/copy/edit states. Shareable examples must use synthetic values.

## Requested deliverables and review order

1. **Foundations:** semantic tokens for both themes; typography, spacing, density, radii, elevation, focus, icon sizes and motion rules. Show token naming and intended use.
2. **Component library:** reusable Figma components with properties, variants, auto layout, content limits, responsive behavior, and interaction states. Use the companion inventory as the coverage checklist.
3. **Composed screens:** task inbox, new task, running task, waiting-for-review task, failed check, completed result, dashboard, configuration overview, and one complete settings editor. Include entry/onboarding and account patterns in the next pass.
4. **Interaction examples:** task launch with a blocker; follow-up; range selection; settings edit/save/discard; destructive confirmation; mobile navigation.
5. **Engineering handoff:** token table, component-to-source mapping, state rules, keyboard/focus behavior, truncation/wrapping rules, and a list of intentionally changed interactions.

Review the task journey first, then configuration, then analytics and entry flows. A polished dashboard alone is insufficient. A new graphical workflow editor is not required for this UI-kit assignment; propose it separately if it solves a demonstrated problem.

Acceptance questions: Can someone identify the page, organization, state, and next action at a glance? Can they distinguish a wait from a failure and a successful run from finished work? Do the same controls behave consistently across pages? Do empty/error/permission states remain understandable? Does the design still work with long task titles, repository names, logs, and narrow screens?

## Evidence and limits

Screenshots in this folder are fresh captures of the implemented app using the repository's Playwright flows and synthetic disposable databases. They document the current UI, not proposed designs or live customer activity. Open-mode configuration screens intentionally expose unavailable-workspace states; authenticated setup captures supplement them. Seeded task titles and usage numbers are fixture content.

See [CAPTURE.md](CAPTURE.md) for the capture manifest, verification result, and coverage gaps. States requested in the inventory but absent from the gallery remain explicit design requirements, not claims of captured evidence.

Source references in the repository: `docs/design-system.md`, `docs/workflows.md`, `web/src/App.tsx`, and `web/src/brand.ts`. Source paths elsewhere in this brief are repository-relative.
