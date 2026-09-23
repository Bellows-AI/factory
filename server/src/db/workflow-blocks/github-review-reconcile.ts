/**
 * The `builtin/github-review-reconcile` block: fetches a PR's open review threads, applies fixes,
 * and replies per thread. Not yet implemented — `available: false` until its own issue lands,
 * which edits only this file (the registry, the compiler and every other block stay untouched).
 */
import type { BlockDescriptor } from './types.js';

export const GITHUB_REVIEW_RECONCILE: BlockDescriptor = {
    id: 'builtin/github-review-reconcile',
    description:
        "Reconciles a pull request's open review threads: fetches line comments, applies fixes, and replies per thread.",
    configSchema: [
        {
            name: 'maxRounds',
            type: 'number',
            description: 'Maximum reconciliation rounds before resting the thread.',
            default: 3,
            min: 1,
            max: 10,
        },
    ],
    available: false,
    expand() {
        throw new Error(
            'builtin/github-review-reconcile is not yet implemented — available is false, so compileDefinition must refuse BLOCK_UNAVAILABLE before this is ever called'
        );
    },
};
