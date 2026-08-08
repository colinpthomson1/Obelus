#!/usr/bin/env bash

set -euo pipefail

repository_root="$(git rev-parse --show-toplevel)"
cd "$repository_root"

expected_origin="https://github.com/colinpthomson1/goose.git"
expected_upstream="https://github.com/aaif-goose/goose.git"
failed=0

check_remote() {
  local name="$1"
  local expected="$2"
  local actual

  actual="$(git remote get-url "$name" 2>/dev/null || true)"
  if [[ "$actual" == "$expected" ]]; then
    printf 'ok: %s -> %s\n' "$name" "$actual"
  else
    printf 'error: %s should be %s, found %s\n' "$name" "$expected" "${actual:-<missing>}" >&2
    failed=1
  fi
}

check_remote origin "$expected_origin"
check_remote upstream "$expected_upstream"

source bin/activate-hermit >/dev/null

printf 'ok: branch %s\n' "$(git branch --show-current)"
printf 'ok: node %s\n' "$(node --version)"
printf 'ok: pnpm %s\n' "$(pnpm --version)"
printf 'ok: rustc %s\n' "$(rustc --version)"
printf 'ok: cargo %s\n' "$(cargo --version)"
printf 'ok: just %s\n' "$(just --version)"

if [[ -n "$(git status --porcelain)" ]]; then
  printf 'warning: worktree has local changes\n'
else
  printf 'ok: worktree is clean\n'
fi

if [[ -n "${GOOSE_PATH_ROOT:-}" ]]; then
  case "$GOOSE_PATH_ROOT" in
    "$repository_root"/.local/*)
      printf 'ok: GOOSE_PATH_ROOT uses ignored local state\n'
      ;;
    *)
      printf 'warning: GOOSE_PATH_ROOT is outside %s/.local\n' "$repository_root"
      ;;
  esac
else
  printf 'warning: set GOOSE_PATH_ROOT=%s/.local/goose/dev before manual sessions\n' "$repository_root"
fi

exit "$failed"
