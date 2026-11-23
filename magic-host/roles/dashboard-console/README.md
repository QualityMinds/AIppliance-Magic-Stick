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
and the dashboard API through cluster-local transport.

The monitor is signed in automatically: the runtime mounts the generated
`magicstick-console-client` Secret read-only and the CLI exchanges it for a
short-lived token of the dedicated `magicstick-console` service account. No
second device, browser or external network is involved. Administrators choose
its access level (Administrator by default, Operator, Viewer or Off) in the
dashboard, CLI or TUI. With **Off**, or on an appliance whose platform revision
has not provisioned the Secret yet, the console falls back to the public
`magicstick-cli` device flow. A user who signs in that way with `x` replaces the
automatic session until they return to it; no password is ever stored.

A mouse attached to the appliance works on the monitor without a display
server. The Linux console reports no mouse to the program it shows, and the TUI
runs in a Pod, so the launcher runs the TUI session behind
`magicstick-console-mouse`. This helper reads the kernel's combined mouse device
(`/dev/input/mice`, which covers every attached mouse) and writes the mouse
reports a terminal emulator would send into the TUI's input, only while the TUI
has asked for them. The TUI draws the pointer itself. Without the helper, the
device, or with `dashboard_console_mouse_enabled: false`, the launcher starts
the TUI directly and the monitor is operated with the keyboard as before.

The monitor saves downloads to and opens files from USB sticks. The TUI cannot
reach host devices, so it writes a small JSON request into
`dashboard_console_transfer_directory/requests` (the only folder there that
the runtime user may write). `magicstick-console-usb.path` then runs
`magicstick-console-usb` (`files/console-usb.py`) as root:

- `scan` mounts every attached USB stick formatted as FAT32 or exFAT below
  `usb/<name>` with `nosuid,nodev,noexec,umask=0077` for the runtime user
  (FAT also flushes each file on close);
- `eject` flushes and unmounts one of those sticks;
- each request also detaches sticks that were unplugged without `eject`.

A disk is never offered while it holds a mounted filesystem, active swap or a
volume in use, and an EFI system partition is never offered. The helper answers
in `status/status.json` and only unmounts what it mounted. Nothing is mounted
when a stick is inserted, only when the signed-in TUI asks. The runtime mounts
the transfer folder with `mountPropagation: HostToContainer`, so sticks
mounted later appear in the running Pod. With `dashboard_console_usb_enabled:
false` the watcher is stopped and the launcher does not offer sticks to the
TUI.

The first-run role owns terminal 9 while its claim file exists. Its cleanup
service starts this role's systemd unit only after the claim reaches
`Completed` or `CompletedLegacy`.
