import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfigurationScope } from '../src/components/ConfigurationScope.js';

/**
 * The scope/impact/editability block that sits before every environment editor (issue 180). The
 * issue's required language is exact, so these assertions quote it; scope truth is readable text,
 * never a tooltip, a disabled input or a color-only badge — and deliberately not the analytics
 * `ScopeToggle`, which is an interactive control with a different job.
 */

describe('ConfigurationScope', () => {
    it('states the organization scope: every member, any member edits', () => {
        const html = renderToStaticMarkup(<ConfigurationScope scope="organization" />);
        expect(html).toContain('Organization');
        expect(html).toContain('Applies to every member\u2019s tasks in the organization.');
        expect(html).toContain('Any member can edit.');
        expect(html).toContain('a workspace or repository value with the same name overrides this scope');
    });

    it('states the workspace scope: only the current member, only that member edits', () => {
        const html = renderToStaticMarkup(<ConfigurationScope scope="workspace" />);
        expect(html).toContain('My workspace');
        expect(html).toContain('Applies only to tasks the current member starts.');
        expect(html).toContain('Edited only by that member.');
        expect(html).toContain('a repository value with the same name overrides them');
    });

    it('names the repository and states its org-wide reach, any member edits', () => {
        const html = renderToStaticMarkup(
            <ConfigurationScope scope="repository" repository={{ owner: 'acme', name: 'web' }} />
        );
        expect(html).toContain('Repository · acme/web');
        expect(html).toContain('Applies to every task using acme/web in the organization.');
        expect(html).toContain('Any member can edit.');
        expect(html).toContain('nothing more specific remains');
    });

    it('carries the precedence sentence on every scope', () => {
        for (const props of [
            <ConfigurationScope key="org" scope="organization" />,
            <ConfigurationScope key="ws" scope="workspace" />,
            <ConfigurationScope key="repo" scope="repository" repository={{ owner: 'acme', name: 'web' }} />,
        ]) {
            expect(renderToStaticMarkup(props)).toContain(
                'Environment values resolve organization &lt; workspace &lt; repository'
            );
        }
    });

    it('is text, not a control — no button, no pressed state', () => {
        const html = renderToStaticMarkup(<ConfigurationScope scope="organization" />);
        expect(html).not.toContain('<button');
        expect(html).not.toContain('aria-pressed');
    });
});
