#!/usr/bin/env bash
# The Kubernetes stack, end to end on minikube.
#
#   scripts/test-k8s.sh              # lint + template only (needs helm)
#   scripts/test-k8s.sh --cluster    # then the real thing (needs minikube running)
#
# Phase one is offline: helm lint, and helm template assertions that the rendered manifests carry
# the security-relevant decisions — credentials by secretKeyRef and never by value, a
# namespace-scoped Role, a runner pod with no service account. Phase two installs the chart into
# minikube with the stub executor image, queues a job, and watches it come back succeeded — real
# pods, no Claude, no credential.
#
# Everything it creates it removes: one helm release, its claims, and the images it loaded.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

RELEASE="factory-k8s-test-$(date +%s)"
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
        kubectl delete pvc -l "app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        # The runner Jobs were created at runtime by the driver, not by the release, so the
        # uninstall leaves them — and their pods — behind. On this test cluster, every Job carrying
        # the factory.job label is one of ours.
        kubectl delete jobs -l factory.job -n "$NAMESPACE" >/dev/null 2>&1
        # Block until the claims are really gone, not just terminating: the next run of this script
        # builds its own release, and an RWO volume still attached to a dying pod would hold the
        # fresh dashboard pod in Pending for its whole timeout.
        kubectl wait --for=delete pvc -l "app.kubernetes.io/instance=$RELEASE" \
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

helm lint charts/factory >/dev/null 2>&1 && ok 'helm lint passes' || bad 'helm lint passes' 'lint failed'

# Rendered with the minikube profile, which is the shape the cluster phase installs: offline auth,
# ReadWriteOnce claim, stub executor.
render() { helm template "$RELEASE" charts/factory -f charts/factory/values-minikube.yaml --namespace "$NAMESPACE"; }
render >"$work/rendered.yaml" || {
    echo 'test-k8s: helm template failed'
    exit 1
}

expect_contains 'the driver selects the kubernetes executor'  "$(cat "$work/rendered.yaml")" 'value: kubernetes'
expect_contains 'the driver finds the board by service name'  "$(cat "$work/rendered.yaml")" "value: http://$RELEASE-factory:8080"
expect_contains 'the driver learns its namespace at runtime' "$(cat "$work/rendered.yaml")" 'fieldPath: metadata.namespace'

# Credentials by reference, checked STRUCTURALLY: the line after every credential env's name must
# be `valueFrom:` — the pod spec carries the reference and never the value, so anything readable in
# `kubectl get -o yaml` stays unreadable to whoever can list pods. (The runner-side half of the same
# rule — the executor reading its credentials from RUNNER_CREDENTIALS_SECRET — is pinned in
# driver/test/k8s.test.ts, where the runner spec lives.)
credentials_clean=1
for cred in GITHUB_APP_PRIVATE_KEY GITHUB_OAUTH_CLIENT_SECRET SESSION_SECRET INGEST_TOKEN; do
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
# list, which the exact-verbs assertion pins.
rbac="$(awk '/^# Source: factory\/templates\/driver-rbac.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains     'the driver role grants the runner calls' "$rbac" \
    "verbs: ['create', 'get', 'delete']"
expect_contains     'the driver role lists pods, only to find them' "$rbac" "verbs: ['list']"
expect_not_contains 'the driver role never watches'         "$rbac" 'watch'
expect_not_contains 'the driver role is never a ClusterRole' "$(cat "$work/rendered.yaml")" 'kind: ClusterRole'

# The dashboard writes checkouts into the same claim the runners mount.
expect_contains 'the dashboard mounts the workspaces claim' "$(cat "$work/rendered.yaml")" \
    "claimName: $RELEASE-factory-workspaces"
expect_contains 'the driver is told that claim name'        "$(cat "$work/rendered.yaml")" \
    "value: \"$RELEASE-factory-workspaces\""

# The service selects the DASHBOARD and only the dashboard. The shared instance labels alone also
# match the driver and timescale pods, and a port-forward landing on the driver fails on a missing
# named port — or worse, on a probe against the wrong container.
service_selector="$(awk '/^# Source: factory\/templates\/service.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains    'the service selects the dashboard component' "$service_selector" 'component: dashboard'
expect_not_contains 'the service never selects the driver'       "$service_selector" 'component: driver'

# Numbers arrive as integers, not whatever helm's float stringifier felt like — a `1.8e+06` here
# would be refused by the driver's own integer check at boot.
render | grep -q 'value: "1800000"' && ok 'the job timeout renders as an integer' ||
    bad 'the job timeout renders as an integer' "$(render | grep -A1 DRIVER_JOB_TIMEOUT_MS)"

# --- Phase two: minikube ---------------------------------------------------------------------

if [ "${1:-}" != '--cluster' ]; then
    printf '\n%d passed, %d failed (cluster phase skipped — pass --cluster)\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

for tool in kubectl minikube docker; do
    command -v "$tool" >/dev/null || {
        echo "test-k8s: $tool is required for the cluster phase"
        exit 1
    }
done

# The cluster phase installs a release and deletes runner Jobs in its namespace — and "runner Job"
# is identified only by the factory.job label, which any release in the namespace shares. This
# script is built for a disposable local cluster; anything else has to say so explicitly.
context="$(kubectl config current-context 2>/dev/null || true)"
if [ "$context" != 'minikube' ] && [ -z "${FACTORY_K8S_ALLOW_ANY_CLUSTER:-}" ]; then
    echo "test-k8s: refusing to run the cluster phase against '$context'."
    echo '  It deletes every runner Job in the namespace. Aim it at minikube, or set'
    echo '  FACTORY_K8S_ALLOW_ANY_CLUSTER=1 if the cluster really is disposable.'
    exit 1
fi

echo
echo '# cluster'

kubectl cluster-info >/dev/null 2>&1 || {
    echo 'test-k8s: no reachable cluster (is minikube running?)'
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
    docker build -q -t "$STUB_IMAGE" -f "$work/stub.Dockerfile" "$work" >/dev/null || {
    echo 'test-k8s: image build failed'
    exit 1
}

echo 'loading the images into minikube'
# docker save through `minikube ssh`, rather than `minikube image load` or `minikube docker-env`:
# the first did not exist before minikube v1.24, and the second makes the host's docker CLI talk to
# the node's daemon, which dies on any version skew between the two. Streaming a tarball through
# ssh works on every version of both.
docker save "$DASH_IMAGE" "$DRIVER_IMAGE" "$STUB_IMAGE" |
    minikube ssh --native-ssh=false docker load >/dev/null || {
    echo 'test-k8s: could not load images into minikube'
    exit 1
}

echo "installing the release $RELEASE"
helm install "$RELEASE" charts/factory -f charts/factory/values-minikube.yaml \
    --set "dashboard.image=$DASH_IMAGE" \
    --set "driver.image=$DRIVER_IMAGE" \
    --set "driver.executorImage=$STUB_IMAGE" \
    -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install failed'
    exit 1
}
installed=1

kubectl wait --for=condition=available \
    "deployment/$RELEASE-factory" "deployment/$RELEASE-factory-driver" \
    -n "$NAMESPACE" --timeout=300s >/dev/null 2>&1 &&
    ok 'the dashboard and driver come up' || bad 'the dashboard and driver come up' \
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

id="$(node -e '
fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "hello from minikube" }) })
    .then(async (r) => process.stdout.write(String((await r.json()).id ?? "")))
    .catch(() => process.stdout.write(""));
' "$BASE/api/jobs")"
case "$id" in
*-*) ok 'a job was queued' ;;
*) bad 'a job was queued' "no id came back" ;;
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
expect_contains 'the prompt reached the pod' "$result" 'hello from minikube'

# The runner object the executor created — the thing only kubernetes could prove. Found by the
# factory.job label the spec stamps on it (the release labels belong to the chart's objects).
job_object="$(kubectl get jobs -l factory.job -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
[ "${job_object:-0}" -ge 1 ] && ok 'a runner Job object exists' || bad 'a runner Job object exists' "none found"

kill "$pf_pid" 2>/dev/null

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
