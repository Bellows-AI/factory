# [Workflow] Close out the default-workflow feature across executors, UI, docs, and E2E

Parent: #36

Depends on #122, #133, #201, #202, #203, #204, #206, #207, #208, #209, #230, and #231.

## Goal

Integrate and verify the complete default-workflow feature after the parallel slices land. This is a repair/verification issue, not a place to redesign contracts already owned by the child issues.

## Integration matrix

Exercise at least:

- saved defaults: missing row plus all four boolean combinations;
- per-task overrides: include saved-off, exclude saved-on, both on, both off;
- arbitrary prompt and user-defined skill entry;
- explicit custom workflow isolation;
- no repo, no changes, publish failure, existing PR reuse, closed/merged PR;
- review: initial no-op, requested reviewer wait, comments across every surface, coalesced webhook deliveries, three rounds, exhaustion, approval, stop/cancel;
- merge: up-to-date, clean rebase, conflict fixed, gate failure, stale remote head/base, force-with-lease refusal;
- Docker and Kubernetes parity for every block helper/publish decision;
- task inbox/detail/nav and settings/composer states at desktop and narrow widths.

## Work

- Add/extend end-to-end offline harness coverage with stub GitHub responses/webhook deliveries; do not depend on a live installation or network.
- Add one Kubernetes cluster smoke path for an allowlisted block helper if the existing kind harness can represent it without live GitHub.
- Run the full build/test/lint/typecheck/executor coverage gates and repair only integration defects in their owning layer.
- Verify no secret reaches argv, pod specs, logs, stored outputs, screenshots, or fixtures.
- Verify snapshot audit data is sufficient to explain the exact step selection and graph walked.
- Update final truth in `docs/workflows.md`, `docs/jobs.md`, `docs/api.md`, `docs/design-system.md`, `docs/executor-testing.md`, `docs/configuration.md`, and `docs/security.md`.
- Remove stale “there are no default workflows,” `— none —`, and “raw prompt with no workflow” copy/tests.
- Document required GitHub App permissions/event subscriptions and that merge autofix never merges a PR.
- Update #36's checklist and close superseded child text only after every acceptance item is green.

## Ownership boundary

Prefer tests/docs/fixtures and the smallest owning-layer fixes. Do not reopen the block grammar, API shapes, wait model, or product semantics unless a demonstrated integration bug makes the accepted contract impossible.

## Definition of done

- `npm test`
- `npm run test:executors`
- `npm run test:coverage:executors`
- disposable-DB suites covering new persistence
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run verify:ui`
- `npm run test:k8s` and the relevant `--cluster` smoke when the local kind prerequisites are available
- screenshots reviewed, docs match code, and parent #36 checklist is complete
