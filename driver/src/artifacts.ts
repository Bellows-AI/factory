/**
 * The run artifacts' close-time upload (issue #325): the full-run log and the agent transcript
 * the runner captured, POSTed to the board while the lease is still live — before the verdict on
 * the ordinary finish path, before the suspend on a stop. One helper, shared by the loop's two
 * call sites; the transport (docker containers, kubernetes Jobs) already filled the outcome.
 *
 * Best-effort by contract, like every telemetry send: a failed upload costs retention, never the
 * run, and a `409` (lost) is swallowed like the output route's — the heartbeat is the one place
 * that decides a superseded run must die, and a lost-artifact log line is not a second one.
 */

import type { Board, BoardJob } from './board.js';
import type { RunOutcome } from './runner.js';

interface UploadCtx {
    board: Board;
    log: (line: string) => void;
}

async function uploadArtifact(
    ctx: UploadCtx,
    job: BoardJob,
    kind: 'log' | 'transcript',
    artifact: { content: string | undefined; truncated: boolean }
): Promise<void> {
    // Absent and empty both mean "nothing was captured" — no artifact, never an empty one.
    if (!artifact.content) return;
    try {
        const state = await ctx.board.artifact(job, {
            kind,
            attempt: job.attempts,
            content: artifact.content,
            truncated: artifact.truncated,
        });
        if (state === 'lost') {
            ctx.log(`job ${job.id}: the ${kind} artifact was refused (lease lost), continuing`);
        }
    } catch (e) {
        ctx.log(`job ${job.id}: could not upload the ${kind} artifact, continuing: ${(e as Error).message}`);
    }
}

/**
 * Uploads the attempt's artifacts — log first, then transcript — sequentially, each best-effort
 * on its own: a failed transcript upload must not cost the log that already succeeded.
 */
export async function uploadRunArtifacts(rt: UploadCtx, job: BoardJob, outcome: RunOutcome): Promise<void> {
    await uploadArtifact(rt, job, 'log', { content: outcome.fullLog, truncated: outcome.logTruncated === true });
    await uploadArtifact(rt, job, 'transcript', {
        content: outcome.transcript,
        truncated: outcome.transcriptTruncated === true,
    });
}
