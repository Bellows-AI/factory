/**
 * The limits of the telemetry, on the page rather than only in the spec: without this copy the
 * numbers above read as more complete than they are.
 */
export function Limitations() {
    return (
        <section className="panel">
            <h2>What this cannot tell you</h2>
            <ul className="limits">
                <li>
                    <strong>The token and line counts are what the agent wrote, not what survived.</strong> Claude Code
                    telemetry carries no commit SHA and no branch, so nothing here can say "340 lines of feature X are
                    AI-written". The honest reading is "written during sessions in this repository".
                </li>
                <li>
                    Repo attribution rests on a hook that samples the current checkout roughly every 20 seconds and is
                    allowed to fail silently. A session shorter than one interval can be missed entirely.
                </li>
                <li>
                    AI usage only covers sessions after the plugin was installed, on machines that have it. A quiet week
                    is not necessarily a week without AI.
                </li>
                <li>
                    No monetary cost, deliberately. Prices and cache discounts change, and a dollar figure would imply
                    precision these totals cannot support.
                </li>
                <li>
                    The four token types are never summed into one number — a long cached conversation would count the
                    same context repeatedly — and the counts include work that was rejected, undone or abandoned.
                </li>
                <li>
                    No AI-vs-human share of the codebase. Telemetry reports agent activity, and nothing here can divide
                    a shipped diff between the two.
                </li>
                <li>n is small. Weekly points are noisy and a single large session moves a total.</li>
                <li>Nothing here says whether the shipped work was the right work.</li>
            </ul>
        </section>
    );
}
