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
