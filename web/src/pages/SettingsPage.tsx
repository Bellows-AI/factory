import { useSession } from '../api/useSession.js';
import { IdentityPanel } from '../panels/IdentityPanel.js';

/**
 * The member's own account: identity today, one section per future concern (personal access
 * tokens, …). Sections stack as plain `section.panel`s — the vocabulary every other page uses — so
 * a new concern is one more block, not a nav framework.
 */
export function SettingsPage() {
    // Unreachable null: LoginGate only mounts the app once a session exists. The hook re-checks
    // on 401, so a session expiring while this page is open unmounts the tree at the gate.
    const { session } = useSession();
    if (!session) return null;
    return (
        <main>
            <section className="panel">
                <div className="panel-head">
                    <h2>Account</h2>
                </div>
                <IdentityPanel session={session} />
            </section>
        </main>
    );
}
