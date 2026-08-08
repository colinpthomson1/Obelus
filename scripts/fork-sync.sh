#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"

expected_origin="https://github.com/colinpthomson1/goose.git"
expected_upstream="https://github.com/aaif-goose/goose.git"

if [[ "$(git remote get-url origin 2>/dev/null || true)" != "$expected_origin" ]]; then
  printf 'Refusing to sync: origin is not %s\n' "$expected_origin" >&2
  exit 1
fi

if [[ "$(git remote get-url upstream 2>/dev/null || true)" != "$expected_upstream" ]]; then
  printf 'Refusing to sync: upstream is not %s\n' "$expected_upstream" >&2
  exit 1
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  printf 'Refusing to sync: switch to main first.\n' >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  printf 'Refusing to sync: commit, stash, or remove local changes first.\n' >&2
  exit 1
fi

git fetch --prune upstream
git fetch --prune origin
git merge --ff-only upstream/main
git push origin main

printf 'main now matches upstream/main and has been pushed to origin.\n'
