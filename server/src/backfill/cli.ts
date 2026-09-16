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
 * (AUTH_MODE=none); a github-mode deployment names its installation id — the same id
 * `npm run adopt` printed for the legacy data.
 */
const { config } = resolveConfig();
if (!config.databaseUrl) {
    console.error(
        'backfill requires DATABASE_URL or telemetry.database_url (and TELEMETRY_SOURCE=postgres to see the result)'
    );
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const orgId = value(args, 'org') ?? LOCAL_ORG_ID;

const sql = postgres(config.databaseUrl, { max: 4 });
try {
    // Imported sessions land in one organization, so a backfill run against the wrong one is
    // worth naming before it writes anything.
    console.log(`[org] importing into ${orgId}`);
    await migrate(sql, { log: (m) => console.log(`[migrate] ${m}`) });
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
