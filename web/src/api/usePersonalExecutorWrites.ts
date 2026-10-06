import { useCallback } from 'react';
import { executorWrite } from './orgExecutors.js';

/**
 * The personal profile's by-id writes (issue 440), split out of `useWorkspace` so that hook stays
 * the poll and the whole-list writes. A refusal is the returned message, success is null; each
 * success re-arms the workspace poll (`start`), which stops once it has seen a settled answer.
 */

/** Removes ONE personal profile by id. */
export const removeExecutorWrite = (id: string): Promise<string | null> =>
    executorWrite(`/api/workspace/executors/${id}`, 'DELETE', undefined, 'Could not remove the executor');

/** Suspends or resumes ONE personal profile by id. */
export const suspendExecutorWrite = (id: string, suspended: boolean): Promise<string | null> =>
    executorWrite(
        `/api/workspace/executors/${id}/suspension`,
        'POST',
        { suspended },
        suspended ? 'Could not suspend the executor' : 'Could not resume the executor'
    );

export function usePersonalExecutorWrites(start: () => void) {
    const rearmed = useCallback(
        async (write: Promise<string | null>): Promise<string | null> => {
            const message = await write;
            if (!message) start();
            return message;
        },
        [start]
    );
    const removeExecutor = useCallback((id: string) => rearmed(removeExecutorWrite(id)), [rearmed]);
    const suspendExecutor = useCallback(
        (id: string, suspended: boolean) => rearmed(suspendExecutorWrite(id, suspended)),
        [rearmed]
    );
    return { removeExecutor, suspendExecutor };
}
