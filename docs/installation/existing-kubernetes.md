<a id="installation-in-einem-bestehenden-kubernetes-cluster"></a>

# Install in an existing Kubernetes cluster

This advanced route installs cluster components only. It does not install Ubuntu,
K3s, host mDNS, systemd workers or the physical setup console.

<a id="voraussetzungen"></a>
<a id="1-cluster-prüfen"></a>

## Before you start

- You administer the cluster and have a working `cluster-admin` kubeconfig.
- `kubectl`, Helm and the Flux CLI are installed; use Bash/Python 3 or PowerShell 7.
- A default StorageClass can provision persistent volumes.
- A LoadBalancer can assign Envoy a reachable private address, with ports `443`
  and temporary `9443` available.
- You have reviewed the cluster, container-runtime and GPU-provider compatibility
  for this release. Existing Kubernetes is not upgraded by these scripts.

Do not remove a shared gateway/controller just to install Magic Stick. Allocate
a separate address when necessary. Back up cluster state and confirm the kubeconfig
context before proceeding.

<a id="empfohlener-weg-ein-installationsskript"></a>
<a id="manueller-fallback"></a>
<a id="2-gateway--und-envoy-crds-installieren"></a>
<a id="3-flux-installieren"></a>
<a id="4-öffentliche-magic-stick-quelle-synchronisieren"></a>

## Install with the wrapper

```bash
git clone https://github.com/QualityMinds/AIppliance-Magic-Stick.git
cd AIppliance-Magic-Stick
less deploy-on-k8s.sh
bash deploy-on-k8s.sh --context "$(kubectl config current-context)" --preflight-only
bash deploy-on-k8s.sh --context "$(kubectl config current-context)"
```

Or with PowerShell 7:

```powershell
git clone https://github.com/QualityMinds/AIppliance-Magic-Stick.git
Set-Location AIppliance-Magic-Stick
Get-Content deploy-on-k8s.ps1
pwsh ./deploy-on-k8s.ps1 -Context (kubectl config current-context) -PreflightOnly
pwsh ./deploy-on-k8s.ps1 -Context (kubectl config current-context)
```

Use `--ref <release-tag>` or `-Ref <release-tag>` for a selected release.
The complete checkout includes the shared release verifier (Python 3 is required
on both platforms). The default resolves a verified stable release once and pins
Flux to its commit. No verified version stops before writes; it never falls back
to main. `--ref main`/`-Ref main` is an explicit development option.
The wrapper checks existing appliance/Flux ownership and stops rather than
overwriting another source tree. It installs the matching Gateway CRDs without
forcing field ownership. Resolve any conflict with the platform owner; do not
bypass it with `--force-conflicts`.

<a id="6-einmaligen-einrichtungscode-erzeugen"></a>
<a id="setup-adresse-ermitteln"></a>
<a id="dns-und-mdns"></a>

## Complete setup

The bootstrap terminal prints a one-time code and setup address. Kubernetes stores
the claim hash, not its plaintext. Connect over your private administration network,
verify the certificate fingerprint, then follow [first administrator setup](first-run-setup.md).
Do not open `9443` publicly. mDNS is optional and often unavailable in routed networks.

If bootstrap is interrupted, rerun the same wrapper with the same source/version
options. Its bounded resume state preserves the installation identity. Do not
manually regenerate setup state on a completed installation.

<a id="5-optional-kubernetes-zugriff-über-magic-stick-sso-aktivieren"></a>
<a id="abschluss-prüfen"></a>

## Verify and troubleshoot

```bash
kubectl get nodes
kubectl -n flux-system get gitrepositories,kustomizations,helmreleases
kubectl -n identity-system get appliancesetup local
kubectl get svc -A
```

Continue with [installation verification](verify.md). Host-only controls may be
unavailable: that is expected when your platform does not run the Magic Stick host worker.
For optional user-facing cluster access, follow [Kubernetes SSO access](../administration/kubernetes-access.md).

The reviewed manual implementation lives in [deploy-on-k8s.sh](../../deploy-on-k8s.sh)
and [deploy-on-k8s.ps1](../../deploy-on-k8s.ps1). For custom source ownership, use
[advanced GitOps integration](../development/gitops-overlays.md).

<a id="deinstallation"></a>

## Removal

Plan data retention and review generated resources with the cluster owner before
removal. Do not delete shared CRDs, Flux, namespaces or storage as a generic uninstall
step. See [backup and recovery](../administration/backup-recovery.md).
