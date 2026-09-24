/**
 * The `builtin/merge-conflict-autofix` block (issue #122): reconciles an existing task's pull
 * request with its current base branch. Two nodes:
 *
 * - `repair` (entry, `session: resume`, `gates: false`) declares a single PRE helper,
 *   `merge-conflict-probe` (driver/src/scripts/merge-conflict-probe.cjs, issue #207's transport):
 *   a deterministic script that fetches the PR's recorded base (the structured publication
 *   identity issue #202 records, injected generically by `resolveClaimHelperPlans` — this
 *   descriptor names no PR field itself), and either finds the branch already up to date, rebases
 *   it cleanly, or leaves a known conflicted rebase state — writing its verdict to
 *   `.factory/merge-conflict-probe.json` in the worktree, since the generic helper transport
 *   surfaces only ok/fail to the loop, never a helper's own output, to the agent that follows.
 *   `repair`'s own prompt is a fixed relay: read that file, and when the verdict names a real
 *   conflict, resolve it using ONLY `git rebase --continue`/`--abort` — never an initiating
 *   `git rebase`, `git merge`, `git switch`/`checkout` of a branch, or `gh pr create`, all denied
 *   to the agent by the executor's git guard (docker/claude-executor/git-guard.cjs) for exactly
 *   this reason: a rebase INITIATION is the driver's own job, and `--continue`/`--abort` on one
 *   already in progress is "the repair path for a tree an interrupted sync left mid-rebase" — the
 *   guard's own words for precisely this block's scenario.
 * - `verify` (`publish: true`, gates default on) is a trivial confirmation turn: the driver's own
 *   claim machinery runs the declared gates and publishes through the existing publisher
 *   (`driver/src/publish.ts`) automatically once claimed — the block adds no publish logic of its
 *   own. Publish already reuses the thread's existing PR for free (its branch is always
 *   `factory/<rootJobId>`, the same branch this thread published from originally), so "never
 *   `gh pr create`" needs no code beyond the agent instruction above.
 *
 * `repair`'s up-to-date and needs-review markers have no outgoing edge — a completed node no rule
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

const UP_TO_DATE_MARKER = 'MERGE-UP-TO-DATE';
const REBASED_MARKER = 'MERGE-REBASED';
const RESOLVED_MARKER = 'MERGE-RESOLVED';
const NEEDS_REVIEW_MARKER = 'MERGE-NEEDS-REVIEW';

const DEFAULT_MAX_ATTEMPTS = 2;

const REPAIR_PROMPT = `A previous turn of this task published a pull request. This turn reconciles it with its current base branch before the thread continues.

A deterministic preflight already ran in this worktree and wrote its verdict to \`${PROBE_STATE_PATH}\`. Read that file now — its "verdict" field is one of "up-to-date", "rebased", or "conflicted".

- "up-to-date": the branch already contains its base branch's tip. Make no changes of any kind. Your entire response must be exactly this line:
${UP_TO_DATE_MARKER}

- "rebased": the preflight already rebased the branch onto its base cleanly. Make no changes — do not run \`git rebase\`, \`git merge\`, \`git switch\`, \`git checkout\` of a branch, or \`gh pr create\`. Your entire response must be exactly this line:
${REBASED_MARKER}

- "conflicted": the preflight left the worktree mid-rebase. The file's "conflictingPaths" lists the files carrying conflict markers. Resolve every conflict in those files, stage each with \`git add <path>\`, then finish with \`git rebase --continue\`. Never start a NEW rebase or merge, never touch the pull request's target branch, and never run \`gh pr create\` — this reconciles the EXISTING pull request only.
  If every conflict is resolved and the rebase completes, end your response with exactly this line:
${RESOLVED_MARKER}
  If you cannot resolve the conflicts, run \`git rebase --abort\` to leave the tree clean, and end your response with exactly this line:
${NEEDS_REVIEW_MARKER}`;

const VERIFY_PROMPT =
    "The merge-conflict-autofix block's repair turn is complete and the branch is ready. " +
    'Nothing further is required from you; respond with a short confirmation.';

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
                    session: 'resume',
                    gates: false,
                    prompt: REPAIR_PROMPT,
                    helperPlans: [{ helperId: PROBE_HELPER_ID, phase: 'pre', githubWriting: true }],
                },
                {
                    name: 'verify',
                    kind: 'agent',
                    session: 'resume',
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
