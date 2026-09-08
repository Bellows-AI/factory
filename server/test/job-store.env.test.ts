import { describe, expect, it } from 'vitest';
import { withMintedToken } from '../src/db/job-store.js';

/**
 * The merge rule that puts the minted installation token on a claim's environment, pinned offline
 * for the same reason `stackEnv` is: a rule this load-bearing must not live only where a database
 * is. The mint is the BASE LAYER, below every configured scope — a `GITHUB_TOKEN` an operator
 * deliberately configured in org, workspace or repo wins, and the mint fills only the gap. See
 * docs/env.md, "Core secrets" and GitHub authentication.
 */
describe('withMintedToken', () => {
    it('lets a configured GITHUB_TOKEN beat the mint, in any scope', () => {
        expect(withMintedToken('ghs_minted', { GITHUB_TOKEN: 'operator-pat', X: 'y' })).toEqual({
            GITHUB_TOKEN: 'operator-pat',
            X: 'y',
        });
    });

    it('mints GITHUB_TOKEN when no scope configured one', () => {
        expect(withMintedToken('ghs_minted', { X: 'y' })).toEqual({ GITHUB_TOKEN: 'ghs_minted', X: 'y' });
    });

    it('mints with no resolver at all', () => {
        expect(withMintedToken('ghs_minted', undefined)).toEqual({ GITHUB_TOKEN: 'ghs_minted' });
    });

    it('carries no environment when there is neither a mint nor a resolver', () => {
        expect(withMintedToken(undefined, undefined)).toBeUndefined();
    });

    it('leaves the resolved environment untouched when there is no mint', () => {
        expect(withMintedToken(undefined, { X: 'y' })).toEqual({ X: 'y' });
    });
});
