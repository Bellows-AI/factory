#!/bin/sh
# Enter the work directory, then hand every argument to claude.
#
#   docker run ... claude-executor -p 'summarise the diff'
#   docker run ... -e WORKDIR=/workspace/server claude-executor -p '...'
set -eu

WORKDIR="${WORKDIR:-/workspace}"
export WORKDIR

# A volume mounted at CLAUDE_CONFIG_DIR — which is how a full-scope login survives the container,
# and so the only way Remote Control works — starts empty and hides the baked configuration behind
# it. Seed it once from the pristine copy. Keyed on settings.json rather than on the directory being
# empty, since the CLI writes .claude.json before anything else asks a question.
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

# Opt-in, and off by default. The trust dialog is a real prompt with a real question — it also
# warns when the mounted checkout's .claude/settings.local.json pre-approves tool permissions, which
# then apply without asking. An interactive session ("--remote-control") has nobody at the keyboard
# to answer it, so the caller states up front that the mount is trusted; run.sh sets this.
if [ -n "${TRUST_WORKDIR:-}" ] && [ "${TRUST_WORKDIR}" != "0" ]; then
    node -e "
        const fs = require('fs');
        const f = process.env.CLAUDE_CONFIG_DIR + '/.claude.json';
        const c = JSON.parse(fs.readFileSync(f, 'utf8'));
        c.projects = c.projects || {};
        c.projects[process.env.WORKDIR] = {
            ...(c.projects[process.env.WORKDIR] || {}),
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
        };
        fs.writeFileSync(f, JSON.stringify(c, null, 2));
    " || echo "claude-executor: could not pre-accept the trust dialog for $WORKDIR" >&2
fi

# Claude Code's settings.json env block OVERRIDES the container environment — the settings file
# value applies — so the endpoint the driver forwards (OTEL_EXPORTER_OTLP_ENDPOINT) would be
# defeated by the baked http://collector:4318, which only a compose network can resolve. Rewrite
# the settings value when the driver has pointed us elsewhere, the same way the opencode executor
# patches otel.json.
if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
    SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
    if [ -f "$SETTINGS" ]; then
        SETTINGS="$SETTINGS" node -e "
            const fs = require('fs');
            const f = process.env.SETTINGS;
            const c = JSON.parse(fs.readFileSync(f, 'utf8'));
            c.env = c.env || {};
            c.env.OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
            fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
        " || echo "claude-executor: could not rewrite settings.json's OTEL_EXPORTER_OTLP_ENDPOINT" >&2
    fi
fi

exec claude "$@"
