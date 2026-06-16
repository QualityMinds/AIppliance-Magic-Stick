[CmdletBinding()]
param(
  [string]$Image,
  [int]$DiskNumber,
  [switch]$ListDevices,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$AllowNonUsb
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session"
  }
}

function Show-Devices {
  Get-Disk |
    Sort-Object Number |
    Select-Object Number, FriendlyName, BusType, Size, PartitionStyle, IsBoot, IsSystem |
    Format-Table -AutoSize
}

if ($ListDevices) {
  Show-Devices
  exit 0
}

if (-not $Image) {
  throw "Missing -Image"
}

if ($PSBoundParameters.ContainsKey("DiskNumber") -eq $false) {
  throw "Missing -DiskNumber"
}

Assert-Admin

$imagePath = (Resolve-Path $Image).ProviderPath
$disk = Get-Disk -Number $DiskNumber

if ($disk.IsBoot -or $disk.IsSystem) {
  throw "Refusing to write to boot/system disk $DiskNumber"
}

if (-not $AllowNonUsb -and $disk.BusType -ne "USB") {
  throw "Disk $DiskNumber is $($disk.BusType), not USB. Re-run with -AllowNonUsb if this is intentional."
}

if (-not $Yes) {
  Write-Host "This will erase all data on disk $DiskNumber ($($disk.FriendlyName))."
  $expected = "ERASE $DiskNumber"
  $answer = Read-Host "Type `"$expected`" to continue"
  if ($answer -ne $expected) {
    throw "Confirmation did not match; aborting"
  }
}

Write-Host "Image:  $imagePath"
Write-Host "Target: PhysicalDrive$DiskNumber"

if ($DryRun) {
  Write-Host "Dry run only; no data was written."
  exit 0
}

Get-Partition -DiskNumber $DiskNumber -ErrorAction SilentlyContinue |
  ForEach-Object {
    try {
      $_ | Get-Volume -ErrorAction Stop | Dismount-Volume -Force -Confirm:$false
    } catch {
      # Partitions without mounted volumes are fine.
    }
  }

Set-Disk -Number $DiskNumber -IsReadOnly $false

$targetPath = "\\.\PhysicalDrive$DiskNumber"
$buffer = New-Object byte[] (4 * 1024 * 1024)
$inputStream = [IO.File]::Open($imagePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$outputStream = [IO.File]::Open($targetPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)

try {
  while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $outputStream.Write($buffer, 0, $read)
  }
  $outputStream.Flush($true)
} finally {
  $outputStream.Dispose()
  $inputStream.Dispose()
}

Update-HostStorageCache
Write-Host "Done. The USB stick now contains the Magic-Stick installer image."
