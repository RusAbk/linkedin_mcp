#!/bin/sh
set -eu
umask 077
WEB_DATA_DIR="${WEB_DATA_DIR:-/data}"
export WEB_DATA_DIR
mkdir -p "$WEB_DATA_DIR"
exec 9>"$WEB_DATA_DIR/.portal.lock"
if ! flock --nonblock 9; then
  echo 'Another LinkedIn MCP container owns this data volume. Startup stopped; profile locks were not changed.' >&2
  exit 73
fi
node /app/web/scripts/recover-profiles.mjs
exec xvfb-run -a --server-args='-screen 0 1440x1000x24 -nolisten tcp' node /app/web/dist/web/src/main.js
