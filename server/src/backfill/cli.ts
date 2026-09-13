import postgres from 'postgres';
import { resolveConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { backfillTranscripts } from './transcripts.js';

/**
 *     npm run backfill
 *
 * Reads Claude Code transcripts from disk and imports them. Safe to re-run: rows land with
 * `source = 'transcript'` and the dedup index makes a second pass a no-op.
 */
const { config } = resolveConfig();
if (!config.databaseUrl) {
    console.error(
        'backfill requires DATABASE_URL or telemetry.database_url (and TELEMETRY_SOURCE=postgres to see the result)',
    );
    process.exit(1);
}

const sql = postgres(config.databaseUrl, { max: 4 });
try {
    // Imported sessions land in the configured organization, so a backfill run against the wrong
    // one is worth naming before it writes anything.
    console.log(`[org] importing into ${config.orgName} (${config.orgId})`);
    await migrate(sql, {
        orgId: config.orgId,
        orgName: config.orgName,
        log: (m) => console.log(`[migrate] ${m}`),
    });
    const summary = await backfillTranscripts(sql, {
        orgId: config.orgId,
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
