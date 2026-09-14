import { useState } from 'react';
import type { AccessTokenView, MintResult } from '../api/useAccessTokens.js';
import { useAccessTokens } from '../api/useAccessTokens.js';
import { taskTime } from '../format.js';

export interface AccessTokensPanelProps {
    title: string;
    /** One sentence on what this scope is for; rendered under the heading. */
    hint: string;
    tokens: AccessTokenView[];
    loading: boolean;
    error: string | null;
    onCreate: (label: string) => Promise<MintResult>;
    onRevoke: (id: string) => Promise<string | null>;
    /** Rendered read-only while a write is in flight or the scope is not the caller's to edit. */
    disabled?: boolean;
}

/**
 * One access-token scope: the create form, the list, and the printed-once moment.
 *
 * The list shows labels and last use, never a token — the plaintext exists exactly once, in the
 * mint response, and `minted` is the state that keeps it on screen until Done is pressed. No
 * `<form>`: the CSP sends `form-action 'none'`, the same trap that makes LoginGate an anchor.
 */
export function AccessTokensPanel({
    title,
    hint,
    tokens,
    loading,
    error,
    onCreate,
    onRevoke,
    disabled = false,
}: AccessTokensPanelProps) {
    const [label, setLabel] = useState('');
    const [minted, setMinted] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        setBusy(true);
        setFailure(null);
        try {
            const result = await onCreate(label.trim());
            if (!result.ok) {
                setFailure(result.error);
            } else {
                setMinted(result.token);
                setCopied(false);
                setLabel('');
            }
        } finally {
            setBusy(false);
        }
    };

    const revoke = async (id: string) => {
        setFailure(null);
        const reason = await onRevoke(id);
        if (reason) setFailure(reason);
    };

    const copy = async () => {
        if (minted === null) return;
        try {
            await navigator.clipboard.writeText(minted);
            setCopied(true);
        } catch {
            // Clipboard access can be refused; the token stays on screen to copy by hand.
            setCopied(false);
        }
    };

    return (
        <section className="panel">
            <div className="panel-head">
                <h2>{title}</h2>
            </div>
            {hint ? <p className="muted">{hint}</p> : null}
            {error ? <p className="status">{error}</p> : null}
            {failure ? <p className="status">{failure}</p> : null}

            {minted !== null ? (
                <div className="token-once">
                    <p>
                        Shown once — copy it now. Only its hash is stored, and it cannot be read again; a lost token is
                        revoked and reissued.
                    </p>
                    <code>{minted}</code>{' '}
                    <button type="button" className="primary" onClick={() => void copy()}>
                        {copied ? 'Copied' : 'Copy'}
                    </button>{' '}
                    <button type="button" onClick={() => setMinted(null)}>
                        Done
                    </button>
                </div>
            ) : (
                <>
                    <p>
                        <input
                            aria-label="Token label"
                            placeholder="what this token is for"
                            value={label}
                            disabled={disabled || busy}
                            onChange={(e) => setLabel(e.target.value)}
                        />{' '}
                        <button
                            type="button"
                            className="primary"
                            disabled={disabled || busy || label.trim() === ''}
                            onClick={() => void submit()}
                        >
                            {busy ? 'Creating…' : 'Create token'}
                        </button>
                    </p>

                    {loading ? <p className="muted">Loading…</p> : null}
                    {!loading && tokens.length === 0 ? <p className="muted">No tokens.</p> : null}
                    {tokens.length > 0 ? (
                        <table className="access-tokens">
                            <thead>
                                <tr>
                                    <th scope="col">Label</th>
                                    <th scope="col">Created</th>
                                    <th scope="col">Last used</th>
                                    <th scope="col">
                                        <span className="visually-hidden">Revoke</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {tokens.map((token) => (
                                    <tr key={token.id}>
                                        <td>{token.label}</td>
                                        <td>{taskTime(token.createdAt)}</td>
                                        <td>{taskTime(token.lastUsedAt)}</td>
                                        <td>
                                            {token.revokedAt !== null ? (
                                                <span className="muted">revoked</span>
                                            ) : (
                                                <button
                                                    type="button"
                                                    disabled={disabled || busy}
                                                    aria-label={`Revoke ${token.label}`}
                                                    onClick={() => void revoke(token.id)}
                                                >
                                                    Revoke
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    ) : null}
                </>
            )}
        </section>
    );
}

/**
 * One scope bound to its data. Mounted only where the caller may actually use it — the org scope
 * is admin-only, so a member's settings page never even asks the server for it.
 */
export function AccessTokensSection({ scope }: { scope: 'personal' | 'org' }) {
    const access = useAccessTokens(scope);
    return (
        <AccessTokensPanel
            title={scope === 'org' ? 'Organization access tokens' : 'Personal access tokens'}
            hint={
                scope === 'org'
                    ? 'Acts for the organization on read-only routes — for automation that outlives any member. Minted by an admin.'
                    : 'Acts as you on the API routes, in an Authorization: Bearer header. Shown once at creation; revoke any time.'
            }
            tokens={access.tokens ?? []}
            loading={access.loading}
            error={access.error}
            onCreate={access.create}
            onRevoke={access.revoke}
        />
    );
}
