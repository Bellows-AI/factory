import { ADMIN_ROLE, MEMBER_ROLE, type Role } from '@factory-ai/core';
import type { MemberView } from '../api/orgMembers.js';
import { commitDate } from '../format.js';

/**
 * The members table (issue 410): one row per membership of the organization, with a role control
 * per row. Presentational, like `OrgExecutorsPanel` — the section owns the roster's state and
 * the write, this owns the shape. `saving` freezes every control while a write is in flight, and
 * a sole admin's Member option renders disabled: the last-admin refusal is visible before the
 * click that would meet it.
 */
export function MembersPanel({
    members,
    saving,
    onChange,
}: {
    members: readonly MemberView[];
    saving: boolean;
    /** The role change one row's control names; the section owns the write and the refetch. */
    onChange: (member: MemberView, role: Role) => void;
}) {
    const soleAdmin = members.filter((m) => m.role === ADMIN_ROLE).length === 1;
    return (
        <section className="panel">
            <h2>Members</h2>
            <p className="muted">
                Everyone whose sign-in materialized a membership of this organization. As an admin you set each member's
                role; an organization always keeps at least one admin.
            </p>
            <section className="table-wrap" aria-label="Organization members">
                {/* `table-cards`: at ≤640px the row reflows into a labeled card, the way the
                    executors and env tables do. */}
                <table className="data table-cards">
                    <thead>
                        <tr>
                            <th scope="col">Login</th>
                            <th scope="col">Role</th>
                            <th scope="col">Joined</th>
                        </tr>
                    </thead>
                    <tbody>
                        {members.map((member) => (
                            <tr key={member.userId}>
                                <td data-label="Login">{member.githubLogin}</td>
                                <td data-label="Role">
                                    <select
                                        aria-label={`Role for ${member.githubLogin}`}
                                        disabled={saving}
                                        value={member.role}
                                        onChange={(event) => onChange(member, event.target.value as Role)}
                                    >
                                        <option value={ADMIN_ROLE}>Admin</option>
                                        <option value={MEMBER_ROLE} disabled={soleAdmin && member.role === ADMIN_ROLE}>
                                            Member
                                        </option>
                                    </select>
                                </td>
                                <td data-label="Joined">{commitDate(member.claimedAt)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        </section>
    );
}
