-- The code-owned default workflow's selected optional-block pair, frozen on the root job at
-- create (issue #209).
--
-- This supersedes 032's "an unnamed task runs the member's words verbatim, and a workflow walks
-- one only when a body names it": an unnamed task now resolves the code-owned DEFAULT workflow —
-- never a member-authored row, never `workflow.is_default` (032 dropped that column and stays
-- applied and unedited, per docs/persistence.md's "applied migrations are never edited") — so 032
-- is not reverted, only narrowed by this later file and by docs/workflows.md's own update.
--
-- workflow_id/workflow_name/workflow_node/workflow_snapshot/workflow_params (027, 030, 033)
-- already carry the name ('default') and the expanded graph a default-workflow root needs; they
-- cannot record WHICH of the two optional blocks the caller selected, nor tell the code-owned
-- default apart from a member's own custom workflow that happens to be named "default" (never
-- reserved — routes/jobs.ts resolves `workflow: "default"` as an ordinary name, and a null
-- workflow_id is what actually distinguishes the two). These two columns close that gap.
--
-- Both non-null together, both null together: a create either selects the default workflow's pair
-- (and stamps both) or does not (a named workflow, or a pre-209 workflow-less create) — never one
-- without the other. Root-only, like workflow_params: a successor or follow-up row carries
-- neither, exactly as it carries no workflow_id of its own.
--
-- NOT VALID, matching 033's own reasoning: every row already in the table gets both columns null
-- by construction (they are created in this file), so there is nothing to backfill or validate —
-- unlike 033/034, this file needs no follow-up VALIDATE CONSTRAINT migration.
--
-- This file must contain NO `create extension` and NO `create_hypertable`, per 005's header.

alter table job add column if not exists default_review_reconciliation boolean;
alter table job add column if not exists default_merge_conflict_autofix boolean;

alter table job add constraint job_default_workflow_pair_ck check (
    (default_review_reconciliation is null and default_merge_conflict_autofix is null)
    or (
        default_review_reconciliation is not null and default_merge_conflict_autofix is not null
        and workflow_name = 'default' and workflow_id is null and workflow_snapshot is not null
    )
) not valid;
