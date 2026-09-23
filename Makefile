# The baked `runtime` image — what deploys, and what `docker compose up` deliberately does not run
# (compose binds the working tree instead). `make baked` builds it and serves it against the
# compose TimescaleDB, the same factory_dev the dev stack uses, via the OFFLINE entry — the same
# server, built with the code-only no-fetch arm, so two processes never sync one database;
# AUTH_MODE=none + AUTH_ALLOW_PUBLIC_BIND=1 is the chart's values-local profile — the image bakes
# HOST=0.0.0.0, so the loopback port publish is the perimeter. BAKED_PORT defaults to 8081 so it
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
# installs the chart with charts/factory/values-local.yaml, the offline profile: AUTH_MODE=none +
# the code-only no-fetch dashboard entry, stub echo executor — no GitHub App, no Claude credential.
# Re-runs upgrade the release in place, keeping its data. Once everything is up the port-forward
# takes the foreground; Ctrl-C detaches it and leaves the stack running. `make build` is the hot
# half against a running stack — rebuild the code images, load them into the node, restart the
# workloads — no install, no port-forward, release and data kept. K8S_PORT defaults to 8081
# so it can sit beside a running dev stack on 8080, the same reasoning as BAKED_PORT. `make stop`
# uninstalls the release and reaps what uninstall leaves: the claims (checkouts and history go
# with them — a dev install is disposable by construction) and the runner Jobs, created at runtime
# by the driver and therefore not the release's. `make cleanup` deletes the kind cluster itself.

CLUSTER ?= factory
K8S_RELEASE ?= dev
K8S_PORT ?= 8081
DRIVER_IMAGE ?= factory-driver
STUB_IMAGE ?= echo-executor
COLLECTOR_IMAGE ?= otel/opentelemetry-collector-contrib

.PHONY: build start stop

# Update a running cluster with new code. The stub executor and the collector are static — start's
# build left them in the node — so only the two code images are rebuilt and re-loaded. The restart
# exists because the images are side-loaded under one tag and read with IfNotPresent: nothing rolls
# on its own, and the running pods would keep the old layers. With no release installed the target
# stops after the load and says so, so `make build && make start` is a valid cold sequence too.
build:
	docker build -f docker/Dockerfile --target runtime -t $(IMAGE) .
	docker build -f docker/driver.Dockerfile -t $(DRIVER_IMAGE) .
	@for image in $(IMAGE) $(DRIVER_IMAGE); do \
		kind load docker-image $$image --name $(CLUSTER) || exit 1; \
	done
	@if kubectl --context kind-$(CLUSTER) get deployment/$(K8S_RELEASE)-factory >/dev/null 2>&1; then \
		kubectl --context kind-$(CLUSTER) rollout restart \
			deployment/$(K8S_RELEASE)-factory deployment/$(K8S_RELEASE)-factory-driver-local; \
	else \
		echo "make build: no release $(K8S_RELEASE) in $(CLUSTER) — images loaded; 'make start' installs it"; \
	fi

start:
	@for tool in docker kind helm kubectl; do \
		command -v $$tool >/dev/null || { echo "make start: $$tool is required"; exit 1; }; \
	done
	@kind get clusters | grep -qx '$(CLUSTER)' || kind create cluster --name $(CLUSTER)
	@kubectl config use-context kind-$(CLUSTER)
	@echo 'building the images on the host daemon'
	docker build -f docker/Dockerfile --target runtime -t $(IMAGE) .
	docker build -f docker/driver.Dockerfile -t $(DRIVER_IMAGE) .
	printf 'FROM alpine:3\nENTRYPOINT ["echo"]\n' | docker build -t $(STUB_IMAGE) -
	docker pull -q $(COLLECTOR_IMAGE)
	@echo "loading the images into the kind cluster $(CLUSTER)"
	@for image in $(IMAGE) $(DRIVER_IMAGE) $(STUB_IMAGE) $(COLLECTOR_IMAGE); do \
		kind load docker-image $$image --name $(CLUSTER) || exit 1; \
	done
	@echo "installing the release $(K8S_RELEASE)"
	helm upgrade --install $(K8S_RELEASE) charts/factory -f charts/factory/values-local.yaml
	# The images are side-loaded under one tag and read with IfNotPresent, so an upgrade whose
	# values did not change rolls nothing out and a re-run would keep the stale pods. Restart both
	# workloads so every start runs what the build above just loaded.
	kubectl rollout restart deployment/$(K8S_RELEASE)-factory deployment/$(K8S_RELEASE)-factory-driver-local
	@echo 'waiting for the deployments (a cold node pulls the database image for minutes)'
	kubectl wait --for=condition=available \
		deployment/$(K8S_RELEASE)-factory deployment/$(K8S_RELEASE)-factory-driver-local \
		deployment/$(K8S_RELEASE)-factory-timescale deployment/$(K8S_RELEASE)-factory-collector \
		--timeout=600s
	@echo
	@echo "board on http://127.0.0.1:$(K8S_PORT) — queue a job and watch it run through a pod:"
	@echo "  curl -s -X POST localhost:$(K8S_PORT)/api/jobs -H 'content-type: application/json' -d '{\"command\":\"hello from the cluster\"}'"
	@echo '  curl -s localhost:$(K8S_PORT)/api/jobs/<id>'
	@echo
	# The forward lands on one ready endpoint of the service, and a restart — this start's own
	# rollout, or any future one — can take that pod out from under it ("lost connection to
	# pod"). Retry until interrupted: Ctrl-C is the only thing that should end a start.
	until kubectl port-forward svc/$(K8S_RELEASE)-factory $(K8S_PORT):8080; do sleep 2; done

stop:
	helm uninstall $(K8S_RELEASE) || true
	kubectl delete pvc -l "app.kubernetes.io/instance=$(K8S_RELEASE)" || true
	kubectl delete jobs -l factory.job,app.kubernetes.io/instance=$(K8S_RELEASE) || true

# The kind cluster itself, `stop` being only the release: this takes the node down with every
# volume bound to it — checkouts, database, history. Everything `make start` needs it rebuilds
# (images on the host daemon, cluster, release), so this is the reset button, not a loss.
.PHONY: cleanup

cleanup:
	kind delete cluster --name $(CLUSTER)
