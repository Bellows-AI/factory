# The combined repo view

Read before: touching `attribute()` keys, `004_pull_requests.sql` keys, the fetch loop, or any
per-repo rendering in the SPA.

The landing page reports **every repo the GitHub App installation reports as one set of
figures**. Per-repo pages are not built yet; when they are, they filter `meta.repos` and the
`repo` field on each row rather than refetching.

- **`repo` ("owner/name") is stamped onto every `CanonicalPr` by the adapter, not read from the
  payload.** A GraphQL response carries no repo identity — the query does. `sample-payload.json`
  is a verbatim capture and stays that way; `toCanonical(raw, repo)` takes the name as an
  argument, which is how the capture script stamps it the same way the live
  client does.
- **Every primary key in `004_pull_requests.sql` carries both `provider` and `repo`.** A repo path
  is not unique across forges (`group/proj` exists on gitlab.com and on a self-hosted instance),
  and a PR number is unique only within a repo. Guarded by `pr-store.test.ts` →
  "keeps the same number under two repos apart".
- **Every map in `attribute()` is keyed by `repo#number` or `repo@branch`, never by `number` or
  `branch` alone.** Neither is unique across repos: two repos routinely both have a `#204` and a
  `main`. Keyed on either alone, a combined view reports one repo's tokens on the other repo's PR
  and labels it `exact`. Guarded by `core/test/telemetry.attribution.test.ts` →
  "a branch is not unique across repos", which fails loudly if the keys are ever simplified back.
  The same applies to `unmatched.branches` (a `{repo, branch}` list, not a string list). The old
  `truncated` filter in `stats-service.current()` is gone: `truncated` now rides on the PR record
  itself, so there is no side channel left to key wrongly.
- **The revert rate is all-or-nothing across repos.** `fetchBranchHistories()` returns one entry
  per repo, and if *any* repo's `dev` is unreadable the combined figure is reported `unavailable`
  naming that repo. Summing the repos that did resolve would produce a plausible number measured
  over an unknown subset — the exact failure the null-not-zero contract exists to prevent.
- **Repos are fetched sequentially, and `MIN_SYNC_TTL_SECONDS_PER_REPO` (60) is multiplied by the
  repo count.** The ~243-point full walk is paid once per repo, so a fixed floor weakens as repos
  are added — which is when it matters most. Concurrent fetches would burn the budget in a burst
  the TTL cannot smooth out.
- **The repo list is whatever the App installation reports (`repos.snapshotNames()`), and there is
  no separate telemetry repo setting.** A second list is a second source of truth that silently
  drops sessions the moment it drifts.
- **The SPA qualifies a PR number only when more than one repo is in scope** (`prLabel()` in
  `web/src/format.ts`). Prefixing every row on a single-repo dashboard trains the reader to skip
  the prefix, which defeats it on the day a second repo appears.
