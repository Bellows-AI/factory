/**
 * A task's execution mode (issue #543), stored on every job row. An omitted `workflow` on task
 * creation is OBJECTIVE mode — an ordinary claimable job with no workflow snapshot, node,
 * successor or wait; a named workflow is WORKFLOW mode. The root decides; follow-ups, retries and
 * successors inherit it.
 */
export const OBJECTIVE_MODE = 'objective';
export const WORKFLOW_MODE = 'workflow';

export const JOB_MODES = [OBJECTIVE_MODE, WORKFLOW_MODE] as const;

export type JobMode = (typeof JOB_MODES)[number];
