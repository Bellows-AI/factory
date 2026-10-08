import { ADMIN_ROLE } from '@factory-ai/core';
import { useWorkflowsManagement } from '../api/useWorkflows.js';
import { PageHeader } from '../components/PageHeader.js';
import { useSettingsPage } from './SettingsLayout.js';
import { WorkflowsPanel } from '../panels/WorkflowsPanel.js';

/**
 * `/settings/workflows`: the reusable-workflow management panel (issue 131) — list, create, edit
 * and delete a member's own custom definitions. Its own poll (`useWorkflowsManagement`), not one
 * of `SettingsLayout`'s shared polls, the same precedent `TaskComposerPage` sets for
 * `useWorkflows`, since no other settings page needs it.
 */
export function SettingsWorkflowsPage() {
    const management = useWorkflowsManagement();
    const { session } = useSettingsPage();

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Workflows"
                description="The reusable workflows you manage. A task with no workflow runs your prompt as written."
            />
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
