import type { UseEnv } from '../api/useEnv.js';
import type { Session } from '../api/useSession.js';
import type { UseWorkspace } from '../api/useWorkspace.js';

/**
 * The configuration overview's derivation (issue 180): the five readiness items, computed from
 * exactly what `SettingsLayout` already polls — the session, the shared workspace poll and the
 * shared environment read. Pure data on purpose: no JSX, no fetch effects, no icons, no color
 * words. The page renders what this returns, which is what keeps "what is configured" testable
 * without a browser and stops a status sentence from growing markup opinions.
 *
 * Precedence is the if-chain order, pinned by web/test/settings-overview.test.tsx:
 *
 * - a failed repository outranks queued/cloning ones;
 * - a missing workspace root outranks empty executor/repository lists — root-null is deliberate
 *   deployment configuration, but the driver refuses a claim without `workspacePath`, so nothing
 *   here may call the system runnable;
 * - an initial load never reports zero: `loading` with no data reads as "checking", not "empty";
 * - stale data stays: an `error` that arrives WITH data is ignored here (the page renders it as a
 *   separate line), so a later poll failure never replaces the last true answer with an outage —
 *   only a failure with NO data reads as "unavailable".
 *
 * Zero rows are neutral, not errors: no personal executors is "the deployment default", no custom
 * environment values is "optional".
 */

export type ReadinessTone = 'ok' | 'attention' | 'pending' | 'info';

/** Names the destination — never a bare "Fix". */
export interface ReadinessAction {
    label: string;
    to: string;
}

export interface ReadinessFact {
    text: string;
    /** When set, the fact itself is a way in (the environment item's per-scope links). */
    link?: ReadinessAction;
}

export type ReadinessItemId = 'organization' | 'workspace' | 'repositories' | 'executors' | 'environment';

export interface ReadinessItem {
    id: ReadinessItemId;
    heading: string;
    /** The headline sentence — the one string a reader scans first. */
    status: string;
    facts: ReadinessFact[];
    tone: ReadinessTone;
    action: ReadinessAction | null;
}

/** Exactly what the overview page has in hand — the hooks pass straight through, no adapter. */
export interface ReadinessInput {
    session: Pick<Session, 'organization' | 'role'> | null;
    workspace: Pick<UseWorkspace, 'data' | 'loading' | 'error'>;
    environment: Pick<UseEnv, 'data' | 'loading' | 'error'>;
}

/** A count as a sentence fragment with the verb/noun agreeing — "1 repository needs", "2 repositories need". */
const count = (n: number, singular: string, plural: string): string => `${n} ${n === 1 ? singular : plural}`;

const REVIEW_WORKSPACE: ReadinessAction = { label: 'Review workspace setup', to: '/settings/workspace' };
const REVIEW_REPOS: ReadinessAction = { label: 'Review repository status', to: '/settings/repos' };
const MANAGE_EXECUTORS: ReadinessAction = { label: 'Manage executors', to: '/settings/executors' };

function organizationItem(session: ReadinessInput['session']): ReadinessItem {
    if (!session) {
        return {
            id: 'organization',
            heading: 'Organization',
            status: 'Checking organization…',
            facts: [],
            tone: 'pending',
            action: null,
        };
    }
    return {
        id: 'organization',
        heading: 'Organization',
        status: 'Configured',
        facts: [
            { text: session.organization.name },
            // The role's title, and nothing more: no internal id, no powers the API does not grant.
            { text: `Your role: ${session.role === 'admin' ? 'Admin' : 'Member'}` },
        ],
        tone: 'ok',
        action: { label: 'Review organization settings', to: '/settings/organization' },
    };
}

function workspaceItem(workspace: ReadinessInput['workspace']): ReadinessItem {
    const { data, loading, error } = workspace;
    if (!data) {
        if (loading) {
            return { id: 'workspace', heading: 'Workspace', status: 'Checking workspace…', facts: [], tone: 'pending', action: null };
        }
        return {
            id: 'workspace',
            heading: 'Workspace',
            status: 'Workspace status unavailable',
            facts: error ? [{ text: error }] : [],
            tone: 'attention',
            action: null,
        };
    }
    if (data.root === null) {
        return {
            id: 'workspace',
            heading: 'Workspace',
            status: 'Workspace is not configured; tasks cannot run',
            facts: [],
            tone: 'attention',
            action: REVIEW_WORKSPACE,
        };
    }
    return {
        id: 'workspace',
        heading: 'Workspace',
        status: 'Workspace available',
        // The quiet path value itself — where the checkouts land is the fact a member verifies.
        facts: [{ text: data.root }],
        tone: 'ok',
        action: { label: 'Open workspace settings', to: '/settings/workspace' },
    };
}

function repositoriesItem(workspace: ReadinessInput['workspace']): ReadinessItem {
    const { data, loading, error } = workspace;
    if (!data) {
        if (loading) {
            return { id: 'repositories', heading: 'Repositories', status: 'Checking repositories…', facts: [], tone: 'pending', action: null };
        }
        return {
            id: 'repositories',
            heading: 'Repositories',
            status: 'Repository status unavailable',
            facts: error ? [{ text: error }] : [],
            tone: 'attention',
            action: null,
        };
    }
    if (data.root === null) {
        return {
            id: 'repositories',
            heading: 'Repositories',
            status: 'Repository checkouts require a workspace root',
            facts: [],
            tone: 'attention',
            action: REVIEW_WORKSPACE,
        };
    }
    // Failed outranks in-progress: a clone that failed is the thing to act on, even while others
    // are still cloning.
    const failed = data.repos.filter((repo) => repo.status === 'failed');
    const inProgress = data.repos.filter((repo) => repo.status === 'queued' || repo.status === 'cloning');
    if (failed.length > 0) {
        return {
            id: 'repositories',
            heading: 'Repositories',
            status: `${count(failed.length, 'repository needs', 'repositories need')} attention`,
            facts: failed.map((repo) => ({
                text: repo.error ? `${repo.owner}/${repo.name} — ${repo.error}` : `${repo.owner}/${repo.name}`,
            })),
            tone: 'attention',
            action: REVIEW_REPOS,
        };
    }
    if (inProgress.length > 0) {
        return {
            id: 'repositories',
            heading: 'Repositories',
            status: `Setting up ${count(inProgress.length, 'repository', 'repositories')}`,
            facts: inProgress.map((repo) => ({ text: `${repo.owner}/${repo.name}` })),
            tone: 'pending',
            action: REVIEW_REPOS,
        };
    }
    if (data.repos.length === 0) {
        return {
            id: 'repositories',
            heading: 'Repositories',
            status: 'No repositories enabled for your workspace',
            facts: [],
            tone: 'info',
            action: { label: 'Choose repositories', to: '/settings/repos' },
        };
    }
    return {
        id: 'repositories',
        heading: 'Repositories',
        status: count(data.repos.length, 'repository ready', 'repositories ready'),
        facts: [],
        tone: 'ok',
        action: { label: 'Review repositories', to: '/settings/repos' },
    };
}

function executorsItem(workspace: ReadinessInput['workspace']): ReadinessItem {
    const { data, loading, error } = workspace;
    if (!data) {
        if (loading) {
            return { id: 'executors', heading: 'Executors', status: 'Checking executors…', facts: [], tone: 'pending', action: null };
        }
        return {
            id: 'executors',
            heading: 'Executors',
            status: 'Executor status unavailable',
            facts: error ? [{ text: error }] : [],
            tone: 'attention',
            action: null,
        };
    }
    // Root-null outranks the (empty) list: without a root the rows could not run anyway.
    if (data.root === null) {
        return {
            id: 'executors',
            heading: 'Executors',
            status: 'Personal executors are unavailable',
            facts: [{ text: 'Tasks cannot run until a workspace root is configured.' }],
            tone: 'attention',
            action: REVIEW_WORKSPACE,
        };
    }
    if (data.executors.length === 0) {
        return {
            id: 'executors',
            heading: 'Executors',
            status: 'Using the deployment default',
            facts: [{ text: 'No personal executor rows are required; new tasks run on the deployment default.' }],
            tone: 'info',
            action: MANAGE_EXECUTORS,
        };
    }
    return {
        id: 'executors',
        heading: 'Executors',
        status: `${count(data.executors.length, 'personal executor available', 'personal executors available')}`,
        facts: [{ text: `${data.executors[0]!.name} is selected first on new tasks.` }],
        tone: 'ok',
        action: MANAGE_EXECUTORS,
    };
}

function environmentItem(environment: ReadinessInput['environment']): ReadinessItem {
    const { data, loading, error } = environment;
    if (!data) {
        if (loading) {
            return { id: 'environment', heading: 'Environment', status: 'Checking environment scopes…', facts: [], tone: 'pending', action: null };
        }
        return {
            id: 'environment',
            heading: 'Environment',
            status: 'Environment status unavailable',
            facts: error ? [{ text: error }] : [],
            tone: 'attention',
            action: null,
        };
    }
    const total = data.org.length + data.workspace.length + data.repos.reduce((n, scope) => n + scope.vars.length, 0);
    if (total === 0) {
        return {
            id: 'environment',
            heading: 'Environment',
            status: 'No custom environment values',
            facts: [{ text: 'Environment values are optional; runners run without them.' }],
            tone: 'info',
            action: null,
        };
    }
    // Counts only — no names, no values, no ids. Each scope fact links to the page that edits it,
    // which is why the item itself carries no single action.
    const facts: ReadinessFact[] = [];
    const split = (rows: { isSecret: boolean }[]) => ({
        vars: rows.filter((row) => !row.isSecret).length,
        secrets: rows.filter((row) => row.isSecret).length,
    });
    const org = split(data.org);
    if (data.org.length > 0) {
        facts.push({
            text: `Organization scope: ${count(org.vars, 'variable', 'variables')}, ${count(org.secrets, 'secret', 'secrets')}`,
            link: { label: 'Organization environment', to: '/settings/organization' },
        });
    }
    const workspace = split(data.workspace);
    if (data.workspace.length > 0) {
        facts.push({
            text: `Workspace scope: ${count(workspace.vars, 'variable', 'variables')}, ${count(workspace.secrets, 'secret', 'secrets')}`,
            link: { label: 'Workspace environment', to: '/settings/workspace' },
        });
    }
    if (data.repos.length > 0) {
        const rows = data.repos.flatMap((scope) => scope.vars);
        const repo = split(rows);
        facts.push({
            text: `Repository scope: ${count(repo.vars, 'variable', 'variables')}, ${count(repo.secrets, 'secret', 'secrets')} across ${count(data.repos.length, 'repository', 'repositories')}`,
            link: { label: 'Repository environment', to: '/settings/repos' },
        });
    }
    return {
        id: 'environment',
        heading: 'Environment',
        status: count(total, 'environment value configured', 'environment values configured'),
        facts,
        tone: 'info',
        action: null,
    };
}

/** The five items, in the order the overview renders them. */
export function deriveReadiness(input: ReadinessInput): ReadinessItem[] {
    return [
        organizationItem(input.session),
        workspaceItem(input.workspace),
        repositoriesItem(input.workspace),
        executorsItem(input.workspace),
        environmentItem(input.environment),
    ];
}
