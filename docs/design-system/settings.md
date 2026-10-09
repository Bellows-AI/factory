# Design system — region: settings

The settings area. `web/src/styles/regions/settings.css`; shared system:
[../design-system.md](../design-system.md).

| Concern | Code | Test | Classes |
| --- | --- | --- | --- |
| Executor editor dialog | `web/src/components/ExecutorDialog.tsx`, `executor-dialog-parts.tsx` | `web/test/executor-dialog.test.tsx` | `picker-field-actions`, `picker-help`, `picker-advanced`, `picker-managed`, `picker-save-hint`, `picker-actions` |
| JSON configuration editor | `web/src/components/JsonEditor.tsx` | `e2e/json-editor.spec.ts` | `json-editor-gutter`, `json-editor-area`, `json-editor-highlight`, `json-editor-input`, `json-token-key`, `json-token-string`, `json-token-number`, `json-token-literal`, `json-token-punct`, `json-token-invalid`; select-all and partial selections stay readable (`--selection-wash`) |
| Repositories page | `web/src/components/RepositorySetup.tsx`, `repository-setup.ts`, `web/src/pages/SettingsRepositoriesPage.tsx` | `web/test/repository-setup.test.ts`, `web/test/repository-setup.render.test.tsx` | `repo-scope`, `repo-cards`, `repo-card-disc-accent`, `repo-card-disc-ok`, `repo-card-disc-warn`, `repo-card-disc-bad`, `repo-card-label`, `repo-card-value`, `repo-card-caption`, `repo-search`, `repo-toolbar-count`, `repo-table`, `repo-row-configured`, `repo-save`, `repo-na`, `repo-detail-body` |
| Environment variable editor | `web/src/panels/EnvVarsPanel.tsx`, `env-vars-panel-parts.tsx`, `env-draft.ts`, `env-raw.ts` | `web/test/env-draft.test.ts`, `web/test/env-raw.test.ts`, `web/test/env.render.test.tsx`, `e2e/env.spec.ts` | `env-tabs`, `env-vars`, `env-pending`, `env-advanced-note`, `env-advanced-toggle`, `env-errors`, `env-row-actions`, `env-row-remove`, `env-add` |
| Save footer and the discard confirmation | `web/src/components/SettingsSaveActions.tsx`, `UnsavedChangesDialog.tsx` | `web/test/unsaved-changes.test.tsx` | `settings-actions`, `settings-dirty`, `settings-toggle`, `unsaved-title`, `unsaved-actions` |
| Organization executors and the member roster | `web/src/panels/OrgExecutorsPanel.tsx`, `OrgExecutorsSection.tsx`, `MembersPanel.tsx`, `MembersSection.tsx`, `org-executor-confirm.ts`, `web/src/components/OrgExecutorConfirmDialog.tsx` | `web/test/org-executors-panel.render.test.tsx`, `web/test/org-executors-section.test.ts`, `web/test/org-executor-confirm.test.ts`, `web/test/members-panel.render.test.tsx`, `web/test/members-section.test.ts`, `e2e/org-executors.spec.ts` | `org-executor-add`, the shared row-actions pattern |
| Jira connections (org-wide and personal) and the add dialog | `web/src/panels/JiraConnectionsPanel.tsx`, `JiraConnectionsSection.tsx`, `web/src/components/JiraConnectionDialog.tsx`, `web/src/api/connections.ts` | `web/test/jira-connections-panel.render.test.tsx`, `e2e/jira-connections.spec.ts` | the executor dialog's `picker-field` and `picker-actions`, the shared `table-cards` pattern |
| Settings pages, overview readiness, scope context, workspace, workflows | `web/src/pages/SettingsOverviewPage.tsx`, `SettingsOrganizationPage.tsx`, `SettingsWorkflowsPage.tsx`, `SettingsWorkspacePage.tsx`, `SettingsExecutorsPage.tsx`, `web/src/components/ConfigurationScope.tsx`, `WorkspaceRootBanner.tsx`, `OrphanDeleteDialog.tsx`, `web/src/panels/WorkflowsPanel.tsx`, `WorkspaceExecutorsPanel.tsx`, `PersonalExecutorRemoval.tsx` | `web/test/settings-pages.render.test.tsx`, `web/test/settings-overview.test.tsx`, `web/test/configuration-scope.test.tsx`, `web/test/workflows-panel.render.test.tsx`, `web/test/workspace.render.test.tsx`, `e2e/workspace.spec.ts` | `readiness-item`, `readiness-status`, `readiness-fact`, `readiness-action`, `scope-context-label` |

## Invariants

- The JSON editor's two layers must keep identical text metrics: the highlighted `code` inherits
  the textarea's font and line height with no inline-code padding or inset, or mouse hit testing
  drifts off the visible glyphs. `e2e/json-editor.spec.ts` clicks the painted text to prove it.
- Ownership-changing verbs confirm before they write. The copy and the single write dispatch live
  in `web/src/panels/org-executor-confirm.ts`, so neither is reachable from a row click.
- Status meaning is in the words: a readiness card's edge stays neutral and only its pill is toned.
- A settings table reflows into `table-cards` at ≤640px rather than widening its scroll region;
  every cell names itself with `data-label`.
