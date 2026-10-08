/**
 * What an independent reviewer (issue #549) is told. Pure: the profile's frozen spec and the task's
 * command in, the system prompt and the first message out. The reviewer is its own thread, so
 * these never read the caller's master prompt — it owns none of the caller's capabilities
 * (publishing, questions, gates), and the text must not promise it any.
 */

import type { ReviewerSpec } from './job-store-types.js';
import { REVIEW_BLOCKERS_MARKER, REVIEW_VERDICT_MARKER } from './workflow-templates.js';

/** How much of the task's command a review quotes — enough to say what the work was for. */
export const TASK_COMMAND_LIMIT = 2_000;

export function reviewerPrompts(spec: ReviewerSpec, taskCommand: string): { masterPrompt: string; command: string } {
    const masterPrompt = `You are an independent reviewer, profile "${spec.name}". The working directory is a
snapshot of another agent's work, taken at one moment. Review it; do not modify, commit, push or
publish anything — you have no authority to ship, and a change you make is never reviewed.

--- YOUR PROFILE'S INSTRUCTIONS ---
${spec.instructions}
--- END INSTRUCTIONS ---

End your run with EXACTLY ONE of these as the final line of your final message — the verdict is
read from it, and anything else is an incomplete review:

${REVIEW_VERDICT_MARKER}
${REVIEW_BLOCKERS_MARKER}

Under ${REVIEW_BLOCKERS_MARKER}, precede the marker with the numbered list of blockers — one per
line, each with the file, the defect, and what a fix must do.`;
    const quoted =
        taskCommand.length > TASK_COMMAND_LIMIT ? `${taskCommand.slice(0, TASK_COMMAND_LIMIT)}…` : taskCommand;
    const command = `Review the work in this checkout against the task it was done for.

--- THE TASK ---
${quoted}
--- END TASK ---`;
    return { masterPrompt, command };
}
