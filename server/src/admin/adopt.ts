/**
 *     npm run adopt -- --installation <id> [--from <legacy-org-id>]
 *
 * One-off legacy-data adoption for the multi-org upgrade (#99).
 *
 * Before #99 a deployment had exactly one organization, named by ORG_ID. After it, the orgs are
 * the App's installations: ids are installation ids, and boot no longer knows an org to claim rows
 * into. A database upgraded in place therefore holds its history under the old configured id while
 * sign-in lands new sessions in the installation's org — which reads as an empty dashboard, the
 * exact silent failure adoptOrg() has always existed to prevent. This CLI is the upgrade step the
 * docs say to run.
 *
 * It never fetches (the code-only no-fetch arm, like every admin CLI), so it is safe against any
 * database the operator names — including the disposable ones, where it is also harmless.
 */
import postgres from 'postgres';
import { resolveConfig } from '../config.js';
import { adoptOrg, mergeLegacyOrg, migrate } from '../db/migrate.js';
import { parseArgs, value } from './args.js';

const { config } = resolveConfig({ env: process.env, github: { mode: 'none' } });
const args = parseArgs(process.argv.slice(2));

const installation = value(args, 'installation');
const from = value(args, 'from');

if (!installation || !/^\d+$/.test(installation)) {
    console.error('usage: npm run adopt -- --installation <id> [--from <legacy-org-id>]');
    console.error('       <id> is the GitHub App installation id — a number. Find it in the App settings URL,');
    console.error('       or from GET /app/installations. It becomes the organization id.');
    process.exit(1);
}

if (from && from.startsWith('__')) {
    console.error(`--from "${from}" is inside the reserved "__" namespace; the legacy ORG_ID is meant.`);
    process.exit(1);
}

if (from && from === installation) {
    // The merge would upsert every row onto itself and the cleanup would then delete the
    // org's whole history — the one argument pair that turns an adoption into a wipe.
    console.error('--from must name the legacy organization, not the installation being adopted into.');
    process.exit(1);
}

const sql = postgres(config.databaseUrl, { max: 2 });
try {
    const ready = migrate(sql, { attempts: 3, log: (m) => console.log(`[migrate] ${m}`) });
    await ready;

    // The org row: id = the installation id. The name is the installation id until the first
    // sign-in reports the account login and signIn's upsert rewrites it — a label, free to be
    // wrong for a while.
    await sql`
        insert into organization (id, name, installation_id)
        values (${installation}, ${installation}, ${installation}::bigint)
        on conflict (id) do update set installation_id = excluded.installation_id
    `;
    console.log(`[adopt] organization "${installation}" is the installation's org`);

    // The pre-organization rows 005 parked, claimed into the new org.
    await adoptOrg(sql, installation, (m) => console.log(`[adopt] ${m}`));

    if (from) {
        // History written under the legacy configured id is merged into the installation's org —
        // every org-owned table, not only the telemetry — and the legacy org row is retired, so
        // the selector and the adoption notice stop naming it (#123).
        await mergeLegacyOrg(sql, installation, from, (m) => console.log(`[adopt] ${m}`));
    }

    console.log(`[adopt] done. Members sign in as usual; the dashboard reads from "${installation}" now.`);
} finally {
    await sql.end({ timeout: 5 });
}
