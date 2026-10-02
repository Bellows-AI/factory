import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The org section's refresh contract (PR review 4163357735): `data.orgExecutors` comes from the
 * workspace poll, and that poll stops once it returns a settled answer — so a successful org
 * write must re-arm it (`workspace.refresh`) or a deleted or demoted row stays in the table and a
 * new one never appears until the page reloads. The writes run inside callbacks a static render
 * never fires, so this is the file's source inspection, the `window.confirm` idiom: some
 * contracts are about the file, not the render. A refused write reports through `onError` and
 * must leave the poll alone.
 */

const section = readFileSync(fileURLToPath(new URL('../src/panels/OrgExecutorsSection.tsx', import.meta.url)), 'utf8');

const page = readFileSync(fileURLToPath(new URL('../src/pages/SettingsExecutorsPage.tsx', import.meta.url)), 'utf8');

describe('OrgExecutorsSection refresh wiring', () => {
    it('takes the poll re-arm as a prop', () => {
        expect(section).toMatch(/onRefresh: \(\) => void/);
    });

    it('refreshes after a successful dialog save — create or update — and not after a refusal', () => {
        const save = section.slice(section.indexOf('const save ='), section.indexOf('const withRow'));
        expect(save).toMatch(/if \(!message\) onRefresh\(\);/);
        expect(save).toMatch(/return message;/);
    });

    it('refreshes after a successful row action — delete or demote — and reports failures unrefreshed', () => {
        const withRow = section.slice(section.indexOf('const withRow'), section.indexOf('return ('));
        expect(withRow).toMatch(/if \(message\) \{\s*onError\(message\);\s*return;\s*\}\s*onRefresh\(\);/);
    });

    it('is handed the page poll’s refresh', () => {
        expect(page).toMatch(/onRefresh=\{refresh\}/);
    });
});

/**
 * The confirmation gate (issue 411). Delete and Make personal are org-wide and irreversible, so a
 * row click may only open the confirmation — the writes themselves belong to the dialog's confirm.
 * Source inspection for the same reason as above: the handlers run inside callbacks a static
 * render never fires.
 */
describe('OrgExecutorsSection confirmation gate', () => {
    it('never writes straight from a row click', () => {
        const panel = section.slice(
            section.indexOf('<OrgExecutorsPanel'),
            section.indexOf('<OrgExecutorConfirmDialog')
        );
        expect(panel).not.toContain('deleteOrgExecutor');
        expect(panel).not.toContain('changeOrgExecutorScope');
        expect(panel).toContain('setConfirm(');
    });

    it('performs each write exactly once, from the confirmed dispatch', () => {
        expect(section.match(/deleteOrgExecutor/g)?.length).toBe(2); // the import, then the dispatch
        expect(section.match(/changeOrgExecutorScope/g)?.length).toBe(2);
        expect(section).toContain('confirmedWrite(');
    });

    it('cancelling clears the pending confirmation, leaving the row untouched', () => {
        expect(section).toMatch(/onClose=\{\(\) => setConfirm\(null\)\}/);
    });
});
