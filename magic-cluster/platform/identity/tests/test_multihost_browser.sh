#!/usr/bin/env bash
# SPDX-License-Identifier: BUSL-1.1
# Isolated synthetic browser/IdP test. No host trust store is modified.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d "${TMPDIR:-/tmp}/magicstick-multihost-browser.XXXXXX")"
stack_pid=
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [[ -n "$stack_pid" ]]; then
    kill "$stack_pid" 2>/dev/null || true
    wait "$stack_pid" || result=1
  fi
  rm -rf "$work" || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 "$root/magic-cluster/platform/identity/tests/test_multihost_stack.py" serve >"$work/stack.json" &
stack_pid=$!
for _ in $(seq 1 180); do
  [[ -s "$work/stack.json" ]] && break
  kill -0 "$stack_pid" 2>/dev/null || { echo 'Isolated identity stack failed' >&2; exit 1; }
  sleep 1
done
[[ -s "$work/stack.json" ]] || { echo 'Isolated identity stack timed out' >&2; exit 1; }
network="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["network"])' "$work/stack.json")"
ca_file="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ca_file"])' "$work/stack.json")"
docker run --rm --network "$network" \
  --mount "type=bind,source=$root/dashboard,target=/repo/dashboard,readonly" \
  --mount "type=bind,source=$root/magic-cluster/platform/identity/tests/multihost_browser.cjs,target=/test/browser.cjs,readonly" \
  --mount "type=bind,source=$ca_file,target=/test/ca.pem,readonly" \
  --env HOME=/tmp/magicstick-browser \
  --entrypoint sh \
  mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
  -ec 'apt-get update -qq && apt-get install -y -qq libnss3-tools >/dev/null; \
       HOME=/tmp/untrusted EXPECT_UNTRUSTED=1 node /test/browser.cjs; \
       for db in "$HOME/.pki/nssdb" "$HOME/.local/share/pki/nssdb"; do \
         mkdir -p "$db"; certutil -N -d "sql:$db" --empty-password; \
         certutil -A -d "sql:$db" -n magicstick-fixture -t "C,," -i /test/ca.pem; \
       done; \
       node /test/browser.cjs; \
       LEGACY_COOKIE_UPGRADE=1 node /test/browser.cjs'
