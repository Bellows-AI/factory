import { PageHeader } from '../components/PageHeader.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Organization section of the settings tree: a stub, with the one org-level editor that
 * already exists mounted under it (issue 150).
 *
 * The page header says the section is a stub — the sentence is the description slot, and no
 * panel repeats it. The core (organization) environment is admin-written — it reaches every
 * member's runners — and a member sees it read-only with the sentence saying why. The rest of
 * the section is a stub on purpose: organization settings beyond the environment are not built,
 * and a sentence saying so is the honest placeholder, not a silent empty page.
 */
export function SettingsOrganizationPage() {
    const { env, session } = useSettingsPage();
    const isAdmin = session?.role === 'admin';
    return (
        <main className="page">
            <PageHeader
                eyebrow="Settings"
                title="Organization"
                description="Organization settings are not built yet."
            />

            {env.error ? <p className="status">{env.error}</p> : null}
            {/*
                The editor mounts only on DATA, not merely when the request settles: its draft is
                seeded from initialVars in a state initializer, so mounting it early would freeze
                empty rows over whatever is stored — after a failed read an enabled editor would
                be one save away from wiping the scope. The error line above is the read-only
                posture; a retry is the page's next full render.
            */}
            {env.loading && !env.data ? (
                <p className="status">Loading environment…</p>
            ) : env.data ? (
                <EnvVarsPanel
                    title="Core (organization)"
                    hint={
                        isAdmin
                            ? 'Injected into every runner in this deployment. The place for shared credentials — GITHUB_TOKEN, for one.'
                            : 'An admin configures the core environment; it is shown here read-only.'
                    }
                    initialVars={env.data.org}
                    onSave={env.saveOrg}
                    disabled={!isAdmin}
                />
            ) : null}
        </main>
    );
}
