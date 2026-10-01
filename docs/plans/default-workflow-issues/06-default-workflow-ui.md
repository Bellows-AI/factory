# [Workflow] Add default-workflow settings and per-task step overrides to the web UI

Parent: #36

Depends on #203's frozen API contract. This issue can be implemented in parallel against fixtures, but its PR should merge after #203.

## Goal

Give members saved defaults for the built-in workflow and allow either optional step to be included or excluded for one task before launch.

This is a web-only issue. Server launch semantics land separately.

## Settings UI

Add `/settings/workflows` and a `Default workflow` panel. Show the mandatory prompt → gates → publish spine as read-only. Expose two switches:

- `Iterate on PR review comments`
- `Repair merge conflicts`

Both read on when the API reports the missing-row defaults. Support loading, unavailable, dirty, saving, saved, and refusal states. Use the shared settings unsaved-change coordinator and explain: “Saved defaults apply to new task drafts; running tasks keep their launch configuration.”

Do not add the generic JSON workflow editor from #131 here.

## Composer UI

- Rename the no-explicit-workflow state from `— none —`/raw prompt to `Default workflow`.
- When default is selected, show the two optional steps as checkboxes initialized from saved settings.
- The member may include a saved-off step or exclude a saved-on step for this task.
- Preflight lists the final step set.
- A settings poll refresh updates a pristine/new draft but never overwrites explicit choices in a dirty draft.
- Selecting a custom workflow hides default-step controls and preserves the custom parameter behavior.
- Returning to default initializes from the current saved defaults unless the draft already holds explicit default choices.
- Submit the complete pair:

```json
{
  "defaultWorkflow": {
    "reviewReconciliation": true,
    "mergeConflictAutofix": false
  }
}
```

## Ownership boundary

Own: a dedicated settings API hook, `SettingsWorkflowsPage`, settings/nav/router wiring, `TaskComposerPage`/`TaskComposer` and pure composer state needed for these controls, focused render/state tests, design-system inventory/styles.

Do not touch: server code, workflow schema/compiler, task detail/inbox waiting states, driver, or generic workflow management.

Coordinate with #131: both may add a Workflows settings surface. If #131 lands first, compose under one route; do not create two navigation entries.

## Acceptance

- Missing-row defaults render both switches on.
- All four saved/default combinations round-trip through settings.
- Per-task choices can invert saved defaults in either direction.
- Dirty drafts survive poll refreshes; new drafts adopt the latest saved defaults.
- Preflight and submitted JSON agree.
- Custom workflow selection sends no `defaultWorkflow` object.
- Keyboard, labels/descriptions, focus, narrow width, and save/refusal announcements meet existing settings primitives.

## Verification

- Focused pure composer/API-hook tests.
- Render tests for settings states and task-composer transitions.
- `npm run verify:ui` screenshots for default/custom, saved overrides, and narrow layout when the DB/browser environment is available.
- `npm run typecheck`
- `npm run lint`

