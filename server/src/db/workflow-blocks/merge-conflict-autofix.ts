/**
 * The `builtin/merge-conflict-autofix` block (issue #122): reconciles an existing task's pull
 * request with its current base branch. Two nodes:
 *
 * - `repair` (entry, `session: fresh`, `gates: false`) declares a single PRE helper,
 *   `merge-conflict-probe` (driver/src/scripts/merge-conflict-probe.cjs, issue #207's transport):
 *   a deterministic script that fetches the PR's recorded base (the structured publication
 *   identity issue #202 records, injected generically by `resolveClaimHelperPlans` — this
 *   descriptor names no PR field itself). The probe DECIDES two of its three verdicts itself and
 *   `conclude`s (issue #230) with the marker as the job's output, so no agent session ever starts
 *   for them (issue #503): `MERGE-UP-TO-DATE` (the branch already contains its base) and
 *   `MERGE-REBASED` (a clean rebase). Only a real conflict continues to the agent, which gets a
 *   fresh session — not the whole task history — and reads the probe's
 *   `.factory/merge-conflict-probe.json` for `conflictingPaths`, since the generic helper
 *   transport surfaces only ok/fail to the loop, never a helper's own output. The agent resolves
 *   it using ONLY `git rebase --continue`/`--abort` — never an initiating `git rebase`,
 *   `git merge`, `git switch`/`checkout` of a branch, or `gh pr create`, all denied to the agent
 *   by the executor's git guard (docker/claude-executor/git-guard.cjs) for exactly this reason:
 *   a rebase INITIATION is the driver's own job, and `--continue`/`--abort` on one already in
 *   progress is "the repair path for a tree an interrupted sync left mid-rebase" — the guard's
 *   own words for precisely this block's scenario.
 * - `verify` (`agent: false`, `publish: true`, gates default on) launches no agent at all: the
 *   driver's own claim machinery runs the declared gates and publishes through the existing
 *   publisher (`driver/src/publish.ts`) once claimed — the block adds no publish logic of its
 *   own. Publish already reuses the thread's existing PR for free (its branch is always
 *   `factory/<rootJobId>`, the same branch this thread published from originally), so "never
 *   `gh pr create`" needs no code beyond the agent instruction above.
 *
 * `MERGE-UP-TO-DATE` and `MERGE-NEEDS-REVIEW` have no outgoing edge — a completed node no rule
 * matches rests the thread loudly (docs/workflows.md, "Marker absence is a first-class outcome"),
 * which is what keeps an up-to-date branch from ever reaching gates or publish, and an unresolved
 * conflict resting as needs-review with its reason visible in the run's own output. The one loop
 * this block declares is `repair`'s own retry on ITS RUN failing outright (a crash, a lost lease,
 * an infra blip) — `maxAttempts` bounds it, reusing the config field's own pre-existing
 * description ("maximum conflict-resolution attempts before resting the thread"); a deliberate
 * `MERGE-NEEDS-REVIEW` verdict is not a failure and is never retried — the issue's "one agent
 * repair round" for the substantive case.
 */
import type { BlockDescriptor, BlockExpansion } from './types.js';

// Exported for master-prompt.ts's generic capability naming — see the same note in
// github-review-reconcile.ts.
export const PROBE_HELPER_ID = 'merge-conflict-probe';
const PROBE_STATE_PATH = '.factory/merge-conflict-probe.json';

// The probe script spells MERGE-UP-TO-DATE and MERGE-REBASED literally — it cannot import this file.
const REBASED_MARKER = 'MERGE-REBASED';
const RESOLVED_MARKER = 'MERGE-RESOLVED';
const NEEDS_REVIEW_MARKER = 'MERGE-NEEDS-REVIEW';

const DEFAULT_MAX_ATTEMPTS = 2;

const REPAIR_PROMPT = `A previous turn of this task published a pull request. This turn reconciles it with its current base branch before the thread continues.

A deterministic preflight already ran in this worktree, started a rebase onto the base branch and hit conflicts: the worktree is mid-rebase. It wrote its verdict to \`${PROBE_STATE_PATH}\`; read that file now — its "conflictingPaths" lists the files carrying conflict markers.

Resolve every conflict in those files, stage each with \`git add <path>\`, then finish with \`git rebase --continue\`. Never start a NEW rebase or merge, never touch the pull request's target branch, and never run \`gh pr create\` — this reconciles the EXISTING pull request only.
If every conflict is resolved and the rebase completes, end your response with exactly this line:
${RESOLVED_MARKER}
If you cannot resolve the conflicts, run \`git rebase --abort\` to leave the tree clean, and end your response with exactly this line:
${NEEDS_REVIEW_MARKER}`;

// `verify` launches no agent, so no model reads this: the schema only requires a prompt on every node.
const VERIFY_PROMPT = 'Driver-only node: runs the declared gates and publishes, with no agent turn.';

export const MERGE_CONFLICT_AUTOFIX: BlockDescriptor = {
    id: 'builtin/merge-conflict-autofix',
    description: "Resolves the branch's merge conflicts against the default branch before publish.",
    configSchema: [
        {
            name: 'maxAttempts',
            type: 'number',
            description: 'Maximum conflict-resolution attempts before resting the thread.',
            default: DEFAULT_MAX_ATTEMPTS,
            min: 1,
            max: 5,
        },
    ],
    available: true,
    expand(_nodeName, config): BlockExpansion {
        // resolveConfig (workflow-blocks/index.ts) has already validated this against the
        // configSchema above — defaulted, type- and bound-checked — before expand() ever runs.
        const maxAttempts = config.maxAttempts as number;
        return {
            nodes: [
                {
                    name: 'repair',
                    kind: 'agent',
                    session: 'fresh',
                    gates: false,
                    prompt: REPAIR_PROMPT,
                    helperPlans: [{ helperId: PROBE_HELPER_ID, phase: 'pre', githubWriting: true }],
                },
                {
                    name: 'verify',
                    kind: 'agent',
                    session: 'resume',
                    agent: false,
                    publish: true,
                    prompt: VERIFY_PROMPT,
                },
            ],
            edges: [
                { from: 'repair', to: 'verify', when: { marker: REBASED_MARKER } },
                { from: 'repair', to: 'verify', when: { marker: RESOLVED_MARKER } },
                { from: 'repair', to: 'repair', when: 'failed', max: maxAttempts },
            ],
            entry: 'repair',
            exit: 'verify',
        };
    },
};
