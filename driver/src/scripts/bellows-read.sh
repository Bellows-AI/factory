# The .bellows.yaml readout: every checkout's services declaration under one member tree, each
# file preceded by a marker naming its checkout (the repo directory name), so the driver can
# merge the declarations across checkouts and attribute a duplicate-name refusal.
#
# Environment (all literals set by the driver — paths and constants, never credentials):
#   BELLOWS_ROOT         — the member tree to walk: <mount>/<orgId>/<userId>;
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

for f in "$BELLOWS_ROOT"/*/.bellows.yaml; do
    [ -f "$f" ] || continue
    echo "###__bellows:$(basename "$(dirname "$f")")"
    if [ "$(wc -c <"$f")" -gt "$BELLOWS_MAX_BYTES" ]; then
        echo "$BELLOWS_ERROR_PREFIX$f is larger than $BELLOWS_MAX_BYTES bytes"
    else
        cat "$f"
    fi
    echo
done
