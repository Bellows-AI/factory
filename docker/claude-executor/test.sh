#!/usr/bin/env bash
# Build the image and exercise it against this repo as the mounted checkout.
#
#   docker/claude-executor/test.sh
#
# Offline by default: no token, no network beyond the build. With
# CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment it also runs one real prompt.
set -uo pipefail

IMAGE="${IMAGE:-claude-executor-test}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

pass=0
fail=0

check() { # check <name> <expected substring> <docker args...>
    local name="$1" want="$2"
    shift 2
    local got
    got="$("$@" 2>&1)"
    if [[ "$got" == *"$want"* ]]; then
        printf 'ok   %s\n' "$name"
        pass=$((pass + 1))
    else
        printf 'FAIL %s\n     want substring: %s\n     got: %s\n' "$name" "$want" "${got:0:400}"
        fail=$((fail + 1))
    fi
}

echo "building $IMAGE"
docker build -q --build-context skills="$HERE/../skills" -t "$IMAGE" "$HERE" >/dev/null || { echo "build failed"; exit 1; }

run() { docker run --rm -v "$REPO:/workspace" "$@"; }

check 'claude runs'            'Claude Code'      run "$IMAGE" --version
check 'acli installed'         'acli version'     run --entrypoint acli "$IMAGE" --version
check 'gh installed'           'gh version'       run --entrypoint gh "$IMAGE" --version
check 'plugin enabled'         'context-mode'     run --entrypoint claude "$IMAGE" plugin list
check 'CLAUDE.md present'      'Agent guide'      run --entrypoint head "$IMAGE" -1 /home/node/.claude/CLAUDE.md
check 'skills present'         'backend-fix'      run --entrypoint ls "$IMAGE" /home/node/.claude/skills

# The entrypoint's own contract: land in $WORKDIR, refuse a missing one.
check 'defaults to /workspace' '/workspace'       run --entrypoint sh "$IMAGE" -c 'pwd'
check 'honours WORKDIR'        '/workspace/server' run -e WORKDIR=/workspace/server --entrypoint sh "$IMAGE" -c \
    'cd "$WORKDIR" && pwd'
check 'rejects bad WORKDIR'    'does not exist'   run -e WORKDIR=/nope "$IMAGE" --version

# A prompt an unattended container cannot answer, settled at build time.
check 'onboarding done'   'true'  run --entrypoint node "$IMAGE" -e \
    'console.log(require(process.env.CLAUDE_CONFIG_DIR + "/.claude.json").hasCompletedOnboarding)'

# The driver's RUNNER_OTEL_ENDPOINT override arrives as OTEL_EXPORTER_OTLP_ENDPOINT. Claude Code's
# settings env blocks override the container environment, so the forwarded value would be silently
# defeated by the baked http://collector:4318 — the entrypoint rewrites the managed settings value
# when it is set, the same way the opencode executor patches otel.json. The managed file is
# bind-mounted so the patched copy can be read back on the host; `--version` runs the entrypoint's
# rewrite then exits the CLI with no credential needed.
MANAGED="$(mktemp -d)"
cp "$HERE/managed-settings.json" "$MANAGED/managed-settings.json"
chmod -R a+rwX "$MANAGED"
docker run --rm \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318 \
    -v "$MANAGED/managed-settings.json:/etc/claude-code/managed-settings.json" \
    -v "$REPO:/workspace" \
    "$IMAGE" --version >/dev/null 2>&1
patched="$(cat "$MANAGED/managed-settings.json")"
rm -rf "$MANAGED"
if node -e \
    'const c = JSON.parse(process.argv[1]); process.exit(c?.env?.OTEL_EXPORTER_OTLP_ENDPOINT === "http://collector.example:4318" ? 0 : 1)' \
    "$patched" >/dev/null 2>&1; then
    printf 'ok   %s\n' 'the entrypoint rewrites managed-settings.json from OTEL_EXPORTER_OTLP_ENDPOINT'
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     patched settings: %s\n' 'the entrypoint rewrites managed-settings.json from OTEL_EXPORTER_OTLP_ENDPOINT' "$patched"
    fail=$((fail + 1))
fi

# The checkout's own .claude/settings.json must not steer telemetry. A target repo that points
# OTEL_EXPORTER_OTLP_ENDPOINT at 127.0.0.1:4318 for host development used to win over the runner's
# user-scope value, so every export went to the container's loopback and was lost without a word.
# Proved against the real CLI: two sinks inside the container, the checkout pointing at one, the
# driver's endpoint at the other. The CLI exports its startup metrics even unauthenticated, so no
# credential is needed; only the forwarded endpoint may receive anything.
CHECKOUT="$(mktemp -d)"
mkdir -p "$CHECKOUT/.claude"
printf '{"env":{"OTEL_EXPORTER_OTLP_ENDPOINT":"http://127.0.0.1:4318"}}\n' > "$CHECKOUT/.claude/settings.json"
chmod -R a+rwX "$CHECKOUT"
SINK='for (const p of [4318, 4999]) require("http").createServer((q, r) => { console.log("SINK:" + p); q.resume(); q.on("end", () => r.end("{}")); }).listen(p)'
sinks="$(docker run --rm \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4999 \
    -v "$CHECKOUT:/workspace" \
    --entrypoint sh "$IMAGE" -c "node -e '$SINK' & sleep 1; timeout 30 claude-executor -p hello >/dev/null 2>&1; sleep 12" 2>&1)"
rm -rf "$CHECKOUT"
if [[ "$sinks" == *"SINK:4999"* && "$sinks" != *"SINK:4318"* ]]; then
    printf 'ok   %s\n' "the checkout's .claude/settings.json cannot redirect telemetry"
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     sinks: %s\n' "the checkout's .claude/settings.json cannot redirect telemetry" "${sinks:0:400}"
    fail=$((fail + 1))
fi

# An empty CLAUDE_CONFIG_DIR — the transcript store's per-thread directory, or a volume mounted over
# the baked configuration — hides everything baked. Seeding is therefore load-bearing, not a nicety.
VOL="claude-executor-test-$$"
check 'seeds an empty volume' 'backend-fix' docker run --rm -v "$VOL:/home/node/.claude" \
    --entrypoint sh "$IMAGE" -c 'claude-executor --version >/dev/null; ls "$CLAUDE_CONFIG_DIR"/skills'
check 'seeding is idempotent' 'ok' docker run --rm -v "$VOL:/home/node/.claude" \
    --entrypoint sh "$IMAGE" -c 'claude-executor --version >/dev/null; echo marker > "$CLAUDE_CONFIG_DIR"/keep; claude-executor --version >/dev/null; [ -f "$CLAUDE_CONFIG_DIR"/keep ] && echo ok'
docker volume rm "$VOL" >/dev/null 2>&1

# A bind mount carries the host uid, so without safe.directory git refuses the repository outright.
# Note the single line: a backslash continuation inside single quotes is a literal backslash, not a
# continuation, and the container would receive a broken script that fails silently.
check 'git reads the mount' 'true' run --entrypoint sh "$IMAGE" -c 'claude-executor --version >/dev/null; git rev-parse --is-inside-work-tree'

# The git guard: the PreToolUse hook that keeps the task worktree's checkout on its branch
# (issue #73). Its case table lives in the script and is pinned offline by vitest too — here it
# must hold in the BAKED copy, speak the real stdin/stdout hook protocol, and be wired in the
# baked settings.json.
check 'the guard script is executable' 'ok' run --entrypoint sh "$IMAGE" -c 'test -x /usr/local/bin/git-guard.cjs && echo ok'
check 'the guard case table holds in the image' 'GUARD-TABLE-OK' \
    run --entrypoint node "$IMAGE" /usr/local/bin/git-guard.cjs --selftest
check 'the guard denies over the hook protocol' '"permissionDecision":"deny"' \
    run --entrypoint sh "$IMAGE" -c \
    'node -e "process.stdout.write(JSON.stringify({tool_name:\"Bash\",tool_input:{command:\"git switch main\"}}))" | node /usr/local/bin/git-guard.cjs'
check 'the guard allows merging origin tracking refs' '' \
    run --entrypoint sh "$IMAGE" -c \
    'node -e "process.stdout.write(JSON.stringify({tool_name:\"Bash\",tool_input:{command:\"git merge --no-edit origin/main\"}}))" | node /usr/local/bin/git-guard.cjs'
check 'settings.json wires the guard hook' 'git-guard.cjs' \
    run --entrypoint cat "$IMAGE" /home/node/.claude/settings.json

# The plugin's MCP server has to answer over stdio, not merely be installed.
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
check 'context-mode responds' '"name":"context-mode"' run -i --entrypoint sh "$IMAGE" -c "p=\$(ls -d \"\$CLAUDE_CONFIG_DIR\"/plugins/cache/context-mode/context-mode/*/); echo '$MCP_INIT' | timeout 60 node \"\${p}start.mjs\""

# The login refusal is an assertion in its own right, and the only one that proves no credential
# was baked into the image. It runs whether or not a token is available, with the token withheld.
check 'unauthenticated by design' 'Not logged in' run "$IMAGE" -p 'hello'

# Fall back to the repo's .env for the live prompt, reading only that one key.
token="${CLAUDE_CODE_OAUTH_TOKEN:-}"
if [[ -z "$token" && -f "$REPO/.env" ]]; then
    token="$(grep -m1 -E '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN=' "$REPO/.env" | cut -d= -f2- | tr -d '"'\''' | xargs)"
fi

if [[ -n "${token}${ANTHROPIC_API_KEY:-}" ]]; then
    check 'answers a prompt' 'EXECUTOR_OK' \
        run -e CLAUDE_CODE_OAUTH_TOKEN="$token" -e ANTHROPIC_API_KEY "$IMAGE" \
        -p 'Reply with exactly EXECUTOR_OK and nothing else.'
else
    echo 'note: no token in the environment or .env — skipped the live prompt'
fi

# The member's own executor config (CLAUDE_CODE_CONFIG_CONTENT, #212): model and env additions
# merge into the baked settings.json, but a member cannot use it to strip the runner's hooks/
# plugins fence. Telemetry keys a member sets land in user scope and lose to managed settings, so
# the merge never touches managed-settings.json.
CNF="$(mktemp -d)"
cp "$HERE/claude-home/settings.json" "$CNF/settings.json"
printf '{"hasCompletedOnboarding":true,"theme":"dark"}\n' > "$CNF/.claude.json"
chmod -R a+rwX "$CNF"
MEMBER_CONFIG='{"model":"claude-member-model","hooks":{"PreToolUse":[]},"enabledPlugins":["evil"],"extraKnownMarketplaces":["evil"],"env":{"CLAUDE_CODE_ENABLE_TELEMETRY":"0","OTEL_LOG_USER_PROMPTS":"1","OTEL_EXPORTER_OTLP_ENDPOINT":"http://member-supplied:4318","ANTHROPIC_API_KEY":"member-token"}}'
docker run --rm \
    -e CLAUDE_CONFIG_DIR=/claude-member-test \
    -e CLAUDE_CODE_CONFIG_CONTENT="$MEMBER_CONFIG" \
    -e OTEL_EXPORTER_OTLP_ENDPOINT=http://collector.example:4318 \
    -v "$CNF:/claude-member-test" \
    -v "$REPO:/workspace" \
    --entrypoint sh "$IMAGE" -c 'claude-executor --version >/dev/null 2>&1; cp /etc/claude-code/managed-settings.json "$CLAUDE_CONFIG_DIR/managed.out"'
patched="$(cat "$CNF/settings.json")"
managed="$(cat "$CNF/managed.out")"
rm -rf "$CNF"
if node -e '
    const c = JSON.parse(process.argv[1]);
    const m = JSON.parse(process.argv[3]);
    const ok =
        c.model === "claude-member-model" &&
        c.env.ANTHROPIC_API_KEY === "member-token" &&
        c.enabledPlugins === undefined &&
        c.extraKnownMarketplaces === undefined &&
        JSON.stringify(c.hooks) === JSON.stringify(require(process.argv[2]).hooks) &&
        m.env.CLAUDE_CODE_ENABLE_TELEMETRY === "1" &&
        m.env.OTEL_LOG_USER_PROMPTS === "0" &&
        m.env.OTEL_EXPORTER_OTLP_ENDPOINT === "http://collector.example:4318";
    process.exit(ok ? 0 : 1);
' "$patched" "$HERE/claude-home/settings.json" "$managed" >/dev/null 2>&1; then
    printf 'ok   %s\n' 'CLAUDE_CODE_CONFIG_CONTENT merges member settings without touching managed telemetry, hooks or plugins'
    pass=$((pass + 1))
else
    printf 'FAIL %s\n     patched settings: %s\n     managed: %s\n' 'CLAUDE_CODE_CONFIG_CONTENT merges member settings without touching managed telemetry, hooks or plugins' "$patched" "$managed"
    fail=$((fail + 1))
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
