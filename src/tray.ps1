# Bridgerator tray helper: started hidden by the bridge (one per Windows user), talks to it over
# stdin/stdout JSON lines, exits when the bridge process is gone. Loaded after ask-lib.ps1 (the
# toast / fallback window). No network, no listening socket.
#   bridge -> helper: {t:'state', state:'online'|'offline'|'paused', name, todo, confirm:'on'|'off', theme, lang:'en'|'ru', plan:{label,url,badge}|null, awake:bool}
#                     {t:'ask', id, head, detail, attr, host, auto, secs, theme, silent, style, lang, buttons:[[key,label,kind]...]}
#                     {t:'rpc-result', id, result | error}   (answers to the window)   {t:'open'}
#   helper -> bridge: {t:'ready'} {t:'answer', id, key} {t:'log', msg} {t:'power', on, ac}  (keep-awake as applied)
#                     {t:'menu', action:'pause'(minutes?)|'resume'|'quit'|'confirm'(on)}
#                     {t:'rpc', id, method, params, paths}    (from the window)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-CachedType -refs System.Windows.Forms -code @'
using System; using System.Collections.Concurrent; using System.Threading; using System.Runtime.InteropServices;
public static class BrIn {
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
  public static volatile bool Closed;
  public static void Start() {
    var t = new Thread(() => { try { string l; while ((l = Console.In.ReadLine()) != null) Lines.Enqueue(l); } catch {} Closed = true; });
    t.IsBackground = true; t.Start();
  }
}
public static class BrWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  // GetHicon makes a handle that Icon.Dispose / FromHandle never free: destroyed here after the icon is replaced.
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string s);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  // Resizable frame, no caption (the page has its own title bar); the title stays for the taskbar.
  public static void NoCaption(IntPtr h) {
    int st = GetWindowLong(h, -16); st &= ~0x00C00000; st |= 0x00040000 | 0x00020000 | 0x00080000; SetWindowLong(h, -16, st);
    SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0027);
  }
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  // The page's title bar moves the window: the native move loop, started as if the caption was pressed.
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  public static void Drag(IntPtr h) { ReleaseCapture(); SendMessage(h, 0xA1, (IntPtr)2, IntPtr.Zero); }
  // The window for the page's requests: a nested .GetNewClosure() handler does not see $f (it was $null → "Minimize" did nothing).
  public static object MainForm, Frame, Post;
  // Keep-awake: ES_CONTINUOUS (| ES_SYSTEM_REQUIRED) on the UI thread, which lives as long as the helper.
  [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint f);
  public static void Awake(bool on) { SetThreadExecutionState(on ? 0x80000001u : 0x80000000u); }
}
// Without a caption Windows still draws the top resize border as a dark / light strip above the page:
// WM_NCCALCSIZE keeps the client top where the window top is (sides and bottom still resize).
public class BrFrame : System.Windows.Forms.NativeWindow {
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  public BrFrame(IntPtr h) { AssignHandle(h); }
  protected override void WndProc(ref System.Windows.Forms.Message m) {
    if (m.Msg == 0x83 && m.WParam != IntPtr.Zero) {
      int top = Marshal.ReadInt32(m.LParam, 4);
      base.WndProc(ref m);
      Marshal.WriteInt32(m.LParam, 4, top + (IsZoomed(m.HWnd) ? GetSystemMetrics(33) + GetSystemMetrics(92) : 0));
      return;
    }
    base.WndProc(ref m);
  }
}
'@
[void][BrWin]::SetProcessDPIAware()
[Windows.Forms.Application]::EnableVisualStyles()
Initialize-Windows
$parent = [int]$env:BR_PARENT
# The account page of the site this PC is linked to (BR_ACCOUNT from tray.mjs: staging opens staging), else the main site.
$account = if ($env:BR_ACCOUNT -match '^https://[a-z0-9.-]+(:\d+)?/app$') { $env:BR_ACCOUNT } else { 'https://bridgerator.recondeck.com/app' }
$siteHost = ([Uri]$account).Host
$send = { param($o) [BrIO]::Send(($o | ConvertTo-Json -Compress -Depth 6)) }
# Links from the window / menu: only our own site (the main one, or the linked one), opened in the default browser.
$openUrl = { param($u) try { $x = [Uri]$u; if ($x.Scheme -eq 'https' -and ($x.Host -eq 'bridgerator.recondeck.com' -or $x.Host -eq $siteHost -or ($x.Host -eq 'chatgpt.com' -and $x.AbsolutePath -like '/settings/*')) -and -not $x.UserInfo) { Start-Process $x.AbsoluteUri } } catch {} }
$openAccount = { & $openUrl $account }
$g0 = [Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $script:dpi = $g0.DpiX / 96.0; $g0.Dispose()
if ($env:BR_DPI) { $script:dpi = [double]$env:BR_DPI }   # test harness: simulate scaling

# --- icon: the logo with a status dot (and a plan badge) ------------------------------------------
function New-TrayIcon([string]$state, [string]$badge) {
  # Drawn at the tray's own icon size (16 at 100 %, 20 / 24 at 125 / 150 %): crisp, no downscaling.
  $n = [Math]::Max(16, [Windows.Forms.SystemInformation]::SmallIconSize.Width)
  $bm = New-LogoBitmap $n
  $g = [Drawing.Graphics]::FromImage($bm); $g.SmoothingMode = 'AntiAlias'
  $ring = [Drawing.ColorTranslator]::FromHtml('#0c0d0f')
  $d = [Math]::Max(4, [Math]::Round($n * 0.34)); $rw = 1.5
  $dot = { param($hex, $cx, $cy)
    $g.FillEllipse((New-Object Drawing.SolidBrush $ring), ($cx - $d / 2 - $rw), ($cy - $d / 2 - $rw), ($d + 2 * $rw), ($d + 2 * $rw))
    $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($hex))), ($cx - $d / 2), ($cy - $d / 2), $d, $d) }
  # Status dot bottom-right with a 1.5 px ring (covers the logo's cyan dot, so they never clash).
  & $dot $(switch ($state) { 'online' { '#32d74b' } 'paused' { '#ffb900' } default { '#8e9098' } }) ($n - $d / 2 - 0.5) ($n - $d / 2 - 0.5)
  if ($badge) { & $dot $(if ($badge -eq 'red') { '#ff453a' } else { '#ffd60a' }) ($n - $d / 2 - 0.5) ($d / 2 + 0.5) }
  $g.Dispose()
  $h = $bm.GetHicon(); $bm.Dispose()
  return @{ icon = [Drawing.Icon]::FromHandle($h); handle = $h }
}

# --- tray menu (as in the mockup: status line, open, queue, confirm, pause, account, help, quit) ----
# Labels in the PC's language (config.json language, sent with every state; V-3).
$TXT = @{
  en = @{ open = 'Open Bridgerator'; queue = 'Task queue'; queueN = 'Task queue — {0} to do'; confirm = 'Confirm on this PC'; on = 'On'; off = 'Off'; pause = 'Pause'; p15 = 'For 15 minutes'; p60 = 'For 1 hour'; pInf = 'Until I resume'; resume = 'Resume'; account = 'Open account ↗'; help = 'Help'; quit = 'Quit Bridgerator'; online = 'Online'; paused = 'Paused'; offline = 'Offline'; renew = 'Renew Pro…'; upgrade = 'Upgrade to Pro…' }
  ru = @{ open = 'Открыть Bridgerator'; queue = 'Очередь задач'; queueN = 'Очередь задач — {0} к выполнению'; confirm = 'Подтверждения на этом ПК'; on = 'Вкл.'; off = 'Выкл.'; pause = 'Пауза'; p15 = 'На 15 минут'; p60 = 'На 1 час'; pInf = 'Пока не возобновлю'; resume = 'Возобновить'; account = 'Открыть кабинет ↗'; help = 'Справка'; quit = 'Выйти из Bridgerator'; online = 'В сети'; paused = 'Пауза'; offline = 'Не в сети'; renew = 'Продлить Pro…'; upgrade = 'Перейти на Pro…' }
}
$S = @{ state = 'offline'; name = $env:COMPUTERNAME; todo = 0; confirm = 'off'; theme = 'system'; lang = 'en'; plan = $null }
function L([string]$k) { $t = $TXT[$(if ($S.lang -eq 'ru') { 'ru' } else { 'en' })]; [string]$t[$k] }
$ni = New-Object Windows.Forms.NotifyIcon
$script:iconKey = 'offline|'; $ti = New-TrayIcon 'offline' $null; $script:iconH = $ti.handle; $ni.Icon = $ti.icon; $ni.Text = 'Bridgerator'; $ni.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $true; $menu.Font = New-Object Drawing.Font('Segoe UI', 9)
$script:dotImgs = @{}
function Get-Dot([string]$hex) { if (-not $script:dotImgs[$hex]) { $script:dotImgs[$hex] = New-Dot $hex }; $script:dotImgs[$hex] }
function New-Dot([string]$hex) { $b = New-Object Drawing.Bitmap 16, 16; $g = [Drawing.Graphics]::FromImage($b); $g.SmoothingMode = 'AntiAlias'; $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($hex))), 4, 4, 8, 8); $g.Dispose(); $b }
function Add-Item([string]$text, $onClick) { $i = New-Object Windows.Forms.ToolStripMenuItem $text; if ($onClick) { $i.Add_Click($onClick) }; [void]$menu.Items.Add($i); $i }
$miPlan = Add-Item 'Renew Pro…' { if ($S.plan) { & $openUrl $S.plan.url } }
$sepPlan = New-Object Windows.Forms.ToolStripSeparator; [void]$menu.Items.Add($sepPlan)
$miHead = Add-Item 'Offline' $null; $miHead.Enabled = $false
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$miOpen = Add-Item 'Open Bridgerator' { Open-Window 'home' }; $miOpen.Font = New-Object Drawing.Font('Segoe UI', 9, [Drawing.FontStyle]::Bold)
$miQueue = Add-Item 'Task queue' { Open-Window 'queue' }
$miConfirm = Add-Item 'Confirm on this PC' $null
$miConfOn = New-Object Windows.Forms.ToolStripMenuItem 'On'; $miConfOn.Add_Click({ & $send @{ t = 'menu'; action = 'confirm'; on = $true } })
$miConfOff = New-Object Windows.Forms.ToolStripMenuItem 'Off'; $miConfOff.Add_Click({ & $send @{ t = 'menu'; action = 'confirm'; on = $false } })
[void]$miConfirm.DropDownItems.AddRange(@($miConfOn, $miConfOff))
$miPause = Add-Item 'Pause' $null
$p15 = New-Object Windows.Forms.ToolStripMenuItem 'For 15 minutes'; $p15.Add_Click({ & $send @{ t = 'menu'; action = 'pause'; minutes = 15 } })
$p60 = New-Object Windows.Forms.ToolStripMenuItem 'For 1 hour'; $p60.Add_Click({ & $send @{ t = 'menu'; action = 'pause'; minutes = 60 } })
$pInf = New-Object Windows.Forms.ToolStripMenuItem 'Until I resume'; $pInf.Add_Click({ & $send @{ t = 'menu'; action = 'pause' } })
[void]$miPause.DropDownItems.AddRange(@($p15, $p60, $pInf))
$miResume = Add-Item 'Resume' { & $send @{ t = 'menu'; action = 'resume' } }
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$miAcc = Add-Item 'Open account ↗' $openAccount
$miHelp = Add-Item 'Help' { Open-Window 'help' }
[void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$miQuit = Add-Item 'Quit Bridgerator' { & $send @{ t = 'menu'; action = 'quit' } }
$ni.ContextMenuStrip = $menu
# Every exit path (parent gone, stop, error) hides + disposes the icon, or a ghost stays in the tray until the mouse passes it.
# The window's WebView2 is disposed too: its msedgewebview2 processes end with it (V-8: an update left 12 behind).
function Remove-Tray {
  try { $ni.Visible = $false; $ni.Dispose() } catch {}; if ($script:iconH) { [void][BrWin]::DestroyIcon($script:iconH); $script:iconH = $null }
  try { if ($script:wv) { $script:wv.Dispose(); $script:wv = $null } } catch {}
  try { if ($script:win -and -not $script:win.IsDisposed) { $W.forceClose = $true; $script:win.Close(); $script:win.Dispose() } } catch {}
}

# The bridge says when ChatGPT is working (awake); the PC is held awake only on mains power (a desktop
# reports Online or Unknown, never Offline). Display may still turn off; a sleep the person starts still works.
$script:awakeOn = $false; $script:acOn = $true
function Set-Awake($want) {
  $ac = $true; try { $ac = [Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -ne 'Offline' } catch {}
  $on = [bool]$want -and $ac
  if ($on -ne $script:awakeOn -or $ac -ne $script:acOn) {
    [BrWin]::Awake($on); $script:awakeOn = $on; $script:acOn = $ac
    & $send @{ t = 'power'; on = $on; ac = $ac }
  }
}
function Set-TrayState($m) {
  foreach ($k in 'state', 'name', 'todo', 'confirm', 'theme', 'lang') { if ($null -ne $m.$k -and "$($m.$k)" -ne '') { $S[$k] = $m.$k } }
  if ($null -ne $m.awake) { try { Set-Awake $m.awake } catch { & $send @{ t = 'log'; msg = "keep awake: $_" } } }
  $S.plan = $m.plan
  $badge = if ($S.plan) { [string]$S.plan.badge } else { $null }
  # Redrawn only when the state / badge changed (the bridge pushes the state every 5 s); the old HICON is destroyed.
  if ($script:iconKey -ne "$($S.state)|$badge") {
    $ti = New-TrayIcon $S.state $badge; $old = $ni.Icon; $oldH = $script:iconH
    $ni.Icon = $ti.icon; $script:iconH = $ti.handle; $script:iconKey = "$($S.state)|$badge"
    if ($old) { $old.Dispose() }; if ($oldH) { [void][BrWin]::DestroyIcon($oldH) }
  }
  $word = switch ($S.state) { 'online' { L 'online' } 'paused' { L 'paused' } default { L 'offline' } }
  $t = "Bridgerator — $($word.ToLower()) ($($S.name))"; if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }
  if ($ni.Text -ne $t) { $ni.Text = $t }
  $miHead.Text = "$word · $($S.name)"
  $miHead.Image = Get-Dot $(switch ($S.state) { 'online' { '#32d74b' } 'paused' { '#ffb900' } default { '#8e9098' } })
  $miQueue.Text = if ([int]$S.todo -gt 0) { (L 'queueN') -f $S.todo } else { L 'queue' }
  $miConfirm.Text = "$(L 'confirm') — $(if ($S.confirm -eq 'on') { L 'on' } else { L 'off' })"
  $miOpen.Text = L 'open'; $miConfOn.Text = L 'on'; $miConfOff.Text = L 'off'; $miPause.Text = L 'pause'; $p15.Text = L 'p15'; $p60.Text = L 'p60'; $pInf.Text = L 'pInf'
  $miResume.Text = L 'resume'; $miAcc.Text = L 'account'; $miHelp.Text = L 'help'; $miQuit.Text = L 'quit'
  $miConfOn.Checked = $S.confirm -eq 'on'; $miConfOff.Checked = $S.confirm -ne 'on'
  $miPause.Visible = $S.state -ne 'paused'; $miResume.Visible = $S.state -eq 'paused'
  $miPlan.Visible = [bool]$S.plan; $sepPlan.Visible = [bool]$S.plan
  if ($S.plan) { $miPlan.Text = $(switch ([string]$S.plan.label) { 'Renew Pro…' { L 'renew' } 'Upgrade to Pro…' { L 'upgrade' } default { [string]$S.plan.label } }); $miPlan.Image = Get-Dot $(if ($badge -eq 'red') { '#ff453a' } else { '#ffd60a' }) }
}
Set-TrayState @{ state = 'offline' }

# --- the window (WebView2): 1040 x 900 (every page without scrollbars, owner 21.10; never larger than the screen), min 760 x 520 ---
# Created once, hidden, soon after the helper starts (WebView2 warm), shown only after the page has
# loaded; closing hides it — reopening is instant and never flashes.
$W = @{ win = $null; wv = $null; ready = $false; want = $null; shown = $false; t0 = $null; forceClose = $false }
$script:win = $null; $script:wv = $null
function Show-Win([string]$page) {
  $f = $W.win
  if ($W.wv.CoreWebView2) { $W.wv.CoreWebView2.PostWebMessageAsJson((@{ t = 'nav'; page = $page } | ConvertTo-Json -Compress)) }
  $f.Show(); if ($f.WindowState -eq 'Minimized') { $f.WindowState = 'Normal' }
  if (-not $W.shown) {
    $W.shown = $true; [BrWin]::NoCaption($f.Handle)
    # Physical pixels (the process is DPI-aware): never larger than the work area of the monitor, title bar always on screen.
    $wa = [Windows.Forms.Screen]::FromHandle($f.Handle).WorkingArea
    $f.MinimumSize = New-Object Drawing.Size([Math]::Min($f.MinimumSize.Width, $wa.Width), [Math]::Min($f.MinimumSize.Height, $wa.Height))
    $f.ClientSize = New-Object Drawing.Size([int](1040 * $script:dpi), [int](900 * $script:dpi))
    $f.Size = New-Object Drawing.Size([Math]::Min($f.Width, $wa.Width), [Math]::Min($f.Height, $wa.Height))
    $f.Location = New-Object Drawing.Point(($wa.Left + [int](($wa.Width - $f.Width) / 2)), ($wa.Top + [int](($wa.Height - $f.Height) / 2)))
  }
  [void][BrWin]::ShowWindow($f.Handle, 5); [void][BrWin]::SetForegroundWindow($f.Handle); $f.Activate()
  if ($W.t0) { & $send @{ t = 'log'; msg = "tray window shown in $([int]((Get-Date) - $W.t0).TotalMilliseconds) ms" }; $W.t0 = $null }
}
function Get-Dark { $th = [string]$S.theme; if ($th -eq 'dark') { return $true }; if ($th -eq 'light') { return $false }; try { return (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme -eq 0 } catch { return $true } }
function Open-Window([string]$page = 'home', [switch]$Prewarm) {
  if (-not $Prewarm) { $W.t0 = Get-Date }
  $ui = if ($env:BR_UI_DIR) { $env:BR_UI_DIR } else { Join-Path $env:BR_PKG 'ui' }
  $vendor = Join-Path $env:BR_PKG 'vendor\webview2'
  if (-not (Test-Path (Join-Path $ui 'index.html'))) { if (-not $Prewarm) { & $openAccount }; return }
  if ($W.win -and -not $W.win.IsDisposed) {
    if ($Prewarm) { return }
    if ($W.ready) { Show-Win $page } else { $W.want = $page }
    return
  }
  try {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $env:PATH = (Join-Path $vendor $arch) + ';' + $env:PATH   # WebView2Loader.dll
    Add-Type -Path (Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll')
    [void][Microsoft.Web.WebView2.Core.CoreWebView2Environment]::GetAvailableBrowserVersionString()
  } catch { & $send @{ t = 'log'; msg = "tray: WebView2 not available ($_)$(if ($Prewarm) { ' - prewarm skipped, tried again when the window is opened' } else { ', opening the account page' })" }; if (-not $Prewarm) { & $openAccount }; return }
  $dark = Get-Dark
  $bg = [Drawing.ColorTranslator]::FromHtml($(if ($dark) { '#141518' } else { '#f6f7f9' }))
  $k = $script:dpi
  $f = New-Object Windows.Forms.Form
  # Sizable frame without a caption: the page draws its own title bar (drag region via app-region).
  $f.FormBorderStyle = 'Sizable'; $f.ControlBox = $false; $f.Text = ''; $f.ShowIcon = $true
  $f.Icon = New-Object Drawing.Icon (Join-Path $env:BR_PKG 'assets\bridgerator.ico'); $f.StartPosition = 'CenterScreen'; $f.AutoScaleMode = 'None'; $f.BackColor = $bg
  $f.ClientSize = New-Object Drawing.Size([int](1040 * $k), [int](900 * $k))
  $f.MinimumSize = New-Object Drawing.Size([int](760 * $k), [int](520 * $k))
  $wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2; $wv.Dock = 'Fill'; $wv.DefaultBackgroundColor = $bg
  $cp = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
  $cp.UserDataFolder = if ($env:BR_WEBVIEW) { $env:BR_WEBVIEW } else { Join-Path $env:LOCALAPPDATA 'Bridgerator\webview' }; $wv.CreationProperties = $cp
  if ($env:BR_ZOOM) { $wv.ZoomFactor = [double]$env:BR_ZOOM }
  $f.Controls.Add($wv)
  $post = { param($o) if ($wv.CoreWebView2) { $wv.CoreWebView2.PostWebMessageAsJson(($o | ConvertTo-Json -Compress -Depth 4)) } }.GetNewClosure()
  [BrWin]::Post = $post
  $wv.Add_CoreWebView2InitializationCompleted({
    param($s, $e)
    if (-not $e.IsSuccess) {
      # Close() is a UserClosing (hidden by the handler below): force it (the flag lives in $W: each .GetNewClosure() handler has its own $script: scope); only an explicit click falls back to the browser.
      $wanted = [bool]$W.want; $W.forceClose = $true; try { $f.Close() } finally { $W.forceClose = $false }
      if ($wanted) { & $openAccount }
      return
    }
    $c = $wv.CoreWebView2
    $c.Settings.AreDevToolsEnabled = [bool]$env:BR_DEVTOOLS; $c.Settings.IsStatusBarEnabled = $false; $c.Settings.AreDefaultContextMenusEnabled = [bool]$env:BR_DEVTOOLS
    $c.Settings.IsZoomControlEnabled = $false
    $c.SetVirtualHostNameToFolderMapping('bridgerator.local', $ui, 'Deny')
    # Only our own page: anything else opens in the default browser (our site only) or is refused.
    $c.Add_NavigationStarting({ param($s2, $n) if ($n.Uri -notlike 'https://bridgerator.local/*') { $n.Cancel = $true; & $openUrl $n.Uri } }.GetNewClosure())
    $c.Add_NewWindowRequested({ param($s2, $n) $n.Handled = $true; & $openUrl $n.Uri }.GetNewClosure())
    $c.Add_WebMessageReceived({
      param($s2, $m)
      try {
        # Only our own page may talk to the helper.
        if ([string]$m.Source -notlike 'https://bridgerator.local/*') { return }
        $f = [BrWin]::MainForm; $post = [BrWin]::Post
        $msg = $m.WebMessageAsJson | ConvertFrom-Json
        $paths = @(); try { foreach ($o in $m.AdditionalObjects) { if ($o.Path) { $paths += [string]$o.Path } } } catch {}
        switch ($msg.method) {
          'openUrl' { & $openUrl ([string]$msg.params.url); & $post @{ id = $msg.id; result = $true } }
          'minimize' { $f.WindowState = 'Minimized'; & $post @{ id = $msg.id; result = $true } }
          'drag' { [BrWin]::Drag($f.Handle); & $post @{ id = $msg.id; result = $true } }
          'hide' { $f.Hide(); & $post @{ id = $msg.id; result = $true } }
          'droppedPaths' { & $post @{ id = $msg.id; result = @($paths) } }
          'pickFolder' {
            $d = New-Object Windows.Forms.FolderBrowserDialog
            $r = if ($d.ShowDialog($f) -eq 'OK') { $d.SelectedPath } else { $null }
            & $post @{ id = $msg.id; result = $r }
          }
          'pickFiles' {
            $d = New-Object Windows.Forms.OpenFileDialog; $d.Multiselect = $true
            $r = if ($d.ShowDialog($f) -eq 'OK') { @($d.FileNames) } else { @() }
            & $post @{ id = $msg.id; result = $r }
          }
          default { & $send @{ t = 'rpc'; id = [string]$msg.id; method = [string]$msg.method; params = $msg.params; paths = $paths } }
        }
      } catch { & $send @{ t = 'log'; msg = "tray window: $_" } }
    }.GetNewClosure())
    # First page loaded: only now the window may appear (no white / black flash).
    $c.Add_NavigationCompleted({ if (-not $W.ready) { $W.ready = $true; if ($W.want) { $p0 = $W.want; $W.want = $null; Show-Win $p0 } } }.GetNewClosure())
    $c.Navigate("https://bridgerator.local/index.html#$page")
  }.GetNewClosure())
  $f.Add_HandleCreated({ [void][BrWin]::SetWindowText($f.Handle, 'Bridgerator'); [BrWin]::MainForm = $f; [BrWin]::Frame = New-Object BrFrame $f.Handle; [BrWin]::NoCaption($f.Handle); if ($dark) { $v = 1; [void][BrWin]::DwmSetWindowAttribute($f.Handle, 20, [ref]$v, 4) } }.GetNewClosure())

  # Closing hides to the tray (the X in the page, Alt+F4); Quit is in the tray menu.
  $f.Add_FormClosing({ param($s, $e) if ($e.CloseReason -eq 'UserClosing' -and -not $W.forceClose) { $e.Cancel = $true; $f.Hide() } }.GetNewClosure())
  $f.Add_FormClosed({ $W.win = $null; $W.wv = $null; $W.ready = $false; $W.shown = $false; $script:win = $null; $script:wv = $null })
  $W.win = $f; $W.wv = $wv; $W.ready = $false; $W.shown = $false; $W.want = $(if ($Prewarm) { $null } else { $page })
  $script:win = $f; $script:wv = $wv
  # Handles without showing; WebView2 starts loading the page in the background.
  [void]$f.Handle; [void]$wv.Handle
  [void]$wv.EnsureCoreWebView2Async($null)
}
$ni.Add_DoubleClick({ try { Open-Window 'home' } catch { & $send @{ t = 'log'; msg = "tray: $_" } } })

# --- questions (toast; fallback window when our notifications are off) ---------------------------
$pending = @{}   # id -> @{ w = BrWait; tag; deadline }
# popupStyle = toast but the own window appeared (V-4): the reason goes to bridge.log once per reason
# (notifications for Bridgerator / all apps off = Setting not Enabled, the toast failed with its HRESULT, ...).
$script:fallbackWhy = @{}
function Write-FallbackWhy([string]$why) { if (-not $script:fallbackWhy[$why]) { $script:fallbackWhy[$why] = $true; & $send @{ t = 'log'; msg = "question shown in the Bridgerator window instead of a Windows notification: $why" } } }
function Start-Ask($m) {
  $specs = @(); foreach ($b in $m.buttons) { $specs += ,@([string]$b[0], [string]$b[1], [string]$b[2]) }
  $q = @{ specs = $specs; head = [string]$m.head; detail = [string]$m.detail; attr = [string]$m.attr; host = [string]$m.host; auto = [string]$m.auto; secs = [int]$m.secs; tag = "t$([string]$m.id)"; theme = [string]$m.theme; icon = (Join-Path $env:BR_PKG 'assets\icon-64.png'); silent = [bool]$m.silent; lang = [string]$m.lang }
  if ($q.tag.Length -gt 60) { $q.tag = $q.tag.Substring(0, 60) }
  $w = New-Object BrWait; $w.Id = [string]$m.id; $w.Report = $true; $w.Keys = [string[]]@($specs | ForEach-Object { $_[0] })
  try {
    if ($m.style -eq 'popup') { throw 'compact pop-up chosen' }
    Show-AskToast $q $w
    $pending[$w.Id] = @{ w = $w; q = $q; deadline = (Get-Date).AddSeconds($q.secs) }
  } catch { if ("$_" -ne 'compact pop-up chosen') { Write-FallbackWhy "$_" }; Show-AskWindow $q $w.Id $w.Keys }
}
# Our notifications are off (or the toast failed): the small window, answer reported when it closes.
function Show-AskWindow($q, $id, $keys) {
  $w = New-Object BrWait; $w.Id = $id; $w.Report = $true; $w.Keys = $keys
  try {
    $f = New-AskForm $q
    $f.Add_FormClosed({ [void]$w.Finish($f.Tag.pick) }.GetNewClosure())
    $f.Show(); [void][BrWin]::ShowWindow($f.Handle, 4)   # SW_SHOWNOACTIVATE: no focus stealing
  } catch { [void]$w.Finish('deny') }
}

# --- main loop on the UI thread ----------------------------------------------------------------
[BrIn]::Start()
& $send @{ t = 'ready' }
$warm = New-Object Windows.Forms.Timer; $warm.Interval = 200
$warm.Add_Tick({ $warm.Stop(); try { Open-Window 'home' -Prewarm } catch { & $send @{ t = 'log'; msg = "tray prewarm: $_" } } })
$warm.Start()
$script:lastParentCheck = Get-Date
$tm = New-Object Windows.Forms.Timer; $tm.Interval = 100
$tm.Add_Tick({
  $line = $null
  while ([BrIn]::Lines.TryDequeue([ref]$line)) {
    try {
      $m = $line | ConvertFrom-Json
      switch ($m.t) {
        'state' { Set-TrayState $m }
        'ask' { Start-Ask $m }
        'rpc-result' { if ($script:wv -and $script:wv.CoreWebView2) { $script:wv.CoreWebView2.PostWebMessageAsJson($line) } }
        'exit' { Remove-Tray; [Windows.Forms.Application]::Exit() }
        'open' { Open-Window $(if ($m.page) { [string]$m.page } else { 'home' }) }
      }
    } catch { & $send @{ t = 'log'; msg = "tray: $_ $($_.InvocationInfo.PositionMessage)" } }
  }
  foreach ($id in @($pending.Keys)) {
    $p = $pending[$id]
    if ($p.w.IsOver) { $pending.Remove($id); if ($p.w.Result -eq 'failed') { Write-FallbackWhy "Windows could not show the notification ($($p.w.FailCode))"; Show-AskWindow $p.q $id $p.w.Keys }; continue }
    if ((Get-Date) -gt $p.deadline) { Remove-AskToast $p.q.tag; [void]$p.w.Finish('deny'); $pending.Remove($id) }
  }
  if ([BrIn]::Closed -or ((Get-Date) - $script:lastParentCheck).TotalSeconds -ge 2) {
    $script:lastParentCheck = Get-Date
    $alive = $false; try { $alive = -not [BrIn]::Closed -and [bool](Get-Process -Id $parent -ErrorAction Stop) } catch {}
    if (-not $alive) { Remove-Tray; [Windows.Forms.Application]::Exit() }
  }
})
$tm.Start()
try { [Windows.Forms.Application]::Run() } finally { Remove-Tray }
