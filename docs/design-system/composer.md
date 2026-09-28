# Design system — region: composer

Owned by the composer lane. Styles: `web/src/styles/regions/composer.css` — the lane rules plus its
trailing 44px touch-target segment (issue 189). Shared primitives, tokens and the system
contracts: [../design-system.md](../design-system.md).

## Primitives

| Primitive | Classes | Use for |
| --- | --- | --- |
| Composer | `composer`, `composer-input`, `composer-row`, `composer-label`, `select-trigger`, `composer-param-input`, `task-compose`, `composer-field`, `composer-fields`, `composer-context`, `composer-context-item`, `composer-context-value`, `composer-steps`, `composer-helper`, `composer-preflight`, `composer-start`, `composer-blocker`, `composer-param-error`, `composer-param-details` | The message input and its row (the detail view's chat footer); `task-compose` is the full-page variant. A chosen workflow's declared parameters render as the `composer-fields` list, each a `composer-field` with a `composer-label`, `composer-helper` guidance, per-field `composer-param-error` lines, and the raw rule only inside `composer-param-details`; a failed field tints its `.composer-param-input` edge via `aria-invalid`. The `composer-start` action row holds Discard draft, Start, the `kbd` shortcut and the `composer-blocker` status (quiet reasons only — an empty prompt, a launch in flight), after the `composer-preflight` sentence. The trigger and menu skin itself (`select-trigger`, `popover`, `popover-option`) is shared with every other selector and owned by #224, not this pattern |
| New-task page | `composer-section`, `composer-section-head`, `composer-section-title`, `composer-step`, `composer-example`, `composer-counter`, `is-over`, `composer-trigger-missing`, `composer-notices`, `composer-notices-body`, `composer-notices-dismiss`, `composer-skeleton`, `composer-skeleton-block`, `composer-skeleton-line` | `/tasks/new` (#280, concept 02): four numbered `panel composer-section`s — Request, Execution context, Workflow details, Readiness — each headed by a `composer-section-head` with a 28px `--accent` `composer-step` disc (`aria-hidden`; the h2 in `composer-section-title` carries the words). Request: a 160px/15px textarea, "Try an example" (`composer-example`, `sparkles`, enabled only on an empty draft) and the `composer-counter` (`{length} / 16,384` from core's `COMMAND_LIMIT`, `is-over` in `--lamp-stop`). Execution context: `composer-context`, three `composer-context-item` columns ≥1024px (stacked below), each a glyphed `composer-label` over a full-width framed `select-trigger`, its value in an ellipsis-truncating `composer-context-value` (full value in the trigger's `title`); `composer-trigger-missing` is the executor's stop-lamp edge. Workflow details: a named workflow's fields, or the spine sentence and the closed `composer-steps` disclosure ("Optional steps (n of 2 on)"). Readiness: `banner-bad` only for a missing executor (with its settings link), incomplete workflow details and an over-limit request; `banner-info` while a chosen workflow's list or the saved preferences load — Start's `aria-describedby` names the banner or the status text. A draft restored from the shell (F1) says what it lost in a dismissible `banner-info composer-notices`; `composer-skeleton` holds the page, static, while the session is checked |


## Inventory

| File | Primitives |
| --- | --- |
| `TaskComposer.tsx` | panel, composer, task-compose, composer-section, composer-section-head, composer-section-title, composer-step, composer-example, composer-counter, field, selector, composer-label, composer-context, composer-context-item, composer-context-value, composer-trigger-missing, composer-steps, composer-helper, composer-preflight, composer-start, composer-blocker, banner-bad, banner-info, banner-title, composer-notices, composer-skeleton, icon, settings-toggle, kbd, chat-resume, unsaved (the discard confirmation) |
| `TaskComposerPage.tsx` | page-header, status, composer-skeleton |
| `WorkflowParameterFields.tsx` | composer-field, composer-fields, composer-label, composer-param-input, composer-helper, composer-param-error, composer-param-details |

