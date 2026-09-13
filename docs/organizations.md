# Organizations

Read before: touching `org_id` anywhere, `server/migrations/005_organizations.sql`, `adoptOrg()`,
or the org selector in the topbar.

An **organization owns the repo list and partitions every stored row.** There is exactly one per
deployment, defined by `ORG_ID`/`ORG_NAME` — `meta.organization.mode` is the literal
`'config'`. The selector in the topbar is a real `<select disabled>`; mode 2 turns it on by dropping
one attribute.

**There are accounts and memberships now** (see [auth.md](auth.md)), and that changed less here than
it looks. Signing in checks a caller's membership against the one configured organization rather than
selecting between several, so the store still binds `orgId` at construction and `mode` is still
`'config'`. Mode 2 is what makes the org a property of the *caller* rather than of the process, and
it has not been built.

- **`ORG_ID` defaults to the literal `default`, and `ORG_NAME` to `ORG_ID`.** The id leads every
  org-owned primary key, so deriving it from anything that can change would re-key every persisted
  row the day that thing changed — the dashboard comes back empty and reads as data loss, not as a
  config change. A *label* can be derived for free, because nothing keys on one. The name used to
  fall back to `GITHUB_OWNER`; there is no owner to fall back to now, because a GitHub App
  installation reports each repository with its own, so the id is the only other name the process
  has. Requiring `ORG_ID` was rejected: it breaks every existing `loadConfig({})` case, and that is
  the signal not to require, not an obstacle to work around.
- **The id is rejected, never normalised** (`^[a-z0-9][a-z0-9_-]{0,38}$`, no leading `__`). It is
  simultaneously a database key and a URL parameter, and a case-insensitive collision in a key is
  invisible: `Bellows` and `bellows` are two partitions that read as one. Silently lowercasing would
  leave the file, the database and the query string disagreeing.
- **`GITHUB_REPOS` and `ORG_REPOS` are fatal, not ignored.** The one deliberate exception to "an
  unknown environment variable is ignored", and for exactly the reason that rule is stated: a
  variable that *was* meaningful and is now dropped reverts a two-repo dashboard to one repo and
  still renders, indistinguishable from a repo genuinely removed. The error names the variable
  rather than saying "unknown key", because a key that demonstrably worked yesterday reads as a
  typo and the reader's next move is to type it again.
- **A Factory organization is not a GitHub organization.** `ORG_ID` names this deployment's data
  partition and has nothing to do with the GitHub account the App is installed on; the repo list
  is whatever that one installation reports. Do not "simplify" by tying one to the other.
- **`org_id` leads every org-owned primary key.** `005` partitioned ten tables; `ORG_OWNED` — the
  list `adoptOrg()` updates — is down to `session_branch` alone now, because 023 dropped the PR
  tables that made up the rest (see [persistence.md](persistence.md)). The id leads rather than
  trails because a query always knows its organization, so the key is a prefix scan of the
  partition rather than a filter applied afterwards.
- **`metric_point` has no `org_id`, on purpose.** It has no `repo` either, for the reason stated in
  `001_init.sql`: a datapoint's repo is resolved by joining `session_branch`, so there is one source
  of truth rather than two that disagree. Its organization comes through that same join. Adding the
  column would mean a second source of truth *and* rebuilding a unique index on a hypertable.
  Consequence: a session with metrics but no `session_branch` row belongs to no organization, which
  is why `session_summary` is read with `org_id = $1 or org_id is null` — those rows are exactly
  what `sessionsWithoutHook` counts, and filtering them would make a broken hook look like an idle
  week. Guarded by "still reports a hook-less session, which belongs to no organization".
- **Pre-organization rows are backfilled `'__unclaimed__'` and adopted once, at boot.**
  `005_organizations.sql` cannot see the config, and backfilling the configured id directly would
  point a deployment that sets `ORG_ID=bellows` at an empty partition: **200 OK, zero sessions, no
  log line**. `adoptOrg()` in `db/migrate.ts` claims them, which is why `migrate()` takes a required
  `orgId` and why `config.ts` refuses any id beginning with `__`.
- **`session_branch_slice` partitions its `lead()` window by `org_id`, not merely projects it.**
  Otherwise the clamp runs across organizations and one org's slice is truncated by another's start,
  silently dropping the datapoints in between. Guarded by "does not attribute one organization's
  session to another's branch".
- **There is no `OrgProvider` interface, deliberately.** `TokenProvider` is the tempting precedent,
  but it earned its interface the hard way: it was async before its second implementation existed,
  on a bet that swapping a personal access token for a GitHub App would touch no call site — and
  the bet paid. A directory's org list is per *user*, so its real signature is
  `resolve(caller, orgId)` — which this bullet originally noted was meaningless "in a codebase with
  no caller, no session and no auth". There is now a caller and a session, and the conclusion is
  unchanged: there is still no *directory*, `resolveOrg` is still one function taking the configured
  org, and the room mode 2 needs is still in the *data shape* (`mode` + `available[]`) and in the
  store's construction-time org binding. When mode 2 arrives this becomes a wider signature on the
  same function, not a provider. Do not add one for symmetry.
- **`app_user` and `session` are NOT org-owned; `org_membership` is.** `005_organizations.sql` picks
  org-owned tables as "exactly those that already carry `repo`", and a GitHub identity carries none.
  The consequence if it were keyed by organization: one human becomes two accounts with two ids, and
  the per-user Claude credential planned on top of that id is the person's, not the organization's.
- **The store binds `orgId` at construction**, not per call: it is a constant for the life of the
  process, and it is the shape a request-scoped store needs later anyway. **`createAuthStore` is the
  one exception** and takes the organization per call, because it is what *decides* whether a caller
  belongs to one — and because a worker token's lookup cannot start from an organization at all,
  being the thing that reports which one a driver is working for.
