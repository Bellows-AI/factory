import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { CLOSE_LABEL, DIALOG_LABEL, MobileNavDialog } from '../src/components/MobileNavDialog.js';
import type { Job } from '../src/api/useJobs.js';
import type { StatsPayload } from '../src/api/useStats.js';

/**
 * The mobile drawer (issue 160) is a Headless UI Dialog, so it portals — and
 * `renderToStaticMarkup` does not render portals: an open drawer server-renders as Headless'
 * placeholder span, exactly like the RepoPickerDialog. The in-dialog contracts (focus trap,
 * Escape, backdrop, the labels themselves) are therefore a real browser's to assert, and
 * e2e/navigation.spec.ts owns them. What a static render CAN pin is the boundary — the
 * component server-renders without crashing whatever it mounts to — and the labels it will
 * carry, exported as the constants the component and the e2e spec both read.
 */

const META = null as unknown as StatsPayload['meta'] | null;

const render = (open: boolean) =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={['/tasks']}>
            <MobileNavDialog open={open} onClose={() => {}} onNavigate={() => {}} tasks={null} meta={META} />
        </MemoryRouter>
    );

describe('MobileNavDialog', () => {
    it('server-renders a placeholder until the client mounts, open or closed', () => {
        for (const open of [false, true]) {
            expect(render(open)).toContain('<span hidden');
        }
    });

    it('labels the dialog and its close control for the browser to mount', () => {
        // The dialog role takes its accessible name from the title; the close control speaks for
        // itself. e2e asserts the mounted result against these same constants.
        expect(DIALOG_LABEL).toBe('Navigation');
        expect(CLOSE_LABEL).toBe('Close navigation');
    });
});
