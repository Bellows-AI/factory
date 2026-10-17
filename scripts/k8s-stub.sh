#!/bin/sh
# The kind lane releases a blocked agent only after observing the disruption it is testing.
set -eu
echo "${CLAUDE_CODE_CONFIG_CONTENT:-none}"
echo "$@"
# `factory-stub-mark` (issue #822): the first run marks the worktree's git-ignored .factory/ and goes
# on; a run that finds the mark — a replacement on the tree a lost runner left — says so and ends.
case "$*" in
*factory-stub-mark*)
    if [ -f "$WORKDIR/.factory/stub-mark" ]; then
        echo "mark kept from $(cat "$WORKDIR/.factory/stub-mark") head: $(git -C "$WORKDIR" log -1 --format=%s)"
        exit 0
    fi
    mkdir -p "$WORKDIR/.factory" && echo "${HOSTNAME:-stub}" >"$WORKDIR/.factory/stub-mark"
    ;;
esac
for arg in "$@"; do
    case "$arg" in
    *factory-stub-github*)
        github_exit=0
        node /usr/local/bin/github-credential.cjs token >/dev/null 2>/tmp/github.err || github_exit=$?
        echo "github exit $github_exit"
        cat /tmp/github.err
        grep -q ' /run/factory-github tmpfs ' /proc/mounts && echo 'github cache tmpfs'
        env | grep -q -e '^GITHUB_TOKEN=' -e '^GH_TOKEN=' || echo 'github no env token'
        break
        ;;
    *factory-stub-wait-*)
        release="${arg##*factory-stub-wait-}"
        release="${release%%[!a-zA-Z0-9_./-]*}"
        [ -n "$release" ] || exit 1
        : > "$release.ready-${HOSTNAME:-stub}"
        echo "waiting in ${HOSTNAME:-stub}"
        deadline=$(($(date +%s) + ${FACTORY_STUB_TIMEOUT_SECONDS:-120}))
        while [ ! -f "$release" ]; do
            if [ "$(date +%s)" -ge "$deadline" ]; then
                echo 'stub release timed out' >&2
                exit 1
            fi
            sleep 0.2
        done
        echo "released in ${HOSTNAME:-stub}"
        break
        ;;
    esac
done
