#!/usr/bin/env bash
# The Kubernetes stack, end to end on a local kind cluster.
#
#   scripts/test-k8s.sh              # lint + template only (needs helm)
#   scripts/test-k8s.sh --cluster    # then the real thing (needs a kind cluster running)
#   scripts/test-k8s.sh --cluster --phase recovery # smoke prerequisites + recovery only
#
# Phase one is offline: helm lint, and helm template assertions that the rendered manifests carry
# the security-relevant decisions — credentials by secretKeyRef and never by value, a
# namespace-scoped Role, a runner pod with no service account, and an auth wall that no value can
# take down (the chart always renders AUTH_MODE=github). Phase one also renders an EKS-shaped value
# set (#364): the cluster phase refuses every non-kind context, so the cloud shape is asserted
# where it can be — at render time — and exercised on a real cluster only by the by-hand walk in
# docs/eks-runbook.md. Phase two installs the chart into the
# local cluster with the stub executor image and the code-only no-fetch entry (dashboard.offline)
# behind that same wall, mints a member's personal access token straight into the database, queues
# a job through it, and watches it come back succeeded — real pods, no Claude, no GitHub, and the
# driver authenticating with its board token all the way. Every credential it uses is throwaway,
# generated per run; it never reads the repo's .env.
#
# Everything it creates it removes: two helm releases — the app and the local state it runs against
# (charts/factory-local-state: the database and the workspaces claim) — and the state's claims.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

MODE=''
PHASE=all
phase_requested=''
while [ "$#" -gt 0 ]; do
    case "$1" in
    --cluster|--netpol) [ -z "$MODE" ] || { echo 'choose --cluster or --netpol'; exit 2; }; MODE="$1" ;;
    --phase)
        phase_requested=1
        shift
        PHASE="${1:-}"
        case "$PHASE" in all|smoke|admission|workspace|recovery) ;; *) echo 'invalid --phase'; exit 2 ;; esac
        ;;
    --help)
        echo 'Usage: scripts/test-k8s.sh [--cluster [--phase all|smoke|admission|workspace|recovery] | --netpol]'
        echo 'All cluster phases run smoke prerequisites. The default cluster phase is all.'
        echo 'TIMINGS_FILE overrides artifacts/k8s/<release>.tsv (includes cleanup).'
        exit 0
        ;;
    *) echo "unknown argument: $1"; exit 2 ;;
    esac
    shift
done
if [ -n "$phase_requested" ] && [ "$MODE" != --cluster ]; then
    echo '--phase requires --cluster'
    exit 2
fi
selected_phase() { [ "$PHASE" = all ] || [ "$PHASE" = "$1" ]; }

RELEASE="factory-k8s-test-$(date +%s)"
# The app chart deploys no database; locally the state chart stands in for the managed one. Its
# object names are its release name plus a fixed suffix, so the app release is pointed at them the
# same way values-local.yaml points `dev` at `factory-state`.
STATE_RELEASE="$RELEASE-state"
STATE_SETS=(
    --set "database.url=postgres://factory:factory@$STATE_RELEASE-postgres:5432/factory_dev"
    --set "workspaces.existingClaim=$STATE_RELEASE-workspaces"
)
# The chart refuses to render without its auth values, and values-local.yaml carries none (they come
# from .env through scripts/k8s-local-values.mjs, which this script deliberately never runs). These
# are throwaway: fake OAuth client, no App. Phase one renders with fixed ones; the cluster phase
# refills AUTH_SETS with per-run random secrets.
SECRET32="$(printf '%032d' 0)"
auth_sets() { # auth_sets <publicUrl> <sessionSecret> <jobBoardToken> — (re)fills AUTH_SETS
    AUTH_SETS=(
        --set "auth.publicUrl=$1"
        --set auth.oauthClientId=client
        --set secret.oauthClientSecret=secret
        --set "secret.sessionSecret=$2"
        --set "secret.jobBoardToken=$3"
    )
}
auth_sets https://factory.example "$SECRET32" "$SECRET32"
# The local profile as the cluster phase installs it: no App, so the code-only no-fetch entry.
LOCAL_SETS=(-f charts/factory/values-local.yaml "${STATE_SETS[@]}" --set dashboard.offline=true)
NAMESPACE="${NAMESPACE:-default}"
DASH_IMAGE="${DASH_IMAGE:-factory-ai}"
DRIVER_IMAGE="${DRIVER_IMAGE:-factory-driver}"
STUB_IMAGE="${STUB_IMAGE:-echo-executor}"

pass=0
fail=0
work="$(mktemp -d)"
TIMINGS_FILE="${TIMINGS_FILE:-$REPO/artifacts/k8s/$RELEASE.tsv}"
mkdir -p "$(dirname "$TIMINGS_FILE")" && printf 'phase\tseconds\n' >"$TIMINGS_FILE" || exit 1
phase_name=''
phase_started=$SECONDS
lane_started=$SECONDS
end_phase() {
    [ -n "$phase_name" ] || return 0
    local elapsed=$((SECONDS - phase_started))
    printf '[timing] %s: %ss\n' "$phase_name" "$elapsed"
    printf '%s\t%s\n' "$phase_name" "$elapsed" >>"$TIMINGS_FILE"
    phase_name=''
}
begin_phase() {
    end_phase
    phase_name="$1"
    phase_started=$SECONDS
}

ok() {
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
}

bad() {
    printf 'FAIL %s\n     %s\n' "$1" "${2:0:400}"
    fail=$((fail + 1))
}

expect_contains() { # expect_contains <name> <haystack> <needle>
    case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" "wanted substring '$3' in: ${2:0:200}" ;;
    esac
}

expect_not_contains() { # expect_not_contains <name> <haystack> <needle>
    case "$2" in
    *"$3"*) bad "$1" "did not want '$3' in: ${2:0:200}" ;;
    *) ok "$1" ;;
    esac
}

cleanup() {
    local status=$?
    begin_phase cleanup
    local pid
    for pid in "${dash_build:-}" "${driver_build:-}" "${stub_build:-}" "${collector_pull:-}"; do
        [ -n "$pid" ] || continue
        kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
    done
    if [ -n "${pf_pid:-}" ]; then
        kill "$pf_pid" 2>/dev/null
        wait "$pf_pid" 2>/dev/null
        pf_pid=''
    fi
    if [ "${installed:-}" = '1' ]; then
        helm uninstall "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        # The runner Jobs were created at runtime by the driver, not by the release, so the
        # uninstall leaves them — and their pods — behind. Only this release's: the cluster may
        # host another release in the namespace, and the driver stamps its release label on every
        # runner Job. They go BEFORE the claims: a runner pod that still mounts the workspaces
        # claim holds it under pvc-protection, and a waiting claim delete issued first blocks
        # forever on a pod whose delete it never reaches.
        kubectl delete jobs -l "factory.job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        # The repository seed pod mounts the workspaces claim too, if the run died while it ran.
        kubectl delete pod "$RELEASE-repo-seed" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
    fi
    if [ "${state_installed:-}" = '1' ]; then
        helm uninstall "$STATE_RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        kubectl delete pvc -l "app.kubernetes.io/instance=$STATE_RELEASE" -n "$NAMESPACE" --wait=false >/dev/null 2>&1
        # Block until the claims are really gone, not just terminating: the next run of this script
        # builds its own releases, and an RWO volume still attached to a dying pod would hold the
        # fresh dashboard pod in Pending for its whole timeout.
        kubectl wait --for=delete pvc -l "app.kubernetes.io/instance=$STATE_RELEASE" \
            -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
    fi
    rm -rf "$work"
    end_phase
    printf 'total\t%s\n' "$((SECONDS - lane_started))" >>"$TIMINGS_FILE"
    printf '[timing] total: %ss; timings: %s; exit: %s\n' "$((SECONDS - lane_started))" "$TIMINGS_FILE" "$status"
}
trap cleanup EXIT

command -v helm >/dev/null || {
    echo 'test-k8s: helm is required'
    exit 1
}

# --- Phase one: offline ----------------------------------------------------------------------

echo '# chart'
begin_phase chart

# Linted with the local profile: the app chart's defaults carry no database.url, which is required,
# and no auth values, which are too.
helm lint charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" >/dev/null 2>&1 && ok 'helm lint passes' ||
    bad 'helm lint passes' "$(helm lint charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" 2>&1 | tail -3)"
helm lint charts/factory-local-state >/dev/null 2>&1 && ok 'helm lint passes on the local state chart' ||
    bad 'helm lint passes on the local state chart' 'lint failed'

# Rendered with the local profile, which is the shape the cluster phase installs: the no-fetch
# entry behind github auth, the state release's database and claim, stub executor.
render() {
    if [ "$#" -eq 0 ] && [ -f "$work/rendered.yaml" ]; then
        cat "$work/rendered.yaml"
        return
    fi
    helm template "$RELEASE" charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --namespace "$NAMESPACE" "$@"
}
render >"$work/rendered.tmp" && mv "$work/rendered.tmp" "$work/rendered.yaml" || {
    echo 'test-k8s: helm template failed'
    exit 1
}

expect_contains 'the driver selects the kubernetes executor'  "$(cat "$work/rendered.yaml")" 'value: kubernetes'
expect_contains 'the driver finds the board by service name'  "$(cat "$work/rendered.yaml")" "value: http://$RELEASE-factory:8080"
expect_contains 'the driver learns its namespace at runtime' "$(cat "$work/rendered.yaml")" 'fieldPath: metadata.namespace'

# Telemetry. The docker runner joins the compose network and its baked `collector:4318` resolves; a
# pod cannot join a network, so the chart ships a collector and names it in every runner spec the
# driver builds — the kubernetes form of RUNNER_NETWORK.
expect_contains 'the chart ships a collector service'         "$(cat "$work/rendered.yaml")" \
    "name: $RELEASE-factory-collector"
expect_contains 'the driver points runners at the in-chart collector' "$(cat "$work/rendered.yaml")" \
    "value: \"http://$RELEASE-factory-collector:4318\""
# The collector's config is rendered, not static: its exporter must target THIS release's dashboard
# ingest route, and the one line whose absence produces a flat 400 is pinned (docs/telemetry.md).
expect_contains 'the collector forwards to the release dashboard' "$(cat "$work/rendered.yaml")" \
    "endpoint: http://$RELEASE-factory:8080/api/otlp"
expect_contains 'the collector exports uncompressed, or the server answers 400' \
    "$(cat "$work/rendered.yaml")" 'compression: none'
# The config must render INSIDE the block scalar: content indented no deeper than the
# `config.yaml:` key (the chart's own 4-space children level) empties the scalar and leaks every
# top-level config key into data as maps — refused only by an install's apiserver validation,
# which helm template never runs. The needle is exactly 4 spaces + receivers:; the correct render
# carries 8.
expect_not_contains 'the collector config stays inside its block scalar' "$(cat "$work/rendered.yaml")" \
    $'\n    receivers:'

# Credentials by reference, checked STRUCTURALLY: the line after every credential env's name must
# be `valueFrom:` — the pod spec carries the reference and never the value, so anything readable in
# `kubectl get -o yaml` stays unreadable to whoever can list pods. (The runner-side half of the same
# rule — the executor reading its credentials from RUNNER_CREDENTIALS_SECRET — is pinned in
# driver/test/k8s.test.ts, where the runner spec lives.)
credentials_clean=1
for cred in GITHUB_APP_PRIVATE_KEY GITHUB_OAUTH_CLIENT_SECRET SESSION_SECRET INGEST_TOKEN DATABASE_URL; do
    next="$(grep -A1 -- "- name: $cred\$" "$work/rendered.yaml" | sed -n '2p' | tr -d ' ')"
    if [ "$next" = 'valueFrom:' ]; then
        continue
    fi
    credentials_clean=0
    bad "credentials travel by secretKeyRef" "$cred is not read from a Secret (next line: '$next')"
done
[ "$credentials_clean" = '1' ] && ok 'every credential env is a secretKeyRef'

# The Role is namespace-scoped and no wider than the calls the runner makes: create a Job, read its
# status, delete it, list its pods, read one pod's log. Nothing watches; the jobs rule carries no
# watch, which the exact-verbs assertion pins.
rbac="$(awk '/^# Source: factory\/templates\/driver-rbac.yaml/,/^---/' "$work/rendered.yaml")"
# `list` on jobs and services is the re-claim fence: its sweep is a collection GET, and a
# collection GET needs the list verb — a rule without it makes every fence round a 403.
expect_contains     'the driver role grants the runner calls' "$rbac" \
    "resources: ['jobs']
      verbs: ['create', 'get', 'delete', 'list', 'patch']"
# The claim env's per-job Secret: create before the Job, delete with it. No `get`, no `list` —
# the driver writes values it was handed and never reads one back.
expect_contains     'the driver role manages the per-job env Secret' "$rbac" \
    "resources: ['secrets']
      verbs: ['create', 'delete']"
# The checkout claim that makes the re-claim fence atomic: POSTed to take the checkout, read to
# order the contenders, deleted to release or take over. `get` is safe on ConfigMaps and would
# not be on secrets — the claim carries no secret material.
expect_contains     'the driver role manages the checkout claim' "$rbac" \
    "resources: ['configmaps']
      verbs: ['create', 'get', 'delete']"
expect_contains     'the driver role lists pods, only to find them' "$rbac" "verbs: ['create', 'delete', 'list']"
# Gate runs ride the jobs rule (a gate run IS a Job), but a declared SERVICE is a long-running
# neighbor pod, and its DNS name is a Service object: create before the runner starts, delete
# with the attempt, list for the fence sweep and the attempt teardown.
expect_contains     'the driver role names the service DNS objects' "$rbac" \
    "resources: ['services']
      verbs: ['create', 'delete', 'list']"
# A vanished service pod's events name why it went: list only, by field selector.
expect_contains     'the driver role reads why a service pod vanished' "$rbac" \
    "resources: ['events']
      verbs: ['list']"
# Arbitrary exec into a running pod is the one escalation the design never needed: gates run as
# Jobs this driver specs itself, never as exec calls into somebody else's container.
expect_not_contains 'the driver role never execs into pods' "$rbac" 'pods/exec'
expect_not_contains 'the driver role never watches'         "$rbac" 'watch'
# The runner vitals: a read-only get against the metrics API, which the metrics-server serves
# when the cluster runs one — absent it, the driver answers null ("no fresh sample").
expect_contains     'the driver role reads the runner vitals' "$rbac" \
    "apiGroups: ['metrics.k8s.io']
      resources: ['pods']
      verbs: ['get']"
expect_not_contains 'the driver role is never a ClusterRole' "$(cat "$work/rendered.yaml")" 'kind: ClusterRole'

# The dashboard writes checkouts into the same claim the runners mount — the state release's, so an
# app reinstall keeps them — and the app release creates no claim of its own.
expect_contains 'the dashboard mounts the workspaces claim' "$(cat "$work/rendered.yaml")" \
    "claimName: $STATE_RELEASE-workspaces"
expect_contains 'the driver is told that claim name'        "$(cat "$work/rendered.yaml")" \
    "value: \"$STATE_RELEASE-workspaces\""
expect_not_contains 'the app release creates no claim' "$(cat "$work/rendered.yaml")" \
    'kind: PersistentVolumeClaim'

# The service selects the DASHBOARD and only the dashboard. The shared instance labels alone also
# match the driver pod, and a port-forward landing on the driver fails on a missing
# named port — or worse, on a probe against the wrong container.
service_selector="$(awk '/^# Source: factory\/templates\/service.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains    'the service selects the dashboard component' "$service_selector" 'component: dashboard'
expect_not_contains 'the service never selects the driver'       "$service_selector" 'component: driver'

# The gate endpoint is advertised at the driver POD's own IP: a Service name resolves to every
# driver replica — and, mid-rollout, to the old and new pod both — while the ephemeral port the
# driver appends is open on exactly one of them.
expect_contains 'the driver learns its pod IP'             "$(cat "$work/rendered.yaml")" 'fieldPath: status.podIP'
expect_contains 'the runner is told the driver pod IP'     "$(cat "$work/rendered.yaml")" 'value: http://$(POD_IP)'
expect_not_contains 'the chart ships no headless driver Service' "$(cat "$work/rendered.yaml")" 'clusterIP: None'
# The Secret carries the one shared key: the dashboard validates it, the driver presents it.
expect_contains 'the secret renders the shared board secret key' "$(cat "$work/rendered.yaml")" \
    'job-board-token:'
expect_contains 'the driver presents the shared secret' "$(cat "$work/rendered.yaml")" 'key: job-board-token'
# The URL is useless against the default loopback bind: inside the pod, nothing else can reach
# 127.0.0.1. Compose makes the same pairing.
expect_contains 'the gate listener binds all interfaces' "$(cat "$work/rendered.yaml")" 'value: 0.0.0.0'

# Numbers arrive as integers, not whatever helm's float stringifier felt like — a `1.8e+06` here
# would be refused by the driver's own integer check at boot.
render | grep -q 'value: "7200000"' && ok 'the job timeout renders as an integer' ||
    bad 'the job timeout renders as an integer' "$(render | grep -A1 DRIVER_JOB_TIMEOUT_MS)"
render | grep -A1 'name: GATE_TIMEOUT_MS' | grep -q 'value: "1800000"' && ok 'the gate timeout renders as an integer' ||
    bad 'the gate timeout renders as an integer' "$(render | grep -A1 GATE_TIMEOUT_MS)"

# Runner pod resources (issue #360): requests by default so Karpenter and the Cluster Autoscaler
# can size for the runner fleet — a zero-request pod schedules onto any free pod slot and
# provisions nothing. Limits only when set: a memory limit on an agent run OOM-kills a big build
# mid-work, the requests-only posture the dashboard pod above already carries deliberately.
runner_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the driver forwards the runner cpu request'       "$runner_resources" 'name: RUNNER_CPU_REQUEST'
expect_contains 'the cpu request renders from the chart value'     "$runner_resources" 'value: "500m"'
expect_contains 'the driver forwards the runner memory request'    "$runner_resources" 'name: RUNNER_MEMORY_REQUEST'
expect_contains 'the memory request renders from the chart value'  "$runner_resources" 'value: "1Gi"'
expect_contains 'the driver forwards a default cpu limit (issue #454)' "$runner_resources" 'name: RUNNER_CPU_LIMIT'
expect_contains 'the driver forwards a default memory limit'       "$runner_resources" 'name: RUNNER_MEMORY_LIMIT'
expect_contains 'the memory limit defaults to 8Gi'                 "$runner_resources" 'value: "8Gi"'
unlimited="$(render --set runner.resources.limits=null)"
unlimited_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$unlimited")"
expect_not_contains 'limits: null removes the cpu limit'           "$unlimited_resources" 'RUNNER_CPU_LIMIT'
expect_not_contains 'limits: null removes the memory limit'        "$unlimited_resources" 'RUNNER_MEMORY_LIMIT'
# The namespace LimitRange hands a pod created without limits its defaults.
expect_contains 'a LimitRange renders by default'                  "$(cat "$work/rendered.yaml")" 'kind: LimitRange'
expect_contains 'the LimitRange defaults the container memory limit' "$(cat "$work/rendered.yaml")" 'type: Container'
expect_not_contains 'limitRange.enabled=false renders no LimitRange' "$(render --set limitRange.enabled=false)" 'kind: LimitRange'
limited="$(render --set runner.resources.limits.memory=4Gi)"
limited_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$limited")"
expect_contains 'a configured memory limit forwards'               "$limited_resources" 'name: RUNNER_MEMORY_LIMIT'
expect_contains 'the limit renders as the operator spelled it'     "$limited_resources" 'value: "4Gi"'
emptied="$(render --set runner.resources.requests.cpu= --set runner.resources.requests.memory=)"
emptied_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$emptied")"
expect_not_contains 'empty cpu requests forward nothing'           "$emptied_resources" 'RUNNER_CPU_REQUEST'
expect_not_contains 'empty memory requests forward nothing'        "$emptied_resources" 'RUNNER_MEMORY_REQUEST'
# Gate pod resources (issue #507): a gate runs the whole suite, so it requests more than a runner.
expect_contains 'the driver forwards the gate cpu request'         "$runner_resources" 'name: GATE_CPU_REQUEST'
# values-local.yaml lowers the gate request to fit one node; the chart default is pinned on the
# EKS shape below, which renders without it.
expect_contains 'the local gate cpu request renders from values-local' "$(grep -A1 'name: GATE_CPU_REQUEST' <<<"$runner_resources")" 'value: "1"'
expect_contains 'the driver forwards the gate memory request'      "$runner_resources" 'name: GATE_MEMORY_REQUEST'
expect_contains 'the local gate memory request renders from values-local' "$(grep -A1 'name: GATE_MEMORY_REQUEST' <<<"$runner_resources")" 'value: "1Gi"'
expect_not_contains 'gate limits default to the runner limits'     "$runner_resources" 'GATE_CPU_LIMIT'
gate_limited="$(render --set runner.gateResources.limits.memory=6Gi)"
gate_limited_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$gate_limited")"
expect_contains 'a configured gate memory limit forwards'          "$gate_limited_resources" 'name: GATE_MEMORY_LIMIT'
expect_contains 'the gate limit renders as the operator spelled it' "$(grep -A1 'name: GATE_MEMORY_LIMIT' <<<"$gate_limited_resources")" 'value: "6Gi"'
gate_unsized="$(render --set runner.gateResources.requests=null)"
gate_unsized_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$gate_unsized")"
expect_not_contains 'gate requests: null forwards no gate cpu request' "$gate_unsized_resources" 'GATE_CPU_REQUEST'
expect_not_contains 'gate requests: null forwards no gate memory request' "$gate_unsized_resources" 'GATE_MEMORY_REQUEST'

# The runner's branch attribution credential is attempt-scoped: the driver mints nothing here and
# forwards no deployment-wide ingest token — the runner presents the job id and lease token of the
# attempt it runs for, forwarded at runtime into the per-attempt runner Secret. The chart must not
# wire RUNNER_INGEST_TOKEN: the driver does not read it, and a deployment-wide ingest token has no
# org binding, which is exactly what branch attribution may not run on.
driver="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' "$work/rendered.yaml")"
if grep -q 'RUNNER_INGEST_TOKEN' <<<"$driver"; then
    bad 'the driver forwards no ingest token' \
        'RUNNER_INGEST_TOKEN is still wired in the rendered driver deployment'
else
    ok 'the driver forwards no ingest token'
fi

# The auth wall is a literal, not a value: the dashboard holds checkouts and serves a route that
# runs shell commands, so there is no open mode to select and no public-bind hatch to except one.
auth_mode_of() { grep -A1 -- '- name: AUTH_MODE$' | sed -n '2p' | tr -d ' '; }
mode="$(auth_mode_of <"$work/rendered.yaml")"
[ "$mode" = 'value:github' ] && ok 'the dashboard renders AUTH_MODE=github' ||
    bad 'the dashboard renders AUTH_MODE=github' "next line after AUTH_MODE: '$mode'"
expect_not_contains 'no AUTH_ALLOW_PUBLIC_BIND renders' "$(cat "$work/rendered.yaml")" 'AUTH_ALLOW_PUBLIC_BIND'
# The removed values are inert: a stale override cannot reopen the board.
if reopened="$(render --set auth.mode=none --set auth.allowPublicBind=true 2>&1)"; then
    mode="$(auth_mode_of <<<"$reopened")"
    [ "$mode" = 'value:github' ] && ok '--set auth.mode=none has no effect' ||
        bad '--set auth.mode=none has no effect' "next line after AUTH_MODE: '$mode'"
    expect_not_contains '--set auth.allowPublicBind=true has no effect' "$reopened" 'AUTH_ALLOW_PUBLIC_BIND'
else
    bad '--set auth.mode=none has no effect' "render failed: ${reopened:0:200}"
fi
# The driver's board token is required: a driver started without it would poll into 401s forever,
# where a missing key fails the pod visibly.
board_ref="$(grep -A1 -- 'key: job-board-token' <<<"$driver")"
if [ -z "$board_ref" ]; then
    bad "the driver's board token ref is not optional" 'no job-board-token ref in the driver deployment'
else
    expect_not_contains "the driver's board token ref is not optional" "$(sed -n '2p' <<<"$board_ref")" 'optional'
fi

# The dashboard pod must not start its server until the database accepts connections: the server's
# migration retry gives up after ~45s and then serves every DB-backed route as a 500 forever — a
# state no amount of client-side polling recovers. On a cold cluster the database image pulls for
# minutes, and a managed database can be mid-failover, so the wait has to live in the pod spec, as
# an init container running pg_isready against the very URL the server reads.
dashboard="$(awk '/^# Source: factory\/templates\/deployment.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the dashboard waits for the database before starting' "$dashboard" \
    'wait-for-database'
expect_contains 'the wait is an init container, not a sidecar' "$dashboard" 'initContainers:'
expect_contains 'the wait probes the URL the server reads' "$dashboard" 'pg_isready -q -d "$DATABASE_URL"'

# Production runs no database in the cluster: the app chart has no database objects to switch on,
# and without a URL it refuses to render rather than boot a server with nowhere to write.
expect_not_contains 'the app chart deploys no database' "$(cat "$work/rendered.yaml")" 'component: postgres'
if helm template "$RELEASE" charts/factory >/dev/null 2>&1; then
    bad 'the app chart refuses to render without database.url' 'helm template succeeded with no database.url'
else
    ok 'the app chart refuses to render without database.url'
fi

# The state chart: one database writer on one claim, held by a StatefulSet so the claim belongs to
# the pod identity and no update can put a second writer on it.
state="$(helm template "$STATE_RELEASE" charts/factory-local-state --namespace "$NAMESPACE")"
expect_contains 'the state chart names the database service'  "$state" "name: $STATE_RELEASE-postgres"
expect_contains 'the state chart names the workspaces claim'  "$state" "name: $STATE_RELEASE-workspaces"
expect_contains 'the state database is a StatefulSet'         "$state" 'kind: StatefulSet'
expect_contains 'the database claim is the set’s own'         "$state" 'volumeClaimTemplates:'
expect_contains 'the set is addressed by the database service' "$state" "serviceName: $STATE_RELEASE-postgres"
expect_contains 'the set runs one writer'                     "$state" '
    replicas: 1
    serviceName:'
# The claim a volumeClaimTemplate mints is named after the template, not the release, so the
# instance label is the only handle `make reset` and this script's cleanup have on it — and a
# volumeClaimTemplate's PVC carries only the labels written in its own metadata. Asserted against
# the template block alone: every other object in this chart renders that label too, so the whole
# document as a haystack would pass with the block deleted.
vct="$(printf '%s\n' "$state" | sed -n '/^    volumeClaimTemplates:/,$p')"
expect_contains 'the database claim is the template’s own'      "$vct" 'name: data'
expect_contains 'the database claim carries the instance label' "$vct" \
    "app.kubernetes.io/instance: $STATE_RELEASE"
# Exactly one standalone claim — the workspaces one. The database's is the set's, so a second
# `kind: PersistentVolumeClaim` would mean the old Deployment-era claim came back beside it and
# helm would delete the data on uninstall again.
claims="$(printf '%s\n' "$state" | grep -c '^kind: PersistentVolumeClaim' || true)"
if [ "$claims" = 1 ]; then
    ok 'the workspaces claim is the only standalone claim'
else
    bad 'the workspaces claim is the only standalone claim' "found $claims"
fi

# --- The review hardening: every item pinned so a revert fails here, not in production ---------

# A complete value set on the chart's own defaults, App included, which is what production renders.
GH_SETS=(
    --set database.url=postgres://u:p@db:5432/factory
    "${AUTH_SETS[@]}"
    --set github.appId=1
    --set github.appPrivateKey=pem
    --set artifacts.s3.bucket=factory-artifacts
    --set artifacts.s3.region=us-east-1
)
gh_render() { helm template "$RELEASE" charts/factory "${GH_SETS[@]}" --namespace "$NAMESPACE" "$@" 2>&1; }
gh="$(gh_render)"

# Images carry a tag: the chart's appVersion by default, so an upgrade to a new build changes the
# pod spec and rolls the pods. The collector is pinned — its config keys move between releases.
app_version="$(awk '/^appVersion:/ { gsub(/[^0-9.]/, "", $2); print $2 }' charts/factory/Chart.yaml)"
expect_contains 'the dashboard image defaults to the appVersion tag' "$gh" "image: factory-ai:$app_version"
expect_contains 'the driver image defaults to the appVersion tag'    "$gh" "image: factory-driver:$app_version"
expect_not_contains 'no chart image is untagged or :latest'           "$gh" 'opentelemetry-collector-contrib:latest'
COLLECTOR_IMAGE="$(awk '$1 == "image:" && /opentelemetry-collector-contrib/ { print $2; exit }' "$work/rendered.yaml")"
case "$COLLECTOR_IMAGE" in
*:[0-9]*) ok 'the collector image is pinned to a version' ;;
*) bad 'the collector image is pinned to a version' "got '$COLLECTOR_IMAGE'" ;;
esac

# A changed Secret or collector config rolls the pods that read it at start.
expect_contains 'pods roll on a Secret change'        "$gh" 'checksum/secret:'
expect_contains 'the collector rolls on a config change' "$gh" 'checksum/config:'

# One dashboard, replaced not rolled: an in-process workspace writer, unlocked migrations, and an
# RWO claim that cannot attach twice.
gh_dashboard="$(awk '/^# Source: factory\/templates\/deployment.yaml/,/^---/' <<<"$gh")"
expect_contains 'the dashboard runs exactly one replica' "$gh_dashboard" 'replicas: 1'
expect_contains 'the dashboard is recreated, never rolled' "$gh_dashboard" 'type: Recreate'
# Readiness is the migrations; liveness is the process. A database outage must not restart-loop.
expect_contains 'the dashboard starts on /api/ready'  "$gh_dashboard" 'startupProbe:'
expect_contains 'readiness reads the migrations'      "$gh_dashboard" 'path: /api/ready'
expect_contains 'liveness reads the process only'     "$gh_dashboard" 'path: /api/health'
expect_contains 'the database wait gives up visibly'  "$gh_dashboard" 'WAIT_TIMEOUT_SECONDS'

# Every chart pod runs unprivileged on a read-only root, and only the driver holds a token.
[ "$(grep -c 'runAsNonRoot: true' <<<"$gh")" -ge 3 ] && ok 'every chart pod runs as non-root' ||
    bad 'every chart pod runs as non-root' "$(grep -c 'runAsNonRoot: true' <<<"$gh") of 3"
[ "$(grep -c 'readOnlyRootFilesystem: true' <<<"$gh")" -ge 4 ] && ok 'every chart container has a read-only root' ||
    bad 'every chart container has a read-only root' "$(grep -c 'readOnlyRootFilesystem: true' <<<"$gh") of 4"
[ "$(grep -c 'automountServiceAccountToken: false' <<<"$gh")" -ge 2 ] &&
    ok 'the dashboard and collector mount no ServiceAccount token' ||
    bad 'the dashboard and collector mount no ServiceAccount token' 'fewer than 2'
gh_driver="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$gh")"
expect_contains 'the driver has a liveness probe'      "$gh_driver" 'livenessProbe:'
expect_contains 'the driver writes the heartbeat it reads' "$gh_driver" 'DRIVER_HEARTBEAT_FILE'
expect_contains 'the driver drains before SIGKILL'     "$gh_driver" 'terminationGracePeriodSeconds: 600'
expect_contains 'the driver hands over a minute before SIGKILL' "$(grep -A1 'name: DRIVER_HANDOVER_MS' <<<"$gh_driver")" 'value: "540000"'

# Selectors hold only name/instance/component: they are immutable, so a chart-version label in
# one would make every upgrade an apiserver refusal.
selectors="$(grep -A4 'matchLabels:' <<<"$gh_dashboard$gh_driver")"
expect_not_contains 'selectors carry no version label'  "$selectors" 'app.kubernetes.io/version'
expect_not_contains 'selectors carry no managed-by'     "$selectors" 'managed-by'

# The checkouts survive `helm uninstall` when the chart created their claim.
expect_contains 'the chart-created claim is kept on uninstall' "$gh" 'helm.sh/resource-policy: keep'

# The collector always sends the ingest header by reference: with secret.existingSecret the token
# is in the Secret while telemetry.ingestToken is empty, and a header gated on the value would
# leave an authenticated board answering every export 401.
byo="$(helm template "$RELEASE" charts/factory --set secret.create=false --set secret.existingSecret=mine \
    --set auth.publicUrl=https://f.example --set auth.oauthClientId=c --set github.appId=1 \
    --set artifacts.s3.bucket=factory-artifacts --set artifacts.s3.region=us-east-1 2>&1)"
expect_contains 'the collector sends the ingest header with a managed Secret' "$byo" \
    'X-Factory-Ingest-Token: ${env:INGEST_TOKEN}'
# Every dashboard key but database-url is optional, so a missing one reads as the server's own boot
# message; the driver's job-board-token is the exception (pinned above), so 7 rather than 8.
[ "$(grep -c 'optional: true' <<<"$byo")" -ge 7 ] && ok 'managed-Secret keys are optional' ||
    bad 'managed-Secret keys are optional' "$(grep -c 'optional: true' <<<"$byo") optional refs"

# Render-time refusals: half-configured values fail here, not as a crash loop.
refuses() { # refuses <name> <needle> <helm args...>
    local name="$1" needle="$2"
    shift 2
    local out
    if out="$(helm template "$RELEASE" charts/factory "$@" 2>&1)"; then
        bad "$name" 'helm template succeeded'
    else
        expect_contains "$name" "$out" "$needle"
    fi
}
refuses 'a missing publicUrl is refused' 'auth.publicUrl is required' "${GH_SETS[@]}" --set auth.publicUrl=
# The artifact store (#764): the dashboard runs as its own ServiceAccount, which carries the IRSA
# annotation, and the s3 backend refuses to render without a bucket.
expect_contains 'the dashboard has its own ServiceAccount' "$gh" "serviceAccountName: $RELEASE-factory-dashboard"
irsa="$(gh_render --set 'dashboard.serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::1:role/factory')"
expect_contains 'the IRSA role annotation lands on the dashboard ServiceAccount' "$irsa" \
    'eks.amazonaws.com/role-arn: arn:aws:iam::1:role/factory'
[ "$(grep -c '^kind: ServiceAccount' <<<"$(gh_render --set dashboard.serviceAccount.create=false)")" -lt \
    "$(grep -c '^kind: ServiceAccount' <<<"$gh")" ] && ok 'serviceAccount.create=false renders no dashboard ServiceAccount' ||
    bad 'serviceAccount.create=false renders no dashboard ServiceAccount' 'the ServiceAccount count did not drop'
expect_contains 'the s3 backend reaches the dashboard as environment' "$gh" 'name: ARTIFACTS_S3_BUCKET'
expect_contains 'a credentials Secret becomes the static keys' \
    "$(gh_render --set artifacts.credentialsExistingSecret=store-keys)" 'key: secret-access-key'
expect_not_contains 'no credentials Secret leaves Pod Identity and IRSA to the credential chain' "$gh" 'ARTIFACTS_ACCESS_KEY_ID'
refuses 'an s3 backend with no bucket is refused' 'artifacts.s3.bucket is required' \
    "${GH_SETS[@]}" --set artifacts.s3.bucket=
refuses 'an unknown artifacts backend is refused' 'artifacts.backend must be' \
    "${GH_SETS[@]}" --set artifacts.backend=gcs
refuses 'a missing OAuth client id is refused' 'auth.oauthClientId is required' \
    "${GH_SETS[@]}" --set auth.oauthClientId=
refuses 'a missing OAuth client secret is refused' 'secret.oauthClientSecret is required' \
    "${GH_SETS[@]}" --set secret.oauthClientSecret=
refuses 'a short session secret is refused' 'secret.sessionSecret of at least 32 characters is required' \
    "${GH_SETS[@]}" --set secret.sessionSecret=short
refuses 'a missing board token is refused' 'secret.jobBoardToken of at least 32 characters is required' \
    "${GH_SETS[@]}" --set secret.jobBoardToken=
refuses 'a missing App id is refused unless offline' 'github.appId is required' "${GH_SETS[@]}" --set github.appId=
# Offline waives the App, never the wall: the no-fetch entry still needs every auth value.
refuses 'offline still refuses a missing OAuth client id' 'auth.oauthClientId is required' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set auth.oauthClientId=
refuses 'offline still refuses a missing board token' 'secret.jobBoardToken of at least 32 characters is required' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set secret.jobBoardToken=
refuses 'no Secret at all is refused' 'secret.existingSecret is empty' "${GH_SETS[@]}" --set secret.create=false

# --- The optional ingress (#359): off by default, never disagreeing with auth.publicUrl --------

# Off by default in both profiles: the ClusterIP is the perimeter until the operator says
# otherwise (docs/security.md), and the local profile fronts it with a port-forward.
expect_not_contains 'no Ingress renders by default (local profile)' "$(cat "$work/rendered.yaml")" 'kind: Ingress'
expect_not_contains 'no Ingress renders by default (production defaults)' "$gh" 'kind: Ingress'

# On: the Ingress fronts the release's dashboard service — class, annotations, host and tls all
# verbatim from the values, the backend pinned to the Service the driver already uses.
ing="$(gh_render --set ingress.enabled=true --set ingress.className=alb \
    --set 'ingress.hosts={factory.example}' \
    --set 'ingress.tls[0].secretName=factory-tls' --set 'ingress.tls[0].hosts[0]=factory.example' \
    --set 'ingress.annotations.alb\.ingress\.kubernetes\.io/target-type=ip')"
ingress_doc="$(awk '/^# Source: factory\/templates\/ingress.yaml/,/^---/' <<<"$ing")"
expect_contains 'the enabled ingress carries the ingress class' "$ingress_doc" 'ingressClassName: alb'
expect_contains 'the enabled ingress carries the host' "$ingress_doc" 'host: "factory.example"'
expect_contains 'annotations pass through verbatim' "$ingress_doc" 'alb.ingress.kubernetes.io/target-type: ip'
expect_contains 'tls passes through verbatim' "$ingress_doc" 'secretName: factory-tls'
expect_contains 'the ingress backs the dashboard service by name' "$ingress_doc" "name: $RELEASE-factory"
expect_contains 'the ingress backs the dashboard port' "$ingress_doc" 'number: 8080'
expect_contains 'the ingress is the dashboard component' "$ingress_doc" 'app.kubernetes.io/component: dashboard'
helm lint charts/factory "${GH_SETS[@]}" --set ingress.enabled=true --set 'ingress.hosts={factory.example}' \
    >/dev/null 2>&1 && ok 'helm lint passes with the ingress enabled' \
    || bad 'helm lint passes with the ingress enabled' 'lint failed'

# The enabled-with-defaults shape: no className, no annotations, no tls keys render at all — an
# empty `ingressClassName: ""` would be an apiserver refusal — and the range covers every host.
bare_ingress="$(gh_render --set ingress.enabled=true --set 'ingress.hosts={factory.example,b.example}' |
    awk '/^# Source: factory\/templates\/ingress.yaml/,/^---/')"
expect_contains     'the ingress renders one rule per host' "$bare_ingress" 'host: "b.example"'
expect_not_contains 'an empty className renders no ingressClassName' "$bare_ingress" 'ingressClassName'
expect_not_contains 'empty annotations render no annotations key' "$bare_ingress" 'annotations:'
expect_not_contains 'empty tls renders no tls key' "$bare_ingress" 'tls:'

# The refusals: the hosts list is the authority, and auth.publicUrl must be an origin it answers.
refuses 'an enabled ingress with no hosts is refused' 'ingress.hosts is required when ingress.enabled' \
    "${GH_SETS[@]}" --set ingress.enabled=true
refuses 'an auth.publicUrl the ingress does not answer is refused' 'is not among ingress.hosts' \
    "${GH_SETS[@]}" --set ingress.enabled=true --set 'ingress.hosts={elsewhere.example}'
refuses 'a scheme-less auth.publicUrl is refused under ingress' 'auth.publicUrl must be an absolute origin' \
    "${GH_SETS[@]}" --set auth.publicUrl=factory.example --set ingress.enabled=true \
    --set 'ingress.hosts={factory.example}'
refuses 'a port-forward origin is refused as an ingress host' 'is not among ingress.hosts' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set auth.publicUrl=http://127.0.0.1:18080 \
    --set ingress.enabled=true --set 'ingress.hosts={factory.example}'

# --- The registry prefix (#358): one value, every image the release names ---------------------

# Bare image names are the kind story: `kind load docker-image` side-loads them and IfNotPresent
# resolves. On a remote cluster a bare name resolves to docker.io/library/* and every pod lands in
# ImagePullBackOff — and the executor images reach the driver as opaque env strings, so setting two
# of four values by hand is exactly the half-applied state one prefix value closes. With the
# prefix empty (the default, the local story) the image assertions above pin the verbatim render
# for the chart's own images and the pin below for the executor values, so a prefix that applied
# unconditionally fails here first.
expect_contains 'the executor values render verbatim with no prefix' "$gh" 'value: "claude-executor"'
prefixed="$(gh_render --set global.imageRegistry=ghcr.io/example)"
expect_contains 'the prefix reaches the dashboard image' "$prefixed" \
    "image: ghcr.io/example/factory-ai:$app_version"
expect_contains 'the prefix reaches the driver image' "$prefixed" \
    "image: ghcr.io/example/factory-driver:$app_version"
# The needle is the values.yaml pin verbatim; move it with the pin.
expect_contains 'the prefix reaches the collector image' "$prefixed" \
    'image: ghcr.io/example/otel/opentelemetry-collector-contrib:0.161.0'
expect_contains 'the prefix reaches the claude executor image'   "$prefixed" 'value: "ghcr.io/example/claude-executor"'
expect_contains 'the prefix reaches the opencode executor image' "$prefixed" 'value: "ghcr.io/example/opencode-executor"'
# The exclusion the values comment states: the wait image is a full reference, never prefixed.
expect_contains 'the prefix leaves the database wait image whole' "$prefixed" 'image: postgres:17-alpine'

# A tag on an executor value survives the prefix; tagless reads :latest, which the pinning
# assertions above already refuse for the chart's own images.
tagged="$(gh_render --set global.imageRegistry=ghcr.io/example \
    --set driver.executorImages.claudeCode=claude-executor:v1.2.3)"
expect_contains 'a tag on the executor value survives the prefix' "$tagged" \
    'value: "ghcr.io/example/claude-executor:v1.2.3"'

# The prefix composes with a bare repository only: a value that already names a registry would
# render a double prefix no registry serves. The tag-carrying shape is pinned too — the regex's
# colon rule has to catch it before the tag, not false-positive on the tag itself.
refuses 'an absolute repository is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set dashboard.image.repository=ghcr.io/other/factory-ai
refuses 'a tagged absolute executor value is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set driver.executorImages.claudeCode=ghcr.io/other/claude-executor:v1.2.3
refuses 'a trailing slash on the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example/
refuses 'a pasted URL as the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=https://ghcr.io/example
refuses 'a doubled slash in the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io//example
refuses 'surrounding whitespace on the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set 'global.imageRegistry=ghcr.io/example '
refuses 'an uppercase prefix is refused' 'lowercase registry path' \
    "${GH_SETS[@]}" --set global.imageRegistry=Ghcr.io/Example
refuses 'a scheme:/ typo as the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=https:/ghcr.io/example

# The colon in a prefix is a registry port, not a tag: a bare host:port prefix renders whole.
port="$(gh_render --set global.imageRegistry=registry:5000)"
expect_contains 'a colon-bearing prefix renders as a host port' "$port" \
    "image: registry:5000/factory-ai:$app_version"
# The `:` and `localhost` alternations of the registry rule, pinned like the `.` one above.
refuses 'a host:port repository is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set driver.image.repository=registry:5000/factory-driver
refuses 'a localhost repository is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set driver.image.repository=localhost/factory-driver

# Names stay valid DNS labels however long the release name: truncation leaves room for suffixes.
long="$(helm template "release-name-that-is-deliberately-far-too-long-for-a-dns-label" charts/factory \
    "${GH_SETS[@]}" 2>&1)"
too_long="$(grep -E '^    name: ' <<<"$long" | awk '{ if (length($2) > 63) print $2 }' | grep -v 'admission' || true)"
[ -z "$too_long" ] && ok 'every object name fits a DNS label' || bad 'every object name fits a DNS label' "$too_long"

# Pull secrets reach the chart's pods and every pod the driver specs.
pulled="$(gh_render --set 'imagePullSecrets={regcred}')"
expect_contains 'chart pods name the pull secret'      "$pulled" 'name: "regcred"'
expect_contains 'the driver forwards the pull secret'  "$pulled" 'value: "regcred"'

# The runner group's scheduling knobs (issue #361): forwarded to the driver as JSON, which is how
# they reach every pod it specs. Unset, nothing renders — an untainted cluster sees the same spec
# as before.
expect_not_contains 'no runner scheduling var renders on defaults' "$gh" 'name: RUNNER_NODE_SELECTOR'
expect_not_contains 'no runner tolerations var renders on defaults' "$gh" 'name: RUNNER_TOLERATIONS'
expect_not_contains 'no runner affinity var renders on defaults' "$gh" 'name: RUNNER_AFFINITY'
scheduled="$(gh_render --set runner.nodeSelector.dedicated=factory-runners \
    --set 'runner.tolerations[0].key=dedicated' --set 'runner.tolerations[0].operator=Equal' \
    --set 'runner.tolerations[0].value=factory-runners' --set 'runner.tolerations[0].effect=NoSchedule' \
    --set 'runner.affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].weight=1')"
expect_contains 'the driver is handed the runner node selector as JSON' "$scheduled" \
    'value: "{\"dedicated\":\"factory-runners\"}"'
expect_contains 'the driver is handed the runner tolerations as JSON' "$scheduled" \
    'value: "[{\"effect\":\"NoSchedule\",\"key\":\"dedicated\",\"operator\":\"Equal\",\"value\":\"factory-runners\"}]"'
expect_contains 'the driver is handed the runner affinity as JSON' "$scheduled" 'name: RUNNER_AFFINITY'
expect_contains 'the driver is handed the runner affinity as JSON' "$scheduled" \
    'value: "{\"podAntiAffinity\":{\"preferredDuringSchedulingIgnoredDuringExecution\":[{\"weight\":1}]}}"'

# The runner Secret has a key for every forwarded name, valued or not.
runner_secret="$(gh_render --set-string "runner.env=ONE\,TWO" --set runner.credentials.ONE=x)"
expect_contains 'the runner Secret keys every forwarded name' "$runner_secret" 'TWO: ""'

# Isolation. The Role cannot scope by name, so an admission policy bound to the driver's identity
# does: pod specs may reference only per-attempt Secrets, deletes reach only factory.job objects.
admission="$(awk '/^# Source: factory\/templates\/driver-admission.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the admission policy binds the driver identity' "$admission" \
    "system:serviceaccount:$NAMESPACE:$RELEASE-factory-driver"
expect_contains 'the admission policy names the per-attempt Secret pattern' "$admission" \
    '^factory-(job|gate)-[a-z0-9-]+-env$'
expect_contains 'the admission policy fences deletes by label' "$admission" "'factory.job' in variables.target.metadata.labels"
expect_contains 'the admission policy denies' "$admission" 'validationActions: [Deny]'
expect_not_contains 'the admission policy never admits the dashboard Secret' "$admission" "$RELEASE-factory-dashboard"
expect_contains 'the admission policy scopes workspace mounts to a member subPath' "$admission" \
    "m.subPath.matches('^[A-Za-z0-9][A-Za-z0-9_-]{0,38}/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\$')"
expect_contains 'the admission policy refuses subPathExpr on workspace mounts' "$admission" '!has(m.subPathExpr)'
# A pull secret is for the kubelet only: it may appear under imagePullSecrets, never where a
# container can read it (volumes, env, envFrom).
pulled="$(gh_render --set 'imagePullSecrets={probe-regcred}' |
    awk '/^# Source: factory\/templates\/driver-admission.yaml/,/^---/')"
expect_contains 'the admission policy lets pods pull with a configured pull secret' \
    "$(grep -A1 'name: pullSecrets' <<<"$pulled")" 'probe-regcred'
expect_not_contains 'the admission policy never lets a container read a pull secret' \
    "$(grep -A1 'name: allowed' <<<"$pulled")" 'probe-regcred'
netpol="$(awk '/^# Source: factory\/templates\/runner-networkpolicy.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the runner policy selects this release only' "$netpol" "app.kubernetes.io/instance: $RELEASE"
expect_contains 'the runner policy blocks the metadata endpoint' "$netpol" '169.254.0.0/16'
expect_contains 'the runner policy is both directions' "$netpol" 'policyTypes: [Ingress, Egress]'
expect_contains 'the runner policy sends DNS to kube-dns in kube-system' "$netpol" \
    $'- namespaceSelector:\n                    matchLabels:\n                        kubernetes.io/metadata.name: kube-system\n                podSelector:\n                    matchLabels:\n                        k8s-app: kube-dns'
expect_contains 'the runner policy sends DNS to the NodeLocal DNSCache address' "$netpol" 'cidr: 169.254.20.10/32'
expect_not_contains 'the runner policy never allows port 53 to any destination' "$netpol" '        - ports:'

# Issue #382. The hardening the driver sets on every pod is also REQUIRED by admission, which is a
# different control: a driver that silently stopped setting the fields satisfies every "may not be
# privileged" expression and would be admitted. The rendered CEL is pinned here; that a REAL
# apiserver refuses a pod missing each field is phase two, because a policy that renders and does
# not compile refuses everything (failurePolicy: Fail).
expect_contains 'the admission policy requires the RuntimeDefault seccomp profile' "$admission" \
    "variables.spec.securityContext.seccompProfile.type == 'RuntimeDefault'"
expect_contains 'the admission policy requires allowPrivilegeEscalation false' "$admission" \
    'c.securityContext.allowPrivilegeEscalation == false'
# A container-level seccomp profile overrides the pod-level one, so requiring it on the pod alone
# would admit the exact shape it forbids. The needle names the container field, because
# `c.securityContext.seccompProfile` is a SUBSTRING of the pod expression's
# `variables.spec.securityContext.seccompProfile` and would match a template without this rule.
expect_contains 'the admission policy refuses a container-level seccomp override' "$admission" \
    '!has(c.securityContext.seccompProfile)'
expect_contains 'the admission policy requires every capability dropped' "$admission" \
    "'ALL' in c.securityContext.capabilities.drop"
expect_contains 'the admission policy exempts only a labelled declared service' "$admission" \
    "variables.podLabels['factory.unhardened'] == 'true'"

# The chart-pod egress, split per component and port-scoped (#382). A runner reached every port on
# all three before; now the dashboard is its serving port and the collector its two OTLP ports.
# The driver stays portless — the gate endpoint is ephemeral, so no number exists to name — and
# that rule's CONTINUED EXISTENCE is asserted too: dropping it would break every gate run, which
# is a failure no isolation assertion would have caught.
expect_contains 'the runner policy reaches the dashboard on its serving port only' "$netpol" \
    $'app.kubernetes.io/component: dashboard\n          ports:\n              - protocol: TCP\n                port: 8080'
expect_contains 'the runner policy reaches the collector on the OTLP ports only' "$netpol" \
    $'app.kubernetes.io/component: collector\n          ports:\n              - protocol: TCP\n                port: 4317\n              - protocol: TCP\n                port: 4318'
expect_contains 'the runner policy still reaches the driver on any port, for the ephemeral gate endpoint' \
    "$netpol" $'app.kubernetes.io/component: driver\n        - to:'

# Node churn vs long runs (issue #362). The do-not-disrupt opt-out is off by default in both
# profiles — an undisruptable runner pod pins its node for as long as its job runs — and the
# PDBs are always on: the dashboard drains with at most one unavailable, the driver is protected
# only above one replica, where a single-replica minAvailable would block drains forever.
expect_not_contains 'no do-not-disrupt switch renders by default (local profile)' \
    "$(cat "$work/rendered.yaml")" 'RUNNER_DO_NOT_DISRUPT'
expect_not_contains 'no do-not-disrupt switch renders by default (production defaults)' "$gh" 'RUNNER_DO_NOT_DISRUPT'
dnd="$(gh_render --set driver.runnerDoNotDisrupt=1)"
expect_contains 'the opt-in forwards the do-not-disrupt switch' "$dnd" 'name: RUNNER_DO_NOT_DISRUPT'
expect_contains 'the opt-in carries the value the operator set' "$dnd" 'value: "1"'

[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$(cat "$work/rendered.yaml")")" -eq 1 ] &&
    ok 'the dashboard PDB renders in the local profile' ||
    bad 'the dashboard PDB renders in the local profile' 'expected exactly one PDB'
[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$gh")" -eq 1 ] &&
    ok 'the dashboard PDB renders at the production defaults' ||
    bad 'the dashboard PDB renders at the production defaults' "$(grep -c 'kind: PodDisruptionBudget' <<<"$gh") PDBs"
expect_contains 'the dashboard PDB allows one unavailable' "$gh" 'maxUnavailable: 1'
expect_not_contains 'no driver PDB below two replicas' "$gh" 'minAvailable: 1'
two="$(gh_render --set driver.replicas=2)"
[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$two")" -eq 2 ] &&
    ok 'the driver PDB renders above one replica' ||
    bad 'the driver PDB renders above one replica' "$(grep -c 'kind: PodDisruptionBudget' <<<"$two") PDBs"
expect_contains 'the driver PDB keeps one replica through a drain' "$two" 'minAvailable: 1'
driver_pdb="$(awk '/^# Source: factory\/templates\/pdb.yaml/ { n++ } n == 2 && /^---$/ { exit } n == 2 { print }' <<<"$two")"
expect_contains 'the driver PDB selects the driver component' "$driver_pdb" 'component: driver'
helm lint charts/factory "${GH_SETS[@]}" --set driver.replicas=2 >/dev/null 2>&1 &&
    ok 'helm lint passes above one driver replica' ||
    bad 'helm lint passes above one driver replica' 'lint failed'

# --- The EKS-shaped render lane (#364): the cloud shape, rendered offline ----------------------
#
# The cluster phase refuses every non-kind context on purpose — it deletes runner Jobs — so no
# automated lane ever installs this chart against a cloud cluster. What CAN be asserted without
# one is the value shape an EKS install sets: the same set docs/eks-runbook.md walks by hand, and
# the two must not drift — a mismatch is a bug in one of them. The needles below are read off the
# COMBINED render, every runbook feature in one release, which is itself the assertion: no two
# values the runbook sets may be mutually exclusive. The annotation values go through --set-string,
# where plain --set would parse the JSON-shaped ones as structured data and mangle the render.
EKS_SETS=(
    "${GH_SETS[@]}"
    --set global.imageRegistry=ghcr.io/example
    --set workspaces.storageClass=efs-ap
    --set ingress.enabled=true --set ingress.className=alb
    --set 'ingress.hosts={factory.example}'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/scheme=internet-facing'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/target-type=ip'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/certificate-arn=arn:aws:acm:eu-west-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/listen-ports=[{"HTTP":80}\,{"HTTPS":443}]'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/ssl-redirect=443'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/healthcheck-path=/api/health'
    --set runner.nodeSelector.dedicated=factory-runners
    --set 'runner.tolerations[0].key=dedicated' --set 'runner.tolerations[0].operator=Equal'
    --set 'runner.tolerations[0].value=factory-runners' --set 'runner.tolerations[0].effect=NoSchedule'
    --set driver.runnerDoNotDisrupt=1
    --set 'isolation.allowedCidrs={10.5.5.5/32}'
)
eks_render() { helm template "$RELEASE" charts/factory "${EKS_SETS[@]}" --namespace "$NAMESPACE" "$@" 2>&1; }

if ! eks="$(eks_render)"; then
    bad 'the EKS-shaped values render as one shape' "${eks:0:400}"
else
    ok 'the EKS-shaped values render as one shape'
fi
# The claim and its class: the EFS decision, pinned so a values regression cannot silently drop
# the cloud install back onto a default class that cannot serve ReadWriteMany.
expect_contains 'the EKS shape names the EFS storage class on the claim' "$eks" 'storageClassName: "efs-ap"'
expect_contains 'the EFS claim stays ReadWriteMany' "$eks" '- ReadWriteMany'
# The chart's gate request (issue #507): a gate runs the whole suite, so it requests more than a runner.
expect_contains 'the gate cpu request renders from the chart value' "$(grep -A1 'name: GATE_CPU_REQUEST' <<<"$eks")" 'value: "2"'
expect_contains 'the gate memory request renders from the chart value' "$(grep -A1 'name: GATE_MEMORY_REQUEST' <<<"$eks")" 'value: "2Gi"'
# The registry prefix composes with every image, and the wait image stays whole — the two rules
# the prefix's own block pins separately, pinned together here because the runbook sets both.
expect_contains 'the EKS shape prefixes the dashboard image' "$eks" "image: ghcr.io/example/factory-ai:$app_version"
expect_contains 'the EKS shape prefixes the executor values' "$eks" 'value: "ghcr.io/example/claude-executor"'
expect_contains 'the wait image stays whole under the EKS prefix' "$eks" 'image: postgres:17-alpine'
# The ingress, scoped to its own document: class and the two annotations that carry behaviour
# (where traffic lands, what the ALB health check reads).
eks_ingress="$(awk '/^# Source: factory\/templates\/ingress.yaml/,/^---/' <<<"$eks")"
expect_contains 'the ALB class fronts the EKS ingress' "$eks_ingress" 'ingressClassName: alb'
expect_contains 'the ALB target type routes to pod IPs' "$eks_ingress" 'alb.ingress.kubernetes.io/target-type: ip'
expect_contains 'the ALB healthcheck path is the liveness route' "$eks_ingress" \
    'alb.ingress.kubernetes.io/healthcheck-path: /api/health'
# The runner group's scheduling: the driver is handed the node selector and tolerations as JSON
# (issue #361), the tainted node group's contract, in the same render that names the storage class.
expect_contains 'the EKS shape hands the driver the runner node selector as JSON' "$eks" \
    'value: "{\"dedicated\":\"factory-runners\"}"'
expect_contains 'the EKS shape hands the driver the runner tolerations as JSON' "$eks" \
    'value: "[{\"effect\":\"NoSchedule\",\"key\":\"dedicated\",\"operator\":\"Equal\",\"value\":\"factory-runners\"}]"'
eks_driver="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$eks")"
# Name and value asserted adjacent: `value: "1"` alone is satisfied by RUNNER_SERVICES' default in
# the same document, so the second needle could never fail on its own.
expect_contains 'the EKS shape forwards the do-not-disrupt switch, value set' "$eks_driver" \
    $'- name: RUNNER_DO_NOT_DISRUPT\n                        value: "1"'
# The VPC-endpoint escape hatch (docs/kubernetes.md, "EKS prerequisites"): a /32 in allowedCidrs
# renders as its own ipBlock beside the except-carving 0.0.0.0/0 rule — the only way a runner
# reaches a private host, and never asserted anywhere until now.
eks_netpol="$(awk '/^# Source: factory\/templates\/runner-networkpolicy.yaml/,/^---/' <<<"$eks")"
expect_contains 'an allowed VPC endpoint cidr reaches the runner policy' "$eks_netpol" 'cidr: 10.5.5.5/32'
# The port scoping (#382) survives the cloud value set: an EKS install must not quietly go back to
# reaching every port on the dashboard and collector.
expect_contains 'the EKS shape keeps the dashboard port scoping' "$eks_netpol" \
    $'app.kubernetes.io/component: dashboard\n          ports:'
expect_contains 'the EKS shape keeps the collector OTLP port scoping' "$eks_netpol" \
    $'app.kubernetes.io/component: collector\n          ports:'
# ...and keeps the driver rule PORTLESS. Asserted in the same breath as the two above: the cloud
# shape can drift in either direction, and a driver rule that grew a port list would break every
# gate run on EKS while every port-scoping assertion still passed.
expect_contains 'the EKS shape keeps the driver egress portless for the ephemeral gate endpoint' \
    "$eks_netpol" $'app.kubernetes.io/component: driver\n        - to:'
helm lint charts/factory "${EKS_SETS[@]}" >/dev/null 2>&1 && ok 'helm lint passes on the EKS shape' \
    || bad 'helm lint passes on the EKS shape' 'lint failed'

# --- Phase three: the enforcing-CNI lane (issue #382) -------------------------------------------
#
#   scripts/test-k8s.sh --netpol
#
# Everything the runner NetworkPolicy claims is inert without a CNI that enforces NetworkPolicy,
# and kind's default CNI (kindnet) does NOT enforce it. That makes this the one lane that cannot
# borrow phase two's cluster: an "access denied" assertion against a non-enforcing CNI passes
# while proving nothing, which is strictly worse than having no test. So this lane CREATES its own
# cluster — kindnet disabled, Calico installed — runs an enforcement self-check that fails the
# whole lane if a known-denied address turns out reachable, and deletes the cluster on the way
# out. It never touches the caller's current context or any cluster it did not create, which is
# why phase two's guard (which refuses every context it has not fingerprinted, because it deletes
# Jobs) is left exactly as it was.
#
# This is also the one lane that needs the NETWORK: Calico's manifest and the probe image are
# pulled. Everything else in this file is offline.

if [ "$MODE" = '--netpol' ]; then
    begin_phase netpol
    for tool in kind kubectl docker; do
        command -v "$tool" >/dev/null || {
            echo "test-k8s: $tool is required for the --netpol lane"
            exit 1
        }
    done

    echo
    echo '# enforcing-CNI isolation'

    NETPOL_CLUSTER="factory-netpol-$$"
    NETPOL_KUBECONFIG="$work/netpol.kubeconfig"
    NETPOL_NS=factory-netpol
    # Pinned, not `latest`: a CNI that changed its manifest layout under us would fail this lane
    # with a download error rather than a policy verdict, and the two must never look alike.
    CALICO_VERSION=v3.28.2
    CALICO_URL="https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/calico.yaml"

    kn() { kubectl --kubeconfig "$NETPOL_KUBECONFIG" "$@"; }

    # Chained onto the file's own cleanup, never replacing it: that one owns $work (and the
    # releases phase two installs, which this lane never does). A trap that dropped it would leave
    # the work directory behind on every --netpol run.
    netpol_cleanup() { kind delete cluster --name "$NETPOL_CLUSTER" >/dev/null 2>&1 || true; }
    trap 'netpol_cleanup; cleanup' EXIT

    cat >"$work/kind-netpol.yaml" <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
    # The whole point of this lane. kindnet ships with kind and does not enforce NetworkPolicy, so
    # it is turned off and Calico installed in its place; until Calico is up the cluster has no pod
    # network at all, which is why the node readiness wait below is not optional.
    disableDefaultCNI: true
    podSubnet: "192.168.0.0/16"
EOF
    echo "creating kind cluster $NETPOL_CLUSTER (no default CNI)"
    kind create cluster --name "$NETPOL_CLUSTER" --kubeconfig "$NETPOL_KUBECONFIG" \
        --config "$work/kind-netpol.yaml" >/dev/null 2>&1 || {
        echo 'test-k8s: could not create the kind cluster for the --netpol lane'
        exit 1
    }

    echo "installing Calico $CALICO_VERSION"
    kn apply -f "$CALICO_URL" >/dev/null 2>&1 || {
        echo "test-k8s: could not apply the Calico manifest ($CALICO_URL) — this lane needs network"
        exit 1
    }
    kn wait --for=condition=Ready node --all --timeout=300s >/dev/null 2>&1 || {
        echo 'test-k8s: nodes never became Ready — Calico did not come up'
        exit 1
    }
    kn wait --for=condition=Available deployment/calico-kube-controllers -n kube-system \
        --timeout=300s >/dev/null 2>&1 || true

    kn create namespace "$NETPOL_NS" >/dev/null 2>&1 || true

    # One pod per role, each exactly as the policy's selectors see it. The runner pods carry
    # `factory.job` and the release instance label and NOT `app.kubernetes.io/name`, which is what
    # the policy's podSelector is written against; the chart pods carry both.
    netpol_pod() { # netpol_pod <name> <labels json> [<args>]
        kn run "$1" -n "$NETPOL_NS" --image=alpine:3 --restart=Never \
            --overrides="{\"metadata\":{\"labels\":$2},\"spec\":{\"automountServiceAccountToken\":false,\"containers\":[{\"name\":\"$1\",\"image\":\"alpine:3\",\"command\":[\"sh\",\"-c\",\"${3:-sleep 3600}\"]}]}}" \
            --command -- sh >/dev/null 2>&1
    }
    # busybox `nc`, which alpine already has, rather than `apk add socat`: the install needs the
    # network from inside the pod and takes an unbounded amount of time, and a listener that is not
    # up yet reads to every probe exactly like a listener the policy blocked. Re-listening in a
    # loop because busybox nc serves one connection and exits.
    LISTEN='while :; do nc -l -p 8080 >/dev/null 2>&1; done & while :; do nc -l -p 9999 >/dev/null 2>&1; done & sleep 3600'

    netpol_pod attempt-a "{\"factory.job\":\"aaaa\",\"factory.lease\":\"la\",\"app.kubernetes.io/instance\":\"$RELEASE\"}"
    netpol_pod attempt-b "{\"factory.job\":\"bbbb\",\"factory.lease\":\"lb\",\"app.kubernetes.io/instance\":\"$RELEASE\"}" "$LISTEN"
    netpol_pod unrelated '{"role":"unrelated"}' "$LISTEN"
    netpol_pod dashboard \
        "{\"app.kubernetes.io/name\":\"factory\",\"app.kubernetes.io/instance\":\"$RELEASE\",\"app.kubernetes.io/component\":\"dashboard\"}" \
        "$LISTEN"

    # The node itself, as a probeable address. "A runner may not reach its node" needs something
    # LISTENING on the node for the denial to mean anything — a kind node runs no sshd, and a
    # closed port answers `denied` with or without a policy. This pod binds the host network
    # directly, so 31999 is open on the node's own InternalIP: inside blockedCidrs (172.16/12 on
    # kind), reachable before the policy and dropped after it. It is the only pod here that needs
    # host access, it exists purely to be a target, and it is deleted with the cluster.
    kn run node-listener -n "$NETPOL_NS" --image=alpine:3 --restart=Never \
        --overrides="{\"spec\":{\"hostNetwork\":true,\"automountServiceAccountToken\":false,\"containers\":[{\"name\":\"node-listener\",\"image\":\"alpine:3\",\"command\":[\"sh\",\"-c\",\"while :; do nc -l -p 31999 >/dev/null 2>&1; done\"]}]}}" \
        --command -- sh >/dev/null 2>&1

    for p in attempt-a attempt-b unrelated dashboard node-listener; do
        kn wait --for=condition=Ready "pod/$p" -n "$NETPOL_NS" --timeout=180s >/dev/null 2>&1 || {
            echo "test-k8s: probe pod $p never became Ready"
            exit 1
        }
    done
    ip_of() { kn get pod "$1" -n "$NETPOL_NS" -o jsonpath='{.status.podIP}'; }
    IP_B="$(ip_of attempt-b)"
    IP_UNRELATED="$(ip_of unrelated)"
    IP_DASH="$(ip_of dashboard)"
    NODE_IP="$(kn get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
    API_IP="$(kn get service kubernetes -n default -o jsonpath='{.spec.clusterIP}')"

    # `reaches` answers one question and prints one word, so every assertion below reads the same
    # way round. A denied connection is a DROPPED packet, so it costs the full timeout — which is
    # also why the timeout is short.
    reaches() { # reaches <from pod> <host> <port>
        if kn exec "$1" -n "$NETPOL_NS" -- sh -c "nc -z -w 4 $2 $3 >/dev/null 2>&1" >/dev/null 2>&1; then
            echo reachable
        else
            echo denied
        fi
    }

    # THE DENIAL TARGETS, and the rule that keeps every one of them honest: each is probed BEFORE
    # the policy is applied and must answer `reachable` there. An address that was already
    # unreachable — no listener, no responder, wrong IP — would answer `denied` afterwards no
    # matter what the policy said, and the lane would report a pass having proved nothing. That is
    # the single failure mode this whole lane exists to avoid, so it is checked per target rather
    # than once.
    #
    # Each target is `<name>|<host>|<port>`, and each is a REAL listener on this cluster:
    #   - the unrelated pod on both its ports (an unrelated workload),
    #   - the kubernetes API's ClusterIP (the service network, inside blockedCidrs 10/8),
    #   - the kubelet on the node's own address (inside blockedCidrs 172.16/12 on kind),
    #   - a hostNetwork pod bound to a high port on that same node address — the node itself,
    #     reachable only because something is actually listening there. There is deliberately no
    #     `:22` probe: a kind node runs no sshd, so that assertion could only ever be vacuous.
    DENIALS="unrelated pod|$IP_UNRELATED|8080
another port on an unrelated pod|$IP_UNRELATED|9999
the kubernetes API|$API_IP|443
the kubelet on its node|$NODE_IP|10250
the node itself|$NODE_IP|31999
another port on the dashboard|$IP_DASH|9999"

    # Ready means ANSWERING, not Running: the kubelet calls a pod Ready as soon as its process
    # starts, which is before the listener inside it has bound. Polled rather than slept, because
    # a fixed sleep is either too short (and the honest-probe controls below fail for a reason
    # that has nothing to do with the policy) or wasted on every run. EVERY probe target is
    # polled, not just the first: `node-listener` is a separate pod with its own image pull and is
    # the likeliest laggard, and a target that is merely slow would otherwise fail its own
    # control. `attempt-b` is in the list too — it is not a DENIALS entry (its reachability is the
    # #257 residual, asserted at the end) but it is a listener this lane waits on all the same.
    #
    # The first target that never comes up abandons the whole wait rather than letting each
    # remaining one burn its own budget: the lane is already going to fail its honest-probe
    # control, and six targets each waiting out 30 attempts would delay that verdict by a
    # quarter of an hour for no extra information.
    poll_ready=1
    while IFS='|' read -r what host port; do
        [ -n "$what" ] || continue
        [ "$poll_ready" = '1' ] || continue
        ready=0
        for _ in $(seq 1 30); do
            if [ "$(reaches attempt-a "$host" "$port")" = 'reachable' ]; then
                ready=1
                break
            fi
            sleep 2
        done
        [ "$ready" = '1' ] || poll_ready=0
    done <<EOF
$DENIALS
the cross-attempt residual target|$IP_B|8080
EOF

    while IFS='|' read -r what host port; do
        [ -n "$what" ] || continue
        expect_contains "before any policy, a runner reaches $what (so the probe is honest)" \
            "$(reaches attempt-a "$host" "$port")" 'reachable'
    done <<EOF
$DENIALS
EOF

    awk '/^# Source: factory\/templates\/runner-networkpolicy.yaml/,/^---/' "$work/rendered.yaml" |
        grep -v '^---$' | kn apply -n "$NETPOL_NS" -f - >/dev/null 2>&1 || {
        echo 'test-k8s: the rendered runner NetworkPolicy would not apply'
        exit 1
    }
    sleep 5

    while IFS='|' read -r what host port; do
        [ -n "$what" ] || continue
        expect_contains "a runner may not reach $what" "$(reaches attempt-a "$host" "$port")" 'denied'
    done <<EOF
$DENIALS
EOF

    # NOT probed, and said out loud rather than left as a gap: the cloud metadata endpoint
    # (169.254.169.254). Nothing answers on it in a kind cluster, so a probe would report `denied`
    # whether or not the policy covered it — exactly the vacuous pass the controls above exist to
    # prevent, and worse here because metadata access is the highest-value denial in the issue.
    # What IS proved is the mechanism it depends on: 169.254.0.0/16 and 172.16.0.0/12 are both
    # `blockedCidrs` entries excluded from the same `0.0.0.0/0` egress rule, and the node probe
    # above shows that rule actually dropping traffic to a blocked private range. The endpoint's
    # own defence is a node-level setting the chart cannot make either way
    # (`httpPutResponseHopLimit: 1`, docs/kubernetes.md). Recorded in docs/executor-testing.md
    # under "What no lane covers".

    # The port scoping (#382), positive half: the dashboard stays reachable where it actually
    # serves. The negative half — 9999 on that same pod — is in DENIALS above rather than here,
    # precisely because it is the assertion this whole change exists for: asserted standalone it
    # would report `denied` if the dashboard's second listener had simply failed to bind, which is
    # the vacuous pass every other denial is already protected from.
    expect_contains 'a runner reaches the dashboard on its serving port' "$(reaches attempt-a "$IP_DASH" 8080)" 'reachable'

    # The positive probes: a run that cannot resolve a name or reach its own fleet is a run that
    # does not work, and an isolation change that breaks them has not hardened anything.
    dns="$(kn exec attempt-a -n "$NETPOL_NS" -- sh -c 'nslookup kubernetes.default.svc.cluster.local >/dev/null 2>&1 && echo resolves || echo broken' 2>/dev/null)"
    expect_contains 'a runner still resolves cluster DNS' "$dns" 'resolves'

    # The STATED RESIDUAL, asserted rather than assumed. One attempt can still reach another
    # attempt's pods: the policy's runner-to-runner rule is what makes a declared service
    # reachable from its own runner, and it does not distinguish attempts. #257 owns narrowing it.
    # Pinned as `reachable` on purpose — when #257 lands, THIS line is what tells its author the
    # behaviour changed, instead of the change being invisible.
    expect_contains 'cross-attempt traffic is still allowed — the #257 residual, measured not assumed' \
        "$(reaches attempt-a "$IP_B" 8080)" 'reachable'

    netpol_cleanup
    trap cleanup EXIT
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

# --- Phase two: the cluster -------------------------------------------------------------------

if [ "$MODE" != '--cluster' ]; then
    printf '\n%d passed, %d failed (cluster phase skipped — pass --cluster or --netpol)\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

begin_phase cluster-preflight
for tool in kubectl docker openssl; do
    command -v "$tool" >/dev/null || {
        echo "test-k8s: $tool is required for the cluster phase"
        exit 1
    }
done

# The cluster phase installs a release and deletes runner Jobs in its namespace — and "runner Job"
# is identified only by the factory.job label, which any release in the namespace shares. This
# script is built for a disposable local kind cluster; anything else has to say so twice: the
# context must be shaped `kind-<name>` (how kind always names them) AND that name's cluster must
# be the one actually serving the context. Those two facts are BOUND, not checked independently:
# kind publishes the control-plane API on host 127.0.0.1:<port> and writes that same `server:`
# into the kubeconfig, so the guard reads the context's server address and requires a control-plane
# container labelled `io.x-k8s.kind.cluster=<name>` (the same label `kind load --name` resolves
# below; k8s node objects carry no kind label) to be publishing that port. Two independent
# fingerprints — a docker label on this daemon, node objects over the wire — could each pass
# against a different cluster and admit a context aimed anywhere; the endpoint cannot. There is
# no override — a context outside both has no image-load path here anyway.
context="$(kubectl config current-context 2>/dev/null || true)"
case "$context" in
kind-*)
    kind_name="${context#kind-}"
    command -v kind >/dev/null || {
        echo "test-k8s: kind is required for the cluster phase (context is $context)"
        exit 1
    }
    server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)"
    [ -n "$server" ] || {
        echo "test-k8s: refusing to run the cluster phase against '$context'."
        echo "  It deletes every runner Job in the namespace, and the context's API server"
        echo "  address could not be read — the context may be dangling or not a kind"
        echo "  cluster's. Create one (`kind create cluster --name <name>`) and aim kubectl at it."
        exit 1
    }
    serving=0
    for container in $(docker ps -q --filter "label=io.x-k8s.kind.cluster=$kind_name" \
        --filter 'label=io.x-k8s.kind.role=control-plane'); do
        host_port="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "6443/tcp") 0).HostPort}}' \
            "$container" 2>/dev/null || true)"
        case "$server" in
        "https://127.0.0.1:$host_port" | "https://localhost:$host_port")
            serving=1
            break
            ;;
        esac
    done
    [ "$serving" = '1' ] || {
        echo "test-k8s: refusing to run the cluster phase against '$context'."
        echo "  It deletes every runner Job in the namespace, and no kind cluster named"
        echo "  '$kind_name' is serving the context's endpoint ($server): no control-plane"
        echo "  container of that cluster publishes the port the context points at. It"
        echo "  may not be a disposable kind cluster."
        echo '  Create one (`kind create cluster --name <name>`) and aim kubectl at it.'
        exit 1
    }
    ;;
*)
    echo "test-k8s: refusing to run the cluster phase against '$context'."
    echo '  It deletes every runner Job in the namespace. Create a disposable kind cluster'
    echo '  (`kind create cluster --name <name>`) and aim kubectl at it — its context is'
    echo '  kind-<name>.'
    exit 1
    ;;
esac

echo
echo '# cluster'

kubectl cluster-info >/dev/null 2>&1 || {
    echo "test-k8s: no reachable cluster (is the kind cluster $kind_name running?)"
    exit 1
}

command -v node >/dev/null || {
    echo 'test-k8s: node is required for the cluster phase'
    exit 1
}

echo 'building the images on the host daemon'
begin_phase images
# The stub echoes the claude config content and its argv; `factory-stub-wait-<path>` holds it
# until the harness releases that file, so disruption tests observe a running agent. It stands on
# node + git as the uid-1000 `node` user, like the executor images: the startup sync and the other
# supervised steps run IN the job's executor image (the task supervisor's container,
# `driver/src/scripts/supervisor.cjs`), and every task has a checkout to sync (issue #263). It
# starts through scripts/stub-agent.sh, beside ctl-agent.cjs, over the node-owned mailbox mount
# points: the task supervisor's agent contract (driver/test/lane-stubs.test.ts), which the real
# entrypoints honor.
cp docker/claude-executor/ctl-agent.cjs scripts/stub-agent.sh "$work/"
cp docker/claude-executor/github-credential.cjs "$work/"
cp scripts/k8s-stub.sh "$work/stub.sh"
printf 'FROM public.ecr.aws/docker/library/node:24-alpine\nRUN apk add --no-cache git\nCOPY stub.sh /stub.sh\nCOPY ctl-agent.cjs stub-agent.sh /usr/local/bin/\nCOPY github-credential.cjs /usr/local/bin/\nRUN mkdir -p /factory/in /factory/out /factory/export /factory/supervisor && chown -R node:node /factory\nUSER node\nENTRYPOINT ["sh","/usr/local/bin/stub-agent.sh","sh","/stub.sh"]\n' >"$work/stub.Dockerfile"
# Two Docker builds at once. Each process owns its log and is joined even if a sibling fails.
docker build -f docker/Dockerfile --target runtime -q -t "$DASH_IMAGE" . >"$work/dashboard-build.log" 2>&1 &
dash_build=$!
docker build -f docker/driver.Dockerfile -q -t "$DRIVER_IMAGE" . >"$work/driver-build.log" 2>&1 &
driver_build=$!
build_failed=0
wait "$dash_build" || { tail -30 "$work/dashboard-build.log"; build_failed=1; }
dash_build=''
wait "$driver_build" || { tail -30 "$work/driver-build.log"; build_failed=1; }
driver_build=''
[ "$build_failed" -eq 0 ] || exit 1
docker build -q -t "$STUB_IMAGE" -f "$work/stub.Dockerfile" "$work" >"$work/stub-build.log" 2>&1 &
stub_build=$!
docker image inspect "$COLLECTOR_IMAGE" >/dev/null 2>&1 || docker pull -q "$COLLECTOR_IMAGE" >"$work/collector-pull.log" 2>&1 &
collector_pull=$!
wait "$stub_build" || { tail -30 "$work/stub-build.log"; build_failed=1; }
stub_build=''
wait "$collector_pull" || { tail -30 "$work/collector-pull.log"; build_failed=1; }
collector_pull=''
[ "$build_failed" -eq 0 ] || exit 1

echo "loading the images into the kind cluster $kind_name"
begin_phase image-load
# Whether every node already holds <image> under its name at the id the host daemon has: `kind load`
# copies the whole archive into each node however unchanged it is, minutes for the board image. The
# id is the image config digest on both sides; any doubt — a digest reference, a node that cannot
# be read, a daemon whose ids are not config digests — answers no, and the image is loaded.
image_on_nodes() { # image_on_nodes <image>
    local want nodes node
    want="$(docker image inspect --format '{{.Id}}' "$1" 2>/dev/null)" || return 1
    nodes="$(kind get nodes --name "$kind_name" 2>/dev/null)"
    [ -n "$want" ] && [ -n "$nodes" ] || return 1
    for node in $nodes; do
        docker exec "$node" crictl images -o json 2>/dev/null | node -e '
const [ref, want] = process.argv.slice(1);
if (ref.includes("@")) process.exit(1);
const slash = ref.indexOf("/");
const first = slash === -1 ? "" : ref.slice(0, slash);
const named = slash === -1 ? `docker.io/library/${ref}` : /[.:]/.test(first) || first === "localhost" ? ref : `docker.io/${ref}`;
const full = named.slice(named.lastIndexOf("/")).includes(":") ? named : `${named}:latest`;
let images = [];
try { images = JSON.parse(require("node:fs").readFileSync(0, "utf8")).images ?? []; } catch { process.exit(1); }
process.exit(images.some((i) => i.id === want && (i.repoTags ?? []).includes(full)) ? 0 : 1);
' "$1" "$want" || return 1
    done
}

# One load call per image, not one variadic invocation: every kind version accepts
# `kind load docker-image <image> --name <cluster>`, older ones not always a list.
for image in "$DASH_IMAGE" "$DRIVER_IMAGE" "$STUB_IMAGE" "$COLLECTOR_IMAGE"; do
    if image_on_nodes "$image"; then
        echo "  $image is already on every node"
        continue
    fi
    kind load docker-image "$image" --name "$kind_name" >/dev/null || {
        echo "test-k8s: could not load $image into the kind cluster $kind_name"
        exit 1
    }
done

echo "installing the releases $STATE_RELEASE and $RELEASE"
begin_phase deploy
helm install "$STATE_RELEASE" charts/factory-local-state -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install of the state chart failed'
    exit 1
}
state_installed=1
# Fresh throwaway secrets per run; the board token is what the driver presents on every claim, so a
# job that comes back succeeded proves it end to end. The origin is the port-forward's below.
PORT=18080
BASE="http://127.0.0.1:$PORT"
auth_sets "$BASE" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)"
helm install "$RELEASE" charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" \
    --set "dashboard.image.repository=$DASH_IMAGE" \
    --set "driver.image.repository=$DRIVER_IMAGE" \
    --set "driver.executorImages.claudeCode=$STUB_IMAGE" \
    --set "driver.executorImages.opencode=$STUB_IMAGE" \
    --set driver.reapIntervalMs=3000 --set driver.reapGraceMs=1000 \
    --set-string driver.leaseSeconds=120 --set driver.terminationGracePeriodSeconds=70 \
    -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install failed'
    exit 1
}
installed=1

# The postgres StatefulSet is waited for deliberately: the dashboard listens the moment its
# process is up — health answers, availability reports — but its migrations only start landing
# once the database accepts connections, and the server gives up retrying after ~45s. On a cold
# kind node the database image is still being pulled through containerd in that window, so
# queueing before it is available fails every POST no matter how long the queue step polls.
# A StatefulSet carries no `available` condition, so the database is waited for by rollout
# status rather than being folded into the condition wait with the three Deployments.
kubectl wait --for=condition=available \
    "deployment/$RELEASE-factory" "deployment/$RELEASE-factory-driver" \
    "deployment/$RELEASE-factory-collector" \
    -n "$NAMESPACE" --timeout=600s >/dev/null 2>&1 &&
    kubectl rollout status "statefulset/$STATE_RELEASE-postgres" \
        -n "$NAMESPACE" --timeout=600s >/dev/null 2>&1 &&
    ok 'the dashboard, driver, database and collector come up' || \
    bad 'the dashboard, driver, database and collector come up' \
        "$(kubectl get pods -n "$NAMESPACE" | tail -5)"

# Through the dashboard, so the assertion is the user's own path: queue, then poll the board.
begin_phase smoke
PF_LOG="$work/portforward.log"
kubectl port-forward "svc/$RELEASE-factory" "$PORT:8080" -n "$NAMESPACE" >"$PF_LOG" 2>&1 &
pf_pid=$!

# Every human route needs a member behind it. The node calls below read the member's personal
# access token from FACTORY_TOKEN — the environment, not argv, so it never shows in a process
# listing — and send it as a bearer when it is set.
JS_HEADERS='const headers = { "content-type": "application/json" };
if (process.env.FACTORY_TOKEN) headers.authorization = "Bearer " + process.env.FACTORY_TOKEN;'
http_status() { # http_status <method> <url> [json body] — the status code, 000 when nothing answered
    node -e "$JS_HEADERS"'
fetch(process.argv[2], { method: process.argv[1], headers, body: process.argv[3] })
    .then((r) => process.stdout.write(String(r.status)))
    .catch(() => process.stdout.write("000"));
' "$@"
}
give_up() {
    kill "$pf_pid" 2>/dev/null
    # What the lane was standing on when it stopped: the port-forward and this release's pods.
    echo '--- port-forward'
    tail -5 "$PF_LOG" 2>/dev/null
    echo '--- pods'
    kubectl get pods -l "app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" 2>&1 | head -20
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
}

first_runner_job() { # first_runner_job <id> -> the name of the runner Job claim 1 created
    kubectl get jobs -l "factory.job=$1,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.factory\.claim-seq}{"\n"}{end}' \
        2>/dev/null | awk '$2 == "1" { print $1; exit }'
}

await_runner_pod() { # await_runner_pod <id> -> the claim-1 runner pod's name once it runs, empty on timeout
    local name="" pod=""
    for _ in $(seq 1 120); do
        [ -n "$name" ] || name="$(first_runner_job "$1")"
        [ -n "$name" ] && pod="$(kubectl get pods -l "job-name=$name" -n "$NAMESPACE" \
            -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{end}' 2>/dev/null)"
        [ -n "$pod" ] && break
        sleep 1
    done
    printf '%s' "$pod"
}

await_blocked() { # await_blocked <runner pod> <release file> -> the agent is running behind its barrier
    # Pod Running and even `go` can precede the agent: observe the stub itself before disrupting it.
    for _ in $(seq 1 60); do
        kubectl exec "$1" -c agent -n "$NAMESPACE" -- test -f "$2.ready-$1" >/dev/null 2>&1 && return 0
        sleep 1
    done
    bad 'the stub agent reached its barrier' 'no ready marker within 60s'
    return 1
}

release_stub() {
    # The member workspace survives pod deletion, so the replacement agent sees the same release.
    kubectl exec "deployment/$RELEASE-factory" -c dashboard -n "$NAMESPACE" -- touch "$1" || give_up
}

up=""
for _ in $(seq 1 30); do
    [ "$(http_status GET "$BASE/api/health")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done
[ -n "$up" ] && ok 'the board answers through the service' || {
    bad 'the board answers through the service' "$(cat "$PF_LOG")"
    give_up
}

# The rows below go straight into the tables the migrations create, so wait for them: /api/ready
# answers 200 only once every migration has landed.
ready=""
for _ in $(seq 1 120); do
    [ "$(http_status GET "$BASE/api/ready")" = '200' ] && {
        ready=1
        break
    }
    sleep 1
done
[ -n "$ready" ] && ok 'the board reports its migrations applied' || {
    bad 'the board reports its migrations applied' 'GET /api/ready never answered 200'
    give_up
}

SMOKE_REPO='factory-smoke/demo'
JOB_BODY='{"command":"hello from the cluster","executor":"claude","repo":"factory-smoke/demo"}'
# The wall is up: no credential, no job.
anon="$(http_status POST "$BASE/api/jobs" "$JOB_BODY")"
[ "$anon" = '401' ] && ok 'an unauthenticated POST /api/jobs is refused 401' ||
    bad 'an unauthenticated POST /api/jobs is refused 401' "got $anon"

# A member, minted where sign-in would have put one. With no App nobody can sign in, so the rows go
# in directly: an organization, a user, the membership that binds them, and a personal access token
# — `fat_` + 32 CSPRNG bytes base64url, stored only as the sha-256 of the whole token
# (server/src/auth/access-token.ts, hashToken in session.ts). Every id is generated here or by the
# database; psql variables carry the values, so nothing is spliced into the SQL text.
read -r FACTORY_TOKEN token_hash < <(node -e '
const c = require("node:crypto");
const t = "fat_" + c.randomBytes(32).toString("base64url");
process.stdout.write(t + " " + c.createHash("sha256").update(t).digest("hex"));
')
member="k8s-test-$(openssl rand -hex 6)"
minted="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" -v "hash=$token_hash" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
with o as (
    insert into organization (id, name) values (:'member', :'member') returning id
), u as (
    insert into app_user (github_user_id, github_login)
    values ((1000000000 + floor(random() * 1000000000000))::bigint, :'member') returning id
), m as (
    insert into org_membership (org_id, github_login, user_id, role, claimed_at)
    select o.id, :'member', u.id, 'member', now() from o, u
)
insert into access_token (org_id, kind, user_id, created_by, label, token_hash)
select o.id, 'personal', u.id, u.id, 'test-k8s', decode(:'hash', 'hex') from o, u;
SQL
)" && ok 'a member and a personal access token are minted' || {
    bad 'a member and a personal access token are minted' "$minted"
    give_up
}
export FACTORY_TOKEN

# The member's checkout (issue #263): POST /api/jobs refuses a create whose repo is not the author's
# own ready selection. With no GitHub there is nothing to clone, so the fixture is what a finished
# clone leaves — the ready user_repo row and, in the workspaces claim under the member's
# `<org>/<user id>` subtree, the clone — with its origin a bare repository beside it, so every
# startup sync fetches and branches its task worktree with no network. scripts/test-jobs.sh's
# fixture, on the claim: a one-shot pod of this run mounts the claim root, creates the subtree as
# root and hands it to uid 1000, then the stub image (git, uid 1000) writes the repositories.
member_user="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -qtA -v ON_ERROR_STOP=1 -v "member=$member" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
select user_id from org_membership where org_id = :'member';
SQL
)"
member_path="$member/$member_user"
case "$member_user" in
????????-????-????-????-????????????) ;;
*) bad 'the member has a user id' "$member_user"
    give_up
    ;;
esac
selected="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" -v "user=$member_user" \
    -v "owner=${SMOKE_REPO%%/*}" -v "name=${SMOKE_REPO#*/}" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
insert into user_repo (org_id, user_id, repo_owner, repo_name, status, ready_at)
values (:'member', :'user', :'owner', :'name', 'ready', now());
SQL
)" && ok 'the member selects a ready repository' || {
    bad 'the member selects a ready repository' "$selected"
    give_up
}
# One line, no double quotes or backslashes: it is interpolated into the JSON override below.
seed_script="set -e; cd /workspaces/$member_path;
git init -q --bare -b main .smoke-origin.git;
git init -q -b main /tmp/seed;
git -C /tmp/seed -c user.name=test-k8s -c user.email=test-k8s@localhost commit -q --allow-empty -m init;
git -C /tmp/seed push -q /workspaces/$member_path/.smoke-origin.git main;
git clone -q /workspaces/$member_path/.smoke-origin.git ${SMOKE_REPO#*/};
echo seeded"
seed_script="$(printf '%s' "$seed_script" | tr '\n' ' ')"
kubectl run "$RELEASE-repo-seed" -n "$NAMESPACE" --image="$STUB_IMAGE" --restart=Never --command \
    --overrides="$(
        cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"volumes":[{"name":"w","persistentVolumeClaim":{"claimName":"$STATE_RELEASE-workspaces"}}],
"initContainers":[{"name":"own","image":"alpine:3",
"command":["sh","-c","mkdir -p /workspaces/$member_path && chown 1000:1000 /workspaces/$member_path"],
"volumeMounts":[{"name":"w","mountPath":"/workspaces"}]}],
"containers":[{"name":"seed","image":"$STUB_IMAGE","imagePullPolicy":"IfNotPresent",
"command":["sh","-c","$seed_script"],
"volumeMounts":[{"name":"w","mountPath":"/workspaces"}]}]}}
EOF
    )" -- sh >/dev/null 2>&1
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s "pod/$RELEASE-repo-seed" \
    -n "$NAMESPACE" >/dev/null 2>&1
repo_seeded="$(kubectl logs "$RELEASE-repo-seed" -n "$NAMESPACE" --all-containers 2>&1 || true)"
kubectl delete pod "$RELEASE-repo-seed" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
case "$repo_seeded" in
*seeded*) ok 'the member checkout is seeded in the workspaces claim' ;;
*) bad 'the member checkout is seeded in the workspaces claim' "$repo_seeded"
    give_up
    ;;
esac

# A task runs only under an executor from its author's own list — there is no global fallback, and
# a claim whose label matches nothing is failed by the driver — so the fresh member needs one
# before anything is queued. The PUT replaces the whole list, so repeating it is harmless: it
# retries through the same grace the queue loop below allows.
configured=""
for _ in $(seq 1 60); do
    [ "$(http_status PUT "$BASE/api/workspace/executors" \
        '{"executors":[{"name":"claude","type":"claude-code","config":{}}]}')" = '200' ] && {
        configured=1
        break
    }
    sleep 1
done
[ -n "$configured" ] && ok 'the board stores the task executor' ||
    bad 'the board stores the task executor' 'PUT /api/workspace/executors never answered 200'

# The organization-scope leg (issue 391): an org profile seeded straight into the table — the
# admin-created shape, with this lane's member only ever a selector — and a task stamped
# `executorScope: 'org'`. The stub prints the claude config content, so the org model marker in
# the output is the proof the claim resolved the ORG row: the member's personal list is empty.
org_seeded="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
insert into executor_profile (org_id, user_id, name, type, config)
select id, null, 'team', 'claude-code', '{"model":"org-team-model"}'::jsonb from organization where id = :'member';
SQL
)" && ok 'an org executor profile is seeded' || {
    bad 'an org executor profile is seeded' "$org_seeded"
    give_up
}
ORG_BODY="{\"command\":\"hello from the org scope\",\"executor\":\"team\",\"executorScope\":\"org\",\"repo\":\"$SMOKE_REPO\"}"
smoke_release="/workspaces/$member_path/.lane-smoke"
SMOKE_COMMAND="hello from the cluster factory-stub-wait-$smoke_release"
JOB_BODY="{\"command\":\"$SMOKE_COMMAND\",\"executor\":\"claude\",\"repo\":\"$SMOKE_REPO\"}"

# The wait above covers the cold case (database image still pulling); this poll covers the
# residual one — migrations retry on a backoff, so the first POST after the database is up can
# still land inside it. The server adopts the database on the attempt that works; the script
# gives it the same grace. No rejection is proof the job was not created: the route wraps store
# calls in `guard`, which answers 503 to ANY throw — including one raised by the postgres client
# while awaiting the result of an INSERT that has already committed — and a 000 means no response
# came back, not that nothing was processed. Repeating the non-idempotent POST on either would
# queue a duplicate the test does not track. So on 000 and on 5xx the loop reconciles first: it
# reads GET /api/jobs (limit 200, the endpoint's cap) and, if a job whose command is this test's
# command exists, adopts its id and carries on with the normal flow. A list read that FAILS is no
# evidence either way, so only a read that SUCCEEDS and shows no such job re-arms the POST; a
# failed read keeps waiting here (the loop has 60 iterations) rather than re-POSTing blind. Any
# other answer — a 2xx whose body will not parse into an id, say — may have created a job, so
# the loop stops and lets the check below report, rather than re-POSTing the same command into a
# duplicate. Same shape as the status poll below.
id=""
reconcile=0
for _ in $(seq 1 60); do
    if [ "$reconcile" = '0' ]; then
        response="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: process.argv[2] })
    .then(async (r) => { const b = await r.text(); let id = ""; try { id = String(JSON.parse(b).id ?? ""); } catch {} process.stdout.write(r.status + "|" + id); })
    .catch(() => process.stdout.write("000|"));
' "$BASE/api/jobs" "$JOB_BODY")"
        status="${response%%|*}"
        id="${response#*|}"
        case "$status" in
        000 | 5*) reconcile=1 ;;
        *) break ;;
        esac
    else
        adopted="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => {
        if (r.status !== 200) { process.stdout.write("no"); return; }
        const b = await r.json().catch(() => null);
        if (!b || !Array.isArray(b.jobs)) { process.stdout.write("no"); return; }
        const hit = b.jobs.find((j) => j.command === process.argv[2]);
        process.stdout.write(hit ? "id " + String(hit.id) : "none");
    })
    .catch(() => process.stdout.write("no"));
' "$BASE/api/jobs?limit=200" "$SMOKE_COMMAND")"
        case "$adopted" in
        'id '*)
            id="${adopted#id }"
            break
            ;;
        none) reconcile=0 ;; # the read succeeded and showed no such job: re-POST is safe
        esac
    fi
    sleep 1
done
case "$id" in
*-*) ok 'a job was queued' ;;
*) bad 'a job was queued' "no id came back (last status: ${status:-none})"
    give_up
    ;;
esac

# Observe this task's real Job while its agent is held alive, before normal teardown can remove it.
smoke_pod="$(await_runner_pod "$id")"
job_object="$(first_runner_job "$id")"
if [ -n "$smoke_pod" ] && [ -n "$job_object" ]; then
    ok 'a runner Job object exists for the queued task'
    release_stub "$smoke_release"
else
    bad 'a runner Job object exists for the queued task' 'none found while the agent was blocked'
    give_up
fi

# The stub image echoes its arguments, so the output is the proof the prompt reached the pod — the
# same assertion scripts/test-jobs.sh makes against docker.
result=""
for _ in $(seq 1 120); do
    result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.exitCode ?? "") + "\t" + String(j.output ?? "")); })
    .catch(() => process.stdout.write("queued\t\t"));
' "$BASE/api/jobs/$id")"
    case "$result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the job ran to completion' "$result" 'succeeded'
expect_contains 'the prompt reached the pod' "$result" 'hello from the cluster'

# The organization-scope run (issue 391), the kubernetes counterpart of test-jobs.sh's leg: the
# task stamps `executorScope: 'org'`, the claim resolves the ORG row seeded above, and the stub's
# config echo carries the org model marker no personal row on this board could produce.
org_id=""
for _ in $(seq 1 60); do
    response="$(node -e "$JS_HEADERS"'
// `node -e` has no script path in argv: the first argument is argv[1].
const [url, body] = process.argv.slice(1);
fetch(url, { method: "POST", headers, body })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status + "|" + String(b.id ?? "")); })
    .catch(() => process.stdout.write("000|"));
' "$BASE/api/jobs" "$ORG_BODY")"
    status="${response%%|*}"
    org_id="${response#*|}"
    case "$status" in
    000 | 5*) sleep 1 ;;
    201) break ;;
    *) break ;;
    esac
done
case "$org_id" in
*-*) ok 'an org-scoped job was queued' ;;
*) bad 'an org-scoped job was queued' "no id came back (last status: ${status:-none})"
    give_up
    ;;
esac
org_result=""
for _ in $(seq 1 120); do
    org_result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.executorScope ?? "") + "\t" + String(j.output ?? "")); })
    .catch(() => process.stdout.write("queued\t\t"));
' "$BASE/api/jobs/$org_id")"
    case "$org_result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the org-scoped job ran to completion' "$org_result" 'succeeded'
# The read model's second tab field is the stamped scope: matched strictly, because the output
# itself is full of the substring "org" (the prompt, the marker).
expect_contains 'the org scope is stamped on the read' "$org_result" "$(printf 'succeeded\torg\t')"
expect_contains 'the org config reached the pod' "$org_result" 'org-team-model'

# --- The runner's GitHub token (docs/connections.md) --------------------------------------------
#
# The cluster's board is the offline entry, which holds no App: the runner pod's image helper asks
# the credential route with the attempt pair and is told so (409 GITHUB_UNAVAILABLE), saying it on
# stderr. The same pod shows the helper's cache is a Memory emptyDir (tmpfs) and that no GitHub
# token rides its env. Renewal across an expiry is the docker lane's (scripts/test-jobs.sh), whose
# host-side board can carry the stand-in mint.

echo
echo '# github credential'

gh_id="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: JSON.stringify({ command: "factory-stub-github", executor: "claude", repo: process.argv[2] }) })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status === 201 ? String(b.id ?? "") : ""); })
    .catch(() => {});
' "$BASE/api/jobs" "$SMOKE_REPO")"
gh_result=""
for _ in $(seq 1 120); do
    gh_result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.output ?? "")); })
    .catch(() => process.stdout.write("queued\t"));
' "$BASE/api/jobs/$gh_id")"
    case "$gh_result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the github helper job ran to completion'          "$gh_result" 'succeeded'
expect_contains 'the helper reaches the credential route and is refused' "$gh_result" 'github exit 1'
expect_contains 'the refusal is the App-less board, said on stderr'  "$gh_result" 'no GitHub App installation'
expect_contains "the helper's cache is a Memory emptyDir"           "$gh_result" 'github cache tmpfs'
expect_contains 'the runner pod carries no GitHub token in its env'  "$gh_result" 'github no env token'

# --- The orphan reaper (issue #301), against the real apiserver ---------------------------------
#
# A service fleet the way a crashed attempt would have left it: a pod and its headless Service,
# labelled with the job id of the job that just succeeded — the board answers `succeeded`, the
# reaper's table says gone. The driver was installed with a 3s cadence, so one round must do it.
# The release label rides both objects, because that is the selector the arm scans by; the pod's
# image is the stub already loaded onto the node, and whether the container ever runs is beside
# the point — the OBJECT is what the reaper deletes.

echo
echo '# orphan reaper'

orphan_lease='33333333-3333-4333-8333-333333333333'
cat <<EOF | kubectl apply -n "$NAMESPACE" -f - >/dev/null 2>&1
apiVersion: v1
kind: Pod
metadata:
    name: factory-orphan-reaper-probe
    labels:
        factory.job: $id
        factory.lease: $orphan_lease
        factory.service: probe
        app.kubernetes.io/instance: $RELEASE
spec:
    restartPolicy: Never
    automountServiceAccountToken: false
    containers: [{name: probe, image: $STUB_IMAGE}]
---
apiVersion: v1
kind: Service
metadata:
    name: factory-orphan-reaper-svc
    labels:
        factory.job: $id
        factory.lease: $orphan_lease
        factory.service: factory-orphan-reaper-svc
        app.kubernetes.io/instance: $RELEASE
spec:
    clusterIP: None
    selector: {factory.fleet: factory-orphan-reaper-svc}
EOF
kubectl get pod/factory-orphan-reaper-probe service/factory-orphan-reaper-svc -n "$NAMESPACE" >/dev/null 2>&1 &&
    ok 'the synthetic orphan fleet is up' ||
    bad 'the synthetic orphan fleet is up' 'the seed objects were not created'

kubectl wait --for=delete pod/factory-orphan-reaper-probe -n "$NAMESPACE" --timeout=60s >/dev/null 2>&1 &&
    ok 'the reaper removes the orphan pod' ||
    bad 'the reaper removes the orphan pod' 'the pod survived the reaper'
kubectl wait --for=delete service/factory-orphan-reaper-svc -n "$NAMESPACE" --timeout=60s >/dev/null 2>&1 &&
    ok 'the reaper removes the orphan Service' ||
    bad 'the reaper removes the orphan Service' 'the Service survived the reaper'

if selected_phase admission; then
begin_phase admission
# The admission policy, against the real apiserver. The job above proves it admits what the driver
# specs; these prove it refuses what the Role alone would allow. Server-side dry runs as the
# driver's own ServiceAccount: admission runs in full, nothing is persisted.
DRIVER_SA="system:serviceaccount:$NAMESPACE:$RELEASE-factory-driver"

# The executor hardening (#382), in the two spellings these probes need. HARD_C goes INSIDE a
# container's flow mapping; the pod half is in probe_pod's own body. Every probe below carries
# both, because the policy now REQUIRES them — a probe shaped like the driver's own pod is a probe
# that is hardened, and the ones that deliberately are not are the four at the end.
HARD_C='securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}'
# The pod half, as a VARIABLE rather than a quoted default inside the heredoc: `${4:-'{…}'}`
# expands the quotes literally, and the apiserver then reads a YAML string where it wants a
# securityContext — a BadRequest that never reaches admission, so every probe fails with the same
# unrelated message and none of them tests anything.
HARD_POD='{seccompProfile: {type: RuntimeDefault}}'

probe_pod() { # probe_pod <name> <extra spec lines> [<extra labels>] [<pod securityContext>]
    cat <<EOF
apiVersion: v1
kind: Pod
metadata:
    name: admission-probe-$1
    labels: {factory.job: admission-probe${3:+, $3}}
spec:
    automountServiceAccountToken: false
    restartPolicy: Never
    securityContext: ${4:-$HARD_POD}
$2
EOF
}
as_driver() { kubectl create --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server -f - 2>&1; }

allowed="$(probe_pod ok "    containers: [{name: c, image: alpine, $HARD_C, envFrom: [{secretRef: {name: factory-job-probe-env}}]}]" | as_driver)"
expect_contains 'the policy admits a pod reading a per-attempt Secret' "$allowed" 'created (server dry run)'
stolen="$(probe_pod steal "    containers: [{name: c, image: alpine, $HARD_C, envFrom: [{secretRef: {name: $RELEASE-factory-dashboard}}]}]" | as_driver)"
expect_contains 'the policy refuses a pod reading the dashboard Secret' "$stolen" 'may read only its own per-attempt Secrets'
mounted="$(probe_pod mount "    containers: [{name: c, image: alpine, $HARD_C}]
    volumes: [{name: s, secret: {secretName: $RELEASE-factory-dashboard}}]" | as_driver)"
expect_contains 'the policy refuses a pod mounting the dashboard Secret' "$mounted" 'may mount only the workspaces claim'
host="$(probe_pod host "    containers: [{name: c, image: alpine, $HARD_C}]
    volumes: [{name: h, hostPath: {path: /}}]" | as_driver)"
expect_contains 'the policy refuses a hostPath pod' "$host" 'may mount only the workspaces claim'
member="$(probe_pod member "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: w, mountPath: /w, subPath: probe/44444444-4444-4444-8444-444444444444}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $STATE_RELEASE-workspaces}}]" | as_driver)"
expect_contains 'the policy admits a pod mounting a member workspace subPath' "$member" 'created (server dry run)'
root="$(probe_pod root "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: w, mountPath: /w}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $STATE_RELEASE-workspaces}}]" | as_driver)"
expect_contains 'the policy refuses a pod mounting the workspaces claim root' "$root" 'only at a member subPath'
expr="$(probe_pod expr "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: w, mountPath: /w, subPathExpr: '\$(HOME)'}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $STATE_RELEASE-workspaces}}]" | as_driver)"
expect_contains 'the policy refuses a subPathExpr workspace mount' "$expr" 'only at a member subPath'
deleted="$(kubectl delete secret "$RELEASE-factory-dashboard" --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server 2>&1)"
expect_contains 'the policy refuses deleting an unlabelled Secret' "$deleted" 'only objects labelled factory.job'

# Issue #382, the half that cannot be asserted by rendering. Phase one proved the CEL is in the
# document; this proves a real apiserver COMPILES it and refuses on it. The distinction matters
# more here than anywhere else in this script: `failurePolicy: Fail` means an expression that does
# not compile refuses every pod the driver creates, so a policy that renders and does not work is
# a total outage — and one that compiles but matches nothing passes phase one unchanged. Each
# probe below removes exactly one field from the shape the probes above all carry.
no_seccomp="$(probe_pod noseccomp "    containers: [{name: c, image: alpine, $HARD_C}]" '' '{}' | as_driver)"
expect_contains 'the policy refuses a pod with no seccomp profile' "$no_seccomp" 'RuntimeDefault seccomp profile'
wrong_seccomp="$(probe_pod unconfined "    containers: [{name: c, image: alpine, $HARD_C}]" '' \
    '{seccompProfile: {type: Unconfined}}' | as_driver)"
expect_contains 'the policy refuses an Unconfined seccomp profile' "$wrong_seccomp" 'RuntimeDefault seccomp profile'
no_sc="$(probe_pod nosc '    containers: [{name: c, image: alpine}]' | as_driver)"
expect_contains 'the policy refuses a container with no securityContext at all' "$no_sc" 'allowPrivilegeEscalation: false'
escalating="$(probe_pod escalate \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: true, capabilities: {drop: [ALL]}}}]' |
    as_driver)"
expect_contains 'the policy refuses a container that may escalate' "$escalating" 'allowPrivilegeEscalation: false'
# The container-level override, against the real apiserver: the pod keeps RuntimeDefault and the
# CONTAINER asks for Unconfined. Admitted, this is a runner with no syscall filter at all while
# every pod-level assertion still reads green — which is why it is probed rather than reasoned about.
container_unconfined="$(probe_pod cseccomp \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}, seccompProfile: {type: Unconfined}}}]' |
    as_driver)"
expect_contains 'the policy refuses a container that overrides the pod seccomp profile' \
    "$container_unconfined" 'may not override the pod seccomp profile'

no_drop="$(probe_pod nodrop \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: []}}}]' |
    as_driver)"
expect_contains 'the policy refuses a container that drops nothing' "$no_drop" 'must drop ALL capabilities'
# The declared opt-out, and the fact that it is the LABEL that carries it — not the absence of the
# field. The same pod without the label is the probe directly above, and it is refused.
opted_out="$(probe_pod optout \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false}}]' \
    'factory.unhardened: "true"' | as_driver)"
expect_contains 'the policy admits a labelled declared unhardened service' "$opted_out" 'created (server dry run)'
# The opt-out reaches the capability drop and NOTHING else: the label does not buy the escalation
# bit back, and it does not buy an unconfined seccomp profile.
opted_escalating="$(probe_pod optesc \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: true}}]' \
    'factory.unhardened: "true"' | as_driver)"
expect_contains 'the opt-out still may not escalate privileges' "$opted_escalating" 'allowPrivilegeEscalation: false'
opted_unconfined="$(probe_pod optsec \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false}}]' \
    'factory.unhardened: "true"' '{seccompProfile: {type: Unconfined}}' | as_driver)"
expect_contains 'the opt-out still runs under the default seccomp profile' "$opted_unconfined" \
    'RuntimeDefault seccomp profile'

# --- The workspace boundary, probed from inside a pod (issue #382) ------------------------------
fi

if selected_phase workspace; then
begin_phase workspace
#
# The admission probes above prove the driver cannot SPEC a pod that mounts another member's
# subtree. This proves the kernel will not let a pod that mounted its own subtree REACH one — the
# other half, and the half a policy cannot give you. `subPath` is a bind mount of one directory
# into the container's mount namespace: the rest of the volume is not merely unreadable, it is
# absent, so traversal and symlinks have nothing to resolve against. That is a property worth
# proving rather than asserting, because the failure mode if it were wrong is silent.
#
# No CNI involvement, no NetworkPolicy: this lane runs on the plain kind cluster.
echo
echo '# the workspace boundary'

uuid4() { # a legal member-id uuid, fresh per run — two runs never share a subtree
    printf '%s-%s-4%s-8%s-%s\n' "$(openssl rand -hex 4)" "$(openssl rand -hex 2)" \
        "$(openssl rand -hex 2 | cut -c2-)" "$(openssl rand -hex 2 | cut -c2-)" "$(openssl rand -hex 6)"
}
MEMBER_A="probea/$(uuid4)"
MEMBER_B="probeb/$(uuid4)"

# The seeder mounts the claim ROOT, which the driver's own identity may not do — it runs as this
# script's kubeconfig identity, which the policy's matchConditions do not select. That asymmetry
# is the point: only the dashboard writes checkouts across members, and it is not the driver.
kubectl run fs-seed -n "$NAMESPACE" --image=alpine:3 --restart=Never --command \
    --overrides="$(
        cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"volumes":[{"name":"w","persistentVolumeClaim":{"claimName":"$STATE_RELEASE-workspaces"}}],
"containers":[{"name":"fs-seed","image":"alpine:3",
"command":["sh","-c","mkdir -p /all/$MEMBER_A /all/$MEMBER_B && echo mine > /all/$MEMBER_A/secret.txt && echo theirs > /all/$MEMBER_B/secret.txt && echo seeded"],
"volumeMounts":[{"name":"w","mountPath":"/all"}]}]}}
EOF
    )" -- sh >/dev/null 2>&1
kubectl wait --for=condition=Ready=false --timeout=120s pod/fs-seed -n "$NAMESPACE" >/dev/null 2>&1 || true
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s pod/fs-seed -n "$NAMESPACE" >/dev/null 2>&1
seeded="$(kubectl logs fs-seed -n "$NAMESPACE" 2>&1 || true)"
expect_contains 'two member subtrees are seeded through a claim-root mount' "$seeded" 'seeded'

# The probe mounts ONLY member A's subtree, exactly as the driver specs it: subPath, no
# subPathExpr, target is the subtree's own volume path. Every check prints one `name=verdict`
# line, so a check that never ran is a missing line rather than a silent pass.
#
# One line, single quotes only, no backslashes: the script is interpolated into a JSON override,
# and a `\n` or a `"` here would have to be JSON-escaped by something. Keeping the script free of
# both is cheaper than carrying an encoder, and it is why `ls` output is read space-separated
# (command substitution already collapses it) instead of through `tr`.
probe_script="cd /workspaces/$MEMBER_A;
echo own=\$(cat secret.txt 2>/dev/null || echo UNREADABLE);
echo siblings=\$(ls /workspaces 2>/dev/null);
echo relative=\$(cat ../../$MEMBER_B/secret.txt 2>/dev/null && echo LEAKED || echo denied);
echo absolute=\$(cat /workspaces/$MEMBER_B/secret.txt 2>/dev/null && echo LEAKED || echo denied);
ln -sf / escape 2>/dev/null;
echo symlink=\$(cat escape/workspaces/$MEMBER_B/secret.txt 2>/dev/null && echo LEAKED || echo denied);
ln -sf ../.. up 2>/dev/null;
echo symlink_up=\$(ls up/$MEMBER_B 2>/dev/null && echo LEAKED || echo denied);
echo above=\$(ls ../.. 2>/dev/null);
rm -f escape up"
probe_script="$(printf '%s' "$probe_script" | tr '\n' ' ')"
kubectl run fs-probe -n "$NAMESPACE" --image=alpine:3 --restart=Never --command \
    --overrides="$(
        cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"securityContext":{"seccompProfile":{"type":"RuntimeDefault"}},
"volumes":[{"name":"w","persistentVolumeClaim":{"claimName":"$STATE_RELEASE-workspaces"}}],
"containers":[{"name":"fs-probe","image":"alpine:3",
"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},
"command":["sh","-c","$probe_script"],
"volumeMounts":[{"name":"w","mountPath":"/workspaces/$MEMBER_A","subPath":"$MEMBER_A"}]}]}}
EOF
    )" -- sh >/dev/null 2>&1
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s pod/fs-probe -n "$NAMESPACE" >/dev/null 2>&1
probe_out="$(kubectl logs fs-probe -n "$NAMESPACE" 2>&1 || true)"

# The positive control FIRST. Without it every "denied" below could be a pod that failed to start,
# a wrong path or an empty log — the vacuous pass an isolation test must never be able to report.
expect_contains 'the probe reads its OWN file through the subPath mount' "$probe_out" 'own=mine'
expect_contains 'only the probe own org is visible under the mount root' "$probe_out" 'siblings=probea'
expect_not_contains 'the other member org does not appear beside it' "$probe_out" 'probeb'
expect_contains 'a relative traversal to another member is denied' "$probe_out" 'relative=denied'
expect_contains 'an absolute path to another member is denied' "$probe_out" 'absolute=denied'
expect_contains 'a symlink to / cannot reach another member' "$probe_out" 'symlink=denied'
expect_contains 'a symlink up out of the subtree cannot reach another member' "$probe_out" 'symlink_up=denied'
expect_not_contains 'nothing in the probe leaked' "$probe_out" 'LEAKED'
expect_not_contains 'the volume root is not reachable above the mount' "$probe_out" 'theirs'

kubectl delete pod fs-seed fs-probe -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1

# --- Node disruption (issue #796) ---------------------------------------------------------------
fi

if selected_phase recovery; then
#
# Infrastructure loss interrupts a task, it never loses one — on a real apiserver. The release was
# installed with a 120s lease and a 70s drain grace, so the chart's handover (grace minus 60s) is
# 10s. a: the driver pod deleted hard while its runner runs to the end — the replacement driver
# adopts the finished runner Job, and its reaper spares that Job while the job is live. b: the
# driver drained (scaled to 0) — the handover queues the job with an interruption and leaves the
# runner running; the driver scaled back adopts it. c: the runner pod deleted mid-run (an eviction
# stand-in) — an interruption, then the next attempt, in its session. d: the driver pod and its
# runner Job deleted together — a replacement runner redoes the attempt in the lost session, on the
# restored tree. Each job refunds its interrupted attempt and records exactly one interruption; an
# expired lease is that interruption (issue #822). Only this release's objects are touched, by label.

echo
echo '# node disruption'

DRIVER_DEPLOY="deployment/$RELEASE-factory-driver"
DRIVER_SEL="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=driver"
ADOPTED='adopted the finished runner of claim 1, whose driver was lost'
DRAINED='the driver was drained'
POD_LOST='infrastructure loss: the runner pod was deleted'
# The interruption the next claim records for an attempt whose lease expired (issue #822).
EXPIRED='the lease expired: its driver went silent'

queue_job() { # queue_job <command> -> the new job's id, empty when the board refused it
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: JSON.stringify({ command: process.argv[2], executor: "claude", repo: process.argv[3] }) })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status === 201 ? String(b.id ?? "") : ""); })
    .catch(() => {});
' "$BASE/api/jobs" "$1" "$SMOKE_REPO"
}

job_brief() { # job_brief <id> -> "status|attempts|interruptions|first claimSeq|first reason"
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); const l = j.interruptions ?? []; process.stdout.write([j.status, j.attempts, l.length, l[0]?.claimSeq ?? "", l[0]?.reason ?? ""].join("|")); })
    .catch(() => process.stdout.write("unread"));
' "$BASE/api/jobs/$1"
}

job_output() { # job_output <id>
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers }).then(async (r) => process.stdout.write(String((await r.json()).output ?? ""))).catch(() => {});
' "$BASE/api/jobs/$1"
}

job_session() { # job_session <id>
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers }).then(async (r) => process.stdout.write(String((await r.json()).sessionId ?? ""))).catch(() => {});
' "$BASE/api/jobs/$1"
}

last_attempt() { # last_attempt <id> -> the job allowed one attempt, so an expiry spending it would retire it dead
    kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        psql -q -v ON_ERROR_STOP=1 -v "id=$1" postgres://factory:factory@127.0.0.1:5432/factory_dev -f - \
        >/dev/null 2>&1 <<'SQL'
update job set max_attempts = 1 where id = :'id';
SQL
}

expire_claim_one() { # expire_claim_one <id> -> "1" once claim 1's live lease is expired, as waiting it out would
    kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        psql -qtA -v ON_ERROR_STOP=1 -v "job=$1" \
        postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
with expired as (
    update job set lease_expires_at = now() - interval '1 second'
    where id = :'job' and status = 'running' and claim_seq = 1 and lease_expires_at > now()
    returning id
)
select count(*) from expired;
SQL
}

advance_origin() { # advance_origin -> success once the origin's main has a new `lane-upstream` commit
    local script="set -e; git clone -q /workspaces/$member_path/.smoke-origin.git /tmp/up; git -C /tmp/up -c user.name=test-k8s -c user.email=test-k8s@localhost commit -q --allow-empty -m lane-upstream; git -C /tmp/up push -q origin HEAD:main; echo advanced"
    kubectl run "$RELEASE-origin-advance" -n "$NAMESPACE" --image="$STUB_IMAGE" --restart=Never --command \
        --overrides="$(
            cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"volumes":[{"name":"w","persistentVolumeClaim":{"claimName":"$STATE_RELEASE-workspaces"}}],
"containers":[{"name":"advance","image":"$STUB_IMAGE","imagePullPolicy":"IfNotPresent",
"command":["sh","-c","$script"],
"volumeMounts":[{"name":"w","mountPath":"/workspaces"}]}]}}
EOF
        )" -- sh >/dev/null 2>&1
    kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s "pod/$RELEASE-origin-advance" \
        -n "$NAMESPACE" >/dev/null 2>&1
    local out
    out="$(kubectl logs "$RELEASE-origin-advance" -n "$NAMESPACE" 2>&1 || true)"
    kubectl delete pod "$RELEASE-origin-advance" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
    case "$out" in *advanced*) return 0 ;; esac
    return 1
}

await_brief() { # await_brief <id> <case pattern> <seconds> -> the last brief; returns 0 once it matched
    local i=0 b=""
    while [ "$i" -lt "$3" ]; do
        b="$(job_brief "$1")"
        # shellcheck disable=SC2254 # the pattern is the point
        case "$b" in $2) printf '%s' "$b"; return 0 ;; esac
        sleep 1
        i=$((i + 1))
    done
    printf '%s' "$b"
    return 1
}

await_job_complete() { # await_job_complete <runner Job name> <seconds>
    kubectl wait --for=condition=complete "job/$1" -n "$NAMESPACE" --timeout="$2s" >/dev/null 2>&1
}

driver_logs() { kubectl logs -l "$DRIVER_SEL" -n "$NAMESPACE" --tail=-1 2>/dev/null; }
hard_release="/workspaces/$member_path/.lane-hard"
drain_release="/workspaces/$member_path/.lane-drain"
evict_release="/workspaces/$member_path/.lane-evict"
lost_release="/workspaces/$member_path/.lane-lost"

# a. The hard kill: a lease expiry. A forced delete is no SIGKILL — the kubelet still
#    sends SIGTERM and kills ~2s later — so this is no drain only while the 10s handover outlasts
#    that. The 120s lease keeps the job live, under the dead driver's claim, through the reaper check.
#    At max_attempts 1: the claim records the expiry as claim 1's interruption and adopts.
begin_phase recovery-hard-kill
hard="$(queue_job "factory-stub-wait-$hard_release hard kill")"
[ -n "$hard" ] && last_attempt "$hard"
hard_pod="$(await_runner_pod "$hard")"
if [ -z "$hard" ] || [ -z "$hard_pod" ]; then
    bad 'the hard-kill runner is running' "job '$hard': $(job_brief "$hard")"
else
    ok 'the hard-kill runner is running'
    await_blocked "$hard_pod" "$hard_release" && ok 'the hard-kill agent is blocked at its barrier' || give_up
    hard_job="$(first_runner_job "$hard")"
    kubectl delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --grace-period=0 --force >/dev/null 2>&1
    kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
    release_stub "$hard_release"
    await_job_complete "$hard_job" 60 && ok 'the runner of a deleted driver runs to its end' ||
        bad 'the runner of a deleted driver runs to its end' "$(kubectl get job "$hard_job" -n "$NAMESPACE" 2>&1)"
    # Two and more 3s reaper rounds of the replacement driver while the job is still live under the
    # dead driver's lease: the finished runner Job is unread, and stays.
    sleep 8
    hard_live="$(job_brief "$hard")"
    case "$hard_live" in
    running*) ok 'the job is still live after the runner finished' ;;
    *) bad 'the job is still live after the runner finished' "$hard_live (the window closed before the reaper check)" ;;
    esac
    kubectl get job "$hard_job" -n "$NAMESPACE" >/dev/null 2>&1 && ok 'the reaper spares the unread finished runner Job' ||
        bad 'the reaper spares the unread finished runner Job' 'the runner Job is gone before its adoption'
    expect_not_contains 'the reaper logs nothing for the live job' "$(driver_logs)" "reaper: job $hard"
    # The live-lease window above is the proof. Expire only this dead driver's claim after it,
    # instead of spending the remaining lease budget idle; reclaim still uses the real board SQL.
    expired="$(expire_claim_one "$hard")"
    [ "$expired" = 1 ] && ok 'the dead driver lease is expired after the reaper observation' || {
        bad 'the dead driver lease is expired after the reaper observation' "$expired"
        give_up
    }
    hard_end="$(await_brief "$hard" 'succeeded*' 240)"
    [ "$hard_end" = "succeeded|1|1|1|$EXPIRED" ] && ok 'the replacement driver adopts the run: one attempt, one interruption' ||
        bad 'the replacement driver adopts the run: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $hard_end"
    expect_contains 'the adopted output is the first runner pod output' "$(job_output "$hard")" "released in $hard_pod"
    expect_contains 'the replacement driver logs the adoption' "$(driver_logs)" "job $hard: $ADOPTED"
fi

# b. The drain: SIGTERM, and the handover 10s in. Scaled to 0, so no driver claims the queued job
#    while its runner still runs (a claim of a still-running runner sweeps it: the stated limit).
begin_phase recovery-drain
drained="$(queue_job "factory-stub-wait-$drain_release handover")"
drained_pod="$(await_runner_pod "$drained")"
if [ -z "$drained" ] || [ -z "$drained_pod" ]; then
    bad 'the handover runner is running' "job '$drained': $(job_brief "$drained")"
else
    ok 'the handover runner is running'
    await_blocked "$drained_pod" "$drain_release" && ok 'the handover agent is blocked at its barrier' || give_up
    drained_job="$(first_runner_job "$drained")"
    kubectl scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=0 >/dev/null 2>&1
    drained_mid="$(await_brief "$drained" "queued|0|1|1|$DRAINED" 30)" &&
        ok 'a drained driver hands its run back as an interruption' ||
        bad 'a drained driver hands its run back as an interruption' "status|attempts|count|claimSeq|reason: $drained_mid"
    kubectl wait --for=delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --timeout=90s >/dev/null 2>&1
    [ "$(kubectl get pod "$drained_pod" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null)" = 'Running' ] &&
        ok 'the handed-over runner pod is left running' ||
        bad 'the handed-over runner pod is left running' "$(kubectl get pod "$drained_pod" -n "$NAMESPACE" 2>&1)"
    release_stub "$drain_release"
    await_job_complete "$drained_job" 90 && ok 'the handed-over runner Job completes on its own' ||
        bad 'the handed-over runner Job completes on its own' "$(kubectl get job "$drained_job" -n "$NAMESPACE" 2>&1)"
fi
# Scaled back whatever happened above: the case after this one needs a driver.
kubectl scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=1 >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
if [ -n "$drained_pod" ]; then
    drained_end="$(await_brief "$drained" 'succeeded*' 120)"
    [ "$drained_end" = "succeeded|1|1|1|$DRAINED" ] && ok 'the returning driver adopts the handed-over run' ||
        bad 'the returning driver adopts the handed-over run' "status|attempts|count|claimSeq|reason: $drained_end"
    expect_contains 'the handed-over output is the first runner pod output' "$(job_output "$drained")" "released in $drained_pod"
    expect_contains 'the returning driver logs the adoption' "$(driver_logs)" "job $drained: $ADOPTED"
fi

# c. The runner pod deleted mid-run, its driver alive: an interruption the driver reports at once,
#    not a failed run and not a lease left to expire; the next attempt runs the job again.
begin_phase recovery-eviction
evicted="$(queue_job "factory-stub-wait-$evict_release pod deleted")"
evicted_pod="$(await_runner_pod "$evicted")"
if [ -z "$evicted" ] || [ -z "$evicted_pod" ]; then
    bad 'the runner pod to delete is running' "job '$evicted': $(job_brief "$evicted")"
else
    ok 'the runner pod to delete is running'
    await_blocked "$evicted_pod" "$evict_release" && ok 'the evicted agent is blocked at its barrier' || give_up
    deleted_at="$(date +%s)"
    kubectl delete pod "$evicted_pod" -n "$NAMESPACE" --grace-period=5 --wait=false >/dev/null 2>&1
    evicted_mid="$(await_brief "$evicted" "*|1|1|$POD_LOST*" 45)"
    took=$(($(date +%s) - deleted_at))
    case "$evicted_mid" in
    *"|1|1|$POD_LOST"*) [ "$took" -lt 30 ] && ok "a deleted runner pod is an interruption (${took}s, inside the 120s lease)" ||
        bad 'a deleted runner pod is an interruption inside the lease' "took ${took}s: $evicted_mid" ;;
    *) bad 'a deleted runner pod is an interruption inside the lease' "status|attempts|count|claimSeq|reason: $evicted_mid" ;;
    esac
    release_stub "$evict_release"
    evicted_end="$(await_brief "$evicted" 'succeeded*' 120)"
    case "$evicted_end" in
    "succeeded|1|1|1|$POD_LOST"*) ok 'the next attempt succeeds: one attempt, one interruption' ;;
    *) bad 'the next attempt succeeds: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $evicted_end" ;;
    esac
    expect_contains 'the job output is the second runner pod' "$(job_output "$evicted")" 'released in '
    expect_not_contains 'the deleted pod produced no verdict' "$(job_output "$evicted")" "released in $evicted_pod"
    expect_contains 'the next attempt resumes the session' "$(job_output "$evicted")" "--resume $(job_session "$evicted")"
fi

# d. The driver and its runner lost together (issue #822): nothing survives to adopt, so the next
#    claim redoes the attempt in a replacement runner — in the lost attempt's session, on its tree.
#    The first runner marks the worktree's git-ignored .factory/ and blocks at its barrier; the
#    replacement finds the mark and ends. Restored, not synced: the origin moves after the first
#    runner synced, and a sync would have moved the tree onto that commit. At max_attempts 1, where
#    an expiry spending an attempt would retire the job dead.
begin_phase recovery-lost-together
lost="$(queue_job "factory-stub-mark factory-stub-wait-$lost_release lost together")"
[ -n "$lost" ] && last_attempt "$lost"
lost_pod="$(await_runner_pod "$lost")"
if [ -z "$lost" ] || [ -z "$lost_pod" ]; then
    bad 'the lost-together runner is running' "job '$lost': $(job_brief "$lost")"
else
    ok 'the lost-together runner is running'
    await_blocked "$lost_pod" "$lost_release" && ok 'the lost-together agent is blocked at its barrier' || give_up
    lost_session="$(job_session "$lost")"
    lost_job="$(first_runner_job "$lost")"
    # Before the disruption, while the live driver still heartbeats the lease: the first runner's tree
    # is already synced, and only a replacement that re-synced would move onto this commit.
    advance_origin && ok 'the origin moves after the first runner synced its tree' ||
        bad 'the origin moves after the first runner synced its tree' 'the advance pod did not push'
    kubectl delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --grace-period=0 --force >/dev/null 2>&1
    kubectl delete job "$lost_job" -n "$NAMESPACE" --grace-period=0 --force --wait=false >/dev/null 2>&1
    kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
    expired="$(expire_claim_one "$lost")"
    [ "$expired" = 1 ] && ok "the lost driver's lease is expired" || bad "the lost driver's lease is expired" "$expired"
    lost_end="$(await_brief "$lost" 'succeeded*' 240)"
    [ "$lost_end" = "succeeded|1|1|1|$EXPIRED" ] && ok 'a replacement runner redoes the lost attempt: one attempt, one interruption' ||
        bad 'a replacement runner redoes the lost attempt: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $lost_end"
    lost_out="$(job_output "$lost")"
    expect_contains 'the replacement resumes the lost session' "$lost_out" "--resume $lost_session"
    expect_contains 'the replacement runs on the tree the lost runner left' "$lost_out" "mark kept from $lost_pod head: "
    expect_not_contains 'the replacement ran on the restored tree, not a synced one' "$lost_out" 'head: lane-upstream'
    expect_contains 'the replacement driver logs the resumed session' "$(driver_logs)" \
        "job $lost: attempt 1 resuming session $lost_session"
    expect_not_contains 'nothing was adopted' "$(driver_logs)" "job $lost: $ADOPTED"
fi

for job in $hard $drained $evicted $lost; do
    kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false >/dev/null 2>&1
done
fi

kill "$pf_pid" 2>/dev/null
wait "$pf_pid" 2>/dev/null
pf_pid=''

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
