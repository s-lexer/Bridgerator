# Bridgerator installer for Windows (PowerShell 5.1+). Source: https://github.com/s-lexer/bridgerator
# Usage (one line, from your Bridgerator account page):
#   & ([scriptblock]::Create((irm https://bridgerator.recondeck.com/install.ps1))) -Token <device key>
# What it does: installs Node.js LTS if missing (portable zip, no admin), installs the bridgerator npm package,
# then runs `bridgerator setup` (config + hidden autostart at logon for THIS user, no admin rights),
# then opens the welcome page in the default browser (skip with -NoBrowser).
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$Package = 'https://bridgerator.recondeck.com/bridgerator.tgz',
  [string[]]$Allow,
  [string[]]$Deny,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

# No winget on many clean Windows installs: take the official Node.js LTS zip into the user's
# profile (no admin rights), checked against nodejs.org SHASUMS256, and put it on the user PATH.
function Install-PortableNode {
  $dir = Join-Path $env:LOCALAPPDATA 'Bridgerator\node'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $rel = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
  if (-not $rel) { throw 'Could not find a Node.js LTS build. Install Node.js 20+ from https://nodejs.org and run this again.' }
  $name = "node-$($rel.version)-win-$arch"
  Write-Host "Node.js not found - downloading Node.js $($rel.version) into $dir ..."
  $tmp = Join-Path $env:TEMP "bridgerator-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp "$name.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$($rel.version)/$name.zip" -OutFile $zip -UseBasicParsing
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$($rel.version)/SHASUMS256.txt" -UseBasicParsing).Content
    $want = ($sums -split "`n" | Where-Object { $_ -match "\s$name\.zip$" }) -replace '\s.*$', ''
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash
    if (-not $want -or $got -ne $want.Trim().ToUpper()) { throw 'Node.js download failed the checksum check.' }
    Write-Host 'Node.js checksum OK (SHA256, nodejs.org)'
    Expand-Archive $zip -DestinationPath $tmp -Force
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $dir) -Force | Out-Null
    Move-Item (Join-Path $tmp $name) $dir
  } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', (@($dir, $userPath) | Where-Object { $_ }) -join ';', 'User') }
  Refresh-Path
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Install-PortableNode }
$major = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20+ required, found $(& node -v). Update from https://nodejs.org" }

# The engine's PDF export brings puppeteer, whose postinstall downloads Chrome (~700 MB);
# skipped here, PDF export fetches a browser itself the first time it is used.
$env:PUPPETEER_SKIP_DOWNLOAD = '1'
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

# Next steps (connect ChatGPT, example prompts) on the welcome page; skipped for -NoBrowser and
# non-interactive sessions (scheduled tasks, remote shells). Never fails the install.
$welcome = 'https://bridgerator.recondeck.com/welcome/'
if (-not $NoBrowser -and [Environment]::UserInteractive) {
  try { Start-Process $welcome } catch { Write-Host "Next steps: $welcome" }
} else {
  Write-Host "Next steps: $welcome"
}
