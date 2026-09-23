/**
 * The roles a member may hold in an organization.
 *
 * `org_membership_role_ck` in 010_auth.sql must list the same values; adding one means a migration
 * AND this array in the same change.
 */
export const ROLES = ['admin', 'member'] as const;

export type Role = (typeof ROLES)[number];

export const [ADMIN_ROLE, MEMBER_ROLE] = ROLES;
