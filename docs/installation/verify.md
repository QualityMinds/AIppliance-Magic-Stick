# Verify your installation

## From the dashboard

1. Sign in using the administrator created during setup, not the Linux/SSH account.
2. Open **Overview**. Resolve core identity, storage or reconciliation errors first.
3. Open **System → System Status** to inspect workload and reconciliation health.
4. Open **System → Hardware** to inspect each node and GPU. An optional provider
   without matching hardware need not be installed. Engine validation is optional
   and must be started explicitly; it is not a blanket certification.
5. Check the local/public URLs in **Overview** or **Services** from the client network.

## Optional administrator checks

On a managed host:

```bash
sudo systemctl status k3s --no-pager
sudo k3s kubectl get nodes
sudo k3s kubectl -n flux-system get kustomizations
sudo k3s kubectl -n identity-system get appliancesetup local
```

On an existing cluster, use the authorized `kubectl` context instead of `sudo k3s kubectl`.
After first-run setup, expect `ApplianceSetup/local` to be `Completed`; legacy
installations can report `CompletedLegacy`. The temporary setup route is removed.

## Expected result

You can sign in, read platform status and create runtime resources. Optional modules
and large model downloads may still be progressing. The next check is an actual
[first model response](../get-started/first-model.md), not simply a green Pod count.

If a core component remains unhealthy, follow [troubleshooting](../administration/troubleshooting/overview.md)
and collect bounded, redacted logs. Never paste setup claims or Secret values into an issue.
