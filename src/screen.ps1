# LOGIC: see critical-logic/bridge.md ("Extra tools", screen). Screenshot / window list / OCR for the
# `screen` tool (screen-tool.mjs). Windows PowerShell 5.1, no extra programs: user32 + System.Drawing for
# the picture, the built-in Windows.Media.Ocr engine for text. Input only through BRX_* environment
# variables; output = ONE JSON line. Never shows a window, never moves or restores the person's windows.
#   BRX_ACTION  windows | capture | ocr | langs
#   BRX_HWND    window id (capture / ocr of one window; BRX_PID = its process then, must still match), BRX_MONITOR 1-based monitor (0 = all)
#   BRX_FILE    image file to recognize (ocr), BRX_LANG OCR language tag (empty = the user's languages)
#   BRX_IMAGE   1 = return the compressed picture, BRX_MAXSIDE / BRX_MAXBYTES its limits, BRX_SAVE full-size copy path

function Out-Json($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Depth 6 -Compress)) }
# taken = a picture was already made: the bridge shows the screenshot notice even when a later step fails.
$script:taken = $false
function Fail([string]$code, [string]$message, $extra = @{}) { $o = @{ ok = $false; code = $code; message = $message }; if ($script:taken) { $o.taken = $true }; foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] }; Out-Json $o; exit 0 }

# Compiled helpers are cached like the tray helper's (%LOCALAPPDATA%\Bridgerator\cache, br-<hash>.dll).
function Add-CachedType([string]$code, [string[]]$refs = @()) {
  try {
    $dir = Join-Path $env:LOCALAPPDATA 'Bridgerator\cache'
    $bytes = [Text.Encoding]::UTF8.GetBytes("$code|$($refs -join ',')|$($PSVersionTable.CLRVersion)")
    $key = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)[0..11] | ForEach-Object { $_.ToString('x2') })
    $dll = Join-Path $dir "br-$key.dll"
    if (-not [IO.File]::Exists($dll)) {
      [void][IO.Directory]::CreateDirectory($dir)
      $tmp = Join-Path $dir "br-$key.$PID.dll"
      Add-Type -TypeDefinition $code -ReferencedAssemblies $refs -OutputAssembly $tmp -OutputType Library
      try { [IO.File]::Move($tmp, $dll) } catch {
        # Another run compiled the same helper at the same moment: use its file, drop ours.
        if ([IO.File]::Exists($dll)) { try { [IO.File]::Delete($tmp) } catch { } } else { $dll = $tmp }
      }
    }
    Add-Type -Path $dll
  } catch {
    Add-Type -TypeDefinition $code -ReferencedAssemblies $refs
  }
}

Add-CachedType -refs System.Drawing @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
using System.Drawing; using System.Drawing.Imaging; using System.Drawing.Drawing2D; using System.IO;
public static class BrShot {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  delegate bool MonProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder buf, int len, out int needed);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  // Physical pixels on every monitor (per-monitor v2; older Windows: system aware).
  public static void Dpi() {
    try { if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return; } catch (Exception) { }
    try { SetProcessDPIAware(); } catch (Exception) { }
  }
  // The desktop that gets the keyboard: "Default" when the person is working; locked screen, sign-in
  // screen and UAC prompts are on the secure desktop (not readable from here) -> null.
  public static string InputDesktop() {
    IntPtr d = OpenInputDesktop(0, false, 0x0001);
    if (d == IntPtr.Zero) return null;
    try { StringBuilder b = new StringBuilder(256); int n; return GetUserObjectInformation(d, 2, b, b.Capacity * 2, out n) ? b.ToString() : null; }
    finally { CloseDesktop(d); }
  }
  public class Win { public long Id; public string Title; public uint Pid; public bool Minimized; public int W, H; }
  public static List<Win> Windows() {
    List<Win> list = new List<Win>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;              // WS_EX_TOOLWINDOW
      int cloaked = 0;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // hidden store apps
      StringBuilder sb = new StringBuilder(len + 1); GetWindowText(h, sb, sb.Capacity);
      RECT r; GetWindowRect(h, out r);
      uint pid; GetWindowThreadProcessId(h, out pid);
      Win w = new Win(); w.Id = h.ToInt64(); w.Title = sb.ToString(); w.Pid = pid; w.Minimized = IsIconic(h); w.W = r.R - r.L; w.H = r.B - r.T;
      if (!w.Minimized && (w.W <= 1 || w.H <= 1)) return true;
      list.Add(w);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static Rectangle[] Monitors() {
    List<Rectangle> m = new List<Rectangle>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr hm, IntPtr dc, ref RECT r, IntPtr l) { m.Add(Rectangle.FromLTRB(r.L, r.T, r.R, r.B)); return true; }, IntPtr.Zero);
    return m.ToArray();
  }
  public static Bitmap Screen(int monitor) {
    Rectangle[] mons = Monitors();
    Rectangle b;
    if (monitor > 0) { if (monitor > mons.Length) return null; b = mons[monitor - 1]; }
    else { b = mons.Length > 0 ? mons[0] : Rectangle.Empty; foreach (Rectangle x in mons) b = Rectangle.Union(b, x); }
    if (b.Width <= 0 || b.Height <= 0) return null;
    Bitmap bmp = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) { g.Clear(Color.Black); g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size, CopyPixelOperation.SourceCopy); }
    return bmp;
  }
  public static bool IsMinimized(long id) { return IsIconic(new IntPtr(id)); }
  public static uint Owner(long id) { uint pid; GetWindowThreadProcessId(new IntPtr(id), out pid); return pid; }
  public static bool Exists(long id) { IntPtr h = new IntPtr(id); return IsWindow(h) && IsWindowVisible(h); }
  // PrintWindow with PW_RENDERFULLCONTENT: the window's own picture, also when other windows cover it.
  // Cropped to the visible frame (without the invisible resize borders).
  public static Bitmap Window(long id) {
    IntPtr h = new IntPtr(id);
    RECT r; if (!GetWindowRect(h, out r)) return null;
    int w = r.R - r.L, ht = r.B - r.T;
    if (w <= 1 || ht <= 1) return null;
    Bitmap full = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(full)) {
      IntPtr hdc = g.GetHdc();
      bool ok;
      try { ok = PrintWindow(h, hdc, 2); } finally { g.ReleaseHdc(hdc); }
      if (!ok) { full.Dispose(); return null; }
    }
    RECT f;
    if (DwmGetWindowAttribute(h, 9, out f, Marshal.SizeOf(typeof(RECT))) == 0) {
      Rectangle c = Rectangle.Intersect(new Rectangle(f.L - r.L, f.T - r.T, f.R - f.L, f.B - f.T), new Rectangle(0, 0, w, ht));
      if (c.Width > 1 && c.Height > 1 && (c.Width < w || c.Height < ht)) { Bitmap crop = full.Clone(c, full.PixelFormat); full.Dispose(); return crop; }
    }
    return full;
  }
  public static Bitmap Scale(Bitmap src, double k) {
    int w = Math.Max(1, (int)Math.Round(src.Width * k)), h = Math.Max(1, (int)Math.Round(src.Height * k));
    Bitmap dst = new Bitmap(w, h, PixelFormat.Format24bppRgb);
    using (Graphics g = Graphics.FromImage(dst)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.DrawImage(src, 0, 0, w, h); }
    return dst;
  }
  static ImageCodecInfo Jpeg() { foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") return c; return null; }
  public static byte[] ToJpeg(Bitmap b, long quality) {
    using (MemoryStream ms = new MemoryStream()) {
      EncoderParameters p = new EncoderParameters(1); p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
      b.Save(ms, Jpeg(), p); return ms.ToArray();
    }
  }
  // Long side <= maxSide, then lower quality / size until it fits maxBytes.
  public class Packed { public byte[] Data; public int W, H; public long Quality; }
  public static Packed Pack(Bitmap src, int maxSide, int maxBytes) {
    double k = Math.Min(1.0, (double)maxSide / Math.Max(src.Width, src.Height));
    long[] qs = new long[] { 80, 65, 50 };
    for (int round = 0; round < 6; round++) {
      using (Bitmap s = Scale(src, k)) {
        foreach (long q in qs) {
          byte[] d = ToJpeg(s, q);
          if (d.Length <= maxBytes) { Packed p = new Packed(); p.Data = d; p.W = s.Width; p.H = s.Height; p.Quality = q; return p; }
        }
      }
      k *= 0.75;
    }
    return null;
  }
  // A NEW file only (CreateNew): never overwrites, also when the name was taken a moment ago.
  public static void Save(Bitmap b, string path) {
    string ext = Path.GetExtension(path).ToLowerInvariant();
    byte[] data = ext == ".png" ? ToPng(b) : ToJpeg(b, 90);
    FileStream f = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
    try { f.Write(data, 0, data.Length); f.Dispose(); }
    catch (Exception) { f.Dispose(); try { File.Delete(path); } catch (Exception) { } throw; }
  }
  public static byte[] ToPng(Bitmap b) { using (MemoryStream ms = new MemoryStream()) { b.Save(ms, ImageFormat.Png); return ms.ToArray(); } }
}
'@

# --- OCR (Windows.Media.Ocr, WinRT from PowerShell 5.1) ---------------------------------------
function Get-Await {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:AsTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
}
function Await($op, [Type]$type) {
  $task = $script:AsTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(-1)
  $task.Result
}
function Get-OcrLanguages {
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
}
function Invoke-Ocr([byte[]]$bytes, [string]$lang) {
  Get-Await
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  [void][Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
  $langs = @(Get-OcrLanguages)                     # @(): one language must stay a list, not a string
  if (-not $langs.Count) { Fail 'NO_OCR_LANG' 'No text recognition language is installed in Windows.' }
  if ($lang) {
    $hit = $langs | Where-Object { $_ -ieq $lang -or $_ -ilike "$lang-*" } | Select-Object -First 1
    if (-not $hit) { Fail 'BAD_LANG' "Text recognition for ""$lang"" is not installed." @{ languages = $langs } }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($hit))
  } else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($langs[0])) }
  }
  if (-not $engine) { Fail 'NO_OCR_LANG' 'Text recognition could not start for the installed languages.' @{ languages = $langs } }
  $ms = New-Object IO.MemoryStream (, $bytes)
  $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  } catch { Fail 'BAD_IMAGE' 'This file is not an image Windows can read (PNG, JPEG, BMP, GIF or TIFF).' }
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($decoder.PixelWidth -gt $max -or $decoder.PixelHeight -gt $max) { Fail 'IMAGE_TOO_LARGE' "The image is larger than $max pixels on a side." }
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  @{ language = $engine.RecognizerLanguage.LanguageTag; lines = @($res.Lines | ForEach-Object { $_.Text }); width = [int]$decoder.PixelWidth; height = [int]$decoder.PixelHeight }
}
# Text recognition works best on the full-size picture; above the engine's limit it is scaled down.
function Get-OcrBytes($bmp) {
  [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $side = [Math]::Max($bmp.Width, $bmp.Height)
  if ($side -gt $max) { $s = [BrShot]::Scale($bmp, ($max - 1) / $side); try { return , [BrShot]::ToPng($s) } finally { $s.Dispose() } }
  , [BrShot]::ToPng($bmp)
}

try {
  [BrShot]::Dpi()
  $action = $env:BRX_ACTION
  if ($action -eq 'langs') { Out-Json @{ ok = $true; languages = @(Get-OcrLanguages) }; exit 0 }
  if ($action -eq 'ocr' -and $env:BRX_FILE) {
    $r = Invoke-Ocr ([IO.File]::ReadAllBytes($env:BRX_FILE)) $env:BRX_LANG
    Out-Json (@{ ok = $true; kind = 'file' } + $r); exit 0
  }
  if (([BrShot]::InputDesktop()) -ne 'Default') { Fail 'SCREEN_LOCKED' 'The screen is locked, signed out or showing a Windows security prompt.' }
  if ($action -eq 'windows') {
    $wins = @([BrShot]::Windows() | ForEach-Object {
      $p = ''; try { $p = (Get-Process -Id $_.Pid -ErrorAction Stop).ProcessName } catch { }
      @{ id = $_.Id; pid = [int64]$_.Pid; title = $_.Title; process = $p; minimized = $_.Minimized; width = $_.W; height = $_.H } })
    Out-Json @{ ok = $true; windows = $wins }; exit 0
  }
  if ($action -ne 'capture' -and $action -ne 'ocr') { Fail 'BAD_ACTION' "Unknown action $action." }
  $hwnd = [long]('0' + $env:BRX_HWND)
  $monitor = [int]('0' + $env:BRX_MONITOR)
  $minimized = $false
  if ($hwnd) {
    if (-not [BrShot]::Exists($hwnd)) { Fail 'NO_WINDOW' 'That window is not open any more.' }
    # The id was looked up in an earlier run: it must still belong to the same program (ids are reused).
    if ($env:BRX_PID -and [string][BrShot]::Owner($hwnd) -ne $env:BRX_PID) { Fail 'NO_WINDOW' 'That window closed meanwhile.' }
    $minimized = [BrShot]::IsMinimized($hwnd)
    $bmp = [BrShot]::Window($hwnd)
    $kind = 'window'
  } else {
    $count = ([BrShot]::Monitors()).Count
    if ($monitor -gt $count) { Fail 'NO_MONITOR' "There is no monitor $monitor (this PC has $count)." @{ monitors = $count } }
    try { $bmp = [BrShot]::Screen($monitor) } catch { Fail 'SCREEN_LOCKED' 'Windows gave no picture of the screen (locked, or a remote session without a display).' }
    $kind = $(if ($monitor) { 'monitor' } else { 'screen' })
  }
  if (-not $bmp) { Fail 'CAPTURE_FAILED' 'Windows could not take the picture.' }
  $script:taken = $true
  try {
    $out = @{ ok = $true; kind = $kind; width = $bmp.Width; height = $bmp.Height; minimized = $minimized }
    if ($action -eq 'ocr') {
      $r = Invoke-Ocr (Get-OcrBytes $bmp) $env:BRX_LANG
      $out.language = $r.language; $out.lines = $r.lines
    }
    if ($env:BRX_IMAGE -eq '1') {
      $p = [BrShot]::Pack($bmp, [int]$env:BRX_MAXSIDE, [int]$env:BRX_MAXBYTES)
      if (-not $p) { Fail 'IMAGE_TOO_LARGE' 'The picture could not be made small enough.' }
      $out.mime = 'image/jpeg'; $out.data = [Convert]::ToBase64String($p.Data); $out.outWidth = $p.W; $out.outHeight = $p.H; $out.bytes = $p.Data.Length
    }
    # The full-size copy last: no file is left on disk when an earlier step failed.
    if ($env:BRX_SAVE) {
      try { [BrShot]::Save($bmp, $env:BRX_SAVE) } catch {
        $h = $_.Exception.HResult; if ($_.Exception.InnerException) { $h = $_.Exception.InnerException.HResult }
        if ($h -eq -2147024816 -or $h -eq -2147024713) { Fail 'EXISTS' 'A file with this name appeared meanwhile; nothing was overwritten.' }
        throw
      }
      $out.saved = $env:BRX_SAVE
    }
    Out-Json $out
  } finally { $bmp.Dispose() }
} catch {
  Out-Json @{ ok = $false; code = 'PS_ERROR'; message = [string]$_.Exception.Message; taken = [bool]$script:taken }
}
