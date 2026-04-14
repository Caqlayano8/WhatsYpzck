param(
    [string]$Source = "C:\Users\kurto\OneDrive\Desktop\WhatsYpzck",
    [string]$BackupRoot = "C:\Users\kurto\OneDrive\Desktop\WhatsYpzck-LiveBackups"
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$ts] $Message"
}

if (-not (Test-Path -LiteralPath $Source)) {
    throw "Source path not found: $Source"
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDir = Join-Path $BackupRoot "live-$stamp"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$excludeDirs = @(
    ".git",
    "node_modules",
    ".wwebjs_cache",
    ".wwebjs_auth",
    "dist-installers-smoke-20260313-165054"
)

$excludeFiles = @(
    "Thumbs.db",
    ".DS_Store"
)

function Test-ExcludedPath {
    param([string]$FullPath)

    $normalized = $FullPath.Replace('/', '\')
    foreach ($dir in $excludeDirs) {
        $marker = "\$dir\"
        if ($normalized -like "*$marker*" -or $normalized.EndsWith("\$dir")) {
            return $true
        }
    }

    $leaf = Split-Path -Leaf $normalized
    if ($excludeFiles -contains $leaf) {
        return $true
    }

    return $false
}

function Copy-One {
    param([string]$Path)

    if (-not $Path) { return }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    if (Test-ExcludedPath -FullPath $Path) { return }

    $resolvedSource = (Resolve-Path -LiteralPath $Source).Path
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path

    if (-not $resolvedPath.StartsWith($resolvedSource, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $relative = $resolvedPath.Substring($resolvedSource.Length).TrimStart("\")
    if ([string]::IsNullOrWhiteSpace($relative)) { return }

    $target = Join-Path $BackupDir $relative
    $targetDir = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    }

    Copy-Item -LiteralPath $resolvedPath -Destination $target -Force
}

function Remove-One {
    param([string]$Path)

    if (-not $Path) { return }
    if (Test-ExcludedPath -FullPath $Path) { return }

    $resolvedSource = (Resolve-Path -LiteralPath $Source).Path
    $normalized = $Path.Replace('/', '\')
    if (-not $normalized.StartsWith($resolvedSource, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }

    $relative = $normalized.Substring($resolvedSource.Length).TrimStart("\")
    if ([string]::IsNullOrWhiteSpace($relative)) { return }

    $target = Join-Path $BackupDir $relative
    if (Test-Path -LiteralPath $target) {
        Remove-Item -Force -LiteralPath $target
    }
}

Write-Log "Initial sync started..."
Get-ChildItem -LiteralPath $Source -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-One -Path $_.FullName
}
Write-Log "Initial sync completed."

$snapshotPath = Join-Path $BackupDir "session-snapshot.txt"
@(
    "Project: WhatsYpzck",
    "Date: $(Get-Date -Format \"yyyy-MM-dd HH:mm:ss\")",
    "Branch: $(git -C $Source rev-parse --abbrev-ref HEAD)",
    "Commit: $(git -C $Source rev-parse --short HEAD)",
    "Note: Live backup watcher active"
) | Set-Content -Path $snapshotPath -Encoding UTF8

$fsw = New-Object System.IO.FileSystemWatcher
$fsw.Path = $Source
$fsw.IncludeSubdirectories = $true
$fsw.EnableRaisingEvents = $true
$fsw.NotifyFilter = [System.IO.NotifyFilters]'FileName, LastWrite, DirectoryName, Size, CreationTime'

$onChanged = {
    param($sender, $event)
    try {
        Copy-One -Path $event.FullPath
        Write-Log "Synced: $($event.ChangeType) $($event.FullPath)"
    } catch {
        Write-Log "Sync error (changed): $($_.Exception.Message)"
    }
}

$onRenamed = {
    param($sender, $event)
    try {
        Remove-One -Path $event.OldFullPath
        Copy-One -Path $event.FullPath
        Write-Log "Synced: Renamed $($event.OldFullPath) -> $($event.FullPath)"
    } catch {
        Write-Log "Sync error (renamed): $($_.Exception.Message)"
    }
}

$onDeleted = {
    param($sender, $event)
    try {
        Remove-One -Path $event.FullPath
        Write-Log "Synced: Deleted $($event.FullPath)"
    } catch {
        Write-Log "Sync error (deleted): $($_.Exception.Message)"
    }
}

Register-ObjectEvent -InputObject $fsw -EventName Changed -Action $onChanged | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Created -Action $onChanged | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Renamed -Action $onRenamed | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Deleted -Action $onDeleted | Out-Null

Write-Log "Live backup active."
Write-Log "Source: $Source"
Write-Log "Backup: $BackupDir"
Write-Log "Press Ctrl+C to stop."

while ($true) {
    Wait-Event -Timeout 2 | Out-Null
}
