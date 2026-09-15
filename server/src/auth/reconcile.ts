import type { Role } from '../auth/store.js';
import type { AuthStore } from '../auth/store.js';

/**
 * What one GitHub roster entry says about a member: the org role, under the login GitHub CURRENTLY
 * knows them by. Keyed by the numeric GitHub id, never the login — the login is a mutable label
 * (docs/auth.md), and a member who renamed would be false-removed by a login match every sweep.
 */
export interface RosterEntry {
    login: string;
    role: Role;
}

/** A roster keyed by GitHub's numeric user id — the identity, not the label. */
export type Roster = ReadonlyMap<number, RosterEntry>;

/**
 * One periodic sweep of the membership roster against the GitHub org's.
 *
 * Removal and re-roling only — this can never admit anyone. A GitHub id the org no longer lists
 * loses the Factory row auto-join created for it (and `removeMemberById` ends their sessions and
 * personal tokens with it); a member whose org role changed has the auto-joined row re-roled.
 * Invite-born rows are not in the input at all — `listAutoJoined` selects them out — because an
 * admin named those people here, and GitHub's opinion of them is irrelevant.
 */
export interface RosterSyncPlan {
    /** Auto-joined members the GitHub org no longer lists, named by their stored login for the log. */
    remove: { userId: string; login: string }[];
    /** Auto-joined members whose Factory role must move to match the org. */
    setRole: { userId: string; login: string; role: Role }[];
}

export function planRosterSync(
    members: readonly { login: string; role: Role; userId: string; githubUserId: number }[],
    org: Roster
): RosterSyncPlan {
    const remove: { userId: string; login: string }[] = [];
    const setRole: { userId: string; login: string; role: Role }[] = [];
    for (const member of members) {
        const entry = org.get(member.githubUserId);
        if (!entry) remove.push({ userId: member.userId, login: member.login });
        else if (entry.role !== member.role)
            setRole.push({ userId: member.userId, login: member.login, role: entry.role });
    }
    return { remove, setRole };
}

export interface RosterSyncResult {
    removed: string[];
    roled: string[];
}

/**
 * Applies one sweep through the store. Returns the logins it acted on, for the log line — silence
 * is the common case and must stay the common case in the log too.
 */
export async function runRosterSync(store: AuthStore, orgId: string, org: Roster): Promise<RosterSyncResult> {
    const plan = planRosterSync(await store.listAutoJoined(orgId), org);
    const removed: string[] = [];
    const roled: string[] = [];
    for (const { userId, login } of plan.remove) {
        if ((await store.removeMemberById(orgId, userId)) === 'removed') removed.push(login);
    }
    for (const { userId, login, role } of plan.setRole) {
        if (await store.updateMemberRole(orgId, userId, role)) roled.push(login);
    }
    return { removed, roled };
}
