import type { StatsPayload } from '../api/useStats.js';

export function DataQualityPanel({ meta }: { meta: StatsPayload['meta'] }) {
    const range = meta.range;
    const items: string[] = [
        // The window bounds shown elsewhere are what the fetch returned, not what was asked
        // for; without this line a narrowed range looks like a shrinking repository.
        ...(range.from || range.to
            ? [
                  `Every figure above covers ${range.from?.slice(0, 10) ?? 'the start of the window'} to ${range.to?.slice(0, 10) ?? 'now'} only. Sessions outside that range are excluded.`,
              ]
            : []),
        // Caller scope changes what the figures cover; naming it here keeps the page honest
        // about whose numbers are on screen when "mine" is selected.
        ...(meta.scope === 'mine' && meta.scopeLogin
            ? [`Figures are scoped to ${meta.scopeLogin} — switch to Org for the whole organization.`]
            : []),
    ];

    // Two counters, not one: "wrong repo" and "no hook" present identically on the page
    // otherwise — an empty telemetry panel with a healthy backend.
    const t = meta.telemetry;
    if (t.status === 'disabled') {
        items.push('Agent telemetry is not configured, so no AI usage is reported.');
    } else {
        if (t.status === 'unreachable') {
            items.push(`Telemetry is unreachable — ${t.reason ?? 'the store could not be read'}.`);
        }
        if (t.sessionsWithoutHook > 0) {
            items.push(
                `${t.sessionsWithoutHook} agent session(s) sent telemetry but no repo, so they are not attributed to this dashboard — install the agent-telemetry plugin.`
            );
        }
        if (t.otherRepoSessions > 0) {
            items.push(
                `${t.otherRepoSessions} agent session(s) happened in another repo and are excluded; this dashboard only counts ${t.repoFilter.join(', ')}.`
            );
        }
        if (t.unattributedSessions > 0) {
            // Its own line, beside the other exclusions: sessions with telemetry but no board
            // task are a different setup state from no-hook and wrong-repo, and the by-user
            // table alone does not reach a reader checking the page for holes.
            items.push(
                `${t.unattributedSessions} agent session(s) match no board task and are counted as unattributed — local runs, backfilled transcripts, or removed tasks.`
            );
        }
        if (t.source === 'fixture') {
            items.push(
                'AI usage figures are synthetic fixture data, not measurements. Set TELEMETRY_SOURCE=postgres to report real sessions.'
            );
        }
    }

    if (!items.length) return null;

    return (
        <section className="panel warn">
            <h2>Data quality</h2>
            <ul>
                {items.map((text) => (
                    <li key={text}>{text}</li>
                ))}
            </ul>
        </section>
    );
}
