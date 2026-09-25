#!/usr/bin/env bash
# The Kubernetes stack, end to end on a local kind cluster.
#
#   scripts/test-k8s.sh              # lint + template only (needs helm)
#   scripts/test-k8s.sh --cluster    # then the real thing (needs a kind cluster running)
#
# Phase one is offline: helm lint, and helm template assertions that the rendered manifests carry
# the security-relevant decisions — credentials by secretKeyRef and never by value, a
# namespace-scoped Role, a runner pod with no service account. Phase two installs the chart into
# the local cluster with the stub executor image, queues a job, and watches it come back succeeded
# — real pods, no Claude, no credential.
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

# Linted with the local profile: the app chart's defaults carry no database.url, which is required.
helm lint charts/factory -f charts/factory/values-local.yaml >/dev/null 2>&1 && ok 'helm lint passes' ||
    bad 'helm lint passes' 'lint failed'
helm lint charts/factory-local-state >/dev/null 2>&1 && ok 'helm lint passes on the local state chart' ||
    bad 'helm lint passes on the local state chart' 'lint failed'

# Rendered with the local profile, which is the shape the cluster phase installs: offline auth,
# the state release's database and claim, stub executor.
render() {
    helm template "$RELEASE" charts/factory -f charts/factory/values-local.yaml "${STATE_SETS[@]}" \
        --namespace "$NAMESPACE"
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

# The state chart: one database writer on one claim, so its Deployment recreates rather than rolls.
state="$(helm template "$STATE_RELEASE" charts/factory-local-state --namespace "$NAMESPACE")"
expect_contains 'the state chart names the database service'  "$state" "name: $STATE_RELEASE-timescale"
expect_contains 'the state chart names the workspaces claim'  "$state" "name: $STATE_RELEASE-workspaces"
expect_contains 'the state database never runs two writers'   "$state" 'type: Recreate'

# --- The review hardening: every item pinned so a revert fails here, not in production ---------

# A complete github-mode value set: the chart's own defaults, which is what production renders.
SECRET32="$(printf '%032d' 0)"
GH_SETS=(
    --set database.url=postgres://u:p@db:5432/factory
    --set auth.publicUrl=https://factory.example
    --set auth.oauthClientId=client
    --set secret.oauthClientSecret=secret
    --set "secret.sessionSecret=$SECRET32"
    --set "secret.jobBoardToken=$SECRET32"
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
# Every key but database-url is optional, so a managed Secret carries only what its mode needs.
[ "$(grep -c 'optional: true' <<<"$byo")" -ge 8 ] && ok 'managed-Secret keys are optional' ||
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
refuses 'github mode refuses a missing publicUrl' 'auth.publicUrl' "${GH_SETS[@]}" --set auth.publicUrl=
refuses 'github mode refuses a short session secret' 'secret.sessionSecret' "${GH_SETS[@]}" --set secret.sessionSecret=short
refuses 'github mode refuses a missing board token' 'secret.jobBoardToken' "${GH_SETS[@]}" --set secret.jobBoardToken=
refuses 'a missing App id is refused unless offline' 'github.appId' "${GH_SETS[@]}" --set github.appId=
refuses 'an open board needs the public-bind hatch' 'allowPublicBind' "${GH_SETS[@]}" --set auth.mode=none
refuses 'no Secret at all is refused' 'secret.existingSecret' "${GH_SETS[@]}" --set secret.create=false

# Names stay valid DNS labels however long the release name: truncation leaves room for suffixes.
long="$(helm template "release-name-that-is-deliberately-far-too-long-for-a-dns-label" charts/factory \
    "${GH_SETS[@]}" 2>&1)"
too_long="$(grep -E '^    name: ' <<<"$long" | awk '{ if (length($2) > 63) print $2 }' | grep -v 'admission' || true)"
[ -z "$too_long" ] && ok 'every object name fits a DNS label' || bad 'every object name fits a DNS label' "$too_long"

# Pull secrets reach the chart's pods and every pod the driver specs.
pulled="$(gh_render --set 'imagePullSecrets={regcred}')"
expect_contains 'chart pods name the pull secret'      "$pulled" 'name: "regcred"'
expect_contains 'the driver forwards the pull secret'  "$pulled" 'value: "regcred"'

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

# --- Phase two: the cluster -------------------------------------------------------------------

if [ "${1:-}" != '--cluster' ]; then
    printf '\n%d passed, %d failed (cluster phase skipped — pass --cluster)\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

for tool in kubectl docker; do
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
    printf 'FROM alpine:3\nENTRYPOINT ["echo"]\n' >"$work/stub.Dockerfile" &&
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
helm install "$RELEASE" charts/factory -f charts/factory/values-local.yaml "${STATE_SETS[@]}" \
    --set "dashboard.image.repository=$DASH_IMAGE" \
    --set "driver.image.repository=$DRIVER_IMAGE" \
    --set "driver.executorImages.claudeCode=$STUB_IMAGE" \
    --set "driver.executorImages.opencode=$STUB_IMAGE" \
    -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install failed'
    exit 1
}
installed=1

# The timescale deployment is waited for deliberately: the dashboard listens the moment its
# process is up — health answers, availability reports — but its migrations only start landing
# once the database accepts connections, and the server gives up retrying after ~45s. On a cold
# kind node the database image is still being pulled through containerd in that window, so
# queueing before it is available fails every POST no matter how long the queue step polls.
kubectl wait --for=condition=available \
    "deployment/$RELEASE-factory" "deployment/$RELEASE-factory-driver" \
    "deployment/$STATE_RELEASE-timescale" "deployment/$RELEASE-factory-collector" \
    -n "$NAMESPACE" --timeout=600s >/dev/null 2>&1 &&
    ok 'the dashboard, driver, database and collector come up' || \
    bad 'the dashboard, driver, database and collector come up' \
        "$(kubectl get pods -n "$NAMESPACE" | tail -5)"

# Through the dashboard, so the assertion is the user's own path: queue, then poll the board.
PF_LOG="$work/portforward.log"
kubectl port-forward "svc/$RELEASE-factory" 18080:8080 -n "$NAMESPACE" >"$PF_LOG" 2>&1 &
pf_pid=$!
BASE="http://127.0.0.1:18080"

up=""
for _ in $(seq 1 30); do
    [ "$(node -e 'fetch(process.argv[1]).then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write("000"))' "$BASE/api/health")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done
[ -n "$up" ] && ok 'the board answers through the service' || {
    bad 'the board answers through the service' "$(cat "$PF_LOG")"
    kill "$pf_pid" 2>/dev/null
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
}

# A task runs only under an executor from its author's own list — there is no global fallback, and
# a claim whose label matches nothing is failed by the driver — so the fresh database needs one
# before anything is queued. The PUT replaces the whole list, so repeating it is harmless: it
# retries through the same migration grace the queue loop below allows.
configured=""
for _ in $(seq 1 60); do
    [ "$(node -e '
fetch(process.argv[1], { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ executors: [{ name: "claude", type: "claude-code", config: {} }] }) })
    .then((r) => process.stdout.write(String(r.status)))
    .catch(() => process.stdout.write("000"));
' "$BASE/api/workspace/executors")" = '200' ] && {
        configured=1
        break
    }
    sleep 1
done
[ -n "$configured" ] && ok 'the board stores the task executor' ||
    bad 'the board stores the task executor' 'PUT /api/workspace/executors never answered 200'

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
        response="$(node -e '
fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "hello from the cluster", executor: "claude" }) })
    .then(async (r) => { const b = await r.text(); let id = ""; try { id = String(JSON.parse(b).id ?? ""); } catch {} process.stdout.write(r.status + "|" + id); })
    .catch(() => process.stdout.write("000|"));
' "$BASE/api/jobs")"
        status="${response%%|*}"
        id="${response#*|}"
        case "$status" in
        000 | 5*) reconcile=1 ;;
        *) break ;;
        esac
    else
        adopted="$(node -e '
fetch(process.argv[1])
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
*) bad 'a job was queued' "no id came back"
    kill "$pf_pid" 2>/dev/null
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
    ;;
esac

# The stub image echoes its arguments, so the output is the proof the prompt reached the pod — the
# same assertion scripts/test-jobs.sh makes against docker.
result=""
for _ in $(seq 1 120); do
    result="$(node -e '
fetch(process.argv[1])
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

# The runner object the executor created — the thing only kubernetes could prove. Found by the
# factory.job label the spec stamps on it (the release labels belong to the chart's objects).
job_object="$(kubectl get jobs -l factory.job -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
[ "${job_object:-0}" -ge 1 ] && ok 'a runner Job object exists' || bad 'a runner Job object exists' "none found"

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
