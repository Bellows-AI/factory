# Claude Code, headless, with a fixed configuration baked in.
#
# Build context is this directory, not the repo root: the image carries no application code, only
# the CLI, the config under claude-home/ and the skills shared with opencode-executor, which arrive
# as the named `skills` context:
#
#   docker build --build-context skills=docker/skills -t claude-executor docker/claude-executor
#
# debian rather than alpine: the CLI ships prebuilt glibc binaries (ripgrep among them) that fail
# at runtime on musl, and the failure surfaces as an empty search result rather than an error.
#
# -slim rather than the full image, reversing the earlier choice. The full tag carries a C/C++
# toolchain and an X/media stack it never uses, and with it `linux-libc-dev`, `libopenexr`,
# `libperl` and friends: 547 CRITICAL+HIGH findings on v0.0.0, of which ~497 were unfixed kernel
# headers nothing in a container links against. The release scan gates on CRITICAL+HIGH, so that
# base is a release that cannot ship.
#
# The earlier comment argued the full image avoids a network-dependent apt layer that breaks
# behind a TLS-intercepting proxy. That reason did not survive contact: the two layers below
# already curl binaries from acli.atlassian.com and github.com over TLS, so the build has required
# working egress and a trusted chain all along. apt adds one more host, not a new class of failure.
FROM node:24-bookworm-slim

# What -slim drops and the rest of this file needs: git (Claude Code shells out to it for status,
# diffs and blame), curl (the two downloads below) and the CA bundle both verify against.
#
# The doc/man/locale strip is in THIS layer, not a later one: deleting in a later layer leaves the
# bytes in this one and saves nothing. Worth 0.9MB, measured — NOT the ~18MB `dpkg-query
# --showformat='${Installed-Size}'` suggests when it reports perl at 28MB and git at 45MB. Those
# live in the base image's own layers, and a whiteout here cannot reclaim a lower layer's bytes;
# only the docs apt installs in THIS layer go. Kept because it is free and bounds the growth, not
# because it is large. Byte-identical to the same layer in docker/opencode-executor/Dockerfile,
# deliberately — see the acli/gh note below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# npm stays in this image — the CLI's plugin path uses it — so its own bundled dependency tree
# ships too, and the version node:24 pins carries the only fixable findings the release scan
# still reports here (tar, brace-expansion, ip-address, undici). Upgrading npm is what moves
# them; removing npm would take the plugin path with it. Pinned, like everything else in this
# file, so the image does not change under a rebuild of the same commit.
ARG NPM_VERSION=11.21.0
RUN npm install -g npm@${NPM_VERSION} && npm cache clean --force

# acli and gh sit ABOVE each image's CLI install, and the two files spell this whole block — ARG
# order included — identically. BuildKit keys a layer on the command string it was built from,
# which carries the declared ARGs as a `|N NAME=VALUE` prefix, so the slightest divergence here
# (an extra ARG above, a reworded flag) gives the two images four distinct layers instead of two
# shared ones. Built in one daemon, as `make runners` does, identical means the second build
# reuses the first's layers: 59MB less to store and pull on any node that runs both executors.
# Neither image gets smaller. Keep the two blocks in sync or the saving silently evaporates.

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
ARG GH_VERSION=2.102.0
RUN curl -fsSL --proto '=https' --tlsv1.2 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
        | tar -xz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
    && gh --version

# Pinned, not `latest`: two builds of the same commit must produce the same CLI, or a runner that
# starts misbehaving gives no way to tell a code change from a silent upgrade underneath it.
# No --ignore-scripts here, deliberately. The postinstall is what places the native binary, and
# without it the CLI installs cleanly and then fails at run time with
# "Error: claude native binary not installed."
# This floor also carries the board's master prompt (issue #244): `--append-system-prompt` and
# `--system-prompt-snapshot off` are both present from 2.1.280 on. The driver never falls back to
# prefixing the prompt onto the user message on an older CLI — a build below this floor fails an
# unknown-flag argv rather than silently losing the Factory execution context.
#
# The install lands one 223MB native binary, `bin/claude.exe`, hardlinked into the resolved
# platform package (@anthropic-ai/claude-code-linux-x64). `.exe` is the package's name for it on
# every platform; the file is an ELF. Unlike opencode below, only the one platform package
# resolves, so there is no second copy to delete.
ARG CLAUDE_CODE_VERSION=2.1.287
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && npm cache clean --force

ENV CLAUDE_CONFIG_DIR=/home/node/.claude

# The CLI's bundled skills (dataviz, loop, schedule, code-review, …) are interactive tools a
# headless run cannot use, listed to the model on every turn. This drops them; docker/skills and
# plugins stay. The env switch rather than settings.json's `disableBundledSkills`: a thread's
# settings.json persists, and only its hooks are re-laid. The built-in `statusline-setup` agent
# has no switch short of --safe-mode, so it stays listed.
ENV CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1

# The predefined configuration. Everything under claude-home/ lands in the config directory as-is:
# settings.json, CLAUDE.md, agents/, commands/, hooks/. No credentials live here — those arrive at
# runtime as environment (see README).
COPY --chown=node:node claude-home/ /home/node/.claude/

# Telemetry lives in MANAGED settings, not in claude-home/settings.json: managed is the one scope
# that outranks the checkout's own .claude/settings.json. A target repo that sets its own OTEL_*
# for host development (this repo points OTEL_EXPORTER_OTLP_ENDPOINT at 127.0.0.1:4318) would
# otherwise win inside the runner and export every datapoint into the container's own loopback —
# silently, since the CLI never reports a failed export. It also outranks a member's executor
# config, so telemetry cannot be switched off or redirected from there. Root-owned and read-only to
# the agent's uid, like the git guard: nothing in the container writes it. The driver replaces it,
# root-owned again, with its endpoint rendered in (driver/src/telemetry-config.ts).
COPY managed-settings.json /etc/claude-code/managed-settings.json

# The skills, from docker/skills/ — one source for both executor images, so a task sees the same
# skills whichever executor runs it. Before the /opt/claude-home snapshot below, so a seeded config
# dir (the transcript store's) carries them too.
COPY --from=skills --chown=node:node . /home/node/.claude/skills/

# Bind-mounted at runtime. Owned by node so the CLI can write into the checkout.
#
# /opt/claude-home is the seed source for a fresh config directory: the transcript store points
# CLAUDE_CONFIG_DIR at a per-thread directory on the workspaces volume, which starts empty and
# would hide the baked config, so the entrypoint copies this tree in on first run.
#
# A symlink, not the `cp -a` of the finished config this replaces. That copy wrote 34MB — nearly
# all of it the context-mode plugin baked in below — into a second layer, for a tree the baked
# home already holds. Nothing mutates /home/node/.claude before the seed runs: the entrypoint
# only seeds when CLAUDE_CONFIG_DIR has been pointed somewhere ELSE, and every container starts
# from the image, so two paths naming one tree costs nothing. The entrypoint's
# `[ -d /opt/claude-home ]` and `cp -a /opt/claude-home/.` both read through it unchanged.
# Dangling until the COPYs below land, which is fine — nothing dereferences it at build time.
# Created here, as root: /opt is root-owned, and everything past `USER node` cannot write it.
RUN mkdir -p /workspace && chown node:node /workspace \
    && ln -s /home/node/.claude /opt/claude-home
WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/claude-executor
# The branch reporter lives in /usr/local/bin, NOT claude-home/: the transcript store moves
# CLAUDE_CONFIG_DIR off the baked home, so a script there is not a fixed path. The git guard
# (settings.json's PreToolUse hook) is in the same boat and for the same reason: its hook
# command names an absolute path.
COPY branch-reporter.cjs /usr/local/bin/branch-reporter.cjs
COPY git-guard.cjs /usr/local/bin/git-guard.cjs
COPY claude-progress.cjs /usr/local/bin/claude-progress.cjs
# The cooperative Stop (issue #442): the poller writes the stop marker, the PostToolUse hook in
# settings.json reads it. Absolute paths in /usr/local/bin for the same reason as the git guard.
COPY stop-poller.cjs /usr/local/bin/stop-poller.cjs
COPY stop-hook.cjs /usr/local/bin/stop-hook.cjs
# The claim's turn context (issue #509): settings.json's UserPromptSubmit hook answers it from
# FACTORY_TURN_CONTEXT. Absolute path for the same reason as the git guard.
COPY turn-context-hook.cjs /usr/local/bin/turn-context-hook.cjs
RUN chmod 0755 /usr/local/bin/claude-executor /usr/local/bin/branch-reporter.cjs /usr/local/bin/git-guard.cjs /usr/local/bin/claude-progress.cjs /usr/local/bin/stop-poller.cjs /usr/local/bin/stop-hook.cjs /usr/local/bin/turn-context-hook.cjs

USER node

# Baked in at build time rather than resolved on first run: a cold container would otherwise clone
# the marketplace and install before it could answer anything, and would fail outright with no
# network. `plugin install` rewrites settings.json in place, adding extraKnownMarketplaces and
# enabledPlugins — which is why those two keys are absent from the committed settings.json. Runs as
# node because it writes into CLAUDE_CONFIG_DIR; as root it would leave the files unwritable.
RUN claude plugin marketplace add mksglu/context-mode \
    && claude plugin install context-mode@context-mode

# Mark first-run onboarding done. Without this the CLI opens the theme picker and waits for a
# keypress, which an unattended container never sends. Merged into the file the CLI just wrote rather than replacing it, since it
# already holds a generated machineID and userID.
RUN node -e "const f=process.env.CLAUDE_CONFIG_DIR+'/.claude.json',fs=require('fs'); \
    const c=JSON.parse(fs.readFileSync(f,'utf8')); c.hasCompletedOnboarding=true; \
    c.theme='dark'; fs.writeFileSync(f,JSON.stringify(c,null,2));"

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
