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
- **`BarChart` caps `barWidth` at 56px.** The chart is fixed-width, so a one-week range renders
  a single ~580px bar that reads as a filled panel rather than as one data point. Types, tests
  and the SSR smoke render all passed; only `npm run verify:ui` showed it.
