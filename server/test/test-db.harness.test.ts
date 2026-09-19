import { describe, expect, it } from 'vitest';
import { assertTestDatabase } from '../test-db/harness.js';

describe('assertTestDatabase', () => {
    it('accepts a database whose name marks it disposable', () => {
        expect(() => assertTestDatabase('postgres://factory:factory@127.0.0.1:5432/factory_test')).not.toThrow();
    });

    it('refuses a database whose name is not marked disposable, naming it', () => {
        expect(() => assertTestDatabase('postgres://factory:factory@127.0.0.1:5432/factory_dev')).toThrow(
            /factory_dev/
        );
    });
});
