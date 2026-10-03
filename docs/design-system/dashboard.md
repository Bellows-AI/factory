# Design system — region: dashboard

Telemetry and charts. `web/src/styles/regions/dashboard.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test |
| --- | --- | --- |
| Page frame, control row, and the toolbar's range, scope, coverage and freshness | `web/src/pages/DashboardPage.tsx`, `web/src/components/AnalyticsToolbar.tsx`, `RangeSelector.tsx`, `ScopeToggle.tsx` | `e2e/dashboard.spec.ts`, `web/test/range-selector.test.tsx`, `web/test/scope-toggle.test.tsx` |
| Metric cards, the one empty state, telemetry panels, the task board section | `web/src/panels/UsageSummaryPanel.tsx`, `TelemetryFrame.tsx`, `TokenUsagePanel.tsx`, `TaskUsagePanel.tsx`, `ByUserPanel.tsx`, `RecentTasksPanel.tsx` | `web/test/dashboard-summary.test.ts`, `web/test/panels.render.test.tsx`, `web/test/dashboard-telemetry.test.tsx`, `web/test/recent-tasks.render.test.tsx` |
| Chart marks, axes, scales | `web/src/charts/BarChart.tsx`, `Axes.tsx`, `scale.ts` | `web/test/bar-chart.test.tsx` |

## Invariants

- Unmeasured renders "—", a measured zero renders 0, the Tokens card headlines total input rather
  than a sum of the token types, and no trend, comparison or cost appears here.
- Recent tasks is the board, not telemetry: range and scope do not filter it.
- The usage bar's width is `aria-hidden` decoration; the partial-bucket hatch is grayscale-safe.

Classes defined here: `two-up`, `dashboard-controls`, `analytics-toolbar`, `analytics-summary`,
`toolbar-group`, `toolbar-label`, `toolbar-value`, `toolbar-coverage-dot`, `range-dialog-title`,
`range-draft-fields`, `range-draft-actions`, `updated-at-full`, `usage-groups`, `usage-disc-ok`,
`usage-body`, `usage-label`, `usage-caption`, `usage-empty`, `usage-track`, `usage-bar`, `tick`,
`task-title`, `recent-tasks-head`, `chart-wrap`, `chart-caption`, `chart-disclosure`, `chart-empty`,
`chart-tooltip-box`, `grid-alt`, `axis-label`, `bar-primary`, `bar-ok`, `bar-partial-hatch`, `line`,
`bucket-hit`, `legend-button`, `swatch-primary`, `swatch-ok`, `swatch-warn`.
