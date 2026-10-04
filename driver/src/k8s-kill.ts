/**
 * What a Stop (`kill`) leaves for the polls it interrupts. Deleting a Job makes the very next
 * status read answer 404 — indistinguishable from a Job fenced away by hand unless the driver
 * remembers it did the deleting — and a helper's aux Job belongs to no pod the runner's own
 * delete reaches. Both are in-process facts of one driver, so they live in module state.
 */

/** The exit code a killed run resolves with — the SIGKILL status docker's killed container answers. */
export const KILLED_EXIT_CODE = 137;

/** Thrown by a poll whose Job vanished because this driver killed it. */
export class RunnerKilled extends Error {
    constructor(jobName: string) {
        super(`the runner job ${jobName} was killed`);
    }
}

const killedRunners = new Set<string>();
const helperJobs = new Map<string, Set<string>>();

/** The error for a runner Job that read 404: this driver's own kill, or one fenced away by hand. */
export function vanishedRunner(name: string): Error {
    return killedRunners.has(name) ? new RunnerKilled(name) : new Error(`the runner job ${name} no longer exists`);
}

/** Records that `kill` deleted the runner Job `name`; the poll's 404 that follows is its own doing. */
export function markKilled(name: string): void {
    killedRunners.add(name);
}

/** Forgets a kill on the runner Job `name` — a fresh run of the same job starts with a clean slate. */
export function clearKilled(name: string): void {
    killedRunners.delete(name);
}

/** Registers a helper aux Job under its owning job so `kill` can delete it; returns the unregister. */
export function trackHelperJob(ownerJobId: string, name: string): () => void {
    const names = helperJobs.get(ownerJobId) ?? new Set<string>();
    names.add(name);
    helperJobs.set(ownerJobId, names);
    return () => {
        names.delete(name);
        if (names.size === 0 && helperJobs.get(ownerJobId) === names) helperJobs.delete(ownerJobId);
    };
}

/** The helper aux Jobs currently running for `ownerJobId`. */
export function helperJobsOf(ownerJobId: string): string[] {
    return [...(helperJobs.get(ownerJobId) ?? [])];
}
