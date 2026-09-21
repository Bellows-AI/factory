import { ConfigurationScope } from '../components/ConfigurationScope.js';
import { KeyValues } from '../components/KeyValues.js';
import { PageHeader } from '../components/PageHeader.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The Organization section of the settings tree (issue 180): who is signed in, what the org
 * environment scope is, and the one org-level editor. The old "not built yet" stub is gone.
 *
 * The editor is enabled for every role, because that is the server's contract — `PUT /api/env/org`
 * accepts any member of the installation (membership is the one trust level, #99, pinned by
 * server/test/routes.env.test.ts). The disabled control this page used to show a member was not
 * authorization; it was a false claim about the API. If product policy ever changes, the server
 * grows a tested 403 first, and THEN a page renders a readable read-only view.
 */
export function SettingsOrganizationPage() {
    const { env, session } = useSettingsPage();
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Organization"
                description="Identity and the environment values injected into every runner in the organization."
            />

            {session ? (
                <section className="panel">
                    {/* Identity, not authority: the display name and the role title. No internal id,
                        and no powers inferred beyond what the API grants. */}
                    <KeyValues
                        pairs={[
                            ['Organization', session.organization.name],
                            ['Your role', session.role === 'admin' ? 'Admin' : 'Member'],
                        ]}
                    />
                </section>
            ) : (
                <p className="muted">Checking your session…</p>
            )}

            <ConfigurationScope scope="organization" />

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
                    hint="Injected into every runner in this deployment. The place for shared credentials — GITHUB_TOKEN, for one."
                    initialVars={env.data.org}
                    onSave={env.saveOrg}
                    draftId="org"
                    draftLabel="Core (organization)"
                />
            ) : null}
        </>
    );
}
