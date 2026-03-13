[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$IncludeDocker = $true,
    [switch]$Aggressive
)

$ErrorActionPreference = 'Stop'

function Write-Info($msg)  { Write-Host "[i] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[+] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[!] $msg" -ForegroundColor Yellow }

function Remove-PathSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$DirectoryOnly
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    try {
        if ($DirectoryOnly) {
            Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object {
                if ($PSCmdlet.ShouldProcess($_.FullName, 'Remove item')) {
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
        }
        else {
            if ($PSCmdlet.ShouldProcess($Path, 'Remove item')) {
                Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
        Write-Warn "Skip locked path: $Path"
    }
}

Write-Info 'Starting safe cleanup for Windows host'

$pathsToCleanInside = @(
    "$env:TEMP",
    "$env:LOCALAPPDATA\Temp",
    "$env:WINDIR\Temp",
    "$env:LOCALAPPDATA\CrashDumps",
    "$env:LOCALAPPDATA\D3DSCache",
    "$env:LOCALAPPDATA\Microsoft\Windows\INetCache"
)

foreach ($dir in $pathsToCleanInside) {
    Remove-PathSafe -Path $dir -DirectoryOnly
}

$extraFiles = @(
    "$env:WINDIR\SoftwareDistribution\Download\*"
)

foreach ($filePattern in $extraFiles) {
    Get-ChildItem -Path $filePattern -Force -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-PathSafe -Path $_.FullName
    }
}

# Recycle bin cleanup
try {
    if (Get-Command Clear-RecycleBin -ErrorAction SilentlyContinue) {
        if ($PSCmdlet.ShouldProcess('Recycle Bin', 'Clear')) {
            Clear-RecycleBin -Force -ErrorAction SilentlyContinue
        }
    }
}
catch {
    Write-Warn 'Failed to clear Recycle Bin (non-critical)'
}

# Docker cleanup (safe by default)
if ($IncludeDocker) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        Write-Info 'Running Docker safe cleanup (builder cache + dangling images)'

        if ($PSCmdlet.ShouldProcess('docker builder cache', 'Prune')) {
            docker builder prune -f | Out-Null
        }

        if ($PSCmdlet.ShouldProcess('dangling Docker images', 'Prune')) {
            docker image prune -f | Out-Null
        }

        if ($Aggressive) {
            Write-Warn 'Aggressive Docker cleanup enabled: removes all unused containers/images/networks/volumes'
            if ($PSCmdlet.ShouldProcess('all unused Docker resources', 'System prune with volumes')) {
                docker system prune -af --volumes | Out-Null
            }
        }
    }
    else {
        Write-Warn 'Docker not found, skipping Docker cleanup'
    }
}

Write-Ok 'Cleanup completed'
Write-Host ''
Write-Host 'Usage examples:' -ForegroundColor Cyan
Write-Host '  powershell -ExecutionPolicy Bypass -File .\cleanup.ps1' -ForegroundColor Gray
Write-Host '  powershell -ExecutionPolicy Bypass -File .\cleanup.ps1 -Aggressive' -ForegroundColor Gray
Write-Host '  powershell -ExecutionPolicy Bypass -File .\cleanup.ps1 -WhatIf' -ForegroundColor Gray
