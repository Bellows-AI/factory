# opencode, headless, with a fixed configuration baked in.
#
# Build context is this directory, not the repo root: the image carries no application code, only
# the CLI, the config under opencode-home/ and the skills shared with claude-executor, which arrive
# as the named `skills` context:
#
#   docker build --build-context skills=docker/skills -t opencode-executor docker/opencode-executor
#
# The driver selects this image when a task's chosen executor profile has type `opencode`.
#
# debian rather than alpine: the CLI ships prebuilt glibc binaries that fail at runtime on musl.
#
# -slim rather than the full image, for the reason docker/claude-executor/Dockerfile spells out:
# the full tag's unused toolchain and media stack carried ~497 unfixed `linux-libc-dev` findings,
# and the release scan gates on CRITICAL+HIGH.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim

# What -slim drops and the rest of this file needs: git (the agent shells out to it), curl (the
# two downloads below) and the CA bundle both verify against. Deliberately NO compiler: a
# toolchain here would pull libc6-dev back in, and with it the `linux-libc-dev` findings this base
# change exists to remove. context-mode's better-sqlite3 resolves a prebuilt binding for
# linux/amd64 and linux/arm64 on node 24; the test below is what catches the day it stops.
#
# The doc/man/locale strip is in THIS layer, not a later one: deleting in a later layer leaves the
# bytes in this one and saves nothing. Worth 0.9MB, measured — NOT the ~18MB `dpkg-query
# --showformat='${Installed-Size}'` suggests when it reports perl at 28MB and git at 45MB. Those
# live in the base image's own layers, and a whiteout here cannot reclaim a lower layer's bytes;
# only the docs apt installs in THIS layer go. Kept because it is free and bounds the growth, not
# because it is large. Byte-identical to the same layer in docker/claude-executor/Dockerfile,
# deliberately — see the acli/gh note below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# npm stays in this image, so its own bundled dependency tree ships too — and the version node:24
# pins carries the only fixable findings the release scan still reports here. Same pin and same
# reasoning as docker/claude-executor/Dockerfile.
ARG NPM_VERSION=11.21.0
RUN npm install -g npm@${NPM_VERSION} && npm cache clean --force

# acli and gh sit ABOVE this image's CLI install, and docker/claude-executor/Dockerfile spells
# this whole block — ARG order included — identically. BuildKit keys a layer on the command string
# it was built from, which carries the declared ARGs as a `|N NAME=VALUE` prefix, so the slightest
# divergence here (an extra ARG above, a reworded flag) gives the two images four distinct layers
# instead of two shared ones. Built in one daemon, as `make runners` does, identical means this
# build reuses the claude image's layers: 59MB less to store and pull on any node that runs both
# executors. Neither image gets smaller. Keep the two blocks in sync or the saving silently
# evaporates.

# Atlassian CLI — the only supported way to read and write Jira from here; the Atlassian MCP server
# is deliberately not configured. TARGETARCH is amd64/arm64, which is exactly how the download
# paths are named, so no mapping table is needed.
ARG TARGETARCH
# --proto '=https' applies to the redirects -L follows, not just to the URL written here: without
# it a redirect to http:// is honoured, and the binary this installs arrives over plain HTTP.
RUN curl -fsSL --proto '=https' --tlsv1.2 -o /usr/local/bin/acli \
        "https://acli.atlassian.com/linux/latest/acli_linux_${TARGETARCH}/acli" \
    && chmod 0755 /usr/local/bin/acli \
    && acli --version

# GitHub CLI. The agent instructions point GitHub work at `gh`, and without it every one of those
# instructions ends in "command not found". Static release tarball rather than apt, for the same
# proxy reason as the base image choice.
ARG GH_VERSION=2.102.0
RUN curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
        | tar -xz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
    && gh --version

# Pinned, not `latest`: two builds of the same commit must produce the same CLI, or a runner that
# starts misbehaving gives no way to tell a code change from a silent upgrade underneath it.
# No --ignore-scripts: the install resolves its platform binary through install scripts, and
# without them the CLI installs cleanly and then fails at run time.
#
# npm resolves BOTH optional platform packages on linux/x64 — `opencode-linux-x64` and
# `opencode-linux-x64-baseline`, 177MB each — and wires up only the first: `bin/opencode.exe` is a
# hardlink into opencode-linux-x64/bin/opencode. The baseline build (the fallback for x86-64 CPUs
# without the newer ISA extensions) is never reachable through that hardlink, present or not, so
# deleting it removes storage and not a fallback. In THIS layer, or the bytes stay in it.
#
# The `opencode --version` is the guard, not a smoke test: if a future npm ever resolves the
# baseline package into the hardlink instead, this build fails here rather than shipping an image
# whose CLI is missing. docker/opencode-executor/test.sh asserts the directory stays gone.
ARG OPENCODE_VERSION=1.18.34
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && rm -rf /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-linux-x64-baseline \
    && opencode --version \
    && npm cache clean --force

# The OTLP metrics plugin, so a headless run actually reaches the collector. Pinned, and
# self-contained — its OpenTelemetry SDK is bundled into dist/index.js, so the install needs no
# transitive deps and the runtime needs no npm fetch. Referenced from the baked opencode.json by
# its absolute path below.
ARG OPENCODE_OTEL_VERSION=0.4.0
RUN npm install -g @gcornut/opencode-otel@${OPENCODE_OTEL_VERSION} \
    && npm cache clean --force

# The context-mode plugin (https://github.com/mksglu/context-mode) — sandboxed ctx_* tools, session
# memory, hook-based routing — registered by the baked opencode.json alongside the telemetry
# plugin. Pinned like everything else here. Its install scripts must run: better-sqlite3 resolves
# its platform binding through them, and without the binding the plugin fails at run time.
ARG CONTEXT_MODE_VERSION=1.0.169
RUN npm install -g context-mode@${CONTEXT_MODE_VERSION} \
    && npm cache clean --force

# Global config lives under XDG_CONFIG_HOME, and OPENCODE_CONFIG pins the file inside it. Both are
# outside /workspace on purpose: config that resolved inside the checkout would enter its diff —
# the same reason the claude-executor points --settings outside the worktree.
ENV XDG_CONFIG_HOME=/home/node/.config
ENV OPENCODE_CONFIG=/home/node/.config/opencode/opencode.json

# Telemetry. opencode's binary has no native OTLP metric surface (its bundled SDK only emits
# spans, and only behind `experimental.openTelemetry: true`), so metrics come from the plugin
# installed above, configured by otel.json. That file is the single source of truth — it points
# the plugin's exporter at the compose collector on 4318 with http/json, not the
# OTEL_EXPORTER_OTLP_* variables (the plugin reads neither). Off the compose network the exporter
# fails to connect and the runs go unrecorded; the CLI still works. It also decides whether prompt
# and tool bodies ride along, so it lives root-owned and read-only outside the node-owned config
# home, like the claude executor's managed settings — the driver replaces it, root-owned again,
# with its endpoint rendered in (driver/src/telemetry-config.ts).
ENV OPENCODE_OTEL_CONFIG_PATH=/etc/opencode-otel/otel.json
COPY otel.json /etc/opencode-otel/otel.json

# The predefined configuration. Permissions live here, NOT in a CLI flag — unlike claude-code,
# opencode takes policy from this file, and "ask" is unusable in a headless `run`: there is nobody
# to ask, and an unanswered ask auto-rejects, which once killed a run mid-investigation over a
# filename that happened to contain ".env.". The baked policy is permissionless inside the working
# directory (`*: allow`, with read's allow-all stated explicitly over opencode's seeded `*.env.*`
# deny) and hard-gated outside it: external_directory refuses every path beyond the checkout —
# the rest of the shared workspaces volume and system folders included — except the runner's own
# scratch, /tmp and $HOME, and webfetch is a flat deny. The entrypoint re-opens exactly one
# subtree at run time: the member's own tree, derived from the driver's XDG_DATA_HOME, so a task
# can always operate within its own workspace while other members' trees stay refused.
#
# Root-owned, the directory included (issue #452): this global copy is the FIRST config layer, so
# its key order is the order every later layer merges into — writable, the agent could list the
# deny globs before a catch-all allow and silently cancel them. The entrypoint's per-run allows
# ride OPENCODE_CONFIG_CONTENT instead of editing it. Its parents are root-owned and sticky (1777),
# like /tmp: node still creates its own entries (gh, git, caches), but can no longer rename a root
# entry aside and plant its own config in its place. context-mode/ is the plugin's own data
# directory, the one writable spot inside.
RUN chown root:root /home/node && chmod 1777 /home/node && install -d -m 1777 -o root -g root /home/node/.config
COPY opencode-home/ /home/node/.config/opencode/

# The same policy again in opencode's managed tier, root-owned: /etc/opencode is loaded above every
# other config layer — OPENCODE_CONFIG_CONTENT, the checkout's own config — so no layer the agent
# can write flips a baked value back, and plugins accumulate across layers, so none drops the
# telemetry plugin. A later layer can still ADD a narrower allow (a merge never removes keys, and
# the last match wins). To run another policy, mount your own over BOTH copies — a merge cannot
# remove a baked key, so either copy left in place keeps its keys.
COPY opencode-home/opencode.json /etc/opencode/opencode.json

# The skills, from docker/skills/ — the same SKILL.md files claude-executor bakes, in the global
# skills directory opencode discovers (`opencode debug skill` lists them).
COPY --from=skills . /home/node/.config/opencode/skills/
RUN install -d -o node -g node /home/node/.config/opencode/context-mode

# Bind-mounted at runtime. Owned by node so the CLI can write into the checkout.
RUN mkdir -p /workspace && chown node:node /workspace
WORKDIR /workspace

# The install above runs as root, and both opencode and node create scratch directories in /tmp
# while it runs — /tmp/opencode and /tmp/node-compile-cache. Those survive into the image, root-
# owned, and the CLI running as node below cannot write them: its own temp state and node's
# compile cache silently degrade to per-process temp files. Recreate them node-owned, last, so
# nothing re-creates them as root afterwards.
RUN mkdir -p /tmp/opencode /tmp/node-compile-cache && chown node:node /tmp/opencode /tmp/node-compile-cache

COPY entrypoint.sh /usr/local/bin/opencode-executor
# The branch reporter and the rate-limit watch, beside the entrypoint in /usr/local/bin:
# siblings of the CLI, outside the config directory nothing mounted at run time can shadow.
COPY branch-reporter.cjs /usr/local/bin/branch-reporter.cjs
COPY rate-limit-watch.cjs /usr/local/bin/rate-limit-watch.cjs
# The cooperative Stop (issue #442): the poller writes the stop marker, the baked factory-stop
# plugin (registered in opencode.json) reads it at each step boundary. Root-owned like the other
# baked plugins, so the agent cannot edit the plugin out of its own run.
COPY stop-poller.cjs /usr/local/bin/stop-poller.cjs
COPY stop-plugin/ /usr/local/lib/node_modules/factory-stop-plugin/
RUN chmod 0755 /usr/local/bin/opencode-executor /usr/local/bin/branch-reporter.cjs /usr/local/bin/rate-limit-watch.cjs /usr/local/bin/stop-poller.cjs

USER node

# The wrapper cds into $WORKDIR (default /workspace) before exec'ing opencode with every argument
# given after the image name, so a caller can point one image at a subdirectory or at a second
# mounted checkout without rebuilding.
ENTRYPOINT ["opencode-executor"]
CMD ["--help"]
