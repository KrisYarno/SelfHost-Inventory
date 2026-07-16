#!/bin/sh
# scripts/build-info.sh [git-sha] — emit the {"sha","builtAt"} JSON that the
# Dockerfile bakes into the image for the /api/version build-identity probe.
#
# Why this exists (2026-07-16 stale-image incident): a failed `docker compose
# build` followed by `docker compose up -d` silently restarts the OLD image,
# which reads as a successful rebuild — the toolsuite live drive retested a fix
# against a pre-fix image this way. The probe makes image identity checkable:
# after any rebuild, /api/version MUST match `git rev-parse HEAD`.
#
# sha precedence: $1 (the GIT_SHA build arg) > .git/HEAD(+refs|packed-refs)
# copied into the build context via the .dockerignore negations > "unknown".
# NOTE: the fallback reflects HEAD, not uncommitted edits — commit before a
# rebuild you intend to verify (repo discipline anyway).
set -eu

sha="${1:-}"

if [ -z "$sha" ] && [ -f .git/HEAD ]; then
  head_content=$(cat .git/HEAD)
  case "$head_content" in
    ref:*)
      ref=$(printf '%s' "$head_content" | sed 's/^ref: *//')
      if [ -f ".git/$ref" ]; then
        sha=$(cat ".git/$ref")
      elif [ -f .git/packed-refs ]; then
        sha=$(awk -v r="$ref" '$2 == r { print $1 }' .git/packed-refs | tail -1)
      fi
      ;;
    *)
      # Detached HEAD: the file content IS the sha.
      sha="$head_content"
      ;;
  esac
fi

if [ -z "$sha" ]; then
  sha="unknown"
fi

printf '{"sha":"%s","builtAt":"%s"}\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
