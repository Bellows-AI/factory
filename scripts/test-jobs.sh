#!/usr/bin/env bash
# End-to-end for the job board and its driver.
#
#   scripts/test-jobs.sh
#
# Real HTTP, a real database and real containers — but no Claude and no credential. The runners are
# four throwaway stub images — two whose entrypoints echo and exit (proving the whole path: the
# prompt reaches the container, the exit code and output come back, and the board records them),
# plus a service stub and a runner-exec stub for the services phase.
#
# Everything it creates it removes: a *_test database, four stub images, one volume, two processes.
#
# Needs: docker (with the compose stack's timescale reachable) and node. No jq, no curl.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

PORT="${PORT:-8129}"
BASE="http://127.0.0.1:$PORT"
DB="${JOBS_TEST_DB:-factory_jobs_test}"
DATABASE_URL="postgres://factory:factory@127.0.0.1:5432/$DB"
IMAGE_OK="factory-jobs-smoke-ok"
IMAGE_FAIL="factory-jobs-smoke-fail"
IMAGE_SVC="factory-jobs-smoke-svc"
IMAGE_RUN="factory-jobs-smoke-run"
VOLUME="factory-jobs-smoke-workspaces"

pass=0
fail=0
server_pid=""
driver_pid=""
db_created=""
work="$(mktemp -d)"

ok() {
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
}

bad() {
    printf 'FAIL %s\n     %s\n' "$1" "${2:0:400}"
    fail=$((fail + 1))
}

cleanup() {
    [ -n "$driver_pid" ] && kill "$driver_pid" 2>/dev/null
    [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
    wait 2>/dev/null
    # Only ever drops a database this run created, and only one named *_test.
    if [ -n "$db_created" ]; then
        docker compose exec -T timescale psql -U factory -d postgres \
            -c "drop database if exists $DB" >/dev/null 2>&1
    fi
    docker volume rm "$VOLUME" >/dev/null 2>&1
    docker image rm -f "$IMAGE_OK" "$IMAGE_FAIL" "$IMAGE_SVC" "$IMAGE_RUN" >/dev/null 2>&1
    rm -rf "$work"
}
trap cleanup EXIT

# --- HTTP, in node, so the script needs neither curl nor jq ----------------------------------

# BASE and AUTH_HEADER are read from the environment, so a single call can be aimed at the
# authenticated board or carry a worker token without every existing call site growing two
# arguments it does not use.
api() { # api METHOD PATH [json] -> "<status>\t<body>"
    node -e '
const [base, method, path, body, auth] = process.argv.slice(1);
fetch(base + path, {
    method,
    headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(auth ? { authorization: auth } : {}),
    },
    body: body || undefined,
})
    .then(async (r) => process.stdout.write(r.status + "\t" + (await r.text()).replace(/\s+/g, " ")))
    .catch((e) => process.stdout.write("000\t" + e.message));
' "$BASE" "$1" "$2" "${3:-}" "${AUTH_HEADER:-}"
}

status() { printf '%s' "${1%%$'\t'*}"; }
body() { printf '%s' "${1#*$'\t'}"; }

field() { # field <json> <key>
    node -e 'try { const o = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(o[process.argv[2]] ?? "")); } catch { process.stdout.write(""); }' \
        "$1" "$2"
}

expect_status() { # expect_status <name> <want> <method> <path> [json]
    local name="$1" want="$2"
    shift 2
    local out got
    out="$(api "$@")"
    got="$(status "$out")"
    if [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "wanted $want, got $got: $(body "$out")"; fi
}

expect_status_at() { # expect_status_at <base> <name> <want> <method> <path> [json]
    local base="$1"
    shift
    BASE="$base" expect_status "$@"
}

expect_field() { # expect_field <name> <json> <key> <want>
    local got
    got="$(field "$2" "$3")"
    if [ "$got" = "$4" ]; then ok "$1"; else bad "$1" "$3 wanted '$4', got '$got'"; fi
}

expect_contains() { # expect_contains <name> <haystack> <needle>
    case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" "wanted substring '$3' in: $2" ;;
    esac
}

create_job() { # create_job <command> -> id, recorded in $work/created-jobs for the teardown sweep
    local id
    id="$(field "$(body "$(api POST /api/jobs "{\"command\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1")}")")" id)"
    # A file, not a variable: every caller captures this function's output by command substitution,
    # which runs it in a subshell — an assignment here would be thrown away.
    printf '%s\n' "$id" >>"$work/created-jobs"
    printf '%s' "$id"
}

settled() { # settled <id> -> status once it is no longer queued/running, empty otherwise
    local s
    s="$(field "$(body "$(api GET "/api/jobs/$1")")" status)"
    case "$s" in
    queued | running) printf '' ;;
    *) printf '%s' "$s" ;;
    esac
}

await_settled() { # await_settled <id> [seconds] -> final status, or empty on timeout
    local id="$1" limit="${2:-60}" i=0 s=""
    while [ "$i" -lt "$limit" ]; do
        s="$(settled "$id")"
        [ -n "$s" ] && {
            printf '%s' "$s"
            return
        }
        sleep 1
        i=$((i + 1))
    done
    printf ''
}

# --- Bring up everything it needs -------------------------------------------------------------

command -v docker >/dev/null || {
    echo 'test-jobs: docker is required'
    exit 1
}

echo 'starting timescale'
docker compose up -d timescale >/dev/null 2>&1
for _ in $(seq 1 30); do
    docker compose exec -T timescale pg_isready -U factory >/dev/null 2>&1 && break
    sleep 1
done

# The name ends in _test on purpose: it marks the database disposable, and the drop in cleanup()
# refuses anything this run did not create.
if docker compose exec -T timescale psql -U factory -d postgres -tAc \
    "select 1 from pg_database where datname = '$DB'" 2>/dev/null | grep -q 1; then
    echo "reusing database $DB"
else
    docker compose exec -T timescale psql -U factory -d postgres -c "create database $DB" >/dev/null 2>&1 ||
        {
            echo "test-jobs: could not create $DB"
            exit 1
        }
    db_created=1
fi

echo 'building core, server, driver'
npm run build -w core >/dev/null 2>&1 && npm run build -w server >/dev/null 2>&1 &&
    npm run build -w driver >/dev/null 2>&1 || {
    echo 'test-jobs: build failed'
    exit 1
}

echo 'building the stub runner images'
# The OK stub prints two env probes BEFORE echoing its arguments, so the output proves both the
# argv path (prompt, session id) and the env path (the claim's stacked environment) reached the
# container.
printf 'FROM alpine:3\nENTRYPOINT ["sh","-c","echo $FACTORY_ENV_PROBE; echo $SECRET_PROBE; echo \\"$@\\"","sh"]\n' >"$work/Dockerfile.ok"
printf 'FROM alpine:3\nENTRYPOINT ["sh","-c","echo boom >&2; exit 3"]\n' >"$work/Dockerfile.fail"
docker build -q -t "$IMAGE_OK" -f "$work/Dockerfile.ok" "$work" >/dev/null &&
    docker build -q -t "$IMAGE_FAIL" -f "$work/Dockerfile.fail" "$work" >/dev/null || {
    echo 'test-jobs: could not build the stub images'
    exit 1
}

# A workspace root IS set, under $work, and it has to be: with none, the board reports a null
# `workspacePath` on every claim and the driver fails each job rather than guessing a directory.
# Nothing is cloned into it — clones only happen when somebody selects repositories — so this costs
# one empty directory per job author.

# Both boards boot the OFFLINE entry (server/dist/offline.js) — the same server built with the
# code-only no-fetch arm, which is what lets them run with no App credential at all and against a
# disposable database name. It drives the whole lease protocol with no credential anywhere.

echo "starting the board on $BASE"
env DATABASE_URL="$DATABASE_URL" PORT="$PORT" HOST=127.0.0.1 \
    ORG_WORKSPACE_ROOT="$work/workspaces" \
    node server/dist/offline.js >"$work/server.log" 2>&1 &
server_pid=$!

up=""
for _ in $(seq 1 40); do
    [ "$(status "$(api GET /api/health)")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done
[ -n "$up" ] || {
    echo 'test-jobs: the board never came up'
    tail -20 "$work/server.log"
    exit 1
}

# --- The board on its own --------------------------------------------------------------------

echo
echo '# board'

# The queue is FIFO, so every check below depends on what is already in it. A reused database, or
# a job left by a failed run, would otherwise hand the claim a different job than the one under
# test — which reads as a broken lease rather than a dirty fixture. workflow is truncated with it:
# the board seeds the org-default `fix-issue` at boot, and a default here would make every
# workflow-less queue below walk the graph instead of the pipeline these phases pin.
docker compose exec -T timescale psql -U factory -d "$DB" -c 'truncate job, workflow' >/dev/null 2>&1

expect_status 'health answers'            200 GET /api/health
expect_status 'refuses an empty command'  400 POST /api/jobs '{"command":""}'
expect_status 'refuses a malformed id'    400 GET '/api/jobs/not-a-uuid'
expect_status 'unknown job is 404'        404 GET '/api/jobs/00000000-0000-4000-8000-000000000000'
expect_status 'refuses an unknown status' 400 GET '/api/jobs?status=pending'

# The runner environment, configured the way the UI would: one plain variable and one secret on the
# org ("core") scope. AUTH_MODE=none resolves the stand-in admin, so the PUT is allowed.
expect_status 'puts the core env' 200 PUT /api/env/org \
    '{"vars":[{"name":"FACTORY_ENV_PROBE","value":"org-marker","isSecret":false},{"name":"SECRET_PROBE","value":"secret-marker","isSecret":true}]}'
expect_status 'refuses an env name that is not a name' 400 PUT /api/env/org \
    '{"vars":[{"name":"not a name","value":"x","isSecret":false}]}'
env_list="$(body "$(api GET /api/env)")"
expect_contains 'the env list names the plain variable' "$env_list" 'FACTORY_ENV_PROBE'
# The write-only contract, end to end: the secret travels by name, its value is withheld from
# every read.
expect_contains 'the core secret value is withheld' "$env_list" '"name":"SECRET_PROBE","value":null'

id="$(create_job 'board only')"
case "$id" in
*-*-*-*-*) ok 'queues a job' ;;
*) bad 'queues a job' "no id came back: '$id'" ;;
esac
claim="$(body "$(api POST /api/jobs/claim '{"worker":"probe","leaseSeconds":300}')")"
token="$(field "$claim" leaseToken)"
expect_field 'claim returns the command' "$claim" command 'board only'
expect_field 'first attempt is 1'        "$claim" attempts 1

# A live lease is the whole point: nothing else may take this job while probe holds it.
expect_status 'a held job is not offered again' 204 POST /api/jobs/claim '{"worker":"other"}'
expect_status 'heartbeat extends the lease'     200 POST "/api/jobs/$id/heartbeat" "{\"leaseToken\":\"$token\"}"
expect_status 'a wrong token is refused'        409 POST "/api/jobs/$id/complete" \
    '{"leaseToken":"00000000-0000-4000-8000-000000000000","status":"succeeded","exitCode":0,"output":"x"}'
expect_status 'the holder may complete'         200 POST "/api/jobs/$id/complete" \
    "{\"leaseToken\":\"$token\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"hello\"}"

done_body="$(body "$(api GET "/api/jobs/$id")")"
expect_field 'the result is recorded'   "$done_body" status succeeded
expect_field 'the exit code is kept'    "$done_body" exitCode 0
expect_field 'the output is kept'       "$done_body" output hello

# Reclaim, proven by ageing the lease rather than by waiting one out.
reclaim_id="$(create_job 'reclaim me')"
stale="$(field "$(body "$(api POST /api/jobs/claim '{"worker":"dies","leaseSeconds":300}')")" leaseToken)"
docker compose exec -T timescale psql -U factory -d "$DB" \
    -c "update job set lease_expires_at = now() - interval '1 second' where id = '$reclaim_id'" >/dev/null 2>&1
again="$(body "$(api POST /api/jobs/claim '{"worker":"takes-over","leaseSeconds":300}')")"
expect_field 'an expired lease is reclaimed' "$again" id "$reclaim_id"
expect_field 'the attempt count grows'       "$again" attempts 2
# The fencing token, end to end: the first worker is still alive and still wrong.
expect_status 'the superseded worker is refused' 409 POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$stale\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"zombie\"}"
api POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$(field "$again" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

PARKED_SESSION='55555555-5555-4555-8555-555555555555'
REMOTE_SESSION='cse_015tb2nHhHNrBuL7ZDhn9Wx5'

# Standby, end to end: park a running job, prove the board does not re-queue it, end its turn with
# Stop, and continue it as a follow-up — the only resumed claim there is (docs/jobs.md).
park_id="$(create_job 'park me')"
park_claim="$(body "$(api POST /api/jobs/claim '{"worker":"parks","leaseSeconds":300}')")"
park_token="$(field "$park_claim" leaseToken)"
api POST "/api/jobs/$park_id/session" \
    "{\"leaseToken\":\"$park_token\",\"sessionId\":\"$PARKED_SESSION\"}" >/dev/null
# The second report of an attempt. Not a uuid — it is an opaque token minted by Anthropic's backend
# when the Remote Control bridge connects, and it is what claude.ai/code addresses the session by.
api POST "/api/jobs/$park_id/session" \
    "{\"leaseToken\":\"$park_token\",\"sessionId\":\"$PARKED_SESSION\",\"remoteSessionId\":\"$REMOTE_SESSION\"}" >/dev/null
expect_field 'the remote session is kept' "$(body "$(api GET "/api/jobs/$park_id")")" \
    remoteSessionId "$REMOTE_SESSION"
expect_status 'a running job can be parked'   200 POST "/api/jobs/$park_id/suspend" \
    "{\"leaseToken\":\"$park_token\"}"
parked="$(body "$(api GET "/api/jobs/$park_id")")"
expect_field  'it is on standby'              "$parked" status standby
expect_field  'it keeps its session'          "$parked" sessionId "$PARKED_SESSION"
# The link has to keep working while the job waits to be picked up.
expect_field  'and its remote session'        "$parked" remoteSessionId "$REMOTE_SESSION"
# The reason standby is a status and not just an expired lease: an idle poll must not resume it.
expect_status 'a parked job is not offered'   204 POST /api/jobs/claim '{"worker":"idle-poll"}'
# The continuation of a parked task is a person's action on a FINISHED one: while the row sits on
# standby the turn is still open, and the follow-up is refused.
expect_status 'a parked task cannot be continued' 409 POST "/api/jobs/$park_id/follow-up" \
    '{"command":"too soon"}'
# Stop ends the turn: the parked row settles stopped — terminal, the session kept for the
# follow-up that continues exactly where things stood. There is no resume and no park resume.
expect_status 'stop settles the parked row'   200 POST "/api/jobs/$park_id/stop"
stopped="$(body "$(api GET "/api/jobs/$park_id")")"
expect_field  'it is stopped'                 "$stopped" status stopped
expect_field  'stopped keeps the session'     "$stopped" sessionId "$PARKED_SESSION"
# Parking handed the attempt back, and Stop settles without taking one: the parked row never
# burned a try. (suspend: attempts = greatest(attempts - 1, 0); stop does not touch attempts.)
expect_field  'parking did not burn a try'    "$stopped" attempts 0
# One api call, not expect_status plus a second request: every follow-up POST that passes the
# preconditions INSERTS a row, so a duplicate call would queue a second continuation.
follow_out="$(api POST "/api/jobs/$park_id/follow-up" '{"command":"continue this"}')"
if [ "$(status "$follow_out")" = '201' ]; then ok 'a stopped task can be continued'; else
    bad 'a stopped task can be continued' "wanted 201, got $(status "$follow_out"): $(body "$follow_out")"; fi
fu_id="$(field "$(body "$follow_out")" id)"
printf '%s\n' "$fu_id" >>"$work/created-jobs"
fu_claim="$(body "$(api POST /api/jobs/claim '{"worker":"follows","leaseSeconds":300}')")"
expect_field  'the follow-up claim comes back' "$fu_claim" id "$fu_id"
# The per-member workspace, ready-made by the board: `<org>/<user id>`. The driver refuses anything
# that is not exactly that before interpolating it into a `docker run`.
case "$(field "$fu_claim" workspacePath)" in
default/????????-????-????-????-????????????) ok 'the claim carries a workspace path' ;;
*) bad 'the claim carries a workspace path' "got '$(field "$fu_claim" workspacePath)'" ;;
esac
expect_field  'the claim carries the session' "$fu_claim" resumeSessionId "$PARKED_SESSION"
expect_field  'the claim says it is a follow-up' "$fu_claim" followUp true
expect_field  'the follow-up starts at attempt 1' "$fu_claim" attempts 1
api POST "/api/jobs/$fu_id/complete" \
    "{\"leaseToken\":\"$(field "$fu_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

# --- The driver ------------------------------------------------------------------------------

echo
echo '# driver'

start_driver() { # start_driver <image> [RUNNER_CLI] [RUNNER_SERVICES]
    # No ORG_ID. The board sends `workspacePath` on the claim now — it owns the layout, because it
    # is the thing that created the directory — so the driver builds no path of its own.
    # RUNNER_SERVICES defaults to on now; every phase but the services one passes 0 explicitly, so
    # what each phase asserts stays independent of the default.
    env JOB_BOARD_URL="$BASE" EXECUTOR_IMAGE="$1" RUNNER_CLI="${2:-claude-code}" RUNNER_SERVICES="${3:-0}" \
        WORKSPACE_VOLUME="$VOLUME" \
        DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 \
        node driver/dist/index.js >>"$work/driver.log" 2>&1 &
    driver_pid=$!
}

stop_driver() {
    [ -n "$driver_pid" ] && kill "$driver_pid" 2>/dev/null
    wait "$driver_pid" 2>/dev/null
    driver_pid=""
}

start_driver "$IMAGE_OK"

first="$(create_job 'first prompt')"
second="$(create_job 'second prompt')"
third="$(create_job 'third prompt')"

expect_contains 'runs a queued job'        "$(await_settled "$first")"  succeeded
expect_contains 'runs the second'          "$(await_settled "$second")" succeeded
# Three jobs against a concurrency of two: this one only runs once a slot frees.
expect_contains 'queues past the slots'    "$(await_settled "$third")"  succeeded

ran="$(body "$(api GET "/api/jobs/$first")")"
expect_field    'the exit code comes back' "$ran" exitCode 0
# The stub image echoes its arguments, so the output is the proof the prompt reached the container.
expect_contains 'the prompt reached it'    "$(field "$ran" output)" 'first prompt'
expect_contains 'the driver names itself'  "$(field "$ran" claimedBy)" driver-
expect_field    'one attempt was enough'   "$ran" attempts 1

# The driver mints the session id, passes it to the runner as --session-id and reports it to the
# board. The stub echoes its arguments, so finding the reported id inside the output is what proves
# the two are the same one — a link built from it opens the session the job actually ran as.
session="$(field "$ran" sessionId)"
case "$session" in
    ????????-????-????-????-????????????) ok 'the session id was reported' ;;
    *) bad 'the session id was reported' "got '$session'" ;;
esac
expect_contains 'the runner was given that id' "$(field "$ran" output)" "$session"

# The vertical proof for the runner environment: configured on the board in the board section,
# resolved onto the claim, forwarded into the container, printed by the stub. Today the whole
# chain is dark; with it, the markers come back in the job's output.
env_job="$(create_job 'env probe')"
expect_contains 'runs the env job' "$(await_settled "$env_job")" succeeded
env_ran="$(body "$(api GET "/api/jobs/$env_job")")"
expect_contains 'the core env reached the runner'     "$(field "$env_ran" output)" 'org-marker'
expect_contains 'the core secret reached the runner'  "$(field "$env_ran" output)" 'secret-marker'

stop_driver
start_driver "$IMAGE_FAIL"

failing="$(create_job 'this one fails')"
expect_contains 'a non-zero exit is a failure' "$(await_settled "$failing")" failed
failed_body="$(body "$(api GET "/api/jobs/$failing")")"
expect_field    'the exit code is reported'    "$failed_body" exitCode 3
expect_contains 'stderr is captured'           "$(field "$failed_body" output)" boom

stop_driver
start_driver "$IMAGE_OK" opencode

# The opencode switch, end to end: same stub image (its entrypoint echoes, so the output is the
# argv the container received), but the driver now speaks opencode's headless form — `run <prompt>`
# — and, because opencode cannot adopt a minted session id, reports no session at all.
oc="$(create_job 'opencode prompt')"
expect_contains 'an opencode driver runs its job' "$(await_settled "$oc")" succeeded
oc_body="$(body "$(api GET "/api/jobs/$oc")")"
expect_contains 'the opencode argv reached it' "$(field "$oc_body" output)" 'run opencode prompt'
expect_field    'no session was reported'      "$oc_body" sessionId ''

stop_driver

# --- Auxiliary services (.bellows.yaml) -------------------------------------------------------
#
# Issue #6, end to end: a checkout declares a service, the driver starts it on a per-job network,
# and the runner reaches it by name. The stub runner is the one image here whose entrypoint EXECUTES
# the prompt (the driver always puts it last in the argv), so the job's output is an HTTP fetch of
# `http://stub-svc:8000/probe` — the assertion fails unless the service is up, on the job's network,
# under the name the file asked for.

echo
echo '# services'

# The author and their tree, learned the way the board phase learns one: a probe claim, completed
# immediately so the FIFO below is not holding a live lease.
wp_id="$(create_job 'services probe')"
wp_claim="$(body "$(api POST /api/jobs/claim '{"worker":"svc-probe","leaseSeconds":300}')")"
wp="$(field "$wp_claim" workspacePath)"
case "$wp" in
default/????????-????-????-????-????????????) ;;
*) bad 'the services probe claim carries a workspace path' "got '$wp'" ;;
esac
api POST "/api/jobs/$wp_id/complete" \
    "{\"leaseToken\":\"$(field "$wp_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

# The service: a one-file HTTP responder on busybox nc — current alpine:3 ships no httpd applet,
# and the answer is deliberately static so the assertion reads the alias, not the server. The
# runner-exec image: a script that runs the prompt, which the echo stubs cannot do.
mkdir -p "$work/svc"
printf '%s\n' \
    '#!/bin/sh' \
    'while true; do' \
    "    printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 13\\r\\n\\r\\nservice-is-up' | nc -l -p 8000" \
    'done' >"$work/svc/serve.sh"
printf 'FROM alpine:3\nCOPY serve.sh /serve.sh\nCMD ["sh","/serve.sh"]\n' >"$work/svc/Dockerfile"
docker build -q -t "$IMAGE_SVC" "$work/svc" >/dev/null || {
    echo 'test-jobs: could not build the service stub image'
    exit 1
}
mkdir -p "$work/run"
printf '#!/bin/sh\nfor last in "$@"; do :; done\nexec sh -c "$last"\n' >"$work/run/run.sh"
# `sh /run.sh` rather than exec-ing it: a file written by this script has no exec bit to copy in.
printf 'FROM alpine:3\nCOPY run.sh /run.sh\nENTRYPOINT ["sh","/run.sh"]\n' >"$work/run/Dockerfile"
docker build -q -t "$IMAGE_RUN" "$work/run" >/dev/null || {
    echo 'test-jobs: could not build the runner-exec stub image'
    exit 1
}

# The file has to sit in the AUTHOR's tree on the volume the driver mounts — that is where the
# readout container looks, and there is no host path into a named volume. A failed write fails the
# run here, not later as a misleading job verdict.
write_bellows() { # write_bellows <contents>
    docker run --rm -i -v "$VOLUME:/workspaces" alpine:3 \
        sh -c "mkdir -p '/workspaces/$wp/demo' && cat > '/workspaces/$wp/demo/.bellows.yaml'" \
        <<<"$1" >/dev/null || {
        echo 'test-jobs: could not write the .bellows.yaml fixture'
        exit 1
    }
}
write_bellows 'services:
  - name: stub-svc
    image: factory-jobs-smoke-svc'

start_driver "$IMAGE_RUN" claude-code 1

svc="$(create_job 'wget -qO- http://stub-svc:8000/probe')"
expect_contains 'a declared service is reachable by name' "$(await_settled "$svc")" succeeded
expect_contains 'the service answered the runner'    "$(field "$(body "$(api GET "/api/jobs/$svc")")" output)" service-is-up

# The refusal path, end to end: a file the parser refuses fails the job with the reason, and the
# runner never spawns — the output is the parse error alone.
write_bellows 'services:
  - name: db
    image: postgres
    ports: ["5432:5432"]'
broken="$(create_job 'echo must not run')"
expect_contains 'a malformed file fails the job' "$(await_settled "$broken")" failed
expect_contains 'the parse reason comes back'    "$(field "$(body "$(api GET "/api/jobs/$broken")")" output)" '.bellows.yaml'

stop_driver

# Nothing of THIS RUN's jobs may survive the driver: the network is per-job (named after the job
# id), every runner is --rm, and the driver drains before it exits. Scoped to the ids this script
# created — the daemon may be serving a live deployment whose factory.job containers and
# factory-job-* networks are none of this suite's business.
svc_networks=0
leftover=0
for job in $(cat "$work/created-jobs" 2>/dev/null); do
    n="$(docker network ls --filter "name=factory-job-$job-" --format '{{.Name}}' | wc -l | tr -d ' ')"
    svc_networks=$((svc_networks + n))
    n="$(docker ps -aq --filter "label=factory.job=$job" | wc -l | tr -d ' ')"
    leftover=$((leftover + n))
done
if [ "$svc_networks" = '0' ]; then ok 'no service networks left behind'; else bad 'no service networks left behind' "$svc_networks remain"; fi
if [ "$leftover" = '0' ]; then ok 'no containers left behind'; else bad 'no containers left behind' "$leftover remain"; fi

# --- Workflows -------------------------------------------------------------------------------
#
# Issue #94, end to end. A workflow definition lives on the board (created through the API, the
# way the composer's dropdown is fed), and the board walks the graph: fetch → implement →
# review(BLOCKERS-marker) → fix → review(publish-marker) → publish. The echo stub makes every
# run's output deterministic, which is what lets marker edges decide the walk on a real board.
# A second and a third task are then walked BY HAND through the claim API, where the claim body
# itself is the assertion: the publish flag is true on the publish node's claim and false on every
# other, and a bounded edge rests the thread instead of walking past its limit.

echo
echo '# workflows'

# The stub walk. The marker contract rides the templates: review ends with the fix node's output
# tail — empty on round one (the BLOCKERS-marker shape), the fix marker on round two (the publish
# shape) — so the SAME deterministic stub output walks a different edge the second time through.
cat >"$work/stub-walk.json" <<'JSON'
{
  "name": "stub-walk",
  "scope": "org",
  "definition": {
    "entry": "fetch",
    "nodes": [
      { "name": "fetch", "kind": "agent", "session": "resume", "prompt": "fetch the issue" },
      { "name": "implement", "kind": "agent", "session": "resume", "prompt": "implement it\n{{fetch.output}}" },
      { "name": "review", "kind": "agent", "session": "fresh", "gates": false, "prompt": "review the work\n{{fix.output}}" },
      { "name": "fix", "kind": "agent", "session": "resume", "prompt": "fix it\n{{review.output}}\nFIXED-ONE-ROUND" },
      { "name": "publish", "kind": "agent", "session": "resume", "publish": true, "prompt": "ship it" }
    ],
    "edges": [
      { "from": "fetch", "to": "implement", "when": "succeeded" },
      { "from": "implement", "to": "review", "when": "succeeded" },
      { "from": "review", "to": "fix", "when": { "marker": "review the work" }, "max": 1 },
      { "from": "review", "to": "publish", "when": { "marker": "FIXED-ONE-ROUND" } },
      { "from": "fix", "to": "review", "when": "succeeded" }
    ]
  }
}
JSON
expect_status 'creates the stub workflow' 201 POST /api/workflows "$(cat "$work/stub-walk.json")"
expect_status 'the stub workflow is listed' 200 GET /api/workflows
expect_status 'refuses a pasted foreign pipeline' 400 POST /api/workflows \
    '{"name":"foreign","scope":"org","definition":{"nodes":[],"edges":[],"trigger":"on-push"}}'
expect_status 'refuses an unknown workflow name' 404 POST /api/jobs '{"command":"x","workflow":"ghost"}'

# Thread reads, in node, because the assertions below walk arrays — no jq in the harness.
thread_nodes() { # thread_nodes <root-id> -> the node labels, oldest first, space-separated
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(t.map((j)=>j.workflowNode??"-").join(" "))})'
}
thread_session() { # thread_session <root-id> <index> -> that row's sessionId
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[Number(process.argv[1])]?.sessionId??""))})' "$2"
}
thread_command() { # thread_command <root-id> <index> -> that row's command
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[Number(process.argv[1])]?.command??""))})' "$2"
}

start_driver "$IMAGE_OK"
walked="$(api POST /api/jobs '{"command":"walk me end to end","workflow":"stub-walk"}')"
wf_id="$(field "$(body "$walked")" id)"
printf '%s\n' "$wf_id" >>"$work/created-jobs"

# The board walks while the driver runs: wait until the thread holds all six nodes and the last is
# terminal — the walk is the BOARD's, so the row count is the assertion, not one job's verdict.
walk_done=""
for _ in $(seq 1 120); do
    nodes="$(thread_nodes "$wf_id")"
    last_status="$(api GET "/api/jobs/$wf_id/thread" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[t.length-1]?.status??""))})')"
    if [ "$nodes" = 'fetch implement review fix review publish' ] && [ "$last_status" != queued ] && [ "$last_status" != running ]; then
        walk_done=1
        break
    fi
    sleep 1
done
if [ -n "$walk_done" ]; then ok 'the board walked fetch→implement→review→fix→review→publish'; else
    bad 'the board walked fetch→implement→review→fix→review→publish' "nodes: '$(thread_nodes "$wf_id")' last: '$last_status'"; fi

# The interpolation proof: the implement row's command is the template FILLED with the fetch row's
# output tail — the prompt that reached the stub container, not the {{...}} skeleton.
expect_contains 'the implement prompt carries the fetch output' "$(thread_command "$wf_id" 1)" 'fetch the issue'
expect_contains 'the fix prompt carries the review output'       "$(thread_command "$wf_id" 3)" 'review the work'

# The session proof: resume nodes (fetch, implement, fix, publish) carry the primary session; the
# fresh review rows do not — one worktree, N sessions.
primary="$(thread_session "$wf_id" 0)"
case "$primary" in
????????-????-????-????-????????????) ok 'the entry run reported a session' ;;
*) bad 'the entry run reported a session' "got '$primary'" ;;
esac
[ "$(thread_session "$wf_id" 1)" = "$primary" ] && ok 'implement resumed the primary session' ||
    bad 'implement resumed the primary session' "got '$(thread_session "$wf_id" 1)'"
[ "$(thread_session "$wf_id" 3)" = "$primary" ] && ok 'fix resumed the primary session' ||
    bad 'fix resumed the primary session' "got '$(thread_session "$wf_id" 3)'"
review1="$(thread_session "$wf_id" 2)"
review2="$(thread_session "$wf_id" 4)"
if [ -n "$review1" ] && [ "$review1" != "$primary" ] && [ -n "$review2" ] && [ "$review2" != "$primary" ] && [ "$review1" != "$review2" ]; then
    ok 'the review rounds ran fresh'
else
    bad 'the review rounds ran fresh' "review sessions: '$review1' '$review2' primary: '$primary'"
fi
stop_driver

# The claim-level assertions, walked by hand with the driver parked. The stub's walk is
# deterministic, so each complete below decides the next edge exactly as a real run would.
claim_walk() { # claim_walk <output> -> "id<TAB>leaseToken<TAB>publish" of the claimed row
    claim="$(api POST /api/jobs/claim '{"worker":"walker","leaseSeconds":300}')"
    if [ "$(status "$claim")" = '204' ]; then
        printf ''
        return
    fi
    node -e 'const c=JSON.parse(process.argv[1]);process.stdout.write([c.id,c.leaseToken,c.publish===undefined?"absent":String(c.publish)].join("\t"))' \
        "$(body "$claim")"
    if [ -n "$1" ]; then
        api POST "/api/jobs/$(field "$(body "$claim")" id)/complete" \
            "{\"leaseToken\":\"$(field "$(body "$claim")" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"$1\"}" >/dev/null
    fi
}
walk_flag() { # walk_flag <name> <got> <want>
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "publish wanted '$3', got '$2'"; fi
}

# Task two: the publish flag. Every node's claim says false until the graph's publish node — six
# claims to walk the whole graph: fetch, implement, review, fix, the second review, then publish.
wf2="$(api POST /api/jobs '{"command":"flag walk","workflow":"stub-walk"}')"
wf2_id="$(field "$(body "$wf2")" id)"
printf '%s\n' "$wf2_id" >>"$work/created-jobs"
walk_out="$(claim_walk 'fetch the issue')"
walk_flag 'the fetch claim may not publish'    "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'implement it')"
walk_flag 'the implement claim may not publish' "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'review the work')"
walk_flag 'the review claim may not publish'    "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'FIXED-ONE-ROUND')"
walk_flag 'the fix claim may not publish'       "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'FIXED-ONE-ROUND')"
walk_flag 'the second review claim may not publish' "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'ship it')"
walk_flag 'the publish node claim may publish'  "$(printf '%s' "$walk_out" | cut -f3)" true

# Task three: the loop bound. The second review names the fix marker AGAIN, but review→fix is
# bounded at one and the fix row already exists — the board rests the thread instead.
wf3="$(api POST /api/jobs '{"command":"bound walk","workflow":"stub-walk"}')"
wf3_id="$(field "$(body "$wf3")" id)"
printf '%s\n' "$wf3_id" >>"$work/created-jobs"
claim_walk 'fetch the issue' >/dev/null
claim_walk 'implement it' >/dev/null
claim_walk 'review the work' >/dev/null
claim_walk 'fixed' >/dev/null
claim_walk 'review the work' >/dev/null
sleep 2
if [ "$(thread_nodes "$wf3_id")" = 'fetch implement review fix review' ]; then
    ok 'the bounded edge rests the loop at its limit'
else
    bad 'the bounded edge rests the loop at its limit' "nodes: '$(thread_nodes "$wf3_id")'"
fi
expect_status 'a rested thread offers nothing more' 204 POST /api/jobs/claim '{"worker":"idle-walker"}'

# --- The same board, with auth on -------------------------------------------------------------
#
# Everything above runs against AUTH_MODE=none, which is what this script has always been and what
# it must keep exercising: that mode is what `npm run seed`, the route harness and `git clone && npm
# run dev` all depend on. This section is the other half — the only end-to-end proof that the two
# credentials really are disjoint, that a human cannot claim a lease and a worker cannot queue a job.

echo
echo '# auth'

kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""

AUTH_PORT=$((PORT + 1))
AUTH_BASE="http://127.0.0.1:$AUTH_PORT"

env DATABASE_URL="$DATABASE_URL" PORT="$AUTH_PORT" HOST=127.0.0.1 \
    ORG_WORKSPACE_ROOT="$work/workspaces" \
    AUTH_MODE=github \
    GITHUB_OAUTH_CLIENT_ID=stub-client GITHUB_OAUTH_CLIENT_SECRET=stub-secret \
    SESSION_SECRET=a-job-harness-session-secret-32-chars \
    node server/dist/offline.js >"$work/auth-server.log" 2>&1 &
server_pid=$!

up=""
for _ in $(seq 1 40); do
    [ "$(status "$(BASE="$AUTH_BASE" api GET /api/health)")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done

if [ -z "$up" ]; then
    bad 'the authenticated board came up' "$(tail -5 "$work/auth-server.log")"
else
    ok 'the authenticated board came up'

    # Open, because the compose healthcheck carries no credential and this route has to answer
    # while the migrations are still retrying.
    expect_status_at "$AUTH_BASE" 'health stays open'           200 GET /api/health
    expect_status_at "$AUTH_BASE" 'the dashboard needs a login' 401 GET '/api/stats?range=all'
    # The route docs/security.md calls remote code execution. This is the assertion the whole
    # change exists for.
    expect_status_at "$AUTH_BASE" 'queueing a job needs a login' 401 POST /api/jobs '{"command":"rm -rf /"}'
    expect_status_at "$AUTH_BASE" 'claiming needs a worker token' 401 POST /api/jobs/claim '{"worker":"driver-1"}'

    # Minted the way an operator mints one: printed once, only its hash stored.
    token="$(env DATABASE_URL="$DATABASE_URL" \
        node server/dist/admin/worker-token.js --name harness-driver 2>>"$work/auth-server.log" |
        sed -n 's/.*JOB_BOARD_TOKEN=//p' | tr -d ' \r')"
    case "$token" in
    fwt_*) ok 'a worker token was minted' ;;
    *) bad 'a worker token was minted' "got '$token'" ;;
    esac

    claim="$(AUTH_HEADER="Bearer $token" BASE="$AUTH_BASE" api POST /api/jobs/claim '{"worker":"harness-driver"}')"
    case "$(status "$claim")" in
    200 | 204) ok 'a worker token claims' ;;
    *) bad 'a worker token claims' "got $(status "$claim"): $(body "$claim")" ;;
    esac

    # The other direction, and the one that is easy to get wrong: a credential that may claim work
    # must not be able to create it, or the job it queues has no author.
    queued="$(AUTH_HEADER="Bearer $token" BASE="$AUTH_BASE" api POST /api/jobs '{"command":"echo hi"}')"
    if [ "$(status "$queued")" = '401' ]; then
        ok 'a worker token cannot queue a job'
    else
        bad 'a worker token cannot queue a job' "got $(status "$queued")"
    fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
