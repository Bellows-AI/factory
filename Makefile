# The baked `runtime` image — what deploys, and what `docker compose up` deliberately does not run
# (compose binds the working tree instead). `make baked` builds it and serves it against the
# compose TimescaleDB, the same factory_dev the dev stack uses, via the OFFLINE entry — the same
# server, built with the code-only no-fetch arm, so two processes never sync one database;
# AUTH_MODE=none + AUTH_ALLOW_PUBLIC_BIND=1 because the image bakes HOST=0.0.0.0, so the loopback
# port publish is the perimeter. BAKED_PORT defaults to 8081 so it
# can sit beside a running dev stack on 8080.

IMAGE ?= factory-ai
BAKED_PORT ?= 8081
# The compose project's network, where the `timescale` service name resolves. Override if the
# project directory is not `factory-ai` — the same caveat docker-compose.yml carries for
# WORKSPACE_VOLUME.
BAKED_NETWORK ?= factory-ai_default

.PHONY: baked baked-build baked-run

# Build only; docker's layer cache makes a no-change rebuild cheap.
baked-build:
	docker build -f docker/Dockerfile --target runtime -t $(IMAGE) .

# Run the existing image. Does not build — `make baked` for build + run. Reads ORG_ID/ORG_NAME
# from the repo-root .env, the same file compose reads, because those two key every stored row.
baked-run:
	docker compose up -d timescale
	if [ -f .env ]; then set -a; . ./.env; set +a; fi; \
	docker run --rm --name factory-baked \
		--network $(BAKED_NETWORK) \
		-p 127.0.0.1:$(BAKED_PORT):8080 \
		-e AUTH_MODE=none \
		-e AUTH_ALLOW_PUBLIC_BIND=1 \
		-e ORG_ID="$${ORG_ID}" \
		-e ORG_NAME="$${ORG_NAME}" \
		-e DATABASE_URL=postgres://factory:factory@timescale:5432/factory_dev \
		$(IMAGE) node server/dist/offline.js

baked: baked-build baked-run

# The runner images the job driver spawns from each task's executor selection. `make runners`
# rebuilds both; docker's layer cache makes a no-change
# rebuild cheap. Rebuild after editing anything under docker/<executor>/ or the driver picks up a
# stale image silently.

RUNNER_CLAUDE ?= claude-executor
RUNNER_OPENCODE ?= opencode-executor

.PHONY: runners runners-build claude-executor opencode-executor

claude-executor:
	docker build --build-context skills=docker/skills -t $(RUNNER_CLAUDE) docker/claude-executor

opencode-executor:
	docker build --build-context skills=docker/skills -t $(RUNNER_OPENCODE) docker/opencode-executor

runners-build: claude-executor opencode-executor

runners: runners-build

# The Kubernetes stack, end to end on a local kind cluster — the chart walkthrough
# (charts/factory/README.md) as one command. Builds the images, loads them into the cluster and
# installs the chart with charts/factory/values-local.yaml: GitHub sign-in and the GitHub App, as
# everywhere the chart runs, with the real runner images `make runners` builds. The auth and App
# values — and the model credential, when .env has one — come from .env through
# scripts/k8s-local-values.mjs, which names any required value that is missing;
# sign in at the forwarded port. Re-runs upgrade the release in place, keeping its data. Once everything is up the port-forward
# takes the foreground; Ctrl-C detaches it and leaves the stack running. `make build` is the hot
# half against a running stack — rebuild the code and runner images, load them into the node, restart the
# workloads — no install, no port-forward, release and data kept. K8S_PORT defaults to 8081
# so it can sit beside a running dev stack on 8080, the same reasoning as BAKED_PORT.
#
# State lives in its own release, `factory-state` (charts/factory-local-state): the database and
# the workspaces claim. Production runs no database in the cluster; locally this release stands in
# for the managed one, and values-local.yaml names its objects. `make stop` uninstalls only the app
# release and reaps the runner Jobs (created at runtime by the driver, so not the release's) —
# database and checkouts survive, and the next `make start` picks them up. `make reset` is `stop`
# plus the state release and its claims: an empty database next start. `make cleanup` deletes the
# kind cluster itself.

CLUSTER ?= factory
K8S_RELEASE ?= dev
# Fixed, not a knob: values-local.yaml names this release's objects.
K8S_STATE_RELEASE := factory-state
K8S_PORT ?= 8081
DRIVER_IMAGE ?= factory-driver
# The credential values for the local release, on stdout: `$(LOCAL_VALUES) | helm ... -f -`.
LOCAL_VALUES = K8S_PORT=$(K8S_PORT) node scripts/k8s-local-values.mjs
# Whatever the chart pins — read from the render, so the image loaded is the image the pod names.
COLLECTOR_IMAGE ?= $(shell $(LOCAL_VALUES) 2>/dev/null | helm template x charts/factory -f charts/factory/values-local.yaml -f - --show-only templates/collector.yaml 2>/dev/null | awk '$$1 == "image:" { print $$2; exit }')

.PHONY: build start stop reset

# Update a running cluster with new code. The collector is static — start's pull left it in the
# node — so only the code and runner images are rebuilt and re-loaded. Runner pods are minted per
# job, so a re-loaded runner tag reaches the next job with no restart; the restart exists because
# the images are side-loaded under one tag and read with IfNotPresent: nothing rolls on its own, and
# the running pods would keep the old layers. With no release installed the target stops after the
# load and says so, so `make build && make start` is a valid cold sequence too.
build: runners-build
	docker build -f docker/Dockerfile --target runtime -t $(IMAGE) .
	docker build -f docker/driver.Dockerfile -t $(DRIVER_IMAGE) .
	@for image in $(IMAGE) $(DRIVER_IMAGE) $(RUNNER_CLAUDE) $(RUNNER_OPENCODE); do \
		kind load docker-image $$image --name $(CLUSTER) || exit 1; \
	done
	@if kubectl --context kind-$(CLUSTER) get deployment/$(K8S_RELEASE)-factory >/dev/null 2>&1; then \
		kubectl --context kind-$(CLUSTER) rollout restart \
			deployment/$(K8S_RELEASE)-factory deployment/$(K8S_RELEASE)-factory-driver; \
	else \
		echo "make build: no release $(K8S_RELEASE) in $(CLUSTER) — images loaded; 'make start' installs it"; \
	fi

start:
	@for tool in docker kind helm kubectl node; do \
		command -v $$tool >/dev/null || { echo "make start: $$tool is required"; exit 1; }; \
	done
	@# Before any build: a missing credential should cost a second, not an image build.
	@$(LOCAL_VALUES) >/dev/null
	@kind get clusters | grep -qx '$(CLUSTER)' || kind create cluster --name $(CLUSTER)
	@kubectl config use-context kind-$(CLUSTER)
	@echo 'building the images on the host daemon'
	docker build -f docker/Dockerfile --target runtime -t $(IMAGE) .
	docker build -f docker/driver.Dockerfile -t $(DRIVER_IMAGE) .
	$(MAKE) runners-build
	docker pull -q $(COLLECTOR_IMAGE)
	@echo "loading the images into the kind cluster $(CLUSTER)"
	@for image in $(IMAGE) $(DRIVER_IMAGE) $(RUNNER_CLAUDE) $(RUNNER_OPENCODE) $(COLLECTOR_IMAGE); do \
		kind load docker-image $$image --name $(CLUSTER) || exit 1; \
	done
	@echo "installing the releases $(K8S_STATE_RELEASE) and $(K8S_RELEASE)"
	helm upgrade --install $(K8S_STATE_RELEASE) charts/factory-local-state
	$(LOCAL_VALUES) | helm upgrade --install $(K8S_RELEASE) charts/factory -f charts/factory/values-local.yaml -f -
	# The images are side-loaded under one tag and read with IfNotPresent, so an upgrade whose
	# values did not change rolls nothing out and a re-run would keep the stale pods. Restart both
	# workloads so every start runs what the build above just loaded.
	kubectl rollout restart deployment/$(K8S_RELEASE)-factory deployment/$(K8S_RELEASE)-factory-driver
	@echo 'waiting for the deployments (a cold node pulls the database image for minutes)'
	kubectl wait --for=condition=available \
		deployment/$(K8S_RELEASE)-factory deployment/$(K8S_RELEASE)-factory-driver \
		deployment/$(K8S_STATE_RELEASE)-timescale deployment/$(K8S_RELEASE)-factory-collector \
		--timeout=600s
	@echo
	@echo "board on http://127.0.0.1:$(K8S_PORT) — sign in with GitHub, then queue a job and watch it"
	@echo 'run through a pod on the real runner images.'
	@echo
	# The forward lands on one ready endpoint of the service, and a restart — this start's own
	# rollout, or any future one — can take that pod out from under it ("lost connection to
	# pod"). Retry until interrupted: Ctrl-C is the only thing that should end a start.
	until kubectl port-forward svc/$(K8S_RELEASE)-factory $(K8S_PORT):8080; do sleep 2; done

stop:
	helm uninstall $(K8S_RELEASE) || true
	kubectl delete jobs -l factory.job,app.kubernetes.io/instance=$(K8S_RELEASE) || true

# `stop` first, and not only for the order of the words: a runner pod still mounting the
# workspaces claim holds it under pvc-protection, and the claim delete waits for that — it would
# block forever on a pod whose delete had not been issued yet.
reset: stop
	helm uninstall $(K8S_STATE_RELEASE) || true
	kubectl delete pvc -l "app.kubernetes.io/instance=$(K8S_STATE_RELEASE)" || true

# The kind cluster itself, `stop` being only the release: this takes the node down with every
# volume bound to it — checkouts, database, history. Everything `make start` needs it rebuilds
# (images on the host daemon, cluster, release), so this is the reset button, not a loss.
.PHONY: cleanup

cleanup:
	kind delete cluster --name $(CLUSTER)
