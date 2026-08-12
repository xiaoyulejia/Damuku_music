param(
    [switch]$ClearRuntimeCache,
    [switch]$ClearLogs,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$configPath = Join-Path $projectRoot 'config\config.yaml'
$port = 8000

if (Test-Path -LiteralPath $configPath) {
    $portLine = Select-String -LiteralPath $configPath -Pattern '^\s*web_server_port\s*:\s*(\d+)' | Select-Object -First 1
    if ($null -ne $portLine -and $portLine.Matches.Count -gt 0) {
        $port = [int]$portLine.Matches[0].Groups[1].Value
    }
}

if ($env:DAMUKU_PORT -match '^\d+$') {
    $port = [int]$env:DAMUKU_PORT
}

function Get-ProjectNodeProcesses {
    $result = @()
    $nodeProcesses = @(Get-Process -Name node -ErrorAction SilentlyContinue)
    foreach ($nodeProcess in $nodeProcesses) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($nodeProcess.Id)" -ErrorAction SilentlyContinue
        if ($null -eq $processInfo) { continue }

        $commandLine = [string]$processInfo.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }

        $normalizedCommandLine = $commandLine.Replace('/', '\')
        $projectMatch = $normalizedCommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $entryPointMatch = $normalizedCommandLine -match '(?i)(app|launch)\.js'
        if ($projectMatch -and $entryPointMatch) {
            $result += $processInfo
        }
    }
    return $result
}

function Get-ProjectPortProcesses {
    $result = @()
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        if ($null -eq $process -or $process.ProcessName -ine 'node') { continue }

        $isProjectService = $false
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/order/launcher.html" -UseBasicParsing -TimeoutSec 2
            $isProjectService = ($response.StatusCode -ge 200) -and ($response.StatusCode -lt 400) -and
                ($response.Content -match 'id="roomForm"|id="obsLink"')
        } catch {
            $isProjectService = $false
        }

        if ($isProjectService) {
            $result += [pscustomobject]@{
                ProcessId = $process.Id
                CommandLine = ''
            }
        }
    }
    return $result
}

function Remove-VerifiedDirectoryContent {
    param([string]$Directory)

    if (-not (Test-Path -LiteralPath $Directory)) { return }
    $resolved = (Resolve-Path -LiteralPath $Directory).Path.TrimEnd('\')
    $root = $projectRoot.TrimEnd('\')
    $allowedRuntime = Join-Path $root 'cache\order-sync'
    $allowedLegacyRuntime = Join-Path $root 'logs\order-sync'
    $allowedLogs = Join-Path $root 'logs'
    $isAllowed = ($resolved -ieq $allowedRuntime) -or
        ($resolved -ieq $allowedLegacyRuntime) -or
        ($resolved -ieq $allowedLogs)
    if (-not $isAllowed) {
        throw "Refusing to clean an unexpected path: $resolved"
    }

    if ($DryRun) {
        Write-Host "DRY RUN: would clean $resolved"
        return
    }

    Get-ChildItem -LiteralPath $resolved -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force
    Write-Host "Cleaned: $resolved"
}

$targets = @(Get-ProjectNodeProcesses)
$targets += @(Get-ProjectPortProcesses)
$targetIds = @($targets | Select-Object -ExpandProperty ProcessId -Unique | Sort-Object)

if ($targetIds.Count -eq 0) {
    Write-Host "No Damuku_music Node process found on port $port."
} else {
    foreach ($targetId in $targetIds) {
        $target = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId" -ErrorAction SilentlyContinue
        $label = 'service'
        if ($null -ne $target -and ([string]$target.CommandLine -match '(?i)scripts[\\/]launch\.js')) {
            $label = 'launcher'
        }
        Write-Host "Stopping $label PID $targetId and child processes..."
        if (-not $DryRun) {
            & taskkill.exe /PID $targetId /T /F | Out-Host
            if ($LASTEXITCODE -ne 0) {
                throw "Could not stop PID $targetId."
            }
        }
    }
}

if (-not $DryRun) {
    Start-Sleep -Milliseconds 700
    $remainingProject = @(Get-ProjectNodeProcesses)
    $remainingPort = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if (($remainingProject.Count -gt 0) -or ($remainingPort.Count -gt 0)) {
        throw "A project process remains or port $port is still listening."
    }
}

Write-Host "Port $port is free."

if (-not $ClearRuntimeCache -and -not $ClearLogs -and -not $DryRun) {
    Write-Host ''
    Write-Host 'Clean local runtime cache?'
    Write-Host '[1] Keep everything (default)'
    Write-Host '[2] Clean queue, playback state and command cache'
    Write-Host '[3] Option 2 plus ordinary logs'
    $choice = Read-Host 'Choose 1, 2 or 3'
    if ($choice -eq '2') { $ClearRuntimeCache = $true }
    if ($choice -eq '3') {
        $ClearRuntimeCache = $true
        $ClearLogs = $true
    }
}

if ($ClearRuntimeCache) {
    Remove-VerifiedDirectoryContent (Join-Path $projectRoot 'cache\order-sync')
    $legacySyncPath = Join-Path $projectRoot 'logs\order-sync'
    if (Test-Path -LiteralPath $legacySyncPath) {
        Remove-VerifiedDirectoryContent $legacySyncPath
    }
}

if ($ClearLogs) {
    $logsPath = Join-Path $projectRoot 'logs'
    if (Test-Path -LiteralPath $logsPath) {
        if ($DryRun) {
            Write-Host "DRY RUN: would clean ordinary logs in $logsPath"
        } else {
            Get-ChildItem -LiteralPath $logsPath -Force |
                Where-Object { $_.Name -ne 'order-sync' } |
                Remove-Item -Recurse -Force
            Write-Host "Cleaned ordinary logs: $logsPath"
        }
    }
}

Write-Host 'Netease login state was kept. Settings, history, credentials and config were not removed.'
exit 0
