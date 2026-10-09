import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ORG_CONNECTION_SCOPE, USER_CONNECTION_SCOPE, type ConnectionView } from '../src/api/connections.js';
import {
    ADD_CONNECTION_LABEL,
    DEFAULT_CONNECTION_CAPTION,
    JiraConnectionsPanel,
    NO_CONNECTIONS_NOTE,
    SCOPED_TOKEN_HINT,
} from '../src/panels/JiraConnectionsPanel.js';

const connection = (site: string, overrides: Partial<ConnectionView> = {}): ConnectionView => ({
    id: `00000000-0000-4000-8000-${site.length.toString().padStart(12, '0')}`,
    site,
    email: `bot@${site}`,
    access: 'read',
    scope: ORG_CONNECTION_SCOPE,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
});

const render = (props: Partial<Parameters<typeof JiraConnectionsPanel>[0]> = {}) =>
    renderToStaticMarkup(
        <JiraConnectionsPanel
            scope={ORG_CONNECTION_SCOPE}
            hint="hint"
            connections={[connection('new.atlassian.net'), connection('older-site.atlassian.net')]}
            canManage
            saving={false}
            onCreate={async () => true}
            onDelete={() => {}}
            {...props}
        />
    );

describe('the Jira connections panel', () => {
    it('lists site, email, access and created date, and marks only the newest as the default', () => {
        const html = render();
        expect(html).toContain('new.atlassian.net');
        expect(html).toContain('bot@older-site.atlassian.net');
        expect(html).toContain('data-label="Access"');
        expect(html).not.toContain('2026-09-01T00:00:00.000Z');
        expect(html.match(new RegExp(DEFAULT_CONNECTION_CAPTION, 'g'))).toHaveLength(1);
        expect(html.indexOf(DEFAULT_CONNECTION_CAPTION)).toBeLessThan(html.indexOf('older-site'));
    });

    it('gives an admin the add controls, the scoped-token hint, and a delete per row', () => {
        const html = render();
        expect(html).toContain(ADD_CONNECTION_LABEL);
        expect(html).toContain('aria-label="Jira API token"');
        expect(html).toContain('type="password"');
        expect(html).toContain(SCOPED_TOKEN_HINT);
        expect(html.match(/>Delete<\/button>/g)).toHaveLength(2);
    });

    it('hides every control from a member, who still reads the list', () => {
        const html = render({ canManage: false });
        expect(html).toContain('new.atlassian.net');
        expect(html).not.toContain(ADD_CONNECTION_LABEL);
        expect(html).not.toContain('<input');
        expect(html).not.toContain('Delete');
    });

    it('never renders a token, and says so when the list is empty', () => {
        const html = render({ connections: [], scope: USER_CONNECTION_SCOPE });
        expect(html).toContain(NO_CONNECTIONS_NOTE);
        expect(html).not.toMatch(/apiToken|api_token/);
        // The only token surface is the write-only password input, with no value attribute.
        expect(html.match(/<input[^>]*type="password"[^>]*>/)?.[0]).not.toContain('value="s');
    });

    it('disables the controls while a write is in flight', () => {
        const html = render({ saving: true });
        expect(html.match(/disabled/g)!.length).toBeGreaterThanOrEqual(5);
    });
});
