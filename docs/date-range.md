# Date range

How a selected range narrows the payload, and who owns each half of it.

| Concern | Code | Test |
| --- | --- | --- |
| `resolveRange`, `filterTelemetryInput`, `filterJobRuns` | `core/src/range.ts` | `core/test/range.test.ts` |
| Query parsing and `400 BAD_RANGE` | `server/src/routes/stats.ts` (`parseRange`) | `server/test/routes.stats.get.test.ts` |
| Series granularity and bucketing | `core/src/telemetry.ts` (`seriesGranularity`, `bucketSeries`) | `core/test/telemetry.stats.test.ts` |
| UTC day/week helpers | `core/src/metrics.ts` (`dayStart`, `dayKey`) | `core/test/metrics.invariants.test.ts` |
| The selector and its custom-range draft | `web/src/components/RangeSelector.tsx` | `web/test/range-selector.test.tsx` |
| Bar width under sparse ranges | `web/src/charts/BarChart.tsx` | `web/test/bar-chart.test.tsx` |
| Range interaction with per-task usage | `core/src/task-usage.ts` | `core/test/task-usage.test.ts` |

## Invariants

- **Presets are a rolling lookback, not a calendar period** — "this week" on a Tuesday would
  otherwise read as a throughput collapse.
- **`to` is exclusive, and a bare `YYYY-MM-DD` is widened to the next day**, or "custom: today to
  today" is an empty interval that renders as no activity.
- **Sessions are kept on overlap, not containment**; a task enters a range on session overlap OR on
  its run being queued in range (`filterJobRuns`). Dropping boundary work understates usage exactly
  at the edge the reader is looking at.
- **`TelemetryInput.coverage` is never filtered** — it reports what the store holds, which is how
  the UI tells "no usage in this range" from "telemetry does not reach back this far". It describes
  the store under caller scope too.
- **The payload names its own granularity.** Day buckets up to a 92-day window, ISO weeks beyond,
  boundaries UTC, every bucket in the window seeded including quiet ones, the current one
  `partial`. A chart labelling a bucket size it is not using is a lie with correct numbers.
- **Range filtering is read-time over one cached read** — see [architecture.md](architecture.md).
