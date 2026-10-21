# Bridgerator: move files / folders to the Recycle Bin (never a permanent delete). Loaded after
# ask-lib.ps1 (Add-CachedType). Reads a JSON list of absolute paths on stdin, prints one JSON line:
# [{p, r}] with r = 'recycled' | 'nobin' (this drive has no Recycle Bin / the item is too big for it:
# nothing was deleted) | 'missing' | 'error:<hresult>'; a recycled item also carries bin = the path of
# its copy in the Recycle Bin ($R...), so Undo later removes exactly that copy and no other.
# IFileOperation with FOFX_RECYCLEONDELETE and no UI; a progress sink checks PreDeleteItem: without
# TSF_DELETE_RECYCLE_IF_POSSIBLE the shell would delete for good, so the item is aborted instead.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-CachedType @'
using System; using System.IO; using System.Runtime.InteropServices;
[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IBrShellItem { void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv); void GetParent(out IBrShellItem ppsi); void GetDisplayName(uint sigdn, out IntPtr name); void GetAttributes(uint mask, out uint attrs); void Compare(IBrShellItem psi, uint hint, out int order); }
[ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IBrSink {
  [PreserveSig] int StartOperations();
  [PreserveSig] int FinishOperations(int hr);
  [PreserveSig] int PreRenameItem(uint f, IBrShellItem i, [MarshalAs(UnmanagedType.LPWStr)] string n);
  [PreserveSig] int PostRenameItem(uint f, IBrShellItem i, [MarshalAs(UnmanagedType.LPWStr)] string n, int hr, IBrShellItem c);
  [PreserveSig] int PreMoveItem(uint f, IBrShellItem i, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n);
  [PreserveSig] int PostMoveItem(uint f, IBrShellItem i, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, int hr, IBrShellItem c);
  [PreserveSig] int PreCopyItem(uint f, IBrShellItem i, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n);
  [PreserveSig] int PostCopyItem(uint f, IBrShellItem i, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, int hr, IBrShellItem c);
  [PreserveSig] int PreDeleteItem(uint f, IBrShellItem i);
  [PreserveSig] int PostDeleteItem(uint f, IBrShellItem i, int hr, IBrShellItem c);
  [PreserveSig] int PreNewItem(uint f, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n);
  [PreserveSig] int PostNewItem(uint f, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, [MarshalAs(UnmanagedType.LPWStr)] string t, uint a, int hr, IBrShellItem c);
  [PreserveSig] int UpdateProgress(uint total, uint sofar);
  [PreserveSig] int ResetTimer();
  [PreserveSig] int PauseTimer();
  [PreserveSig] int ResumeTimer();
}
[ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IBrFileOperation {
  uint Advise(IBrSink s); void Unadvise(uint c); void SetOperationFlags(uint f);
  void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string m); void SetProgressDialog([MarshalAs(UnmanagedType.IUnknown)] object d);
  void SetProperties([MarshalAs(UnmanagedType.IUnknown)] object p); void SetOwnerWindow(IntPtr h);
  void ApplyPropertiesToItem(IBrShellItem i); void ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object i);
  void RenameItem(IBrShellItem i, [MarshalAs(UnmanagedType.LPWStr)] string n, IBrSink s); void RenameItems([MarshalAs(UnmanagedType.IUnknown)] object i, [MarshalAs(UnmanagedType.LPWStr)] string n);
  void MoveItem(IBrShellItem i, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, IBrSink s); void MoveItems([MarshalAs(UnmanagedType.IUnknown)] object i, IBrShellItem d);
  void CopyItem(IBrShellItem i, IBrShellItem d, [MarshalAs(UnmanagedType.LPWStr)] string n, IBrSink s); void CopyItems([MarshalAs(UnmanagedType.IUnknown)] object i, IBrShellItem d);
  void DeleteItem(IBrShellItem i, IBrSink s); void DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object i);
  void NewItem(IBrShellItem d, uint a, [MarshalAs(UnmanagedType.LPWStr)] string n, [MarshalAs(UnmanagedType.LPWStr)] string t, IBrSink s);
  void PerformOperations(); [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
}
public class BrRecycleSink : IBrSink {
  public bool Seen, ToBin; public int Hr; public string Bin;
  public int PreDeleteItem(uint f, IBrShellItem i) { Seen = true; ToBin = (f & 0x80) != 0; return ToBin ? 0 : unchecked((int)0x80004004); }
  public int PostDeleteItem(uint f, IBrShellItem i, int hr, IBrShellItem c) {
    Hr = hr;
    // c = the item now in the Recycle Bin (null when deleted for good): its file-system path (SIGDN_FILESYSPATH).
    if (c != null) { try { IntPtr n; c.GetDisplayName(0x80058000, out n); Bin = Marshal.PtrToStringUni(n); Marshal.FreeCoTaskMem(n); } catch { Bin = null; } }
    return 0;
  }
  public int StartOperations() { return 0; } public int FinishOperations(int hr) { return 0; }
  public int PreRenameItem(uint f, IBrShellItem i, string n) { return 0; } public int PostRenameItem(uint f, IBrShellItem i, string n, int hr, IBrShellItem c) { return 0; }
  public int PreMoveItem(uint f, IBrShellItem i, IBrShellItem d, string n) { return 0; } public int PostMoveItem(uint f, IBrShellItem i, IBrShellItem d, string n, int hr, IBrShellItem c) { return 0; }
  public int PreCopyItem(uint f, IBrShellItem i, IBrShellItem d, string n) { return 0; } public int PostCopyItem(uint f, IBrShellItem i, IBrShellItem d, string n, int hr, IBrShellItem c) { return 0; }
  public int PreNewItem(uint f, IBrShellItem d, string n) { return 0; } public int PostNewItem(uint f, IBrShellItem d, string n, string t, uint a, int hr, IBrShellItem c) { return 0; }
  public int UpdateProgress(uint t, uint s) { return 0; } public int ResetTimer() { return 0; } public int PauseTimer() { return 0; } public int ResumeTimer() { return 0; }
}
public static class BrRecycle {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IBrShellItem item);
  // FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_NOCONFIRMMKDIR | FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE
  const uint FLAGS = 0x0004 | 0x0010 | 0x0400 | 0x0200 | 0x0040 | 0x00080000 | 0x00100000;
  public static string LastBin;
  public static string One(string path) {
    LastBin = null;
    if (!File.Exists(path) && !Directory.Exists(path)) return "missing";
    try {
      var root = Path.GetPathRoot(path);
      if (string.IsNullOrEmpty(root) || root.StartsWith(@"\\")) return "nobin";
      var dt = new DriveInfo(root).DriveType;
      if (dt != DriveType.Fixed && dt != DriveType.Removable) return "nobin";
    } catch { return "nobin"; }
    var op = (IBrFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
    var sink = new BrRecycleSink();
    try {
      op.SetOperationFlags(FLAGS);
      IBrShellItem item; SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IBrShellItem).GUID, out item);
      op.DeleteItem(item, sink);
      try { op.PerformOperations(); } catch (COMException e) { if (sink.Seen && !sink.ToBin) return "nobin"; return "error:" + e.ErrorCode.ToString("x8"); }
      if (sink.Seen && !sink.ToBin) return "nobin";
      if (sink.Hr < 0) return "error:" + sink.Hr.ToString("x8");
      if (!sink.Seen || File.Exists(path) || Directory.Exists(path)) return op.GetAnyOperationsAborted() ? "nobin" : "error:not-deleted";
      LastBin = sink.Bin;
      return "recycled";
    } catch (Exception e) { return "error:" + e.GetType().Name; }
    finally { Marshal.ReleaseComObject(op); }
  }
}
'@
$list = [Console]::In.ReadToEnd() | ConvertFrom-Json
# Each item: a path, or {p, skip}: skip = letters h / s / r - a hidden / system / read-only item is left
# alone ('skipped'), as the command itself would (a wildcard without -Force / /a / /f).
function Test-Skip([string]$path, [string]$skip) {
  if (-not $skip) { return $false }
  try { $a = [IO.File]::GetAttributes($path) } catch { return $false }
  return (($skip.Contains('h') -and ($a -band [IO.FileAttributes]::Hidden)) -or ($skip.Contains('s') -and ($a -band [IO.FileAttributes]::System)) -or ($skip.Contains('r') -and ($a -band [IO.FileAttributes]::ReadOnly)))
}
$out = @(foreach ($x in @($list)) {
  if ($x -is [string]) { $p = $x; $skip = '' } else { $p = [string]$x.p; $skip = [string]$x.skip }
  if (Test-Skip $p $skip) { @{ p = $p; r = 'skipped' } } else {
    $r = [BrRecycle]::One($p)
    if ($r -eq 'recycled' -and [BrRecycle]::LastBin) { @{ p = $p; r = $r; bin = [BrRecycle]::LastBin } } else { @{ p = $p; r = $r } }
  }
})
[Console]::Out.WriteLine((ConvertTo-Json -InputObject @($out) -Compress -Depth 3))
