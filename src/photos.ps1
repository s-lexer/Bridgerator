# LOGIC: see critical-logic/bridge.md ("Extra tools" / photos). Photo metadata and conversion with the
# imaging built into Windows (WIC through PresentationCore) - no extra programs.
# In: BRX_MODE = info | convert; stdin = base64 of UTF-8 JSON:
#   info:    { files: [path...], gps: bool }
#   convert: { items: [{ src, dst }], maxSize: int (0 = keep), quality: 1-100, format: 'jpg' | 'png' }
# Tags are read by numeric id (EXIF 36867 DateTimeOriginal, 271 Make, 272 Model, 274 Orientation,
# GPS 1-4), never by localized names. A new file is created with CreateNew: nothing is overwritten.
# Out: ONE JSON line { items: [...] }; per-file problems are codes (NO_CODEC, DECODE_FAILED, EXISTS...).
Add-Type -AssemblyName PresentationCore, WindowsBase
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)) }
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())) | ConvertFrom-Json

function Q($md, $q) { try { return $md.GetQuery($q) } catch { return $null } }
function Get-Prefix($md) {
  if (-not $md) { return $null }
  foreach ($p in @('/app1/ifd', '/ifd')) { if ((Q $md "$p/{ushort=271}") -ne $null -or (Q $md "$p/exif") -ne $null -or (Q $md "$p/{ushort=274}") -ne $null) { return $p } }
  return $null
}
function Err-Code($e) {
  $h = $e.Exception.HResult
  if ($e.Exception.InnerException) { $h = $e.Exception.InnerException.HResult }
  if ($h -eq -2003292336) { return 'NO_CODEC' }          # 0x88982F50 WINCODEC_ERR_COMPONENTNOTFOUND
  if ($e.Exception -is [System.IO.FileNotFoundException]) { return 'NOT_FOUND' }
  if ($e.Exception -is [System.UnauthorizedAccessException]) { return 'NO_ACCESS' }
  if ($e.Exception -is [System.IO.IOException]) { return 'IO' }
  return 'DECODE_FAILED'
}
function Open-Frame($path, $cache) {
  $fs = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $dec = [Windows.Media.Imaging.BitmapDecoder]::Create($fs, [Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat -bor [Windows.Media.Imaging.BitmapCreateOptions]::IgnoreColorProfile, $cache)
    return @{ fs = $fs; dec = $dec; frame = $dec.Frames[0] }
  } catch { $fs.Dispose(); throw }
}
function Rationals($v) {
  if ($v -eq $null) { return $null }
  $out = @()
  foreach ($x in @($v)) {
    $u = [uint64]$x
    $num = [double]($u -band [uint64]4294967295); $den = [double]($u -shr 32)
    $out += $(if ($den -eq 0) { 0 } else { $num / $den })
  }
  return $out
}
function Deg($v, $ref) {
  $r = Rationals $v
  if (-not $r -or $r.Count -lt 1) { return $null }
  $d = $r[0]; if ($r.Count -gt 1) { $d += $r[1] / 60 }; if ($r.Count -gt 2) { $d += $r[2] / 3600 }
  if ("$ref" -match '^[SW]') { $d = -$d }
  return [math]::Round($d, 6)
}

if ($env:BRX_MODE -eq 'info') {
  $items = New-Object System.Collections.ArrayList
  foreach ($p in @($req.files)) {
    $o = @{ path = [string]$p }
    $h = $null
    try {
      $h = Open-Frame $p ([Windows.Media.Imaging.BitmapCacheOption]::None)
      $f = $h.frame
      $o.width = $f.PixelWidth; $o.height = $f.PixelHeight
      $md = $f.Metadata -as [Windows.Media.Imaging.BitmapMetadata]
      if ($md) { try { $o.format = [string]$md.Format } catch { } }
      $pre = Get-Prefix $md
      if ($pre) {
        $dt = Q $md "$pre/exif/{ushort=36867}"
        if (-not $dt) { $dt = Q $md "$pre/exif/{ushort=36868}" }
        if (-not $dt) { $dt = Q $md "$pre/{ushort=306}" }
        if ($dt) { $o.taken = ([string]$dt).Trim([char]0, ' ') }
        $mk = Q $md "$pre/{ushort=271}"; if ($mk) { $o.make = ([string]$mk).Trim([char]0, ' ') }
        $ml = Q $md "$pre/{ushort=272}"; if ($ml) { $o.model = ([string]$ml).Trim([char]0, ' ') }
        $or = Q $md "$pre/{ushort=274}"; if ($or -ne $null) { $o.orientation = [int]$or }
        $gl = Q $md "$pre/gps/{ushort=2}"
        if ($gl -ne $null) {
          $o.hasGps = $true
          if ($req.gps -eq $true) {
            $o.gps = @{ lat = (Deg $gl (Q $md "$pre/gps/{ushort=1}")); lon = (Deg (Q $md "$pre/gps/{ushort=4}") (Q $md "$pre/gps/{ushort=3}")) }
          }
        }
      }
    } catch { $o.error = Err-Code $_ } finally { if ($h) { $h.fs.Dispose() } }
    [void]$items.Add($o)
  }
  Out-Json @{ items = @($items) }
  exit 0
}

if ($env:BRX_MODE -eq 'convert') {
  $max = [int]$req.maxSize; $q = [int]$req.quality; if ($q -lt 1 -or $q -gt 100) { $q = 85 }
  $items = New-Object System.Collections.ArrayList
  foreach ($it in @($req.items)) {
    $o = @{ src = [string]$it.src; dst = [string]$it.dst }
    $h = $null; $out = $null
    try {
      $h = Open-Frame $it.src ([Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
      $f = $h.frame
      $md = $f.Metadata -as [Windows.Media.Imaging.BitmapMetadata]
      $pre = Get-Prefix $md
      $orient = 1; if ($pre) { $v = Q $md "$pre/{ushort=274}"; if ($v -ne $null) { $orient = [int]$v } }
      $w = $f.PixelWidth; $hgt = $f.PixelHeight
      $s = 1.0; $big = [math]::Max($w, $hgt)
      if ($max -gt 0 -and $big -gt $max) { $s = $max / $big }
      $tg = New-Object Windows.Media.TransformGroup
      if ($s -ne 1.0) { $tg.Children.Add((New-Object Windows.Media.ScaleTransform $s, $s)) }
      # EXIF orientation applied to the pixels (the new file carries no metadata, so it stays upright).
      switch ($orient) {
        2 { $tg.Children.Add((New-Object Windows.Media.ScaleTransform -1, 1)) }
        3 { $tg.Children.Add((New-Object Windows.Media.RotateTransform 180)) }
        4 { $tg.Children.Add((New-Object Windows.Media.ScaleTransform 1, -1)) }
        5 { $tg.Children.Add((New-Object Windows.Media.RotateTransform 90)); $tg.Children.Add((New-Object Windows.Media.ScaleTransform -1, 1)) }
        6 { $tg.Children.Add((New-Object Windows.Media.RotateTransform 90)) }
        7 { $tg.Children.Add((New-Object Windows.Media.RotateTransform 270)); $tg.Children.Add((New-Object Windows.Media.ScaleTransform -1, 1)) }
        8 { $tg.Children.Add((New-Object Windows.Media.RotateTransform 270)) }
      }
      $img = [Windows.Media.Imaging.BitmapSource]$f
      if ($tg.Children.Count -gt 0) { $img = New-Object Windows.Media.Imaging.TransformedBitmap $img, $tg }
      if ($req.format -eq 'png') { $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder }
      else {
        $enc = New-Object Windows.Media.Imaging.JpegBitmapEncoder; $enc.QualityLevel = $q
        # JPEG has no transparency: flatten onto white (else transparent parts turn black). Formats with
        # alpha: Bgra32 / Pbgra32 / Rgba64 / Prgba64 / Rgba128Float...; Indexed* may carry a transparent colour.
        if ([string]$img.Format -cmatch '^(Bgra|Pbgra|Rgba|Prgba|Indexed)') {
          $pw = $img.PixelWidth; $ph = $img.PixelHeight
          $dv = New-Object Windows.Media.DrawingVisual; $dc = $dv.RenderOpen()
          $rect = New-Object Windows.Rect 0, 0, $pw, $ph
          $dc.DrawRectangle([Windows.Media.Brushes]::White, $null, $rect); $dc.DrawImage($img, $rect); $dc.Close()
          $rtb = New-Object Windows.Media.Imaging.RenderTargetBitmap $pw, $ph, 96, 96, ([Windows.Media.PixelFormats]::Pbgra32)
          $rtb.Render($dv)
          $img = New-Object Windows.Media.Imaging.FormatConvertedBitmap $rtb, ([Windows.Media.PixelFormats]::Bgr24), $null, 0
        }
      }
      $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($img))
      $out = [IO.File]::Open($it.dst, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $enc.Save($out); $out.Dispose(); $out = $null
      $o.ok = $true; $o.width = $img.PixelWidth; $o.height = $img.PixelHeight; $o.bytes = (Get-Item -LiteralPath $it.dst).Length
    } catch {
      $o.error = $(if ($_.Exception -is [System.IO.IOException] -and (Test-Path -LiteralPath $it.dst) -and -not $out) { 'EXISTS' } else { Err-Code $_ })
      if ($out) { $out.Dispose(); Remove-Item -LiteralPath $it.dst -Force -ErrorAction SilentlyContinue }
    } finally { if ($h) { $h.fs.Dispose() } }
    [void]$items.Add($o)
  }
  Out-Json @{ items = @($items) }
  exit 0
}
Out-Json @{ error = 'BAD_MODE' }
