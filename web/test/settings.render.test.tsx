import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import type { AccessTokenView } from '../src/api/useAccessTokens.js';
import { AccessTokensPanel } from '../src/panels/AccessTokensPanel.js';
import { IdentityPanel } from '../src/panels/IdentityPanel.js';

/** The same contract panels.render.test.tsx pins: a null metric never leaks as a value. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const session: Session = {
    user: {
        id: '00000000-0000-4000-8000-000000000001',
        login: 'octocat',
        name: 'The Octocat',
        githubUserId: 4242,
        avatarUrl: 'https://avatars.githubusercontent.com/u/4242.png',
    },
    role: 'admin',
    membership: { invitedAt: '2026-01-15T09:30:00.000Z', claimedAt: '2026-01-16T10:00:00.000Z' },
    account: { createdAt: '2026-01-15T09:30:00.000Z', lastLoginAt: '2026-08-21T12:00:00.000Z' },
    organization: { id: 'bellows', name: 'Bellows AI' },
    workspacePath: '/workspaces/bellows/00000000-0000-4000-8000-000000000001',
    mode: 'github',
};

/** The stand-in account AUTH_MODE=none attributes everything to. */
const local: Session = {
    ...session,
    user: {
        ...session.user,
        login: '__local__',
        name: null,
        githubUserId: 0,
        avatarUrl: null,
    },
    role: 'admin',
    membership: { invitedAt: null, claimedAt: null },
    account: { createdAt: null, lastLoginAt: null },
    workspacePath: null,
    mode: 'none',
};

describe('IdentityPanel', () => {
    it('shows the identity facts, linking the login to GitHub', () => {
        const html = renderToStaticMarkup(<IdentityPanel session={session} />);
        expect(html).toContain('href="https://github.com/octocat"');
        expect(html).toContain('The Octocat');
        expect(html).toContain('4242');
        expect(html).toContain('admin');
        expect(html).toContain('2026-01-16 10:00');
        expect(html).toContain('<code>/workspaces/bellows/00000000-0000-4000-8000-000000000001</code>');
    });

    it('never emits a placeholder value for an absent field', () => {
        const html = renderToStaticMarkup(<IdentityPanel session={local} />);
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
        expect(html).toContain('—');
    });

    it('renders the stand-in account as a local stand-in, not as a GitHub identity', () => {
        // Its login is unrepresentable as a real GitHub login and its numeric id is 0 — a value
        // GitHub never issues. Neither may render as if it were GitHub data.
        const html = renderToStaticMarkup(<IdentityPanel session={local} />);
        expect(html).toContain('authentication off');
        expect(html).not.toContain('github.com');
        expect(html).not.toContain('>0<');
    });
});

const noopMint = async () => ({ ok: false, error: 'unused' }) as const;
const noopRevoke = async () => null;

const tokenRows: AccessTokenView[] = [
    {
        id: '10000000-0000-4000-8000-000000000001',
        label: 'ci',
        createdAt: '2026-08-01T09:00:00.000Z',
        lastUsedAt: '2026-09-01T10:00:00.000Z',
        revokedAt: null,
    },
    {
        id: '10000000-0000-4000-8000-000000000002',
        label: 'old laptop',
        createdAt: '2026-07-01T09:00:00.000Z',
        lastUsedAt: null,
        revokedAt: '2026-08-15T09:00:00.000Z',
    },
];

describe('AccessTokensPanel', () => {
    it('lists labels and last use, and never a token or a hash', () => {
        const html = renderToStaticMarkup(
            <AccessTokensPanel
                title="Personal access tokens"
                hint=""
                tokens={tokenRows}
                loading={false}
                error={null}
                onCreate={noopMint}
                onRevoke={noopRevoke}
            />
        );
        expect(html).toContain('ci');
        expect(html).toContain('old laptop');
        expect(html).toContain('2026-09-01 10:00');
        expect(html).not.toContain('fat_');
        expect(html).not.toContain('oat_');
        expect(html).not.toContain('tokenHash');
        for (const forbidden of FORBIDDEN) expect(html, forbidden).not.toContain(forbidden);
    });

    it('renders a dash for a token never used, and revoked instead of a revoke button', () => {
        const html = renderToStaticMarkup(
            <AccessTokensPanel
                title="Personal access tokens"
                hint=""
                tokens={tokenRows}
                loading={false}
                error={null}
                onCreate={noopMint}
                onRevoke={noopRevoke}
            />
        );
        expect(html).toContain('—');
        expect(html).toContain('revoked');
        // Only the live token is revocable — the revoked row carries no button of its own.
        expect(html).toContain('aria-label="Revoke ci"');
        expect(html).not.toContain('Revoke old laptop');
    });

    it('offers the create form and the empty state, with no printed-once block until a mint', () => {
        const html = renderToStaticMarkup(
            <AccessTokensPanel
                title="Organization access tokens"
                hint="Acts for the organization."
                tokens={[]}
                loading={false}
                error={null}
                onCreate={noopMint}
                onRevoke={noopRevoke}
            />
        );
        expect(html).toContain('No tokens');
        expect(html).toContain('Create token');
        expect(html).toContain('Acts for the organization.');
        expect(html).not.toContain('Shown once');
    });
});
