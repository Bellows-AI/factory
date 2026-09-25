#!/bin/sh
# Enter the work directory, then hand every argument to claude.
#
#   docker run ... claude-executor -p 'summarise the diff'
#   docker run ... -e WORKDIR=/workspace/server claude-executor -p '...'
set -eu

WORKDIR="${WORKDIR:-/workspace}"
export WORKDIR

# The transcript store (issue #55): when the driver hands us a transcript directory, the CLI's
# config dir moves to it — on the workspaces volume, so transcripts survive this container and a
# follow-up's --resume finds the thread's earlier sessions in the same directory. The seed below
# and the patches read CLAUDE_CONFIG_DIR dynamically, so the baked guard and settings ride along
# unchanged.
if [ -n "${FACTORY_TRANSCRIPT_DIR:-}" ]; then
    mkdir -p "$FACTORY_TRANSCRIPT_DIR"
    export CLAUDE_CONFIG_DIR="$FACTORY_TRANSCRIPT_DIR"
fi

# A fresh CLAUDE_CONFIG_DIR — the transcript store's per-thread directory above, or a volume mounted
# over the baked home — starts empty and would hide the baked configuration. Seed it once from the
# pristine copy. Keyed on settings.json rather than on the directory being empty, since the CLI
# writes .claude.json before anything else asks a question.
if [ ! -f "$CLAUDE_CONFIG_DIR/settings.json" ] && [ -d /opt/claude-home ]; then
    cp -a /opt/claude-home/. "$CLAUDE_CONFIG_DIR/"
fi

if [ ! -d "$WORKDIR" ]; then
    echo "claude-executor: WORKDIR '$WORKDIR' does not exist." >&2
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

# The member's own executor config — model, env vars, permission allowlist — synthesized by the
# board from their `claude-code` executor row (server/src/db/job-store.ts) and delivered as
# CLAUDE_CODE_CONFIG_CONTENT, the same shape opencode's OPENCODE_CONFIG_CONTENT takes. Top-level
# keys overwrite the baked settings.json; `env` merges INTO the baked env block instead of
# replacing it outright. Telemetry is not in this file at all: it lives in managed settings, which
# outrank user settings, so a member cannot disable it or turn on prompt/response/tool-detail
# logging from here. `hooks`, `enabledPlugins` and `extraKnownMarketplaces` are the
# runner's fence — the git guard hook and the baked context-mode plugin install — the board
# already strips them before this env var is set; stripped again here in case a value ever
# arrives some other way.
if [ -n "${CLAUDE_CODE_CONFIG_CONTENT:-}" ]; then
    SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
    if [ -f "$SETTINGS" ]; then
        SETTINGS="$SETTINGS" node -e "
            const fs = require('fs');
            const f = process.env.SETTINGS;
            const c = JSON.parse(fs.readFileSync(f, 'utf8'));
            const member = JSON.parse(process.env.CLAUDE_CODE_CONFIG_CONTENT);
            delete member.hooks;
            delete member.enabledPlugins;
            delete member.extraKnownMarketplaces;
            const { env: memberEnv, ...rest } = member;
            Object.assign(c, rest);
            if (memberEnv && typeof memberEnv === 'object') {
                c.env = { ...(c.env || {}), ...memberEnv };
            }
            fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
        " || echo "claude-executor: could not merge CLAUDE_CODE_CONFIG_CONTENT into settings.json" >&2
    fi
fi

# Claude Code's settings env blocks OVERRIDE the container environment — the settings file value
# applies — so the endpoint the driver forwards (OTEL_EXPORTER_OTLP_ENDPOINT) would be defeated by
# the baked http://collector:4318, which only a compose network can resolve. Rewrite the managed
# settings value when the driver has pointed us elsewhere, the same way the opencode executor
# patches otel.json. Managed, not $CLAUDE_CONFIG_DIR/settings.json: a user-scope value loses to the
# checkout's own .claude/settings.json (see the Dockerfile).
if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
    SETTINGS=/etc/claude-code/managed-settings.json
    if [ -f "$SETTINGS" ]; then
        SETTINGS="$SETTINGS" node -e "
            const fs = require('fs');
            const f = process.env.SETTINGS;
            const c = JSON.parse(fs.readFileSync(f, 'utf8'));
            c.env = c.env || {};
            c.env.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
            fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
        " || echo "claude-executor: could not rewrite managed-settings.json's OTEL_EXPORTER_OTLP_ENDPOINT" >&2
    fi
fi

# The branch reporter samples session -> (repo, branch) beside the run, so the board can
# attribute the session's tokens to a PR. A background SIBLING of the CLI, never its child — a
# CLI crash must not take the reporter down mid-run — with stdio discarded: the output stream
# this container prints is the run's, and the reporter never speaks. This shell is PID 1, so
# it owns the runtime's TERM/INT: both children are tracked, the signal is forwarded to both,
# and the CLI is waited out past the trap-interrupted `wait` returns — otherwise a
# `docker stop` would leave it running until the runtime's forced kill. Its exit status, a
# signal death's 143 included, is captured and re-raised, which is the one behavior exec had
# that must survive; the reporter is stopped and reaped before the close-time sample so
# nothing outlives the run.
# The trap goes up BEFORE the first child, not after the last one. Installed afterwards, the
# stretch between the CLI's `&` and the `trap` line is a window where PID 1 still carries the
# default TERM action: a `docker stop` landing there kills this shell outright and leaves the
# CLI running until the runtime's forced kill — the exact outcome the trap exists to prevent.
# The window is small and it is real; it is also what made the offline signal test flaky, since
# that test could only guess at its width with a sleep.
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
PROGRESS_PID=''
TERM_PENDING=''
on_term() {
    TERM_PENDING=1
    # shellcheck disable=SC2086 # deliberately unquoted: an unset pid must vanish, not empty-arg
    kill -TERM $CLI_PID $REPORTER_PID $PROGRESS_PID 2>/dev/null || true
}
trap on_term TERM INT

node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs >/dev/null 2>&1 &
REPORTER_PID=$!
PROGRESS_DIR="$(mktemp -d)"
PROGRESS_FIFO="$PROGRESS_DIR/events"
mkfifo "$PROGRESS_FIFO"
node "$(dirname "$0")/claude-progress.cjs" < "$PROGRESS_FIFO" &
PROGRESS_PID=$!
# The CLI is forked through a subshell that CLEARS the inherited handler and execs. A background
# child inherits the parent's traps until it execs, so a TERM landing in that sliver runs
# `on_term` IN THE CHILD — which sets a copy of TERM_PENDING nothing reads, and swallows the very
# signal meant to kill it. The child then execs and runs on, and `docker stop` waits out its
# grace period for a CLI that was already told to stop. `exec` keeps $! pointing at the CLI, so
# the wait loop and the `kill -0` probe below are unchanged, and the FIFO redirect stays on the
# subshell, which is the same file descriptor the CLI inherits.
#
# ash and dash — what these images ship — reset the handler themselves and never showed this;
# bash-as-/bin/sh does not, and dropped the signal in 3 of 12 runs of a reduction of this script.
# The entrypoints are run under the host's sh by the offline suite, so "correct only under ash"
# is not good enough for a file whose whole job is to pass a signal on.
(
    trap - TERM INT
    exec claude --output-format stream-json --verbose "$@"
) > "$PROGRESS_FIFO" &
CLI_PID=$!

if [ -n "$TERM_PENDING" ]; then
    # shellcheck disable=SC2086 # same reason as on_term
    kill -TERM $CLI_PID $REPORTER_PID $PROGRESS_PID 2>/dev/null || true
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

# The run is over: stop the sampler and reap it before the close-time sample, which is the
# last thing that runs.
kill -TERM "$REPORTER_PID" 2>/dev/null || true
wait "$REPORTER_PID" 2>/dev/null || true
kill -TERM "$PROGRESS_PID" 2>/dev/null || true
wait "$PROGRESS_PID" 2>/dev/null || true
rm -rf "$PROGRESS_DIR"
node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs --once >/dev/null 2>&1 || true
exit "$STATUS"
