#!/usr/bin/env bash
# The Kubernetes stack, end to end on a local kind cluster.
#
#   scripts/test-k8s.sh              # lint + template only (needs helm)
#   scripts/test-k8s.sh --cluster    # then the real thing (needs a kind cluster running)
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

RELEASE="factory-k8s-test-$(date +%s)"
# The app chart deploys no database; locally the state chart stands in for the managed one. Its
# object names are its release name plus a fixed suffix, so the app release is pointed at them the
# same way values-local.yaml points `dev` at `factory-state`.
STATE_RELEASE="$RELEASE-state"
STATE_SETS=(
    --set "database.url=postgres://factory:factory@$STATE_RELEASE-timescale:5432/factory_dev"
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
    if [ "${installed:-}" = '1' ]; then
        helm uninstall "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        # The runner Jobs were created at runtime by the driver, not by the release, so the
        # uninstall leaves them — and their pods — behind. On this test cluster, every Job carrying
        # the factory.job label is one of ours. They go BEFORE the claims: a runner pod that still
        # mounts the workspaces claim holds it under pvc-protection, and a waiting claim delete
        # issued first blocks forever on a pod whose delete it never reaches.
        kubectl delete jobs -l factory.job -n "$NAMESPACE" >/dev/null 2>&1
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
}
trap cleanup EXIT

command -v helm >/dev/null || {
    echo 'test-k8s: helm is required'
    exit 1
}

# --- Phase one: offline ----------------------------------------------------------------------

echo '# chart'

# Linted with the local profile: the app chart's defaults carry no database.url, which is required,
# and no auth values, which are too.
helm lint charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" >/dev/null 2>&1 && ok 'helm lint passes' ||
    bad 'helm lint passes' "$(helm lint charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" 2>&1 | tail -3)"
helm lint charts/factory-local-state >/dev/null 2>&1 && ok 'helm lint passes on the local state chart' ||
    bad 'helm lint passes on the local state chart' 'lint failed'

# Rendered with the local profile, which is the shape the cluster phase installs: the no-fetch
# entry behind github auth, the state release's database and claim, stub executor.
render() {
    helm template "$RELEASE" charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --namespace "$NAMESPACE" "$@"
}
render >"$work/rendered.yaml" || {
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
      verbs: ['create', 'get', 'delete', 'list']"
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
expect_not_contains 'no cpu limit renders by default'              "$runner_resources" 'RUNNER_CPU_LIMIT'
expect_not_contains 'no memory limit renders by default'           "$runner_resources" 'RUNNER_MEMORY_LIMIT'
limited="$(render --set runner.resources.limits.memory=4Gi)"
limited_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$limited")"
expect_contains 'a configured memory limit forwards'               "$limited_resources" 'name: RUNNER_MEMORY_LIMIT'
expect_contains 'the limit renders as the operator spelled it'     "$limited_resources" 'value: "4Gi"'
emptied="$(render --set runner.resources.requests.cpu= --set runner.resources.requests.memory=)"
emptied_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$emptied")"
expect_not_contains 'empty cpu requests forward nothing'           "$emptied_resources" 'RUNNER_CPU_REQUEST'
expect_not_contains 'empty memory requests forward nothing'        "$emptied_resources" 'RUNNER_MEMORY_REQUEST'

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
expect_not_contains 'the app chart deploys no database' "$(cat "$work/rendered.yaml")" 'component: timescale'
if helm template "$RELEASE" charts/factory >/dev/null 2>&1; then
    bad 'the app chart refuses to render without database.url' 'helm template succeeded with no database.url'
else
    ok 'the app chart refuses to render without database.url'
fi

# The state chart: one database writer on one claim, held by a StatefulSet so the claim belongs to
# the pod identity and no update can put a second writer on it.
state="$(helm template "$STATE_RELEASE" charts/factory-local-state --namespace "$NAMESPACE")"
expect_contains 'the state chart names the database service'  "$state" "name: $STATE_RELEASE-timescale"
expect_contains 'the state chart names the workspaces claim'  "$state" "name: $STATE_RELEASE-workspaces"
expect_contains 'the state database is a StatefulSet'         "$state" 'kind: StatefulSet'
expect_contains 'the database claim is the set’s own'         "$state" 'volumeClaimTemplates:'
expect_contains 'the set is addressed by the database service' "$state" "serviceName: $STATE_RELEASE-timescale"
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
    --set auth.publicUrl=https://f.example --set auth.oauthClientId=c --set github.appId=1 2>&1)"
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
    '^factory-(job|sync|publish|helper|gate)-[a-z0-9-]+-env$'
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
helm lint charts/factory "${EKS_SETS[@]}" >/dev/null 2>&1 && ok 'helm lint passes on the EKS shape' \
    || bad 'helm lint passes on the EKS shape' 'lint failed'

# --- Phase two: the cluster -------------------------------------------------------------------

if [ "${1:-}" != '--cluster' ]; then
    printf '\n%d passed, %d failed (cluster phase skipped — pass --cluster)\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

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

echo 'building core, server, driver'
npm run build -w core >/dev/null 2>&1 && npm run build -w server >/dev/null 2>&1 &&
    npm run build -w driver >/dev/null 2>&1 || {
    echo 'test-k8s: build failed'
    exit 1
}

echo 'building the images on the host daemon'
docker build -f docker/Dockerfile --target runtime -q -t "$DASH_IMAGE" . >/dev/null &&
    docker build -f docker/driver.Dockerfile -q -t "$DRIVER_IMAGE" . >/dev/null &&
    printf 'FROM alpine:3\nENTRYPOINT ["sh","-c","echo ${CLAUDE_CODE_CONFIG_CONTENT:-none}; echo \\"$@\\""]\n' >"$work/stub.Dockerfile" &&
    docker build -q -t "$STUB_IMAGE" -f "$work/stub.Dockerfile" "$work" >/dev/null &&
    docker pull -q "$COLLECTOR_IMAGE" >/dev/null 2>&1 || {
    echo 'test-k8s: image build or pull failed'
    exit 1
}

echo "loading the images into the kind cluster $kind_name"
# One load call per image, not one variadic invocation: every kind version accepts
# `kind load docker-image <image> --name <cluster>`, older ones not always a list.
for image in "$DASH_IMAGE" "$DRIVER_IMAGE" "$STUB_IMAGE" "$COLLECTOR_IMAGE"; do
    kind load docker-image "$image" --name "$kind_name" >/dev/null || {
        echo "test-k8s: could not load $image into the kind cluster $kind_name"
        exit 1
    }
done

echo "installing the releases $STATE_RELEASE and $RELEASE"
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
    -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install failed'
    exit 1
}
installed=1

# The timescale StatefulSet is waited for deliberately: the dashboard listens the moment its
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
    kubectl rollout status "statefulset/$STATE_RELEASE-timescale" \
        -n "$NAMESPACE" --timeout=600s >/dev/null 2>&1 &&
    ok 'the dashboard, driver, database and collector come up' || \
    bad 'the dashboard, driver, database and collector come up' \
        "$(kubectl get pods -n "$NAMESPACE" | tail -5)"

# Through the dashboard, so the assertion is the user's own path: queue, then poll the board.
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
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
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

JOB_BODY='{"command":"hello from the cluster","executor":"claude"}'
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
minted="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-timescale" -- \
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
org_seeded="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-timescale" -- \
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
insert into executor_profile (org_id, user_id, name, type, config)
select id, null, 'team', 'claude-code', '{"model":"org-team-model"}'::jsonb from organization where id = :'member';
SQL
)" && ok 'an org executor profile is seeded' || {
    bad 'an org executor profile is seeded' "$org_seeded"
    give_up
}
ORG_BODY='{"command":"hello from the org scope","executor":"team","executorScope":"org"}'

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
' "$BASE/api/jobs?limit=200" 'hello from the cluster')"
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
const [url, body] = process.argv.slice(2);
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

# The runner object the executor created — the thing only kubernetes could prove. Found by the
# factory.job label the spec stamps on it (the release labels belong to the chart's objects).
job_object="$(kubectl get jobs -l factory.job -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
[ "${job_object:-0}" -ge 1 ] && ok 'a runner Job object exists' || bad 'a runner Job object exists' "none found"

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

# The admission policy, against the real apiserver. The job above proves it admits what the driver
# specs; these prove it refuses what the Role alone would allow. Server-side dry runs as the
# driver's own ServiceAccount: admission runs in full, nothing is persisted.
DRIVER_SA="system:serviceaccount:$NAMESPACE:$RELEASE-factory-driver"
probe_pod() { # probe_pod <name> <extra spec lines> — a pod otherwise shaped like the driver's own
    cat <<EOF
apiVersion: v1
kind: Pod
metadata:
    name: admission-probe-$1
    labels: {factory.job: admission-probe}
spec:
    automountServiceAccountToken: false
    restartPolicy: Never
$2
EOF
}
as_driver() { kubectl create --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server -f - 2>&1; }

allowed="$(probe_pod ok '    containers: [{name: c, image: alpine, envFrom: [{secretRef: {name: factory-job-probe-env}}]}]' | as_driver)"
expect_contains 'the policy admits a pod reading a per-attempt Secret' "$allowed" 'created (server dry run)'
stolen="$(probe_pod steal "    containers: [{name: c, image: alpine, envFrom: [{secretRef: {name: $RELEASE-factory-dashboard}}]}]" | as_driver)"
expect_contains 'the policy refuses a pod reading the dashboard Secret' "$stolen" 'may read only its own per-attempt Secrets'
mounted="$(probe_pod mount "    containers: [{name: c, image: alpine}]
    volumes: [{name: s, secret: {secretName: $RELEASE-factory-dashboard}}]" | as_driver)"
expect_contains 'the policy refuses a pod mounting the dashboard Secret' "$mounted" 'may mount only the workspaces claim'
host="$(probe_pod host '    containers: [{name: c, image: alpine}]
    volumes: [{name: h, hostPath: {path: /}}]' | as_driver)"
expect_contains 'the policy refuses a hostPath pod' "$host" 'may mount only the workspaces claim'
member="$(probe_pod member "    containers: [{name: c, image: alpine, volumeMounts: [{name: w, mountPath: /w, subPath: probe/44444444-4444-4444-8444-444444444444}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $STATE_RELEASE-workspaces}}]" | as_driver)"
expect_contains 'the policy admits a pod mounting a member workspace subPath' "$member" 'created (server dry run)'
root="$(probe_pod root "    containers: [{name: c, image: alpine, volumeMounts: [{name: w, mountPath: /w}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $STATE_RELEASE-workspaces}}]" | as_driver)"
expect_contains 'the policy refuses a pod mounting the workspaces claim root' "$root" 'only at a member subPath'
expr="$(probe_pod expr "    containers: [{name: c, image: alpine, volumeMounts: [{name: w, mountPath: /w, subPathExpr: '\$(HOME)'}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $STATE_RELEASE-workspaces}}]" | as_driver)"
expect_contains 'the policy refuses a subPathExpr workspace mount' "$expr" 'only at a member subPath'
deleted="$(kubectl delete secret "$RELEASE-factory-dashboard" --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server 2>&1)"
expect_contains 'the policy refuses deleting an unlabelled Secret' "$deleted" 'only objects labelled factory.job'

kill "$pf_pid" 2>/dev/null

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
