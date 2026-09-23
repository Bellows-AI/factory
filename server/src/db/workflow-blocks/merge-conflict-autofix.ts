/**
 * The `builtin/merge-conflict-autofix` block: resolves merge conflicts against the default branch
 * before publish. Not yet implemented — `available: false` until its own issue lands, which edits
 * only this file (the registry, the compiler and every other block stay untouched).
 */
import type { BlockDescriptor } from './types.js';

export const MERGE_CONFLICT_AUTOFIX: BlockDescriptor = {
    id: 'builtin/merge-conflict-autofix',
    description: "Resolves the branch's merge conflicts against the default branch before publish.",
    configSchema: [
        {
            name: 'maxAttempts',
            type: 'number',
            description: 'Maximum conflict-resolution attempts before resting the thread.',
            default: 2,
            min: 1,
            max: 5,
        },
    ],
    available: false,
    expand() {
        throw new Error(
            'builtin/merge-conflict-autofix is not yet implemented — available is false, so compileDefinition must refuse BLOCK_UNAVAILABLE before this is ever called'
        );
    },
};
