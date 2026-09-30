import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The schema guards that used to live as a comment header copied into every migration (#371).
 * A header asks; this asserts — and `npm run test:db` is not in CI, so an offline suite is the
 * only place a stray `create extension` is caught before it reaches a managed PostgreSQL that
 * has none installed.
 */
const DIR = fileURLToPath(new URL('../../server/migrations/', import.meta.url));
const names = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');

describe('migrations', () => {
    it('reads the real directory, so an empty sweep cannot pass for a clean one', () => {
        expect(names.length).toBeGreaterThan(40);
        expect(names).toContain('001_init.sql');
    });

    it('names no TimescaleDB object anywhere in the schema', () => {
        for (const name of names) {
            expect(read(name), name).not.toMatch(/timescaledb/i);
            expect(read(name), name).not.toMatch(/create_hypertable|time_bucket/);
        }
    });

    it('creates no extension, so the chart runs on RDS, Aurora or any managed PostgreSQL', () => {
        // Comment lines are stripped rather than the match being line-anchored: 005 and 006
        // explain in prose why there is no extension, and an anchor would also miss a real
        // `…; create extension pgcrypto;` sharing a line with the statement before it.
        for (const name of names) {
            const code = read(name)
                .split('\n')
                .filter((line) => !line.trimStart().startsWith('--'))
                .join('\n');
            expect(code, name).not.toMatch(/create\s+extension/i);
        }
    });

    it('range-partitions metric_point on time, covered by a DEFAULT partition', () => {
        const init = read('001_init.sql');
        expect(init).toMatch(/partition by range \(time\)/);
        // Without a covering partition a range-partitioned table rejects every insert — a
        // failure mode the hypertable did not have.
        expect(init).toMatch(/partition of metric_point default/);
    });
});
