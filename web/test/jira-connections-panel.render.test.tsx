import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ORG_CONNECTION_SCOPE, USER_CONNECTION_SCOPE, type ConnectionView } from '../src/api/connections.js';
import { JiraConnectionDialog, SCOPED_TOKEN_HINT } from '../src/components/JiraConnectionDialog.js';
import {
    ADD_CONNECTION_LABEL,
    DEFAULT_CONNECTION_CAPTION,
    JiraConnectionsPanel,
    NO_CONNECTIONS_NOTE,
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
            onCreate={async () => null}
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

    it('gives an admin the add button in the panel head and a delete per row, with the form kept in the dialog', () => {
        const html = render();
        expect(html).toMatch(new RegExp(`class="panel-head">.*${ADD_CONNECTION_LABEL}</button>`));
        // The fields live in the closed dialog, never inline in the panel.
        expect(html).not.toContain('<input');
        expect(html.match(/>Delete<\/button>/g)).toHaveLength(2);
    });

    it('hides every control from a member, who still reads the list', () => {
        const html = render({ canManage: false });
        expect(html).toContain('new.atlassian.net');
        expect(html).not.toContain(ADD_CONNECTION_LABEL);
        expect(html).not.toContain('<input');
        expect(html).not.toContain('Delete');
    });

    it('says so when the list is empty, and never renders a token', () => {
        const html = render({ connections: [], scope: USER_CONNECTION_SCOPE });
        expect(html).toContain(NO_CONNECTIONS_NOTE);
        expect(html).not.toMatch(/apiToken|api_token/);
    });

    it('disables the add button and every delete while a write is in flight', () => {
        const html = render({ saving: true });
        expect(html.match(/<button[^>]*disabled/g)).toHaveLength(3);
    });
});

/**
 * The add dialog is a Headless UI Dialog and portals, which `renderToStaticMarkup` does not
 * render: its fields, the scoped-token help and the in-dialog refusal are e2e/jira-connections.spec.ts's.
 */
describe('the Jira connection dialog', () => {
    it('server-renders a placeholder, open or closed', () => {
        for (const open of [false, true]) {
            const html = renderToStaticMarkup(
                <JiraConnectionDialog
                    open={open}
                    scope={ORG_CONNECTION_SCOPE}
                    saving={false}
                    onClose={() => {}}
                    onCreate={async () => null}
                />
            );
            expect(html).toContain('<span hidden');
        }
        expect(SCOPED_TOKEN_HINT).toMatch(/scoped \(service-account\) token/);
    });
});
