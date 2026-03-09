#!/usr/bin/env bash
set -euo pipefail

node_path="$(command -v node || true)"

if [[ -z "${node_path}" ]]; then
  echo "error: Node.js is required for this repository's Vite/Vitest/Playwright tooling, but 'node' is not available in PATH." >&2
  echo "hint: activate the full development shell (for example via 'nix develop' or direnv) before running this command." >&2
  exit 1
fi

if [[ "${node_path}" == /tmp/bun-node-* ]]; then
  echo "error: Bun's temporary 'node' shim is not sufficient for this repository's Vite/Vitest/Playwright tooling." >&2
  echo "hint: activate an environment that provides a real Node.js binary in PATH (for example via 'nix develop' or direnv)." >&2
  exit 1
fi

exec "$@"
