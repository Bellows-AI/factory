import { useMemo, useState } from 'react';
import { Outlet, useLocation, useOutletContext } from 'react-router-dom';
import { useStats } from '../api/useStats.js';
import type { StatsPayload, FetchState } from '../api/useStats.js';
import { useTasks } from '../api/useTasks.js';
import type { UseTasks } from '../api/useTasks.js';
import { useSession } from '../api/useSession.js';
import type { Session } from '../api/useSession.js';
import { DEFAULT_RANGE, DEFAULT_SCOPE, statsQuery } from './RangeSelector.js';
import type { RangeSelection, ScopeSelection } from './RangeSelector.js';
import { SideNav } from './SideNav.js';
import { AppBar } from './AppBar.js';
import { MobileNavDialog } from './MobileNavDialog.js';

/**
 * Everything both pages share: the range, the scope, the one `/api/stats` poll, and the chrome
 * around them.
 *
 * The poll lives HERE rather than in the dashboard page because the Workspace page renders the
 * repos the dashboard reports on, and two pages each running `useStats` would be two polls of the
 * same endpoint during every cold fetch.
 */
export interface ShellContext {
    data: StatsPayload | null;
    range: RangeSelection;
    setRange: (range: RangeSelection) => void;
    scope: ScopeSelection;
    setScope: (scope: ScopeSelection) => void;
    /** The signed-in member, when there is one — what makes the org/my toggle exist at all. */
    session: Session | null;
    progress: FetchState | null;
    error: string | null;
    /** The one task-overview poll, shared by the tasks pages the way the stats poll is. */
    tasks: UseTasks;
}

/** Typed access to what the layout route publishes. */
export function useShell(): ShellContext {
    return useOutletContext<ShellContext>();
}

export function AppShell() {
    // The range is state because it is an INPUT the user changes and that must ride the next
    // request. The organization is not: with one config-defined org it is server-reported identity,
    // read straight off `meta`, so a useState here would need a value before the first payload
    // exists and would have to be reconciled against every response — two sources of truth for one
    // value. When the org becomes an input its state moves up to here too:
    //
    //     const [org, setOrg] = useState<string | null>(null);   // null = the server's default
    //     const query = useMemo(
    //         () => (org ? `${rangeQuery(range)}&org=${org}` : rangeQuery(range)),
    //         [range, org],
    //     );
    //
    // useStats keys on the query string, so that re-polls with no change to the hook.
    //
    // This block used to live in App.tsx and predicted that "when accounts arrive the org becomes an
    // input and the state moves up to here". Accounts arrived, and what moved up was the range —
    // into this layout route, which is the new "here".
    const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE);
    // The scope is an input like the range, and lives beside it for the same reason: it must
    // ride the next request and survive a range change, and `useStats` keys on the composed
    // query string, so changing either re-polls with both values and nothing is reconciled.
    const [scope, setScope] = useState<ScopeSelection>(DEFAULT_SCOPE);
    const query = useMemo(() => statsQuery(range, scope), [range, scope]);
    const { data, progress, error } = useStats(query);

    // The task overview is the same decision as the stats poll above — one instance, above the
    // Outlet — with one difference: it is gated to the tasks area. The sidenav's own comment
    // already rejected a poll that runs on every page for a number nobody is looking at, and a
    // full task list is that request at a larger size; so the chain runs only while the member is
    // on `/tasks` or under it, and the sidenav renders no preview anywhere else. The hook reads
    // the URL itself: the inbox's filters come from the query string exactly on `/tasks`, the
    // composer and detail views ask the default attention question.
    const { pathname } = useLocation();
    const onTasks = pathname === '/tasks' || pathname.startsWith('/tasks/');
    const tasks = useTasks(onTasks);

    // The session for the app bar's user menu. A second `useSession` instance next to the gate's —
    // the account page already does the same; the module-level listener they
    // register is a Set for exactly this reason.
    const { session } = useSession();

    // The mobile navigation drawer's open state (issue 160). It lives HERE — above both the app
    // bar, whose trigger mirrors it as aria-expanded, and the dialog itself — so neither chrome
    // piece owns state the other renders.
    const [navOpen, setNavOpen] = useState(false);

    const context: ShellContext = {
        data,
        range,
        setRange,
        scope,
        setScope,
        session,
        progress,
        error,
        tasks,
    };

    return (
        <div className="shell">
            {/* The first focusable element on every page (issue 160): a keyboard user's first Tab
                makes it visible, activating it moves focus to the main region below — and nothing
                else ever moves focus there, so ordinary client-side navigation never steals it.
                A plain fragment anchor is the whole mechanism; the target's tabIndex={-1} is what
                lets Chrome and Safari land focus on a non-interactive region. */}
            <a className="skip-link" href="#main-content">
                Skip to main content
            </a>
            <SideNav navigation={onTasks ? tasks.navigation : null} onNavigate={() => setNavOpen(false)} />
            <div className="shell-main">
                <AppBar
                    meta={data?.meta ?? null}
                    session={session}
                    navOpen={navOpen}
                    onOpenNav={() => setNavOpen(true)}
                />
                {/* The routed page's one main region. The `.page` container — not the bare element
                    selector — carries the padding and width cap, so a dialog or a nested main can
                    never inherit page chrome by accident. Pages render fragments into it. */}
                <main id="main-content" className="page" tabIndex={-1}>
                    <Outlet context={context} />
                </main>
            </div>
            {/* The drawer renders from the shell's own state; the same close closes it whether the
                trigger, a link, Escape or the backdrop asked (issue 160). */}
            <MobileNavDialog
                open={navOpen}
                onClose={() => setNavOpen(false)}
                onNavigate={() => setNavOpen(false)}
                navigation={onTasks ? tasks.navigation : null}
                meta={data?.meta ?? null}
            />
        </div>
    );
}
