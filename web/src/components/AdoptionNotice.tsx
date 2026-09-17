import type { Session } from '../api/useSession.js';

type LegacyOrg = Session['legacyOrganizations'][number];

/**
 * The adoption notice: one line per pre-upgrade organization (issue 123), naming the exact
 * `npm run adopt` command that re-homes its history and retires it.
 *
 * A skipped adoption reads as a bug — a duplicate org in the selector, an empty dashboard —
 * so the dashboard says what to run instead of rendering the symptom silently. The sweep at
 * sign-in keeps the legacy org out of the selector; this notice is what keeps the missing
 * adoption itself from being invisible.
 *
 * The command is filled in ONLY when the server names an unambiguous target (`adoptInto`): one
 * installation org in the whole database. Otherwise the generic form is shown — pairing a
 * legacy org with an installation is the operator's `--from` decision, and a guessed pairing
 * would move another org's history into the viewer's own.
 */
export function AdoptionNotice({
    legacyOrganizations,
    target,
}: {
    legacyOrganizations: readonly LegacyOrg[];
    target: Session['adoptInto'];
}) {
    if (legacyOrganizations.length === 0) return null;
    return (
        <p className="status">
            {legacyOrganizations.length === 1 ? 'An older organization is' : 'Older organizations are'} waiting to be
            adopted — run{' '}
            {legacyOrganizations.map((legacy, i) => (
                <span key={legacy.id}>
                    {i > 0 && '; '}
                    <code>
                        {target
                            ? `npm run adopt -- --installation ${target.id} --from ${legacy.id}`
                            : 'npm run adopt -- --installation <id> --from <legacy-org-id>'}
                    </code>
                </span>
            ))}
            {target ? '' : ', naming the installation id and the legacy organization it succeeds'}
        </p>
    );
}
