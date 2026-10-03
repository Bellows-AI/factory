# Organizations

An organization is one GitHub App installation: it owns the repo list and partitions every stored
row.

| Concern | Code | Test |
| --- | --- | --- |
| Partitioning of the stored tables | `server/migrations/005_organizations.sql` | `core/test/migrations.sql.test.ts` |
| Per-org runtimes, keyed by org id | `server/src/orgs.ts` | `server/test/orgs.test.ts` |
| Materializing orgs and memberships at sign-in | `server/src/auth/store.ts`, `server/src/routes/auth.ts` | `server/test/auth.oauth.sign-in.test.ts` |
| Choosing installations on a first sign-in | `server/src/routes/auth-onboarding.ts`, `web/src/components/OnboardingOrganization.tsx` | `server/test/auth.completion.test.ts`, `web/test/onboarding.render.test.tsx` |
| Resolving the caller's org per request, `POST /api/auth/org` | `server/src/auth/plugin.ts`, `server/src/routes/auth.ts` | `server/test/auth.session.test.ts` |
| Org selector in the app bar | `web/src/components/OrgSelector.tsx` | `web/test/org-selector.test.tsx` |
| Refusal of retired org variables | `server/src/config.ts` | `server/test/config.org.test.ts` |

## Invariants

- **The org id IS the installation id** (a decimal string) and the name is the installation
  account's login, rewritten on every sign-in — nothing keys on the label. The id passes 010's
  `organization_id_ck` (`^[a-z0-9][a-z0-9_-]{0,38}$`).
- **The org is a property of the caller, not of the process.** A session row and a personal token
  each carry one, re-checked through the `org_membership` join on every request, so a GitHub-side
  removal ends a credential's reach ([auth.md](auth.md)). The driver holds no org-bound credential:
  the shared board secret names a process, and the org comes from the job row.
- **`org_id` leads every org-owned primary key** — a query always knows its organization, so the
  key is a prefix scan rather than a filter. Org-owned-but-user-less rows (an org executor profile,
  an org workflow) are a NULL `user_id` in the same table as the personal ones.
- **`metric_point` carries neither `org_id` nor `repo`**: both resolve by joining `session_branch`,
  so there is one source of truth. `session_branch` is the only table a re-attribution rewrites
  directly ([persistence.md](persistence.md)).
- **Ingest attribution is the credential's, never the report's.** A branch report's `repo` field is
  caller-controlled payload; the org is the runner's lease pair or the plugin's personal token.
  `server/test/routes.ingest.test.ts`.
- **`session_branch_slice` partitions its `lead()` window by `org_id`**
  (`server/migrations/002_views.repeatable.sql`), or one org's slice is truncated by another's
  start. Guarded by `server/test-db/telemetry.sql.test.ts`.
- **`ORG_ID`, `ORG_NAME`, `GITHUB_REPOS`, `ORG_REPOS` and the auto-join variables are fatal, not
  ignored** — see [configuration.md](configuration.md).
- **There is no `OrgProvider` interface, and `createAuthStore` is the one store that takes an
  organization per call** — it is what decides whether a caller belongs to one, so its lookups
  cannot start from an org. Every other store binds `orgId` at construction in `orgs.ts`.
