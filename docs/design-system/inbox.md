# Design system — region: inbox

Owned by the inbox lane. Styles: `web/src/styles/regions/inbox.css` — the lane rules plus its
trailing 44px touch-target segment (issue 189). Shared primitives, tokens and the system
contracts: [../design-system.md](../design-system.md).

## Primitives

| Primitive | Classes | Use for |
| --- | --- | --- |
| Task inbox | `inbox`, `inbox-new` | The `/tasks` page (issue 279) and its header action: New task is the primary recipe (accent fill, `--ink-inverse` text, 40px, 20px `plus`) on a link, since `button.primary` skins buttons only |
| Count cards | `inbox-cards`, `inbox-card`, `inbox-card-review`, `inbox-card-running`, `inbox-card-past`, `inbox-card-disc`, `inbox-card-text`, `inbox-card-line`, `inbox-card-value`, `inbox-card-label`, `inbox-card-caption` | Three 88px raised cards, one link each to `?state=review/running/past`, from `navigation.counts` — they never read the filters. A 40px disc on the count's wash (`--accent-wash` + `circle-dot`, `--ok-wash` + `refresh`, `--done-wash` + `check-circle`), the value 28px/600 tabular, the label 14px/600 in the tone's color, "Organization total" 13px muted; the link's `aria-label` is the sentence ("12 tasks need review across the organization"). One column at ≤900px |
| Filters | `inbox-filters`, `inbox-tabs`, `inbox-tab`, `inbox-search`, `inbox-sort` | The state tabs and the sort links are two segmented controls (`--surface` track, the active `inbox-tab` raised with a `--line-strong` edge); the search form keeps its labels, `field` skins and its Filter button. The inputs are controlled, re-synced from the URL, so a removed chip or Back never leaves stale text |
| Chips | `inbox-chips`, `inbox-chip-remove`, `inbox-clear` | One `inbox-chip` per applied `q`/`repo`/`author` (never state or sort); `inbox-chip-remove` is the × — a link, not the primitive's inner button, so removal is a history entry Back undoes — to the same URL without that one param, on a 24px target tucked into the chip's end padding; `inbox-clear` the "Clear filters" link to `/tasks` |
| Rows | `inbox-list`, `inbox-columns`, `inbox-rows`, `inbox-row`, `inbox-title`, `inbox-summary`, `inbox-state`, `inbox-state-waiting`, `inbox-state-done`, `inbox-repo`, `inbox-author`, `inbox-cell-text`, `inbox-when` | A raised frame around an `aria-hidden` column header and the rows, grid `minmax(12rem, 1fr) 168px minmax(0, 160px) minmax(0, 144px) 96px` — the plan's `minmax(0,1fr) 168px 160px 144px 96px` at desktop widths, but between the drawer and the desktop the title keeps a 12rem floor and the repository/author tracks give way instead — 60px min, `--surface-sunken` on hover. The title is the row's one link, 14px/600, over a one-line 13px summary (activity while running, the head's summary once terminal, full text in `title`); the state is a `pill` per the status table, allowed to wrap in its fixed track so a long title never hides it (`inbox-state-waiting` adds the `--line-strong` edge, `inbox-state-done` greens the check); repository with the `repo` glyph, author as `avatar` + login ("?" and "Unknown author" when none), the `RelativeTime` right-aligned. At ≤900px each row stacks into a card: title, pill, then the metadata line |
| States | `inbox-empty`, `inbox-banner-body`, `inbox-error`, `inbox-footer`, `inbox-note` | Empty board and zero matches are distinct centered panels with a 24px glyph (`list`, `search`); a first-page failure is a `banner-bad` whose `inbox-banner-body` holds the message and Retry, a failed refresh a `banner-warn` above rows that stay; `inbox-error` is the inline Load more failure; `inbox-footer` is "Showing N loaded tasks" (no total) beside Load more; `inbox-note` the polite append announcement |


## Inventory

| File | Primitives |
| --- | --- |
| `TaskInboxPage.tsx` | page-header, icon, inbox, inbox-new, inbox-cards, inbox-card, inbox-card-review, inbox-card-running, inbox-card-past, inbox-card-disc, inbox-card-text, inbox-card-line, inbox-card-value, inbox-card-label, inbox-card-caption, inbox-filters, inbox-tabs, inbox-tab, inbox-search, field, inbox-sort, inbox-chips, inbox-chip, inbox-chip-remove, inbox-clear, inbox-list, inbox-columns, inbox-rows, inbox-row, inbox-title, inbox-summary, inbox-state, inbox-state-waiting, inbox-state-done, pill, pill-ok, pill-done, pill-accent, pill-bad, inbox-repo, inbox-author, inbox-cell-text, avatar, avatar-fallback, inbox-when, inbox-empty, banner-bad, banner-warn, banner-title, inbox-banner-body, inbox-error, inbox-footer, inbox-note, sidenav-dot, muted |

