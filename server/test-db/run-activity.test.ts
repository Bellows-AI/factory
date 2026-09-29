import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createPostgresTelemetryClient } from '../src/telemetry/postgres-client.js';
import { useTestDb } from './harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;

const ORG = 'test-org';

const db = useTestDb({ max: 2 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
});

const T = (iso: string) => new Date(iso);

async function point(row: {
    session: string;
    field: string;
    value: number;
    time: string;
    temporality?: string;
    startTime?: string;
    attrs?: Record<string, string>;
}) {
    await sql`insert into metric_point ${sql({
        agent: 'claude-code',
        metric: 'claude_code.token.usage',
        field: row.field,
        session_id: row.session,
        value: row.value,
        temporality: row.temporality ?? 'delta',
        start_time: row.startTime ? T(row.startTime) : null,
        time: T(row.time),
        attrs: row.attrs ?? {},
    })}`;
}

describe.skipIf(!enabled)('runActivity — the per-run telemetry read (issue #339)', () => {
    const FROM = '2026-09-22T10:00:00.000Z';
    const TO = '2026-09-22T10:45:00.000Z';
    const FIFTEEN_MIN = 900_000;

    it('buckets one session’s points over the run window, and nothing else’s', async () => {
        // Minted per test: a shared factory_test database must never let one run's session id
        // collide with another's rows.
        const sessionId = randomUUID();
        const otherSession = randomUUID();
        await point({ session: sessionId, field: 'tokens_input', value: 2_000_000, time: '2026-09-22T10:05:00Z' });
        await point({ session: sessionId, field: 'tokens_output', value: 500_000, time: '2026-09-22T10:07:00Z' });
        await point({ session: sessionId, field: 'edits_accept', value: 3, time: '2026-09-22T10:20:00Z' });
        // A cumulative series rides the same window and must be differenced, not summed.
        await point({
            session: sessionId,
            field: 'tokens_cacheRead',
            value: 100,
            time: '2026-09-22T10:06:00Z',
            temporality: 'cumulative',
            startTime: FROM,
        });
        await point({
            session: sessionId,
            field: 'tokens_cacheRead',
            value: 160,
            time: '2026-09-22T10:21:00Z',
            temporality: 'cumulative',
            startTime: FROM,
        });
        // Another session's points and points outside the window both stay out.
        await point({ session: otherSession, field: 'tokens_input', value: 9_000_000, time: '2026-09-22T10:05:00Z' });
        await point({ session: sessionId, field: 'tokens_input', value: 7_000_000, time: '2026-09-22T09:55:00Z' });

        const buckets = await createPostgresTelemetryClient({ sql, orgId: ORG }).runActivity({
            sessionId,
            from: FROM,
            to: TO,
            bucketMs: FIFTEEN_MIN,
        });

        expect(buckets).toHaveLength(3);
        expect(buckets[0]).toEqual({
            start: FROM,
            tokens: 2_500_000 + 100,
            edits: 0,
        });
        expect(buckets[1]).toEqual({ start: '2026-09-22T10:15:00.000Z', tokens: 60, edits: 3 });
        expect(buckets[2]).toEqual({ start: '2026-09-22T10:30:00.000Z', tokens: 0, edits: 0 });
    });

    it('answers empty for a session the pipeline holds nothing about', async () => {
        const buckets = await createPostgresTelemetryClient({ sql, orgId: ORG }).runActivity({
            sessionId: randomUUID(),
            from: FROM,
            to: TO,
            bucketMs: FIFTEEN_MIN,
        });
        expect(buckets).toEqual([]);
    });
});
