import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';

/**
 * Imports history from Claude Code session transcripts.
 *
 * Transcripts (`~/.claude/projects/<slug>/<uuid>.jsonl`) carry more than the OTEL export:
 * `gitBranch` on every record, and token usage per assistant message. So this is a way to get
 * history from before the collector existed.
 *
 * What transcripts do NOT have: edit accept/reject decisions and active time. Those are
 * OTEL-only, which is why `session_source` prefers 'otel' when both cover a session.
 *
 * Idempotent: rows are written with `source = 'transcript'` and the dedup index makes a
 * re-run a no-op.
 */

const TRANSCRIPTS = join(homedir(), '.claude', 'projects');

interface Record_ {
    type?: string;
    sessionId?: string;
    timestamp?: string;
    cwd?: string;
    gitBranch?: string;
    message?: {
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };
}

/** Datapoint fields a transcript can support. No cost, no edit decisions, no active time. */
const USAGE_FIELDS: [keyof NonNullable<NonNullable<Record_['message']>['usage']>, string][] = [
    ['input_tokens', 'tokens_input'],
    ['output_tokens', 'tokens_output'],
    ['cache_read_input_tokens', 'tokens_cacheRead'],
    ['cache_creation_input_tokens', 'tokens_cacheCreation'],
];

export interface BackfillSummary {
    files: number;
    sessions: number;
    datapoints: number;
    branchSpans: number;
    unresolvedCwds: string[];
}

function transcriptFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const project of readdirSync(root)) {
        const dir = join(root, project);
        try {
            if (!statSync(dir).isDirectory()) continue;
            for (const file of readdirSync(dir)) {
                if (file.endsWith('.jsonl')) out.push(join(dir, file));
            }
        } catch {
            // A project directory we cannot read is skipped, not fatal.
        }
    }
    return out.sort();
}

/**
 * `cwd` is an absolute path; the attribution join needs "owner/name". Resolved by walking up
 * to the worktree and asking git, so it only works for checkouts still on disk — a deleted
 * one yields null, and its sessions surface as `sessionsWithoutHook` rather than being
 * silently mis-attributed.
 */
function repoSlug(cwd: string, cache: Map<string, string | null>): string | null {
    if (cache.has(cwd)) return cache.get(cwd) ?? null;
    let dir = cwd;
    let slug: string | null = null;
    for (let i = 0; i < 8 && dir !== '/' && dir !== '.'; i += 1) {
        if (existsSync(join(dir, '.git'))) {
            try {
                const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
                    cwd: dir,
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                }).trim();
                slug = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
            } catch {
                slug = null;
            }
            break;
        }
        dir = join(dir, '..');
    }
    cache.set(cwd, slug);
    return slug;
}

interface BranchSpan {
    repo: string;
    branch: string | null;
    first: string;
    last: string;
    samples: number;
}

export async function backfillTranscripts(
    sql: Sql,
    options: { orgId: string; root?: string; log?: (message: string) => void }
): Promise<BackfillSummary> {
    const { orgId, root = TRANSCRIPTS, log = () => {} } = options;
    const files = transcriptFiles(root);

    const points: {
        session_id: string;
        field: string;
        value: number;
        time: Date;
        attrs: Record<string, string>;
    }[] = [];
    // Keyed by session+repo+branch so a session that checks out three branches yields three
    // spans, exactly as the live hook would report them.
    const spans = new Map<string, BranchSpan>();
    const sessions = new Set<string>();
    const slugCache = new Map<string, string | null>();
    const unresolved = new Set<string>();

    for (const file of files) {
        let lines: string[];
        try {
            lines = readFileSync(file, 'utf8').split('\n');
        } catch {
            continue;
        }

        for (const line of lines) {
            if (!line) continue;
            let record: Record_;
            try {
                record = JSON.parse(line) as Record_;
            } catch {
                // A truncated final line is normal in an in-progress transcript.
                continue;
            }

            const sessionId = record.sessionId;
            if (!sessionId) continue;

            const at = record.timestamp;
            if (!at) continue;
            sessions.add(sessionId);

            if (record.cwd) {
                const repo = repoSlug(record.cwd, slugCache);
                if (repo === null) {
                    unresolved.add(record.cwd);
                } else {
                    // The literal 'HEAD' is not a branch name and would join to nothing while
                    // looking like one.
                    const branch = record.gitBranch && record.gitBranch !== 'HEAD' ? record.gitBranch : null;
                    const key = `${sessionId}\u0000${repo}\u0000${branch ?? ''}`;
                    const span = spans.get(key);
                    if (!span) {
                        spans.set(key, { repo, branch, first: at, last: at, samples: 1 });
                    } else {
                        if (at < span.first) span.first = at;
                        if (at > span.last) span.last = at;
                        span.samples += 1;
                    }
                }
            }

            const usage = record.message?.usage;
            if (record.type !== 'assistant' || !usage) continue;
            for (const [key, field] of USAGE_FIELDS) {
                const value = usage[key];
                if (typeof value !== 'number' || value === 0) continue;
                points.push({
                    session_id: sessionId,
                    field,
                    value,
                    time: new Date(at),
                    // `type` mirrors the OTEL attribute, so both sources aggregate identically.
                    attrs: { 'session.id': sessionId, type: field.replace('tokens_', '') },
                });
            }
        }
    }

    log(`${files.length} transcripts, ${sessions.size} sessions, ${points.length} datapoints`);

    // Chunked because a single insert of ~100k rows exceeds the parameter limit.
    const CHUNK = 2000;
    for (let i = 0; i < points.length; i += CHUNK) {
        const batch = points.slice(i, i + CHUNK).map((p) => ({
            agent: 'claude-code',
            metric: 'claude_code.token.usage',
            field: p.field,
            session_id: p.session_id,
            value: p.value,
            // Each assistant message reports its own request's usage, so these are increments.
            temporality: 'delta',
            start_time: null,
            time: p.time,
            attrs: p.attrs,
            source: 'transcript',
        }));
        await sql`insert into metric_point ${sql(batch)} on conflict do nothing`;
    }

    for (const [key, span] of spans) {
        const sessionId = key.split('\u0000')[0] as string;
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
            values (${orgId}, 'claude-code', ${sessionId}, ${span.repo}, ${span.branch}, null,
                    ${new Date(span.first)}, ${new Date(span.last)}, ${span.samples})
            on conflict (org_id, agent, session_id, repo, branch) do update
                set first_seen = least(session_branch.first_seen, excluded.first_seen),
                    last_seen  = greatest(session_branch.last_seen, excluded.last_seen),
                    samples    = greatest(session_branch.samples, excluded.samples)
        `;
    }

    return {
        files: files.length,
        sessions: sessions.size,
        datapoints: points.length,
        branchSpans: spans.size,
        unresolvedCwds: [...unresolved].sort(),
    };
}
