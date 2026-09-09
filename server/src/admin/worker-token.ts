/**
 *     npm run worker-token -- --name driver-1
 *     npm run worker-token -- --name driver-1 --revoke
 *     npm run worker-token -- --list
 *
 * Mints the credential a driver claims jobs with, and prints it exactly once — only its hash is
 * stored, so a lost token is reissued rather than recovered.
 *
 * A CLI and not a route, deliberately. Everything else a signed-in member can do is bounded by the
 * organization; this issues a credential that lets a process claim work and report results without a
 * human anywhere, so it is minted by somebody with shell on the machine rather than by anybody with
 * a session.
 */
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { hashToken } from '../auth/session.js';
import { createAuthStore } from '../auth/store.js';
import { resolveConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { parseArgs, value } from './args.js';

/**
 * A prefix, not decoration: it makes a leaked token greppable in a log or a repository, and it lets
 * the board tell "this is a worker token" from "this is something else" without a database lookup.
 */
const PREFIX = 'fwt_';

// No fetch credential, said in code, for the same reason as invite.ts: this mints one credential
// against the database and never reads GitHub, so App credentials are not its business — and
// requiring them would stop it running against the disposable database scripts/test-jobs.sh uses.
const { config } = resolveConfig({ env: process.env, github: { mode: 'none' } });
const args = parseArgs(process.argv.slice(2));

const orgId = value(args, 'org') ?? config.orgId;
const name = value(args, 'name');

if (!name && !args.list) {
    console.error('usage: npm run worker-token -- --name <worker-name> [--revoke]');
    console.error('       npm run worker-token -- --list');
    process.exit(1);
}

const sql = postgres(config.databaseUrl, { max: 2 });
try {
    const ready = migrate(sql, { orgId, orgName: config.orgName, attempts: 3 });
    const store = createAuthStore({ sql, ready });

    if (args.list) {
        const tokens = await store.listWorkerTokens(orgId);
        if (!tokens.length) console.log(`"${orgId}" has no worker tokens`);
        for (const token of tokens) {
            console.log(`${token.name}  ${token.createdAt}${token.revoked ? '  (revoked)' : ''}`);
        }
    } else if (args.revoke) {
        const result = await store.revokeWorkerToken(orgId, name!);
        if (result === 'missing') {
            console.error(`"${name}" has no live token in "${orgId}"`);
            process.exit(1);
        }
        console.log(`revoked "${name}"; its driver will start failing every claim with 401`);
    } else {
        const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
        await store.createWorkerToken(orgId, name!, hashToken(token));
        console.log(`worker token for "${name}" in "${orgId}" — shown once, only its hash is stored:\n`);
        console.log(`  JOB_BOARD_TOKEN=${token}\n`);
        console.log('Put it in the driver\'s environment. It is not recoverable; reissue if lost.');
    }
} finally {
    await sql.end({ timeout: 5 });
}
