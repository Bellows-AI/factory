#!/usr/bin/env bash
# Build the image as opencode-executor-test and smoke-test it.
#
#   docker/opencode-executor/test.sh
#
# Deliberately shallower than docker/claude-executor/test.sh: the pinned version, the baked
# permission policy, the baked telemetry wiring, the WORKDIR contract, and the fact that no
# credential ships in the image. Deepen it the first time something surprises us.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

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

# The telemetry surface is baked, not fetched at runtime: the plugin package must exist in the
# image and the baked config must wire it to the compose collector. opencode would silently slurp
# the plugin from npm on first run otherwise, which is slow and not reproducible.
if docker run --rm --entrypoint sh "$IMAGE" -c \
    'test -f /usr/local/lib/node_modules/@gcornut/opencode-otel/dist/index.js'; then
    ok 'the OTLP telemetry plugin is baked into the image'
else
    bad 'the OTLP telemetry plugin is baked into the image' 'missing @gcornut/opencode-otel under /usr/local/lib/node_modules'
fi
if node -e \
    'const o = JSON.parse(process.argv[1]); process.exit(Array.isArray(o?.plugin) && o.plugin.includes("/usr/local/lib/node_modules/@gcornut/opencode-otel") ? 0 : 1)' \
    "$policy" >/dev/null 2>&1; then
    ok 'the baked opencode.json enables the telemetry plugin'
else
    bad 'the baked opencode.json enables the telemetry plugin' 'plugin array does not reference the baked package'
fi
otel="$(docker run --rm --entrypoint sh "$IMAGE" \
    -c 'cat "$XDG_CONFIG_HOME/opencode/otel.json"')"
if node -e \
    'try { const o = JSON.parse(process.argv[1]); process.exit(o.endpoint === "http://collector:4318" && o.protocol === "http/json" ? 0 : 1); } catch { process.exit(1); }' \
    "$otel" >/dev/null 2>&1; then
    ok 'otel.json points at the compose collector'
else
    bad 'otel.json points at the compose collector' "$otel"
fi

# The context-mode plugin (https://github.com/mksglu/context-mode) is baked the same way as the
# telemetry plugin: pinned package, absolute-path plugin entry. The native module must be present —
# it resolves through install scripts, so a missing better_sqlite3.node means the install was run
# with scripts disabled and the plugin will fail at run time. No `mcp.context-mode` entry may sit
# beside the plugin entry: the loader then registers zero ctx_* tools (upstream-documented trap).
# Static by intent — these assertions police the bake, not the load: opencode treats a plugin that
# throws during init as log-and-continue, so catching that would take a live-LLM assertion, which
# this suite refuses. The pinned-version assertion exists so a bump is a deliberate act.
CONTEXT_MODE_VERSION="$(sed -n 's/^ARG CONTEXT_MODE_VERSION=//p' Dockerfile | head -1)"
if [ -n "$CONTEXT_MODE_VERSION" ]; then
    ok "the context-mode ARG is pinned ($CONTEXT_MODE_VERSION)"
else
    bad 'the context-mode ARG is pinned' 'no ARG CONTEXT_MODE_VERSION line in the Dockerfile'
fi
got="$(docker run --rm --entrypoint node "$IMAGE" \
    -p 'require("/usr/local/lib/node_modules/context-mode/package.json").version' 2>&1)"
if [ "$got" = "$CONTEXT_MODE_VERSION" ]; then
    ok 'the baked context-mode is the pinned version'
else
    bad 'the baked context-mode is the pinned version' "wanted '$CONTEXT_MODE_VERSION', got: $got"
fi
if docker run --rm --entrypoint sh "$IMAGE" -c \
    'test -f /usr/local/lib/node_modules/context-mode/build/adapters/opencode/plugin.js'; then
    ok 'the context-mode opencode plugin entrypoint is baked into the image'
else
    bad 'the context-mode opencode plugin entrypoint is baked into the image' \
        'missing build/adapters/opencode/plugin.js under /usr/local/lib/node_modules/context-mode'
fi
if docker run --rm --entrypoint sh "$IMAGE" -c \
    'test -n "$(find /usr/local/lib/node_modules/context-mode -name better_sqlite3.node -print -quit)"'; then
    ok 'the context-mode native module is built in the image'
else
    bad 'the context-mode native module is built in the image' \
        'no better_sqlite3.node under /usr/local/lib/node_modules/context-mode'
fi
if node -e \
    'const o = JSON.parse(process.argv[1]); process.exit(Array.isArray(o?.plugin) && o.plugin.includes("/usr/local/lib/node_modules/context-mode") ? 0 : 1)' \
    "$policy" >/dev/null 2>&1; then
    ok 'the baked opencode.json enables the context-mode plugin'
else
    bad 'the baked opencode.json enables the context-mode plugin' 'plugin array does not reference the baked package'
fi
if node -e \
    'const o = JSON.parse(process.argv[1]); process.exit(o?.mcp && "context-mode" in o.mcp ? 1 : 0)' \
    "$policy" >/dev/null 2>&1; then
    ok 'no mcp.context-mode entry beside the plugin entry'
else
    bad 'no mcp.context-mode entry beside the plugin entry' 'a plugin entry and an mcp.context-mode entry together register zero ctx_* tools'
fi

# The driver's RUNNER_OTEL_ENDPOINT override arrives as OTEL_EXPORTER_OTLP_ENDPOINT, which the
# opencode-otel plugin does not read — the entrypoint patches otel.json when it is set. The config
# directory is bind-mounted so the patched file can be read back on the host; `--help` runs the
# entrypoint's patch then exits the agent with no credential needed.
CNF="$(mktemp -d)"
cp "$HERE/opencode-home/otel.json" "$CNF/otel.json"
chmod -R a+rwX "$CNF"
docker run --rm \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318 \
    -v "$CNF:/home/node/.config/opencode" \
    "$IMAGE" --help >/dev/null 2>&1
patched="$(cat "$CNF/otel.json")"
rm -rf "$CNF"
if node -e \
    'try { const o = JSON.parse(process.argv[1]); process.exit(o.endpoint === "http://collector.example:4318" ? 0 : 1); } catch { process.exit(1); }' \
    "$patched" >/dev/null 2>&1; then
    ok 'the entrypoint rewrites otel.json from OTEL_EXPORTER_OTLP_ENDPOINT'
else
    bad 'the entrypoint rewrites otel.json from OTEL_EXPORTER_OTLP_ENDPOINT' "$patched"
fi

# The task workspace allow: the driver's XDG_DATA_HOME names the member tree on the shared
# workspaces volume, and the entrypoint opens exactly that subtree in the baked fence — `**`,
# because the allow must reach the tree's dot-directories. Config bind-mounted so the patched
# file reads back on the host; `--help` runs the patch then exits with no credential needed.
CNF="$(mktemp -d)"
cp "$HERE/opencode-home/opencode.json" "$CNF/opencode.json"
chmod -R a+rwX "$CNF"
WS="$(mktemp -d)"
chmod -R a+rwX "$WS"
# The member tree is mounted writable, as the driver mounts the workspaces volume: the entrypoint
# creates the data directory in it, and a mkdir that cannot happen must fail loudly, not skip the
# patch in silence.
docker run --rm \
    -e XDG_DATA_HOME=/workspaces/org/uuid/.opencode \
    -v "$CNF:/home/node/.config/opencode" \
    -v "$WS:/workspaces/org/uuid" \
    "$IMAGE" --help >/dev/null 2>&1
patched="$(cat "$CNF/opencode.json")"
rm -rf "$CNF" "$WS"
if node -e \
    'try { const o = JSON.parse(process.argv[1]).permission.external_directory; process.exit(o["/workspaces/org/uuid/**"] === "allow" && o["*"] === "deny" ? 0 : 1); } catch { process.exit(1); }' \
    "$patched" >/dev/null 2>&1; then
    ok 'the entrypoint allows the member tree from XDG_DATA_HOME'
else
    bad 'the entrypoint allows the member tree from XDG_DATA_HOME' "$patched"
fi

# The fence is not loosened for a data directory that is not the driver's shape: a standalone run
# that merely points XDG_DATA_HOME somewhere keeps the deny-everything default.
CNF="$(mktemp -d)"
cp "$HERE/opencode-home/opencode.json" "$CNF/opencode.json"
chmod -R a+rwX "$CNF"
docker run --rm \
    -e XDG_DATA_HOME=/tmp/just-data \
    -v "$CNF:/home/node/.config/opencode" \
    "$IMAGE" --help >/dev/null 2>&1
unpatched="$(cat "$CNF/opencode.json")"
rm -rf "$CNF"
if node -e \
    'try { const o = JSON.parse(process.argv[1]).permission.external_directory; process.exit(o["*"] === "deny" && !Object.keys(o).some((k) => k.endsWith("/**")) ? 0 : 1); } catch { process.exit(1); }' \
    "$unpatched" >/dev/null 2>&1; then
    ok 'the fence stays as baked without the driver-shaped XDG_DATA_HOME'
else
    bad 'the fence stays as baked without the driver-shaped XDG_DATA_HOME' "$unpatched"
fi

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
