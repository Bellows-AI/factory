import { describe, expect, it } from 'vitest';
import type { ReposPayload } from '../src/api/useRepos.js';
import { nextChosen, saveDisabled } from '../src/components/RepoPickerDialog.js';

const loaded: ReposPayload = {
    repos: [],
    installation: null,
    meta: { fetchedAt: '2026-01-01T00:00:00.000Z', error: null },
};

describe('nextChosen', () => {
    it('takes the picked keys as the new selection', () => {
        // Headless reports the full array after a click; whatever it decided is the selection.
        expect(nextChosen(new Set(['a/one']), ['a/one', 'a/two'], ['a/one', 'a/two'])).toEqual(
            new Set(['a/one', 'a/two'])
        );
    });

    it('keeps a chosen key the rendered list no longer represents', () => {
        // The contract the save payload leans on: `chosen` is the source of truth and the list is
        // only how keys were chosen — so a repository the filter hid, or that the installation
        // stopped reporting, survives a toggle of a different row instead of vanishing from the
        // next PUT.
        expect(nextChosen(new Set(['a/hidden', 'a/one']), ['a/one'], ['a/one'])).toEqual(
            new Set(['a/hidden', 'a/one'])
        );
    });

    it('drops a rendered key when it is toggled off', () => {
        expect(nextChosen(new Set(['a/one', 'a/two']), ['a/one'], ['a/one', 'a/two'])).toEqual(new Set(['a/one']));
    });

    it('stays empty when nothing is picked and nothing was held', () => {
        expect(nextChosen(new Set(), [], ['a/one'])).toEqual(new Set());
    });
});

describe('saveDisabled', () => {
    /*
     * The body of the PUT is the WHOLE selection, so saving against a list that has not arrived
     * is how somebody loses every checkout they had — historically worse than a missing guard,
     * because `save()` once built its payload by FILTERING the installation list, and an empty
     * list produced an empty payload: one click deselected everything. The button lives inside
     * the Dialog's portal, out of the offline render suite's reach, so the guard is pinned here.
     */
    it('blocks while the list has not loaded, or a save is already running', () => {
        expect(saveDisabled(false, true, null)).toBe(true);
        expect(saveDisabled(false, false, null)).toBe(true);
        expect(saveDisabled(true, false, loaded)).toBe(true);
    });

    it('allows a save only once the payload arrived and no save is running', () => {
        expect(saveDisabled(false, false, loaded)).toBe(false);
    });
});
