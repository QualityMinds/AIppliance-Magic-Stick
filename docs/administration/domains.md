# Domains and addresses

## Before changing a name

Keep a working local administrator session and independent host access. Public DNS,
private mDNS and TLS trust are different things; changing a dashboard setting does
not configure your router or public DNS provider.

## Configure

Open **System → Settings → Domains**. Review the public domain, dashboard hostname
and local mDNS settings offered by the form. Use names you control and save the
change. Wait for the platform to reconcile routes and identity callbacks.

Generated application hostnames follow `<instance-name>.<instance-type>.<domain>`.
Do not hand-edit individual generated routes to work around a changed domain.

## Verify

From an intended client, resolve the new name, open HTTPS, sign in locally and
open an application. Public names need matching DNS, reachability and certificate
configuration. mDNS usually stays on the local network and may not work over VPNs.

If a DHCP address changes, SSO kubeconfigs may need to be downloaded again.
See [certificates](certificates.md), [network configuration](network.md) and
[identity diagnostics](troubleshooting/identity.md).
