# [Workflow] Persist default-workflow preferences and expose the settings API

Parent: #36

## Goal

Store each member's saved defaults for the two optional default-workflow steps and expose a narrow authenticated API. Missing data must mean both steps are enabled.

This issue does not change job creation and does not add UI.

## API contract

`GET /api/workflows/default-settings`

```json
{
  "reviewReconciliation": true,
  "mergeConflictAutofix": true,
  "updatedAt": null
}
```

`PUT /api/workflows/default-settings`

```json
{
  "reviewReconciliation": false,
  "mergeConflictAutofix": true
}
```

PUT requires exactly the complete boolean pair. Unknown, missing, or non-boolean fields return `400 BAD_DEFAULT_WORKFLOW`. The response is the saved representation with non-null `updatedAt`.

## Work

- Add `server/migrations/035_default_workflow_settings.sql`, keyed by `(org_id, user_id)` with both non-null booleans and `updated_at`. This number is reserved for this parallel slice.
- Foreign keys follow existing org/user lifecycle rules; settings must not leak across organizations for a user who belongs to more than one.
- Implement a dedicated store module and a dedicated route module so this can land without editing generic workflow CRUD.
- A missing row reads as both `true`; do not backfill all users.
- PUT is an atomic upsert and updates `updated_at` only on a real accepted write.
- Bind author identity from the authenticated caller, never from the body.
- Register the route in the app and enforce the same credential boundary as other member settings.
- Update `docs/api.md` and persistence documentation.

## Ownership boundary

Own: one new migration, the new settings store/route, app registration, focused route/DB tests, API/persistence docs.

Do not touch: `routes/jobs.ts`, workflow schema/compiler, task composer/settings pages, driver, or webhooks.

The web issue may implement against this frozen contract in parallel, but its PR should merge after this API.

## Acceptance

- New/existing members with no row read both switches as `true`.
- Two members and two organizations remain isolated.
- PUT accepts all four boolean combinations and rejects partial/unknown/malformed bodies.
- An unauthenticated/wrong-org caller cannot read or mutate another member's settings.
- No job behavior changes in this issue.

## Verification

- Focused route unit tests.
- Focused `server/test-db` store tests against a disposable `*_test` database.
- `npm run typecheck`
- `npm run lint`
