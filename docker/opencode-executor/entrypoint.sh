#!/bin/sh
# Enter the work directory, then hand every argument to opencode.
#
#   docker run ... opencode-executor run 'summarise the diff'
#   docker run ... -e WORKDIR=/workspace/server opencode-executor run '...'
set -eu

WORKDIR="${WORKDIR:-/workspace}"

if [ ! -d "$WORKDIR" ]; then
    echo "opencode-executor: WORKDIR '$WORKDIR' does not exist." >&2
    echo "Mount a checkout at it, e.g. -v \"\$PWD:/workspace\"." >&2
    exit 2
fi

cd "$WORKDIR"

# A bind-mounted checkout keeps the host's uid, which is rarely 1000. git then refuses to read the
# repository at all ("dubious ownership"), and every git-shaped thing the agent tries fails with an
# error that says nothing about uids. Marking it safe is the narrow fix; it is scoped to this
# directory, and the container is already a single-user throwaway.
if [ -e "$WORKDIR/.git" ]; then
    git config --global --add safe.directory "$WORKDIR" 2>/dev/null || true
fi

# Jira (docs/env.md): when the claim env carries all three ATLASSIAN_* names, export JIRA_API —
# the site's REST base on the api.atlassian.com gateway, the only host a scoped (service-account)
# token authenticates against; acli only takes unscoped tokens. The cloud id comes from the site's
# public tenant_info. A failed lookup does not fail the run: most tasks never touch Jira, and the
# jira skill tells the agent to stop and report when JIRA_API is missing. JIRA_API is derived here,
# never inherited: a stale one would send the token wherever it points.
unset JIRA_API
if [ -n "${ATLASSIAN_SITE:-}" ] && [ -n "${ATLASSIAN_EMAIL:-}" ] && [ -n "${ATLASSIAN_API_TOKEN:-}" ]; then
    jira_host=${ATLASSIAN_SITE#*://}
    jira_host=${jira_host%%/*}
    jira_cloud_id=$(curl -fsS --proto '=https' -m 10 "https://$jira_host/_edge/tenant_info" 2>/dev/null \
        | node -e "try { const id = JSON.parse(require('fs').readFileSync(0, 'utf8')).cloudId; if (typeof id === 'string') process.stdout.write(id); } catch {}")
    if [ -n "$jira_cloud_id" ]; then
        export JIRA_API="https://api.atlassian.com/ex/jira/$jira_cloud_id/rest/api/3"
    else
        echo "opencode-executor: could not resolve the Jira cloud id of $jira_host; Jira is unavailable this run" >&2
    fi
elif [ -n "${ATLASSIAN_SITE:-}${ATLASSIAN_EMAIL:-}${ATLASSIAN_API_TOKEN:-}" ]; then
    echo "opencode-executor: Jira needs ATLASSIAN_SITE, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN; skipped" >&2
fi

# The baked policy is root-owned (issue #452): the global copy under $HOME/.config/opencode
# fixes the key order, the managed copy under /etc/opencode restores every baked value. The per-run
# allows below therefore ride OPENCODE_CONFIG_CONTENT — the inline layer, merged after the global
# copy, so its new keys land after the baked deny globs (last-match-wins) — never a file edit.
#
# The baked bash table allows merging only `origin/main`, by exact match — a glob allow would
# bless compounds. A repo whose default is another name gets the same three exact allows for
# its own default, read from origin/HEAD. No origin/HEAD, or a default of main: nothing to add.
DEFAULT_BRANCH="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
DEFAULT_BRANCH="${DEFAULT_BRANCH#origin/}"
if [ "$DEFAULT_BRANCH" = main ]; then DEFAULT_BRANCH=''; fi

# The driver points XDG_DATA_HOME at a per-member directory on the workspaces volume so the
# session database outlives the container — that persistence is what makes a follow-up's
# `--session <id>` resumable at all. The directory may not exist yet for a member's first run;
# create it rather than letting the first run fail inside opencode's own setup.
MEMBER_ROOT=''
if [ -n "${XDG_DATA_HOME:-}" ]; then
    mkdir -p "$XDG_DATA_HOME"

    # The driver's shape is <mount>/<org>/<user>/.opencode, so the member's own tree — checkouts,
    # .worktrees, .opencode — is derivable here. The baked fence denies everything outside the
    # working directory because the volume under the mount is shared by every member; the one
    # subtree a run may always operate in is its own member's. `**` rather than `*`: the allow
    # must cross "/" and reach the dot-directories the tree is made of. A path without the
    # driver's shape allows nothing — standalone runs keep the fence as baked.
    case "$XDG_DATA_HOME" in
    */.opencode) MEMBER_ROOT="${XDG_DATA_HOME%/.opencode}" ;;
    esac
fi

if [ -n "$DEFAULT_BRANCH$MEMBER_ROOT" ]; then
    if amended="$(DEFAULT_BRANCH="$DEFAULT_BRANCH" MEMBER_ROOT="$MEMBER_ROOT" node -e 2>/dev/null "
        const c = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
        if (typeof c !== 'object' || c === null || Array.isArray(c)) process.exit(1);
        c.permission ??= {};
        const branch = process.env.DEFAULT_BRANCH;
        if (branch) {
            const ref = 'origin/' + branch;
            c.permission.bash ??= {};
            for (const rule of ['git merge ' + ref, 'git merge --no-edit ' + ref, 'git merge ' + ref + ' --no-edit']) {
                c.permission.bash[rule] = 'allow';
            }
        }
        const root = process.env.MEMBER_ROOT;
        if (root) {
            c.permission.external_directory ??= {};
            c.permission.external_directory[root + '/**'] = 'allow';
        }
        process.stdout.write(JSON.stringify(c));
    ")"; then
        OPENCODE_CONFIG_CONTENT="$amended"
        export OPENCODE_CONFIG_CONTENT
    else
        echo "opencode-executor: could not add the per-run allows to OPENCODE_CONFIG_CONTENT" >&2
    fi
fi

# The branch reporter samples session -> (repo, branch) beside the run, so the board can
# attribute the session's tokens to a PR. A background SIBLING of the CLI, never its child — a
# CLI crash must not take the reporter down mid-run — with stdio discarded: the output stream
# this container prints is the run's, and the reporter never speaks. This shell is PID 1, so
# it owns the runtime's TERM/INT: all three children are tracked, the signal is forwarded to
# each, and the CLI is waited out past the trap-interrupted `wait` returns — otherwise a
# `docker stop` would leave it running until the runtime's forced kill. Its exit status, a
# signal death's 143 included, is captured and re-raised, which is the one behavior exec had
# that must survive; the reporter and the rate-limit watch are stopped and reaped before the
# close-time sample so nothing outlives the run.
# The trap goes up BEFORE the first child, not after the last one. Installed afterwards, the
# stretch between the CLI's `&` and the `trap` line is a window where PID 1 still carries the
# default TERM action: a `docker stop` landing there kills this shell outright and leaves the
# CLI running until the runtime's forced kill — the exact outcome the trap exists to prevent.
# This entrypoint's window is the wider of the two, because the rate-limit watch forks between
# them. It is also what made the offline signal test flaky, since that test could only guess at
# the window's width with a sleep.
#
# The pids are empty until each child starts, and `kill` is given them UNQUOTED so an empty one
# expands to nothing rather than to an empty argument. A TERM arriving before any child exists
# finds nothing to forward, which is correct: there is nothing running yet to stop.
#
# `cmd & PID=$!` is two commands and cannot be made one, so a signal can still land in the gap
# between the fork and the assignment — the child exists, this shell does not know its pid yet,
# and the forward reaches nothing. TERM_PENDING records that it happened; the re-check once every
# pid is known delivers it. Without that, the signal is simply lost and the run keeps going.
CLI_PID=''
REPORTER_PID=''
WATCHER_PID=''
TERM_PENDING=''
on_term() {
    TERM_PENDING=1
    # shellcheck disable=SC2086 # deliberately unquoted: an unset pid must vanish, not empty-arg
    kill -TERM $CLI_PID $REPORTER_PID $WATCHER_PID 2>/dev/null || true
}
trap on_term TERM INT

node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs >/dev/null 2>&1 &
REPORTER_PID=$!
# The CLI is forked through a subshell that CLEARS the inherited handler and execs. A background
# child inherits the parent's traps until it execs, so a TERM landing in that sliver runs
# `on_term` IN THE CHILD — which sets a copy of TERM_PENDING nothing reads, and swallows the very
# signal meant to kill it. The child then execs and runs on, and `docker stop` waits out its
# grace period for a CLI that was already told to stop. `exec` keeps $! pointing at the CLI, so
# the wait loop and the `kill -0` probe below are unchanged.
#
# ash and dash — what these images ship — reset the handler themselves and never showed this;
# bash-as-/bin/sh does not, and dropped the signal in 3 of 12 runs of a reduction of this script.
# The entrypoints are run under the host's sh by the offline suite, so "correct only under ash"
# is not good enough for a file whose whole job is to pass a signal on.
(
    trap - TERM INT
    exec opencode "$@"
) &
CLI_PID=$!
# The rate-limit watch needs the CLI's pid to bind to (it kills a run the provider has
# rate-limited into a zombie — see rate-limit-watch.cjs), so it starts after the CLI, silent
# until the one moment it must speak.
CLI_PID=$CLI_PID node --disable-warning=ExperimentalWarning /usr/local/bin/rate-limit-watch.cjs &
WATCHER_PID=$!

if [ -n "$TERM_PENDING" ]; then
    # shellcheck disable=SC2086 # same reason as on_term
    kill -TERM $CLI_PID $REPORTER_PID $WATCHER_PID 2>/dev/null || true
fi

set +e
# `wait` returns 128+signal when the trap interrupts it, indistinguishable from a child that
# died to that signal — so loop until the CLI is really gone (the kill -0 probe fails once
# the last wait has reaped it), and take that final status.
while :; do
    wait "$CLI_PID"
    STATUS=$?
    kill -0 "$CLI_PID" 2>/dev/null || break
done
set -e

# The run is over: stop the sampler and the watcher and reap them before the close-time sample,
# which is the last thing that runs.
kill -TERM "$REPORTER_PID" "$WATCHER_PID" 2>/dev/null || true
wait "$REPORTER_PID" "$WATCHER_PID" 2>/dev/null || true
node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs --once >/dev/null 2>&1 || true
exit "$STATUS"
