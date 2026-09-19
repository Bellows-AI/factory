import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, inboxFiltersFromSearch, inboxQueryString } from '../src/api/useTasks.js';

/**
 * The inbox's URL is the filter state — linkable, Back/Forward-navigable — so what the URL can
 * put into a poll is a contract: unknown values clamp to the defaults and are never sent, the
 * search is trimmed and capped, and the defaults are omitted from the serialized query so the
 * default inbox's URL stays bare.
 */
describe('inboxFiltersFromSearch', () => {
    it('answers the defaults for an empty or absent query', () => {
        expect(inboxFiltersFromSearch('')).toEqual(DEFAULT_FILTERS);
        expect(inboxFiltersFromSearch('?')).toEqual(DEFAULT_FILTERS);
    });

    it('reads every known parameter', () => {
        expect(inboxFiltersFromSearch('?state=review&q=login&repo=acme/web&author=octocat&sort=oldest')).toEqual({
            state: 'review',
            q: 'login',
            repo: 'acme/web',
            author: 'octocat',
            sort: 'oldest',
        });
    });

    it('clamps an unknown state, sort or repo shape to the default', () => {
        expect(inboxFiltersFromSearch('?state=weird').state).toBe('attention');
        expect(inboxFiltersFromSearch('?sort=soon').sort).toBe('newest');
        expect(inboxFiltersFromSearch('?repo=not-a-repo').repo).toBeNull();
    });

    it('trims the search and caps it at 200 characters', () => {
        expect(inboxFiltersFromSearch('?q=%20%20login%20').q).toBe('login');
        expect(inboxFiltersFromSearch(`?q=${'x'.repeat(300)}`).q).toHaveLength(200);
        expect(inboxFiltersFromSearch('?q=%20%20').q).toBeNull();
    });

    it('clamps a malformed author login to nothing', () => {
        expect(inboxFiltersFromSearch('?author=bad%20name').author).toBeNull();
        expect(inboxFiltersFromSearch('?author=-nope').author).toBeNull();
        expect(inboxFiltersFromSearch('?author=Octo-Cat').author).toBe('Octo-Cat');
    });
});

describe('inboxQueryString', () => {
    it('omits the defaults so the default inbox URL stays bare', () => {
        expect(inboxQueryString(DEFAULT_FILTERS)).toBe('');
    });

    it('serializes exactly the values that differ from the defaults', () => {
        expect(
            inboxQueryString({ state: 'past', q: 'login', repo: 'acme/web', author: 'octocat', sort: 'oldest' })
        ).toBe('state=past&q=login&repo=acme%2Fweb&author=octocat&sort=oldest');
    });

    it('never sends an empty or clamped value', () => {
        expect(inboxQueryString({ ...DEFAULT_FILTERS, q: null, author: null, repo: null })).toBe('');
    });
});
