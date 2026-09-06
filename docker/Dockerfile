FROM node:24-alpine AS deps
WORKDIR /app
# node-owned, because this stage installs as `node` (see USER below): the volume compose mounts over
# /app/node_modules seeds from whatever the image has here, ownership included, and a root-owned
# seed would leave the container's `npm install` — run as node — failing on EACCES.
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node core/package.json core/
COPY --chown=node:node server/package.json server/
COPY --chown=node:node web/package.json web/
# WORKDIR itself stays root-owned; the process only ever writes node_modules beneath it.
RUN chown node:node /app
USER node
RUN npm ci --ignore-scripts

# The target docker-compose.yml builds, and the reason it names one: `runtime` below is the last
# stage and so the default, and it is what deploys, but compose runs the working tree instead.
#
# This stage copies no sources at all: the repo arrives as a bind
# mount and the container runs the same `npm run dev` as the host. FROM deps rather than a bare
# node:24-alpine so that /app/node_modules already exists in the image — docker seeds a fresh named
# volume from whatever the image has at the mount point, so the first `up` starts with the
# dependencies already installed instead of a cold several-minute npm install.
FROM deps AS dev
# Stages inherit the parent's USER, and deps now ends as node — apk needs root.
USER root
WORKDIR /app
# Same reason as the runtime stage: the workspace reconcile shells out to git.
RUN apk add --no-cache git
# Run as `node`, matching the runtime stage and the runner images (both uid 1000): this is the
# process that clones the workspaces volume, and a root-owned clone is read-only for the runner
# that mounts the same volume. The `USER` above is not enough on its own — every mount point the
# compose file shadows with a named volume must already exist and be node-owned in the image, or
# the daemon creates it root-owned and seeds the volume behind it. /workspaces is here for the
# same reason the runtime stage creates it: a volume over a path the image does not have is
# created root-owned, and the first clone then dies on EACCES.
RUN mkdir -p core/node_modules server/node_modules web/node_modules driver/node_modules /workspaces \
    && chown node:node core server web driver \
        core/node_modules server/node_modules web/node_modules driver/node_modules /workspaces
# The runtime stage sets this too. Without it the dev server binds 127.0.0.1 *inside* the container,
# where the published port cannot reach it and curl from the host just hangs.
ENV HOST=0.0.0.0
USER node
EXPOSE 8080 5173

FROM deps AS build
# Inherited from deps: build tooling as root, as before deps ran as node.
USER root
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY core core
COPY server server
COPY web web
# Not `npm run build`: that one also builds the driver, which ships as its own image and whose
# sources are deliberately not copied here. Running it would fail on --workspace=driver.
RUN npm run build -w core && npm run build -w server && npm run build -w web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# node:24-alpine ships no git, and the workspace reconcile shells out to it. Absent, the failure is
# an ENOENT per repo that only ever appears in the container, never in dev.
RUN apk add --no-cache git
COPY --from=build /app/core/dist core/dist
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# The fixtures back DATA_SOURCE=fixture and TELEMETRY_SOURCE=fixture, which is how the
# container runs with no token, no database and no collector.
COPY --from=build /app/server/fixtures server/fixtures
COPY --from=build /app/core/test/fixtures/telemetry-sessions.json core/test/fixtures/telemetry-sessions.json
# tsc compiles neither .sql nor .json, so the migrations and the raw GitHub capture have to be
# copied by hand — both sit outside src/ at a depth that resolves the same from src/ and dist/.
COPY --from=build /app/server/migrations server/migrations
# No COPY for .env, despite the precedent just above: it carries secrets, so they
# have to arrive as a read-only mount or as environment, never baked into an image layer.
ENV WEB_ROOT=/app/web/dist
ENV HOST=0.0.0.0
# The mount point for docker-compose's `workspaces` volume, which ORG_WORKSPACE_ROOT defaults to.
# It has to exist in the image AND be owned by `node`: Docker seeds a fresh named volume from the
# image directory it is mounted over, ownership included, and a volume over a path the image does
# not have is created root-owned. The process runs as `node`, so the first clone then dies on
# `EACCES: permission denied, mkdir '/workspaces/<org>'` — in the container only, never in dev.
RUN mkdir -p /workspaces && chown node:node /workspaces
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
