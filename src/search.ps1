# LOGIC: see critical-logic/bridge.md ("Extra tools" / fast_search). Instant search sources for the
# bridge (search-tool.mjs builds every query; this script only runs it).
# In (env): BRX_MODE = status | everything | index; BRX_ES (es.exe path), BRX_ARGS (base64 UTF-8 JSON
# array of es.exe arguments), BRX_SQL (base64 UTF-8 SystemIndex query), BRX_SCOPE_SQL (status: the
# coverage query, optional), BRX_ES_WAIT (ms es.exe may run, default 20000). Out: ONE JSON line. Errors are codes, never localized message text.
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 5)) }
function From-B64($s) { if (-not $s) { return '' }; [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }

# es.exe runs only from a place a standard user cannot write (Program Files, Windows) or when it is
# signed by voidtools: a planted es.exe on the PATH / in a user folder never runs.
function Test-TrustedEs([string]$p) {
  if (-not $p -or -not (Test-Path -LiteralPath $p -PathType Leaf)) { return $false }
  $full = [IO.Path]::GetFullPath($p)
  foreach ($d in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($d -and $full.StartsWith(([IO.Path]::GetFullPath($d).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  # Windows itself: only the folder and System32 (subfolders like Temp are writable by users).
  $parent = [IO.Path]::GetDirectoryName($full)
  if ($env:SystemRoot -and @($env:SystemRoot, (Join-Path $env:SystemRoot 'System32')) -contains $parent) { return $true }
  try {
    $sig = Get-AuthenticodeSignature -LiteralPath $full
    return ($sig.Status -eq 'Valid' -and [string]$sig.SignerCertificate.Subject -match '(^|,\s*)(CN|O)=voidtools(,|$)')
  } catch { return $false }
}
function Find-Es {
  $found = $null
  $cands = @(Get-Command es.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  foreach ($d in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, (Join-Path $env:LOCALAPPDATA 'Programs'))) { if ($d) { $cands += (Join-Path $d 'Everything\es.exe') } }
  foreach ($p in $cands) {
    if (-not $p -or -not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
    if (Test-TrustedEs $p) { return @{ path = $p } }
    if (-not $found) { $found = $p }
  }
  return @{ path = $null; untrusted = $found }
}
# One Windows command-line argument (words carry no quotes: search-tool.mjs strips them). Quoted, a
# trailing \ is doubled: "C:\My Files\" would end in \" (a literal quote) and swallow the next arguments.
function Quote-Arg([string]$a) { if ($a -match '[\s"]' -or -not $a) { return '"' + (($a -replace '"', '') -replace '(\\+)$', '$1$1') + '"' }; return $a }

function Invoke-Index($sql) {
  $conn = $null; $rs = $null
  try {
    $conn = New-Object -ComObject ADODB.Connection
    $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
    $rs = New-Object -ComObject ADODB.Recordset
    $rs.Open($sql, $conn)
    $items = New-Object System.Collections.ArrayList
    while (-not $rs.EOF) {
      $url = [string]$rs.Fields.Item('System.ItemUrl').Value
      $size = $rs.Fields.Item('System.Size').Value
      $mod = $rs.Fields.Item('System.DateModified').Value
      $o = @{ url = $url }
      if ($size -ne $null -and $size -isnot [DBNull]) { $o.size = [int64]$size }
      if ($mod -is [DateTime]) { $o.modified = $mod.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }
      [void]$items.Add($o)
      $rs.MoveNext()
    }
    return @{ items = @($items) }
  } catch {
    return @{ error = 'INDEX_UNAVAILABLE'; hresult = ('0x{0:X8}' -f $_.Exception.HResult) }
  } finally {
    if ($rs) { try { $rs.Close() } catch { } }
    if ($conn) { try { $conn.Close() } catch { } }
  }
}

$mode = $env:BRX_MODE
if ($mode -eq 'status') {
  $es = Find-Es
  $running = [bool](Get-Process -Name 'Everything', 'Everything64' -ErrorAction SilentlyContinue)
  $svc = Get-Service -Name WSearch -ErrorAction SilentlyContinue
  $state = if ($svc) { [string]$svc.Status } else { 'Missing' }
  $covered = $null
  $scopeSql = From-B64 $env:BRX_SCOPE_SQL
  if ($scopeSql -and $state -eq 'Running') {
    $r = Invoke-Index $scopeSql
    $covered = if ($r.error) { $null } else { $r.items.Count -gt 0 }
  }
  Out-Json @{ everything = @{ path = $es.path; untrusted = [bool]$es.untrusted; running = $running }; index = @{ service = $state; covered = $covered } }
  exit 0
}
if ($mode -eq 'everything') {
  $es = $env:BRX_ES
  if (-not $es -or -not (Test-Path -LiteralPath $es)) { Out-Json @{ error = 'ES_MISSING' }; exit 0 }
  # Held open (others may only read) from the trust check until it has started: it can't be swapped in between.
  $hold = $null; try { $hold = [IO.File]::Open($es, 'Open', 'Read', 'Read') } catch { Out-Json @{ error = 'ES_START_FAILED' }; exit 0 }
  if (-not (Test-TrustedEs $es)) { $hold.Dispose(); Out-Json @{ error = 'ES_UNTRUSTED' }; exit 0 }
  # PowerShell 5.1 ConvertFrom-Json emits an array as ONE object: enumerate it into separate arguments.
  $argv = @((From-B64 $env:BRX_ARGS) | ConvertFrom-Json | ForEach-Object { $_ })
  # The export file lives in our own cache folder (not TEMP); es.exe is stopped when it takes too long.
  $dir = Join-Path $env:LOCALAPPDATA 'Bridgerator\cache'
  [void][IO.Directory]::CreateDirectory($dir)
  $tmp = Join-Path $dir ('es-' + [guid]::NewGuid().ToString('N') + '.efu')
  $wait = 20000; $w = 0; if ([int]::TryParse([string]$env:BRX_ES_WAIT, [ref]$w) -and $w -gt 0) { $wait = $w }
  $proc = $null
  try {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $es
    $psi.Arguments = ((@($argv) + @('-export-efu', $tmp)) | ForEach-Object { Quote-Arg ([string]$_) }) -join ' '
    # Its own pipes (our stdout stays the one JSON line for the bridge), both drained at once: a full pipe
    # (usage / error text) would block es.exe until the kill.
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    try { $proc = [Diagnostics.Process]::Start($psi) } catch { Out-Json @{ error = 'ES_START_FAILED' }; exit 0 } finally { $hold.Dispose() }
    [void]$proc.StandardOutput.ReadToEndAsync(); [void]$proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($wait)) { try { $proc.Kill() } catch { }; [void]$proc.WaitForExit(5000); Out-Json @{ error = 'ES_TIMEOUT' }; exit 0 }
    $code = $proc.ExitCode
    if ($code -ne 0) { Out-Json @{ error = ('ES_EXIT_' + $code) }; exit 0 }
    $items = New-Object System.Collections.ArrayList
    if (Test-Path -LiteralPath $tmp) {
      foreach ($row in (Import-Csv -LiteralPath $tmp -Encoding UTF8)) {
        $o = @{ path = [string]$row.Filename }
        $s = 0L; if ([int64]::TryParse([string]$row.Size, [ref]$s)) { $o.size = $s }
        $ft = 0L; if ([int64]::TryParse([string]$row.'Date Modified', [ref]$ft) -and $ft -gt 0) { $o.modified = [DateTime]::FromFileTimeUtc($ft).ToString('yyyy-MM-ddTHH:mm:ssZ') }
        $a = 0; if ([int]::TryParse([string]$row.Attributes, [ref]$a)) { $o.dir = [bool]($a -band 16) }
        [void]$items.Add($o)
      }
    }
    Out-Json @{ items = @($items) }
  } finally {
    if ($proc) { try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }; $proc.Dispose() }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  exit 0
}
if ($mode -eq 'index') {
  Out-Json (Invoke-Index (From-B64 $env:BRX_SQL))
  exit 0
}
Out-Json @{ error = 'BAD_MODE' }
