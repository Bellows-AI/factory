# The image the `.bellows.yaml` UI gate runs `npm run verify:ui` in: node, the chromium the locked
# playwright drives, its system libraries, git, and the postgres client that creates the two E2E
# databases. No application code — the gate mounts the worktree.
#
# Debian rather than alpine: playwright publishes no musl chromium.
FROM node:24-bookworm-slim

# No default. .github/workflows/ui-runner-image.yml reads it out of package-lock.json, so the
# browser revision always belongs to the playwright the suite resolves.
ARG PLAYWRIGHT_VERSION

# The gate runs npm, so it cannot be deleted the way the release images delete it. The base image's
# bundled npm fails the scan gate; the executors' pin clears all but what .trivyignore triages.
ARG NPM_VERSION=11.21.0

# A gate runs as uid 1000 with HOME=/tmp, so the browsers cannot live under root's home.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN test -n "$PLAYWRIGHT_VERSION" \
    && apt-get update \
    && apt-get install -y --no-install-recommends git postgresql-client \
    && npm install -g "npm@${NPM_VERSION}" \
    && npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm
