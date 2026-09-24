/**
 * The board-owned prompt templates — the building blocks every workflow's nodes are made of — and
 * the seeded base workflow (`fix-issue`), the `/fix` engineering process as a graph instead of
 * prose baked into a runner image (issue #94).
 *
 * What moved to the graph, and what did not: the loop skeleton (review x3, gate-fix x3, their stop
 * conditions) is the BOARD's — edges with bounds, enforced from the audit trail, no longer model
 * discipline. The worktree, the branch, the gates and the publish (commit/push/PR) stay driver
 * machinery the graph references by outcome. Each block carries only its agentic content plus the
 * output contract an edge needs (`VERDICT: CLEAN | BLOCKERS` for review; the fetch block's final
 * message IS the issue body later nodes interpolate). A definition change needs no image rebuild
 * and reaches opencode and claude-code runners alike.
 *
 * Templates interpolate at row-insert time: `{{nodeName.output}}` — the named node's most recent
 * output tail, bounded — `{{gate.name}}` / `{{gate.output}}` — the completed run's first failed
 * gate — `{{param.NAME}}` — a declared launch parameter, required at `POST /api/jobs` — and
 * `{{command}}` at the entry — the member's own words. The vocabulary is closed
 * (workflow-schema.ts validates it), so a block's prompt is always fully filled before the row
 * ever reaches a runner.
 */
import { type WorkflowDefinition, type WorkflowParam } from './workflow-schema.js';

/** The final line a review block must emit. The board's marker edges match exactly this. */
export const REVIEW_VERDICT_MARKER = 'VERDICT: CLEAN';
export const REVIEW_BLOCKERS_MARKER = 'VERDICT: BLOCKERS';

/**
 * The issue reference `fix-issue` is launched with — a bare `#123` or a full GitHub issues URL.
 * The bare form keeps its `#` so the issue reference survives into the interpolated command the
 * driver parses and the branch/commit messages cite.
 */
export const ISSUE_PARAM: WorkflowParam = {
    name: 'issue',
    pattern: '#\\d+|https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/\\d+',
    description: 'Enter an issue reference such as #123 or a full GitHub issue URL.',
    example: '#123',
};

const fetchIssuePrompt = `Fetch GitHub issue {{param.issue}} with full detail, comments included —
clarifications and changed requirements often live there:

    gh issue view {{param.issue}} --json number,title,body,labels,comments,state

The member's own words for this task, for context:

    {{command}}

Before touching anything, read the repo's AGENTS.md and the docs/ file that covers the area the
issue concerns — the "Read before you touch" table maps areas to files. These hold conventions
that look like cruft and are not.

Do not implement anything in this run. End your FINAL message with the issue's number, title, and
full body (comments summarized) — later steps are handed exactly that text, so it must be complete
and last.`;

const implementPrompt = `Implement the issue below, end to end.

--- ISSUE ---
{{fetch-issue.output}}
--- END ISSUE ---

Work autonomously and in order:

1. Read AGENTS.md and the docs/ file covering the area you will change, then plan: one step per
   approach move, each with the test or command that verifies it.
2. RED: write a test that reproduces the issue. Run it and confirm it FAILS for the expected
   reason — a test that fails with a setup error proves nothing.
3. GREEN: write the minimum implementation that makes it pass. No features beyond the issue, no
   speculative abstractions.
4. Run the full suite and the typecheck. If existing tests break, fix them before proceeding —
   never delete or skip a test to get green. Run the formatter/linter the repo declares and settle
   what it flags.
5. Stage your work with commits as you go, in the repo's existing message style. Never commit
   secrets, keys, or .env files.

End your final message with a summary of what changed and which commands verified it — the review
step that follows reads it first.`;

const reviewPrompt = `You are a fresh-eyes reviewer. You have NO prior context on this work by design —
everything you need is in the worktree and below. Review only; change nothing.

--- ISSUE UNDER REVIEW ---
{{fetch-issue.output}}
--- END ISSUE ---

1. Produce the complete diff: git status, then the diff of every commit on this branch against the
   remote default branch (git diff origin/<default>...HEAD), plus uncommitted changes. You must
   see everything that changed.
2. Review the diff against the issue: correctness, broken error handling, missing test coverage
   for the change, security issues. Existing-style violations count only when they are defects.
   Run the test suite yourself; a red suite is a blocker.
3. Triage: a BLOCKER is a bug, broken error handling, missing coverage for the change, or a
   security issue. Style nits are not blockers.

End your run with EXACTLY ONE of these as the final line of your final message — the process is
driven by it, and anything else strands the task:

${REVIEW_VERDICT_MARKER}
${REVIEW_BLOCKERS_MARKER}

Under VERDICT: BLOCKERS, precede the marker with the numbered list of blockers — one per line,
each with the file, the defect, and what a fix must do.`;

const fixPrompt = `A reviewer found blockers in your earlier implementation of this task. Resume that
implementation conversation and fix them — nothing else.

--- REVIEWER FINDINGS ---
{{review.output}}
--- END FINDINGS ---

1. Fix every numbered blocker, in order. Do not redesign around a finding; if one is genuinely
   wrong, say why in your final message rather than "fixing" it sideways.
2. Re-run the full suite and the typecheck. Existing tests breaking is a blocker of your own — fix
   them before proceeding.
3. Commit the fixes in the repo's existing message style.

End your final message with the list of blockers you fixed and the verification commands you ran.`;

const gateFixPrompt = `A verification gate failed on this task's latest run. Resume the implementation conversation
and make the gate pass — nothing else. Gates are the checks the checkout declares; the run's own
work is otherwise done.

--- FAILED GATE: {{gate.name}} ---
{{gate.output}}
--- END GATE OUTPUT ---

1. Read the gate's command and its output; reproduce the failure locally.
2. Fix the cause. If the failure is flaky (re-run passes), say exactly that in your final message
   with the two runs' results — do not "fix" a flake by weakening a check.
3. Never delete, skip or weaken a test or gate to get green.

End your final message with the cause and the fix, then the gate command's passing output.`;

const publishPrompt = `The review loop has cleared this task. This is the final pre-flight before the board commits
and publishes your work — verify, then stop.

1. git status must show only files your change touched. Anything else was made during the run —
   revert it; never mix it into the PR.
2. Run the full suite and the typecheck one last time. Red here fails the task.
3. Confirm the commit history reads as the repo's style (git log --oneline), with the issue
   referenced, and that no secrets, keys or .env files are staged or committed.

End your final message with a one-paragraph summary of the root cause and the fix, suitable as the
PR description's opening — the board publishes immediately after this run.`;

/**
 * The base workflow: fetch-issue → implement → review (x3) → gate-fix (x3) → publish. Review
 * rounds are bounded at three by every edge INTO `review` (counts are rows for the node, so the
 * bound is the loop limit, not a per-edge tally), gate-fix rounds the same at three. A round with
 * blockers after the third rests the thread — visible, follow-up-able, never silently continued.
 */
export const BASE_WORKFLOW: { name: string; definition: WorkflowDefinition } = {
    name: 'fix-issue',
    definition: {
        entry: 'fetch-issue',
        params: [ISSUE_PARAM],
        nodes: [
            {
                name: 'fetch-issue',
                kind: 'agent',
                session: 'resume',
                gates: false,
                prompt: fetchIssuePrompt,
            },
            {
                name: 'implement',
                kind: 'agent',
                session: 'resume',
                prompt: implementPrompt,
            },
            {
                name: 'review',
                kind: 'agent',
                session: 'fresh',
                gates: false,
                prompt: reviewPrompt,
            },
            {
                name: 'fix',
                kind: 'agent',
                session: 'resume',
                prompt: fixPrompt,
            },
            {
                name: 'gate-fix',
                kind: 'agent',
                session: 'resume',
                prompt: gateFixPrompt,
            },
            {
                name: 'publish',
                kind: 'agent',
                session: 'resume',
                publish: true,
                prompt: publishPrompt,
            },
        ],
        edges: [
            { from: 'fetch-issue', to: 'implement', when: 'succeeded' },
            { from: 'implement', to: 'review', when: 'succeeded', max: 3 },
            { from: 'implement', to: 'gate-fix', when: 'gate-failed', max: 3 },
            { from: 'review', to: 'fix', when: { marker: REVIEW_BLOCKERS_MARKER }, max: 3 },
            { from: 'review', to: 'publish', when: { marker: REVIEW_VERDICT_MARKER } },
            { from: 'fix', to: 'review', when: 'succeeded', max: 3 },
            { from: 'fix', to: 'gate-fix', when: 'gate-failed', max: 3 },
            { from: 'gate-fix', to: 'review', when: 'succeeded', max: 3 },
            { from: 'publish', to: 'gate-fix', when: 'gate-failed', max: 3 },
        ],
    },
};
