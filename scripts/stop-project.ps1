$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')
$configPath = Join-Path $projectRoot 'config\config.yaml'
$port = 8000

if (Test-Path -LiteralPath $configPath) {
    $portLine = Select-String -LiteralPath $configPath -Pattern '^\s*web_server_port\s*:\s*(\d+)' | Select-Object -First 1
    if ($portLine -and $portLine.Matches.Count -gt 0) {
        $port = [int]$portLine.Matches[0].Groups[1].Value
    }
}

if ($env:DAMUKU_PORT -match '^\d+$') {
    $port = [int]$env:DAMUKU_PORT
}

function Get-ProjectNodeProcesses {
    $result = @()
    # Read Node PIDs one by one so protected system processes do not block the query.
    foreach ($nodeProcess in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($nodeProcess.Id)" -ErrorAction SilentlyContinue
        if (-not $process) { continue }

        $commandLine = [string]$process.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) { continue }

        $normalized = $commandLine.Replace('/', '\')
        $inProject = $normalized.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
        $isEntryPoint = $normalized -match '(?i)(app|launch)\.js'
        if ($inProject -and $isEntryPoint) { $result += $process }
    }
    return $result
}

$targets = @(Get-ProjectNodeProcesses)
$portConnections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

if ($portConnections.Count -gt 0) {
    $portPids = @($portConnections | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($portPid in $portPids) {
        $process = Get-Process -Id $portPid -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -ieq 'node') {
            # Only treat the port owner as this service when it returns this project page.
            $isProjectService = $false
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/order/launcher.html" -UseBasicParsing -TimeoutSec 2
                $isProjectService = $response.StatusCode -ge 200 -and $response.StatusCode -lt 400 -and
                    $response.Content -match 'id="roomForm"|id="obsLink"'
            } catch {
                $isProjectService = $false
            }
            if ($isProjectService) {
                $targets += [pscustomobject]@{ ProcessId = $process.Id; CommandLine = '' }
            }
        }
    }
}

$targetIds = @($targets | Select-Object -ExpandProperty ProcessId -Unique | Sort-Object)
if ($targetIds.Count -eq 0) {
    Write-Host "No Damuku_music Node process found on port $port."
    exit 0
}

foreach ($targetId in $targetIds) {
    $target = Get-CimInstance Win32_Process -Filter "ProcessId = $targetId" -ErrorAction SilentlyContinue
    $label = if ($target.CommandLine -match '(?i)scripts[\\/]launch\.js') { 'launcher' } else { 'service' }
    Write-Host "Stopping $label PID $targetId and its child processes..."
    & taskkill.exe /PID $targetId /T /F | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Could not stop PID $targetId."
    }
}

Start-Sleep -Milliseconds 700
$remainingProject = @(Get-ProjectNodeProcesses)
$remainingPort = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

if ($remainingProject.Count -gt 0 -or $remainingPort.Count -gt 0) {
    Write-Error "A project process remains or port $port is still listening."
}

Write-Host "Port $port is free."
exit 0
