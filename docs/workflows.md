# Workflows

**Read this before touching** `server/src/db/workflow-schema.ts`, `workflow-engine.ts`,
`workflow-store.ts`, the workflow paths in `job-store-worker.ts` and `job-store-claim.ts`, `server/src/routes/workflows.ts`, the
`workflow` field on `POST /api/jobs`, the driver's publish gate, or `027_workflows.sql`. Each
decision below looks like it could be simplified; most are guarded by a test that fails obscurely.

A workflow is the process a task walks, owned by the board instead of baked into runner prompts
(issue #94). A definition is a graph of `agent` nodes — each holding only its prompt template and
its session policy — joined by deterministic edges with optional loop bounds. The board walks the
graph: the driver claims one row, runs it, reports one verdict; the board, never the driver,
decides the next row. Checkout/sync, gates and publish stay driver machinery the graph references
by OUTCOME — they are never nodes with containers.

## The definition grammar

```jsonc
{
  "entry": "fetch-issue",                      // optional; defaults to the first declared node
  "params": [                                  // optional; see "Launch parameters" below
    {
      "name": "issue",
      "pattern": "#\\d+|https://github\\.com/…/issues/\\d+",
      "description": "Enter an issue reference such as #123 or a full GitHub issue URL.",
      "example": "#123"
    }
  ],
  "nodes": [
    {
      "name": "review",                        // /^[a-z0-9][a-z0-9-]{0,63}$/, unique in the graph
      "kind": "agent",                         // "agent" or "block"; see "Built-in blocks" below
      "session": "fresh",                      // "resume" | "fresh"
      "gates": false,                          // optional; default true — run the driver's gates
      "publish": true,                         // optional; default false — see "Publishing" below
      "prompt": "…{{fetch-issue.output}}…"     // the interpolated template; see below
    }
  ],
  "edges": [
    {
      "from": "review", "to": "fix",
      "when": { "marker": "VERDICT: BLOCKERS" }, // or "succeeded" | "failed" | "gate-failed"
      "max": 3                                  // optional loop bound; see "Loops" below
    }
  ]
}
```

The grammar is closed and the validator (`workflow-schema.ts`) refuses with NAMED errors:

- unknown keys anywhere — a pasted foreign pipeline fails loudly (`UNKNOWN_KEY`), never silently;
- unknown node references in edges or `entry`, and unknown nodes in `{{node.output}}` placeholders
  (`UNKNOWN_NODE`, `UNKNOWN_PLACEHOLDER`);
- any node kind other than `agent` or `block` — checkout, gates and publish are driver machinery,
  and a node with an arbitrary container is exactly what a workflow must not grow (`BAD_NODE`); see
  "Built-in blocks" below for what `block` is and is not;
- a definition with no `publish: true` node, or with none reachable from the entry — a graph with
  no exit dooms every thread to rest mid-flight (`NO_PUBLISH_PATH`);
- a malformed parameter declaration — a bad or duplicate name, or a pattern that is not a bounded,
  compiling regex source (`BAD_PARAMS`);
- a definition over 16 KiB (`TOO_LARGE`) — the same body-limit discipline as commands.

## Built-in blocks

**Read this before touching** `server/src/db/workflow-blocks/`. A `block` node is the other half
of the closed node grammar (issue #204): a reference to a board-owned, allowlisted process, without
copying its prompts into every workflow that wants it.

```jsonc
{
  "name": "review-comments",
  "kind": "block",
  "uses": "builtin/github-review-reconcile",
  "with": { "maxRounds": 3 }
}
```

`uses` names a reserved block id (`namespace/block-name`); `with` is an optional, bounded config
object (scalar values, at most 16 keys, camelCase field names — `maxRounds` above, not
`max-rounds`: a config field is a JS identifier, not a node name). A node is an `agent` node or a
`block` node, never both — `prompt`, `session`, `gates` and `publish` on a `block` node refuse
`UNKNOWN_KEY`, and `uses`/`with` on an `agent` node refuse the same way.

The two reserved ids are `builtin/github-review-reconcile` (issue #133, `available: true` — see
"The github-review-reconcile block" below) and `builtin/merge-conflict-autofix` (issue #122,
`available: true` — see "The merge-conflict-autofix block" below). Both are listed by the catalog
(`GET /api/workflow-blocks`) regardless of availability. Referencing an unavailable id in
a definition refuses `BLOCK_UNAVAILABLE` at create — an unavailable block cannot be stored, so it
can never be launched. Naming an id the registry has never reserved refuses `UNKNOWN_BLOCK`; a
`with` value the block's own
`configSchema` rejects (unknown key, wrong type, out of range) refuses `BAD_BLOCK_CONFIG` — all
three are compile-time refusals from `workflow-blocks/index.ts`'s `compileDefinition`, distinct
from `workflow-schema.ts`'s own `DefinitionRefusal` codes: the schema validates `uses`/`with`
SHAPE only (it stays registry-unaware, on purpose — see its own module comment) and knows no id.

**Authored vs. expanded.** What a member POSTs to `POST /api/workflows` is the AUTHORED
definition — block nodes intact. `workflow-store.ts`'s `create()` runs `compileDefinition`
immediately after the schema validates: every block node is replaced by its descriptor's `expand()`
output (an ordinary low-level `agent`-node subgraph), the expanded graph is validated AGAIN in
full — reachability, the publish path, the placeholder vocabulary, positive bounds, all reused from
`validateDefinition` itself, against the wider `EXPANDED_DEFINITION_LIMIT` cap rather than the
authored `DEFINITION_LIMIT` — and the EXPANDED graph, never a live block reference, is what
`workflow.definition` actually stores. This is deliberate, not an implementation detail to route
around: `workflow-engine.ts` and `routes/jobs.ts` read `.prompt` off every node with no `kind`
guard, so a stored `block` node would corrupt the first transition that ever walked into it — the
one thing this issue's ownership boundary forbids fixing (`routes/jobs.ts` is out of scope). Storing
the expansion instead means a root job's frozen snapshot is automatically the expanded graph with
zero changes to either file, and a block descriptor's own future implementation only ever affects
workflows CREATED after it lands — an already-created workflow's expansion is fixed at its own
create time, exactly like every other frozen snapshot in this file.

One consequence worth knowing: `GET`/`POST /api/workflows` responses show the EXPANDED graph for a
definition that used a block, not the `uses`/`with` text originally posted — there is no
update/edit endpoint today, so nothing currently needs to re-read the authored source. Expanded
node names are namespaced under the referencing node's own name (`${blockName}--${internalName}`)
so two uses of one block, or a name a block's own internal subgraph happens to reuse, cannot
collide — collision-freedom is not trusted to the naming scheme alone, either: the expanded graph's
own re-validation pass is what actually refuses a true clash, via the ordinary `DUPLICATE_NODE`
check every workflow gets.

The driver-side transport a compiled block's declared pre/post helper actually runs through —
`Runner.runHelper`, the docker/kubernetes parity, the loop's fencing — is issue #207
(docs/jobs.md, "Block-helper steps"). `WorkflowNode.helperPlans` (issue #122) is what a block's
`expand()` populates it with: a bounded array of `{helperId, phase, githubWriting}`, validated the
same way `gates`/`publish` are, registry-unaware like the rest of this file — it names no
helperId's own meaning. `job-store-claim.ts`'s `resolveClaimHelperPlans` resolves each declared
plan onto the claim GENERICALLY, injecting one value every helperId alike may use: the thread's
recorded PR publication (`job_pr`, issue #202's `pr-lifecycle-store.ts`), when it has one. A node
that declares none carries no `helperPlans` on its claim — unchanged from before this field
existed, and still true of every plain `agent` node outside a block's own expansion today.

Issue #230 extends that same generic, block-agnostic transport, entirely on the driver side (docs/jobs.md,
"Conclude control and composite helper programs"): a successful pre-helper may answer `control:
'conclude'` to complete the job without an agent turn, and a `helperId` may name an allowlisted
composite that sequences several registered script helpers with pure planning between them. Both
are transparent to `helperId` itself — a block's `expand()` still just names an id, exactly as
before.

### Durable block waits (issue #231)

**Read this before touching** `server/src/db/workflow-blocks/runtime.ts`, `038_workflow_round.sql`,
the `runtime` field on a compiled `WorkflowNode`, or the wake-sweep/cancellation-fence code in
`job-store-claim.ts`. This is the generic seam a block uses to park a thread after publish with no
executor held, coalesce matching GitHub webhook deliveries, and later make exactly one continuation
claimable — turning #202's PR-lifecycle primitives (`pr-lifecycle-store.ts`'s `enterWait`,
`recordDelivery`, `claimReview`, cancellation) into workflow-transition behavior. It owns no
review-repair or merge-conflict policy; `builtin/github-review-reconcile`'s `wait` node is its one
shipped real user, alongside the fake, dependency-injected descriptors
`workflow-block-compiler.test.ts` and `job-store.block-wait.test.ts` still exercise it with.

**The private runtime descriptor.** A `BlockExpansion` may declare `runtime`, keyed by the block's
own INTERNAL node name — `{ [internalName]: { runtime: BlockRuntimeId, params } }` — kept separate
from `expansion.nodes` so it never passes through the authored node parser (which would refuse it as
`UNKNOWN_KEY`). `compileDefinition` validates each entry against `runtime.ts`'s allowlist (an unknown
runtime id, or params its handler rejects, refuse `BAD_BLOCK_CONFIG`, naming the internal node),
namespaces the key the same way it namespaces node names, and — critically — attaches the result onto
`WorkflowNode.runtime` only AFTER the expanded graph has already passed `validateDefinition`. The
validator's own key set has no `runtime` at all, on an `agent` node or a `block` node, so a member's
authored JSON (or a pasted `GET /api/workflows` response) carrying one refuses `UNKNOWN_KEY` — the
same closed-grammar guarantee every other authored field gets, at the one point (this attach step)
that is deliberately downstream of the check that would otherwise refuse it.

**Dispatch is by allowlisted id only.** `workflow-blocks/runtime.ts`'s `HANDLERS` map is the entire
allowlist; nothing resolves a runtime by a user-provided module or script name. The one shipped id,
`pr-delivery-wait`, takes no params (the wait's address — repo, PR number — comes from the thread's
recorded publication, `job_pr`, never from block config). A node whose `runtime` names an id this
build does not recognize, or whose params its handler rejects, is treated as `runtimeIsValid`
answering false: the transition RESTS the thread rather than falling back to an ordinary insert,
which would silently skip the wait — "Marker absence is a first-class outcome" holds here too. A
runtime-carrying node also cannot resolve to the graph's own ENTRY — a thread's first row is
inserted directly by `routes/jobs.ts`, never through a transition, so a wait boundary there would
run immediately as an ordinary claimable job; `compileDefinition` refuses this `BAD_BLOCK_CONFIG` at
compile time rather than let it happen at the first thread that ever launches one.

**The park: `job-store-worker.ts`'s `runWorkflowTransition`.** Exactly where an ordinary transition
would `insertWorkflowSuccessor`, a node carrying `runtime` calls `enterRuntimeBoundary` instead —
same verdict transaction, same per-root `pg_advisory_xact_lock` the transition already holds, so no
extra locking is needed for the park itself. It reads the thread's publication
(`prs.publicationOf`); with none, the thread rests (never parks on nothing to wait for). With one,
it calls `prs.enterWait` (idempotent: a re-entry of an already-open wait keeps its folded `pending`
and cursor) and either inserts a new `workflow_round` row — command, session, repo, executor, the
completed row as `parent_job_id`, `round = 1 + max(previous rounds)` — or, if this same wait node is
still parked from an EARLIER transition that has not woken yet (an unusual but legal loop shape),
refreshes that row in place rather than minting a second round. `038_workflow_round.sql`'s partial
unique index (`woken_at is null`) is what makes "the currently parked round" one indexed lookup
either way. A parked round is not a `job` row: waiting consumes no runner/executor lease, and the
claim loop has nothing to poll for it beyond the sweep below.

**The wake: `runtime.ts`'s `sweepRuntimeWakes`, called from `job-store-claim.ts`'s `claimJob` once
at the top of every poll, before it looks for queued work.** It selects parked rounds whose wait is
open with `pending > 0` and whose thread has no active member (queued, running, or already
`done_at`) — a bounded batch (`WAKE_BATCH`), oldest-activity first — then wakes each candidate in
ITS OWN transaction, never inside the claim transaction that triggered the sweep: a wake that
already committed must survive a later candidate's or the claim's own failure. Each wake takes that
thread's per-root advisory lock (the same one the park and every claim already use), RE-CHECKS the
active-member predicate under that lock on a best-effort basis (the candidate list above ran
unlocked, so this closes the common case of a follow-up queued or the thread marked done in
between; neither of those two writers takes this same lock, so it narrows the race rather than
closing it outright — `sameThreadRunning`, the claim's own ordinary same-thread exclusion, is what
actually keeps two rows of one thread from running at once regardless), re-reads the round
`for update` and bails if `woken_at` is already set, calls `prs.claimReview` (which atomically reads
and resets `pending` — coalescing is inherent here: three deliveries folded since the last claim
become one continuation whose audit `delivery_count` is 3, and a delivery landing after the reset
starts the NEXT round's count from zero), inserts the continuation through the same
`insertWorkflowSuccessor` an ordinary transition uses (byte-identical claim shape — no `runtime`
key, no privileged metadata), and stamps the round `woken_at`/`job_id`/`delivery_count`/
`last_delivery_id` — turning the parked row into its own bounded audit record rather than deleting
it. **Two concurrent claimers cannot double-wake one round**: the advisory lock is what actually
prevents it — it serializes every sweep and claim of one thread, so only one transaction can ever
hold it, and the `for update` re-check under that lock is what catches a round another transaction
already woke while THIS one was blocked waiting for the lock. `workflow_round_pk` guards against a
double PARK (two rows of the same round), not a double WAKE — a second wake past the lock would
still insert a second `job` row; its own `update ... where woken_at is null` would simply match zero
rows, leaving that second row an orphan. The advisory lock is therefore the only thing standing
between a correct wake and that orphan, which is exactly what
`job-store.block-wait.test.ts`'s concurrent-claimers test counts directly (`count(*) from job
where ... workflow_node = ...`), not just the round-row count. A crash mid-wake rolls the whole
transaction back — `pending` and the parked row are untouched, and the very next poll retries it.
The wait itself stays OPEN across a wake (only a block's own future `finishWait` call ends it —
policy this seam does not have; today that also means the read model buckets a woken, actively
RUNNING continuation as `review` rather than `running`, matching #202's existing "an open wait
buckets the thread as review regardless of the row's own status" rule, docs/jobs.md): a re-park
after the continuation runs finds the
wait already active and simply adds a new round.

**Who calls `finishWait`: `workflow-blocks/runtime-settle.ts`'s `settleBlockWaits` (issue #133),
generic and block-agnostic like this file.** Called from `job-store-worker.ts`'s
`runWorkflowTransition`, once per completion, right after `nextTransition` decides and BEFORE
either branch (insert or rest) runs: it derives the halted node's SCOPE (the `${blockName}--`
prefix a compiler-namespaced node name carries; null for a bare node) and, when the transition is
either a REST or an INSERT into a node OUTSIDE that same scope, finishes every open wait any
runtime-carrying node of that scope holds — `terminalReason` names why (`'block exited'` for a
successor outside the scope, `` `rested (${reason})` `` for a rest). An insert that STAYS inside
the scope (the block's own internal round-trip, or a re-park into its own wait node) settles
nothing — exactly the "stays OPEN across a wake" rule above. `finishWait` is idempotent, so a scope
with no wait ever entered (a block whose `collect`-equivalent concluded clean before ever reaching
its `wait` node) costs one no-op call, never a refusal.

**The cancellation fence: `job-store-claim.ts`'s `claimNextCandidate`, right after a row claims.**
PR-close (`cancelForRepoPr`) and thread-stop/remove (`cancelWaitsForRoot`) cancel a `workflow_wait`
row directly and do NOT take the per-root advisory lock — a close can land at any time, including
between a wake committing and that continuation being claimed. So every claim of a workflow row
checks, under its own already-held advisory lock, whether the just-claimed job is a `workflow_round`
continuation (`job_id` match) whose wait was cancelled; if so it is settled `stopped` right there
instead of handed to a worker, and the claim loop moves to the next candidate. This is what makes
cancellation win the race against a wake rather than the other way around. Ordinary cancellation
paths need no changes: a PR close arriving before any wake is simply never picked up by the sweep's
"wait is open" predicate; stopping the QUEUED continuation (an ordinary `job` row once woken) already
cancels the wait through the existing stop-settle path (`cancelWaitsForRoot`); removing the thread
cancels the wait AND deletes its `workflow_round` rows in the same transaction. The one case this
seam does not cover is stopping a thread that is parked and has NOT yet woken — there is no `job` row
to address with `/stop` in that state, so cancelling before the first wake is `removeThread`'s job
(which works regardless of park state) or `cancelForRepoPr`'s.

### The merge-conflict-autofix block

`builtin/merge-conflict-autofix` (issue #122, `server/src/db/workflow-blocks/merge-conflict-autofix.ts`)
reconciles an existing task's pull request with its current base branch. It expands to two nodes:

- `repair` (entry, `session: resume`, `gates: false`) declares one PRE helper,
  `merge-conflict-probe` (`driver/src/scripts/merge-conflict-probe.cjs`): a deterministic script
  that fetches the PR's recorded base and either finds the branch already up to date, rebases it
  cleanly, or leaves a known conflicted rebase state — writing its verdict to
  `.factory/merge-conflict-probe.json` in the worktree (the generic helper transport surfaces only
  ok/fail to the loop, never a helper's own output, to the agent turn that follows — the state file
  is how that agent reads it). `repair`'s own prompt is a fixed relay: read the file, and when the
  verdict names a real conflict, resolve it using ONLY `git rebase --continue`/`--abort` — an
  INITIATING `git rebase`, `git merge`, `git switch`/`checkout` of a branch, and `gh pr create` are
  all denied to the agent by the executor's git guard for exactly this reason (docs/jobs.md,
  "The runner images refuse checkout manipulation at the hook"): a rebase initiation is the
  driver's own job, and `--continue`/`--abort` on one already in progress is the guard's own
  documented repair path for a tree an interrupted rebase left mid-flight.
- `verify` (`publish: true`, gates default on) is a trivial confirmation turn — the driver's own
  claim machinery runs the declared gates and publishes through the existing publisher
  automatically once claimed, reusing the thread's existing PR for free (its branch is always
  `factory/<rootJobId>`, unchanged since the thread's original publish).

`repair`'s up-to-date and needs-review markers carry no outgoing edge, so a completed run that
emits either rests the thread loudly — "Marker absence is a first-class outcome" above — which is
what keeps an up-to-date branch from ever reaching gates or publish, and an unresolved conflict
resting as needs-review with its reason in the run's own output. The one loop the block declares
is `repair`'s own retry on ITS RUN failing outright (a crash, a lost lease), bounded by the
block's `maxAttempts` config (1-5, default 2) on a `repair -> repair` self-edge — a deliberate
`MERGE-NEEDS-REVIEW` verdict is not a failure and is never retried, matching the issue's "one
agent repair round" for the substantive case. Because `repair` carries `session: resume`, this
block must be referenced as a LATER node of a thread that already produced a PR earlier in the
same thread (never a fresh thread's own entry) — restore mode (the sync's `RESTORE=1`, which skips
the fetch/rebase that would otherwise race the block's own preflight) falls out of
`claimContinuesSession` automatically once the claim carries a `resumeSessionId`, with no extra
wiring. This block never merges, closes, or auto-merges the PR — it only reconciles and republishes.

### The github-review-reconcile block

`builtin/github-review-reconcile` (issue #133,
`server/src/db/workflow-blocks/github-review-reconcile.ts`) waits for GitHub review activity on a
published PR with no executor held, collects every supported feedback surface deterministically
(issue #201's `review-collect.cjs`), addresses at most `with.maxRounds` rounds (1-10, default 3),
and replies to exactly what it addressed (issue #201's `review-reply.cjs`). Four internal nodes:

- `collect` (entry) and `wait` (the durable wait boundary, `runtime: pr-delivery-wait` — issue
  #231) are identically shaped: both declare one pre-helper, `review-collect-probe`
  (`driver/src/review-helpers.ts`, an ADAPTER around issue #201's unmodified script — never a
  modification of it), which fetches full state and answers, as a PRE-helper `conclude` (issue
  #230, so neither node ever spends an agent turn): `REVIEW-CLEAN` (approved, or nothing
  outstanding and no reviewer requested), `REVIEW-WAIT` (a reviewer is requested or changes were
  requested, nothing actionable yet), or — writing `.factory/review-reconcile/digest.json` first —
  `REVIEW-ACTIONABLE`, which lets the outgoing marker edge launch `repair`.
- `repair` (`session: resume`, gates default on, `publish: true`) is the only node that edits
  code: it reads the digest, fixes what it can, and writes
  `.factory/review-reconcile/intents.json` — one reply-or-decline note per digest item. It may
  never comment, reply, resolve a thread, or run `gh pr create` itself; the driver's own claim
  machinery runs gates and publishes automatically once claimed, reusing the thread's existing PR.
- `reply` declares one pre-helper, `review-reply-probe` (also `driver/src/review-helpers.ts`):
  re-fetches FRESH state (never trusting the repair agent's own claim that a comment or thread
  still exists), builds a bounded mutation plan from the declared intents, executes it through
  issue #201's unmodified `review-reply.cjs`, and always concludes `REVIEW-REPLIED` on a clean
  run — this node never launches an agent turn either.

`repair` reaches `reply` only on `succeeded`, never a marker — a publish failure fails the verdict
(docs/jobs.md), so by the time `reply` runs the push has already landed, and a `[driver]
published …` decorated output line can never masquerade as a marker the way it could if this edge
matched on one. The loop bound: every edge into `repair` (the fresh-actionable entry from
`collect`/`wait`, and `repair`'s own `gate-failed`/`failed` retries) shares `maxRounds` as its
`max`, per "give EVERY edge into X the same max" above — a gate-failure retry counts toward the
same three rounds a fresh actionable entry does, the same acceptable trade the
merge-conflict-autofix block's own retry edge makes. A fourth required round rests the thread
loudly (`loop_bound`), the last completed run's own output still visible. `collect`'s and
`reply`'s own retry/self-loops, and `wait`'s repeated false-wake self-loop, get independent,
generous bounds — never the round bound — so a transient fetch/reply failure or an ordinarily
noisy PR never eats into the three real repair attempts.

The block's `exit` is `collect` itself (also its `entry`): every internal path funnels back
through a fresh `collect` fetch before the block can leave (`reply`'s own `REVIEW-REPLIED` marker
routes there), so an outer edge attached to this block only ever fires on `collect`'s own
`REVIEW-CLEAN` completion — the one marker with no internal edge of its own to intercept it first.

## Launch parameters

A workflow may declare parameters (`params`), and every declared parameter is REQUIRED at launch —
there is no optional parameter, because a parametrized workflow like `fix-issue` that launched
without its issue would burn a full executor run on a prompt the model can only guess at. A
declaration is `{ name, pattern?, description?, example? }`: the name is a lowercase identifier the
prompts reference as `{{param.NAME}}` (`param` is therefore a RESERVED node name); the pattern is an
optional regex SOURCE (≤256 characters) the value must fully match — `^(?:pattern)$`, so authors
write a bare shape and never anchors. Absent pattern means any non-empty value, bounded at 512
characters.

`description` and `example` are PRESENTATION METADATA the composer renders beside the input —
plain-language guidance and a valid example a generic client can show instead of interpreting the
regex. Both are optional, validated on the trimmed value (non-empty, at most 160 and 120 characters
respectively — `BAD_PARAMS` otherwise), and retained trimmed on the normalized definition. `example`
must be VALID: when the parameter declares a `pattern`, the trimmed example must fully match it
(`^(?:pattern)$`, the same semantics launch applies) — the composer may pre-fill it, and a hint the
launch would refuse is exactly the dishonest guidance this metadata exists to replace. The pair
still participates in NOTHING beyond that: no interpolation, and `checkWorkflowParams` never reads
them — guidance never substitutes for the pattern at launch. Unknown keys beside them still refuse
`UNKNOWN_KEY`, and they count toward the unchanged 16 KiB definition cap. The workflow list and
detail responses carry the fields through the existing parameter summaries.

THE PATTERN GRAMMAR IS A SAFE SUBSET of regular expressions, refused on any doubt (`BAD_PARAMS`).
A pattern runs in the board's event loop (every launch validates against it) and in every member's
browser (the composer mirrors the check per keystroke), so an ambiguous pattern must never be
stored — catastrophic backtracking on a 512-character value would hang the board, not just the
request. Allowed: literals, `.`, the class shorthands (`\d \w \s` and friends), punctuation
escapes, character classes, alternation, unquantified groups, and quantifiers (`* + ? {m,n}`) on
single atoms — never on groups, never stacked on another quantifier. The AMBIGUITY BUDGET caps the
damage by construction: at most 4 quantified atoms per pattern, at most 3 in one unbroken run
(groups are transparent to the run — `(a+)(a+)` is a run of two), `{m,n}` at most 64. Anchors,
lookarounds and backreferences are refused outright. The worst backtrack a stored pattern can
force is C(512, 3) ≈ 2×10⁷ cheap steps — bounded, and honest shapes never come near it.

The values travel on the `POST /api/jobs` body as `workflowParams` — an object keyed by parameter
name. The route validates them against the resolved definition's declarations BEFORE anything
queues: a missing, empty, over-length or non-matching value is a `400 BAD_WORKFLOW_PARAMS`, and
`workflowParams` sent beside a task that names no workflow is the same refusal. This is
code-enforced, not prompt-discipline: the composer renders one explicit input per declared
parameter of the workflow the member CHOSE, and the launch button stays disabled until every
value validates. An unnamed task names no workflow, resolves none, and runs the member's words
verbatim — parameters are never demanded by anything the member did not pick.

The validated values freeze on the thread's root row (`job.workflow_params`, beside the snapshot)
and every row's transition interpolates `{{param.NAME}}` from them — a follow-up's completion
continues to resolve them, and editing a definition's params changes later tasks, never a running
thread. The prompt vocabulary gains two tokens alongside `{{nodeName.output}}` and the `{{gate.*}}`
pair:

- `{{param.NAME}}` — the named parameter's frozen value, bounded like every substitution;
- `{{command}}` — the thread root's command: the member's own words on the entry node, the
  interpolated entry prompt on every successor. The one UNBOUNDED substitution — the member's
  words were already capped by the boundary that accepted them, and a silent 4 KiB cut mid-sentence
  would mangle exactly the text the route let through; the post-interpolation command cap is the
  guard instead.

THE ROOT COMMAND IS THE ENTRY PROMPT: when a workflow resolves, `POST /api/jobs` builds the task's
command by interpolating the ENTRY node's prompt — `{{command}}` carrying the member's chat line —
instead of storing the raw line. A parametrized workflow's first run IS its entry node (there is no
other way for the parameter to reach the model), and a param-less workflow gains the same shape:
its entry prompt launches, with the member's line wherever `{{command}}` names it. The task view's
title reads the prompt's first line — authors keep prompts whose first line is a sentence.

## The edge vocabulary

An edge rule matches one of, and nothing else — no rule may depend on anything the board does not
store on its own rows:

- `"succeeded"` / `"failed"` — the verdict the worker reported.
- `"gate-failed"` — derived from the row's stored `gates` jsonb: any gate report with
  `status: "failed"`. Read off the report the driver already maintains, never parsed from prose;
  an agent-exit failure (a `failed` verdict with green gates) and a gate failure stay
  distinguishable outcomes.
- `{"marker": "…"}` — an exact match against the output tail: the final non-empty line of the
  stored output must EQUAL the marker, trimmed. Blocks that need a semantic distinction emit a
  strict final line (`VERDICT: CLEAN` / `VERDICT: BLOCKERS` — the exact markers
  `server/src/db/workflow-templates.ts` defines and the board's marker edges match).

Rules evaluate in the definition's declared order, first match wins — the one deliberate
simplification; no precedence algebra. A bound-exhausted edge RESTS the thread; it does not fall
through to a later edge, because a loop that hit its limit is a stop the author declared.

**Marker absence is a first-class outcome**: a completed node whose no rule matches rests the
thread loudly, output intact — visible, follow-up-able, never silently continued, never failed.

## Loops: counted from the audit trail

A bound `max` on an edge into node X means: the thread must not already hold `max` rows for X
when the rule matches. The count is `count(*)` over the thread's rows for that node — ALL of
them, dead rows included. Attempts are retries of one row; rounds are rows; the two counters
never substitute for each other. There is no loop-counter store: a second source of thread truth
would drift from the rows, and the rows are already the audit record.

To declare "review x3", give EVERY edge into `review` the same `max: 3` — the bound lives on the
matching edge, and the count is rows for the target, so the shared bound is the loop limit.

## Session policy

- `resume` — the row carries, FROM INSERT, the thread's PRIMARY session: the session of the
  thread's first `resume`-policy run (read off the root's snapshot). Its claim resumes it. A
  resume node with no session yet to copy (an exotic `fresh` entry, say) inserts with none, mints
  its own at claim, and that session then IS the primary.
- `fresh` — the row inserts with no session, claims with none, and mints its own: fresh eyes, one
  worktree, N sessions per thread. The task view shows each turn's own session.

A user follow-up always resumes the primary session, whatever node ran last — the follow-up CTE
reads the primary off the snapshot instead of the newest row's (a fresh-eyes review is a side
branch, and a follow-up continues the thread, not the branch). Pre-workflow threads (no snapshot
on the root) chain the NEWEST session exactly as they always did — the old behavior is pinned by
the db suite and must not change.

## Transitions: the board walks, in the verdict's transaction

`complete()` lands the verdict and — in the same `sql.begin` block, under the same per-root
advisory lock the claim takes — evaluates the completed node's outgoing edges against the run's
verdict, stored gates and output tail, then either inserts the next row (an ordinary queued job:
the driver claims it through the existing lease/fence machinery, `max_attempts` governing it
individually) or rests the thread. No read ever observes a thread with the verdict landed but no
successor row inserted; the threadDone aggregate runs AFTER the insert decision, so a moving
thread correctly answers not-done.

The engine (`workflow-engine.ts`) is a pure function — thread rows + snapshot + completed run →
insert-or-rest — unit-tested exhaustively beside the store; the SQL around it only reads rows and
inserts what the engine says. The failure mode of a bug is a thread that stops, never one that
misbehaves; a rested thread is visible and hand-continuable.

The current node is the completed row's own `workflow_node`. For an off-graph row (a user
follow-up), it is the halted node — the thread's newest carried node — so the human's extra work
sits at the node and the graph continues from it.

## Halt semantics: stop, dead, and the human's way back in

- A `stopped` row fires no edge: a human ended the turn; the follow-up composer is next. The
  board's transition runs only out of `complete()`, which a stop never reaches.
- A `dead` row (attempts burned) fires no edge — but it still COUNTS toward loop bounds, being a
  row.
- A user follow-up is an ordinary row of the same thread with NO `workflow_node`; when IT
  completes, the halted node's outgoing edges are evaluated from that completion, so the loop
  continues without the user re-triggering it by hand. Without this, a stopped loop would sit
  behind a manual re-trigger for every round — the human toil #94 exists to remove.

## Publishing

The board decides, per node, whether the driver may publish after the run's succeeded gated run,
and rides the decision on the CLAIM: `publish: true` only out of a `publish: true` node, `false`
on every other workflow node. ABSENT on a workflow-less claim — the driver reads absence as
"publish", which is what keeps a no-workflow task's claim byte-identical to before 027. The gate
lives in ONE place — the loop in `driver/src/loop.ts`, shared by both executors; the docker and
kubernetes transports grew no gate of their own (pinned by their suites), because a decision in
two places drifts.

A node may also declare `gates: false` — a fresh-eyes review need not pay suite minutes, and must
not fail the thread on a gate it did not touch. The claim then carries neither gates nor a gate
error. Default is on, matching today.

## Scoping, defaults, and the snapshot

A workflow belongs to exactly one scope — the org, a member, or a repository label — the same
stack the env vars use. Org-level creation is admin-gated; a member may create user-level and
repo-level definitions. Names are unique per scope (a coalesced unique index, the
`env_var_key_uk` precedent).

Resolution for a task, in `POST /api/jobs`:

1. an explicit `workflow` name, within the caller's visible scopes — repo over user over org when
   the name exists in several;
2. unnamed: NO workflow. The member's words are the whole command, and the row and claim are
   byte-identical to pre-027. There are no default workflows: a process walks a task only when a
   body names it, so nothing the member did not choose can demand parameters or reshape their
   prompt.

The resolved definition is SNAPSHOT-FROZEN onto the thread's root row at creation, beside
`workflow_id` — and the resolved record's NAME is frozen with them (`job.workflow_name`, 033): the
reusable process the member chose, as it was called when the task was created, inherited by every
successor and user follow-up. Follow-up rows reference the root; every transition decision reads
the snapshot. Editing or deleting a workflow mid-flight changes later tasks, never a running
thread — the task view can always show the exact graph walked. `job.workflow_id` carries no foreign
key on purpose: job is an audit record, and deleting a definition must not touch the threads that
walked it. The frozen name is held to the same doctrine — a rename or delete rewrites later tasks,
never existing task history, and a task that never named a workflow keeps null.

## The blocks and the base workflow

`server/src/db/workflow-templates.ts` holds the board-owned prompt templates and the seeded
`fix-issue` workflow — the `/fix` skeleton as a graph: fetch-issue → implement → review (x3) →
gate-fix (x3) → publish. It declares the `issue` parameter — a bare `#123` or a full GitHub issues
URL, with the composer guidance `description` "Enter an issue reference such as #123 or a full
GitHub issue URL." and the `example` `#123` — and its fetch block fetches exactly that reference
(`gh issue view {{param.issue}} …`), with
the member's own words carried in as `{{command}}`. The old "if none was given, take the issue the
task describes as text and skip the fetch" fallback is gone: the launch refuses without a valid
issue instead of improvising. The bare form keeps its `#` so the reference survives into the
command the driver parses and the branch/commit messages cite. Each block carries only its agentic
content plus the output contract an edge needs; the loop limits live on the edges, enforced by the
board, no longer model discipline. The board seeds it at boot (idempotent by name, org-level) as
one choosable process among the list — never a default that unnamed tasks resolve; the row is the
board's, so it tracks the shipped template — a definition an older boot seeded refreshes to the
current shape, because a stale row would serve a process the code no longer ships with no way for
a member to fix it (no workflow edit UI exists). A member's own same-named definition in another
scope is never touched. Running threads are safe regardless — they froze their snapshot at
creation.

Templates interpolate at row-insert time, bounded: `{{nodeName.output}}` — that node's most
recent stored output tail, hard-truncated to its 4 KiB share with a visible `[…truncated by the
board]` marker — `{{gate.name}}` / `{{gate.output}}` — the completed run's first failed gate —
and `{{param.NAME}}` — a declared launch parameter (values are bounded at 512 characters anyway).
`{{command}}` is the unbounded exception — see "Launch parameters". An interpolated command over
the 16 KiB command cap refuses the insert (`command_too_large`) and rests the thread. The
vocabulary is closed: anything else in `{{...}}` is refused at create.

## Where things live

| Thing | Place |
| --- | --- |
| Grammar, validator, interpolation, param values | `server/src/db/workflow-schema.ts` |
| The block registry, config resolution, the expansion compiler | `server/src/db/workflow-blocks/index.ts` |
| Shared block types: `BlockDescriptor`, `BlockExpansion`, `CompileCheck` | `server/src/db/workflow-blocks/types.ts` |
| The two reserved block descriptors (issue #204; each block's own implementation issue edits only its own file) | `server/src/db/workflow-blocks/github-review-reconcile.ts`, `server/src/db/workflow-blocks/merge-conflict-autofix.ts` |
| The catalog route | `server/src/routes/workflows.ts` (`GET /api/workflow-blocks`) |
| The transition engine (pure) | `server/src/db/workflow-engine.ts` |
| The store: CRUD, scope visibility, seed, block compilation at create | `server/src/db/workflow-store.ts` |
| Templates and the base `fix-issue` workflow | `server/src/db/workflow-templates.ts` |
| Columns (027, 030, 033) and the freeze-at-create snapshot | `server/migrations/027_workflows.sql`, `server/migrations/030_workflow_params.sql`, `server/migrations/033_job_workflow_name.sql` |
| The durable block-wait dispatcher: the allowlist, the park, the wake sweep, the cancellation fence (issue #231) | `server/src/db/workflow-blocks/runtime.ts` |
| The generic `finishWait` settle rule (issue #133) | `server/src/db/workflow-blocks/runtime-settle.ts` |
| The parked continuation and its wake audit (issue #231) | `server/migrations/038_workflow_round.sql` |
| The github-review-reconcile block's own driver helpers: the adapter scripts, the composed bodies, the registry entries (issue #133) | `driver/src/review-helpers.ts`, `driver/src/scripts/review-collect-probe-*.cjs`, `driver/src/scripts/review-reply-probe-*.cjs` |
| The transition in the verdict's transaction | `job-store-worker.ts` `completeJob()` → `runWorkflowTransition()` |
| The primary-session follow-up copy | `job-store-actions.ts` `createFollowUpRow()` |
| The claim's `publish` flag and the gates opt-out | `job-store-claim.ts` `resolveClaimPublish()` |
| The driver's one publish gate | `driver/src/loop.ts` |
| CRUD routes and `POST /api/jobs` resolution | `server/src/routes/workflows.ts`, `routes/jobs.ts` |
| The composer dropdown and the parameter inputs | `web/src/panels/TaskComposer.tsx`, `web/src/task-composer.ts`, `web/src/api/useWorkflows.ts` |
| A member's saved default-step switches (035, #203) — no job behavior yet reads them | `server/src/db/default-workflow-settings-store.ts`, `server/src/routes/workflow-settings.ts` |
| The settings page and composer checkboxes that read/write that API (#208) — still no job behavior reads the submitted `defaultWorkflow` field | `web/src/pages/SettingsWorkflowsPage.tsx`, `web/src/panels/DefaultWorkflowPanel.tsx`, `web/src/api/useDefaultWorkflowSettings.ts` |

## Tests

- Offline units: `server/test/workflow-engine.test.ts` — the edge vocabulary, first-match order,
  loop bounds, dead-row counting, halt rules, bounded interpolation, the seeded definition.
- Offline units: `server/test/workflow-schema.test.ts` — the `block` node grammar (`uses`/`with`
  shape, the two node kinds never mixing, a block as an opaque reachability/publish-path hop, the
  `sizeLimit` override) — registry-unaware, matching `workflow-schema.ts` itself.
- Offline units: `server/test/workflow-block-compiler.test.ts` — expansion, namespacing, edge
  rewriting into/out of a block, config resolution against a descriptor's `configSchema`, and the
  real registry's `UNKNOWN_BLOCK`/`BLOCK_UNAVAILABLE` refusals against fake, dependency-injected
  descriptors.
- Offline units: `server/test/workflow-block-merge-conflict-autofix.test.ts` — the real
  `builtin/merge-conflict-autofix` expansion: node/edge shape, namespacing, the declared
  `helperPlans`, the `maxAttempts`-bounded retry edge, and that a custom graph can reference it
  independently of any other workflow.
- Offline units: `server/test/workflow-block-github-review-reconcile.test.ts` — the real
  `builtin/github-review-reconcile` expansion (node/edge shape, namespacing, the shared
  `maxRounds` bound, the `wait` node's runtime attachment, the repair prompt's own guardrails) plus
  a pure orchestration walk of the expanded graph through the real `nextTransition`: initial
  clean/wait/actionable, the repair->reply->collect round-trip, gate-failed/failed retries, and
  round exhaustion resting `loop_bound`.
- Offline units: `server/test/workflow-block-runtime.test.ts` — the runtime allowlist and params
  parser in isolation, no database or compiler involved.
- Offline units: `server/test/workflow-block-runtime-settle.test.ts` — the generic `finishWait`
  settle rule (issue #133): scope arithmetic, staying inside a block's own round-trip, resting vs.
  leaving for an outer node, and touching only the departing scope's own runtime nodes.
- Offline units (extended): `server/test/workflow-block-compiler.test.ts` — attaching a namespaced
  `runtime` descriptor onto the matching expanded node, the `BAD_BLOCK_CONFIG` refusals (unknown
  internal node, unknown runtime id, rejected params, a runtime-carrying node resolving to the
  graph's own entry), and that an expansion with none (the real merge-conflict-autofix block
  included) stays byte-identical.
- Offline units (extended): `server/test/workflow-schema.test.ts` — `runtime` refuses `UNKNOWN_KEY`
  on both an authored agent node and a block node (issue #231's "never authorable" guarantee).
- HTTP contracts: `server/test/routes.workflows.test.ts` (including `GET /api/workflow-blocks` and
  the compiler's refusal codes surfacing the same way a schema refusal does), the
  workflow-resolution block of `routes.jobs.test.ts`.
- Against a real database (`npm run test:db`): `server/test-db/workflow-store.test.ts` and
  `job-store.workflow.test.ts` — atomicity, the walks, session copies, publish flags, bounds; the
  former also covers `create()` compiling `builtin/github-review-reconcile` and storing its
  expanded, namespaced graph with the `wait` node's `runtime` intact.
- Against a real database: `server/test-db/job-store.block-wait.test.ts` (issue #231) — parking
  (no runnable row, an open wait, the frozen continuation), resting when unpublished, the wake
  sweep's zero/one/many-and-redelivered-GUID coalescing, a thread with an active member never
  waking, concurrent claimers unable to double-wake one round (asserted directly on `job` row
  count, not just the round row), PR-close before and after a wake (the cancellation fence),
  stopping a woken continuation, removing a parked thread, re-parking the same wait node before it
  wakes, a second independent round after the first wakes and completes, a crash mid-wake (rolled
  back, `pending` and the parked row untouched), and a continuation's stale lease reclaimed as the
  same row.
- Driver: the publish-flag twins in `driver/test/loop.test.ts`, and the transport parity pins in
  `docker.test.ts` / `k8s.test.ts`. Real offline git fixtures for the merge-conflict-autofix
  preflight (up-to-date, clean rebase, conflicted, stale/precondition-refused, and stale-rebase
  cleanup) live in `driver/test/merge-conflict-probe-script.test.ts`. The github-review-reconcile
  block's composed helper bodies run end to end against a stub `gh` in
  `driver/test/review-helpers.test.ts` — REVIEW-CLEAN/WAIT/ACTIONABLE decisions, the digest write,
  a reply plan built only from digest-presented, still-live targets, and the fresh-refetch failure
  propagating as a helper failure, never a false REVIEW-REPLIED conclude; `driver/test/scripts.test.ts`
  pins the composed-body ASSEMBLY (not just the pieces) byte for byte.
- End to end: the `# workflows` phase of `scripts/test-jobs.sh` walks a stub workflow on a real
  board and driver.
