# Bridgerator: the question on the PC (toast / fallback window). Shared by ask.ps1 (one question per
# process) and the tray helper. Loaded as text into a scriptblock (not subject to the execution policy).
function X([string]$s) { [Security.SecurityElement]::Escape($s) }
# $q (one question): specs = @(@(key, label, kind)...), head, detail, attr, host, auto, secs, tag, theme, scale, shot, lang (en | ru)

# Compiled C# helpers are cached in %LOCALAPPDATA%\Bridgerator\cache\<hash of the code>.dll and
# loaded from there (compiling on every start costs ~1 s). A failed cache falls back to compiling.
function Add-CachedType([string]$code, [string[]]$refs = @()) {
  try {
    $dir = Join-Path $env:LOCALAPPDATA 'Bridgerator\cache'
    $bytes = [Text.Encoding]::UTF8.GetBytes("$code|$($refs -join ',')|$($PSVersionTable.CLRVersion)")
    $key = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)[0..11] | ForEach-Object { $_.ToString('x2') })
    $dll = Join-Path $dir "br-$key.dll"
    if (-not [IO.File]::Exists($dll)) {
      [void][IO.Directory]::CreateDirectory($dir)
      $tmp = Join-Path $dir "br-$key.$PID.dll"
      if ($refs.Count) { Add-Type -TypeDefinition $code -ReferencedAssemblies $refs -OutputAssembly $tmp -OutputType Library } else { Add-Type -TypeDefinition $code -OutputAssembly $tmp -OutputType Library }
      # Another process compiled the same code first: use its file, remove ours (not loaded yet).
      try { [IO.File]::Move($tmp, $dll) } catch { if ([IO.File]::Exists($dll)) { try { [IO.File]::Delete($tmp) } catch { } } else { $dll = $tmp } }
    }
    Add-Type -Path $dll
  } catch {
    if ($refs.Count) { Add-Type -TypeDefinition $code -ReferencedAssemblies $refs } else { Add-Type -TypeDefinition $code }
  }
}

# Event sink in C#: PowerShell 5.1 can't subscribe to WinRT events itself (Register-ObjectEvent
# refuses), but a compiled delegate can. Finish() runs once: by a click, a dismissal or the timeout.
# With Report set (tray helper) the answer goes straight to stdout as a JSON line.
Add-CachedType @'
using System; using System.Threading; using System.Text.RegularExpressions;
public static class BrIO {
  static readonly object L = new object();
  public static void Send(string line) { lock (L) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
}
public class BrWait {
  public string Id; public string[] Keys = new string[0]; public bool Report; public string Result; public string FailCode; public ManualResetEvent Done = new ManualResetEvent(false);
  readonly object l = new object(); bool over;
  public bool Finish(string key) {
    lock (l) { if (over) return false; over = true; }
    Result = Array.IndexOf(Keys, key) >= 0 ? key : (key == "failed" ? "failed" : "deny");
    if (Report && Result != "failed" && Regex.IsMatch(Id ?? "", "^[A-Za-z0-9-]{1,40}$")) BrIO.Send("{\"t\":\"answer\",\"id\":\"" + Id + "\",\"key\":\"" + Result + "\"}");
    Done.Set(); return true;
  }
  public bool IsOver { get { lock (l) return over; } }
  public void OnActivated(object s, object a) { var p = a == null ? null : a.GetType().GetProperty("Arguments"); Finish(p == null ? "" : (string)p.GetValue(a, null)); }
  public void OnDismissed(object s, object a) { var p = a == null ? null : a.GetType().GetProperty("Reason"); if (p != null && p.GetValue(a, null).ToString() == "UserCanceled") Finish("deny"); }
  public void OnFailed(object s, object a) { try { var p = a == null ? null : a.GetType().GetProperty("ErrorCode"); var e = p == null ? null : p.GetValue(a, null) as Exception; if (e != null) FailCode = "0x" + e.HResult.ToString("X8"); } catch {} Finish("failed"); }
}
'@

# The Bridgerator logo "Arc" (assets/logo.svg, 64x64): blue rounded square, white arc, a white and a
# cyan dot. Small sizes (<= 24 px) get a pixel-snapped variant: stroke and dots at least 2 px.
function New-LogoBitmap([int]$size) {
  Add-Type -AssemblyName System.Drawing
  $bm = New-Object Drawing.Bitmap $size, $size
  $g = [Drawing.Graphics]::FromImage($bm); $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $k = $size / 64.0
  $r = 15 * $k * 2; $w = [single]$size
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $p.AddArc(0, 0, $r, $r, 180, 90); $p.AddArc($w - $r, 0, $r, $r, 270, 90); $p.AddArc($w - $r, $w - $r, $r, $r, 0, 90); $p.AddArc(0, $w - $r, $r, $r, 90, 90); $p.CloseFigure()
  $g.FillPath((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#2251E6'))), $p)
  $small = $size -le 24
  $sw = if ($small) { [Math]::Max(2, [Math]::Round(5.5 * $k)) } else { 5.5 * $k }
  $dr = if ($small) { [Math]::Max(2, [Math]::Round(6.5 * $k * 2) / 2) } else { 6.5 * $k }
  $snap = { param($v) if ($small) { [Math]::Round($v * 2) / 2 } else { $v } }
  $x1 = & $snap (17 * $k); $x2 = & $snap (47 * $k); $y = & $snap (42 * $k); $cy = & $snap (44 * $k)
  $pen = New-Object Drawing.Pen ([Drawing.Color]::White), $sw; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  # Quadratic M17 42 Q32 12 47 42 as a cubic: control points 2/3 of the way to (32,12).
  $g.DrawBezier($pen, $x1, $y, (27 * $k), (22 * $k), (37 * $k), (22 * $k), $x2, $y)
  $g.FillEllipse([Drawing.Brushes]::White, ($x1 - $dr), ($cy - $dr), (2 * $dr), (2 * $dr))
  $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#7fe0ff'))), ($x2 - $dr), ($cy - $dr), (2 * $dr), (2 * $dr))
  $g.Dispose(); return $bm
}

# The process is started hidden (windowsHide): Windows applies that to the FIRST window shown by the
# process. Spend it on an invisible throwaway form so our real windows show normally.
function Initialize-Windows {
  Add-Type -AssemblyName System.Windows.Forms
  $d = New-Object Windows.Forms.Form; $d.ShowInTaskbar = $false; $d.Opacity = 0; $d.Size = New-Object Drawing.Size(1, 1); $d.StartPosition = 'Manual'; $d.Location = New-Object Drawing.Point(-2000, -2000)
  $d.Show(); $d.Close(); $d.Dispose()
}

# Our app id under HKCU (no admin): the notification header reads "Bridgerator" with our icon.
function Register-AppId([string]$icon) {
  $k = 'HKCU:\Software\Classes\AppUserModelId\Bridgerator'
  if (-not (Test-Path $k)) { New-Item $k -Force | Out-Null }
  New-ItemProperty $k -Name DisplayName -Value 'Bridgerator' -Force | Out-Null
  if ($icon -and (Test-Path $icon)) { New-ItemProperty $k -Name IconUri -Value $icon -Force | Out-Null }
}

# Shows the toast; the answer arrives in $w (BrWait). Throws when our notifications are off.
function Show-AskToast($q, $w) {
  Register-AppId $q.icon
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
  $n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Bridgerator')
  # Only an explicit Disabled* value means off: Windows 10 (PowerShell 5.1) can return no value at all (VM 21.10).
  if ([string]$n.Setting -like 'Disabled*') { throw "notifications for Bridgerator are off ($($n.Setting))" }
  # Three buttons fit on one line; "Allow always" goes to the toast's "..." / right-click menu.
  $btns = ($q.specs | ForEach-Object {
    $extra = if ($_[2] -eq 'deny') { " hint-buttonStyle='Critical'" } elseif ($_[0] -eq 'always') { " placement='contextMenu'" } else { '' }
    $label = if ($_[0] -eq 'always') { "$($_[1]) $(if ($q.lang -eq 'ru') { '(больше не спрашивать)' } else { '(stop asking for this)' })" } else { $_[1] }
    "<action content='$(X $label)' arguments='$(X $_[0])' activationType='foreground'$extra/>" }) -join ''
  $logo = if ($q.icon -and (Test-Path $q.icon)) { "<image placement='appLogoOverride' src='$(X ([Uri]$q.icon).AbsoluteUri)'/>" } else { '' }
  $audio = if ($q.silent) { "<audio silent='true'/>" } else { "<audio src='ms-winsoundevent:Notification.Default'/>" }
  $xml = "<toast scenario='reminder' useButtonStyle='true' activationType='foreground' launch='open'><visual><binding template='ToastGeneric'>$logo<text>$(X $q.head)</text><text>$(X $q.detail)</text><text placement='attribution'>$(X $q.attr)</text></binding></visual><actions>$btns</actions>$audio</toast>"
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($xml)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc); $toast.Tag = $q.tag; $toast.Group = 'bridgerator'
  foreach ($ev in 'Activated', 'Dismissed', 'Failed') {
    $h = [Delegate]::CreateDelegate($toast.GetType().GetEvent($ev).EventHandlerType, $w, $w.GetType().GetMethod("On$ev"))
    [void]$toast."add_$ev"($h)
  }
  $n.Show($toast)
}
function Remove-AskToast($tag) { try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, 'bridgerator', 'Bridgerator') } catch {} }

# Fallback: Windows 11 notification metrics (logical px x DPI scale), bottom-right above the taskbar.
function New-AskForm($q) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $f = $null
  try {
    Add-CachedType -refs System.Windows.Forms, System.Drawing -code @'
using System; using System.Windows.Forms; using System.Runtime.InteropServices;
// Only real input clicks: a click injected by a program (SendInput) or an accessibility "Invoke" /
// BM_CLICK never counts (GetCurrentInputMessageSource must say: hardware).
public class BrRealButton : Button {
  [StructLayout(LayoutKind.Sequential)] struct IMS { public int deviceType; public int originId; }
  [DllImport("user32.dll")] static extern bool GetCurrentInputMessageSource(out IMS s);
  bool real;
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x0202 || m.Msg == 0x0101) { IMS s; real = GetCurrentInputMessageSource(out s) && s.originId == 1; }
    base.WndProc(ref m);
  }
  protected override void OnClick(EventArgs e) { if (!real) return; real = false; base.OnClick(e); }
}
public class BrToastForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000008; return p; } }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
    [void][BrToastForm]::SetProcessDPIAware()
    $f = New-Object BrToastForm
  } catch { $f = New-Object Windows.Forms.Form }
  [Windows.Forms.Application]::EnableVisualStyles()
  $dark = $false
  try { $dark = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme -eq 0 } catch {}
  if ($q.theme -eq 'dark') { $dark = $true } elseif ($q.theme -eq 'light') { $dark = $false }
  $rgb = { param($h) [Drawing.ColorTranslator]::FromHtml($h) }
  $bg = & $rgb $(if ($dark) { '#2b2b2b' } else { '#f9f9f9' }); $border = & $rgb $(if ($dark) { '#3a3a3a' } else { '#e5e5e5' })
  $fg = & $rgb $(if ($dark) { '#ffffff' } else { '#1b1b1b' }); $dim = & $rgb $(if ($dark) { '#a8a8a8' } else { '#5f5f5f' })
  $btnBg = & $rgb $(if ($dark) { '#3a3a3a' } else { '#ffffff' }); $btn2 = & $rgb $(if ($dark) { '#323232' } else { '#f3f3f3' }); $btnLine = & $rgb $(if ($dark) { '#4a4a4a' } else { '#d0d0d0' })
  $red = & $rgb $(if ($dark) { '#ff99a4' } else { '#c42b1c' })
  $g0 = [Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $sc = $g0.DpiX / 96.0; $g0.Dispose()
  if ($q.scale) { $sc = [double]$q.scale }
  $px = { param($v) [int][Math]::Round($v * $sc) }
  $font = { param($name, $size, $style = 'Regular') New-Object Drawing.Font($name, [single]($size * $sc), [Drawing.FontStyle]$style, [Drawing.GraphicsUnit]::Pixel) }
  $fApp = & $font 'Segoe UI' 12; $fTitle = & $font 'Segoe UI Semibold' 14; $fCmd = & $font 'Consolas' 11; $fMeta = & $font 'Segoe UI' 11; $fBtn = & $font 'Segoe UI' 12
  $pad = & $px 16; $gap = & $px 8; $bh = & $px 32
  # Width: 380, wider only when a button label would not fit on one line.
  $rows = New-Object Collections.ArrayList
  foreach ($primary in $true, $false) { $row = @($q.specs | Where-Object { ($_[0] -in 'allow', 'deny') -eq $primary }); if ($row.Count) { [void]$rows.Add($row) } }
  $W = & $px 380
  foreach ($s in $q.specs) { $need = 2 * ([Windows.Forms.TextRenderer]::MeasureText($s[1], $fBtn).Width + (& $px 24)) + $gap + 2 * $pad; if ($need -gt $W) { $W = $need } }
  $cw = $W - 2 * $pad; $bw = [int](($cw - $gap) / 2)
  foreach ($s in $q.specs) { if ([Windows.Forms.TextRenderer]::MeasureText($s[1], $fBtn).Width + (& $px 24) -gt $bw) { throw "button label does not fit: $($s[1])" } }

  $f.FormBorderStyle = 'None'; $f.ShowInTaskbar = $false; $f.TopMost = $true; $f.StartPosition = 'Manual'; $f.AutoScaleMode = 'None'
  $f.BackColor = $bg; $f.ForeColor = $fg; $f.Text = 'Bridgerator'; $f.KeyPreview = $true
  $y = $pad
  $add = { param($c) $f.Controls.Add($c) }
  # App line: icon + "Bridgerator"
  $ic = New-LogoBitmap (& $px 16); $qs = $ic.Width
  $pb = New-Object Windows.Forms.PictureBox; $pb.Image = $ic; $pb.SetBounds($pad, $y + (& $px 1), $qs, $qs); & $add $pb
  $al = New-Object Windows.Forms.Label; $al.Text = 'Bridgerator'; $al.Font = $fApp; $al.ForeColor = $dim; $al.AutoSize = $true; $al.UseMnemonic = $false; $al.Location = New-Object Drawing.Point(($pad + $qs + (& $px 8)), $y); & $add $al
  $y += [Math]::Max($qs, $al.PreferredHeight) + (& $px 10)
  # Title
  $tl = New-Object Windows.Forms.Label; $tl.UseMnemonic = $false; $tl.Font = $fTitle; $tl.ForeColor = $fg; $tl.Text = $q.head
  $th = [Windows.Forms.TextRenderer]::MeasureText($tl.Text, $fTitle, (New-Object Drawing.Size($cw, 0)), [Windows.Forms.TextFormatFlags]::WordBreak).Height
  $tl.SetBounds($pad, $y, $cw, $th); & $add $tl; $y += $th + (& $px 6)
  # Command / path: a Label (not selectable), at most 3 lines, then "…"
  $flags = [Windows.Forms.TextFormatFlags]::WordBreak -bor [Windows.Forms.TextFormatFlags]::TextBoxControl
  $lineH = [Windows.Forms.TextRenderer]::MeasureText('Ag', $fCmd).Height
  $txt = [string]$q.detail
  while ($txt.Length -gt 1 -and [Windows.Forms.TextRenderer]::MeasureText($txt, $fCmd, (New-Object Drawing.Size($cw, 0)), $flags).Height -gt 3 * $lineH) { $txt = $txt.Substring(0, $txt.Length - 2).TrimEnd() + [char]0x2026 }
  $ch = [Windows.Forms.TextRenderer]::MeasureText($txt, $fCmd, (New-Object Drawing.Size($cw, 0)), $flags).Height
  $cl = New-Object Windows.Forms.Label; $cl.UseMnemonic = $false; $cl.Font = $fCmd; $cl.ForeColor = $fg; $cl.Text = $txt; $cl.SetBounds($pad, $y, $cw, $ch); & $add $cl; $y += $ch + (& $px 6)
  # Meta line with the countdown
  $ml = New-Object Windows.Forms.Label; $ml.UseMnemonic = $false; $ml.Font = $fMeta; $ml.ForeColor = $dim; $ml.AutoSize = $false
  $st = @{ pick = 'deny'; left = [int]$q.secs }; $f.Tag = $st
  $hostName = $q.host; $autoWord = $q.auto; $ru = $q.lang -eq 'ru'
  $tick = { $ml.Text = $(if ($ru) { "$hostName · $autoWord через $($st.left) с" } else { "$hostName · $autoWord in $($st.left) s" }) }.GetNewClosure(); & $tick
  $mh = [Windows.Forms.TextRenderer]::MeasureText('Ag', $fMeta).Height; $ml.SetBounds($pad, $y, $cw, $mh); & $add $ml; $y += $mh + (& $px 12)
  # Buttons: two rows, two per row, never wrapping
  foreach ($row in $rows) {
    $x = $pad
    foreach ($s in $row) {
      $b = if ('BrRealButton' -as [type]) { New-Object BrRealButton } else { New-Object Windows.Forms.Button }; $b.Text = $s[1]; $b.Tag = $s[0]; $b.Font = $fBtn; $b.FlatStyle = 'Flat'; $b.UseMnemonic = $false; $b.TabStop = $false
      $b.AutoEllipsis = $false; $b.UseCompatibleTextRendering = $false; $b.SetBounds($x, $y, $bw, $bh); $b.Cursor = 'Hand'
      $primary = $s[0] -in 'allow', 'deny'
      $b.BackColor = $(if ($primary) { $btnBg } else { $btn2 }); $b.ForeColor = $fg; $b.FlatAppearance.BorderColor = $btnLine
      if ($s[2] -eq 'deny') { $b.FlatAppearance.BorderColor = $red; $b.ForeColor = $red; $f.CancelButton = $b }
      $b.Add_Click({ $f.Tag.pick = $this.Tag; $f.Close() }.GetNewClosure())
      & $add $b; $x += $bw + $gap
    }
    $y += $bh + $gap
  }
  $H = $y - $gap + $pad
  $f.ClientSize = New-Object Drawing.Size($W, $H)
  $wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea; $m = & $px 12
  $f.Location = New-Object Drawing.Point(($wa.Right - $W - $m), ($wa.Bottom - $H - $m))
  $f.Add_Paint({ $_.Graphics.DrawRectangle((New-Object Drawing.Pen $border), 0, 0, $f.ClientSize.Width - 1, $f.ClientSize.Height - 1) }.GetNewClosure())
  $f.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $f.Tag.pick = 'deny'; $f.Close() } }.GetNewClosure())
  $f.Add_HandleCreated({ try { $v = 2; [void][BrToastForm]::DwmSetWindowAttribute($f.Handle, 33, [ref]$v, 4) } catch {} }.GetNewClosure())
  # Started hidden (windowsHide): show it explicitly, without taking the focus.
  $f.Add_Shown({ try { [void][BrToastForm]::ShowWindow($f.Handle, 4) } catch {} }.GetNewClosure())
  $tm = New-Object Windows.Forms.Timer; $tm.Interval = 1000
  $tm.Add_Tick({ $st.left--; & $tick; if ($st.left -le 0) { $f.Close() } }.GetNewClosure()); $tm.Start()
  # Buttons answer only after 600 ms: no accidental click on a window that just popped up.
  $btns = @($f.Controls | Where-Object { $_ -is [Windows.Forms.Button] }); foreach ($b in $btns) { $b.Enabled = $false }
  $en = New-Object Windows.Forms.Timer; $en.Interval = 600; $en.Add_Tick({ $en.Stop(); foreach ($b in $btns) { $b.Enabled = $true } }.GetNewClosure()); $en.Start()
  $f.Add_FormClosed({ $tm.Stop(); $tm.Dispose() }.GetNewClosure())
  if ($q.shot) { $shot = $q.shot; $sh = New-Object Windows.Forms.Timer; $sh.Interval = 1200; $sh.Add_Tick({ $sh.Stop(); $bm = New-Object Drawing.Bitmap $f.Width, $f.Height; $gg = [Drawing.Graphics]::FromImage($bm); $gg.CopyFromScreen($f.Location, [Drawing.Point]::Empty, $f.Size); $bm.Save($shot); $f.Close() }.GetNewClosure()); $sh.Start() }
  return $f
}


