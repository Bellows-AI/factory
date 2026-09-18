/**
 * Empty the synthetic-data tables verify:ui is about to reseed.
 *
 * The seed is additive (`on conflict do nothing`) and every run generates fresh session ids, so
 * without this the databases accumulate one generator window per run: the "All time" range grows
 * a little every run and the cold first stats fetch eventually outlives the test timeout — a
 * failure that looks like a UI bug and is really six months of stacked synthetic Marches. The
 * config comment promises every run reads exactly what this run's generator produces; the TRUNCATE
 * below is what keeps that promise true. It runs before the seed, which runs before any server.
 *
 * The same disposable-name rule as the seed's guard, one step earlier — this script deletes, so
 * it refuses louder.
 */
import postgres from 'postgres';

const DISPOSABLE = /_(seed|synthetic|demo|e2e|test)$/;

const url = process.env.DATABASE_URL;
if (!url) {
    console.error('reset-db requires DATABASE_URL');
    process.exit(1);
}
const name = new URL(url).pathname.replace(/^\//, '');
if (!DISPOSABLE.test(name)) {
    console.error(
        `Refusing to reset "${name}": this script TRUNCATES data. Point it at a database whose\n` +
            `name ends in _seed, _synthetic, _demo, _e2e or _test.`
    );
    process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
    // The three tables the seed writes (job_summary is a column, not a table). A database that
    // has never been seeded has none of them yet — "nothing to reset" is success, not an error.
    for (const table of ['metric_point', 'session_branch', 'job']) {
        try {
            await sql.unsafe(`truncate table ${table}`);
        } catch (e) {
            if (e?.code !== '42P01') throw e;
        }
    }
    console.log(`[reset-db] ${name}: synthetic tables truncated`);
} finally {
    await sql.end();
}
