---
title: Telemetry and metrics
description: Learn how Factory receives, attributes, aggregates, and reports agent telemetry.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/concepts/telemetry-metrics.md
---

Factory accepts OTLP metrics and logs from runners and the agent telemetry plugin. Repository and branch
samples associate a session with the code it changed. Dashboard queries then aggregate sessions for
the selected organization's tracked repositories over the selected time range. The only narrower
view is the dashboard's **Scope** selector, which can limit the figures to the signed-in member
(`scope=mine`); per-member breakdowns are shown as a rollup, not a filter.

Reported measures include:

- session counts, overall and per member;
- input, output, cache-read, and cache-creation tokens;
- lines added and removed, and edit acceptance;
- active agent time;
- per-task statistics: wall-clock time, agent turns, job turns (runs per task), and tokens, with
  average, p50, and p95
  distributions;
- diagnostic counters for sessions in untracked repositories, sessions with no repository sample,
  and sessions that cannot be attributed to a member;
- telemetry coverage and unavailable states.

## Important semantics

Cumulative OTEL counters are reduced to the maximum value for each series start time, not summed across
every sample. A restarted series receives a new start time and its maximum is added separately. This
avoids multiplying token counts simply because a runner exported the same cumulative counter more than
once.

`TELEMETRY_TTL_SECONDS` controls one server cache slot. Its default is 30 seconds and values below five
seconds are refused. If a refresh fails after a successful read, Factory serves the last good snapshot
and cools down before retrying rather than replacing the dashboard with a transient error.

`meta.telemetry.status` reports one of four states:

- `ok` — data was read normally.
- `empty` — the pipeline is wired but has no sessions; the response is a real zero-session result.
- `unreachable` — the first read failed; the request answers `503`.
- `disabled` (`TELEMETRY_SOURCE=off`) — the request answers `503`.

Separately, `stale: true` alongside `ok` or `empty` means a refresh failed and the last good
snapshot is being served with `200`.

## Authentication

Set `INGEST_TOKEN` to require `X-Factory-Ingest-Token` on OTLP writes. With `AUTH_MODE=github`,
branch attribution requires either a personal access token or the runner's attempt ID and lease
token; organization access tokens are refused, and the deployment-wide ingest token cannot
authorize branch samples for an arbitrary organization. With `AUTH_MODE=none`, the branch route is
open.
