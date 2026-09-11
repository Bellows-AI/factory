# Claude Code, headless, with a fixed configuration baked in.
#
# Build context is this directory, not the repo root: the image carries no application code, only
# the CLI and the config under claude-home/.
#
#   docker build -t claude-executor docker/claude-executor
#
# debian rather than alpine: the CLI ships prebuilt glibc binaries (ripgrep among them) that fail
# at runtime on musl, and the failure surfaces as an empty search result rather than an error.
# The full image rather than -slim, despite the size: it already carries git and the CA bundle, and
# Claude Code shells out to git for status, diffs and blame. Installing them with apt instead would
# be smaller but adds a network-dependent layer that breaks behind a TLS-intercepting proxy.
FROM node:24-bookworm

# Pinned, not `latest`: two builds of the same commit must produce the same CLI, or a runner that
# starts misbehaving gives no way to tell a code change from a silent upgrade underneath it.
# No --ignore-scripts here, deliberately. The postinstall is what places the native binary, and
# without it the CLI installs cleanly and then fails at run time with
# "Error: claude native binary not installed."
ARG CLAUDE_CODE_VERSION=2.1.251
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
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

# GitHub CLI. The github skill and CLAUDE.md both instruct agents to reach GitHub through `gh`, and
# without it every one of those instructions ends in "command not found". Static release tarball
# rather than apt, for the same proxy reason as the base image choice.
ARG GH_VERSION=2.98.0
RUN curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
        | tar -xz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
    && gh --version

ENV CLAUDE_CONFIG_DIR=/home/node/.claude

# The predefined configuration. Everything under claude-home/ lands in the config directory as-is:
# settings.json, CLAUDE.md, agents/, commands/, skills/, hooks/. No credentials live here — those
# arrive at runtime as environment (see README).
COPY --chown=node:node claude-home/ /home/node/.claude/

# Bind-mounted at runtime. Owned by node so the CLI can write into the checkout.
RUN mkdir -p /workspace /opt/claude-home && chown node:node /workspace /opt/claude-home
WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/claude-executor
# The branch reporter lives in /usr/local/bin, NOT claude-home/: the Remote Control auth volume
# mounts over CLAUDE_CONFIG_DIR and would shadow anything baked there — exactly the runs that
# most want to be attributed.
COPY branch-reporter.cjs /usr/local/bin/branch-reporter.cjs
RUN chmod 0755 /usr/local/bin/claude-executor /usr/local/bin/branch-reporter.cjs

USER node

# Baked in at build time rather than resolved on first run: a cold container would otherwise clone
# the marketplace and install before it could answer anything, and would fail outright with no
# network. `plugin install` rewrites settings.json in place, adding extraKnownMarketplaces and
# enabledPlugins — which is why those two keys are absent from the committed settings.json. Runs as
# node because it writes into CLAUDE_CONFIG_DIR; as root it would leave the files unwritable.
RUN claude plugin marketplace add mksglu/context-mode \
    && claude plugin install context-mode@context-mode

# Mark first-run onboarding done. Without this the CLI opens the theme picker and waits for a
# keypress, which an unattended container never sends — `--remote-control` in particular hangs on a
# prompt nobody can see. Merged into the file the CLI just wrote rather than replacing it, since it
# already holds a generated machineID and userID.
RUN node -e "const f=process.env.CLAUDE_CONFIG_DIR+'/.claude.json',fs=require('fs'); \
    const c=JSON.parse(fs.readFileSync(f,'utf8')); c.hasCompletedOnboarding=true; \
    c.theme='dark'; fs.writeFileSync(f,JSON.stringify(c,null,2));"

# Keep a pristine copy of the finished config. Remote Control needs a full-scope login, and a login
# only survives the container if CLAUDE_CONFIG_DIR is a volume — which mounts empty and hides
# everything above it. The entrypoint seeds the volume from here on first run.
RUN cp -a /home/node/.claude/. /opt/claude-home/

# The installs above run as root, and node creates /tmp/node-compile-cache while they run. It
# survives into the image root-owned, and node running as `node` below cannot write it — the
# compile cache silently disables itself. Recreate it node-owned, as root, then drop straight
# back: this is the end of the file, so the USER here is the user every runner container gets,
# and a runner left as root would write root-owned files into the mounted checkout — the
# permission failure this whole arrangement exists to prevent.
USER root
RUN mkdir -p /tmp/node-compile-cache && chown node:node /tmp/node-compile-cache
USER node

# The wrapper cds into $WORKDIR (default /workspace) before exec'ing claude with every argument
# given after the image name, so a caller can point one image at a subdirectory or at a second
# mounted checkout without rebuilding.
ENTRYPOINT ["claude-executor"]
CMD ["--help"]
