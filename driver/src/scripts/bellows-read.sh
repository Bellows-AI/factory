# The .bellows.yaml readout: every checkout's services declaration under one member tree, each
# file preceded by a marker naming its checkout (the repo directory name), so the driver can
# merge the declarations across checkouts and attribute a duplicate-name refusal.
#
# Environment (all literals set by the driver — paths and constants, never credentials):
#   BELLOWS_ROOT         — the member tree to walk: <mount>/<orgId>/<userId>;
#   BELLOWS_TASK_REPO    — the task's own checkout name; unset for a job with no repo;
#   BELLOWS_TASK_TREE    — that checkout's task worktree, <root>/.worktrees/<rootJobId>: the
#                          tree the gates read, so the task repo is read from it and never from
#                          its base clone, whose checked-out files may lag (no fallback);
#   BELLOWS_MAX_BYTES    — the per-file size bound, mirrored by the driver's splitter;
#   BELLOWS_ERROR_PREFIX — the line printed IN PLACE OF a file the readout refused to read
#                          whole; the splitter turns it into the author-facing refusal.
#
# A glob over the checkout directories; the [ -f ] guard is what a glob with no matches
# produces in sh — the pattern itself — so a workspace with no .bellows.yaml prints nothing at
# all. Each file is size-checked before it is read: stdio readers on both platforms bound the
# output (execFile at 1 MiB, a pod log at its server-side limit), and an oversize file must
# come back as the author's refusal, not as a failed read that reads as infrastructure and
# burns the job's attempts. A file with no trailing newline would otherwise glue the next
# marker onto its last line; the newline between sections is padding the splitter drops.
#
# The dot-directory that holds the task worktrees (.worktrees) is skipped naturally: a shell
# glob does not match leading-dot names.

section() {
    [ -f "$2" ] || return 0
    echo "###__bellows:$1"
    if [ "$(wc -c <"$2")" -gt "$BELLOWS_MAX_BYTES" ]; then
        echo "$BELLOWS_ERROR_PREFIX$2 is larger than $BELLOWS_MAX_BYTES bytes"
    else
        cat "$2"
    fi
    echo
}

if [ -n "$BELLOWS_TASK_TREE" ]; then
    section "$BELLOWS_TASK_REPO" "$BELLOWS_TASK_TREE/.bellows.yaml"
fi
for f in "$BELLOWS_ROOT"/*/.bellows.yaml; do
    name=$(basename "$(dirname "$f")")
    [ -n "$BELLOWS_TASK_TREE" ] && [ "$name" = "$BELLOWS_TASK_REPO" ] && continue
    section "$name" "$f"
done
