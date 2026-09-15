import type { Role } from '../auth/store.js';
import type { AuthStore } from '../auth/store.js';

/**
 * One periodic sweep of the membership roster against the GitHub org's.
 *
 * Removal and re-roling only — this can never admit anyone. A login the GitHub org does not list
 * loses the Factory row auto-join created for it (and `removeMember` ends their sessions and
 * personal tokens with it); a login whose org role changed has the auto-joined row re-roled.
 * Invite-born rows are not in the input at all — `listAutoJoined` selects them out — because an
 * admin named those people here, and GitHub's opinion of them is irrelevant.
 */
export interface RosterSyncPlan {
    /** Auto-joined logins the GitHub org no longer lists. */
    remove: string[];
    /** Auto-joined logins whose Factory role must move to match the org. */
    setRole: { login: string; role: Role }[];
}

export function planRosterSync(
    members: readonly { login: string; role: Role }[],
    org: ReadonlyMap<string, Role>
): RosterSyncPlan {
    const remove: string[] = [];
    const setRole: { login: string; role: Role }[] = [];
    for (const member of members) {
        const orgRole = org.get(member.login);
        if (!orgRole) remove.push(member.login);
        else if (orgRole !== member.role) setRole.push({ login: member.login, role: orgRole });
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
export async function runRosterSync(
    store: AuthStore,
    orgId: string,
    org: ReadonlyMap<string, Role>
): Promise<RosterSyncResult> {
    const plan = planRosterSync(await store.listAutoJoined(orgId), org);
    const removed: string[] = [];
    const roled: string[] = [];
    for (const login of plan.remove) {
        if ((await store.removeMember(orgId, login)) === 'removed') removed.push(login);
    }
    for (const { login, role } of plan.setRole) {
        if (await store.updateMemberRole(orgId, login, role)) roled.push(login);
    }
    return { removed, roled };
}
