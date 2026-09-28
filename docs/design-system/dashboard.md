# Design system — region: dashboard

Owned by the dashboard lane. Styles: `web/src/styles/regions/dashboard.css` — the lane rules plus its
trailing 44px touch-target segment (issue 189). Shared primitives, tokens and the system
contracts: [../design-system.md](../design-system.md).

## Primitives

| Primitive | Classes | Use for |
| --- | --- | --- |
| Grid | `two-up` | Two-panel dashboards |
| Controls row | `dashboard-controls` | The dashboard's control row under the page header: the analytics toolbar, which moved here from the old global topbar (issues 160 and 159) |
| Cards | `cards`, `card` | Numeric figure tiles inside a panel |
| Analytics toolbar | `analytics-toolbar`, `toolbar-group`, `toolbar-label`, `toolbar-value` | The dashboard's visibly labeled Range / Scope / Repositories groups (#166, refined by #246): each a real `fieldset`/`legend` — the caption groups the trigger without stealing its own accessible name — read-only values sunken like the inputs they echo |
| Range | `range-dialog`, `range-dialog-title`, `range-draft`, `range-draft-fields`, `range-draft-actions` | The Range group's one dropdown (issue 246): a `select-trigger`/`popover`/`popover-option` Listbox over the presets plus Custom; picking a preset commits it, picking Custom opens the `range-dialog` — a Headless UI Dialog in the shared `dialog` panel and shell — holding the draft form (`range-draft`, `range-draft-fields` for the two labeled date fields); Apply, Cancel and Clear are the only ways to commit or discard it |
| Rendered-data summary | `analytics-summary` | The one-line payload sentence under the toolbar groups — mono, muted, a polite live region |
| Freshness | `updated-at`, `updated-at-full` | Relative "Updated …" copy; the precise stamp is revealed on hover and keyboard focus and carried by a `<time dateTime>` |
| Metric summary | `usage-summary`, `usage-groups`, `usage-group`, `usage-tokens`, `usage-label`, `usage-measures`, `usage-measure` | The dashboard's six measures in four groups (#166): the hierarchy IS the grid — Sessions and the wider Token usage group first — and narrow widths restack the same DOM order. Each `usage-measure` stacks its figure, label and cache detail in its own column (#246) so nothing collides; Token usage holds Total input (with its uncached, cache-read and cache-write parts beneath it), Cache hit rate and Output, and Output carries none of the input parts |
| Analytics empty state | `usage-empty` | The one "nothing measured in this selection" state that replaces the dash-card chorus, naming the selection and one next action |
| Usage bar | `usage-track`, `usage-bar` | The proportional New-tokens bar in the by-user table: a sunken-well track with a chart-blue fill, `aria-hidden` — width is decoration, the cell's accessible name carries the exact figure |
| Task title | `task-title` | The board section's linked task identity cell, clamped after two lines |

Charts:

| Primitive | Classes | Use for |
| --- | --- | --- |
| Frame | `chart-wrap`, `chart` | The overflow scroll and the SVG itself |
| Grid | `grid`, `grid-alt`, `tick`, `axis-label` | Gridlines (alt = dashed), ticks and labels — all `--ink-muted`/`--chart-grid` |
| Marks | `bar` (+ `bar-primary`, `bar-ok`, `bar-warn`, `bar-bad`), `line`, `dot` (+ `dot-warn`, `dot-bad`) | Series fills; `dot` default is `--lamp-done` |
| Partial | `bar-partial`, `bar-partial-hatch` | The hatch over a partial bucket (the current day/week), painted behind the bars — a non-color mark, grayscale-safe |
| Bucket target | `bucket-hit` | The transparent rect over each bucket; one roving tab stop, accent edge on `:focus-visible` |
| Tooltip | `chart-tooltip`, `chart-tooltip-box` | The active bucket's exact readout, rendered inside the SVG so it scales with it |
| Legend | `legend`, `legend-button`, `swatch`, `swatch-primary`, `swatch-ok`, `swatch-warn` | Series toggle buttons (`aria-pressed`); swatches stay in step with their marks and dim when the series is off; a toggle paints no hover fill |
| Caption | `chart-caption`, `chart-disclosure` | The one-line caption (keying the hatched partial bucket when one exists) and the calculation `<details>` after the chart |
| Empty | `chart-empty` | The all-hidden readout — **All series hidden** instead of a broken plot |


## Inventory

| File | Primitives |
| --- | --- |
| `DashboardPage.tsx` | page-header, dashboard-controls |
| `AnalyticsToolbar.tsx` | analytics toolbar, rendered-data summary, range |
| `RangeSelector.tsx` | analytics toolbar, selector, range, dialog, primary, status |
| `ScopeToggle.tsx` | analytics toolbar, selector |
| `DataTable.tsx` | table-wrap, data, sortable, th.asc, th.desc, align-end |
| `Card.tsx` | card |
| `TaskUsagePanel.tsx` | data, align-end, muted |
| `ByUserPanel.tsx` | data, align-end, usage-track, usage-bar, task-avatar, by-user-user |
| `RecentTasksPanel.tsx` | panel, alert, muted, data, task-title, task-avatar, by-user-user |
| `UsageSummaryPanel.tsx` | metric summary, badge |
| `TokenUsagePanel.tsx` | chart-wrap, legend, legend-button, swatch, chart-caption, chart-disclosure |
| `TelemetryFrame.tsx` | alert, badge |
| `Axes.tsx` | grid, tick, axis-label |
| `BarChart.tsx` | bar, line, bucket-hit, bar-partial, bar-partial-hatch, chart-tooltip, chart-tooltip-box, chart-empty |
| `HBarChart.tsx` | bar |
| `Scatter.tsx` | dot, axis-label |
| `scale.ts` | helper — no markup |

