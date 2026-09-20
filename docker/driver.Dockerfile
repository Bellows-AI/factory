# The job driver: polls the board and spawns claude-executor containers.
#
# It does not run Docker — it TALKS to the host's daemon over a mounted socket, so the runners it
# starts are siblings of this container, not children. That is why the workspace is referenced by
# volume NAME: a host path would mean nothing to the daemon in that context, and a path inside this
# container even less.
#
# Two targets, like docker/Dockerfile: `runtime` (the last stage) bakes driver/dist and is what
# deploys — the chart and scripts/test-k8s.sh build it with no --target. `dev` carries no source
# at all: docker-compose.yml bind-mounts the working tree over it and runs the same
# `npm run dev -w driver` as the host, so a restart can never serve a publisher older than the
# checkout (issue #174).

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Every workspace's manifest, or `npm ci` refuses the lockfile — even though only driver/ is built.
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
COPY driver/package.json driver/
RUN npm ci --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY driver driver
# Only the driver. Its tsconfig has no project references — it shares no code with core, which is
# what keeps this image free of the server's dependency tree.
RUN npm run build -w driver

# The target docker-compose.yml builds. No sources are copied — the working tree arrives as a bind
# mount and the container runs the same `npm run dev -w driver` as the host (tsx watch). FROM deps
# rather than a bare alpine so the node_modules volumes compose shadows onto /app/node_modules and
# /app/driver/node_modules seed from a warm npm ci, and so tsx is present. The docker CLI is the
# driver's one runtime tool: it talks to the host daemon through the socket compose mounts, spawning
# sibling runner containers. Not the last stage — `runtime` below stays what deploys.
FROM deps AS dev
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The client only. The daemon is the host's, reached through the socket mounted at run time.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
# No `npm ci` here: the driver has no runtime dependencies at all. package.json is still needed —
# it is what makes node read dist/*.js as ESM.
COPY driver/package.json driver/package.json
COPY --from=build /app/driver/dist driver/dist
# Runs as root, unlike the dashboard. /var/run/docker.sock is root-owned on the host and a
# non-root user cannot open it; see docs/security.md for what mounting it actually grants.
CMD ["node", "driver/dist/index.js"]
