# Restart or shut down a computer

## Before you start

These actions affect the physical/virtual host and every workload on it, not just
the dashboard. Notify users, save work and keep a way to power the computer back on.

## Perform the action

1. Open **System → Computer power** as an administrator.
2. Select the managed computer and verify its name and current worker status.
3. Choose **Restart computer** or **Shut down computer**.
4. Review the warning and confirm the exact host name.

The host worker validates and schedules the action. A submitted request is not
proof that the computer has completed it. Stale evidence or another host operation
can prevent the action.

## Verify

After a restart, wait for host, cluster and GPU reconciliation, then test an
inference request. Shutdown can require manual power-on; Wake-on-LAN is not
implied. See [host recovery](host-management.md) for operation states.
