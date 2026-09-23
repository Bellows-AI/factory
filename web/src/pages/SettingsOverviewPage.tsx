import { Link } from 'react-router-dom';
import { roleLabel } from '../api/useSession.js';
import { KeyValues } from '../components/KeyValues.js';
import { PageHeader } from '../components/PageHeader.js';
import { deriveReadiness } from '../settings/readiness.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * The settings tree's index (issue 180): what is configured for this organization and this
 * member's workspace, read from the two polls `SettingsLayout` already owns — the page itself
 * starts no request of any kind. Notably absent: an `/api/repos` fetch (repository facts derive
 * from the workspace poll's payload) and an executor-config read (those carry credentials and are
 * fetched only when the dialog opens).
 *
 * Every readiness item's action names its destination — there is no generic top-level Fix button.
 * Status is text, the tone class is decoration; and nothing here is a live region, because the
 * workspace poll updates these items and a polite announcement per tick is noise, not information
 * (the `countLabel` precedent in nav-model.ts).
 *
 * A later poll failure keeps the last-good items on screen and renders the error as its own
 * `.status` line below. On an INITIAL failure the item's own fact names the error, so the page
 * does not repeat it.
 */
export function SettingsOverviewPage() {
    const { session, workspace, env } = useSettingsPage();
    const items = deriveReadiness({ session, workspace, environment: env });
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Configuration overview"
                description={`Review what is configured for ${session?.organization.name ?? 'your organization'} and your workspace.`}
            />

            {session ? (
                <section className="panel">
                    {/* Identity, not authority: the organization's display name and the member's role
                        title. No internal id, and no powers the API does not grant the role. */}
                    <KeyValues
                        pairs={[
                            ['Organization', session.organization.name],
                            ['Your role', roleLabel(session.role)],
                        ]}
                    />
                </section>
            ) : (
                <p className="muted">Checking your session…</p>
            )}

            <ol className="readiness">
                {items.map((item) => (
                    <li key={item.id} className={`readiness-item is-${item.tone}`}>
                        <h2>{item.heading}</h2>
                        <p className="readiness-status">{item.status}</p>
                        {item.facts.length > 0 ? (
                            <ul>
                                {item.facts.map((fact) => (
                                    <li key={fact.text} className="readiness-fact">
                                        {fact.text}
                                        {fact.link ? (
                                            <>
                                                {' — '}
                                                <Link to={fact.link.to}>{fact.link.label}</Link>
                                            </>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                        {item.action ? (
                            <Link className="readiness-action" to={item.action.to}>
                                {item.action.label}
                            </Link>
                        ) : null}
                    </li>
                ))}
            </ol>

            {/* Stale-data warnings only: with no data at all, each item's fact already names the
                error, and a second line would say it twice. */}
            {workspace.error && workspace.data ? <p className="status">{workspace.error}</p> : null}
            {env.error && env.data ? <p className="status">{env.error}</p> : null}
        </>
    );
}
