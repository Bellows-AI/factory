import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ADD_LABEL, ExecutorDialog, SAVE_LABEL, TYPE_CONFIG_NOTE } from '../src/components/ExecutorDialog.js';

/**
 * The add/edit executor dialog is a Headless UI Dialog, so it portals — and
 * `renderToStaticMarkup` does not render portals: an open dialog server-renders as Headless'
 * placeholder span, exactly like the RepoPickerDialog and the MobileNavDialog. The in-dialog
 * contracts (focus trap, Escape, input retention across a failed save, focus restoration) are a
 * real browser's to assert, and e2e/workspace.spec.ts owns them. What a static render CAN pin is
 * the boundary — the component server-renders whatever its `open` — and the copy it will carry,
 * exported as the constants the component renders and the e2e spec asserts by role and name.
 */

const render = (open: boolean) =>
    renderToStaticMarkup(
        <ExecutorDialog
            open={open}
            existing={[]}
            editing={null}
            onClose={() => {}}
            onSave={async () => null}
            saving={false}
        />
    );

describe('ExecutorDialog', () => {
    it('server-renders a placeholder until the client mounts, open or closed', () => {
        for (const open of [false, true]) {
            expect(render(open)).toContain('<span hidden');
        }
    });

    it('pins the action copy and the type note the mounted dialog is asserted against in e2e', () => {
        // The dialog content is portal markup no offline render can see; these constants are the
        // contract the component renders and e2e/workspace.spec.ts asserts by role and name.
        expect(ADD_LABEL).toBe('Add executor');
        expect(SAVE_LABEL).toBe('Save executor');
        expect(TYPE_CONFIG_NOTE).toMatch(/does not change the deployment's runner CLI/);
    });
});
