#!/bin/sh
set -eu
tool_mode=$(node /bootstrap/prepare.mjs --tool-mode)
set -- --provider litellm --model "$PI_MODEL" --continue --offline
if [ "$tool_mode" = disabled ]; then
  set -- "$@" --no-tools
fi
exec /runtime/pi/pi "$@"
