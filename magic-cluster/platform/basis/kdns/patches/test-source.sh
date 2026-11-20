#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]]; then
  printf 'Usage: %s <prepared kdns checkout>\n' "${0##*/}" >&2
  exit 2
fi

cd "$1"
test -z "$(gofmt -l \
  handler/gateway_api_handler.go handler/gateway_api_handler_test.go handler/gateway_links.go \
  watcher/watcher.go cmd/root.go \
  vendor/github.com/brutella/dnssd/{cache,mdns,multicast_links,multicast_links_test,multicast_links_linux_test,netlink_linux,responder,service}.go)"
go test -mod=vendor ./... github.com/brutella/dnssd
go vet -mod=vendor ./... github.com/brutella/dnssd

# Run the packet tests with no access to the runner's actual interfaces.
if [[ "${MAGICSTICK_TEST_LINUX_PACKETS:-0}" == 1 ]]; then
  test_dir="$(mktemp -d)"
  trap 'rm -f -- "$test_dir/mdns.test"; rmdir -- "$test_dir"' EXIT
  go test -mod=vendor -c github.com/brutella/dnssd -o "$test_dir/mdns.test"
  sudo unshare --net -- env MAGICSTICK_TEST_PRIVATE_NETNS=1 \
    "$test_dir/mdns.test" -test.v -test.timeout=45s \
    '-test.run=^TestLateIPv4AndRenumberingOnRealMulticastSocket$'
fi
