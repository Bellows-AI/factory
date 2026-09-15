## 1. Schema: migration and stores

- [ ] 1.1 Write `server/migrations/027_workflows.sql`: a `workflow` table (org_id, id, name, scope
      fields, nullable user/repo owner labels, `definition` jsonb, created_by, timestamps, unique
      name per scope) plus nullable `job.workflow_id`, `job.workflow_node`, and the definition
      snapshot column on the root; verify `npm run test:db` migrations boot cleanly against
      `factory_test` and pre-027 rows are untouched
- [ ] 1.2 Add `server/src/db/workflow-store.ts`: create/list/get/delete with the strict definition
      validator (known node kinds, resolvable edges, bounded edge rules, size cap) returning named
      errors; verify with db-suite tests covering accept, unknown-key refusal, unknown-node
      refusal, and name uniqueness per scope
- [ ] 1.3 Extend `job-store.ts` create paths: `workflow_id`/`workflow_node`/snapshot land on the
      row at insert, and a follow-up insert copies the thread's PRIMARY session for `resume` nodes
      (not the last row's); verify with db tests pinning primary-session copy across a
      fresh-session branch (implement → review(fresh) → fix(resume) carries the implement session)

## 2. Server: workflow routes and task creation

- [ ] 2.1 Add `server/src/routes/workflows.ts`: `GET /api/workflows` (caller-visible list with
      scope; worker token refused), create (org-level admin-gated, user/repo for members), delete;
      register in `main.ts`/`buildApp`; verify with route tests including the 403 admin gate and
      the worker-token refusal
- [ ] 2.2 Extend `POST /api/jobs` with the optional `workflow` field: name resolution (explicit >
      repo default > user default > org default), unknown-name refusal with a named error, and the
      snapshot stored on the root row; verify with route tests for each resolution step and the
      refusal
- [ ] 2.3 Pin the no-workflow byte-identity: a create and claim without a `workflow` field produce
      the same shapes as before the change; verify by asserting the claim payload fields in
      `routes.jobs.test.ts` stay exactly as today

## 3. Server: the transition engine

- [ ] 3.1 Implement the engine as a pure module: (thread rows, snapshot, completed row's verdict +
      gates + output tail) → next node with interpolated command, or rest; edge vocabulary =
      verdict / gate-failed (from stored gates jsonb) / output-tail marker match, evaluated in
      declared order, first match wins; verify with exhaustive unit tests — marker match, marker
      absence resting, gate-failed derivation, first-match order
- [ ] 3.2 Wire the engine into `complete`'s transaction (beside the `threadDone` aggregate):
      bounded-edge counts from thread row counts, insert the next row (session policy per
      design.md Decision 3, publish flag per node), or rest; verify with db tests — atomicity (no
      read observes verdict without successor-or-rest), the fourth review round never inserting,
      a dead row still counting as a round
- [ ] 3.3 Implement publish computation: publish-node runs get `publish: true` on the claim, every
      other node false, no-workflow tasks true; add `publish` to the claim read; verify with a db
      test per arm
- [ ] 3.4 Implement the halt rules: `stopped` fires no edge; a user follow-up is an off-graph row
      that, on completion, re-fires the halted node's outgoing edges; verify with db tests for
      stop-then-followup-then-continue on the base workflow
- [ ] 3.5 Bound interpolation: substituted tails hard-truncated to their share of the 16 KiB
      command cap, over-cap result refuses the insert with a named error and rests the thread;
      verify with unit + db tests

## 4. Driver: the publish flag (both executors, one change)

- [ ] 4.1 Make the publish step conditional on the claim's `publish` flag in `driver/src/`
      (docker and kubernetes paths read the same claim object); absent flag = today's behavior;
      verify `driver/test/` pins: flag false skips publish (no publish containers/Jobs), flag
      absent behaves byte-identically to the current suite's expectations
- [ ] 4.2 Verify executor parity explicitly: the kubernetes path gates the same aux-Job publish
      sequence on the same flag; verify with the k8s-side test twins and `npm run test:k8s`
      (offline phase) still green

## 5. Blocks and the default workflow

- [ ] 5.1 Write the base workflow definition (`fix-issue`: fetch-issue → implement → review x3 →
      gates → gate-fix x3 → publish) with board-owned prompt templates carrying `{{...}}`
      placeholders and the strict `VERDICT:` contract for review; ship as a seeded org-level
      default; verify the validator accepts it and a walkthrough unit test interpolates every
      placeholder
- [ ] 5.2 Write the block templates: fetch-issue, execute (`/fix` minus its loop skeleton),
      review, fix, gate-fix; each ends with its deterministic marker where an edge needs one;
      verify template-review against the interpolation tests and the 16 KiB shares
- [ ] 5.3 Extend `scripts/test-jobs.sh` with a stub workflow walked end-to-end offline (stub
      runner emits the markers; the board walks fetch → implement → review(fail-marker) → fix →
      review(clean) → publish-skip → publish), proving transitions, loop limit, session copy and
      the publish flag on a real board; verify the script passes and drops what it creates

## 6. Web: selection and labels

- [ ] 6.1 Add the workflow dropdown to the task composer (fed by `GET /api/workflows`, beside
      repo/executor, default "— none —"); verify web render smoke covers the composer with and
      without workflows
- [ ] 6.2 Label task-detail turns with their `workflow_node` when present; verify render smoke
      with a fixture thread carrying node labels

## 7. Docs

- [ ] 7.1 Write `docs/workflows.md`: the schema, the edge vocabulary and marker contracts, the
      scoping/resolution order, the snapshot rule, halt semantics, and the blocks' templates with
      their output contracts
- [ ] 7.2 Update AGENTS.md's read-before-you-touch table and docs/jobs.md with pointers; verify
      `npx vitest run core/test/biome.test.ts` still passes and links resolve

## 8. Verification

- [ ] 8.1 Full gates: `npm test`, `npm run typecheck`, `npm run lint` green; `npm run test:db`
      against `factory_test` green
- [ ] 8.2 End-to-end: `npm run test:jobs` green including the new workflow phase; a
      no-workflow task in the same run behaves byte-identically (same claim shape, same publish)
