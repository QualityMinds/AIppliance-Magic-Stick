#!/usr/bin/env bash
set -euo pipefail

for command_name in kubectl jq dns-sd; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "required command not found: ${command_name}" >&2
    exit 1
  fi
done

gateway_namespace="${GATEWAY_NAMESPACE:-identity-system}"
gateway_name="${GATEWAY_NAME:-identity-pilot}"

gateway_json="$(kubectl -n "${gateway_namespace}" get gateway "${gateway_name}" -o json)"
gateway_ip="$(jq -r '.status.addresses[]? | select((.type // "IPAddress") == "IPAddress") | .value' <<<"${gateway_json}" | head -n 1)"
gateway_port="$(jq -r '[.spec.listeners[]? | select(.protocol == "HTTPS") | .port][0] // 443' <<<"${gateway_json}")"

if [[ -z "${gateway_ip}" ]]; then
  echo "Gateway ${gateway_namespace}/${gateway_name} has no IPAddress in status.addresses" >&2
  exit 1
fi

hostnames=()
while IFS= read -r hostname; do
  [[ -n "${hostname}" ]] && hostnames+=("${hostname}")
done < <(
  kubectl get httproutes.gateway.networking.k8s.io -A -o json |
    jq -r \
      --arg gateway_namespace "${gateway_namespace}" \
      --arg gateway_name "${gateway_name}" '
      .items[]
      | .metadata.namespace as $route_namespace
      | select(.metadata.annotations["lab42.io/mdns.enabled"] == "true")
      | select(any(
          .status.parents[]?;
          .parentRef.name == $gateway_name
          and (.parentRef.namespace // $route_namespace) == $gateway_namespace
          and any(.conditions[]?; .type == "Accepted" and .status == "True")
        ))
      | .spec.hostnames[]?
      | ascii_downcase
      | select(endswith(".local"))
    ' |
    sort -u
)

if [[ ${#hostnames[@]} -eq 0 ]]; then
  echo "No accepted HTTPRoute with lab42.io/mdns.enabled=true and a .local hostname found" >&2
  exit 1
fi

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "${pid}" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

for hostname in "${hostnames[@]}"; do
  instance="${hostname%.local}"
  instance="${instance//./-}"
  dns-sd -P "MagicStick-${instance}" _https._tcp local. "${gateway_port}" "${hostname}." "${gateway_ip}" >/dev/null &
  pids+=("$!")
  echo "published ${hostname} -> ${gateway_ip}:${gateway_port}"
done

echo "Rancher Desktop mDNS bridge is running; press Ctrl-C to stop."
wait
