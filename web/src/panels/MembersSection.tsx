import { ADMIN_ROLE, type Role } from '@factory-ai/core';
import { useCallback, useEffect, useState } from 'react';
import { listMembers, setMemberRole, type MemberView } from '../api/orgMembers.js';
import type { Session } from '../api/useSession.js';
import { MembersPanel } from './MembersPanel.js';

/**
 * The members section's interactive half (issue 410): the roster read, the role write, and the
 * audience split — the table is an administrator's surface because the roster read is
 * admin-gated server-side, so a member's browser renders the muted sentence and issues no fetch
 * at all. Split out of `SettingsOrganizationPage` so the page stays a composition; the section
 * owns its state because its CRUD is member-rows, not the polls the layout publishes.
 *
 * Nothing renders for no session or `AUTH_MODE=none`: that mode has no session and no role, and
 * every gate there is already open — a role table for a stand-in account would be theater (the
 * tokens-section precedent).
 */
export function MembersSection({ session }: { session: Session | null }) {
    const isAdmin = session?.mode === 'github' && session.role === ADMIN_ROLE;
    const [members, setMembers] = useState<MemberView[] | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const result = await listMembers();
        if (!result.ok) {
            setError(result.error);
            return;
        }
        setMembers(result.members);
    }, []);

    useEffect(() => {
        if (!isAdmin) return;
        void refresh();
    }, [isAdmin, refresh]);

    /**
     * The row's role write: refused means the message on this section's own error line. When the
     * write itself lands but the refetch fails, `members` still shows the pre-write roles beside
     * that error — the selects snap back until a reload refetches; the server holds the truth.
     */
    const changeRole = async (member: MemberView, role: Role) => {
        setError(null);
        setSaving(true);
        const message = await setMemberRole(member.userId, role);
        setSaving(false);
        if (message) {
            setError(message);
            return;
        }
        await refresh();
    };

    if (session === null || session.mode !== 'github') return null;

    return (
        <>
            {error ? <p className="status">{error}</p> : null}
            {isAdmin ? (
                members === null ? (
                    <section className="panel">
                        <h2>Members</h2>
                        <p className="status">Loading members…</p>
                    </section>
                ) : (
                    <MembersPanel
                        members={members}
                        saving={saving}
                        onChange={(member, role) => void changeRole(member, role)}
                    />
                )
            ) : (
                <p className="muted">Member roles are managed by your organization&rsquo;s admins.</p>
            )}
        </>
    );
}
