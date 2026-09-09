#!/usr/bin/env bash
# Build the image as opencode-executor-test and smoke-test it.
#
#   docker/opencode-executor/test.sh
#
# Deliberately shallower than docker/claude-executor/test.sh: the pinned version, the baked
# permission policy, the WORKDIR contract, and the fact that no credential ships in the image.
# Deepen it the first time something surprises us.
set -uo pipefail

cd "$(dirname "$0")" || exit 1

IMAGE="opencode-executor-test"
VERSION="$(sed -n 's/^ARG OPENCODE_VERSION=//p' Dockerfile | head -1)"

pass=0
fail=0

ok() {
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
}

bad() {
    printf 'FAIL %s\n     %s\n' "$1" "${2:0:400}"
    fail=$((fail + 1))
}

cleanup() {
    docker image rm -f "$IMAGE" >/dev/null 2>&1
}
trap cleanup EXIT

echo "building $IMAGE"
docker build -q -t "$IMAGE" . >/dev/null || {
    echo 'test.sh: build failed'
    exit 1
}

# The pinned CLI is what answers, not something else on PATH.
got="$(docker run --rm "$IMAGE" --version 2>&1)"
case "$got" in
*"$VERSION"*) ok "the CLI is the pinned $VERSION" ;;
*) bad "the CLI is the pinned $VERSION" "got: $got" ;;
esac

# The baked policy, exactly: permissionless inside the workspace, hard gates outside. "ask" is
# unusable headless — an unanswered ask auto-rejects — so nothing may resolve to it. The read
# allow-all is pinned because opencode seeds a default `*.env.*` deny that once matched a test
# file's name (routes.env.test.ts) and broke a run mid-investigation.
policy="$(docker run --rm --entrypoint sh "$IMAGE" -c 'cat "$OPENCODE_CONFIG"')"
expect_exact() { # expect_exact <name> <json> <dotted.key.path> <want>
    local got
    got="$(node -e 'try { let o = JSON.parse(process.argv[1]); for (const k of process.argv[2].split(".")) o = o?.[k]; process.stdout.write(String(o ?? "")); } catch { process.stdout.write("<unparseable>"); }' \
        "$2" "$3")"
    if [ "$got" = "$4" ]; then ok "$1"; else bad "$1" "$3 wanted '$4', got '$got'"; fi
}
if node -e 'JSON.parse(process.argv[1])' "$policy" >/dev/null 2>&1; then
    ok 'the baked opencode.json parses'
else
    bad 'the baked opencode.json parses' "$policy"
fi
expect_exact 'everything is allowed by default' "$policy" 'permission.*' allow
expect_exact 'read allows every path'           "$policy" 'permission.read.*' allow
expect_exact 'webfetch is denied'               "$policy" 'permission.webfetch' deny
expect_exact 'external paths are denied by default' "$policy" 'permission.external_directory.*' deny
expect_exact 'the runner scratch is reachable'  "$policy" 'permission.external_directory./tmp/*' allow
expect_exact 'home scratch is reachable'        "$policy" 'permission.external_directory./home/node/*' allow

# A missing WORKDIR must refuse in place, not start an agent in the wrong directory.
docker run --rm -e WORKDIR=/nope "$IMAGE" run 'hi' >/dev/null 2>&1
if [ "$?" = "2" ]; then ok 'a missing WORKDIR exits 2'; else bad 'a missing WORKDIR exits 2' 'see above'; fi

# The driver's exact argv shape, through the wrapper: `run <prompt>`. Relies on opencode's
# anonymous free tier, since no credential is baked (checked above). Bounded by timeout(1) where
# the host has one — stock macOS does not — and skipped rather than hung where it does not.
if command -v timeout >/dev/null 2>&1; then
    out="$(timeout 120 docker run --rm "$IMAGE" run 'Reply with exactly: pong' 2>&1 | tail -1)"
    case "$out" in
    *pong*) ok 'a real run answers through the wrapper' ;;
    *) bad 'a real run answers through the wrapper' "last line: $out" ;;
    esac
else
    printf 'skip      a real run answers through the wrapper (no timeout(1) on this host to bound it)\n'
fi

# The image ships with zero credential material — checked directly, not behaviourally: opencode
# answers prompts with no key at all through its own anonymous free tier, so "a run fails without
# a credential" would be a false expectation here. What must never be true is a baked key.
leaked="$(docker inspect -f '{{join .Config.Env "\n"}}' "$IMAGE" |
    grep -E '^(ANTHROPIC|OPENCODE|OPENROUTER|X_AI|GROQ|AZURE)_[A-Z_]*(_KEY|_TOKEN)=' || true)"
if [ -z "$leaked" ]; then
    ok 'no credential is baked into the image env'
else
    bad 'no credential is baked into the image env' "$leaked"
fi
if docker run --rm --entrypoint sh "$IMAGE" \
    -c 'test ! -e "$HOME/.local/share/opencode/auth.json" && test ! -e "$HOME/.local/share/opencode/auth"' 2>/dev/null; then
    ok 'no baked auth file in the opencode data directory'
else
    bad 'no baked auth file in the opencode data directory' 'auth.json exists in the image'
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
