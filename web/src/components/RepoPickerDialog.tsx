import { useEffect, useMemo, useRef, useState } from 'react';
import { useRepos, type InstallationRepo } from '../api/useRepos.js';

/**
 * Choose which repositories to check out.
 *
 * A native `<dialog>` driven by `showModal()`. That buys the top layer — so no z-index argument with
 * the topbar — plus `::backdrop`, focus trapping, focus restoration, `inert` on the rest of the
 * page, and Escape, none of which have to be written here. A hand-rolled focus trap is the single
 * most reliably broken part of a first modal.
 *
 * Two traps worth naming, because both fail quietly:
 *
 * - Never render `<dialog open>`. That is the NON-modal mode: no top layer, no backdrop, no focus
 *   trap. Modality comes from calling `showModal()`, which is why it happens in an effect.
 * - No `<form method="dialog">`, and no submitting form at all. `server/src/app.ts` sends
 *   `form-action 'none'`, which is the same reason LoginGate is an anchor rather than a form.
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

export function RepoPickerDialog({ open, selected, onClose, onSave, saving }: RepoPickerProps) {
    const ref = useRef<HTMLDialogElement | null>(null);
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

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        if (!open && dialog.open) dialog.close();
    }, [open]);

    // Escape closes the dialog without telling React, so without this the parent still believes it
    // is open and will not reopen it.
    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        const closed = () => onClose();
        dialog.addEventListener('close', closed);
        return () => dialog.removeEventListener('close', closed);
    }, [onClose]);

    const repos = useMemo(() => order(data?.repos ?? []), [data]);
    const shown = useMemo(() => {
        const needle = search.trim().toLowerCase();
        // Client-side: an installation holds hundreds at most, which fits in memory, and a search
        // endpoint is a route nobody asked for.
        return needle ? repos.filter((repo) => key(repo).toLowerCase().includes(needle)) : repos;
    }, [repos, search]);

    const toggle = (repo: InstallationRepo) => {
        setChosen((held) => {
            const next = new Set(held);
            if (next.has(key(repo))) next.delete(key(repo));
            else next.add(key(repo));
            return next;
        });
    };

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
        <dialog className="picker" ref={ref} aria-labelledby="picker-title">
            <h2 id="picker-title">Select repositories</h2>
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
                    This GitHub App is not installed on any repositories yet. Ask an administrator to install it on the
                    organization you work in.
                </p>
            ) : null}

            {repos.length ? (
                <>
                    <label className="picker-search">
                        <span className="muted">filter</span>
                        <input
                            type="text"
                            value={search}
                            placeholder="owner/name"
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </label>
                    <ul className="picker-list">
                        {shown.map((repo) => (
                            <li key={key(repo)}>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={chosen.has(key(repo))}
                                        onChange={() => toggle(repo)}
                                    />
                                    <span className="picker-name">{key(repo)}</span>
                                    {repo.private ? <span className="pill">private</span> : null}
                                </label>
                            </li>
                        ))}
                    </ul>
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
                    disabled={saving || loading || !data}
                >
                    {saving ? 'Saving…' : 'Save'}
                </button>
            </div>
        </dialog>
    );
}
