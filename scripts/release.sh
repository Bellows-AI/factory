#!/bin/sh
# Cut a patch release: bump VERSION's patch, commit only that, tag the commit vX.Y.Z, and push the
# branch and the tag in one atomic push. The tag starts release-image.yml, which validates and
# publishes; ci.yml's push filter skips the VERSION-only commit on main.
#
#   npm run release
#
# Refuses a branch other than main, a dirty tree, a HEAD not level with origin/main, a HEAD that
# already carries a v* tag, a malformed VERSION, and a next tag that exists locally or on origin.
# On failure it undoes only what it created locally; the atomic push lands both refs or neither.
set -eu

fail() {
    echo "release: $*" >&2
    exit 1
}

cd "$(git rev-parse --show-toplevel)"

[ "$(git symbolic-ref --quiet --short HEAD || true)" = main ] || fail 'not on main'
[ -z "$(git status --porcelain)" ] || fail 'the working tree is not clean'
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail 'HEAD is not level with origin/main'

[ -f VERSION ] || fail 'VERSION is missing'
current=$(cat VERSION)
[ "$(printf '%s\n' "$current" | wc -l)" -eq 1 ] \
    && printf '%s\n' "$current" | grep -Eqx '(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)' \
    || fail "VERSION holds '$current', not X.Y.Z"

[ -z "$(git tag --points-at HEAD --list 'v*')" ] || fail 'HEAD is already released'

major=${current%%.*}
rest=${current#*.}
minor=${rest%%.*}
patch=${rest#*.}
next="$major.$minor.$((patch + 1))"
tag="v$next"

git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null && fail "$tag already exists locally"
if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null; then
    fail "$tag already exists on origin"
else
    status=$?
    # 2 is ls-remote's "no matching ref"; anything else is a failure to ask.
    [ "$status" -eq 2 ] || fail "cannot list origin's tags"
fi

orig=$(git rev-parse HEAD)
wrote=
committed=
tagged=
released=
undo() {
    if [ -n "$released" ]; then return; fi
    if [ -n "$tagged" ]; then git tag -d "$tag" >/dev/null; fi
    if [ -n "$committed" ]; then git reset --quiet --keep "$orig"; fi
    if [ -n "$wrote" ]; then git checkout --quiet HEAD -- VERSION; fi
}
trap undo EXIT
trap 'exit 1' INT TERM

wrote=1
printf '%s\n' "$next" >VERSION
git add VERSION
git commit --quiet -m "Release $tag"
committed=1
git tag -a "$tag" -m "$tag"
tagged=1
git push --quiet --atomic origin HEAD:refs/heads/main "refs/tags/$tag" || fail "push of $tag failed; check origin before retrying"
released=1
echo "released $tag"
