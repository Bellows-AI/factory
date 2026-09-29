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

    it('reads a blank FACTORY_TOKEN as empty and trims a real one', () => {
        // A blank token is "no credential", the AUTH_MODE=none case — never an empty Bearer.
        expect(loadCliConfig({ FACTORY_URL: 'http://board' }).token).toBe('');
        expect(loadCliConfig({ FACTORY_URL: 'http://board', FACTORY_TOKEN: '' }).token).toBe('');
    });
});
