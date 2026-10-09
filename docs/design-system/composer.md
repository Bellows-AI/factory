# Design system — region: composer

The chat footer and the `/tasks/new` page. Styles: `web/src/styles/regions/composer.css`; shared
primitives and the system contracts: [../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Prompt surface, context chips, launch row, skeleton | `web/src/panels/TaskComposer.tsx`, `web/src/pages/TaskComposerPage.tsx` | `web/test/task-composer.render.test.tsx`, `e2e/composer.spec.ts` |
| Validation, blockers, readiness derivation | `web/src/task-composer.ts` | `web/test/task-composer-logic.test.ts` |
| Draft persistence and restore | `web/src/use-composer-draft.ts` | `web/test/composer-draft.test.tsx` |
| A workflow's declared parameter fields | `web/src/components/WorkflowParameterFields.tsx` | `web/test/task-composer.render.test.tsx` |
| The no-synced-repository dialog | `web/src/components/NoSyncedReposDialog.tsx` | `e2e/composer.spec.ts` |

## Invariants

- The request counter's ceiling is core's `COMMAND_LIMIT`, imported, never restated.
- Start's `aria-describedby` names whichever banner or status text is blocking it, so the reason is
  announced rather than inferred from a disabled button.
- A task launches only against a selected repository whose clone is `ready`; the same rule is
  refused at `POST /api/jobs` (`REPO_REQUIRED`, `REPO_NOT_READY`) in
  `server/src/routes/job-handlers-worker.ts`, `server/test/routes.executor-lifecycle.test.ts`.

Classes defined here: `composer-row`, `composer-input`, `composer-label`, `composer-fields`,
`composer-helper`, `composer-param-input`, `composer-param-error`, `composer-param-details`,
`composer-prompt`, `composer-prompt-head`, `composer-bar`, `composer-start`, `composer-blocker`,
`composer-example`, `composer-counter`, `is-over`,
`composer-context-item`, `composer-context-value`, `composer-trigger-missing`,
`composer-notices-body`, `composer-notices-dismiss`, `composer-skeleton-block`,
`composer-skeleton-line`, `task-compose`.
