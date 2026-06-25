[CmdletBinding()]
param(
  [string]$DeploymentName = "public",

  [Parameter(Mandatory = $true)]
  [string]$Hostname,

  [string]$GitOwner = "example-org",

  [string]$GitRepo = "example-deployment",

  [string]$GitBranch = "main",

  [string]$FluxClusterPath,
  [ValidateSet("github", "readonly-public")]
  [string]$FluxBootstrapMode = "readonly-public",
  [string]$FluxPublicSyncPath = "magic-cluster/flux/entrypoints/single-node",
  [string]$PublicRepo = "https://github.com/QualityMinds/AIppliance-Magic-Stick.git",
  [string]$PublicRef = "main",
  [ValidateSet("branch", "tag", "semver", "commit")]
  [string]$PublicRefKind = "branch",
  [string]$Output = "dist/magicstick-installer.img",
  [string]$ContainerRuntime,
  [string]$BuilderImage = "magicstick-installer-builder:local",
  [switch]$NoBuild,
  [string]$UbuntuIsoUrl = "https://releases.ubuntu.com/24.04.4/ubuntu-24.04.4-live-server-amd64.iso",
  [string]$UbuntuIsoSha256 = "e907d92eeec9df64163a7e454cbc8d7755e8ddc7ed42f99dbc80c40f1a138433",
  [string]$Domain = "example.local",
  [string]$DashboardHost = "dashboard.example.local",
  [string]$DashboardMdnsName = "ai-appliance"
)

$ErrorActionPreference = "Stop"

function Resolve-Tool {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  throw "None of these tools were found: $($Names -join ', ')"
}

function Read-SecretString {
  param([string]$Prompt)

  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).ProviderPath

if (-not $FluxClusterPath) {
  $FluxClusterPath = "deployments/$DeploymentName/infra-cluster/flux-bootstrap"
}

if ($FluxBootstrapMode -eq "github") {
  if (-not $DeploymentName -or -not $GitOwner -or -not $GitRepo -or -not $GitBranch) {
    throw "DeploymentName, GitOwner, GitRepo and GitBranch are required for github bootstrap mode"
  }

  $token = $env:FLUX_GITHUB_TOKEN
  if (-not $token) {
    $token = Read-SecretString -Prompt "Flux GitHub token"
  }
  if (-not $token) {
    throw "Flux GitHub token is required for github bootstrap mode"
  }
} else {
  $token = ""
}

if (-not $ContainerRuntime) {
  $ContainerRuntime = Resolve-Tool -Names @("docker", "podman")
}

if ([IO.Path]::IsPathRooted($Output)) {
  $outputFull = $Output
} else {
  $outputFull = Join-Path $repoRoot $Output
}

$outputDir = Split-Path -Parent $outputFull
$outputName = Split-Path -Leaf $outputFull
$cacheDir = Join-Path $repoRoot ".installer-cache"

New-Item -ItemType Directory -Force -Path $outputDir, $cacheDir | Out-Null

if (-not $NoBuild) {
  & $ContainerRuntime build `
    -f (Join-Path $scriptDir "Containerfile") `
    -t $BuilderImage `
    $scriptDir
  if ($LASTEXITCODE -ne 0) {
    throw "Container builder image build failed"
  }
}

$env:MAGICSTICK_DEPLOYMENT_NAME = $DeploymentName
$env:MAGICSTICK_HOSTNAME = $Hostname
$env:MAGICSTICK_GIT_OWNER = $GitOwner
$env:MAGICSTICK_GIT_REPO = $GitRepo
$env:MAGICSTICK_GIT_BRANCH = $GitBranch
$env:MAGICSTICK_FLUX_CLUSTER_PATH = $FluxClusterPath
$env:MAGICSTICK_FLUX_BOOTSTRAP_MODE = $FluxBootstrapMode
$env:MAGICSTICK_FLUX_PUBLIC_SYNC_PATH = $FluxPublicSyncPath
$env:MAGICSTICK_FLUX_GITHUB_TOKEN = $token
$env:MAGICSTICK_PUBLIC_REPO = $PublicRepo
$env:MAGICSTICK_PUBLIC_REF = $PublicRef
$env:MAGICSTICK_PUBLIC_REF_KIND = $PublicRefKind
$env:MAGICSTICK_UBUNTU_ISO_URL = $UbuntuIsoUrl
$env:MAGICSTICK_UBUNTU_ISO_SHA256 = $UbuntuIsoSha256
$env:MAGICSTICK_AI_APPLIANCE_DOMAIN = $Domain
$env:MAGICSTICK_AI_APPLIANCE_DASHBOARD_HOST = $DashboardHost
$env:MAGICSTICK_AI_APPLIANCE_DASHBOARD_MDNS_NAME = $DashboardMdnsName

& $ContainerRuntime run --rm `
  --env MAGICSTICK_DEPLOYMENT_NAME `
  --env MAGICSTICK_HOSTNAME `
  --env MAGICSTICK_GIT_OWNER `
  --env MAGICSTICK_GIT_REPO `
  --env MAGICSTICK_GIT_BRANCH `
  --env MAGICSTICK_FLUX_CLUSTER_PATH `
  --env MAGICSTICK_FLUX_BOOTSTRAP_MODE `
  --env MAGICSTICK_FLUX_PUBLIC_SYNC_PATH `
  --env MAGICSTICK_FLUX_GITHUB_TOKEN `
  --env MAGICSTICK_PUBLIC_REPO `
  --env MAGICSTICK_PUBLIC_REF `
  --env MAGICSTICK_PUBLIC_REF_KIND `
  --env MAGICSTICK_UBUNTU_ISO_URL `
  --env MAGICSTICK_UBUNTU_ISO_SHA256 `
  --env MAGICSTICK_AI_APPLIANCE_DOMAIN `
  --env MAGICSTICK_AI_APPLIANCE_DASHBOARD_HOST `
  --env MAGICSTICK_AI_APPLIANCE_DASHBOARD_MDNS_NAME `
  --volume "${repoRoot}:/workspace:ro" `
  --volume "${outputDir}:/output" `
  --volume "${cacheDir}:/cache" `
  $BuilderImage --output "/output/$outputName"

if ($LASTEXITCODE -ne 0) {
  throw "Installer image build failed"
}
