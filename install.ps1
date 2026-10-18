# Bridgerator installer for Windows (PowerShell 5.1+). Source: https://github.com/recondeck/bridgerator
# Usage (one line, from your Bridgerator account page):
#   & ([scriptblock]::Create((irm https://bridgerator.recondeck.com/install.ps1))) -Token <device key>
# What it does: installs Node.js LTS if missing (winget), installs the bridgerator npm package,
# then runs `bridgerator setup` (config + hidden autostart at logon for THIS user, no admin rights).
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Package = 'https://bridgerator.recondeck.com/bridgerator.tgz',
  [string[]]$Allow,
  [string[]]$Deny
)
$ErrorActionPreference = 'Stop'

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js not found - installing Node.js LTS via winget...'
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw 'winget is not available. Install Node.js 20+ from https://nodejs.org and run this again.' }
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js installed but not on PATH yet. Open a new PowerShell window and run this again.' }
}
$major = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20+ required, found $(& node -v). Update from https://nodejs.org" }

Write-Host "Installing bridgerator from $Package ..."
& npm install -g $Package --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
Refresh-Path

$setupArgs = @('setup', '--token', $Token)
foreach ($a in $Allow) { $setupArgs += @('--allow', $a) }
foreach ($d in $Deny) { $setupArgs += @('--deny', $d) }
& bridgerator @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'bridgerator setup failed' }
Write-Host 'Done. Check with: bridgerator status'
