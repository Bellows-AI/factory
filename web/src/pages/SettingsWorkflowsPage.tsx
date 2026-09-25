import { ADMIN_ROLE } from '@factory-ai/core';
import { useDefaultWorkflowSettings } from '../api/useDefaultWorkflowSettings.js';
import { useWorkflowsManagement } from '../api/useWorkflows.js';
import { PageHeader } from '../components/PageHeader.js';
import { useSettingsPage } from './SettingsLayout.js';
import { DefaultWorkflowPanel } from '../panels/DefaultWorkflowPanel.js';
import { WorkflowsPanel } from '../panels/WorkflowsPanel.js';

/**
 * `/settings/workflows`: a member's saved defaults for the two optional default-workflow steps
 * (issue 208), plus the generic reusable-workflow management panel (issue 131) — list, create,
 * edit and delete a member's own custom definitions. Two independent polls
 * (`useDefaultWorkflowSettings`, `useWorkflowsManagement`), neither one of `SettingsLayout`'s
 * shared polls, the same precedent `TaskComposerPage` sets for `useWorkflows`, since no other
 * settings page needs either.
 */
export function SettingsWorkflowsPage() {
    const { data, loading, unavailable, error, save } = useDefaultWorkflowSettings();
    const management = useWorkflowsManagement();
    const { session } = useSettingsPage();

    return (
        <>
            <PageHeader eyebrow="Settings" title="Workflows" />
            {loading && !data ? <p className="status">Loading your default workflow…</p> : null}
            {/* Gated on `!data`: `unavailable` also flips true when a SAVE hits the 503 (the
                settings store vanished mid-session, data already loaded) — the panel's own
                inline refusal covers that case, and this categorical "not available" sentence
                must never sit above a still-interactive, still-enabled panel that contradicts it. */}
            {!data && unavailable ? (
                <p className="status">Default-workflow settings are not available for this organization.</p>
            ) : null}
            {!unavailable && error ? <p className="status">{error}</p> : null}
            {/* Requiring `data` keeps the failed-poll state honest, and holds the panel's draft
                back until there is something to seed it from — the same gate EnvVarsPanel's
                caller applies. */}
            {data ? <DefaultWorkflowPanel initialSettings={data} onSave={save} /> : null}
            <WorkflowsPanel
                workflows={management.workflows}
                loading={management.loading}
                error={management.error}
                isAdmin={session?.role === ADMIN_ROLE}
                fetchOne={management.fetchOne}
                onCreate={management.create}
                onUpdate={management.update}
                onRemove={management.remove}
            />
        </>
    );
}
