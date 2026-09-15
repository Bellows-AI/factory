# Design: dedicated executor transcript store

## Context

Headless claude-code runs write transcripts to `$CLAUDE_CONFIG_DIR/projects/<slug>/<uuid>.jsonl`
on the container filesystem; `docker rm -f` at cleanup destroys them. Two facts in the tree
shape the fix:

- The runner always mounts the workspaces volume, and the opencode runner already persists
  through it the same way (`XDG_DATA_HOME=<mount>/<workspacePath>/.opencode` — docker.ts,
  k8s.ts twin).
- `docker/claude-executor/entrypoint.sh` already seeds an empty `CLAUDE_CONFIG_DIR` from the
  pristine baked copy `/opt/claude-home` — a mechanism built for the Remote Control auth
  volume (it mounts empty and would otherwise hide the baked git-guard settings), keyed on
  `settings.json` existing rather than on the directory being empty.

Follow-up claims resume with `--resume <sessionId>`, which resolves the session **inside
`$CLAUDE_CONFIG_DIR`**. Today a headless follow-up resumes against an ephemeral config dir —
the session it names does not exist there. The transcript store fixes this as a side effect;
the design leans on it rather than working around it.

Motivation and scope: see proposal.md. Behavior contract: specs/executor-transcripts/spec.md.

## Goals / Non-Goals

**Goals:**

- Transcripts land on the workspaces volume the moment the CLI writes them — no post-run
  copy window, docker and kubernetes alike.
- The redirect reuses the existing seed mechanism and existing settings patching unchanged.
- Per-thread-root grouping that doubles as the resume key for headless follow-ups.

**Non-Goals:**

- Reading, analyzing, or ingesting transcripts anywhere; retention policy (unbounded v1);
  re-homing opencode's sqlite; organizing the Remote Control auth-volume pile; any new
  volume, API surface, or database schema.

## Decisions

### D1 — Redirect at the source, not a post-run copy

The entrypoint points `CLAUDE_CONFIG_DIR` at a per-thread-root directory on the workspaces
volume; the CLI writes transcripts there by construction. Alternatives rejected: post-run
copy (`exec tar` piped into a writer throwaway) has a loss window between run end and copy —
a driver crash in that window loses the transcript anyway, the exact event the re-claim fence
exists for — and needs separate docker and kubernetes implementations; `docker cp` lands on
the driver's host, which is the wrong machine under a remote daemon.

### D2 — The per-thread-root directory IS the config dir

`CLAUDE_CONFIG_DIR=<mount>/<workspacePath>/.factory/transcripts/<rootJobId>/` — no separate
`config/` nesting. Rationale: the seed is already keyed on `settings.json` (entrypoint.sh:15),
so an existing thread dir seeds once and every later attempt — re-claim or follow-up — finds
the previous session's transcript for `--resume`. RootJobId is stable across every attempt and
follow-up of a thread (it is the claim's worktree key too), so resume works with no new
state. Alternative (config in a subdir, transcripts copied out at close) reintroduces a copy
and was rejected; splitting cosmetic layout later is cheap, the requirement only fixes the
path shape, not the internal layout.

### D3 — The entrypoint grows one guarded block, the seed does the rest

At the top of `entrypoint.sh`, before the existing seed: when `FACTORY_TRANSCRIPT_DIR` is
set, `mkdir -p` it and `export CLAUDE_CONFIG_DIR="$FACTORY_TRANSCRIPT_DIR"`. Everything
downstream — the `/opt/claude-home` seed, the `.claude.json` trust patch, the
`settings.json` OTEL-endpoint patch — already reads `$CLAUDE_CONFIG_DIR` dynamically and
keeps working unchanged. The block refuses loudly if `TRUST_WORKDIR` is also set (Remote
Control posture — the driver must never combine them), in `set -e` POSIX sh. Both runner
images carry both CLIs and serve both executors, so one image change covers docker and
kubernetes; the opencode image needs no change at all (the driver never sends the name to an
opencode run).

### D4 — Driver composes the path from claim fields, guarded like every board-derived path

A `transcriptDir(config, job)` helper next to `runWorkingDir`:
`<workspaceMount>/<workspacePath>/.factory/transcripts/<rootJobId>`. `workspacePath` passes
the existing `^<org>/<uuid>$` assertion; `rootJobId` is board-supplied and gets the same
`UUID` assertion `envFilePath` applies to `job.id` before it becomes a path fragment. Passed
as `-e FACTORY_TRANSCRIPT_DIR=<value>` when `cli === 'claude-code' && !remoteControl` —
covering headless fresh runs AND headless resumes (the resume needs the dir) — and as the
same env entry in the kubernetes Job spec's env array beside the existing path-literal
entries. A path literal, never a credential: same classification as `WORKDIR` and
`XDG_DATA_HOME`.

### D5 — `FACTORY_TRANSCRIPT_DIR` is a reserved name on both sides

Added to `RESERVED_ENV_NAMES` (driver) and the mirrored list in `server/src/routes/env.ts` —
the board's list is a superset by `OPENCODE_CONFIG_CONTENT`, per the existing arrangement.
A member-configured value of that name is refused at PUT and would be shadowed at claim
time; the runner always receives the driver-composed path.

### D6 — Remote Control and opencode stay exactly as they are

Remote Control keeps the auth volume over `CLAUDE_CONFIG_DIR` (standby/park depends on it;
the driver never sends the transcript env under RC, and the entrypoint refuses the
combination). Opencode keeps `XDG_DATA_HOME` and its per-member sqlite — its transcripts
already persist, and duplicating them buys nothing this change is for.

## Risks / Trade-offs

- [Unbounded growth of the workspaces volume] → Accepted for v1 (proposal scope); the
  `.factory/` namespace makes a future sweep or quota tooling trivial to aim. Volume capacity
  is shared with checkouts — note for the operator, not a code change.
- [Stale seed per thread dir] → A thread dir seeded by an older image keeps that seed for
  the thread's life; a fresh image's baked changes (guard rules, settings) land only in new
  thread dirs. Strictly better than the auth volume, which seeds once per volume forever;
  accepted.
- [Two writers on one thread dir] → A superseded attempt may still be dying while its
  successor runs; both would share the dir. Pre-existing exposure (the same two-writer window
  the heartbeat 409-kill bounds for the worktree), not widened materially by config-dir
  writes; accepted.
- [Claude Code may treat the config dir as scratch (todos, shell-snapshots, statsig)] →
  Writes land in the per-thread dir by design; the CLI state co-locating with the transcript
  is the accepted D2 shape.
- [Headless follow-ups start actually resuming] → Today `--resume` against an ephemeral
  config dir cannot find the session; after this change it can, surfacing any latent
  resume-path bugs. That is the intended behavior (spec: transcripts survive, keyed by
  thread root), named so the change is not blamed for breaking something.

## Migration Plan

No migration: no API, schema, or config-shape changes. Deploy order is irrelevant — the
driver may pass the env before the images learn it (entrypoint ignores unknown names until
updated) and vice versa (no env, no redirect, current behavior). Rollback is "stop passing
the env": transcripts stop persisting, nothing else changes.

## Open Questions

None blocking. The only deliberate deferral is cosmetic: whether analysts later want bare
`projects/**.jsonl` separated from CLI scratch inside the thread dir (D2 alternative).
