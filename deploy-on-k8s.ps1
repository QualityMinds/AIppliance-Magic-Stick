#!/usr/bin/env pwsh
<#
.SYNOPSIS
Deploys Magic Stick into an existing Kubernetes cluster.

.DESCRIPTION
Runs fail-closed preflight checks, installs the pinned Envoy Gateway CRDs and
Flux controllers, creates the read-only Magic Stick source, and initializes a
one-time First-Run Setup. Existing appliance state is never reset.

.EXAMPLE
pwsh ./deploy-on-k8s.ps1 -Context rancher-desktop

.EXAMPLE
pwsh ./deploy-on-k8s.ps1 -Context production-admin -Ref v1.0.0 -Yes
#>
[CmdletBinding()]
param(
    [Parameter()]
    [string]$Context,

    [Parameter()]
    [string]$Ref = "main",

    [Parameter()]
    [ValidateSet("branch", "tag", "semver", "commit")]
    [string]$RefKind,

    [Parameter()]
    [string]$Repository = "https://github.com/QualityMinds/AIppliance-Magic-Stick.git",

    [Parameter()]
    [string]$Domain = "magicstick.example.com",

    [Parameter()]
    [string]$MdnsDomain = "magicstick.local",

    [Parameter()]
    [switch]$PreflightOnly,

    [Parameter()]
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$EnvoyGatewayVersion = "v1.8.2"
$SyncPath = "magic-cluster/flux/entrypoints/single-node"
$InstallerStateName = "magicstick-installer-state"
$BootstrapInstallationId = ""
$ResumeAllowed = $false

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "[magicstick] $Message"
}

function Stop-Install {
    param([Parameter(Mandatory)][string]$Message)
    throw "[magicstick] $Message"
}

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Stop-Install "Required tool not found: $Name"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Command,
        [Parameter()][string[]]$Arguments = @(),
        [Parameter()][switch]$Capture
    )

    if ($Capture) {
        $output = & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            Stop-Install "$Command failed with exit code $LASTEXITCODE."
        }
        return ($output | Out-String).Trim()
    }

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-Install "$Command failed with exit code $LASTEXITCODE."
    }
}

function Invoke-Kubectl {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter()][switch]$Capture
    )
    $allArguments = @("--context", $script:Context) + $Arguments
    $result = Invoke-Checked -Command "kubectl" -Arguments $allArguments -Capture:$Capture
    return $result
}

function Test-KubernetesResource {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & kubectl --context $script:Context @Arguments *> $null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Assert-DnsName {
    param(
        [Parameter(Mandatory)][string]$Value,
        [Parameter(Mandatory)][string]$Label
    )
    if ($Value -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' -or $Value.Contains("..")) {
        Stop-Install "$Label is not a valid DNS name: $Value"
    }
}

function Resolve-RefKind {
    if ($script:RefKind) {
        return
    }
    if ($script:Ref -match '^[0-9a-fA-F]{40}$') {
        $script:RefKind = "commit"
    }
    elseif ($script:Ref -match '^v[0-9]+\.[0-9]+\.[0-9]+([.-].*)?$') {
        $script:RefKind = "tag"
    }
    else {
        $script:RefKind = "branch"
    }
}

function Invoke-Preflight {
    if ($PSVersionTable.PSVersion.Major -lt 7) {
        Stop-Install "PowerShell 7 or newer is required."
    }
    foreach ($tool in @("kubectl", "helm", "flux")) {
        Assert-Command $tool
    }

    Assert-DnsName -Value $script:Domain -Label "-Domain"
    Assert-DnsName -Value $script:MdnsDomain -Label "-MdnsDomain"
    if (-not $script:MdnsDomain.EndsWith(".local", [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Install "-MdnsDomain must end in .local."
    }
    Resolve-RefKind

    if (-not $script:Context) {
        $script:Context = Invoke-Checked -Command "kubectl" -Arguments @("config", "current-context") -Capture
    }
    if (-not $script:Context) {
        Stop-Install "No kubectl context is selected. Use -Context."
    }

    Invoke-Checked -Command "kubectl" -Arguments @("config", "get-contexts", $script:Context) | Out-Null
    Invoke-Kubectl -Arguments @("get", "--raw=/readyz") | Out-Null

    $clusterAdmin = Invoke-Kubectl -Arguments @("auth", "can-i", "*", "*", "--all-namespaces") -Capture
    if ($clusterAdmin -ne "yes") {
        Stop-Install "The selected identity does not have cluster-admin permissions."
    }

    $storageJsonPath = '{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'
    $defaultStorage = Invoke-Kubectl -Arguments @("get", "storageclass", "-o", "jsonpath=$storageJsonPath") -Capture
    if (-not $defaultStorage) {
        $legacyJsonPath = '{range .items[?(@.metadata.annotations.storageclass\.beta\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'
        $defaultStorage = Invoke-Kubectl -Arguments @("get", "storageclass", "-o", "jsonpath=$legacyJsonPath") -Capture
    }
    if (-not $defaultStorage) {
        Stop-Install "The cluster has no default StorageClass."
    }

    if (Test-KubernetesResource -Arguments @("-n", "identity-system", "get", "appliancesetup", "local")) {
        Stop-Install "ApplianceSetup/local already exists. This script never resets an existing appliance."
    }

    if (Test-KubernetesResource -Arguments @("-n", "flux-system", "get", "configmap", $script:InstallerStateName)) {
        $state = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "configmap", $script:InstallerStateName, "-o", "jsonpath={.data.state}") -Capture
        $stateRepository = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "configmap", $script:InstallerStateName, "-o", "jsonpath={.data.repository}") -Capture
        $stateRef = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "configmap", $script:InstallerStateName, "-o", "jsonpath={.data.ref}") -Capture
        $stateRefKind = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "configmap", $script:InstallerStateName, "-o", "jsonpath={.data.refKind}") -Capture
        $statePath = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "configmap", $script:InstallerStateName, "-o", "jsonpath={.data.path}") -Capture
        $script:BootstrapInstallationId = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "configmap", $script:InstallerStateName, "-o", "jsonpath={.data.installationId}") -Capture
        if ($state -ne "Installing") {
            Stop-Install "Unknown bootstrap marker state: $state"
        }
        if ($stateRepository -ne $script:Repository -or $stateRef -ne $script:Ref -or
            $stateRefKind -ne $script:RefKind -or $statePath -ne $script:SyncPath) {
            Stop-Install "An interrupted bootstrap uses different repository options. Re-run with its original -Repository, -Ref, and -RefKind values."
        }
        if ($script:BootstrapInstallationId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
            Stop-Install "The bootstrap marker has no valid installation ID."
        }
        $script:ResumeAllowed = $true
        Write-Step "An interrupted Magic Stick bootstrap was found and can be resumed."
    }

    if (Test-KubernetesResource -Arguments @("-n", "ai-system", "get", "appliance", "local")) {
        if (-not $script:ResumeAllowed) {
            Stop-Install "Appliance/local already exists. Use Flux reconciliation to update this installation."
        }
    }

    if (Test-KubernetesResource -Arguments @("-n", "flux-system", "get", "gitrepository", "flux-system")) {
        $existingUrl = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "gitrepository", "flux-system", "-o", "jsonpath={.spec.url}") -Capture
        if ($existingUrl -ne $script:Repository) {
            Stop-Install "GitRepository/flux-system already points to $existingUrl. Magic Stick will not replace a shared Flux source."
        }
        if (-not $script:ResumeAllowed) {
            Stop-Install "A matching GitRepository/flux-system exists without an active installer marker. Use Flux reconciliation instead of reinitializing it."
        }
    }
    if (Test-KubernetesResource -Arguments @("-n", "flux-system", "get", "kustomization", "flux-system")) {
        $existingPath = Invoke-Kubectl -Arguments @("-n", "flux-system", "get", "kustomization", "flux-system", "-o", "jsonpath={.spec.path}") -Capture
        if ($existingPath -ne "./$script:SyncPath") {
            Stop-Install "Kustomization/flux-system already uses $existingPath. Use a dedicated cluster or a deployment overlay."
        }
        if (-not $script:ResumeAllowed) {
            Stop-Install "A matching Kustomization/flux-system exists without an active installer marker. Use Flux reconciliation instead of reinitializing it."
        }
    }

    Write-Step "Preflight passed for context '$script:Context'."
    Write-Step "Default StorageClass: $($defaultStorage -replace "`n", ", ")"
    Write-Warning "The cluster must provide a private LoadBalancer address for ports 443 and 9443."
}

function Initialize-BootstrapState {
    $namespaceYaml = Invoke-Kubectl -Arguments @("create", "namespace", "flux-system", "--dry-run=client", "-o", "yaml") -Capture
    Apply-YamlText -Yaml $namespaceYaml
    if ($script:ResumeAllowed) {
        Write-Step "Resuming bootstrap installation $script:BootstrapInstallationId."
        return
    }

    $script:BootstrapInstallationId = [Guid]::NewGuid().ToString()
    $stateYaml = Invoke-Kubectl -Arguments @(
        "-n", "flux-system", "create", "configmap", $script:InstallerStateName,
        "--from-literal=state=Installing",
        "--from-literal=repository=$script:Repository",
        "--from-literal=ref=$script:Ref",
        "--from-literal=refKind=$script:RefKind",
        "--from-literal=path=$script:SyncPath",
        "--from-literal=installationId=$script:BootstrapInstallationId",
        "--dry-run=client", "-o", "yaml"
    ) -Capture
    Apply-YamlText -Yaml $stateYaml
}

function Confirm-Cluster {
    if ($script:Yes) {
        return
    }
    $clusterServer = Invoke-Checked -Command "kubectl" -Arguments @(
        "config", "view", "--minify", "--context", $script:Context,
        "-o", "jsonpath={.clusters[0].cluster.server}"
    ) -Capture

    Write-Host ""
    Write-Host "Magic Stick will be deployed with cluster-wide resources:"
    Write-Host "  context:    $script:Context"
    Write-Host "  API server: $clusterServer"
    Write-Host "  repository: $script:Repository"
    Write-Host "  ref:        $script:RefKind $script:Ref"
    $answer = Read-Host "Continue? [y/N]"
    if ($answer -notmatch '^[Yy]$') {
        Stop-Install "Deployment cancelled."
    }
}

function Install-GatewayCrds {
    Write-Step "Applying Envoy Gateway $script:EnvoyGatewayVersion CRDs without forcing ownership conflicts."
    $crdBundle = [IO.Path]::GetTempFileName()
    try {
        $content = Invoke-Checked -Command "helm" -Arguments @(
            "show", "crds", "oci://docker.io/envoyproxy/gateway-helm",
            "--version", $script:EnvoyGatewayVersion
        ) -Capture
        if (-not $content) {
            Stop-Install "Envoy Gateway CRD bundle is empty."
        }
        [IO.File]::WriteAllText($crdBundle, $content + "`n", [Text.UTF8Encoding]::new($false))
        Invoke-Kubectl -Arguments @("apply", "--server-side", "--field-manager=magicstick-installer", "-f", $crdBundle)
    }
    finally {
        Remove-Item -LiteralPath $crdBundle -Force -ErrorAction SilentlyContinue
    }
}

function Install-Flux {
    $hasSourceController = Test-KubernetesResource -Arguments @("-n", "flux-system", "get", "deployment", "source-controller")
    $hasKustomizeController = Test-KubernetesResource -Arguments @("-n", "flux-system", "get", "deployment", "kustomize-controller")
    if ($hasSourceController -and $hasKustomizeController) {
        Write-Step "Reusing the existing Flux controllers without upgrading them."
        Invoke-Checked -Command "flux" -Arguments @("--context", $script:Context, "check")
    }
    else {
        Write-Step "Installing Flux controllers."
        Invoke-Checked -Command "flux" -Arguments @("--context", $script:Context, "check", "--pre")
        Invoke-Checked -Command "flux" -Arguments @("--context", $script:Context, "install")
    }
}

function Apply-YamlText {
    param([Parameter(Mandatory)][string]$Yaml)
    $manifest = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($manifest, $Yaml.TrimStart() + "`n", [Text.UTF8Encoding]::new($false))
        Invoke-Kubectl -Arguments @("apply", "-f", $manifest)
    }
    finally {
        Remove-Item -LiteralPath $manifest -Force -ErrorAction SilentlyContinue
    }
}

function Apply-Settings {
    $mdnsName = $script:MdnsDomain.Substring(0, $script:MdnsDomain.Length - 6)
    $namespaceYaml = Invoke-Kubectl -Arguments @("create", "namespace", "flux-system", "--dry-run=client", "-o", "yaml") -Capture
    Apply-YamlText -Yaml $namespaceYaml

    $settingsYaml = Invoke-Kubectl -Arguments @(
        "-n", "flux-system", "create", "configmap", "ai-appliance-settings",
        "--from-literal=AI_APPLIANCE_DOMAIN=$script:Domain",
        "--from-literal=AI_APPLIANCE_DASHBOARD_HOST=$script:Domain",
        "--from-literal=AI_APPLIANCE_MDNS_DOMAIN=$script:MdnsDomain",
        "--from-literal=AI_APPLIANCE_MDNS_NAME=$mdnsName",
        "--from-literal=AI_APPLIANCE_DASHBOARD_MDNS_NAME=$mdnsName",
        "--from-literal=AI_APPLIANCE_ENVOY_CRDS_POLICY=Skip",
        "--dry-run=client", "-o", "yaml"
    ) -Capture
    Apply-YamlText -Yaml $settingsYaml
}

function Apply-FluxSync {
    Write-Step "Creating the read-only Magic Stick Flux source."
    $repositoryJson = ConvertTo-Json -InputObject $script:Repository -Compress
    $refJson = ConvertTo-Json -InputObject $script:Ref -Compress
    $yaml = @"
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 1m0s
  ref:
    $($script:RefKind): $refJson
  url: $repositoryJson
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: flux-system
  namespace: flux-system
spec:
  interval: 10m0s
  path: "./$($script:SyncPath)"
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
  wait: true
  timeout: 15m0s
"@
    Apply-YamlText -Yaml $yaml
    Invoke-Checked -Command "flux" -Arguments @(
        "--context", $script:Context, "reconcile", "source", "git", "flux-system",
        "--namespace=flux-system", "--timeout=5m"
    )
    Invoke-Checked -Command "flux" -Arguments @(
        "--context", $script:Context, "reconcile", "kustomization", "flux-system",
        "--namespace=flux-system", "--with-source", "--timeout=20m"
    )
}

function New-ClaimCode {
    $alphabet = "0123456789abcdefghjkmnpqrstvwxyz"
    $characters = for ($index = 0; $index -lt 8; $index++) {
        $alphabet[[Security.Cryptography.RandomNumberGenerator]::GetInt32($alphabet.Length)]
    }
    return -join $characters
}

function Initialize-FirstRunSetup {
    Write-Step "Waiting for the First-Run Setup API."
    Invoke-Kubectl -Arguments @(
        "wait", "--for=condition=Established",
        "crd/appliancesetups.appliance.magicstick.dev", "--timeout=20m"
    )
    Invoke-Kubectl -Arguments @("get", "namespace", "identity-system") | Out-Null
    if (Test-KubernetesResource -Arguments @("-n", "identity-system", "get", "appliancesetup", "local")) {
        Stop-Install "ApplianceSetup/local appeared during deployment; refusing to overwrite it."
    }

    $claim = New-ClaimCode
    $hashBytes = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($claim))
    $claimHash = [Convert]::ToHexString($hashBytes).ToLowerInvariant()

    $secretYaml = Invoke-Kubectl -Arguments @(
        "-n", "identity-system", "create", "secret", "generic", "magicstick-setup-claim",
        "--from-literal=claim-sha256=$claimHash", "--dry-run=client", "-o", "yaml"
    ) -Capture
    Apply-YamlText -Yaml $secretYaml

    $setupYaml = @"
apiVersion: appliance.magicstick.dev/v1alpha1
kind: ApplianceSetup
metadata:
  name: local
  namespace: identity-system
spec:
  setupVersion: v1
  installationId: "$($script:BootstrapInstallationId)"
"@
    Apply-YamlText -Yaml $setupYaml

    Write-Host ""
    Write-Host "============================================================"
    Write-Host "Magic Stick Einrichtungscode: $claim"
    Write-Host "Notiere ihn jetzt. Kubernetes speichert nur seinen SHA-256-Hash."
    Write-Host "Setup: https://<private-load-balancer-ip>:9443/setup"
    Write-Host "============================================================"

    Invoke-Kubectl -Arguments @(
        "-n", "identity-system", "patch", "appliancesetup", "local",
        "--subresource=status", "--type=merge", "-p", '{"status":{"phase":"Pending"}}'
    )
    Invoke-Kubectl -Arguments @("-n", "flux-system", "delete", "configmap", $script:InstallerStateName)
    $claim = $null
    $claimHash = $null
}

try {
    Invoke-Preflight
    if ($PreflightOnly) {
        Write-Step "Preflight-only mode completed; no changes were made."
        exit 0
    }

    Confirm-Cluster
    Initialize-BootstrapState
    Install-GatewayCrds
    Install-Flux
    Apply-Settings
    Apply-FluxSync
    Initialize-FirstRunSetup
    Write-Step "Cluster bootstrap completed."
    Write-Step "Inspect the setup address with: kubectl --context '$Context' -n identity-system get gateway magicstick-setup"
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.WriteLine("[magicstick] Existing cluster resources were not removed.")
    exit 1
}
