import { describe, expect, it } from 'vitest';
import { beforeUnloadGuard, leaveReason, withGuard, withoutGuard } from '../src/unsaved.js';

describe('unsaved guards', () => {
    it('registers a guard and reports its reason as the leave reason', () => {
        const guards = withGuard(new Map(), {
            id: 'workspace.repos',
            reason: 'Selection changed — save to update your workspace',
        });
        expect(leaveReason(guards, 'workspace.repos')).toBe('Selection changed — save to update your workspace');
    });

    it('re-registering an unchanged guard is no state change at all', () => {
        // Effects keep a guard in step with a draft and re-run on unrelated renders; a fresh map
        // per re-registration would feed the render loop that re-ran them.
        const guards = withGuard(new Map(), { id: 'workspace.repos', reason: 'Selection changed' });
        expect(withGuard(guards, { id: 'workspace.repos', reason: 'Selection changed' })).toBe(guards);
    });

    it('reports no reason where no guard stands', () => {
        expect(leaveReason(new Map(), 'workspace.repos')).toBeNull();
    });

    it('replaces a guard set twice for the same id — one draft, one reason', () => {
        const first = withGuard(new Map(), { id: 'repo-env:acme/web', reason: 'stale reason' });
        const second = withGuard(first, {
            id: 'repo-env:acme/web',
            reason: 'Repository environment has unsaved changes.',
        });
        expect(leaveReason(second, 'repo-env:acme/web')).toBe('Repository environment has unsaved changes.');
    });

    it('clears one guard by id and leaves the others intact', () => {
        const guards = withGuard(withGuard(new Map(), { id: 'workspace.repos', reason: 'selection' }), {
            id: 'repo-env:acme/web',
            reason: 'detail',
        });
        const cleared = withoutGuard(guards, 'workspace.repos');
        expect(leaveReason(cleared, 'workspace.repos')).toBeNull();
        expect(leaveReason(cleared, 'repo-env:acme/web')).toBe('detail');
    });

    it('clearing an id that holds no guard changes nothing', () => {
        expect(withoutGuard(new Map(), 'workspace.repos').size).toBe(0);
    });

    it('arms the browser-leave event: preventDefault plus an empty returnValue', () => {
        // The two parts Chrome and Firefox both demand: without preventDefault the dialog is
        // skipped, and Chrome only shows its own copy when returnValue is the empty string.
        let prevented = false;
        const event = {
            preventDefault: () => {
                prevented = true;
            },
            returnValue: 'dirty',
        };
        beforeUnloadGuard(event);
        expect(prevented).toBe(true);
        expect(event.returnValue).toBe('');
    });
});
