---
name: doc-maintenance
description: Keep this repo's documentation short and true. Docs are a map to the code, never a retelling of it — every claim anchors to a file, a test, or a script, and anything a reader could learn in a minute from the source is deleted rather than maintained. Use when the user says "update docs", "doc cleanup", "the docs are stale", "shrink the docs", "check docs for drift", "/doc-maintenance", or after a change whose area has a docs/ page.
---

# Doc maintenance

**Code is the source of truth. Tests are the source of truth. Docs are an index.**

A doc's only job is to get a reader to the right file fast. Prose that explains what the code
already says has two costs: it is read instead of the code, and it rots while the code does not.
So the default action on any paragraph is **delete and link**, and the only prose that survives is
prose that no file can state on its own.

## The shape every doc has

```markdown
# <Area>

<One sentence: what this area is. No history, no rationale.>

| Concern | Code | Test |
| --- | --- | --- |
| <thing a reader comes looking for> | `path/to/file.ts` | `path/to/file.test.ts` |

## Invariants

- <claim that no single file states> — `path/file.ts:fn`, guarded by `path/test.ts`.
```

Hard limits, enforced per file:

- **60 lines** for a normal area doc. **120** only for an area with several independent surfaces
  (jobs, kubernetes, design-system). A runbook of literal commands (`eks-runbook.md`) is exempt from
  the cap but not from the rules.
- Every row and every bullet carries a path. **A claim with no path gets deleted, not researched.**
- The table comes first. If a reader's question is answered by "which file", they never read past it.

## What is deleted on sight

Delete without asking — this is the tenfold reduction, and hesitating on these is what produced the
current size:

| Delete | Because |
| --- | --- |
| Narrative explanation of how code works | The code works that way; read it. |
| Issue-number archaeology (`issue #244`, `with #62`) | Git history has it, and it is never the answer to a question. |
| "X is gone", "no longer", "was removed", "replaced the old" | This repo ships no backward compatibility (AGENTS.md). An absent thing needs no page. |
| Rationale for a decision nobody is re-litigating | A `why` comment belongs at the code, one line. |
| Example payloads, SQL, argv, JSON bodies | Point at the test that asserts the real one. |
| Restated route tables, env tables, flag lists | Point at `routes/*.ts`, `config.ts`, `.env.example`. |
| Warnings about traps a test already catches | Name the test instead; it is the enforcement. |
| Duplicate content across two docs | One home, others link. |

## What survives

Only four kinds of sentence:

1. **Where things live** — the table. The bulk of every doc.
2. **Cross-file invariants** — a constraint no single file states: build order, "docker change needs
   its kubernetes counterpart", "a new `core/src` file must be re-exported from `index.ts`". Each
   names the file that breaks and, if one exists, the test that fails.
3. **Non-obvious operational facts** — what a command destroys, what a database name must match,
   which credential a path needs. Facts with consequences outside the process.
4. **Stated limits** — a capability deliberately not ported, so a reader stops looking. One line.

If a sentence is not one of those four, it goes.

## Running a pass

### Phase 0 — Inventory

`git ls-files '*.md'` (skip the root `CLAUDE.md` pointer). Record line counts; the run is judged
against them. Partition into groups by area, **strict single ownership — no file in two groups**.
`mkdir -p artifacts/doc-maintenance` (gitignored).

### Phase 1 — Brief

Copy `BRIEF-template.md` to `artifacts/doc-maintenance/BRIEF.md`, filling repo path, branch, date.
Agents read the rules there; prompts stay short.

### Phase 2 — Fan out, one owner per doc group

One `general-purpose` agent per group, **all spawned in a single message**. Each prompt:

1. "Read `<abs>/artifacts/doc-maintenance/BRIEF.md` first and follow it exactly."
2. The group's files, absolute paths, with current line counts and each file's target.
3. "Verify every surviving path and test name against the tree before you write it."
4. "Rewrite the files in place. Report back under 150 words: lines before/after, and anything you
   deleted that a human may want back."

Agents rewrite their own files — ownership is strict, so there is no write conflict. They do **not**
touch code, and they do **not** touch `AGENTS.md` (one writer, you, in Phase 4).

### Phase 3 — Verify, do not trust

A rewritten doc that points at a file that does not exist is worse than the prose it replaced.

- Extract every backticked path from the new docs and check it resolves. Mechanical — script it,
  do not eyeball it.
- Check every named npm script exists in a `package.json`, and every named test file exists.
- Read any doc whose reduction was under 50%: either the area genuinely needed the words, or the
  agent paraphrased instead of deleting.

### Phase 4 — AGENTS.md

AGENTS.md is the entry point and gets the same treatment, last, by you alone: the commands block,
the "read before you touch" table, and the invariants that have no other home. Everything else in it
moves into the area doc that owns it or dies. The table's right column must still resolve.

### Phase 5 — Report

`artifacts/doc-maintenance/report.md`: lines before/after per file and in total, the paths that
failed verification and what you did about them, and deletions a human may want to contest. Console
summary: total reduction, and the three deletions most worth a second opinion.

## Touching docs during ordinary work

Outside a full pass, the same contract applies to any doc edit:

- Changed code with an owning doc → update the doc's **table row**, not its prose.
- Tempted to add a paragraph → add a row, or a one-line comment at the code instead.
- Never grow a doc past its cap to fit a new fact. If it does not fit, something in it is dead.
