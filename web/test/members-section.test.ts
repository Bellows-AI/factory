import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The members section's wiring contracts (issue 410). The handlers run inside callbacks and
 * effects a static render never fires, so this is the file's source inspection — the
 * `org-executors-section.test.ts` idiom: some contracts are about the file, not the render.
 */

const section = readFileSync(fileURLToPath(new URL('../src/panels/MembersSection.tsx', import.meta.url)), 'utf8');

const page = readFileSync(fileURLToPath(new URL('../src/pages/SettingsOrganizationPage.tsx', import.meta.url)), 'utf8');

describe('MembersSection audience split', () => {
    it('derives the admin gate once, from the session the page hands it', () => {
        expect(section).toMatch(/const isAdmin = session\?\.mode === 'github' && session\.role === ADMIN_ROLE;/);
    });

    it('fetches only for an admin session — the roster read is admin-gated server-side', () => {
        const effect = section.slice(section.indexOf('useEffect'), section.indexOf('/** The row'));
        expect(effect).toMatch(/if \(!isAdmin\) return;/);
        expect(effect).toMatch(/void refresh\(\);/);
        // Everything the section reads goes through listMembers, and listMembers is called from
        // exactly one place — refresh. A member's browser never reaches it.
        expect(section.match(/listMembers\(\)/g)?.length).toBe(1);
    });

    it('renders nothing for no session or non-github mode — the tokens-section precedent', () => {
        expect(section).toMatch(/session === null \|\| session\.mode !== 'github'/);
    });

    it('gives a member the muted sentence instead of a table it could not have fetched', () => {
        expect(section).toContain('Member roles are managed by your organization');
    });
});

describe('MembersSection refresh wiring', () => {
    it('refetches after a successful role write and reports failures unrefreshed', () => {
        const write = section.slice(section.indexOf('const changeRole'), section.indexOf('if (session === null'));
        expect(write).toMatch(/if \(message\) \{\s*setError\(message\);\s*return;\s*\}\s*await refresh\(\);/);
    });

    it('freezes the controls while a write is in flight', () => {
        expect(section).toMatch(/setSaving\(true\)/);
        expect(section).toMatch(/setSaving\(false\)/);
    });
});

describe('the organization page composition', () => {
    it('composes the section instead of owning its state — the OrgExecutorsSection split', () => {
        expect(page).toContain('<MembersSection');
        expect(page).not.toContain('listMembers');
        expect(page).not.toContain('setMemberRole');
        // The page keeps its no-client-gate contract (settings-pages.render.test.tsx).
        expect(page).not.toContain('isAdmin');
    });
});
