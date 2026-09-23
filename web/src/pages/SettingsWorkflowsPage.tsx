import { useDefaultWorkflowSettings } from '../api/useDefaultWorkflowSettings.js';
import { PageHeader } from '../components/PageHeader.js';
import { DefaultWorkflowPanel } from '../panels/DefaultWorkflowPanel.js';

/**
 * `/settings/workflows` (issue 208): a member's saved defaults for the two optional
 * default-workflow steps. Its own poll (`useDefaultWorkflowSettings`), not one of
 * `SettingsLayout`'s shared polls — the same precedent `TaskComposerPage` sets for
 * `useWorkflows`, since no other settings page needs this data.
 *
 * Not the generic JSON workflow editor (issue 131): this page shows the mandatory prompt → gates →
 * publish spine read-only and exposes exactly the two optional-step switches the board's stored
 * pair carries.
 */
export function SettingsWorkflowsPage() {
    const { data, loading, unavailable, error, save } = useDefaultWorkflowSettings();

    if (loading && !data) {
        return (
            <>
                <PageHeader eyebrow="Settings" title="Default workflow" />
                <p className="status">Loading your default workflow…</p>
            </>
        );
    }

    return (
        <>
            <PageHeader eyebrow="Settings" title="Default workflow" />
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
        </>
    );
}
