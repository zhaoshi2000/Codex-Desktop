#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo 'Install Node.js 22+ first.' >&2; exit 1; fi
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
exec node server/index.mjs --open
