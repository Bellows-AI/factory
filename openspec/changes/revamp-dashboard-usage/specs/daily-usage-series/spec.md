## Purpose

Buckets the usage chart by day instead of ISO week, keeping quiet periods honest and stating which
granularity is rendered, so day-to-day variance is visible at the ranges people actually select.

## ADDED Requirements

### Requirement: The usage series is bucketed by UTC day

The token usage chart's series SHALL bucket sessions by UTC calendar day. Every day in the window
SHALL be seeded, including days with no activity, so a quiet day renders as a quiet day and gaps
never close themselves. The current day SHALL be flagged partial, exactly as the current week is
under weekly bucketing.

#### Scenario: Quiet day is kept
- **WHEN** a selected fortnight contains a day with no sessions
- **THEN** the series holds a point for that day with zero activity rather than omitting it

#### Scenario: Day boundary is UTC
- **WHEN** one session was last seen at 23:30 UTC on Monday and another first seen at 00:15 UTC on
  Tuesday
- **THEN** they land in Monday's and Tuesday's buckets respectively

#### Scenario: Today is partial
- **WHEN** the window includes the current day
- **THEN** the current day's point is flagged partial, and the chart says so

### Requirement: Long windows fall back to weekly buckets

When the selected window spans more than 92 days, the series SHALL bucket by ISO week instead of by
day — a fixed-width chart of a year of daily bars renders hairlines, not information. The payload
SHALL name the granularity actually used, so the chart's labels and blurb describe what is rendered
rather than what was requested.

#### Scenario: Month range is daily
- **WHEN** the selected range is the month preset (30 days)
- **THEN** the series holds daily buckets

#### Scenario: All-time over a long history is weekly
- **WHEN** the all-time range spans six months of coverage
- **THEN** the series holds weekly buckets, and the payload names weekly as the granularity

### Requirement: Short windows still render a data point

The day preset SHALL render the current day as a single partial daily bucket, so a one-day window
shows one honest bar rather than an empty chart.

#### Scenario: Today preset
- **WHEN** the selected range is the day preset
- **THEN** the chart renders exactly one daily bucket, flagged partial

### Requirement: Existing series semantics carry over unchanged

Stacked input and output bars, the sessions line on the right axis, cache reads excluded from the
bars, and quiet-bucket seeding SHALL behave under daily bucketing exactly as they do under weekly
bucketing today.

#### Scenario: Chart composition is unchanged
- **WHEN** the daily series renders
- **THEN** input and output stack as before, the sessions line overlays on the right axis, and cache
  reads remain excluded from the bars
