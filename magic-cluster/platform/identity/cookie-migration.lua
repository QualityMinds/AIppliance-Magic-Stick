-- SPDX-License-Identifier: BUSL-1.1
-- Only the two explicitly named legacy Magic Stick cookies are ours by name.
-- Other OAuth cookies have generic, policy-UID-derived names: do not guess
-- ownership or erase unrelated application cookies.
local local_domain = "${AI_APPLIANCE_MDNS_DOMAIN:=magicstick.local}"
local public_domain = "${AI_APPLIANCE_DOMAIN:=magicstick.example.com}"
local dashboard_host = "${AI_APPLIANCE_DASHBOARD_HOST:=magicstick.example.com}"
local marker = "__Host-MagicStickCookieMigration"

local function within(host, domain)
  return host == domain or (#host > #domain and host:sub(-#domain - 1) == "." .. domain)
end

local function parent_for(host)
  if within(host, local_domain) then return local_domain end
  if within(host, public_domain) then return public_domain end
  return nil
end

function envoy_on_request(handle)
  local headers = handle:headers()
  local host = (headers:get(":authority") or ""):lower():match("^([^:]+)")
  local parent = host and parent_for(host)
  -- Keycloak has its own session cookies and must not be intercepted.
  if not parent or host == "id." .. local_domain or host == "id." .. public_domain then return end

  local cookie = headers:get("cookie") or ""
  local legacy = false
  local migrated = false
  for piece in (cookie .. ";"):gmatch("([^;]*);") do
    local name, value = piece:match("^%s*([^=%s]+)%s*=%s*(.-)%s*$")
    if name == "MagicStickAccessToken" or name == "MagicStickIDToken" then legacy = true end
    if name == marker and value == "2" then migrated = true end
  end
  if not legacy or migrated then
    -- Old anonymous gateway suffixes are not proof of ownership. Do not erase
    -- them or any app cookies. Offer a bounded manual recovery before nginx's
    -- single-header limit, without claiming which particular cookie is large.
    if (host == local_domain or host == dashboard_host) and #cookie >= 15360 then
      handle:respond({[":status"] = "431", ["cache-control"] = "no-store",
        ["content-type"] = "text/plain; charset=utf-8"},
        "The browser sent too much cookie data. Open this site in a private window or remove site data for this appliance in browser settings, then sign in again. Removing site data may also remove application preferences and sessions.")
    end
    return
  end

  local method = headers:get(":method") or ""
  if method ~= "GET" and method ~= "HEAD" then
    handle:respond({[":status"] = "409", ["cache-control"] = "no-store",
      ["content-type"] = "text/plain; charset=utf-8"},
      "Session migration is required. Open the service in a browser before retrying this action.")
    return
  end

  -- Relative-only location: never redirect to a supplied external authority.
  local path = headers:get(":path") or "/"
  if path:sub(1, 1) ~= "/" or path:sub(1, 2) == "//" or path:find("[\r\n\\]") then path = "/" end
  local expired = {}
  for _, name in ipairs({"MagicStickAccessToken", "MagicStickIDToken"}) do
    local attrs = "; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"
    table.insert(expired, name .. "=; Domain=" .. parent .. attrs)
    table.insert(expired, name .. "=" .. attrs)
  end
  table.insert(expired, marker .. "=2; Path=/; Secure; HttpOnly; SameSite=Lax")
  handle:respond({[":status"] = "303", ["location"] = path,
    ["cache-control"] = "no-store", ["set-cookie"] = expired}, "")
end
