/**
 * The driver's half of the board-owned master prompt (issue #244): validating the claim carries
 * one, and turning it into each executor's own delivery mechanics. The server owns what the text
 * SAYS (server/src/db/master-prompt.ts); this file owns nothing about meaning — only how each CLI
 * is told it, which is why it is the one thing docker and kubernetes must build identically.
 */
import type { BoardJob } from './board.js';

/** Mirrors the server's own cap (server/src/db/master-prompt.ts) — the driver's own backstop
 *  against a malformed claim, never the source of truth for what "too large" means. */
export const MASTER_PROMPT_LIMIT = 4_096;

/** The reserved OpenCode primary agent name the master prompt rides as. Never a member's to pick. */
export const FACTORY_OPENCODE_AGENT = 'factory';

/**
 * Why this claim's master prompt cannot be run with, or null when it can. A missing, empty,
 * oversized, or NUL-carrying prompt is a contract violation — the board always renders one for
 * every agent claim (server/src/db/master-prompt.ts), so anything else means the claim itself is
 * broken, and running the agent with no Factory execution context is the one outcome worse than
 * refusing the launch outright.
 */
export function masterPromptRefusalReason(job: BoardJob): string | null {
    const prompt = job.masterPrompt;
    if (typeof prompt !== 'string' || prompt.length === 0) {
        return 'The board reported no Factory execution context for this run. Re-queue the task.';
    }
    if (prompt.length > MASTER_PROMPT_LIMIT) {
        return 'The board reported a Factory execution context larger than this driver will run with. Re-queue the task.';
    }
    if (prompt.includes('\u0000')) {
        return 'The board reported a Factory execution context this driver will not run with. Re-queue the task.';
    }
    return null;
}

/**
 * The validated prompt text, or a throw — the argv/config builders' own line of defence, exactly
 * as `workspacePath`/`session` elsewhere in this package refuse a malformed claim before it
 * reaches an argv rather than trusting the loop's own earlier check alone.
 */
export function masterPromptOf(job: BoardJob): string {
    const refusal = masterPromptRefusalReason(job);
    if (refusal) throw new Error(`refusing to run job ${job.id}: ${refusal}`);
    return job.masterPrompt as string;
}

/**
 * Claude Code's own delivery: the board's text through `--append-system-prompt`, snapshotting off
 * so a resumed conversation rebuilds the current claim's workflow/node context instead of
 * retaining whichever node's prompt rode the FIRST turn's snapshot. Never replaces Claude Code's
 * own built-in system prompt — this is additive, by the flag's own contract.
 */
export function claudeSystemPromptArgs(job: BoardJob): string[] {
    return ['--append-system-prompt', masterPromptOf(job), '--system-prompt-snapshot', 'off'];
}

/** Selects the reserved primary agent on every fresh and resumed OpenCode run. */
export function opencodeAgentArgs(): string[] {
    return ['--agent', FACTORY_OPENCODE_AGENT];
}

/**
 * Strips the reserved agent's name out of one config sub-object (`agent` or the legacy `mode`
 * alias some OpenCode versions still fold into it), without touching any other entry.
 */
function withoutReservedAgent(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const { [FACTORY_OPENCODE_AGENT]: _reserved, ...rest } = value as Record<string, unknown>;
    return rest;
}

/**
 * Merges the reserved `factory` primary agent into whatever `OPENCODE_CONFIG_CONTENT` the claim
 * already carries (the member's own baked model/permission/plugin config, issue #91) — without
 * dropping any of it. Any member-declared `agent.factory` is replaced wholesale, never merged
 * field-by-field with it: a member's own `prompt`, `mode`, or `disable` on that name is exactly
 * the override this feature must refuse, and a partial merge would still let a member turn the
 * reserved agent into a subagent or blank its prompt. The legacy top-level `mode` map some
 * OpenCode versions still fold into `agent` gets the same treatment on its own `factory` key, for
 * the same reason. Every OTHER declared agent (and every other `mode` entry) survives untouched.
 * Throws on a malformed existing value — a member config this driver cannot parse must fail the
 * launch, never run with an agent config the driver silently dropped half of.
 */
export function opencodeConfigContent(job: BoardJob, existing?: string): string {
    const prompt = masterPromptOf(job);
    let base: Record<string, unknown> = {};
    if (existing) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(existing);
        } catch {
            throw new Error(`refusing to run job ${job.id}: OPENCODE_CONFIG_CONTENT is not valid JSON`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`refusing to run job ${job.id}: OPENCODE_CONFIG_CONTENT is not a JSON object`);
        }
        base = parsed as Record<string, unknown>;
    }
    const { agent, mode, ...rest } = base;
    const merged: Record<string, unknown> = {
        ...rest,
        agent: {
            ...withoutReservedAgent(agent),
            // `disable: false` explicit, not merely absent: this key is the one field a stripped
            // `agent.factory` entry could otherwise still leave a trace of if OpenCode ever reads
            // it from more than one layer, and stating it here costs nothing.
            [FACTORY_OPENCODE_AGENT]: { mode: 'primary', prompt, disable: false },
        },
    };
    if (mode !== undefined) merged.mode = withoutReservedAgent(mode);
    return JSON.stringify(merged);
}
