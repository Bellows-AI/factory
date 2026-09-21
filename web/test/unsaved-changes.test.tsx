import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
    beforeUnloadWarning,
    subscribeBeforeUnload,
    unsavedDialogBody,
    unsavedDialogTitle,
    UnsavedChangesDialog,
} from '../src/components/UnsavedChangesDialog.js';

/**
 * The unsaved-change guard, pinned where a DOM-less suite CAN pin it: the dialog's copy, the
 * beforeunload handler and its subscription lifetime, and the dialog's static markup. The
 * interaction contract — focus trapping, Escape and the backdrop taking the safe answer, focus
 * restore to the initiating control, and the blocker actually holding a navigation — belongs to
 * Headless UI and React Router, and is exercised end to end by `e2e/env.spec.ts`; nothing here
 * can execute a navigation, because effects never fire under `renderToStaticMarkup`.
 */
describe('the discard dialog copy', () => {
    it('names the one question the dialog asks', () => {
        expect(unsavedDialogTitle()).toBe('Discard unsaved changes?');
    });

    it('carries the scope label in the body, joined when more than one draft is dirty', () => {
        expect(unsavedDialogBody(['Core (organization)'])).toBe(
            'Your changes to Core (organization) have not been saved.'
        );
        expect(unsavedDialogBody(['Core (organization)', 'octo/hooks'])).toBe(
            'Your changes to Core (organization) and octo/hooks have not been saved.'
        );
    });
});

describe('the beforeunload guard', () => {
    it('cancels the unload the way the browsers require', () => {
        const event = { preventDefault: vi.fn(), returnValue: 'original' };
        beforeUnloadWarning(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(event.returnValue).toBe('');
    });

    it('registers exactly one listener, and the unsubscribe removes it', () => {
        // A fake target instead of stubGlobal: the subscription's contract is with whatever object
        // the caller hands it — the layout hands it `window`.
        const target = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        };
        const handler = beforeUnloadWarning;
        const off = subscribeBeforeUnload(target, handler);
        expect(target.addEventListener).toHaveBeenCalledWith('beforeunload', handler);
        expect(target.removeEventListener).not.toHaveBeenCalled();
        off();
        expect(target.removeEventListener).toHaveBeenCalledWith('beforeunload', handler);
    });
});

describe('the discard dialog markup', () => {
    it('renders the library placeholder whether open or closed — the panel is client-only', () => {
        // An open Headless dialog SSRs its own hidden placeholder and nothing else (the
        // TaskRemoveDialog precedent): the panel mounts for a browser. The copy is pinned pure
        // above; focus trapping, Escape, the backdrop and Discard-resumes-navigation are e2e's.
        const open = renderToStaticMarkup(
            <UnsavedChangesDialog labels={['My workspace']} onClose={() => {}} onConfirm={() => {}} />
        );
        expect(open).toContain('<span hidden');
    });
});
