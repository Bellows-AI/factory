#!/bin/sh
# Enter the work directory, then hand every argument to opencode.
#
#   docker run ... opencode-executor run 'summarise the diff'
#   docker run ... -e WORKDIR=/workspace/server opencode-executor run '...'
set -eu

# The GitHub helper beside this script (/usr/local/bin in the image), resolved before any `cd`.
GITHUB_CREDENTIAL="$(cd "$(dirname "$0")" && pwd)/github-credential.cjs"
# The agent's GitHub token is that helper's alone, renewed ahead of expiry: a value injected into
# this container would shadow it in gh and git, and outlive its hour.
unset GITHUB_TOKEN GH_TOKEN

# The task supervisor releases the agent (issue #771). The group exists from the attempt's first
# step, the sync, and the tree this container works in does not exist until then, so the agent waits
# for the supervisor's `go` marker in its read-only mailbox. A Stop or a kill order that lands first
# means the agent is never released: it leaves quietly. An image run by hand has no mailbox and waits
# for nothing.
if [ -n "${FACTORY_CTL_GO:-}" ]; then
    while [ ! -f "$FACTORY_CTL_GO" ]; do
        if [ -f "${FACTORY_CTL_IN:-/nonexistent}/stop" ] || [ -f "${FACTORY_CTL_IN:-/nonexistent}/kill" ]; then
            exit 0
        fi
        sleep 0.2
    done
fi

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

# GitHub (docs/connections.md): no token rides this container's env. git asks the image's helper
# for github.com, and the helper obtains the attempt's token from the board with the attempt pair,
# caches it on the memory-backed /run/factory-github and renews it ahead of expiry; gh is the
# wrapper over the same helper. Only the helper's path lands in the git config, never a token.
if [ -n "${FACTORY_STATS_URL:-}" ] && [ -n "${RUNNER_JOB_ID:-}" ] && [ -n "${RUNNER_LEASE_TOKEN:-}" ]; then
    git config --global credential.https://github.com.helper "!node '$GITHUB_CREDENTIAL' git" \
        2>/dev/null || echo "opencode-executor: could not configure the git credential helper" >&2
fi

# Jira (docs/connections.md): JIRA_API is the board's connector proxy for THIS attempt, never
# Atlassian itself — the credential stays on the board, which checks the attempt's lease and the
# task's selected connection on every call. Derived here, never inherited: a stale value would
# send the lease pair wherever it points. The jira skill passes the pair as headers and tells the
# agent to stop and report when the board refuses.
unset JIRA_API
if [ -n "${FACTORY_STATS_URL:-}" ] && [ -n "${RUNNER_JOB_ID:-}" ] && [ -n "${RUNNER_LEASE_TOKEN:-}" ]; then
    export JIRA_API="${FACTORY_STATS_URL%/}/api/jobs/$RUNNER_JOB_ID/connectors/jira/rest/api/3"
fi

# The baked policy is root-owned (issue #452): the global copy under $HOME/.config/opencode
# fixes the key order, the managed copy under /etc/opencode restores every baked value. The per-run
# allows below therefore ride OPENCODE_CONFIG_CONTENT — the inline layer, merged after the global
# copy, so its new keys land after the baked deny globs (last-match-wins) — never a file edit.
#
# The baked bash table allows merging only `origin/main`, by exact match — a glob allow would
# bless compounds. A repo whose default is another name gets the same three exact allows for
# its own default, read from origin/HEAD — or, for a batch task, the base the driver hands it
# (BASE_BRANCH). No origin/HEAD, or a default of main: nothing to add.
DEFAULT_BRANCH="${BASE_BRANCH:-$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)}"
DEFAULT_BRANCH="${DEFAULT_BRANCH#origin/}"
if [ "$DEFAULT_BRANCH" = main ]; then DEFAULT_BRANCH=''; fi

# The driver points XDG_DATA_HOME at a per-task directory on the workspaces volume so the
# session database outlives the container — that persistence is what makes a follow-up's
# `--session <id>` resumable at all. The directory may not exist yet for a task's first run;
# create it rather than letting the first run fail inside opencode's own setup.
MEMBER_ROOT=''
if [ -n "${XDG_DATA_HOME:-}" ]; then
    mkdir -p "$XDG_DATA_HOME"

    # The driver's shape is <mount>/<org>/<user>/.factory/opencode/<task>, so the member's own
    # tree — checkouts, .worktrees, .factory — is derivable here. The baked fence denies everything outside the
    # working directory because the volume under the mount is shared by every member; the one
    # subtree a run may always operate in is its own member's. `**` rather than `*`: the allow
    # must cross "/" and reach the dot-directories the tree is made of. A path without the
    # driver's shape allows nothing — standalone runs keep the fence as baked.
    case "$XDG_DATA_HOME" in
    */.factory/opencode/*) MEMBER_ROOT="${XDG_DATA_HOME%/.factory/opencode/*}" ;;
    esac
fi

# A resumed run (`--session <id>`, the id also in BELLOWS_SESSION_ID) names the session its
# predecessor reported live (issue #822); a node lost before opencode flushed that row leaves a
# database without it, and opencode would refuse the run. Only when the session is certainly
# absent — no database (ENOENT), or no such row (exit 1) — the pair is dropped and a new session
# starts, BELLOWS_SESSION_ID unset so the reporter discovers it. One that cannot be read keeps it.
if [ -n "${BELLOWS_SESSION_ID:-}" ] && [ -n "${XDG_DATA_HOME:-}" ]; then
    known=0
    node --disable-warning=ExperimentalWarning -e '
        const db = process.env.XDG_DATA_HOME + "/opencode/opencode.db";
        try {
            require("node:fs").statSync(db);
        } catch (e) {
            process.exit(e.code === "ENOENT" ? 1 : 2);
        }
        try {
            const { DatabaseSync } = require("node:sqlite");
            const handle = new DatabaseSync(db, { readOnly: true });
            const row = handle.prepare("select 1 from session where id = ?").get(process.env.BELLOWS_SESSION_ID);
            handle.close();
            process.exit(row ? 0 : 1);
        } catch {
            process.exit(2);
        }
    ' || known=$?
    if [ "$known" = 1 ]; then
        echo "opencode-executor: session $BELLOWS_SESSION_ID is not in the session database; starting a new one" >&2
        resumed="$BELLOWS_SESSION_ID"
        unset BELLOWS_SESSION_ID
        pending=''
        first=1
        for arg do
            if [ "$first" = 1 ]; then set --; first=''; fi
            if [ -n "$pending" ]; then
                pending=''
                [ "$arg" = "$resumed" ] && continue
                set -- "$@" --session
            fi
            if [ "$arg" = --session ]; then pending=1; continue; fi
            set -- "$@" "$arg"
        done
        if [ -n "$pending" ]; then set -- "$@" --session; fi
    fi
fi

# A fresh run of a task that already ran — a retry — shares the task's directory and session
# database, so until opencode creates this run's session the newest one there is an earlier
# attempt's. Named here, before the CLI starts, the reporter never reports it as this run's; a
# database `--prior` cannot read leaves the baseline unknown, and the reporter discovers nothing.
if [ -z "${BELLOWS_SESSION_ID:-}" ]; then
    if BRANCH_REPORTER_PRIOR_SESSION="$(node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs --prior 2>/dev/null)"; then
        export BRANCH_REPORTER_PRIOR_SESSION
    else
        BRANCH_REPORTER_PRIOR_UNKNOWN=1
        export BRANCH_REPORTER_PRIOR_UNKNOWN
    fi
fi

if [ -n "$DEFAULT_BRANCH$MEMBER_ROOT" ]; then
    # Single-quoted: the shell expands nothing in the script. A value the merge cannot extend is
    # named in one line on stderr and passed through untouched.
    if amended="$(DEFAULT_BRANCH="$DEFAULT_BRANCH" MEMBER_ROOT="$MEMBER_ROOT" node -e '
        let c;
        try {
            c = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
        } catch (e) {
            console.error("opencode-executor: OPENCODE_CONFIG_CONTENT is not JSON: " + e.message);
            process.exit(1);
        }
        if (typeof c !== "object" || c === null || Array.isArray(c)) {
            console.error("opencode-executor: OPENCODE_CONFIG_CONTENT is not a JSON object");
            process.exit(1);
        }
        c.permission ??= {};
        const branch = process.env.DEFAULT_BRANCH;
        if (branch) {
            const ref = "origin/" + branch;
            c.permission.bash ??= {};
            for (const rule of ["git merge " + ref, "git merge --no-edit " + ref, "git merge " + ref + " --no-edit"]) {
                c.permission.bash[rule] = "allow";
            }
        }
        const root = process.env.MEMBER_ROOT;
        if (root) {
            c.permission.external_directory ??= {};
            c.permission.external_directory[root + "/**"] = "allow";
        }
        process.stdout.write(JSON.stringify(c));
    ')"; then
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
CTL_PID=''
TERM_PENDING=''
on_term() {
    TERM_PENDING=1
    # shellcheck disable=SC2086 # deliberately unquoted: an unset pid must vanish, not empty-arg
    kill -TERM $CLI_PID $REPORTER_PID $WATCHER_PID $CTL_PID 2>/dev/null || true
}
trap on_term TERM INT

node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs >/dev/null 2>&1 &
REPORTER_PID=$!
# The cooperative Stop (issue #442): the mailbox agent reads what the task supervisor wrote into
# the read-only FACTORY_CTL_IN directory and writes the stop marker the baked factory-stop plugin
# checks at each step boundary; it also beats the heartbeat the supervisor reads and forwards a
# kill order to this shell as TERM. Exported so the agent and the plugin agree on one path; any
# marker left from before is cleared first. A background sibling like the reporter, stdio discarded.
# Under TMPDIR when one is set (the offline suite gives each case its own), /tmp in the image.
FACTORY_STOP_MARKER="${TMPDIR:-/tmp}/factory-stop"
export FACTORY_STOP_MARKER
rm -f "$FACTORY_STOP_MARKER" "$FACTORY_STOP_MARKER.aborted"
node /usr/local/bin/ctl-agent.cjs >/dev/null 2>&1 &
CTL_PID=$!
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
    kill -TERM $CLI_PID $REPORTER_PID $WATCHER_PID $CTL_PID 2>/dev/null || true
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

# opencode ends a session the stop plugin aborted with `Error: Aborted` and exit 1. That is the run
# ending as the Stop asked, so it is reported as 0 — only for that exit 1, and only when the
# poller's marker AND the plugin's abort record both exist. Every other status, a genuine failure
# or a signal death, is re-raised as it came. The image is the same for docker and kubernetes.
if [ "$STATUS" -eq 1 ] && [ -e "$FACTORY_STOP_MARKER" ] && [ -e "$FACTORY_STOP_MARKER.aborted" ]; then
    STATUS=0
fi

# The run is over: stop the sampler and the watcher and reap them before the close-time sample,
# which is the last thing that runs.
kill -TERM "$REPORTER_PID" "$WATCHER_PID" "$CTL_PID" 2>/dev/null || true
wait "$REPORTER_PID" "$WATCHER_PID" "$CTL_PID" 2>/dev/null || true
node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs --once >/dev/null 2>&1 || true
# The supervisor's word that the agent is over, written last and atomically: the exit status the
# runtime reports is still the verdict, this only lets the supervisor start finalizing at once.
if [ -n "${FACTORY_CTL_OUT:-}" ]; then
    printf '%s\n' "$STATUS" > "$FACTORY_CTL_OUT/agent.exit.tmp" 2>/dev/null \
        && mv "$FACTORY_CTL_OUT/agent.exit.tmp" "$FACTORY_CTL_OUT/agent.exit" 2>/dev/null || true
fi
# The cached GitHub token goes with the run; the memory-backed mount goes with the container.
node "$GITHUB_CREDENTIAL" clear 2>/dev/null || true
exit "$STATUS"
