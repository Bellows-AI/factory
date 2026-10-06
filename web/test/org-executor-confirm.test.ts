import { describe, expect, it, vi } from 'vitest';
import {
    confirmBody,
    confirmBusyLabel,
    confirmLabel,
    confirmTitle,
    confirmedWrite,
} from '../src/panels/org-executor-confirm.js';

/**
 * The org row's two ownership-changing actions (issue 411) are irreversible for everyone else in
 * the organization, so neither may fire from a row click. This file holds the confirmation's whole
 * decidable surface — the copy that must name the row, and the single dispatch that is the only
 * call site of the two writes — with no DOM, the way `env-draft.test.ts` holds its draft rules.
 */

/** The same contract the panel render suite pins. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

describe('the org executor confirmation copy', () => {
    it('names the profile in the delete title and states that it is removed for every member and cannot be undone', () => {
        const confirm = { action: 'delete', name: 'Main ORG' } as const;
        expect(confirmTitle(confirm)).toContain('Main ORG');
        expect(confirmBody(confirm)).toContain('Main ORG');
        expect(confirmBody(confirm)).toMatch(/every member/);
        expect(confirmBody(confirm)).toMatch(/cannot be undone/);
        expect(confirmLabel(confirm)).toBe('Delete profile');
        expect(confirmBusyLabel(confirm)).toBe('Deleting…');
    });

    it('names the profile in the demote title and states that it moves into your personal executors', () => {
        const confirm = { action: 'demote', name: 'team-runner' } as const;
        expect(confirmTitle(confirm)).toContain('team-runner');
        expect(confirmBody(confirm)).toContain('team-runner');
        expect(confirmBody(confirm)).toMatch(/personal executors/);
        expect(confirmBody(confirm)).toMatch(/stops being available/);
        expect(confirmLabel(confirm)).toBe('Make personal');
        expect(confirmBusyLabel(confirm)).toBe('Moving…');
    });

    it('names the personal profile, its scope and the permanent loss in the remove copy (issue 440)', () => {
        const confirm = { action: 'remove', name: 'my-runner' } as const;
        expect(confirmTitle(confirm)).toContain('my-runner');
        expect(confirmBody(confirm)).toContain('my-runner');
        expect(confirmBody(confirm)).toMatch(/personal executor/);
        expect(confirmBody(confirm)).toMatch(/permanently deleted/);
        expect(confirmBody(confirm)).toMatch(/cannot be undone/);
        expect(confirmBody(confirm)).not.toMatch(/every member/);
        expect(confirmLabel(confirm)).toBe('Remove profile');
        expect(confirmBusyLabel(confirm)).toBe('Removing…');
    });

    it('says the org delete is organization-scoped, affects every member and is permanent', () => {
        const body = confirmBody({ action: 'delete', name: 'team' });
        expect(body).toMatch(/organization executor/);
        expect(body).toMatch(/every member/);
        expect(body).toMatch(/permanently deleted/);
    });

    it('carries no placeholder text in any action’s copy', () => {
        for (const action of ['delete', 'demote', 'remove'] as const) {
            const confirm = { action, name: 'team-runner' };
            for (const copy of [
                confirmTitle(confirm),
                confirmBody(confirm),
                confirmLabel(confirm),
                confirmBusyLabel(confirm),
            ]) {
                for (const token of FORBIDDEN) expect(copy, token).not.toContain(token);
            }
        }
    });
});

describe('the confirmed write', () => {
    const api = () => ({
        remove: vi.fn(async () => null),
        demote: vi.fn(async () => null),
    });

    it('confirming a delete calls the delete route and nothing else', async () => {
        const routes = api();
        expect(await confirmedWrite('delete', { id: 'row-1' }, routes)).toBe(null);
        expect(routes.remove).toHaveBeenCalledTimes(1);
        expect(routes.remove).toHaveBeenCalledWith('row-1');
        expect(routes.demote).not.toHaveBeenCalled();
    });

    it('confirming a demote calls the scope route and nothing else', async () => {
        const routes = api();
        expect(await confirmedWrite('demote', { id: 'row-2' }, routes)).toBe(null);
        expect(routes.demote).toHaveBeenCalledTimes(1);
        expect(routes.demote).toHaveBeenCalledWith('row-2');
        expect(routes.remove).not.toHaveBeenCalled();
    });

    it('returns the route’s refusal unchanged, so the caller reports it and refreshes nothing', async () => {
        const routes = { remove: vi.fn(async () => 'Not an admin.'), demote: vi.fn(async () => null) };
        expect(await confirmedWrite('delete', { id: 'row-3' }, routes)).toBe('Not an admin.');
    });
});
