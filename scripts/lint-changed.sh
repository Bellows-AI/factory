#!/bin/sh
# Biome over only the files this branch touched — committed since the merge-base with the base
# branch, staged, unstaged and untracked — at the lowest CPU priority. `biome check --changed`
# sees commits only, so it would skip exactly the work in progress. The whole-repo `npm run lint`
# stays CI's gate: a type-aware finding in a file this branch did not touch surfaces only there.
#
#   npm run lint:changed               LINT_BASE overrides the base ref (default origin/main)
#   npm run lint:changed -- --write    extra arguments go to biome check
set -eu
base=$(git merge-base "${LINT_BASE:-origin/main}" HEAD)
{
    git diff --name-only -z --diff-filter=d "$base"
    git ls-files --others --exclude-standard -z
} | sort -zu | xargs -0 -r nice -n 19 npx biome check --files-ignore-unknown=true --no-errors-on-unmatched "$@"
