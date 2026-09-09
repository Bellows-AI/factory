import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DEV = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const TEST = 'postgres://factory:factory@127.0.0.1:5432/factory_test';
const SEED = 'postgres://factory:factory@127.0.0.1:5432/factory_seed';

/** A syntactically valid App, so a case about the database is not also a case about credentials. */
const APP = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nnot-parsed-here\n-----END RSA PRIVATE KEY-----',
};
/** The code-only no-fetch arm, as the offline tooling injects it. */
const NONE = { mode: 'none' } as const;

describe('the database is required', () => {
    it('refuses to boot without one', () => {
        // There is no in-memory mode any more. A process that forgot its DATABASE_URL used to
        // start, serve, and lose everything on restart; now it says so before it listens.
        expect(() => loadConfig({}, NONE)).toThrow(/DATABASE_URL is required/);
    });

    it('names the two ways to fill it', () => {
        // The message has to answer "so what do I do": sync the App's installation into it, or
        // seed a disposable one with synthetic rows.
        expect(() => loadConfig({}, NONE)).toThrow(/npm run seed/);
    });

    it('boots with a database and no credential, serving what is already stored', () => {
        // The offline tooling runs this way: no credentials, no network, and whatever is in the
        // database still renders.
        expect(() => loadConfig({ DATABASE_URL: DEV }, NONE)).not.toThrow();
    });
});

describe('a fetching process refuses a disposable database', () => {
    /*
     * The pairing that has to stay impossible. A disposable database is one `npm run test:db`
     * truncates and `npm run seed` fills with invented pull requests — so real fetched history put
     * there is either destroyed on the next test run or interleaved with synthetic rows that no
     * later query can separate. Both failures are silent.
     */
    // Every env-booted process fetches now — the App is the only configuration — so the guard is
    // simply refused; the code-only none arm is what the offline tooling injects to say it does
    // not fetch.
    it('throws against a fetching configuration', () => {
        expect(() => loadConfig({ DATABASE_URL: TEST, ...APP })).toThrow(/factory_test/);
        expect(() => loadConfig({ DATABASE_URL: SEED, ...APP })).toThrow(/factory_seed/);
    });

    it('names the remedy, which is a differently named database', () => {
        expect(() => loadConfig({ DATABASE_URL: TEST, ...APP })).toThrow(/_test\/_seed\/_synthetic\/_demo\/_e2e/);
    });

    it('allows it when the process does not fetch, because then nothing is lost', () => {
        // This is exactly how verify:ui and `npm run seed` run: the none arm injected in code.
        expect(() => loadConfig({ DATABASE_URL: TEST }, NONE)).not.toThrow();
        expect(() => loadConfig({ DATABASE_URL: SEED }, NONE)).not.toThrow();
    });

    it('leaves a real database alone', () => {
        expect(() => loadConfig({ DATABASE_URL: DEV, ...APP })).not.toThrow();
    });
});

describe('removed settings are fatal, not ignored', () => {
    it('refuses DATA_SOURCE', () => {
        // It used to decide what the whole page was made of, so an ignored one would boot a
        // dashboard showing something other than what its operator believes.
        expect(() => loadConfig({ DATABASE_URL: DEV, DATA_SOURCE: 'fixture' }, NONE)).toThrow(
            /DATA_SOURCE is no longer supported/,
        );
        expect(() => loadConfig({ DATABASE_URL: DEV, DATA_SOURCE: 'github' }, NONE)).toThrow(
            /DATA_SOURCE is no longer supported/,
        );
    });

    it('refuses CACHE_TTL_SECONDS', () => {
        // A deployment that had raised it to protect its quota would otherwise silently drop to
        // the 60s-per-repo sync floor.
        expect(() => loadConfig({ DATABASE_URL: DEV, CACHE_TTL_SECONDS: '1800' }, NONE)).toThrow(
            /CACHE_TTL_SECONDS is no longer supported/,
        );
    });
});

describe('the sync TTL floor', () => {
    it('defaults to one repo\'s worth, which is all this validator can check', () => {
        // It used to be MIN_SYNC_TTL_SECONDS_PER_REPO × the configured repo count. There is no
        // configured repo count any more — the App installation reports it — so the per-repo floor
        // moved to the stats service, which is the only thing that knows the number. See
        // stats.sync-ttl.test.ts.
        expect(loadConfig({ DATABASE_URL: DEV }, NONE).syncTtlMs).toBe(60_000);
    });

    it('rejects a value under the floor, so the cheap path stays cheap', () => {
        expect(() => loadConfig({ DATABASE_URL: DEV, SYNC_TTL_SECONDS: '30' }, NONE)).toThrow(/at least 60/);
    });

    it('is the only cache floor there is', () => {
        // The 300s-per-repo full-walk floor is gone with the full-walk-every-refresh behaviour it
        // protected. A full reconciliation is now gated on its own 24h schedule and on the
        // provider's reported remaining budget, which is strictly stronger than a clock.
        const config = loadConfig({ DATABASE_URL: DEV, SYNC_TTL_SECONDS: '900' }, NONE);
        expect(config.syncTtlMs).toBe(900_000);
        expect('cacheTtlMs' in config).toBe(false);
    });
});
