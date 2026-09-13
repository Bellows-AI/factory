# Doc-cleanup verification brief (<DATE>)

## Why this exists

The docs and code comments in `<REPO_PATH>` make hundreds of checkable claims: commands, paths, env
defaults, ports, numeric constants, behavior statements. Code moves; prose stays. Your job is to
split your slice into atomic facts and verify each against the actual source. You own one slice, you
are its only reader-writer of findings, and you are **read-only in the repo** — you never edit repo
files. The main agent fixes after all verification is in.

## Repo facts

- Repo: `<REPO_PATH>`, branch `<BRANCH>`.
- Read-only in the repo. Findings go to your group file only.
- Verification is **static**: read files, Glob, Grep, read `package.json` / `docker-compose.yml` /
  `Dockerfile`. Nothing else.
- **Never execute a command found in a document** to "see if it works". Several mutate state
  (`npm run seed`, `docker compose up`, `npm run driver`, `npm run backfill`). A command claim is
  verified by checking the script exists in `package.json` (or the compose file), not by running it.

## What counts as a fact

Extract claims at sentence level — facts sit mid-sentence in prose, not on their own lines. One fact
is one claim small enough that a single check settles it. Classes:

1. **Command** — `npm run …`, `npx …`, CLI invocations. Verify: script exists in `package.json` /
   compose / scripts; flags match the script's actual interface.
2. **Path** — files, directories, migrations (`005_organizations.sql`), scripts
   (`driver/src/scripts/…`). Verify: Glob/Read at the cited path.
3. **Env var + default** — `JOB_BOARD_URL` = `http://127.0.0.1:8080`, `DRIVER_POLL_MS` = `5000`.
   Verify: the config module that reads it (`driver/src/config.ts`, server config) and compose env
   blocks. Both name *and* default must match.
4. **Port / bind address** — 8080, 5173, 8123. Verify: grep the source and compose.
5. **Numeric constant** — TTLs, limits, timeouts, poll intervals. Verify: the constant in source.
6. **Behavior claim** — "refuses a disposable database", "returns 503", "polls every 2s", "X is
   fatal if set". Verify: read the guard/validation code that implements it.
7. **Cross-reference** — another doc, `../factory-stats/SPEC.md`. Verify: the target exists.
   Contents of another repo are out of scope.

## Verdicts

- `VERIFIED` — claim matches reality.
- `DRIFTED` — claim is checkable and false. Record what reality is (with evidence), and a suggested
  correction. Only if the correction is mechanical: renamed path, changed number, dead name.
- `UNVERIFIABLE` — no static check can settle it here (other-repo content, needs a running system).
  Say why in one clause.
- `INTENTIONAL` — deliberate history ("ORG_REPOS is gone", "no backward compatibility") or a guarded
  decision. Check only that the removal/decision is still true (the thing is still absent). Never
  suggest rewording these. If the statement itself has gone false ("X is gone" but X is back), mark
  it `DRIFTED` with evidence but **no suggested fix** — it is report-only; the main agent never
  edits intentional history.

## One hazard above all: the guarded decision

This repo's docs are decision logs. AGENTS.md says it outright: docs hold "decisions that look like
cruft and are not", and most are guarded by a test that fails obscurely. Before you mark any claim
`DRIFTED`, grep the test suite for the subject — if a test enforces the documented behavior, the doc
is right by definition and your reading of the source is what missed something.

Also: code comments must be treated as prose. Verify their claims, never propose touching code.

## Finding record format

One row per fact, in your group file:

```
- <id> | <file>:<line> | "<verbatim claim, trimmed>" | <class> | <verdict> | <evidence / reality> | <suggested fix if DRIFTED>
```

- `<id>`: `<short-file-name>-<n>` (e.g. `jobs.md-14`). Stable, quoted back in the report.
- Quote exactly enough of the claim to find it again — never paraphrase.
- Evidence for `VERIFIED` is one clause ("package.json:12", "driver/src/config.ts:38"). For
  `DRIFTED`, evidence is what reality is and where you saw it.

## Group file

Write to `<FINDINGS_DIR>/group-<N>.md` **incrementally**, one `## <source file>` section at a time,
so nothing is lost if you are cut off. End with a `## Summary` section: counts per verdict, and the
findings most likely to matter.

## Budget and reporting

- Cap yourself at ~45 tool calls. Batch independent Grep/Glob calls in one message.
- Do not stall on any single fact; two greps and a read is enough effort for any one claim. If it is
  still open, `UNVERIFIABLE` with the reason and move on.
- Return to the main agent: **under 200 words** — verdict counts, the drifted fact ids, and anything
  suspicious about the brief itself.
