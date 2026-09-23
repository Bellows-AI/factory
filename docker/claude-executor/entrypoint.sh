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
node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs >/dev/null 2>&1 &
REPORTER_PID=$!
PROGRESS_DIR="$(mktemp -d)"
PROGRESS_FIFO="$PROGRESS_DIR/events"
mkfifo "$PROGRESS_FIFO"
node "$(dirname "$0")/claude-progress.cjs" < "$PROGRESS_FIFO" &
PROGRESS_PID=$!
claude --output-format stream-json --verbose "$@" > "$PROGRESS_FIFO" &
CLI_PID=$!

on_term() {
    kill -TERM "$CLI_PID" "$REPORTER_PID" "$PROGRESS_PID" 2>/dev/null || true
}
trap on_term TERM INT

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
