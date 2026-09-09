import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const env = (extra: NodeJS.ProcessEnv = {}) => (
    {
        DATABASE_URL: DB,
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nshape-checked-only\n-----END RSA PRIVATE KEY-----',
        ...extra,
    }
);

describe('the workspace root', () => {
    it('is null unless one is configured', () => {
        // Off by default rather than defaulting to a path under $HOME: a default would make an
        // upgrade start cloning gigabytes for an operator who changed nothing, and would turn a
        // no-network boot into a network boot.
        expect(loadConfig(env()).workspaceRoot).toBeNull();
    });

    it('treats an empty value as unset, consistent with every other empty value', () => {
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '' })).workspaceRoot).toBeNull();
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '   ' })).workspaceRoot).toBeNull();
    });

    it('expands ~ against the environment it was handed, not the real home directory', () => {
        // loadConfig has to stay a pure function of its argument; os.homedir() would read the
        // environment behind the validator's back and the case would pass on one machine only.
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '~/work', HOME: '/home/ada' })).workspaceRoot).toBe(
            '/home/ada/work',
        );
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '~', HOME: '/home/ada' })).workspaceRoot).toBe('/home/ada');
    });

    it('refuses ~ when there is no HOME to expand it against', () => {
        expect(() => loadConfig(env({ ORG_WORKSPACE_ROOT: '~/work' }))).toThrow(/HOME is not set/);
    });

    it('rejects a relative path rather than resolving it', () => {
        // `npm run dev -w server` has cwd server/ and the container has /app, so one relative root
        // would mean two different trees on a single machine.
        for (const path of ['work', './work', '../work']) {
            expect(() => loadConfig(env({ ORG_WORKSPACE_ROOT: path })), path).toThrow(/must be an absolute path/);
        }
    });

    it('keeps an absolute path as given', () => {
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '/srv/factory' })).workspaceRoot).toBe('/srv/factory');
    });

    it('no longer validates repo names, because it no longer knows any', () => {
        /*
         * `checkWorkspaceNames` used to live here and refuse `-x`, `.`, `..` and two owners' repos
         * that share one checkout directory. It could, because the list was ORG_REPOS and the
         * operator had typed it. Neither is true now: the list comes from the GitHub App
         * installation, and a name this validator dislikes is one nobody here can rename.
         *
         * The rules did not go away — they moved to where the name is actually turned into a
         * directory, which is PUT /api/workspace/repos and the `user_repo` check constraint behind
         * it. See routes.workspace.test.ts. There the answer is a 400 naming the repo, rather than
         * a deployment that will not boot.
         */
        expect(() => loadConfig(env({ ORG_WORKSPACE_ROOT: '/srv/factory' }))).not.toThrow();
    });
});
