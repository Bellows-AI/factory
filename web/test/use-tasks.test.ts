import { describe, expect, it } from 'vitest';
import {
    DEFAULT_FILTERS,
    fetchDepthPages,
    firstPageError,
    inboxFiltersFromSearch,
    inboxQueryString,
    MAX_REFRESH_DEPTH,
} from '../src/api/useTasks.js';

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
        const OVER_QUERY_MAX = 300;
        const QUERY_MAX = 200;
        expect(inboxFiltersFromSearch(`?q=${'x'.repeat(OVER_QUERY_MAX)}`).q).toHaveLength(QUERY_MAX);
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

describe('firstPageError', () => {
    // The hook's depth rule, pinned pure because the suite has no DOM: the retained refresh error
    // is the page's inline error ONLY while no first page has landed — with rows on screen it is
    // the beside-the-rows banner, and with no error at all the hook is in the skeletons state.
    it('is the refresh error while nothing has loaded, and never once rows exist', () => {
        expect(firstPageError(null, 'Request failed (503)')).toBe('Request failed (503)');
        expect(firstPageError([], 'Request failed (503)')).toBeNull();
        expect(firstPageError(null, null)).toBeNull();
    });
});

describe('fetchDepthPages', () => {
    // The poll's refresh must rebuild the depth the member paged to, or every 3s tick would
    // collapse the loaded rows back to page one. The fetch is injected, so the whole chain runs
    // offline: page one, then each next page via its cursor, deduped by id, stopping when the
    // list runs out.
    const summary = (id: string) => ({
        id,
        command: `task ${id}`,
        status: 'running',
        cancelRequestedAt: null,
        doneAt: null,
        repo: null,
        executor: null,
        author: null,
        activity: null,
        summary: null,
        createdAt: '2026-09-02T12:00:00.000Z',
        activityAt: '2026-09-02T12:10:00.000Z',
    });
    const navigation = { counts: { running: 1, review: 0, past: 0 }, running: [], review: [] };
    const page = (items: string[], cursor: string | null) => ({
        navigation,
        page: { items: items.map(summary), nextCursor: cursor },
    });

    it('walks successive cursors until the depth is rebuilt, deduping by id', async () => {
        const seen: string[] = [];
        const fetchPage = async (url: string) => {
            seen.push(url);
            if (!url.includes('cursor=')) return page(['a', 'b'], 'c1');
            if (url.includes('c1')) return page(['b', 'c'], 'c2');
            return page(['d'], null);
        };
        const REQUESTED_DEPTH = 3;
        const rebuilt = await fetchDepthPages(fetchPage, 'state=past', REQUESTED_DEPTH);
        expect(seen).toHaveLength(REQUESTED_DEPTH);
        expect(seen[1]).toContain('cursor=c1');
        expect(seen[2]).toContain('cursor=c2');
        // 'b' moved between pages between reads — first occurrence wins.
        expect(rebuilt.items.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
        expect(rebuilt.nextCursor).toBeNull();
        expect(rebuilt.pages).toBe(REQUESTED_DEPTH);
        expect(rebuilt.navigation).toBe(navigation);
    });

    it('stops early when the list shrank below the loaded depth', async () => {
        const fetchPage = async (url: string) => (url.includes('cursor=') ? page([], null) : page(['a'], 'c1'));
        const REQUESTED_DEPTH = 5;
        const rebuilt = await fetchDepthPages(fetchPage, '', REQUESTED_DEPTH);
        expect(rebuilt.items.map((t) => t.id)).toEqual(['a']);
        expect(rebuilt.nextCursor).toBeNull();
        expect(rebuilt.pages).toBe(2);
    });

    it('reads at most MAX_REFRESH_DEPTH pages however deep the member paged', async () => {
        // The tick is 3s while anything runs and the chain is serial, so an uncapped depth is a
        // request-count problem: past the cap the deeper pages go stale rather than re-read.
        const calls: string[] = [];
        const fetchPage = async (url: string) => {
            calls.push(url);
            return page([`p${calls.length}`], `c${calls.length}`);
        };
        const rebuilt = await fetchDepthPages(fetchPage, '', 12);
        expect(calls).toHaveLength(MAX_REFRESH_DEPTH);
        expect(rebuilt.pages).toBe(MAX_REFRESH_DEPTH);
        // The cursor of the LAST page read, so Load more resumes from the capped depth.
        expect(rebuilt.nextCursor).toBe(`c${MAX_REFRESH_DEPTH}`);
    });

    it('reads exactly one page when the depth is one', async () => {
        const calls: string[] = [];
        const fetchPage = async (url: string) => {
            calls.push(url);
            return page(['a', 'b'], 'c1');
        };
        const rebuilt = await fetchDepthPages(fetchPage, 'state=running', 1);
        expect(calls).toHaveLength(1);
        expect(rebuilt.nextCursor).toBe('c1');
    });
});
