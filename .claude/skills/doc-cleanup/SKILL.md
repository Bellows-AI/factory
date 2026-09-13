---
name: doc-cleanup
description: Scan every document and code comment in the repo, split them into atomic checkable facts, and verify each against the actual source — commands, paths, env defaults, ports, numeric constants, behavior claims. Reports drift grouped by class and fixes mechanical drift (renamed paths, changed defaults, dead references) directly; judgment calls are listed, never silently rewritten. Use when the user says "doc cleanup", "check docs for drift", "validate documentation", "are the docs still true", or "/doc-cleanup".
---

# Doc cleanup — fact-level drift audit

Docs are written once and read for months. Code renames, defaults change, scripts move — and a doc
that is wrong reads as verified fact, sending the next reader down a dead path with confidence. This
skill re-checks every prose claim in the repo against the code it describes, fixes what is
mechanically wrong, and reports the rest.

The repo's docs are **decision logs, not reference manuals**: facts are embedded mid-sentence, many
statements are deliberate history ("X is gone", "no longer"), and AGENTS.md warns that docs hold
decisions that look like cruft and are not. Extraction and verification must respect that or the run
degenerates into style churn.

## Scope

Documents are **discovered, never hardcoded** — a list rots as fast as the facts it describes.
Phase 0 enumerates them with `git ls-files '*.md'`, which today yields the root docs
(`AGENTS.md`, `README.md`; root `CLAUDE.md` is a one-line `@AGENTS.md` pointer — skip), `docs/*.md`,
`specs/executor/*.md`, the executor and chart READMEs, the executor-home agent instructions
(`docker/*/claude-home`, `docker/*/opencode-home`), and `.claude/skills/*/SKILL.md`.

Code comments (prose only, never code), under:

- `core/src`, `server/src`, `web/src`, `driver/src` — including `driver/src/scripts/*.cjs` and `*.sh`.
- `e2e/`, `scripts/*.sh`, `server/migrations/*.sql`.
- Root config files with decision-log comments: `vitest.config.ts`, `vitest.db.config.ts`,
  `playwright.config.ts`, `web/vite.config.ts`.

## Phase 0 — Inventory and partition

1. `mkdir -p artifacts/doc-cleanup` (gitignored — findings never land in the tree).
2. Enumerate documents with `git ls-files '*.md'` (skip the root `CLAUDE.md` pointer) and the
   comment-bearing source files from the scope above. Record the authoritative list in
   `artifacts/doc-cleanup/inventory.md` — the run is auditable against what it actually covered.
3. Partition into groups of a balanced size, **strict single ownership: no file in two groups**.
   Cluster by verification method, not alphabetically — configuration docs together
   (`configuration.md`, `env.md`, `security.md`), jobs/driver docs together (`jobs.md`,
   `kubernetes.md` + driver sources), one group per package's comments. One grep batch then serves
   the whole group.

## Phase 1 — Write the brief once

Copy `BRIEF-template.md` (bundled next to this file) to `artifacts/doc-cleanup/BRIEF.md` and fill in
**all four placeholders**: repo path, branch, date, and the findings dir. Every agent reads that one
file, so the fact format, verdicts and hazard rules are stated once instead of duplicated into six
prompts.

## Phase 2 — Fan out: one owner per group, read-only in the repo

Spawn one `general-purpose` agent per group — the type that can write its findings file; `explore`
agents are read-only and would silently produce no group file — **all in a single message** so they
run in parallel. The brief pins them to read-only in the repo; their only write is the findings file.
Each prompt contains only:

1. "Read `<absolute path>/artifacts/doc-cleanup/BRIEF.md` first and follow it exactly." Absolute
   paths throughout — the agent's cwd is not guaranteed to be the repo root.
2. The group number and its file list (absolute paths).
3. 3–6 focus hints — the claims in that slice most likely to have rotted (env defaults, port
   numbers, migration names, command names, TTLs).
4. "Write findings incrementally to `<absolute path>/artifacts/doc-cleanup/group-<N>.md`. Report
   back under 200 words."

No repo file is edited during verification — it completes for the whole repo before anything is
touched, and Phase 4 has exactly one writer.

## Phase 3 — Trust but verify

Agent summaries describe intent, not outcome. Before accepting:

- Re-check every `DRIFTED` verdict with one direct grep/read of your own. A wrong "drift" finding
  that reaches Phase 4 becomes a wrong edit to a decision log.
- Settle every `UNVERIFIABLE` the agents left, if a grep or two can do it. Cheap checks are yours,
  not theirs — they ran out of budget, you have not.
- Read any file that two groups touched, and de-duplicate findings.

## Phase 4 — Fix mechanical drift only

Fix directly, matching each file's style (4-space indent, sentence-case prose as found):

- Dead paths — file moved or renamed, doc points at the old one.
- Changed numbers — env default, port, TTL, limit where the doc's value ≠ the source's value.
- Renamed commands and npm scripts — script gone from `package.json`, doc still cites it.
- References to migrations, tables, routes that no longer exist under the cited name.

Report without editing:

- Behavior claims and status codes ("refuses a non-loopback HOST", "returns 202") — correcting these
  needs a judgment about intent; list evidence in the report instead.
- Anything that might be a deliberate decision — AGENTS.md's cruft warning applies. If a guarding
  test exists, the doc is right by definition.
- Cross-repo content (`../factory-stats/SPEC.md`) — existence only; contents are out of scope.

Absolute rules while editing:

- **Never invent a replacement fact.** Wrong-but-unresolvable gets reported, not guessed.
- **Never churn.** Fix the claim in place; no reformatting, no restructuring, no "improving"
  adjacent prose. The diff must contain only what verification changed.
- **Never touch code.** Comments are prose — edit the comment text only, never a line of code.
- Intentional-history statements ("X is gone") are never reworded, even when stale — if the removal
  is no longer true, that is a *report* finding (see Phase 5), never an edit.

## Phase 5 — Report

Write `artifacts/doc-cleanup/report.md`, findings grouped by drift class:

- Fixed — stale number / dead path / renamed command (with file:line for each).
- Reported — behavior claims and judgment calls, each with the evidence a human needs to decide.
  Includes intentional history that has gone false ("X is gone" but X is back) — flag it, never
  reword it.
- Unverifiable — with the reason (cross-repo, needs a running system).
- Intentional history — confirmed still true; counts only.

Then give the user a console summary: how many facts checked, how many fixed, how many reported,
and the three findings a human should look at first.
