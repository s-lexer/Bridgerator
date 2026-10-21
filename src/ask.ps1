# Bridgerator: one question per process (when the tray helper is not running); values from BR_* env vars.
$ErrorActionPreference = 'Stop'
$specs = @(); foreach ($s in ($env:BR_BUTTONS -split '\|')) { $k, $t, $kind = $s -split '=', 3; $specs += ,@($k, $t, $kind) }
$q = @{ specs = $specs; head = $env:BR_HEAD; detail = $env:BR_DETAIL; attr = $env:BR_ATTR; host = $env:BR_HOSTNAME; auto = $(if ($env:BR_AUTOWORD) { $env:BR_AUTOWORD } else { 'auto-deny' }); secs = [int]$env:BR_SECS; tag = $env:BR_TAG; theme = $env:BR_THEME; scale = $env:BR_SCALE; shot = $env:BR_SHOT; icon = $env:BR_ICON; silent = ($env:BR_SILENT -eq '1'); lang = $env:BR_LANG }
$w = New-Object BrWait; $w.Keys = [string[]]@($specs | ForEach-Object { $_[0] })
$result = $null
try {
  if ($env:BR_FORCE_FALLBACK -or $env:BR_STYLE -eq 'popup') { throw 'compact pop-up chosen' }
  Show-AskToast $q $w
  if (-not $w.Done.WaitOne($q.secs * 1000)) { Remove-AskToast $q.tag; $result = 'deny' }
  elseif ($w.Result -eq 'failed') { throw 'the notification failed' }
  else { $result = $w.Result }
} catch {
  [Console]::Error.WriteLine("toast: $_")
  try { Initialize-Windows; $f = New-AskForm $q; [void]$f.ShowDialog(); $result = $f.Tag.pick } catch { [Console]::Error.WriteLine("fallback: $_"); $result = 'deny' }
}
[Console]::Out.Write($result)
