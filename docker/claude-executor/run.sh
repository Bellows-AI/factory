#!/usr/bin/env bash
# Start a Remote Control session in the container, against the current directory.
#
#   docker/claude-executor/run.sh login           # once: sign in to claude.ai
#   docker/claude-executor/run.sh                 # session named after the directory
#   docker/claude-executor/run.sh my-session
#   TARGET=~/src/api docker/claude-executor/run.sh
#
# Remote Control needs a FULL-SCOPE claude.ai login. The CLAUDE_CODE_OAUTH_TOKEN in .env is not one:
# `claude setup-token` mints a model-requests-only token, and a session started with it silently
# degrades to an ordinary local session. So this script does not pass that token at all — it mounts
# a named volume holding the login instead, and `run.sh login` is how the login gets there.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${IMAGE:-claude-executor}"
VOLUME="${AUTH_VOLUME:-claude-executor-auth}"
TARGET="$(cd "${TARGET:-$PWD}" && pwd)"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "building $IMAGE"
    docker build -q --build-context skills="$HERE/../skills" -t "$IMAGE" "$HERE" >/dev/null
fi

# The volume holds the credential and the account record. Both live under CLAUDE_CONFIG_DIR, so the
# whole directory is the volume, and the entrypoint seeds it from the image on first use.
mount=(-v "$VOLUME:/home/node/.claude")

if [[ "${1:-}" == "login" ]]; then
    echo "Signing in to claude.ai. The browser cannot reach the container's callback, so the CLI"
    echo "will print a URL: open it on this machine, then paste the code back at the prompt."
    exec docker run --rm -it "${mount[@]}" -v "$TARGET:/workspace" "$IMAGE" auth login
fi

if ! docker run --rm "${mount[@]}" --entrypoint test "$IMAGE" -f /home/node/.claude/.credentials.json; then
    echo "run.sh: no claude.ai login in volume '$VOLUME'." >&2
    echo "Remote Control requires a full-scope login — the .env token cannot establish one." >&2
    echo "Run: $0 login" >&2
    exit 2
fi

SESSION="${1:-$(basename "$TARGET")}"
[ $# -gt 0 ] && shift

echo "remote control: $SESSION   workdir: $TARGET"

# TRUST_WORKDIR answers the trust dialog for the mount, which an interactive session has nobody to
# answer. Mounting a directory here is that decision already; see the README for what it implies
# when the checkout ships a .claude/settings.local.json.
exec docker run --rm -it \
    -e TRUST_WORKDIR=1 \
    "${mount[@]}" \
    -v "$TARGET:/workspace" \
    "$IMAGE" --remote-control "$SESSION" "$@"
