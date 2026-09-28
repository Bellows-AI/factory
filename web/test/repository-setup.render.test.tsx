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
import { MAX_SELECTED_REPOS, NOT_AVAILABLE } from '../src/components/repository-setup.js';
import { bytes, commitDate } from '../src/format.js';

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
            listNotice={null}
            rootNull={false}
            staleError={null}
            listLoaded={true}
            workspaceState="ready"
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
            rootNull={false}
            saving={false}
            absent={[]}
            onDeselectAbsent={() => {}}
            loaded={true}
            dirty={false}
            saveState={{ disabled: false, reason: null }}
            savedNote={false}
            failure={null}
            onSave={() => {}}
            {...overrides}
        />
    );

describe('RepositorySetupSummary', () => {
    const COUNTS = { available: 5, enabled: 2, ready: 1, settingUp: 1, failed: 0 };

    it('shows four cards from counts(): Selected of 20 allowed, Ready, Setting up, Failed', () => {
        const html = summary({ counts: COUNTS });
        expect(html).toContain('aria-label="Selection summary"');
        const at = ['Selected', 'Ready', 'Setting up', 'Failed'].map((label) =>
            html.indexOf(`class="repo-card-label">${label}<`)
        );
        for (const index of at) expect(index).toBeGreaterThanOrEqual(0);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
        expect(html).toMatch(/Selected<\/p><p class="repo-card-value">2</);
        expect(html).toMatch(/Ready<\/p><p class="repo-card-value">1</);
        expect(html).toMatch(/Setting up<\/p><p class="repo-card-value">1</);
        expect(html).toMatch(/Failed<\/p><p class="repo-card-value">0</);
        expect(html).toContain(`<p class="repo-card-caption">of ${MAX_SELECTED_REPOS} allowed</p>`);
        expect(html).toContain('<p class="repo-card-caption">5 available</p>');
    });

    it('shows a dash named Loading on every card, never 0, while counts are unresolved', () => {
        const html = summary({ workspaceState: 'loading' });
        expect(html.match(/aria-label="Loading"/g)).toHaveLength(4);
        expect(html).not.toMatch(/repo-card-value">0</);
        expect(html).not.toContain('0 of 0');
    });

    it('names the dash Not available after a failed first poll', () => {
        const html = summary({ workspaceState: 'error' });
        expect(html.match(new RegExp(`aria-label="${NOT_AVAILABLE}"`, 'g'))).toHaveLength(4);
        expect(html).not.toContain('aria-label="Loading"');
    });

    it('omits the available figure until the installation list answers', () => {
        const html = summary({ counts: COUNTS, listLoaded: false });
        expect(html).toContain(`of ${MAX_SELECTED_REPOS} allowed`);
        expect(html).not.toContain('5 available');
    });

    it('tones the card discs: accent, ok, warn, bad', () => {
        const html = summary({ counts: COUNTS });
        for (const tone of ['accent', 'ok', 'warn', 'bad']) expect(html).toContain(`repo-card-disc-${tone}`);
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

    it('warns in a banner that an operator must set ORG_WORKSPACE_ROOT, links to Workspace, offers no button', () => {
        const html = summary({ rootNull: true });
        expect(html).toContain('class="banner-warn"');
        expect(html).toContain('Workspace root not configured');
        expect(html).toContain('An operator must set <code>ORG_WORKSPACE_ROOT</code> on the deployment');
        expect(html).toMatch(/href="\/settings\/workspace"[^>]*>Learn about workspaces</);
        expect(html).not.toContain('<button');
        expect(html).not.toContain('Configure workspace root');
        expect(summary()).not.toContain('banner-warn');
    });

    it('marks last-good checkout facts stale when a later poll fails', () => {
        expect(summary({ staleError: 'The workspace request failed' })).toContain(
            'Checkout status is stale — The workspace request failed'
        );
    });
    it('states the installation list is loading, and names a hard failure, rather than an empty list', () => {
        // Both postures exist only while no rows are in hand — a cached list renders rows instead.
        expect(summary({ listNotice: 'Loading repositories…' })).toContain('Loading repositories…');
        const failed = summary({ listNotice: 'Could not reach GitHub: upstream unavailable' });
        expect(failed).toContain('Could not reach GitHub: upstream unavailable');
        expect(summary({ listNotice: null })).not.toContain('Could not reach GitHub');
    });

    it('carries no save action — the save lives in the selection bar', () => {
        expect(summary()).not.toContain('<button');
        expect(summary()).not.toContain('Save selection');
    });

    it('names the installation after the cards', () => {
        const html = summary({
            counts: COUNTS,
            installation: { account: 'Acme Inc', repositorySelection: 'selected' },
        });
        expect(html.indexOf('Installation: Acme Inc')).toBeGreaterThan(html.indexOf('repo-cards'));
    });
});

describe('RepositorySetupList', () => {
    it('orders the search, the selection bar with its save, then the full-width table', () => {
        const html = list();
        const searchAt = html.indexOf('id="repo-setup-search"');
        const barAt = html.indexOf('class="repo-toolbar"');
        const saveAt = html.indexOf('>Save selection</button>');
        const tableAt = html.indexOf('aria-label="Repositories"');
        expect(searchAt).toBeGreaterThanOrEqual(0);
        expect(barAt).toBeGreaterThan(searchAt);
        expect(saveAt).toBeGreaterThan(barAt);
        expect(tableAt).toBeGreaterThan(saveAt);
        expect(html).not.toContain('panel-actions');
    });

    it('makes the save prominent only while a dirty selection can save', () => {
        expect(list({ dirty: true })).toMatch(/class="primary repo-save"[^>]*>Save selection/);
        expect(list()).not.toContain('class="primary');
        expect(list({ savedNote: true })).not.toContain('class="primary');
        expect(list({ dirty: true, saving: true, saveState: { disabled: true, reason: null } })).not.toContain(
            'class="primary'
        );
        expect(list({ dirty: true, saveState: { disabled: true, reason: 'x' } })).not.toContain('class="primary');
        expect(list({ dirty: true, failure: 'Too many repositories' })).toMatch(
            /class="primary repo-save"[^>]*>Save selection/
        );
    });

    it('locks the action and renames it while a save runs', () => {
        const html = list({ saving: true, saveState: { disabled: true, reason: null } });
        expect(html).toContain('Saving selection…');
        expect(html).not.toContain('>Save selection</button>');
    });

    it('announces an adopted save, and keeps a failure beside the action', () => {
        expect(list({ savedNote: true })).toContain('Selection saved. Checkouts are being prepared.');
        expect(list({ failure: 'Too many repositories' })).toContain('Too many repositories');
    });

    it('shows the dirty sentence', () => {
        expect(list({ dirty: true })).toContain('Selection changed — save to update your workspace');
        expect(list()).toContain('Save selection');
    });

    it('associates the save-blocking reason with the disabled action', () => {
        const html = list({
            saveState: {
                disabled: true,
                reason: 'Remove repositories GitHub no longer reports before saving other selection changes.',
            },
        });
        expect(html).toContain('id="repo-save-reason"');
        expect(html).toMatch(/aria-describedby="repo-save-reason"/);
    });

    it('counts the selection and names the ceiling in the selection bar', () => {
        expect(list()).toMatch(/class="repo-toolbar">[\s\S]*1 selected · Selection limited to 20 repositories\./);
    });

    it('states no selected count while checkouts load, and names the withheld checkbox', () => {
        const html = list({ workspaceState: 'loading', loadingCheckouts: true });
        expect(html).not.toContain(' selected · ');
        expect(html).toContain('Selection limited to 20 repositories.');
        expect(html).toContain('aria-label="Loading"');
    });

    it('marks the configured row, and only that one', () => {
        expect(list({ configured: 'acme/web' })).toContain('class="repo-row-configured"');
        expect(list({ configured: 'acme/other' })).not.toContain('repo-row-configured');
        expect(list()).not.toContain('repo-row-configured');
    });

    it('labels every data cell for the narrow stacked layout, and leaves the action unlabeled', () => {
        const html = list();
        expect(html).toContain('class="data repo-table"');
        for (const label of ['Enabled', 'Repository', 'Checkout status', 'Branch', 'Last commit', 'Size']) {
            expect(html).toContain(`data-label="${label}"`);
        }
        expect(html.match(/data-label=/g)?.length).toBe(6);
    });

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

    it('never fakes a measurement: unmeasured branch, commit and size say Not available', () => {
        const html = list({
            repos: [repo({ defaultBranch: null })],
            shown: [repo({ defaultBranch: null })],
            rows: new Map([['acme/web', checkout({ branch: null, lastCommit: null, sizeBytes: null })]]),
        });
        expect(html.match(/Not available/g)?.length).toBeGreaterThanOrEqual(3);
        expect(html).not.toContain('—');
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
        // An unchecked box is a selection fact too: while nothing is known, the control itself
        // is withheld rather than rendered unchecked.
        expect(html).not.toContain('Enable acme/web in my workspace');
    });

    it('wires the ceiling into the markup: unchecked rows disable, checked rows never', () => {
        // Twenty keys, none of them this row's: the row may not be added, the checked ones may
        // still be removed. The pure ceiling is pinned in repository-setup.test.ts; this pins the
        // wiring that turns it into a disabled control.
        const full = new Set(Array.from({ length: MAX_SELECTED_REPOS }, (_, i) => `other/r${i}`));
        const html = list({ chosen: full });
        expect(html).toMatch(/<input[^>]*aria-label="Enable acme\/web in my workspace"[^>]*disabled/);
        const ROOM_FOR_THIS_ROW = MAX_SELECTED_REPOS - 1;
        const checked = list({ chosen: new Set([...full].slice(0, ROOM_FOR_THIS_ROW).concat('acme/web')) });
        expect(checked).not.toMatch(/aria-label="Enable acme\/web in my workspace"[^>]*disabled/);
    });

    it('locks the absent rows out of a save in flight, like every other control', () => {
        const html = list({ absent: ['acme/gone'], saving: true });
        expect(html).toMatch(/aria-label="Deselect acme\/gone"[^>]*disabled/);
    });

    it('disables every checkbox when no workspace root exists, though the row stays readable', () => {
        const html = list({ rootNull: true });
        expect(html).toMatch(/aria-label="Enable acme\/web in my workspace"[^>]*disabled/);
        // The name and its facts remain — availability is readable; only the checkout offer is off.
        expect(html).toContain('acme/web');
        expect(html).toContain('Ready');
    });
});

describe('RepositoryConfigDetail', () => {
    it('renders nothing before a repository is chosen — no empty panel', () => {
        expect(
            render(<RepositoryConfigDetail repo={null} checkout="Ready" headingRef={undefined} row={undefined} />)
        ).toBe('');
    });

    it('heads with the selected repository and states the shared scope truth (issue 180)', () => {
        const html = render(
            <RepositoryConfigDetail
                repo={{ owner: 'acme', name: 'web' }}
                checkout="Ready"
                headingRef={undefined}
                row={undefined}
            />
        );
        expect(html).toContain('Selected repository: acme/web');
        // The scope copy is ConfigurationScope's — the same table every editor states.
        expect(html).toContain('Repository · acme/web');
        expect(html).toContain('Applies to every task using acme/web in the organization.');
        expect(html).toContain('Any member can edit.');
        expect(html).toContain('organization &lt; workspace &lt; repository');
    });

    it('lists the checkout facts: status, branch, last commit, size', () => {
        const at = '2026-08-19T10:00:00.000Z';
        const row = checkout({ branch: 'trunk', lastCommit: { sha: 'abc1234', at, headline: 'Fix' }, sizeBytes: 2048 });
        const html = render(
            <RepositoryConfigDetail repo={{ owner: 'acme', name: 'web' }} checkout="Cloning" row={row} />
        );
        expect(html).toContain('<h3>Checkout</h3>');
        for (const label of ['Checkout status', 'Branch', 'Last commit', 'Size']) {
            expect(html).toContain(`<dt>${label}</dt>`);
        }
        expect(html).toContain('<dd>Cloning</dd>');
        expect(html).toContain('<dd>trunk</dd>');
        expect(html).toContain(`<dd>${commitDate(at)}</dd>`);
        expect(html).toContain(`<dd>${bytes(2048)}</dd>`);
        expect(html).not.toContain(NOT_AVAILABLE);
    });

    it('says Not available for each fact nothing measured', () => {
        const html = render(
            <RepositoryConfigDetail repo={{ owner: 'acme', name: 'web' }} checkout="Not checked out" row={undefined} />
        );
        expect(html.match(new RegExp(NOT_AVAILABLE, 'g'))).toHaveLength(3);
        expect(html).not.toContain('—');
    });

    it('names the default branch before any checkout, as the table row does', () => {
        const html = render(
            <RepositoryConfigDetail
                repo={{ owner: 'acme', name: 'web' }}
                checkout="Not checked out"
                row={undefined}
                defaultBranch="main"
            />
        );
        expect(html).toContain('<dt>Branch</dt><dd>main</dd>');
        expect(html.match(new RegExp(NOT_AVAILABLE, 'g'))).toHaveLength(2);
    });

    it('renders the environment editor after the checkout facts', () => {
        const html = render(
            <RepositoryConfigDetail repo={{ owner: 'acme', name: 'web' }} checkout="Ready" row={undefined}>
                <p>EDITOR</p>
            </RepositoryConfigDetail>
        );
        expect(html.indexOf('EDITOR')).toBeGreaterThan(html.indexOf('<dt>Size</dt>'));
    });

    it("carries no switch blocker of its own — the guarded switch is the area dialog's (issue 182)", () => {
        // The dirty detail guards its switch through the settings area's ONE discard confirmation;
        // a blocker line here would be a second dialog contract.
        const html = render(
            <RepositoryConfigDetail
                repo={{ owner: 'acme', name: 'web' }}
                checkout="Ready"
                headingRef={undefined}
                row={undefined}
            />
        );
        expect(html).not.toContain('unsaved');
        expect(html).not.toContain('Discard');
    });
});
