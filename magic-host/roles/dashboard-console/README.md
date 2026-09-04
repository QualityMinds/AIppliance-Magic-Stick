# Dashboard Console Role

This role displays the authenticated Magic Stick TUI on a monitor attached to
the appliance host after first-run setup.

It creates a protected host state directory, reconciles a private runtime
Deployment in `identity-system`, installs a launcher, and owns virtual terminal
9 through `magicstick-dashboard-console.service`. The Deployment has no Service
or ingress and disables service-account token mounting. It uses the dedicated
Node.js CLI runtime image while the host remains free of a separate
Node installation.

The launcher waits for the runtime Pod, attaches its terminal with `kubectl
exec`, and restarts the TUI after Pod upgrades or an intentional quit. The CLI
uses the canonical external issuer for token identity while reaching Keycloak
and the dashboard API through cluster-local transport. Initial authentication
uses the public `magicstick-cli` device flow and never stores a password.

The first-run role owns terminal 9 while its claim file exists. Its cleanup
service starts this role's systemd unit only after the claim reaches
`Completed` or `CompletedLegacy`.
