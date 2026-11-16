#!/bin/sh
set -eu
for executable in /runtime/ttyd /runtime/pi/pi; do
  if [ ! -f "$executable" ] || [ ! -x "$executable" ]; then
    echo 'Pi Coding runtime is unavailable; inspect the install-runtime container.' >&2
    exit 1
  fi
done
node /bootstrap/prepare-cli.mjs
exec /runtime/ttyd --writable --check-origin --max-clients 1 --port 7681 \
  --cwd "$PI_WORKSPACE" --client-option 'titleFixed=Pi Coding Agent' \
  /bin/sh /bootstrap/launch.sh
