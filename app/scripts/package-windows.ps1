[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SkipBuild,
    [string]$OutputDirectory,
    [long]$MaxSizeBytes = 25MB
)

$ErrorActionPreference = 'Stop'
$appDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryDirectory = (Resolve-Path (Join-Path $appDirectory '..')).Path
$executable = Join-Path $appDirectory 'src-tauri\target\release\discord-alt.exe'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $appDirectory 'release-staging'
}
$stagingDirectory = [IO.Path]::GetFullPath($OutputDirectory)

function Get-StageFiles {
    $files = @(
        @{ Source = $executable; Name = 'discord-alt.exe' },
        @{ Source = Join-Path $repositoryDirectory 'README.md'; Name = 'README.md' },
        @{ Source = Join-Path $repositoryDirectory 'DEPLOY.md'; Name = 'DEPLOY.md' }
    )

    $licenseFiles = Get-ChildItem -LiteralPath $repositoryDirectory -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(LICENSE|NOTICE)(\..*)?$' }
    foreach ($file in $licenseFiles) {
        $files += @{ Source = $file.FullName; Name = $file.Name }
    }

    return $files
}

if (-not $SkipBuild -and -not $DryRun) {
    Push-Location $appDirectory
    try {
        & cargo build --manifest-path 'src-tauri/Cargo.toml' --release
        if ($LASTEXITCODE -ne 0) {
            throw "Native release build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

$stageFiles = Get-StageFiles
$missing = @($stageFiles | Where-Object { -not (Test-Path -LiteralPath $_.Source -PathType Leaf) })
if ($missing.Count -gt 0) {
    throw ('Required package file(s) are missing: ' + (($missing | ForEach-Object { $_.Source }) -join ', '))
}

$sourceBytes = [long](($stageFiles | ForEach-Object { (Get-Item -LiteralPath $_.Source).Length } | Measure-Object -Sum).Sum)
$checksumBytes = [Text.Encoding]::ASCII.GetByteCount(('0' * 64) + '  discord-alt.exe' + "`r`n")
$totalBytes = $sourceBytes + $checksumBytes
$totalMiB = [Math]::Round($totalBytes / 1MB, 2)
$limitMiB = [Math]::Round($MaxSizeBytes / 1MB, 2)
Write-Host "Package contents ($totalBytes bytes / $totalMiB MiB, including checksum):"
foreach ($file in $stageFiles) {
    $size = (Get-Item -LiteralPath $file.Source).Length
    Write-Host ("  {0,-24} {1,12} bytes" -f $file.Name, $size)
}

if ($totalBytes -gt $MaxSizeBytes) {
    throw "Package size guard failed: $totalMiB MiB exceeds the $limitMiB MiB limit."
}

if ($DryRun) {
    Write-Host "Dry run: no files were written to $stagingDirectory"
    exit 0
}

if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

foreach ($file in $stageFiles) {
    Copy-Item -LiteralPath $file.Source -Destination (Join-Path $stagingDirectory $file.Name) -Force
}

$hash = (Get-FileHash -LiteralPath (Join-Path $stagingDirectory 'discord-alt.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $stagingDirectory 'discord-alt.exe.sha256') -Value "$hash  discord-alt.exe" -Encoding ASCII

$stagedBytes = [long]((Get-ChildItem -LiteralPath $stagingDirectory -File | Measure-Object -Property Length -Sum).Sum)
Write-Host "Staged package: $stagingDirectory"
Write-Host "Staged size (including checksum and docs): $stagedBytes bytes / $([Math]::Round($stagedBytes / 1MB, 2)) MiB"
Write-Host "SHA-256: $hash"
