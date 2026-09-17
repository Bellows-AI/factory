import postgres from 'postgres';
import { LOCAL_ORG_ID, resolveConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { parseArgs, value } from '../admin/args.js';
import { backfillTranscripts } from './transcripts.js';

/**
 *     npm run backfill [-- --org <installation-id>]
 *
 * Reads Claude Code transcripts from disk and imports them. Safe to re-run: rows land with
 * `source = 'transcript'` and the dedup index makes a second pass a no-op.
 *
 * `--org` names the organization the sessions belong to. It defaults to the local org
 * (AUTH_MODE=none); a github-mode deployment names its installation id.
 */
const { config } = resolveConfig();
if (!config.databaseUrl) {
    console.error(
        'backfill requires DATABASE_URL or telemetry.database_url (and TELEMETRY_SOURCE=postgres to see the result)'
    );
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
// none mode falls back to the local org, which boot seeds. Github mode has no fallback: a legacy
// `default` row can still sit in an upgraded database, so the existence check below cannot tell a
// live installation from that leftover, and an omitted --org would land the import outside every
// installation org. Explicit is the only safe spelling there.
const orgId = value(args, 'org') ?? (config.auth.mode === 'none' ? LOCAL_ORG_ID : undefined);
if (!orgId) {
    console.error('github mode requires --org <installation-id> — its organizations come from sign-in, not boot.');
    process.exit(1);
}

const sql = postgres(config.databaseUrl, { max: 4 });
try {
    // Imported sessions land in one organization, so a backfill run against the wrong one is
    // worth naming before it writes anything.
    console.log(`[org] importing into ${orgId}`);
    // The none-mode default: migrating with the local org, exactly as the server boots, so the
    // default target exists. Github mode seeds nothing — its orgs come from sign-in.
    await migrate(sql, { localUser: config.auth.mode === 'none', log: (m) => console.log(`[migrate] ${m}`) });
    // The org must exist before the first row: session_branch's foreign key would otherwise
    // fail partway through the import, leaving a partial write behind. Github mode's orgs are
    // materialized at sign-in (#99) — boot created none, so a typo'd or too-early --org aborts
    // here instead of halfway through the transcripts.
    const orgs = await sql`select id from organization where id = ${orgId}`;
    if (!orgs.length) {
        console.error(
            `"${orgId}" is not an organization in this database. Sign in once to materialize the installation's org, then retry.`
        );
        process.exit(1);
    }
    const summary = await backfillTranscripts(sql, {
        orgId,
        log: (m) => console.log(`[backfill] ${m}`),
    });

    console.log('\nimported:');
    console.log(`  transcripts   ${summary.files}`);
    console.log(`  sessions      ${summary.sessions}`);
    console.log(`  datapoints    ${summary.datapoints}`);
    console.log(`  branch spans  ${summary.branchSpans}`);

    if (summary.unresolvedCwds.length) {
        // Not a failure. These are checkouts that no longer exist, so the repo cannot be
        // resolved and their sessions will surface as sessionsWithoutHook rather than being
        // attributed to the wrong repository.
        console.log(`\n${summary.unresolvedCwds.length} working directories no longer resolve to a repo:`);
        for (const cwd of summary.unresolvedCwds.slice(0, 10)) console.log(`  ${cwd}`);
        if (summary.unresolvedCwds.length > 10) {
            console.log(`  ... and ${summary.unresolvedCwds.length - 10} more`);
        }
    }
} finally {
    await sql.end();
}
