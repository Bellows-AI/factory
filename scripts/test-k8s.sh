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
# Everything it creates it removes: one helm release, its claims, and the images it loaded.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

RELEASE="factory-k8s-test-$(date +%s)"
NAMESPACE="${NAMESPACE:-default}"
DASH_IMAGE="${DASH_IMAGE:-factory-ai}"
DRIVER_IMAGE="${DRIVER_IMAGE:-factory-driver}"
STUB_IMAGE="${STUB_IMAGE:-echo-executor}"
COLLECTOR_IMAGE="${COLLECTOR_IMAGE:-otel/opentelemetry-collector-contrib}"

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

# Rendered with the local profile, which is the shape the cluster phase installs: offline auth,
# ReadWriteOnce claim, stub executor.
render() { helm template "$RELEASE" charts/factory -f charts/factory/values-local.yaml --namespace "$NAMESPACE"; }
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

# The DRIVER has its own headless Service: the ad-hoc gate endpoint binds an ephemeral port, and
# a headless Service is the only DNS that resolves to the pod without a port list to name it with.
driver_service="$(awk '/^# Source: factory\/templates\/driver-service.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the driver service is headless'        "$driver_service" 'clusterIP: None'
expect_contains 'the driver service selects the driver' "$driver_service" 'component: driver'
expect_contains 'the runner is told the driver service name' "$(cat "$work/rendered.yaml")" \
    "value: http://$RELEASE-factory-driver"
# The URL is useless against the default loopback bind: inside the pod, nothing else can reach
# 127.0.0.1. Compose makes the same pairing.
expect_contains 'the gate listener binds all interfaces' "$(cat "$work/rendered.yaml")" 'value: 0.0.0.0'

# Numbers arrive as integers, not whatever helm's float stringifier felt like — a `1.8e+06` here
# would be refused by the driver's own integer check at boot.
render | grep -q 'value: "1800000"' && ok 'the job timeout renders as an integer' ||
    bad 'the job timeout renders as an integer' "$(render | grep -A1 DRIVER_JOB_TIMEOUT_MS)"

# The driver forwards the branch reporter's credential by reference — the same Secret key the
# dashboard and collector read — so the value never lands in the driver's own pod spec.
driver="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the driver reads the ingest token for its runners' "$driver" 'key: ingest-token'
next="$(grep -A1 -- '- name: RUNNER_INGEST_TOKEN' <<<"$driver" | sed -n '2p' | tr -d ' ')"
[ "$next" = 'valueFrom:' ] || bad 'RUNNER_INGEST_TOKEN travels by secretKeyRef' "next line: '$next'"

# The dashboard pod must not start its server until the in-chart database accepts connections: the
# server's migration retry gives up after ~55s and then serves every DB-backed route as a 500
# forever — a state no amount of client-side polling recovers. On a cold cluster the database
# image pulls for minutes, so the wait has to live in the pod spec, as an init container running
# the same pg_isready the database pod's readiness probe runs.
dashboard="$(awk '/^# Source: factory\/templates\/deployment.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the dashboard waits for the database before starting' "$dashboard" \
    'wait-for-database'
expect_contains 'the wait is an init container, not a sidecar' "$dashboard" 'initContainers:'
expect_contains 'the wait is the database readiness predicate' "$dashboard" 'pg_isready'

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

echo "installing the release $RELEASE"
helm install "$RELEASE" charts/factory -f charts/factory/values-local.yaml \
    --set "dashboard.image=$DASH_IMAGE" \
    --set "driver.image=$DRIVER_IMAGE" \
    --set "driver.executorImage=$STUB_IMAGE" \
    --set "collector.image=$COLLECTOR_IMAGE" \
    -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install failed'
    exit 1
}
installed=1

# The timescale deployment is waited for deliberately: the dashboard listens the moment its
# process is up — health answers, availability reports — but its migrations only start landing
# once the database accepts connections, and the server gives up retrying after ~55s. On a cold
# kind node the database image is still being pulled through containerd in that window, so
# queueing before it is available fails every POST no matter how long the queue step polls.
kubectl wait --for=condition=available \
    "deployment/$RELEASE-factory" "deployment/$RELEASE-factory-driver" \
    "deployment/$RELEASE-factory-timescale" "deployment/$RELEASE-factory-collector" \
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
fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "hello from the cluster" }) })
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

kill "$pf_pid" 2>/dev/null

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
