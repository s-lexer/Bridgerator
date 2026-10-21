# Bridgerator PC check (read-only). Input: BRX_PARTS (comma list: disks,events,startup,drivers,updates,load),
# BRX_DAYS (event log days), BRX_PENDING (1 = ask Windows Update for pending updates, slow).
# Output: ONE JSON line. Every part is caught on its own: a failed part is { error } (NOT CHECKED), not a failed run.
# Values are read as numbers / ids / registry data, never as localized label text.
$parts = @(($env:BRX_PARTS -split ',') | Where-Object { $_ })
$days = 3; [int]::TryParse([string]$env:BRX_DAYS, [ref]$days) | Out-Null
if ($days -lt 1 -or $days -gt 30) { $days = 3 }
$out = [ordered]@{}
function Cut([string]$s, [int]$n) { if ($null -eq $s) { return '' }; $s = ($s -replace '\s+', ' ').Trim(); if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }; return $s }
function Part([string]$name, [scriptblock]$body) {
  if ($parts -notcontains $name) { return }
  try { $out[$name] = & $body } catch { $out[$name] = @{ error = (Cut $_.Exception.Message 200) } }
}

Part 'disks' {
  $vol = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop | ForEach-Object {
    @{ drive = [string]$_.DeviceID; label = [string]$_.VolumeName; fs = [string]$_.FileSystem; size = [int64]$_.Size; free = [int64]$_.FreeSpace }
  })
  $phys = $null
  try {
    $phys = @(Get-CimInstance -Namespace 'root/Microsoft/Windows/Storage' -ClassName MSFT_PhysicalDisk -ErrorAction Stop | ForEach-Object {
      @{ name = [string]$_.FriendlyName; media = [int]$_.MediaType; bus = [int]$_.BusType; health = [int]$_.HealthStatus; status = @($_.OperationalStatus | ForEach-Object { [int]$_ }); size = [int64]$_.Size }
    })
  } catch { $phys = @{ error = (Cut $_.Exception.Message 160) } }
  @{ volumes = $vol; physical = $phys }
}

Part 'events' {
  $since = (Get-Date).AddDays(-$days)
  $ev = @()
  foreach ($log in 'System', 'Application') {
    try { $ev += @(Get-WinEvent -FilterHashtable @{ LogName = $log; Level = 1, 2; StartTime = $since } -MaxEvents 3000 -ErrorAction Stop) }
    catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
  }
  $groups = @($ev | Group-Object { "$($_.LogName)|$($_.ProviderName)|$($_.Id)" } | Sort-Object Count -Descending | Select-Object -First 15 | ForEach-Object {
    $last = $_.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1
    $msg = ''; try { $msg = $last.Message } catch {}
    @{ log = [string]$last.LogName; source = [string]$last.ProviderName; id = [int]$last.Id; level = [int]$last.Level; count = [int]$_.Count; last = $last.TimeCreated.ToString('o'); message = (Cut $msg 220) }
  })
  # Kernel-Power 41 (turned off unexpectedly) is counted over ALL events, not only the 15 most frequent groups.
  $kp = @($ev | Where-Object { $_.Id -eq 41 -and [string]$_.ProviderName -eq 'Microsoft-Windows-Kernel-Power' }).Count
  @{ days = $days; total = $ev.Count; critical = @($ev | Where-Object { $_.Level -eq 1 }).Count; kernelPower = $kp; groups = $groups }
}

Part 'startup' {
  $approved = @{}
  foreach ($k in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder') {
    try { $p = Get-ItemProperty $k -ErrorAction Stop; foreach ($n in $p.PSObject.Properties) { if ($n.Value -is [byte[]] -and $n.Value.Length -gt 0) { $approved[$n.Name] = ($n.Value[0] % 2 -eq 0) } } } catch {}
  }
  ,@(Get-CimInstance Win32_StartupCommand -ErrorAction Stop | ForEach-Object {
    $name = [string]$_.Name; $en = $true
    foreach ($key in @($name, [string]$_.Caption, ([string]$_.Command -split '\\')[-1])) { if ($approved.ContainsKey($key)) { $en = $approved[$key]; break } }
    @{ name = $name; command = (Cut ([string]$_.Command) 200); location = [string]$_.Location; user = [string]$_.User; enabled = $en }
  })
}

Part 'drivers' {
  ,@(Get-CimInstance Win32_PnPEntity -Filter 'ConfigManagerErrorCode<>0' -ErrorAction Stop | Select-Object -First 50 | ForEach-Object {
    @{ name = [string]$_.Name; class = [string]$_.PNPClass; code = [int]$_.ConfigManagerErrorCode; id = (Cut ([string]$_.PNPDeviceID) 120) }
  })
}

# Win32_QuickFixEngineering.InstalledOn is a string in the PC's own date format (15.10.2026, 10/15/2026)
# or a hex FILETIME on some updates: M/d/yyyy (slashes) is read invariant first, other forms with the
# current culture first; unreadable = skipped.
function To-Date($v) {
  $s = ([string]$v).Trim()
  if (-not $s) { return $null }
  if ($s -match '^[0-9A-Fa-f]{16}$') { try { return [DateTime]::FromFileTimeUtc([Convert]::ToInt64($s, 16)) } catch { return $null } }
  $d = [datetime]::MinValue
  $order = @([Globalization.CultureInfo]::CurrentCulture, [Globalization.CultureInfo]::InvariantCulture)
  if ($s.Contains('/')) { [array]::Reverse($order) }
  foreach ($c in $order) {
    if ([datetime]::TryParse($s, $c, [Globalization.DateTimeStyles]::None, [ref]$d)) { return $d }
  }
  return $null
}
Part 'updates' {
  $hot = @(Get-CimInstance Win32_QuickFixEngineering -ErrorAction Stop | ForEach-Object { $d = To-Date $_.InstalledOn; if ($d) { @{ id = [string]$_.HotFixID; on = $d } } } | Sort-Object { $_.on } -Descending | Select-Object -First 5 | ForEach-Object {
    @{ id = $_.id; installed = $_.on.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
  })
  $reboot = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
  $pending = $null
  if ($env:BRX_PENDING -eq '1') {
    try {
      $s = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
      $r = $s.Search('IsInstalled=0 and IsHidden=0 and Type=''Software''')
      $pending = @($r.Updates | Select-Object -First 30 | ForEach-Object { @{ title = (Cut ([string]$_.Title) 160); kb = (@($_.KBArticleIDs) -join ','); mb = [math]::Round($_.MaxDownloadSize / 1MB) } })
    } catch { $pending = @{ error = (Cut $_.Exception.Message 160) } }
  }
  @{ recent = $hot; rebootPending = [bool]$reboot; pending = $pending }
}

Part 'load' {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $cpu = @(Get-CimInstance Win32_Processor -ErrorAction Stop)
  $load = ($cpu | Measure-Object -Property LoadPercentage -Average).Average
  $top = @(Get-Process -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 | ForEach-Object { @{ name = [string]$_.ProcessName; mb = [math]::Round($_.WorkingSet64 / 1MB); cpuSec = [math]::Round([double]$_.CPU) } })
  $topCpu = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.CPU } | Sort-Object CPU -Descending | Select-Object -First 6 | ForEach-Object { @{ name = [string]$_.ProcessName; mb = [math]::Round($_.WorkingSet64 / 1MB); cpuSec = [math]::Round([double]$_.CPU) } })
  @{ os = [string]$os.Caption; build = [string]$os.BuildNumber; bootedAt = $os.LastBootUpTime.ToString('o'); memTotalMb = [math]::Round($os.TotalVisibleMemorySize / 1KB); memFreeMb = [math]::Round($os.FreePhysicalMemory / 1KB); cpuLoad = $load; cpu = [string]$cpu[0].Name; cores = [int](($cpu | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum); topMemory = $top; topCpu = $topCpu }
}

$out | ConvertTo-Json -Compress -Depth 6
