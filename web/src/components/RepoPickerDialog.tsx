import { useEffect, useMemo, useState } from 'react';
import {
    Combobox,
    ComboboxInput,
    ComboboxOption,
    ComboboxOptions,
    Dialog,
    DialogPanel,
    DialogTitle,
} from '@headlessui/react';
import { useRepos, type InstallationRepo, type ReposPayload } from '../api/useRepos.js';

/**
 * Choose which repositories to check out.
 *
 * A Headless UI `Dialog`. That buys the portal, focus trapping, focus restoration, `inert` on the
 * rest of the page, the backdrop and Escape (via `onClose`, which now also fires for a click
 * outside the panel — the same dismissal as "Not now"), none of which have to be written here. A
 * hand-rolled focus trap is the single most reliably broken part of a first modal.
 *
 * One trap worth naming, because it fails quietly: no `<form method="dialog">`, and no submitting
 * form at all. `server/src/app.ts` sends `form-action 'none'`, which is the same reason LoginGate
 * is an anchor rather than a form.
 */

export interface RepoPickerProps {
    open: boolean;
    /** What is already selected, so re-opening the dialog does not look like a fresh start. */
    selected: readonly { owner: string; name: string }[];
    onClose: () => void;
    onSave: (repos: { owner: string; name: string }[]) => Promise<string | null>;
    saving: boolean;
}

const key = (repo: { owner: string; name: string }) => `${repo.owner}/${repo.name}`;

/** Most recently pushed first, because that is where somebody's own repositories are. */
function order(repos: readonly InstallationRepo[]): InstallationRepo[] {
    return [...repos].sort((a, b) => {
        if (a.pushedAt && b.pushedAt) return b.pushedAt.localeCompare(a.pushedAt);
        if (a.pushedAt) return -1;
        if (b.pushedAt) return 1;
        return key(a).localeCompare(key(b));
    });
}

/**
 * Fold the Combobox's click into the chosen set: the picked keys, plus every held key the rendered
 * options no longer represent.
 *
 * `chosen` — not the rendered list — is the source of truth, because the save payload is the WHOLE
 * selection: a repository the filter is currently hiding, or that the installation stopped
 * reporting, must survive a toggle of a different row rather than vanish from the next PUT. Keys
 * the list still renders are whatever the Combobox just said, toggles included.
 */
export function nextChosen(
    chosen: ReadonlySet<string>,
    picked: readonly string[],
    optionKeys: Iterable<string>
): Set<string> {
    const rendered = new Set(optionKeys);
    const next = new Set(picked);
    for (const held of chosen) if (!rendered.has(held)) next.add(held);
    return next;
}

/**
 * Save stays dark until the list has actually loaded, a save is not already running, and — since
 * the payload is the WHOLE selection — never against a list nobody has seen. Pure and exported so
 * the guard is pinnable: the button lives inside the Dialog's portal, which the offline render
 * suite cannot reach.
 */
export function saveDisabled(saving: boolean, loading: boolean, data: ReposPayload | null): boolean {
    return saving || loading || !data;
}

export function RepoPickerDialog({ open, selected, onClose, onSave, saving }: RepoPickerProps) {
    const { data, loading, error } = useRepos(open);
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [search, setSearch] = useState('');
    const [failure, setFailure] = useState<string | null>(null);

    /*
     * Seeded from the server's answer when the dialog OPENS, and not again while it is open.
     *
     * `selected` comes from the polled workspace payload, so it is a fresh array on every tick —
     * depending on it directly re-ran this effect every two seconds during a clone and threw away
     * whatever the person had just clicked. Keyed on the identity of the selection rather than on
     * the array, so a real change to it while the dialog is shut is still picked up.
     */
    const seed = selected.map(key).sort().join(',');
    useEffect(() => {
        if (open) setChosen(new Set(seed ? seed.split(',') : []));
    }, [open, seed]);

    const repos = useMemo(() => order(data?.repos ?? []), [data]);
    const shown = useMemo(() => {
        const needle = search.trim().toLowerCase();
        // Client-side: an installation holds hundreds at most, which fits in memory, and a search
        // endpoint is a route nobody asked for.
        return needle ? repos.filter((repo) => key(repo).toLowerCase().includes(needle)) : repos;
    }, [repos, search]);

    /*
     * Built from `chosen`, NOT by filtering the installation list.
     *
     * Filtering meant that a list which had not loaded — or had failed — produced an empty payload,
     * and the body of this request is the WHOLE selection, so one click on Save would have
     * deselected everything the member already had. It also silently dropped any repository the
     * installation had stopped reporting. The keys are the source of truth here; the list is only
     * how they were chosen.
     */
    const save = async () => {
        const picked = [...chosen].map((entry) => {
            const slash = entry.indexOf('/');
            return { owner: entry.slice(0, slash), name: entry.slice(slash + 1) };
        });
        const message = await onSave(picked);
        setFailure(message);
        if (!message) onClose();
    };

    return (
        <Dialog open={open} onClose={onClose} className="dialog-layer" aria-labelledby="picker-title">
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="picker">
                    <DialogTitle as="h2" id="picker-title">
                        Select repositories
                    </DialogTitle>
                    <p className="muted">
                        Each one is cloned into your workspace. You can change this later from the Workspace page.
                    </p>

                    {loading ? <p className="status">Loading repositories…</p> : null}
                    {error ? <p className="status">Could not reach GitHub: {error}</p> : null}
                    {data?.meta.error ? <p className="status">Showing a cached list: {data.meta.error}</p> : null}

                    {/* An empty list with no error is its own state: the App exists but is installed on
                        nothing, and telling somebody to "select repositories" from an empty list is a dead
                        end. This is also why the dialog is dismissible. */}
                    {!loading && !repos.length ? (
                        <p className="status">
                            This GitHub App is not installed on any repositories yet. Ask an administrator to install it
                            on the organization you work in.
                        </p>
                    ) : null}

                    {repos.length ? (
                        <>
                            {/* Two-step Escape while the filter has text: the Combobox closes (and
                                `onClose` clears the filter) and eats the keypress, so the Dialog
                                closes on the second press. The state stays owned by React either
                                way — no desync, which is the contract. */}
                            <Combobox
                                multiple
                                value={[...chosen]}
                                onChange={(picked) => setChosen(nextChosen(chosen, picked, shown.map(key)))}
                                onClose={() => setSearch('')}
                            >
                                <label className="picker-search" htmlFor="repo-filter">
                                    <span className="muted">filter</span>
                                    <ComboboxInput
                                        id="repo-filter"
                                        value={search}
                                        placeholder="owner/name"
                                        onChange={(event) => setSearch(event.target.value)}
                                    />
                                </label>
                                <ComboboxOptions static className="picker-list">
                                    {shown.map((repo) => (
                                        <ComboboxOption key={key(repo)} value={key(repo)} className="picker-option">
                                            <span className="picker-name">{key(repo)}</span>
                                            {repo.private ? <span className="pill">private</span> : null}
                                        </ComboboxOption>
                                    ))}
                                </ComboboxOptions>
                            </Combobox>
                            <p className="muted">{chosen.size} selected</p>
                        </>
                    ) : null}

                    {failure ? <p className="status">{failure}</p> : null}

                    {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
                    <div className="picker-actions">
                        <button type="button" onClick={onClose}>
                            Not now
                        </button>
                        {/* Disabled until the list has actually loaded. Saving is a REPLACE of the whole
                            selection, so doing it against a list nobody has seen is how a member loses
                            every checkout they had. */}
                        <button
                            type="button"
                            className="primary"
                            onClick={() => void save()}
                            disabled={saveDisabled(saving, loading, data)}
                        >
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
