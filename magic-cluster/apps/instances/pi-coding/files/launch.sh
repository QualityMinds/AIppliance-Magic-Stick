#!/bin/sh
set -eu
node /bootstrap/prepare.mjs
exec /runtime/pi/pi --provider litellm --model "$PI_MODEL" --continue --offline
