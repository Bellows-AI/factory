/**
 *     npm run seed
 *
 * Fills a disposable database with synthetic PRs, base-branch history and agent sessions, so the
 * dashboard has something to render without a GitHub token, a rate-limit budget or a collector.
 *
 * Writes through `createPrStore`, not through raw SQL, so seeded data exercises the same write
 * path real data takes — including the truncation rules and the org partitioning. The telemetry
 * half has no store method to go through (the ingest route parses OTLP, which would mean
 * synthesising a wire format to immediately re-parse it), so those three tables are written
 * directly, in exactly the shape `002_views.repeatable.sql` reads.
 *
 * THE GUARD IS THE POINT. Synthetic PRs in a real database is precisely the catastrophe the old
 * `DATA_SOURCE=fixture` derivation existed to make inexpressible, and it is silent: 203 invented
 * PRs render exactly like 203 real ones. So this refuses any database whose name does not mark it
 * disposable, the same shape of guard as the `*_test` refusal in the db suite — and for the same
 * reason, which is that the failure leaves no trace to notice later.
 */
import postgres from 'postgres';
import { createAuthStore } from '../auth/store.js';
import { resolveConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPrStore } from '../db/pr-store.js';
import { generate } from './synthetic.js';

/**
 * A database whose name ends here is understood to be disposable.
 *
 * An allowlist of suffixes rather than a `--force` flag: a flag is typed once, in a hurry, against
 * whatever DATABASE_URL happened to be exported, and there is no undo.
 */
const DISPOSABLE = /_(seed|synthetic|demo|e2e|test)$/;

function databaseName(url: string): string {
    return new URL(url).pathname.replace(/^\//, '');
}

/*
 * No fetch credential, said in code.
 *
 * A seeding process must never hold a fetching credential — that is the same instinct as the
 * disposable-database refusal below, one step earlier: a process that could both invent pull
 * requests and fetch real ones is one environment variable away from mixing them. The `none` arm
 * is passed to resolveConfig directly rather than selected through the environment, because the
 * environment can no longer produce it at all. It also keeps `npm run seed` working with no App
 * registered, which is what the whole no-credential path exists for.
 */
const { config } = resolveConfig({ env: process.env, github: { mode: 'none' } });

if (!config.databaseUrl) {
    console.error('seed requires DATABASE_URL');
    process.exit(1);
}

const name = databaseName(config.databaseUrl);
if (!DISPOSABLE.test(name)) {
    console.error(
        `Refusing to seed "${name}": synthetic pull requests are indistinguishable from real ones once\n` +
            `they are in a database, and there is no way to tell them apart afterwards.\n\n` +
            `Point DATABASE_URL at a database whose name ends in _seed, _synthetic, _demo, _e2e or _test:\n\n` +
            `  docker compose exec timescale psql -U factory -d postgres -c 'create database factory_seed'\n` +
            `  DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed\n`,
    );
    process.exit(1);
}

/*
 * Which repo the synthetic rows are stamped with.
 *
 * Its own variable now that there is no configured repo list to take the first entry of. It has to
 * agree with what the dashboard measures, and the dashboard asks the GitHub App installation — so
 * for a seeded database the agreement runs the other way: seed picks a name, and whoever reads the
 * result runs the offline entry (`server/dist/offline.js`, as `verify:ui` does) so that nothing
 * overrules it.
 */
const repo = process.env.SEED_REPO?.trim() || 'Bellows-AI/bellows.ai';
const now = new Date();
const data = generate({ repo, baseBranch: config.baseBranch, now });

const sql = postgres(config.databaseUrl, { max: 4 });
try {
    console.log(`[seed] organization ${config.orgName} (${config.orgId})`);
    await migrate(sql, {
        orgId: config.orgId,
        orgName: config.orgName,
        attempts: 5,
        log: (m) => console.log(`[migrate] ${m}`),
    });

    // An unclaimed invite, so the browser check can drive a real sign-in against a stub identity
    // provider. Only the invite, never the account: binding one here would skip the claim, which is
    // the half of sign-in most worth exercising in a browser.
    const invited = process.env.SEED_INVITE_LOGIN?.trim();
    if (invited) {
        await createAuthStore({ sql }).invite(config.orgId, invited, 'admin');
        console.log(`[seed] invited ${invited} to ${config.orgId} as admin`);
    }

    const store = createPrStore({ sql, orgId: config.orgId });
    await store.savePullRequests(data.prs);

    await store.saveBranchHistory('github', {
        repo,
        branch: config.baseBranch,
        coveredFrom: data.coveredFrom,
        // The authoritative totals, straight from the generator — never count(*) of the rows
        // below, for the same reason a PR's reviewCount is not count(*) of its reviews.
        commits: data.branchCommits.length,
        reverts: data.branchCommits.filter((c) => /^revert[\s"']/i.test(c.messageHeadline)).length,
        newCommits: data.branchCommits,
    });

    // Telemetry: raw datapoints and the branch side channel, exactly as the two live pipelines
    // write them. `delta` because each row is an increment; a cumulative series would need a
    // start_time and would be reduced with max() rather than summed.
    for (const s of data.sessions) {
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
            values (${config.orgId}, 'claude-code', ${s.sessionId}, ${s.repo}, ${s.branch}, null,
                    ${new Date(s.firstSeen)}, ${new Date(s.lastSeen)}, ${s.samples})
            on conflict (org_id, agent, session_id, repo, branch) do nothing
        `;

        if (s.prNumber !== null) {
            await sql`
                insert into session_pr (org_id, agent, session_id, repo, pr_number, first_seen)
                values (${config.orgId}, 'claude-code', ${s.sessionId}, ${s.repo}, ${s.prNumber},
                        ${new Date(s.firstSeen)})
                on conflict (org_id, agent, session_id, repo, pr_number) do nothing
            `;
        }

        const mid = new Date((Date.parse(s.firstSeen) + Date.parse(s.lastSeen)) / 2);
        const rows = Object.entries(s.fields).map(([field, value]) => ({
            agent: 'claude-code',
            metric: metricFor(field),
            field,
            session_id: s.sessionId,
            value,
            temporality: 'delta',
            start_time: null,
            time: mid,
            // The disambiguating attribute is not decoration. Four token fields share one metric
            // name, and metric_point_dedup is (metric, session_id, time, source, md5(attrs)) — so
            // with an empty attrs object the four rows collide and three are silently dropped by
            // `on conflict do nothing`, leaving tokens_input populated and the other three null.
            // Real OTLP carries these, which is exactly why the dedup key can afford to.
            attrs: attrsFor(field, s.sessionId),
            source: 'seed',
        }));
        await sql`insert into metric_point ${sql(rows)} on conflict do nothing`;
    }

    const merged = data.prs.filter((p) => p.mergedAt !== null).length;
    const open = data.prs.filter((p) => p.state === 'open').length;
    console.log('\nseeded (SYNTHETIC — not measurements):');
    console.log(`  database        ${name}`);
    console.log(`  repo            ${repo}`);
    console.log(`  pull requests   ${data.prs.length}  (${merged} merged, ${open} open)`);
    console.log(`  ${config.baseBranch} commits`.padEnd(18) + `${data.branchCommits.length}`);
    console.log(`  sessions        ${data.sessions.length}`);
} finally {
    await sql.end();
}

/**
 * The vendor metric name a field would have arrived under.
 *
 * Stored verbatim beside the canonical field because that is what the real ingest does — the
 * mapping lives in metric-map.ts and a seeded row that carried a made-up metric name would look
 * like an unrecognised tool rather than like Claude Code.
 */
function metricFor(field: string): string {
    if (field.startsWith('tokens_')) return 'claude_code.token.usage';
    if (field.startsWith('lines_')) return 'claude_code.lines_of_code.count';
    if (field.startsWith('edits_')) return 'claude_code.code_edit_tool.decision';
    if (field === 'active_seconds') return 'claude_code.active_time.total';
    return 'claude_code.session.count';
}

/**
 * The attributes that make a datapoint distinguishable from its siblings.
 *
 * Mirrors the `enumerated(...)` rules in metric-map.ts, so a seeded row resolves back to the same
 * canonical field the live ingest would have given it. Only allowlisted keys, exactly as the
 * ingest route enforces — no identity attributes, ever.
 */
function attrsFor(field: string, sessionId: string): Record<string, string> {
    const base = { 'session.id': sessionId };
    if (field.startsWith('tokens_')) return { ...base, type: field.slice('tokens_'.length) };
    if (field.startsWith('lines_')) return { ...base, type: field.slice('lines_'.length) };
    if (field.startsWith('edits_')) return { ...base, decision: field.slice('edits_'.length) };
    return base;
}
