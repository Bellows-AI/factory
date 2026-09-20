import type { ReactElement } from 'react';

/**
 * The readable scope context an environment editor renders before its controls (issue 180): what
 * the scope applies to, who may edit it, and where a value of the same name would win. Presenta-
 * tional by contract, like PageHeader — no hooks, no fetching, no route inspection — and plain
 * text on purpose: scope truth is never a tooltip, a disabled input, or a color-only badge.
 *
 * Deliberately NOT the analytics `ScopeToggle` (issue 166): that one switches the dashboard's data
 * cut and carries buttons; this one states facts and renders no control at all.
 *
 * The write rules below are the server's, not this component's wish: `PUT /api/env/org` and
 * `PUT /api/env/repo` accept any member of the installation (membership is the one trust level,
 * #99) and `PUT /api/env/workspace` writes the caller's own rows — server/test/routes.env.test.ts
 * pins all three. Precedence — organization < workspace < repository, most specific wins — is
 * `stackEnv`'s rule, exported from the store and pinned offline there.
 */

export type ConfigurationScopeId = 'organization' | 'workspace' | 'repository';

type ScopeProps =
    | { scope: 'organization' | 'workspace' }
    | { scope: 'repository'; repository: { owner: string; name: string } };

/** Per-scope copy, in one table so the three editors cannot drift apart. */
const COPY: Record<ConfigurationScopeId, { label: string; impact: string; editability: string; precedence: string }> = {
    organization: {
        label: 'Organization',
        impact: 'Applies to every member\u2019s tasks in the organization.',
        editability: 'Any member can edit.',
        precedence:
            'Environment values resolve organization < workspace < repository: a workspace or repository value with the same name overrides this scope.',
    },
    workspace: {
        label: 'My workspace',
        impact: 'Applies only to tasks the current member starts.',
        editability: 'Edited only by that member.',
        precedence:
            'Environment values resolve organization < workspace < repository: these values override the organization scope, and a repository value with the same name overrides them.',
    },
    repository: {
        label: 'Repository',
        impact: 'Applies to every task using {repo} in the organization.',
        editability: 'Any member can edit.',
        precedence:
            'Environment values resolve organization < workspace < repository: these values override the organization and workspace scopes, and nothing more specific remains.',
    },
};

export function ConfigurationScope(props: ScopeProps): ReactElement {
    const copy = COPY[props.scope];
    const fullName = props.scope === 'repository' ? `${props.repository.owner}/${props.repository.name}` : null;
    return (
        <div className="scope-context">
            <p className="scope-context-label">{fullName ? `Repository · ${fullName}` : copy.label}</p>
            <p>{fullName ? copy.impact.replace('{repo}', fullName) : copy.impact}</p>
            <p>{copy.editability}</p>
            <p className="muted">{copy.precedence}</p>
        </div>
    );
}
