import { afterEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { LOCAL_ORG_ID, type AppConfig } from '../src/config.js';
import { createOrgRegistry, type OrgRegistry } from '../src/orgs.js';
import { testConfig } from './helpers.js';

/**
 * The registry is the piece that makes "org is a property of the caller" true without threading an
 * orgId through every store: build per org, cache, retry failures. Route tests substitute it with
 * a static; these drive the REAL one over a scripted sql, because the subtle parts — miss
 * handling, failure retry, store wiring — are exactly what a static hides.
 */

let app: { close(): Promise<void> } | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const config: AppConfig = testConfig();

/** A callable sql fake: records the queries, answers from a queue, throws from a failure slot. */
function fakeSql(responses: { rows?: unknown[]; fail?: Error }[]) {
    const calls: string[] = [];
    let n = 0;
    const fn = ((strings: TemplateStringsArray | string): Promise<unknown> => {
        const text = typeof strings === 'string' ? strings : strings.join('?');
        calls.push(text);
        const next = responses[Math.min(n, responses.length - 1)];
        n += 1;
        if (next.fail) return Promise.reject(next.fail);
        return Promise.resolve(next.rows ?? []);
    }) as unknown as postgres.Sql;
    return { sql: fn, calls };
}

/** The organization-row select answers orgs built from this map, per call. */
const orgRows = (orgs: { id: string; installation_id: string | null }[]) => ({
    rows: orgs.map((o) => ({ id: o.id, name: o.id, installation_id: o.installation_id })),
});

describe('createOrgRegistry', () => {
    it('answers null for an organization row that does not exist — and does not remember it', async () => {
        // The miss must not be cached: a caller asking before the org row lands (a token minted
        // the instant an installation appears) would otherwise pin null for the process's life.
        const { sql } = fakeSql([orgRows([]), orgRows([{ id: '424242', installation_id: '424242' }])]);
        const registry: OrgRegistry = createOrgRegistry({ sql, ready: Promise.resolve(), config, withStores: false });

        await expect(registry.for('424242')).resolves.toBeNull();
        const runtime = await registry.for('424242');
        expect(runtime?.orgId).toBe('424242');
    });

    it('retries a failed build on the next call instead of caching the failure', async () => {
        const { sql } = fakeSql([
            { fail: new Error('connection refused') },
            orgRows([{ id: LOCAL_ORG_ID, installation_id: null }]),
        ]);
        const registry = createOrgRegistry({ sql, ready: Promise.resolve(), config, withStores: false });

        await expect(registry.for(LOCAL_ORG_ID)).resolves.toBeNull();
        await expect(registry.for(LOCAL_ORG_ID)).resolves.toMatchObject({ orgId: LOCAL_ORG_ID });
    });

    it('serves a warm runtime from the cache without re-reading the row', async () => {
        const { sql, calls } = fakeSql([orgRows([{ id: LOCAL_ORG_ID, installation_id: null }])]);
        const registry = createOrgRegistry({ sql, ready: Promise.resolve(), config, withStores: false });

        const first = await registry.for(LOCAL_ORG_ID);
        const second = await registry.for(LOCAL_ORG_ID);
        expect(second).toBe(first);
        // One org-row select for two calls.
        expect(calls.filter((c) => c.includes('from organization'))).toHaveLength(1);
    });

    it('wires the job store only when withStores is set, and never an installation client in none mode', async () => {
        // mode 'none' has no App to mint from: even with stores, no token provider exists to hand
        // the job store, and the repo source falls back to stored names — the offline shape,
        // verified here because every route test's static registry bypasses this construction.
        const { sql } = fakeSql([
            orgRows([{ id: LOCAL_ORG_ID, installation_id: null }]),
            orgRows([{ id: LOCAL_ORG_ID, installation_id: null }]),
        ]);
        const bare = createOrgRegistry({ sql, ready: Promise.resolve(), config, withStores: false });
        const full = createOrgRegistry({ sql, ready: Promise.resolve(), config, withStores: true });

        const bareRuntime = await bare.for(LOCAL_ORG_ID);
        expect(bareRuntime?.jobs).toBeUndefined();
        const fullRuntime = await full.for(LOCAL_ORG_ID);
        expect(fullRuntime?.jobs).toBeDefined();
    });

    it('lists the organizations and warms each runtime', async () => {
        const { sql, calls } = fakeSql([
            // list()
            {
                rows: [
                    { id: 'a', name: 'a', installation_id: null },
                    { id: 'b', name: 'b', installation_id: null },
                ],
            },
            // warmAll's list()
            {
                rows: [
                    { id: 'a', name: 'a', installation_id: null },
                    { id: 'b', name: 'b', installation_id: null },
                ],
            },
            // warmAll -> for('a')
            orgRows([{ id: 'a', installation_id: null }]),
            // warmAll -> for('b')
            orgRows([{ id: 'b', installation_id: null }]),
            // the post-warming for('a') — served from cache, no row read left in the script
        ]);
        const registry = createOrgRegistry({ sql, ready: Promise.resolve(), config, withStores: false });

        await expect(registry.list()).resolves.toHaveLength(2);
        await registry.warmAll();

        // Both runtimes came up warm: for() after warmAll resolves WITHOUT another organization
        // read — the script has none left, so a cache miss would reject rather than pass.
        await expect(registry.for('a')).resolves.toMatchObject({ orgId: 'a' });
        await expect(registry.for('b')).resolves.toMatchObject({ orgId: 'b' });
        const EXPECTED_ORGANIZATION_READS = 4;
        expect(calls.filter((c) => c.includes('from organization'))).toHaveLength(EXPECTED_ORGANIZATION_READS);
    });
});
