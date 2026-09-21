---
title: Telemetry and metrics
description: Learn how Factory receives, attributes, aggregates, and reports agent telemetry.
editUrl: https://github.com/Bellows-AI/factory/edit/main/docs-site/src/content/docs/concepts/telemetry-metrics.md
---

Factory accepts OTLP metrics and logs from runners and the agent telemetry plugin. Repository and branch
samples associate a session with the code it changed. Dashboard queries then aggregate sessions within
the selected organization, repositories, members, and time range.

Reported measures include:

- session and turn counts;
- input, output, cache-read, and cache-creation tokens;
- lines added and removed;
- active agent time;
- telemetry coverage and unavailable states.

## Important semantics

Cumulative OTEL counters are reduced to the maximum value for each series start time, not summed across
every sample. A restarted series receives a new start time and its maximum is added separately. This
avoids multiplying token counts simply because a runner exported the same cumulative counter more than
once.

`TELEMETRY_TTL_SECONDS` controls one server cache slot. Its default is 30 seconds and values below five
seconds are refused. If a refresh fails after a successful read, Factory serves the last good snapshot
and cools down before retrying rather than replacing the dashboard with a transient error.

An empty telemetry pipeline and an unavailable one are distinct. Empty data returns a real zero-session
response; unavailable data reports that the source cannot currently be read.

## Authentication

Set `INGEST_TOKEN` to require `X-Factory-Ingest-Token` on OTLP writes. Branch attribution uses an
organization-bound personal access token or the runner's attempt ID and lease token; the deployment-wide
ingest token cannot authorize branch samples for an arbitrary organization.
