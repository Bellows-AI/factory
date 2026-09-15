# Date range

Read before: touching `filterTelemetryInput()`, `parseRange`, the range selector, or `BarChart`.

- **The cache slot holds the fetched `TelemetryInput`, not a computed `TelemetryStats`.** A range
  re-runs `filterTelemetryInput()` and `telemetryStats()` at read time, so every range is served
  from the one read the TTL paid for and no cache key mentions a range. Pre-aggregating again
  would either bucket the cache per range or force the selector to be cosmetic.
- **Presets are a rolling lookback, not a calendar period.** "This week" on a Tuesday would
  otherwise cover two days and look like a throughput collapse.
- **`to` is exclusive, and a bare `YYYY-MM-DD` from the date input is widened to the next day.**
  Without the widening, "custom: today to today" is an empty interval that renders as no activity.
- **Sessions are kept on overlap, not containment.** A session straddling the range boundary did
  real work inside the range, and dropping it would understate usage exactly at the edge the user
  is looking at.
- **`TelemetryInput.coverage` is never filtered.** It reports what the store holds, which is how
  the UI distinguishes "no AI usage in this range" from "telemetry does not reach back this far".
  The same holds under caller scope: coverage describes the store, never the scope.
- **The usage series buckets by UTC day up to a 92-day window, and by ISO week beyond — and the
  payload names which.** The 92-day threshold is where a fixed-width chart of daily bars stops
  being information; for all-time the coverage span decides, so a short history stays daily
  without anyone configuring anything. `series.granularity` is what the chart's labels and blurb
  render from — a chart describing a bucket size it is not using is a lie with correct numbers.
  Day boundaries are UTC (`dayStart`/`dayKey` beside the week helpers in core), 23:30 and 00:15
  land in different buckets, every day in the window is seeded including quiet ones, and the
  current day is `partial` exactly as the current week is.
- **Tasks enter a range on session overlap or run queued-in-range.** A task's sessions follow the
  overlap rule (`filterTelemetryInput`); its run rows follow the queued-instant rule
  (`filterJobRuns`, half-open like the session bounds). Either one puts the task in the range's
  statistics — boundary-straddling work is not dropped.
- **`BarChart` caps `barWidth` at 56px.** The chart is fixed-width, so a one-week range renders
  a single ~580px bar that reads as a filled panel rather than as one data point. Types, tests
  and the SSR smoke render all passed; only `npm run verify:ui` showed it.
