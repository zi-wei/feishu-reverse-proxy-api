#!/usr/bin/env bash
set -euo pipefail
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$script_dir/runtime/node" "$script_dir/app/cli.mjs" connect --agent agent_4kgf4uygwpt75n5 "$@"
