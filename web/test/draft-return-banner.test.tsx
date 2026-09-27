import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { DraftReturnBanner, withDraftReturn } from '../src/components/DraftReturnBanner.js';

const renderAt = (entry: string) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={[entry]}>
            <DraftReturnBanner />
        </MemoryRouter>
    );

const withReturn = (value: string) => `/settings/executors?return=${encodeURIComponent(value)}`;

describe('DraftReturnBanner', () => {
    it('renders the way back for the exact value /tasks/new', () => {
        const html = renderAt(withReturn('/tasks/new'));
        expect(html).toContain('You have a task draft in progress.');
        expect(html).toContain('Back to new task');
        expect(html).toContain('href="/tasks/new"');
    });

    it.each([
        '',
        'https://evil.example',
        '//evil.example',
        '/tasks/new/',
        '/tasks/new?x=1',
        '/tasks/new#x',
        '/tasks',
        '/TASKS/NEW',
        ' /tasks/new',
        'javascript:alert(1)',
    ])('renders nothing for return=%j', (value) => {
        expect(renderAt(withReturn(value))).toBe('');
    });

    it('renders nothing without the parameter', () => {
        expect(renderAt('/settings/executors')).toBe('');
    });

    it('builds the settings link that carries the return path', () => {
        expect(withDraftReturn('/settings/repos')).toBe('/settings/repos?return=/tasks/new');
    });
});
