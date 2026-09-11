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

# The driver points XDG_DATA_HOME at a per-member directory on the workspaces volume so the
# session database outlives the container — that persistence is what makes a follow-up's
# `--session <id>` resumable at all. The directory may not exist yet for a member's first run;
# create it rather than letting the first run fail inside opencode's own setup.
if [ -n "${XDG_DATA_HOME:-}" ]; then
    mkdir -p "$XDG_DATA_HOME"

    # The driver's shape is <mount>/<org>/<user>/.opencode, so the member's own tree — checkouts,
    # .worktrees, .opencode — is derivable here. The baked fence denies everything outside the
    # working directory because the volume under the mount is shared by every member; the one
    # subtree a run may always operate in is its own member's. `**` rather than `*`: the allow
    # must cross "/" and reach the dot-directories the tree is made of. A path without the
    # driver's shape patches nothing — standalone runs keep the fence as baked.
    case "$XDG_DATA_HOME" in
    */.opencode)
        MEMBER_ROOT="${XDG_DATA_HOME%/.opencode}"
        OPENCODE_JSON="$HOME/.config/opencode/opencode.json"
        if [ -f "$OPENCODE_JSON" ]; then
            MEMBER_ROOT="$MEMBER_ROOT" OPENCODE_JSON="$OPENCODE_JSON" node -e "
                const fs = require('fs');
                const f = process.env.OPENCODE_JSON;
                const c = JSON.parse(fs.readFileSync(f, 'utf8'));
                c.permission ??= {};
                c.permission.external_directory ??= {};
                c.permission.external_directory[process.env.MEMBER_ROOT + '/**'] = 'allow';
                fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
            " || echo "opencode-executor: could not allow $MEMBER_ROOT in opencode.json" >&2
        fi
        ;;
    esac
fi

# The opencode-otel plugin reads its endpoint from otel.json, not from OTEL_EXPORTER_OTLP_ENDPOINT.
# The driver overrides that env var via RUNNER_OTEL_ENDPOINT so the executor's baked endpoint
# (http://collector:4318) can be redirected — for instance to a collector that the compose network
# cannot name. Patch the file here so the plugin picks up the override.
if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
    OTEL_JSON="$HOME/.config/opencode/otel.json"
    if [ -f "$OTEL_JSON" ]; then
        OTEL_JSON="$OTEL_JSON" node -e "
            const fs = require('fs');
            const f = process.env.OTEL_JSON;
            const c = JSON.parse(fs.readFileSync(f, 'utf8'));
            c.endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
            fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
        " || echo "opencode-executor: could not patch otel.json for $OTEL_EXPORTER_OTLP_ENDPOINT" >&2
    fi
fi

# The branch reporter samples session -> (repo, branch) beside the run, so the board can
# attribute the session's tokens to a PR. A background SIBLING of the CLI, never its child — a
# CLI crash must not take the reporter down mid-run — with stdio discarded: the output stream
# this container prints is the run's, and the reporter never speaks. The CLI moves from exec
# to foreground child so one close-time sample can run after it; the exit status is captured
# and re-raised, which is the one behavior exec had that must survive.
node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs >/dev/null 2>&1 &
set +e
opencode "$@"
STATUS=$?
set -e
node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs --once >/dev/null 2>&1 || true
exit "$STATUS"
