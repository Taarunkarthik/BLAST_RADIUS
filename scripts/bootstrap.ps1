#Requires -Version 5.1
<#
.SYNOPSIS
    One-command, idempotent BlastRadius setup for Windows.

.DESCRIPTION
    Creates .venv when it is missing, installs BlastRadius with the requested
    extras, and installs the pinned parser runtime. Run it again at any time;
    it converges on the same result.

.PARAMETER Extras
    Optional-dependency extras to install. Defaults to "harness". Pass an empty
    string to install the base package only, or a comma-separated list such as
    "harness,postgres".

.EXAMPLE
    .\scripts\bootstrap.ps1

.EXAMPLE
    .\scripts\bootstrap.ps1 -Extras "harness,postgres"
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Extras = "harness"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail([string]$Message) {
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

$pythonCommand = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCommand) {
    Fail "Python 3.11+ is required but 'python' was not found on PATH. Install it from https://www.python.org/downloads/ and reopen the terminal."
}

$pythonVersion = (& python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
if ($LASTEXITCODE -ne 0 -or -not $pythonVersion) {
    Fail "Python could not be run. Repair your Python installation and reopen the terminal."
}
if ([version]$pythonVersion -lt [version]"3.11") {
    Fail "Python $pythonVersion was found, but BlastRadius needs Python 3.11 or newer. Install a newer Python from https://www.python.org/downloads/."
}

$venvPython = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "Creating .venv ..."
    & python -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Fail "Could not create .venv. Delete any partial .venv directory and try again."
    }
}
if (-not (Test-Path $venvPython)) {
    Fail "The .venv directory exists but $venvPython is missing. Delete .venv and run this script again."
}

if ([string]::IsNullOrWhiteSpace($Extras)) {
    $target = "."
} else {
    $target = ".[$Extras]"
}
Write-Host "Installing BlastRadius ($target) ..."
& $venvPython -m pip install --disable-pip-version-check -e $target
if ($LASTEXITCODE -ne 0) {
    Fail "Dependency installation failed. Check your network connection and try again."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    Fail "Node.js 20+ is required but 'node' was not found on PATH. Install it from https://nodejs.org and reopen the terminal."
}
$nodeVersion = (& node --version).Trim().TrimStart("v", "V")
$nodeMajor = 0
if ($nodeVersion -match "^(\d+)") {
    $nodeMajor = [int]$Matches[1]
}
if ($nodeMajor -lt 20) {
    Fail "Node.js $nodeVersion was found, but BlastRadius needs Node.js 20 or newer. Install it from https://nodejs.org."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail "npm is required but was not found on PATH. Reinstall Node.js 20+ (npm is bundled) and reopen the terminal."
}

Write-Host "Installing the pinned parser runtime ..."
& $venvPython -m blastradius setup
if ($LASTEXITCODE -ne 0) {
    Fail "Parser setup failed. Run 'blastradius doctor' for details."
}

Write-Host ""
Write-Host "BlastRadius is ready." -ForegroundColor Green
Write-Host "Next: .\.venv\Scripts\blastradius.exe scan --path examples/demo"
Write-Host "UI:   .\.venv\Scripts\blastradius.exe harness --path ."
