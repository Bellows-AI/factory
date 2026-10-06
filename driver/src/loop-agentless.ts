import type { BoardJob } from './board.js';
import type { RunOutcome } from './runner.js';

/**
 * An agent-less workflow node (issue #503: the claim's `agent: false`) runs no runner session — its
 * work is the declared pre-helpers, then the gates and the publish the loop already runs after any
 * clean run. This is the clean run it stands in for: exit 0, nothing said, nothing scraped, so the
 * ledger sees an agent that finished and the gates and publish decide the verdict.
 */
export const AGENTLESS_OUTCOME: RunOutcome = { exitCode: 0, output: '', timedOut: false, started: true };

/** Whether the board claimed this row as a node that launches no agent. Absent reads as an agent. */
export function isAgentless(job: BoardJob): boolean {
    return job.agent === false;
}
