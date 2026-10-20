#!/bin/sh
set -eu
node /bootstrap/prepare.mjs
exec /runtime/ttyd --writable --check-origin --max-clients 1 --port 7681 \
  --cwd "$PI_WORKSPACE" --client-option 'titleFixed=Pi Coding Agent' \
  /bin/sh /bootstrap/launch.sh
