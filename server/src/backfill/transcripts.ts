import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { CLAUDE_CODE } from '@factory-ai/core';

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
/** How far up from `cwd` to look for a `.git` directory before giving up. */
const MAX_WALK_UP_DEPTH = 8;

function repoSlug(cwd: string, cache: Map<string, string | null>): string | null {
    if (cache.has(cwd)) return cache.get(cwd) ?? null;
    let dir = cwd;
    let slug: string | null = null;
    for (let i = 0; i < MAX_WALK_UP_DEPTH && dir !== '/' && dir !== '.'; i += 1) {
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

interface DataPoint {
    session_id: string;
    field: string;
    value: number;
    time: Date;
    attrs: Record<string, string>;
}

/** The accumulators every transcript line folds into. */
interface BackfillState {
    points: DataPoint[];
    // Keyed by session+repo+branch so a session that checks out three branches yields three
    // spans, exactly as the live hook would report them.
    spans: Map<string, BranchSpan>;
    sessions: Set<string>;
    slugCache: Map<string, string | null>;
    unresolved: Set<string>;
}

/** The branch/repo span a record's `cwd` belongs to — recorded, or its unresolved cwd noted. */
function recordBranchSpan(record: Record_, sessionId: string, at: string, state: BackfillState): void {
    if (!record.cwd) return;
    const repo = repoSlug(record.cwd, state.slugCache);
    if (repo === null) {
        state.unresolved.add(record.cwd);
        return;
    }
    // The literal 'HEAD' is not a branch name and would join to nothing while looking like one.
    const branch = record.gitBranch && record.gitBranch !== 'HEAD' ? record.gitBranch : null;
    const key = `${sessionId}\u0000${repo}\u0000${branch ?? ''}`;
    const span = state.spans.get(key);
    if (!span) {
        state.spans.set(key, { repo, branch, first: at, last: at, samples: 1 });
        return;
    }
    if (at < span.first) span.first = at;
    if (at > span.last) span.last = at;
    span.samples += 1;
}

/** The usage datapoints an assistant message's record carries, one per supported field. */
function collectUsagePoints(record: Record_, sessionId: string, at: string, points: DataPoint[]): void {
    const usage = record.message?.usage;
    if (record.type !== 'assistant' || !usage) return;
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

/** One transcript line: a truncated or unparseable one is skipped, not fatal. */
function processLine(line: string, state: BackfillState): void {
    if (!line) return;
    let record: Record_;
    try {
        record = JSON.parse(line) as Record_;
    } catch {
        // A truncated final line is normal in an in-progress transcript.
        return;
    }

    const sessionId = record.sessionId;
    if (!sessionId) return;
    const at = record.timestamp;
    if (!at) return;

    state.sessions.add(sessionId);
    recordBranchSpan(record, sessionId, at, state);
    collectUsagePoints(record, sessionId, at, state.points);
}

/** One transcript file: an unreadable one is skipped, not fatal. */
function processFile(file: string, state: BackfillState): void {
    let lines: string[];
    try {
        lines = readFileSync(file, 'utf8').split('\n');
    } catch {
        return;
    }
    for (const line of lines) processLine(line, state);
}

/** Chunked because a single insert of ~100k rows exceeds the parameter limit. */
const INSERT_CHUNK = 2000;

async function insertDatapoints(sql: Sql, points: DataPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += INSERT_CHUNK) {
        const batch = points.slice(i, i + INSERT_CHUNK).map((p) => ({
            agent: CLAUDE_CODE,
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
}

async function insertBranchSpans(sql: Sql, orgId: string, spans: Map<string, BranchSpan>): Promise<void> {
    for (const [key, span] of spans) {
        const sessionId = key.split('\u0000')[0] as string;
        await sql`
            insert into session_branch (org_id, agent, session_id, repo, branch, head_sha, first_seen, last_seen, samples)
            values (${orgId}, ${CLAUDE_CODE}, ${sessionId}, ${span.repo}, ${span.branch}, null,
                    ${new Date(span.first)}, ${new Date(span.last)}, ${span.samples})
            on conflict (org_id, agent, session_id, repo, branch) do update
                set first_seen = least(session_branch.first_seen, excluded.first_seen),
                    last_seen  = greatest(session_branch.last_seen, excluded.last_seen),
                    samples    = greatest(session_branch.samples, excluded.samples)
        `;
    }
}

export async function backfillTranscripts(
    sql: Sql,
    options: { orgId: string; root?: string; log?: (message: string) => void }
): Promise<BackfillSummary> {
    const { orgId, root = TRANSCRIPTS, log = () => {} } = options;
    const files = transcriptFiles(root);

    const state: BackfillState = {
        points: [],
        spans: new Map(),
        sessions: new Set(),
        slugCache: new Map(),
        unresolved: new Set(),
    };

    for (const file of files) processFile(file, state);

    log(`${files.length} transcripts, ${state.sessions.size} sessions, ${state.points.length} datapoints`);

    await insertDatapoints(sql, state.points);
    await insertBranchSpans(sql, orgId, state.spans);

    return {
        files: files.length,
        sessions: state.sessions.size,
        datapoints: state.points.length,
        branchSpans: state.spans.size,
        unresolvedCwds: [...state.unresolved].sort(),
    };
}
