/**
 *     npm run invite -- --login <github-login> [--role admin|member]
 *     npm run invite -- --login <github-login> --remove
 *     npm run invite -- --list
 *
 * Membership is Factory's, not GitHub's — a Factory organization is not a GitHub organization, so
 * there is nothing to read from GitHub to find out who belongs here. An invite is a row naming a
 * login; the account is bound to it the first time that person signs in.
 *
 * An invite therefore exists BEFORE the account does, which is why a login can be invited that has
 * never been seen, and why this cannot validate that the person exists.
 */
import postgres from 'postgres';
import { createAuthStore } from '../auth/store.js';
import type { Role } from '../auth/store.js';
import { resolveConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { parseArgs, value } from './args.js';

// No fetch credential, said in code. This CLI writes one membership row and never reads GitHub, so
// requiring App credentials to run it would mean a deployment could not invite its first admin
// until the App was registered — and would make `npm run invite` refuse a disposable database,
// which is what scripts/test-jobs.sh points it at.
const { config } = resolveConfig({ env: process.env, github: { mode: 'none' } });
const args = parseArgs(process.argv.slice(2));

const orgId = value(args, 'org') ?? config.orgId;
const login = value(args, 'login');
const role = (value(args, 'role') ?? 'member') as Role;

if (role !== 'admin' && role !== 'member') {
    console.error(`--role must be "admin" or "member", got "${role}"`);
    process.exit(1);
}
if (!login && !args.list) {
    console.error('usage: npm run invite -- --login <github-login> [--role admin|member] [--remove]');
    console.error('       npm run invite -- --list');
    process.exit(1);
}

const sql = postgres(config.databaseUrl, { max: 2 });
try {
    const ready = migrate(sql, { orgId, orgName: config.orgName, attempts: 3 });
    const store = createAuthStore({ sql, ready });

    if (args.list) {
        const members = await store.listMembers(orgId);
        if (!members.length) console.log(`"${orgId}" has no members`);
        for (const member of members) {
            console.log(`${member.role.padEnd(6)} ${member.login}${member.claimed ? '' : '  (never signed in)'}`);
        }
    } else if (args.remove) {
        const result = await store.removeMember(orgId, login!);
        if (result === 'missing') {
            console.error(`"${login}" is not a member of "${orgId}"`);
            process.exit(1);
        }
        // Said out loud because it is the difference between removal taking effect now and taking
        // effect whenever the cookie happened to expire.
        console.log(`removed "${login}" from "${orgId}" and ended their sessions`);
    } else {
        const result = await store.invite(orgId, login!, role);
        console.log(
            result === 'created'
                ? `invited "${login}" to "${orgId}" as ${role}; they are a member once they sign in with GitHub`
                : `"${login}" is now ${role} in "${orgId}"`,
        );
    }
} finally {
    await sql.end({ timeout: 5 });
}
