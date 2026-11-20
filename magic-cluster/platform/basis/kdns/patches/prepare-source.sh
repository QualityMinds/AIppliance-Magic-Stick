#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  printf 'Usage: %s <clean pinned kdns checkout>\n' "${0##*/}" >&2
  exit 2
fi

patch_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$1"
test "$(git rev-parse HEAD)" = f956ab5d35564ee84e58ba155e78a17423cc835b
test "$(go list -mod=mod -m -f '{{.Version}}' github.com/brutella/dnssd)" = v1.2.14

git apply "$patch_dir/gateway-api.patch"
# Patch the checksum-verified dependency in a disposable source tree, not
# the shared Go module cache. Build and test with the same vendored source.
go mod vendor
git apply --directory=vendor/github.com/brutella/dnssd "$patch_dir/dnssd-links.patch"
test -s vendor/github.com/brutella/dnssd/LICENSE
