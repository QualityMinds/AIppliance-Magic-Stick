#!/bin/sh
# SPDX-License-Identifier: BUSL-1.1
# One-time defaults migration. The caller's scoped config is read-only here;
# only the already provisioned bootstrap administrator can write realm policy.
set +x
set -eu
umask 077

KCADM=${KCADM:-/opt/keycloak/bin/kcadm.sh}
reader=${1:?A scoped Keycloak admin configuration is required}
master=
cleanup() { [ -z "$master" ] || rm -f "$master"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
fail() { printf 'Remember-me migration: %s; review required, no authentication bypass enabled.\n' "$1" >&2; exit 1; }

# CSV is produced by Keycloak's JSON parser, not by matching arbitrary JSON.
# Each request selects exactly one scalar; reject extra rows or unknown types.
scalar() {
  field=$1
  result=$("$KCADM" get realms/magicstick --config "$reader" --fields "$field" --format csv --noquotes 2>/dev/null) || return 1
  result=$(printf '%s\n' "$result" | tr -d '\r')
  case "$result" in *'
'*) return 1 ;; esac
  printf '%s' "$result"
}
version() {
  # kcadm --compressed bypasses field filtering and cannot be combined with
  # --fields. Normalize the known projection's pretty-print layout. The exact
  # version whitelist below still rejects unknown values, including ' 1 '.
  projection=$("$KCADM" get realms/magicstick --config "$reader" \
    --fields 'attributes(magicstickRememberMePolicyVersion)' 2>/dev/null) || return 1
  printf '%s\n' "$projection" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    -e 's/"[[:space:]]*:[[:space:]]*/":/g' -e 's/{[[:space:]]*}/{}/g' | tr -d '\r\n'
}
snapshot() {
  identity=$(scalar id) || return 1
  case "$identity" in ''|*[!a-zA-Z0-9_-]*) return 1 ;; esac
  enabled=$(scalar rememberMe) || return 1
  case "$enabled" in true|false) ;; *) return 1 ;; esac
  values=$identity,$enabled
  for field in accessTokenLifespan ssoSessionIdleTimeout ssoSessionMaxLifespan ssoSessionIdleTimeoutRememberMe ssoSessionMaxLifespanRememberMe; do
    value=$(scalar "$field") || return 1
    case "$value" in ''|*[!0-9]*) return 1 ;; esac
    values=$values,$value
  done
  printf '%s' "$values"
}

marker=$(version) || fail READ
case "$marker" in
  '{"attributes":{"magicstickRememberMePolicyVersion":"1"}}')
    printf 'Remember-me migration: already reviewed (version 1).\n'; exit 0 ;;
  '{}'|'{"attributes":{}}'|'{"attributes":null}') ;;
  *) fail VERSION ;;
esac
before=$(snapshot) || fail READ
case "$before" in
  *,true,300,1800,36000,0,0) action=defaults ;;
  *) action=preserve ;;
esac
[ -n "${KC_BOOTSTRAP_ADMIN_USERNAME:-}" ] && [ -n "${KC_BOOTSTRAP_ADMIN_PASSWORD:-}" ] || fail AUTH
master=$(mktemp /tmp/magicstick-session-admin.XXXXXXXX) || fail PRIVATE_FILE
"$KCADM" config credentials --config "$master" --server http://localhost:8080 \
  --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" \
  >/dev/null 2>&1 || fail AUTH

# Recheck after acquiring authority. A concurrent administrative change is not
# permission to silently adopt a different policy or realm identity.
again=$(snapshot) || fail READ
[ "$again" = "$before" ] && [ "$(version)" = "$marker" ] || fail CHANGED
set -- update realms/magicstick --config "$master" \
  -s 'attributes.magicstickRememberMePolicyVersion="1"'
if [ "$action" = defaults ]; then
  set -- "$@" -s ssoSessionIdleTimeoutRememberMe=604800 -s ssoSessionMaxLifespanRememberMe=2592000
fi
# kcadm's normal GET/merge/PUT preserves other attributes. Never use --no-merge.
if ! diagnostic=$("$KCADM" "$@" 2>&1); then
  case "$diagnostic" in *403*|*Forbidden*|*forbidden*) fail PERMISSION ;; *) fail WRITE ;; esac
fi
unset diagnostic
after=$(snapshot) || fail VERIFY
[ "$(version)" = '{"attributes":{"magicstickRememberMePolicyVersion":"1"}}' ] || fail VERIFY
if [ "$action" = defaults ]; then
  expected=${before%,0,0},604800,2592000
  [ "$after" = "$expected" ] || fail VERIFY
  printf 'Remember-me migration: version 1 applied (7 days idle, 30 days maximum).\n'
else
  [ "$after" = "$before" ] || fail VERIFY
  printf 'Remember-me migration: version 1 reviewed; custom session settings preserved.\n'
fi
