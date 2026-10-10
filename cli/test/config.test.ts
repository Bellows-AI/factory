import { describe, expect, it } from 'vitest';
import { loadCliConfig } from '../src/config.js';

describe('loadCliConfig', () => {
    it('reads FACTORY_URL and FACTORY_TOKEN, stripping a trailing slash', () => {
        const config = loadCliConfig({ FACTORY_URL: 'http://board:8080/', FACTORY_TOKEN: ' fat_abc ' });
        expect(config.url).toBe('http://board:8080');
        expect(config.token).toBe('fat_abc');
    });

    it('refuses a missing or blank FACTORY_URL, naming the variable', () => {
        expect(() => loadCliConfig({})).toThrow(/FACTORY_URL/);
        expect(() => loadCliConfig({ FACTORY_URL: '   ' })).toThrow(/FACTORY_URL/);
    });

    it('refuses a FACTORY_URL that is not an http(s) URL', () => {
        // `new URL('dashboard:8080')` parses with 'dashboard:' as the scheme; the protocol is
        // checked, not just the parse, or every call would 404 against a value that reads well.
        expect(() => loadCliConfig({ FACTORY_URL: 'dashboard:8080' })).toThrow(/FACTORY_URL/);
    });

    it('defaults the request deadline and read retries, and reads both overrides', () => {
        const defaults = loadCliConfig({ FACTORY_URL: 'http://board' });
        expect(defaults).toMatchObject({ requestTimeoutMs: 30_000, readRetries: 3 });

        const tuned = loadCliConfig({
            FACTORY_URL: 'http://board',
            FACTORY_REQUEST_TIMEOUT_S: '5',
            FACTORY_READ_RETRIES: '0',
        });
        expect(tuned).toMatchObject({ requestTimeoutMs: 5_000, readRetries: 0 });
    });

    it.each([
        ['FACTORY_REQUEST_TIMEOUT_S', '0'],
        ['FACTORY_REQUEST_TIMEOUT_S', 'soon'],
        ['FACTORY_READ_RETRIES', '-1'],
        ['FACTORY_READ_RETRIES', '1.5'],
        ['FACTORY_READ_RETRIES', '99'],
    ])('refuses %s=%s, naming the variable', (name, value) => {
        expect(() => loadCliConfig({ FACTORY_URL: 'http://board', [name]: value })).toThrow(name);
    });

    it('reads a blank FACTORY_TOKEN as empty and trims a real one', () => {
        // A blank token is "no credential", the AUTH_MODE=none case — never an empty Bearer.
        expect(loadCliConfig({ FACTORY_URL: 'http://board' }).token).toBe('');
        expect(loadCliConfig({ FACTORY_URL: 'http://board', FACTORY_TOKEN: '' }).token).toBe('');
    });
});
