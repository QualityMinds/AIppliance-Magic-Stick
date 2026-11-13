#!/bin/sh
# SPDX-License-Identifier: BUSL-1.1
# Reconcile only the Git-owned human gateway callbacks using the existing
# scoped setup client. No new client, credential, role or wildcard host grant.
set +x
set -eu
umask 077

KCADM=${KCADM:-/opt/keycloak/bin/kcadm.sh}
config=${1:?A scoped Keycloak configuration is required}
client=${2:?The existing human gateway client UUID is required}
redirects=${3:?Configured redirect URIs are required}
origins=${4:?Configured web origins are required}
logout=${5:?Configured logout callbacks are required}
fail() { printf 'Keycloak callback sync: %s; no callback success attested.\n' "$1" >&2; exit 1; }
case "$client" in ''|*[!a-zA-Z0-9_-]*) fail IDENTITY ;; esac

# Parse only kcadm's single-field array-of-strings projection. Preserve every
# character inside strings; reject escapes, controls, extra keys and unknown
# shapes rather than normalizing malformed/wider URLs into accepted values.
# Keycloak's minimal image has no Python, jq or awk dependency.
projection_values() (
  input=$1 field=$2 state=open token=
  [ "${#input}" -le 8192 ] || exit 1
  tab=$(printf '\t') cr=$(printf '\r')
  lf='
'
  LC_ALL=C
  export LC_ALL
  while [ -n "$input" ]; do
    rest=${input#?}
    char=${input%"$rest"}
    input=$rest
    case "$state" in
      key|value)
        case "$char" in
          '"')
            if [ "$state" = key ]; then
              [ "$token" = "$field" ] || exit 1
              state=colon
            else
              printf '%s\n' "$token"
              state=after_value
            fi
            token= ;;
          '\'|[![:print:]]) exit 1 ;;
          *) token=$token$char ;;
        esac
        continue ;;
    esac
    case "$char" in ' '|"$tab"|"$cr"|"$lf") continue ;; esac
    case "$state:$char" in
      'open:{') state=key_start ;;
      'key_start:"') state=key ;;
      'colon::') state=array ;;
      'array:[') state=first_value ;;
      'first_value:]') state=close_object ;;
      'first_value:"'|'next_value:"') state=value ;;
      'after_value:,') state=next_value ;;
      'after_value:]') state=close_object ;;
      'close_object:}') state=done ;;
      *) exit 1 ;;
    esac
  done
  [ "$state" = done ]
)

expected_values() {
  field=$1 desired=$2
  values=$(projection_values "{\"$field\":$desired}" "$field") || return 1
  [ -n "$values" ] || return 1
  # All configured authorities must be explicit HTTPS hosts. Path-scoped
  # callback suffixes from the existing contract are not host wildcards.
  printf '%s\n' "$values" | while IFS= read -r value; do
    case "$value" in https://*) ;; *) exit 1 ;; esac
    case "$value" in *\**) exit 1 ;; esac
    authority=${value#https://}
    authority=${authority%%/*}
    case "$authority" in ''|*[!a-zA-Z0-9.:-]*) exit 1 ;; esac
  done || return 1
  printf '%s\n' "$values" | LC_ALL=C sort -u
}

expected_redirects=$(expected_values redirectUris "$redirects") || fail CONFIG
expected_origins=$(expected_values webOrigins "$origins") || fail CONFIG
# Logout destinations are a subset of the exact trusted origins, never an
# arbitrary URI or wildcard supplied through runtime status.
remaining=$logout
while [ -n "$remaining" ]; do
  value=${remaining%%##*}
  case "$value" in */) origin=${value%/} ;; *) fail CONFIG ;; esac
  printf '%s\n' "$expected_origins" | grep -Fx "$origin" >/dev/null || fail CONFIG
  if [ "$remaining" = "$value" ]; then remaining=; else remaining=${remaining#*##}; [ -n "$remaining" ] || fail CONFIG; fi
done

identity() {
  value=$("$KCADM" get "clients/$client" --config "$config" --realm magicstick \
    --fields id,clientId --format csv --noquotes 2>/dev/null) || return 1
  value=$(printf '%s' "$value" | tr -d '\r')
  [ "$value" = "$client,magicstick-human-gateway-local" ]
}

observed_values() {
  field=$1
  observed=$("$KCADM" get "clients/$client" --config "$config" --realm magicstick \
    --fields "$field" 2>/dev/null) || return 1
  actual=$(projection_values "$observed" "$field") || return 1
  printf '%s\n' "$actual" | LC_ALL=C sort -u
}

verify_list() {
  field=$1 expected=$2
  actual=$(observed_values "$field") || return 1
  [ "$actual" = "$expected" ]
}

verify_logout() {
  # URLs are validated above and contain no spaces or JSON escape characters.
  compact=$(printf '%s' "$1" | tr -d ' \t\r\n')
  case "$compact" in
    *'"post.logout.redirect.uris":"'"$logout"'"'*) return 0 ;;
    *) return 1 ;;
  esac
}

identity || fail IDENTITY
# Keycloak client PUT clears previous secret rotation metadata even if the
# update does not contain a client secret. Never reset an active rotation.
attributes=$("$KCADM" get "clients/$client" --config "$config" --realm magicstick --fields attributes 2>/dev/null) || fail ROTATION_READ
current_redirects=$(observed_values redirectUris) || fail VERIFY_REDIRECTS
current_origins=$(observed_values webOrigins) || fail VERIFY_ORIGINS
if [ "$current_redirects" = "$expected_redirects" ] && [ "$current_origins" = "$expected_origins" ] && verify_logout "$attributes"; then
  unset attributes
  identity || fail IDENTITY
  printf 'Keycloak callback sync: verified existing human gateway client.\n'
  exit 0
fi
case "$attributes" in
  *'"client.secret.expiration.time"'*|*'"client.secret.remaining.expiration.time"'*|*'"client.secret.rotated"'*|*'"client.secret.rotated.creation.time"'*|*'"client.secret.rotated.expiration.time"'*) unset attributes; fail ROTATION ;;
esac
unset attributes
if ! diagnostic=$("$KCADM" update "clients/$client" --config "$config" --realm magicstick \
  -s "redirectUris=$redirects" -s "webOrigins=$origins" \
  -s "attributes.\"post.logout.redirect.uris\"=$logout" 2>&1); then
  case "$diagnostic" in
    *403*|*Forbidden*|*forbidden*) fail WRITE_PERMISSION ;;
    *401*|*Unauthorized*|*unauthorized*) fail WRITE_AUTH ;;
    *) fail WRITE ;;
  esac
fi
unset diagnostic
identity || fail IDENTITY
verify_list redirectUris "$expected_redirects" || fail VERIFY_REDIRECTS
verify_list webOrigins "$expected_origins" || fail VERIFY_ORIGINS
attributes=$("$KCADM" get "clients/$client" --config "$config" --realm magicstick --fields attributes 2>/dev/null) || fail VERIFY_LOGOUT
verify_logout "$attributes" || { unset attributes; fail VERIFY_LOGOUT; }
unset attributes
printf 'Keycloak callback sync: verified existing human gateway client.\n'
