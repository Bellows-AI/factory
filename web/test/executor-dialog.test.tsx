import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ExecutorDialog } from '../src/components/ExecutorDialog.js';
import { JsonEditor } from '../src/components/JsonEditor.js';
import {
    ADD_LABEL,
    AGENT_HELP,
    EXECUTOR_SCOPE,
    GATE_FIX_ROUNDS_HELP,
    INHERITED_NOTE,
    NAME_HELP,
    SAVE_LABEL,
} from '../src/workspace/executors.js';

/**
 * The add/edit executor dialog is a Headless UI Dialog, so it portals — and
 * `renderToStaticMarkup` does not render portals: an open dialog server-renders as Headless'
 * placeholder span, exactly like the RepoPickerDialog and the MobileNavDialog. The in-dialog
 * contracts (guided setup, the Advanced editor, focus trap, Escape and the discard confirmation,
 * input retention across a failed save, focus restoration) are a real browser's to assert, and
 * e2e/workspace.spec.ts owns them. What a static render CAN pin is the boundary — the component
 * server-renders whatever its `open` — the JSON editor, which does not portal, and the copy the
 * dialog carries, exported as the constants it renders and the e2e spec asserts.
 */

const render = (open: boolean) =>
    renderToStaticMarkup(
        <MemoryRouter>
            <ExecutorDialog
                open={open}
                existing={[]}
                editing={null}
                onClose={() => {}}
                onSave={async () => null}
                onSaved={() => {}}
                saving={false}
            />
        </MemoryRouter>
    );

const editor = (value: string, invalid = false) =>
    renderToStaticMarkup(
        <JsonEditor id="cfg" value={value} onChange={() => {}} invalid={invalid} describedBy="cfg-help" />
    );

describe('ExecutorDialog', () => {
    it('server-renders a placeholder until the client mounts, open or closed', () => {
        for (const open of [false, true]) {
            expect(render(open)).toContain('<span hidden');
        }
    });

    it('pins the action copy and the helps the mounted dialog is asserted against in e2e', () => {
        // The dialog content is portal markup no offline render can see; these constants are the
        // contract the component renders and e2e/workspace.spec.ts asserts by role and name.
        expect(ADD_LABEL).toBe('Add executor');
        expect(SAVE_LABEL).toBe('Save changes');
        expect(EXECUTOR_SCOPE).toBe('Your saved agent settings for running tasks.');
        expect(NAME_HELP).toMatch(/task picker/);
        expect(NAME_HELP).toMatch(/Code review/);
        expect(AGENT_HELP).toMatch(/selected agent/);
        // Saving a name and an agent alone inherits the deployment's configuration, and the
        // sentence does not promise that saving verified anything.
        expect(INHERITED_NOTE).toMatch(/inherited from this deployment/);
        expect(INHERITED_NOTE).toMatch(/not your credentials or whether the model is available/);
        // The gate-repair field's help is the same contract: what the number decides, and that
        // zero turns automatic repair off (issue #49).
        expect(GATE_FIX_ROUNDS_HELP).toMatch(/failed gate/);
        expect(GATE_FIX_ROUNDS_HELP).toMatch(/0 turns/i);
    });
});

describe('JsonEditor', () => {
    it('is one labelled textarea carrying the raw text, its description and its invalid state', () => {
        const html = editor('{ "a": 1 }', true);
        expect(html).toMatch(/<textarea[^>]*id="cfg"/);
        expect(html).toMatch(/<textarea[^>]*aria-invalid="true"/);
        expect(html).toMatch(/<textarea[^>]*aria-describedby="cfg-help"/);
        expect(html).toMatch(/<textarea[^>]*spellCheck="false"/);
        expect(html).toContain('>{ &quot;a&quot;: 1 }</textarea>');
        expect(editor('{}')).not.toContain('aria-invalid');
    });

    it('numbers every line in an aria-hidden gutter', () => {
        const html = editor('{\n  "a": 1\n}');
        expect(html).toMatch(
            /class="json-editor-gutter" aria-hidden="true"><span>1<\/span><span>2<\/span><span>3<\/span><\/div>/
        );
    });

    it('paints a highlighted, aria-hidden copy that tells keys from values', () => {
        const html = editor('{"k": "v", "n": 2, "t": true}');
        expect(html).toMatch(/<pre class="json-editor-highlight" aria-hidden="true">/);
        expect(html).toContain('<span class="json-token-key">&quot;k&quot;</span>');
        expect(html).toContain('<span class="json-token-string">&quot;v&quot;</span>');
        expect(html).toContain('<span class="json-token-number">2</span>');
        expect(html).toContain('<span class="json-token-literal">true</span>');
    });
});
