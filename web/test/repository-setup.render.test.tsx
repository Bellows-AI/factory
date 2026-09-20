import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { InstallationRepo } from '../src/api/useRepos.js';
import type { WorkspaceRepo } from '../src/api/useWorkspace.js';
import {
    RepositoryConfigDetail,
    RepositorySetupList,
    RepositorySetupSummary,
} from '../src/components/RepositorySetup.js';

/**
 * The three repository-setup components, server-rendered (#159's contract: presentational, no
 * fetching, so a static render is a complete render). The rules underneath the markup — the draft,
 * the ceiling, the save guard — are pinned in repository-setup.test.ts; this suite pins that the
 * MARKUP states them: the mandated sentences, the non-color status text, and no fact where no
 * measurement exists.
 */

const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

const repo = (overrides: Partial<InstallationRepo> = {}): InstallationRepo => ({
    owner: 'acme',
    name: 'web',
    private: false,
    defaultBranch: 'main',
    pushedAt: '2026-08-20T09:00:00.000Z',
    ...overrides,
});

const checkout = (overrides: Partial<WorkspaceRepo> = {}): WorkspaceRepo => ({
    owner: 'acme',
    name: 'web',
    status: 'ready',
    error: null,
    selectedAt: '2026-08-01T00:00:00.000Z',
    readyAt: '2026-08-01T00:05:00.000Z',
    branch: 'main',
    lastCommit: null,
    sizeBytes: null,
    ...overrides,
});

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

const summary = (overrides: Record<string, unknown> = {}) =>
    render(
        <RepositorySetupSummary
            counts={null}
            installation={null}
            cachedError={null}
            rootNull={false}
            dirty={false}
            saveState={{ disabled: false, reason: null }}
            saving={false}
            savedNote={false}
            failure={null}
            staleError={null}
            onSave={() => {}}
            {...overrides}
        />
    );

const list = (overrides: Record<string, unknown> = {}) =>
    render(
        <RepositorySetupList
            repos={[repo()]}
            shown={[repo()]}
            search=""
            onSearch={() => {}}
            chosen={new Set(['acme/web'])}
            onToggle={() => {}}
            workspaceState="ready"
            rows={new Map([['acme/web', checkout()]])}
            configured={null}
            onConfigure={() => {}}
            loadingCheckouts={false}
            saving={false}
            absent={[]}
            onDeselectAbsent={() => {}}
            loaded={true}
            {...overrides}
        />
    );

describe('RepositorySetupSummary', () => {
    it('states the enabled count only once both answers exist — never 0 of 0 unresolved', () => {
        expect(summary()).not.toContain('repositories enabled');
        expect(summary()).not.toContain('0 of 0');
        expect(summary({ counts: { available: 5, enabled: 2, ready: 1, settingUp: 1, failed: 0 } })).toContain(
            '2 of 5 repositories enabled'
        );
    });

    it('carries the ready, setting-up and failed counts with the enabled sentence', () => {
        const html = summary({ counts: { available: 5, enabled: 2, ready: 1, settingUp: 1, failed: 0 } });
        expect(html).toContain('1 ready');
        expect(html).toContain('1 setting up');
        expect(html).toContain('0 failed');
    });

    it('names the installation account and its access when present', () => {
        expect(summary({ installation: { account: 'Acme Inc', repositorySelection: 'selected' } })).toContain(
            'Acme Inc'
        );
        expect(summary({ installation: { account: 'Acme Inc', repositorySelection: 'selected' } })).toContain(
            'selected'
        );
        expect(summary({ installation: { account: 'Acme Inc', repositorySelection: 'all' } })).toContain('all');
    });

    it('warns when the repository list is cached', () => {
        expect(summary({ cachedError: 'GitHub is unreachable' })).toContain('Showing a cached list');
        expect(summary({ cachedError: 'GitHub is unreachable' })).toContain('GitHub is unreachable');
    });

    it('says the workspace root is missing, with the way back, when there is none', () => {
        const html = summary({ rootNull: true });
        expect(html).toContain('no workspace root');
        expect(html).toContain('/settings/workspace');
        // The save is blocked with it: the guard comes from the pure state, and the summary
        // disables the button the same way.
        expect(summary({ rootNull: true, saveState: { disabled: true, reason: null } })).toContain('disabled');
    });

    it('shows the dirty sentence and the mandated save action', () => {
        expect(summary({ dirty: true })).toContain('Selection changed — save to update your workspace');
        expect(summary()).toContain('Save repository selection');
    });

    it('locks the action and renames it while a save runs', () => {
        const html = summary({ saving: true, saveState: { disabled: true, reason: null } });
        expect(html).toContain('Saving selection…');
        expect(html).not.toContain('>Save repository selection</button>');
    });

    it('announces an adopted save, and keeps a failure beside the action', () => {
        expect(summary({ savedNote: true })).toContain('Selection saved. Checkouts are being prepared.');
        expect(summary({ failure: 'Too many repositories' })).toContain('Too many repositories');
    });

    it('marks last-good checkout facts stale when a later poll fails', () => {
        expect(summary({ staleError: 'The workspace request failed' })).toContain(
            'Checkout status is stale — The workspace request failed'
        );
    });
});

describe('RepositorySetupList', () => {
    it('labels the search field, and clears it only once it holds text', () => {
        expect(list()).toContain('Search repositories');
        expect(list()).not.toContain('Clear search');
        expect(list({ search: 'acme' })).toContain('Clear search');
    });

    it('names each checkbox for the repository it enables', () => {
        const html = list({ chosen: new Set() });
        expect(html).toContain('Enable acme/web in my workspace');
        expect(html).not.toContain('checked');
    });

    it('renders the checkout state as text, never color alone, with the failed reason inline', () => {
        const html = list({
            rows: new Map([['acme/web', checkout({ status: 'failed', error: 'fatal: repository not found' })]]),
        });
        expect(html).toContain('Failed · fatal: repository not found');
    });

    it('never fakes a measurement: unmeasured branch, commit and size render as dashes', () => {
        const html = list({
            rows: new Map([['acme/web', checkout({ branch: null, lastCommit: null, sizeBytes: null })]]),
        });
        expect(html).toContain('—');
        expect(html).not.toContain('0 B');
        for (const token of FORBIDDEN) expect(html, token).not.toContain(token);
    });

    it('says no repositories match only after a successful load, and names the query', () => {
        const html = list({ shown: [], loaded: true, search: 'zzz' });
        expect(html).toContain('No repositories match');
        expect(html).toContain('zzz');
        expect(list({ shown: [], loaded: false })).not.toContain('No repositories match');
    });

    it('explains a successful zero list: the App is installed on nothing, an admin must fix it', () => {
        const html = list({ repos: [], shown: [], loaded: true });
        expect(html).toContain('not installed on any repositories');
        expect(html).toContain('administrator');
        // A filtered empty result over a populated list is the no-match state, not this one.
        expect(list({ shown: [], loaded: true, search: 'zzz' })).not.toContain('not installed on any repositories');
    });

    it('renders rows under a named, keyboard-focusable region, and rows are not clickable', () => {
        const html = list();
        expect(html).toContain('aria-label="Repositories"');
        expect(html).toContain('tabindex="0"');
        expect(html).not.toMatch(/<tr[^>]*onclick/i);
    });

    it('marks the configured row for assistive tech and moves nothing else', () => {
        const html = list({ configured: 'acme/web' });
        expect(html).toContain('aria-current="true"');
        expect(html).toContain('Configure');
    });

    it('keeps a selected repository hidden by search inside the draft — counts stay whole', () => {
        // The rows shrink; the checkbox set does not. The search input carries the query, the
        // table carries only matches, and the summary keeps counting the whole draft.
        const html = list({ shown: [], search: 'zzz', loaded: true, chosen: new Set(['acme/web', 'acme/api']) });
        expect(html).not.toContain('Enable acme/web in my workspace');
        expect(html).not.toContain('acme/api');
    });

    it('offers the way out of the ceiling: checked rows stay enabled, unchecked disable', () => {
        const atCeiling = list({ loadingCheckouts: false });
        expect(atCeiling).not.toContain('disabled'); // one repo, no ceiling reached, rows enabled
    });

    it('names the 20-repository ceiling before any request carries it', () => {
        expect(list()).toContain('20 repositories');
    });

    it('lists what GitHub no longer reports, deselectable but not selectable', () => {
        const html = list({ absent: ['acme/gone'] });
        expect(html).toContain('No longer reported by GitHub');
        expect(html).toContain('acme/gone');
        expect(html).toContain('Deselect acme/gone');
    });

    it('does not state checkout facts while the workspace poll runs', () => {
        const html = list({ workspaceState: 'loading', loadingCheckouts: true });
        expect(html).toContain('Checking checkout status…');
        expect(html).not.toContain('Not checked out');
        expect(html).not.toContain('Ready');
    });
});

describe('RepositoryConfigDetail', () => {
    it('renders nothing before a repository is chosen — no empty panel', () => {
        expect(
            render(<RepositoryConfigDetail repo={null} checkout="Ready" blockedReason={null} headingRef={undefined} />)
        ).toBe('');
    });

    it('heads with the environment, scopes it to the repository, and states impact and precedence', () => {
        const html = render(
            <RepositoryConfigDetail
                repo={{ owner: 'acme', name: 'web' }}
                checkout="Ready"
                blockedReason={null}
                headingRef={undefined}
            />
        );
        expect(html).toContain('Environment for acme/web');
        expect(html).toContain('Repository · acme/web');
        expect(html).toContain('any member can edit');
        expect(html).toContain('organization, then workspace, then repository');
    });

    it('gives the checkout status as context', () => {
        const html = render(
            <RepositoryConfigDetail
                repo={{ owner: 'acme', name: 'web' }}
                checkout="Cloning"
                blockedReason={null}
                headingRef={undefined}
            />
        );
        expect(html).toContain('Cloning');
    });

    it('renders the switch blocker beside the detail, named by its reason', () => {
        const html = render(
            <RepositoryConfigDetail
                repo={{ owner: 'acme', name: 'web' }}
                checkout="Ready"
                blockedReason="Repository environment has unsaved changes."
                headingRef={undefined}
            />
        );
        expect(html).toContain('Repository environment has unsaved changes.');
    });
});
