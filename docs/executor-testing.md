# Executor testing

This is the coverage map for the board/driver/runner/telemetry control plane. It separates code
coverage from boundary coverage: a high V8 percentage does not prove Docker, Kubernetes, Git,
TimescaleDB, or the OTLP collector actually accepted the artifact handed to it.

## Fast gates

| Command | Boundary | Current result |
| --- | --- | --- |
| `npm run test:executors` | Offline board routes, orchestration, both runners, image/config artifacts, OTLP parsing | 1,279 tests |
| `npm run test:coverage:executors` | The same surface with a regression threshold | 95.14% lines/statements, 89.21% branches, 96.28% functions |
| `DATABASE_URL=…/factory_test npm run test:db` | Real lease, fencing, attribution, deduplication and rollup SQL | 308 tests |
| `npm run test:jobs` | Real board HTTP, Docker daemon, containers and disposable database | Required before changing Docker runner behavior |
| `npm run test:k8s` | Helm assertions; `--cluster` adds real Jobs in kind | Required before changing Kubernetes runner behavior |

The focused coverage gate excludes `driver/src/index.ts`, content-injected scripts under
`driver/src/scripts/`, and the Postgres telemetry store. V8 cannot attribute child-process code to
the parent Vitest process, and the stores deliberately need TimescaleDB. Those paths are tested by
the real-process/script suites and `test:db`; adding them as zeroes would make the percentage less
truthful, not more strict.

## Coverage by responsibility

| Responsibility | Primary suites | What must remain pinned |
| --- | --- | --- |
| Board protocol | `board.test.ts`, `routes.jobs.test.ts`, `server/test-db/job-store*` | credential on every worker write, lease conflict distinctions, claim/heartbeat/complete idempotence |
| Orchestration | `loop.test.ts` | first/periodic heartbeat, setup races, stop/remove, stale lease kill, reclaim barriers, report degradation, block-helper pre/post fencing |
| Docker runner | `docker.test.ts`, `gates.test.ts`, `scripts.test.ts`, `worktree.test.ts` | argv/env secrecy, attempt labels, kill/fence isolation, bounded output, real Git behavior |
| Kubernetes runner | `k8s.test.ts`, `k8s-transport.test.ts` | Docker parity plus claim arbitration, attempt Secrets, API retry bounds, token rotation and cleanup ordering |
| Block-helper transport (issue #207) | `helpers.test.ts`, plus the block-helper cases in `docker.test.ts`, `k8s.test.ts` and `loop.test.ts` | registry lookup closed before any container/Job starts, versioned bounded-JSON parsing, named failure reasons, docker/kubernetes argv-and-spec parity, pre-phase agent-launch gating, post-phase publish gating |
| Master prompt (issue #244) | `server/test/master-prompt.test.ts`, `driver/test/master-prompt.test.ts`, the argv/config pins in `docker.test.ts`/`k8s.test.ts`, `loop.test.ts`'s pre-spawn refusal | bounded, versioned renderer output; fail-closed on a missing/malformed claim; identical docker/kubernetes argv; the reserved OpenCode `factory` agent surviving a hostile member config |
| Runner images | `executor-images.test.ts`, `branch-reporter.test.ts` | PID 1 signal forwarding, exact shipped scripts, session attribution, agent-specific startup |
| Analytics | `telemetry-shipping.test.ts`, `routes.ingest.test.ts`, `telemetry*.test.ts`, `telemetry.sql.test.ts` | compatible OTLP/JSON, retry configuration, privacy filters, malformed-payload semantics, deduplication |

Platform-parity cases are not duplicates. Keep both when the same contract is encoded in Docker
argv and Kubernetes object specs. Consolidate only when setup, branch, and expected failure are the
same; the consecutive Kubernetes polling/Secret cleanup cases are the reference pattern.

## Remaining gaps, in priority order

1. The real collector is not in either end-to-end assertion path. Add a synthetic runner export to
   `test:jobs` and `test:k8s --cluster`, pass it through the actual collector, then assert the
   Timescale row and dashboard rollup. Include a dashboard restart inside the collector's 300-second
   retry window and prove one logical datapoint is stored once.
2. The real Docker harness does not kill the driver after claim and prove a replacement fences the
   orphan before writing. The unit suite covers the sequence; the daemon boundary does not.
3. The kind phase proves successful execution, not API outage, stop-during-sync, superseded claim,
   or failed cleanup. Add one fault-injection case at a time; do not recreate the unit matrix in a
   slow cluster suite.
4. Neither real-agent image can emit telemetry offline without the vendor binary/plugin runtime.
   Keep artifact contract tests fast, and reserve image-level emission for a pinned smoke job rather
   than making every unit run depend on external credentials.
5. The `test:k8s --cluster` phase (`scripts/test-k8s.sh`) has no case for an allowlisted block
   helper (`merge-conflict-autofix`, `github-review-reconcile`) — only the bare echo-executor happy
   path. Deferred (issue #210): both real blocks need a "GitHub" to talk to (a git remote to probe/
   rebase against, or `gh`-shaped HTTP responses and a recorded PR publication), and there is no
   agreed shape yet for faking that inside a kind cluster without live GitHub — a fake local git
   remote in the test's own scaffolding and a stub of the helper script's HTTP/`gh` calls inside the
   executor image are the two candidates. Picking one is a test-harness design decision, not an
   integration fix, so it is left open here rather than decided unilaterally.
6. The board-owned master prompt (issue #244) is pinned offline down to the exact argv/config each
   transport builds (`master-prompt.test.ts` on both sides, plus the argv/spec parity pins in
   `docker.test.ts`/`k8s.test.ts`) and against a real database only where `server/test-db` already
   runs. Nothing offline proves the CLIs themselves honor the flags: that the pinned
   `CLAUDE_CODE_VERSION` actually accepts `--append-system-prompt`/`--system-prompt-snapshot off`
   without erroring, or that OpenCode's `run --agent factory` with the merged
   `OPENCODE_CONFIG_CONTENT` really seats a primary agent rather than silently ignoring an unknown
   flag. That needs a real container running the real CLI — an executor-image smoke case, in the
   same family as `executor-images.test.ts`'s static pins but requiring the daemon those pins
   deliberately avoid — and a behavioral fixture proving a task prompt that asks the agent to push
   or open a PR is refused by the CLI's own tool gating while the master prompt is in force. Neither
   exists yet; both need a real model credential, which is out of scope for the offline gates above.

## Efficiency rules

- Prefer one table-driven failure contract over duplicated fixtures.
- Keep real Git tests for semantics the mocks cannot represent, but create large histories with
  `git fast-import`; the PR commit-cap case fell from about 7.7 seconds to 0.77 seconds.
- A new slow boundary test must replace a missing boundary, not repeat an already-covered branch.
- Review the slowest-test report before deleting tests; process startup cost often points to a
  fixture optimization rather than a low-value assertion.
