param(
    [int]$BackendPort = 5000,
    [int]$FrontendPort = 5173,
    [int]$BackendTimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

function Write-Step {
    param([string]$Message)
    Write-Host "[Aviator] $Message" -ForegroundColor Cyan
}

function Start-InNewTerminal {
    param(
        [string]$Title,
        [string]$Command
    )

    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Command))
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-EncodedCommand",
        $encoded
    ) | Out-Null

    Write-Step "Started: $Title"
}

$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    $pythonCmd = "& '$venvPython'"
} else {
    $pythonCmd = "python"
}

$backendCommand = @"
Set-Location '$repoRoot'
$pythonCmd server.py
"@

$frontendCommand = @"
Set-Location '$repoRoot'
npm run dev
"@

Write-Step "Launching backend terminal..."
Start-InNewTerminal -Title "Flask Backend" -Command $backendCommand

Write-Step "Waiting for backend health endpoint..."
$backendUrl = "http://127.0.0.1:$BackendPort/ping"
$deadline = (Get-Date).AddSeconds($BackendTimeoutSeconds)
$backendReady = $false

while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-RestMethod -Uri $backendUrl -Method Get -TimeoutSec 2
        if ($null -ne $resp) {
            $backendReady = $true
            break
        }
    } catch {
        Start-Sleep -Milliseconds 600
    }
}

if (-not $backendReady) {
    Write-Host "[Aviator] Backend did not answer /ping within $BackendTimeoutSeconds seconds." -ForegroundColor Yellow
    Write-Host "[Aviator] Frontend terminal will still be started so you can inspect logs." -ForegroundColor Yellow
} else {
    Write-Step "Backend is healthy on $backendUrl"
}

Write-Step "Launching frontend terminal..."
Start-InNewTerminal -Title "Vite Frontend" -Command $frontendCommand

$dashboardUrl = "http://127.0.0.1:$FrontendPort"
Write-Step "Opening dashboard: $dashboardUrl"
Start-Process $dashboardUrl | Out-Null

Write-Host "[Aviator] Startup sequence complete." -ForegroundColor Green
Write-Host "[Aviator] If telemetry is missing: reload extension, verify Tampermonkey enabled, then refresh game tab." -ForegroundColor DarkYellow
