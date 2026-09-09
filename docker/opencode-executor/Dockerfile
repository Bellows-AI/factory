# opencode, headless, with a fixed configuration baked in.
#
# Build context is this directory, not the repo root: the image carries no application code, only
# the CLI and the config under opencode-home/.
#
#   docker build -t opencode-executor docker/opencode-executor
#
# The driver selects this image with RUNNER_CLI=opencode, which also switches the default
# EXECUTOR_IMAGE — an explicit EXECUTOR_IMAGE still wins.
#
# debian rather than alpine: the CLI ships prebuilt glibc binaries that fail at runtime on musl,
# and the full image already carries git and the CA bundle the agent shells out to.
FROM node:24-bookworm

# Pinned, not `latest`: two builds of the same commit must produce the same CLI, or a runner that
# starts misbehaving gives no way to tell a code change from a silent upgrade underneath it.
# No --ignore-scripts: the install resolves its platform binary through install scripts, and
# without them the CLI installs cleanly and then fails at run time.
ARG OPENCODE_VERSION=1.18.29
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && npm cache clean --force

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
ARG GH_VERSION=2.98.0
RUN curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
        | tar -xz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
    && gh --version

# Global config lives under XDG_CONFIG_HOME, and OPENCODE_CONFIG pins the file inside it. Both are
# outside /workspace on purpose: config that resolved inside the checkout would enter its diff —
# the same reason the claude-executor points --settings outside the worktree.
ENV XDG_CONFIG_HOME=/home/node/.config
ENV OPENCODE_CONFIG=/home/node/.config/opencode/opencode.json

# Telemetry. The endpoint is the compose collector, resolvable only from that network — off it the
# exporter fails to connect and the sessions go unrecorded, the CLI still works. Unlike
# claude-code's, opencode's OTEL surface is not exhaustively verified against these variables; if
# a run's metrics do not arrive at the collector, check here first.
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318
ENV OTEL_EXPORTER_OTLP_PROTOCOL=http/json

# The predefined configuration. Permissions live here, NOT in a CLI flag — unlike claude-code,
# opencode takes policy from this file, and "ask" is unusable in a headless `run`: there is nobody
# to ask, and an unanswered ask auto-rejects, which once killed a run mid-investigation over a
# filename that happened to contain ".env.". The baked policy is permissionless inside the working
# directory (`*: allow`, with read's allow-all stated explicitly over opencode's seeded `*.env.*`
# deny) and hard-gated outside it: external_directory refuses every path beyond the checkout — the
# rest of the shared workspaces volume and system folders included — except the runner's own
# scratch, /tmp and $HOME, and webfetch is a flat deny. To run another policy, mount your own over
# /home/node/.config/opencode/opencode.json.
COPY --chown=node:node opencode-home/ /home/node/.config/opencode/

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
RUN chmod 0755 /usr/local/bin/opencode-executor

USER node

# The wrapper cds into $WORKDIR (default /workspace) before exec'ing opencode with every argument
# given after the image name, so a caller can point one image at a subdirectory or at a second
# mounted checkout without rebuilding.
ENTRYPOINT ["opencode-executor"]
CMD ["--help"]
