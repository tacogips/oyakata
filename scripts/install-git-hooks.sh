#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hooks_path="$repo_root/.githooks"

if [ ! -f "$hooks_path/pre-commit" ]; then
  printf '%s\n' "Expected hook file not found: $hooks_path/pre-commit" >&2
  exit 1
fi

chmod +x "$hooks_path/pre-commit"
git config --local core.hooksPath "$hooks_path"

printf '%s\n' "Configured core.hooksPath=$hooks_path"
