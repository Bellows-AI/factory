# Slimming the executor images

Measured 2026-10-02 on `main` (288751e), linux/amd64, after a clean `make runners`.

## The 2GB figure is stale

The local `claude-executor`/`opencode-executor` images reading 1.49GB/1.61GB were built before
commit 0373a8d moved both bases from `node:24-bookworm` to `node:24-bookworm-slim`. A rebuild of
the committed Dockerfiles gives:

| image | size |
| --- | --- |
| `claude-executor` | **695MB** |
| `opencode-executor` | **812MB** |

So the slim-base work is already done; what follows is what is left.

## Where the bytes are

Shared prefix (identical layers in both images, 9 of them):

| layer | size |
| --- | --- |
| `debian bookworm-slim` rootfs | 74.8MB |
| node 24 runtime | 148MB |
| yarn/corepack | 7.2MB |
| `apt-get install ca-certificates curl git` | 95.5MB |
| `npm@11.21.0` upgrade | 14.4MB |

Per image:

| claude-executor | size | | opencode-executor | size |
| --- | --- | --- | --- | --- |
| `claude.exe` (single native binary) | 223MB | | `opencode-linux-x64` | 177MB |
| `gh` | 42.1MB | | `opencode-linux-x64-baseline` | 177MB |
| context-mode plugin | 31MB | | context-mode (global npm) | 41.4MB |
| `/opt/claude-home` copy of the plugin | 31MB | | `gh` | 42.1MB |
| `acli` | 17MB | | `acli` | 17MB |
| | | | `@gcornut/opencode-otel` | 2MB |

The `apt` layer is ~93% git and its perl dependency: `git` 44.9MB, `libperl5.36` 28.9MB,
`perl-modules-5.36` 17.8MB, `git-man` 2.1MB.

## What can actually come off

### 1. opencode ships two copies of itself — −177MB (22%)

`npm install -g opencode-ai` resolves both optional platform packages,
`opencode-linux-x64` and `opencode-linux-x64-baseline`. Only the first is wired up:
`opencode-ai/bin/opencode.exe` is a **hardlink** into `opencode-linux-x64/bin/opencode`
(link count 2). The baseline copy — the fallback build for CPUs without the newer ISA
extensions — is 177MB of dead weight.

Verified by deleting it in a running container:

```
rm -rf /usr/local/lib/node_modules/opencode-ai/node_modules/opencode-linux-x64-baseline
opencode --version   # 1.18.29
```

Fix: append the `rm -rf` to the existing `RUN npm install -g opencode-ai@...` layer. Add an
assertion to `docker/opencode-executor/test.sh` that `opencode --version` still answers, so the
day npm's resolution flips to the baseline build is a test failure, not a container-only crash.

### 2. `/opt/claude-home` duplicates the plugin tree — −31MB

`RUN cp -a /home/node/.claude/. /opt/claude-home/` copies the 34MB finished config — almost all of
it the baked context-mode plugin — into a second layer. The copy exists only so the entrypoint can
seed a per-thread `CLAUDE_CONFIG_DIR` on first run. Two ways out:

- Install into `/opt/claude-home` and symlink `/home/node/.claude` at it (one tree, both paths).
- Drop the copy and have the entrypoint seed from `/home/node/.claude` directly.

The first keeps the entrypoint unchanged; the second keeps the image simpler. Either needs the
transcript-store seeding test to stay green.

### 3. Strip docs/man/locales — −15..20MB per image

`/usr/share/doc`, `/usr/share/man` (git-man alone is 2.1MB) and `/usr/share/locale` in the same
`RUN` as the `apt-get install`. Standard, zero behavioral risk.

### 4. Hoist `acli` and `gh` above the CLI install — 59MB less to pull, not less to store

Both images install the same `acli` (17MB) and `gh` (42.1MB) layers, but **after** their CLI
install, so the layers have different parents and docker/containerd treat them as distinct. Moving
both `RUN`s up to directly follow the `npm@` upgrade makes them part of the shared 9-layer prefix.
Each image's own size is unchanged; a node that runs both executors stores and pulls 59MB less.

### 5. Multi-stage final image — −15..25MB, more churn

A builder stage plus a `COPY --from` final stage would shed the shadowed old npm (14.4MB still in
the lower layer after the upgrade) and `curl`, which is only needed at build time. Real but small,
and it costs the Dockerfiles their current one-decision-per-layer readability. Do this last, if at
all.

## What is not worth attempting

- **`claude.exe`, 223MB.** One self-contained native binary with nothing prunable inside it.
- **Dropping node.** Both CLIs are self-contained binaries, but `npm` is load-bearing for Claude
  Code's plugin path (stated in the Dockerfile) and the hook scripts (`git-guard.cjs`,
  `branch-reporter.cjs`, `claude-progress.cjs`) are node. The 155MB stays.
- **Dropping perl to shrink git.** `git` Depends on perl in bookworm; removing it afterwards
  breaks `git add -p`/`-i` and `git-send-email` for a ~47MB gain. A static git build trades a
  measured 47MB for an unmeasured class of failure.
- **alpine.** Already settled: both CLIs ship glibc binaries that fail on musl, and for ripgrep
  the failure is an empty search result rather than an error.

## Result (measured, after the change landed)

| image | before | after | delta |
| --- | --- | --- | --- |
| `claude-executor` | 695MB | **674MB** | −21MB |
| `opencode-executor` | 812MB | **627MB** | −185MB |

Shared layers between the two images: 9 → **11**. `acli` (17MB) and `gh` (42.1MB) now have the
same parent in both builds, so a node running both executors holds one copy.

The claude delta is smaller than the −50MB projected above, and the reason is two corrections
worth keeping:

- **The CLI bump cost 11MB.** `@anthropic-ai/claude-code` 2.1.280 → 2.1.287 grew the binary layer
  234MB → 245MB. The slimming saved 32MB; the version bump spent 11MB of it back. opencode
  1.18.29 → 1.18.34 went the other way by a few MB.
- **The doc/man/locale strip is worth 0.9MB, not ~18MB.** The `dpkg-query` Installed-Size figures
  that suggested 18MB (perl 28MB, git 45MB, git-man 2.1MB) are for packages installed in the
  *base image's* layers. A `rm -rf` in a later layer writes a whiteout; it cannot reclaim a lower
  layer's bytes. Only the docs apt installs in the executors' own layer actually go. The strip is
  kept because it is free, not because it is large — and the comment in both Dockerfiles now says
  so, since the 18MB reasoning is exactly the kind that gets re-derived.

## Found on the way: three checks in `docker/claude-executor/test.sh` are already broken on main

`claude runs`, `context-mode responds` and `answers a prompt` fail, and they fail identically on an
image built from HEAD — verified by building `docker/claude-executor` at HEAD as `claude-head` and
running the same probes:

```
--- wrapper --version:            (empty)
--- direct --version:             2.1.280 (Claude Code)
--- wrapper plugin list:          (empty)
```

The cause is the wrapper, not the image: `entrypoint.sh` execs
`claude --output-format stream-json --verbose "$@"` with stdout on a FIFO read by
`claude-progress.cjs`, and that filter drops every line that is not a stream-json event. So
`--version` and `plugin list`, which print plain text and plain JSON, reach the filter and are
swallowed; `answers a prompt` gets the filter's `Claude session started.` summary instead of the
CLI's final message. The three checks go through the wrapper (`run "$IMAGE" --version`) while the
checks that pass use `--entrypoint`.

Not fixed here — it is untouched by this change and the fix is a real decision: either the three
checks move to `--entrypoint claude`, or `claude-progress.cjs` passes non-event lines through.
The second is the one that also restores a human running the image by hand.

The floor is unchanged: node 24 (155MB) + debian-slim (75MB) + git/perl (93MB, in the base
layers and so not strippable) + the CLI binary (245MB / 177MB) + gh/acli (59MB). Below that needs
a different base or a different git — see "What is not worth attempting".
