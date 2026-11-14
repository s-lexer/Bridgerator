# Windows PowerShell 5.1. Input: BRX_UIA = base64(UTF-8 JSON). Output: exactly ONE JSON line.
# All UIA work is in this expendable worker. The Node caller enforces the hard process deadline.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
# LOGIC: see critical-logic/bridge.md ("Extra tools", apps). Loaded as text by runFilesPs (no -File).
# Compiled helper cached like screen.ps1's (%LOCALAPPDATA%\Bridgerator\cache, br-<hash>.dll): one compile, not one per call.
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
        if ([IO.File]::Exists($dll)) { try { [IO.File]::Delete($tmp) } catch { } } else { $dll = $tmp }
      }
    }
    Add-Type -Path $dll
  } catch {
    Add-Type -TypeDefinition $code -ReferencedAssemblies $refs
  }
}
try {
  if (-not $env:BRX_UIA -or $env:BRX_UIA.Length -gt 200000) { throw 'BAD_ARGS' }
  $utf8 = New-Object Text.UTF8Encoding($false, $true)
  $inputJson = $utf8.GetString([Convert]::FromBase64String($env:BRX_UIA))
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Web.Extensions
  Add-CachedType -refs UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Web.Extensions, System.Core @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

public sealed class UiaFault : Exception {
  public string Code;
  public UiaFault(string code) : base(code) { Code = code; }
}
public static class BrUia {
  const int ShownCap = 150, ScanCap = 2000, DepthCap = 8, WalkMs = 4000;
  static readonly TreeWalker Walker = TreeWalker.ControlViewWalker;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4000000, RecursionLimit = 64 };
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flag);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int idx, StringBuilder b, int n, out int needed);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int key, out int v, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int key, IntPtr info, int n, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint n);

  static Dictionary<string, object> Obj(params object[] pairs) {
    var d = new Dictionary<string, object>();
    for (int i=0; i<pairs.Length; i+=2) d.Add((string)pairs[i], pairs[i+1]);
    return d;
  }
  static void Fault(string code) { throw new UiaFault(code); }
  static string Text(object o) { return o == null ? "" : Convert.ToString(o, CultureInfo.InvariantCulture); }
  // Cap raw locator text too. Exact equality on this projection is used in BOTH enumeration and re-find.
  static string Cap(string s) {
    s = s ?? "";
    if (s.Length <= 200) return s;
    int len = 200;
    if (char.IsHighSurrogate(s[len-1])) len--;
    return s.Substring(0, len);
  }
  static string Display(string s) {
    var b = new StringBuilder();
    foreach (char c in Cap(s)) b.Append(char.IsControl(c) || c == '\u2028' || c == '\u2029' ? ' ' : c);
    return b.ToString();
  }
  static string Quote(string s) { return Json.Serialize(Display(s)); }
  static string Str(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) ? Text(v) : ""; }
  static long Num(Dictionary<string, object> d, string key, long def) {
    object v; long n;
    if (!d.TryGetValue(key, out v)) return def;
    if (v == null || v is bool || v is string || !long.TryParse(Text(v), out n)) { Fault("BAD_ARGS"); return 0; }
    return n;
  }
  static Dictionary<string, object> Dict(Dictionary<string, object> d, string key) {
    object v;
    return d.TryGetValue(key, out v) ? v as Dictionary<string, object> : null;
  }
  static bool Has(Dictionary<string, object> d, string key) { return d.ContainsKey(key); }
  static string DesktopName(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    var b = new StringBuilder(256); int n;
    return GetUserObjectInformation(h, 2, b, b.Capacity*2, out n) ? b.ToString() : "";
  }
  static void Session() {
    IntPtr h = OpenInputDesktop(0, false, 1);
    if (h == IntPtr.Zero) Fault("SESSION_LOCKED");
    try {
      if (!String.Equals(DesktopName(h), "Default", StringComparison.OrdinalIgnoreCase)
          || !String.Equals(DesktopName(GetThreadDesktop(GetCurrentThreadId())), "Default", StringComparison.OrdinalIgnoreCase))
        Fault("SESSION_LOCKED");
    } finally { CloseDesktop(h); }
    // Also catches prompts configured to use the interactive (non-secure) desktop.
    IntPtr fg = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(fg, out pid);
    if (pid != 0) {
      string name = "";
      try { using (var p = Process.GetProcessById((int)pid)) name = p.ProcessName; } catch { Fault("SESSION_LOCKED"); }
      if (SecurityProcess(name)) Fault("SESSION_LOCKED");
    }
  }
  static bool SecurityProcess(string p) {
    return String.Equals(p, "consent", StringComparison.OrdinalIgnoreCase)
      || String.Equals(p, "CredentialUIBroker", StringComparison.OrdinalIgnoreCase)
      || String.Equals(p, "LogonUI", StringComparison.OrdinalIgnoreCase)
      || String.Equals(p, "winlogon", StringComparison.OrdinalIgnoreCase);
  }
  // ShellExperienceHost = Windows notifications: a Bridgerator question shown as a toast has its Allow button there (review 14.11).
  static bool Own(string program, string title) {
    return String.Equals(program, "bridgerator", StringComparison.OrdinalIgnoreCase)
      || String.Equals(program, "ShellExperienceHost", StringComparison.OrdinalIgnoreCase)
      || Array.IndexOf(new string[] { "cmd", "powershell", "pwsh", "powershell_ise", "windowsterminal", "wt", "conhost", "openconsole", "wsl", "bash", "mintty" }, (program ?? "").ToLowerInvariant()) >= 0
      || (title ?? "").StartsWith("Bridgerator", StringComparison.OrdinalIgnoreCase);
  }
  static void TokenGuard(uint pid) {
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) Fault("ELEVATED_TARGET");
    IntPtr token = IntPtr.Zero, buf = IntPtr.Zero;
    try {
      if (!OpenProcessToken(p, 8, out token)) Fault("ELEVATED_TARGET");
      int n;
      buf = Marshal.AllocHGlobal(4);
      if (!GetTokenInformation(token, 20, buf, 4, out n)) Fault("ELEVATED_TARGET");
      if (Marshal.ReadInt32(buf) != 0) Fault("ELEVATED_TARGET");
      Marshal.FreeHGlobal(buf); buf = IntPtr.Zero;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out n);
      if (n <= 0 || n > 65536) Fault("ELEVATED_TARGET");
      buf = Marshal.AllocHGlobal(n);
      if (!GetTokenInformation(token, 25, buf, n, out n)) Fault("ELEVATED_TARGET");
      IntPtr sid = Marshal.ReadIntPtr(buf);
      IntPtr count = GetSidSubAuthorityCount(sid);
      if (count == IntPtr.Zero) Fault("ELEVATED_TARGET");
      byte c = Marshal.ReadByte(count);
      if (c == 0 || (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(c-1))) >= 0x3000) Fault("ELEVATED_TARGET");
    } finally {
      if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
      if (token != IntPtr.Zero) CloseHandle(token);
      CloseHandle(p);
    }
  }
  sealed class Win {
    public long Id; public uint Pid; public string Title, Program, Started, Blocked;
    public Dictionary<string, object> Wire() {
      var d = Obj("id", Id, "title", Display(Title), "program", Display(Program), "pid", Pid, "started", Started);
      if (Blocked != null) d["blocked"] = Blocked;
      return d;
    }
  }
  static Win Window(IntPtr h) {
    if (!IsWindow(h) || !IsWindowVisible(h)) return null;
    int cloaked;
    try { if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return null; } catch (DllNotFoundException) {}
    var b = new StringBuilder(32768); GetWindowText(h, b, b.Capacity);
    if (b.Length == 0) return null;
    uint pid; GetWindowThreadProcessId(h, out pid);
    var w = new Win { Id=h.ToInt64(), Pid=pid, Title=b.ToString(), Program="", Started="" };
    try {
      using (var p = Process.GetProcessById((int)pid)) {
        w.Program = p.ProcessName; w.Started = p.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
      }
    } catch { w.Blocked = "ELEVATED_TARGET"; }
    if (SecurityProcess(w.Program)) w.Blocked = "SESSION_LOCKED";
    else if (Own(w.Program, w.Title)) w.Blocked = "OWN_WINDOW";
    else if (w.Blocked == null) {
      try { TokenGuard(pid); } catch (UiaFault e) { w.Blocked = e.Code; }
    }
    return w;
  }
  static List<Win> Windows() {
    Session();
    var list = new List<Win>();
    EnumWindows(delegate(IntPtr h, IntPtr l) { var w=Window(h); if (w!=null) list.Add(w); return true; }, IntPtr.Zero);
    return list;
  }
  static Win Guard(Dictionary<string, object> id) {
    Session();
    if (id == null) { Fault("BAD_ARGS"); return null; }
    long hwnd = Num(id, "id", 0), pid = Num(id, "pid", 0);
    if (hwnd <= 0 || pid <= 0 || Str(id,"started") == "") Fault("BAD_ARGS");
    var w = Window(new IntPtr(hwnd));
    if (w == null || w.Pid != pid || w.Started != Str(id,"started")) Fault("STALE_REF");
    if (w.Blocked != null) Fault(w.Blocked);
    return w;
  }
  sealed class Budget {
    public readonly Stopwatch Clock = Stopwatch.StartNew();
    public int Scanned; public int Millis; public bool Incomplete;
    public readonly HashSet<int> Allowed = new HashSet<int>();
    public Budget(int ms) { Millis=ms; }
    public bool Time() { if (Clock.ElapsedMilliseconds < Millis) return true; Incomplete=true; return false; }
  }
  static void ElementGuard(AutomationElement e, Budget b) {
    object v = e.GetCurrentPropertyValue(AutomationElement.ProcessIdProperty, true);
    if (!(v is int) || (int)v <= 0) Fault("ELEVATED_TARGET");
    int pid = (int)v;
    if (b.Allowed.Contains(pid)) return;
    string program;
    try { using (var p=Process.GetProcessById(pid)) program=p.ProcessName; } catch { Fault("ELEVATED_TARGET"); return; }
    if (SecurityProcess(program)) Fault("SESSION_LOCKED");
    if (Own(program, "")) Fault("OWN_WINDOW");
    TokenGuard((uint)pid);
    b.Allowed.Add(pid);
  }
  sealed class Step {
    public string Role, Aid, Name;
    public int Nth, Dup;
    public string Key { get { return Json.Serialize(new string[] { Role, Aid, Name }); } }
    public Dictionary<string, object> Wire() { return Obj("role",Role,"aid",Aid,"name",Name,"nth",Nth,"dup",Dup); }
  }
  static Step Locator(AutomationElement e, Budget b) {
    ElementGuard(e,b);
    // ignoreDefaultValue=false: ControlType's default (Custom) comes back as NotSupported otherwise (14.11: Explorer).
    var role = (e.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, false) as ControlType) ?? ControlType.Custom;
    object aid = e.GetCurrentPropertyValue(AutomationElement.AutomationIdProperty, true);
    object name = e.GetCurrentPropertyValue(AutomationElement.NameProperty, true);
    if (role == null) Fault("UIA_UNAVAILABLE");
    string r = role.ProgrammaticName;
    int dot = r.LastIndexOf('.');
    return new Step { Role=r.Substring(dot+1).ToLowerInvariant(), Aid=Cap(aid as string), Name=Cap(name as string) };
  }
  sealed class Child { public AutomationElement E; public Step S; }
  // Enumerate the complete sibling set BEFORE assigning refs. A truncated set never creates refs.
  static List<Child> Children(AutomationElement parent, Budget b, bool strict) {
    var kids = new List<Child>();
    if (!b.Time()) { if (strict) Fault("TIMEOUT"); return null; }
    var c = Walker.GetFirstChild(parent);
    while (c != null) {
      if (!b.Time() || b.Scanned >= ScanCap) {
        b.Incomplete=true;
        if (strict) Fault("TIMEOUT");
        return null;
      }
      b.Scanned++;
      try { kids.Add(new Child { E=c, S=Locator(c,b) }); }
      catch (ElementNotAvailableException) { if (strict) Fault("STALE_REF"); b.Incomplete=true; return null; }
      if (!b.Time()) { if (strict) Fault("TIMEOUT"); return null; }
      c = Walker.GetNextSibling(c);
    }
    if (!b.Time()) { if (strict) Fault("TIMEOUT"); return null; }
    var total = new Dictionary<string,int>(); var seen=new Dictionary<string,int>();
    foreach (var k in kids) { string key=k.S.Key; int n; total.TryGetValue(key,out n); total[key]=n+1; }
    foreach (var k in kids) {
      string key=k.S.Key; int n; seen.TryGetValue(key,out n);
      k.S.Nth=n; k.S.Dup=total[key]; seen[key]=n+1;
    }
    return kids;
  }
  // IsPassword not a bool (provider error) = sensitive: Value is never read then. ignoreDefaultValue=false: with true
  // every element whose IsPassword is the default (false) came back NotSupported and counted as a password (14.11).
  static bool Sensitive(AutomationElement e) {
    try {
      object p=e.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty, false);
      return !(p is bool) || (bool)p;
    } catch (UnauthorizedAccessException) { Fault("ELEVATED_TARGET"); return true; }
      catch (ElementNotAvailableException) { throw; }
      catch (Exception e2) {
        if (e2.HResult == unchecked((int)0x80070005)) Fault("ELEVATED_TARGET");
        return true;
      }
  }
  static bool Bool(AutomationElement e, AutomationProperty p) {
    object v=e.GetCurrentPropertyValue(p,true);
    return v is bool && (bool)v;
  }
  static object Pattern(AutomationElement e, AutomationPattern p) {
    object value;
    return e.TryGetCurrentPattern(p,out value) ? value : null;
  }
  sealed class Details {
    public readonly List<string> Actions=new List<string>();
    public bool Visible, Password; public string Value;
  }
  static Details Read(AutomationElement e) {
    var d=new Details();
    object off=e.GetCurrentPropertyValue(AutomationElement.IsOffscreenProperty,true);
    d.Visible = off is bool && !(bool)off;
    if (!d.Visible) return d;
    d.Password=Sensitive(e);
    if (Bool(e, AutomationElement.IsEnabledProperty)) {
      if (Pattern(e,InvokePattern.Pattern)!=null) d.Actions.Add("invoke");
      if (!d.Password && Pattern(e,ValuePattern.Pattern)!=null) d.Actions.Add("value");
      if (Pattern(e,TogglePattern.Pattern)!=null) d.Actions.Add("toggle");
      if (Pattern(e,ExpandCollapsePattern.Pattern)!=null) { d.Actions.Add("expand"); d.Actions.Add("collapse"); }
      if (Pattern(e,SelectionItemPattern.Pattern)!=null) d.Actions.Add("select");
      if (Bool(e,AutomationElement.IsKeyboardFocusableProperty)) d.Actions.Add("focus");
    }
    // Do not read TextPattern or bulk document text. Recheck sensitivity immediately before Value.
    if (!d.Password) {
      var v=Pattern(e,ValuePattern.Pattern) as ValuePattern;
      if (v!=null && !Sensitive(e)) d.Value=Cap(v.Current.Value);
    }
    return d;
  }
  sealed class Node {
    public AutomationElement E; public Step S; public List<Step> Chain;
    public int Depth, Indent;
  }
  static Dictionary<string,object> Snapshot(Win w) {
    var budget=new Budget(WalkMs);
    var root=AutomationElement.FromHandle(new IntPtr(w.Id));
    budget.Scanned=1;
    var q=new Queue<Node>();
    q.Enqueue(new Node { E=root, S=Locator(root,budget), Chain=new List<Step>(), Depth=0, Indent=0 });
    var refs=new Dictionary<string,object>();
    var lines=new List<string>();
    while (q.Count>0) {
      if (!budget.Time()) break;
      if (lines.Count>=ShownCap) { budget.Incomplete=true; break; }
      var n=q.Dequeue(); Details d;
      try { d=Read(n.E); } catch (ElementNotAvailableException) { budget.Incomplete=true; continue; }
      if (!budget.Time()) break;
      bool emit=d.Visible && (n.S.Name.Length>0 || d.Actions.Count>0);
      if (emit) {
        string key="e"+(lines.Count+1).ToString(CultureInfo.InvariantCulture);
        var chain=new List<object>(); foreach (var s in n.Chain) chain.Add(s.Wire());
        refs.Add(key,chain);
        string line=new string(' ',n.Indent*2)+key+" "+n.S.Role+" "+Quote(n.S.Name);
        if (!d.Password && d.Value!=null) line+=" ="+Quote(d.Value);
        var tags=new List<string>(d.Actions);
        if (d.Password) tags.Add("password");
        if (!Bool(n.E,AutomationElement.IsEnabledProperty)) tags.Add("disabled");
        if (tags.Count>0) line+=" ["+String.Join(",",tags.ToArray())+"]";
        if (!budget.Time()) { refs.Remove(key); break; }
        lines.Add(line);
      }
      if (lines.Count>=ShownCap) { budget.Incomplete=true; break; }
      if (n.Depth>=DepthCap) {
        if (!budget.Time()) break;
        budget.Incomplete=true; // Depth budget reached; do not inspect any deeper node.
        continue;
      }
      var kids=Children(n.E,budget,false);
      if (kids==null) break;
      foreach (var k in kids) {
        var chain=new List<Step>(n.Chain); chain.Add(k.S);
        q.Enqueue(new Node { E=k.E, S=k.S, Chain=chain, Depth=n.Depth+1, Indent=n.Indent+(emit ? 1 : 0) });
      }
    }
    if (q.Count>0 || !budget.Time()) budget.Incomplete=true;
    // Recheck identity and security after reading: never silently attach a snapshot to a reused HWND.
    Guard(w.Wire());
    string text=String.Join("\n",lines.ToArray())+"\nincomplete="+(budget.Incomplete ? "true" : "false");
    return Obj("ok",true,"text",text,"refs",refs,"incomplete",budget.Incomplete,"scanned",budget.Scanned,"shown",lines.Count);
  }
  static List<Step> ParseChain(Dictionary<string,object> req) {
    object v; if (!req.TryGetValue("chain",out v) || !(v is object[])) { Fault("BAD_ARGS"); return null; }
    var arr=(object[])v; if (arr.Length>DepthCap) Fault("BAD_ARGS");
    var chain=new List<Step>();
    foreach (object o in arr) {
      var d=o as Dictionary<string,object>;
      if (d==null) Fault("BAD_ARGS");
      foreach (string key in new string[] { "role","aid","name" }) {
        if (!d.ContainsKey(key) || !(d[key] is string) || ((string)d[key]).Length>200) Fault("BAD_ARGS");
      }
      long nth=Num(d,"nth",-1), dup=Num(d,"dup",0);
      if (nth<0 || dup<1 || dup>ScanCap || nth>=dup) Fault("BAD_ARGS");
      chain.Add(new Step { Role=Str(d,"role"), Aid=Str(d,"aid"), Name=Str(d,"name"), Nth=(int)nth, Dup=(int)dup });
    }
    return chain;
  }
  static AutomationElement Resolve(Win w,List<Step> chain) {
    var budget=new Budget(WalkMs);
    var cur=AutomationElement.FromHandle(new IntPtr(w.Id));
    ElementGuard(cur,budget);
    foreach (var step in chain) {
      var kids=Children(cur,budget,true);
      var matches=new List<AutomationElement>();
      foreach (var k in kids) if (k.S.Key==step.Key) matches.Add(k.E);
      if (matches.Count==0) Fault("STALE_REF");
      if (matches.Count!=step.Dup) Fault("AMBIGUOUS_TARGET");
      cur=matches[step.Nth];
    }
    if (!budget.Time()) Fault("TIMEOUT");
    return cur;
  }
  static object NeedPattern(AutomationElement e,AutomationPattern p) {
    var value=Pattern(e,p); if (value==null) Fault("NO_PATTERN"); return value;
  }
  static void Focus(AutomationElement e) {
    if (!Bool(e,AutomationElement.IsKeyboardFocusableProperty)) Fault("NO_PATTERN");
    e.SetFocus();
    if (!Automation.Compare(e,AutomationElement.FocusedElement)) Fault("FOCUS_FAILED");
  }
  static Dictionary<string,object> Act(Dictionary<string,object> req) {
    var identity=Dict(req,"identity"); var w=Guard(identity);
    string kind=Str(req,"kind");
    if (Array.IndexOf(new string[] {"invoke","set_value","toggle","expand","collapse","select","focus","keys"},kind)<0) Fault("BAD_ARGS");
    if ((kind=="set_value" || kind=="keys") && (!Has(req,"text") || !(req["text"] is string) || Str(req,"text").Length>10000)) Fault("BAD_ARGS");
    var chain=ParseChain(req); var e=Resolve(w,chain);
    Guard(identity);
    ElementGuard(e,new Budget(WalkMs));
    if ((kind=="set_value" || kind=="keys") && Sensitive(e)) Fault("PASSWORD_FIELD");
    if (!Bool(e,AutomationElement.IsEnabledProperty)) Fault("DISABLED");
    object off=e.GetCurrentPropertyValue(AutomationElement.IsOffscreenProperty,true);
    if (!(off is bool) || (bool)off) Fault("NOT_VISIBLE");
    if (kind=="keys") {
      if (Str(req,"text").Length==0) Fault("BAD_ARGS");
      Focus(e);
      Guard(identity);
      var again=Resolve(w,chain);
      if (!Automation.Compare(e,again) || !Automation.Compare(again,AutomationElement.FocusedElement)) Fault("FOCUS_FAILED");
      if (Sensitive(again)) Fault("PASSWORD_FIELD");
      IntPtr fg=GetForegroundWindow();
      if (fg!=new IntPtr(w.Id) && GetAncestor(fg,2)!=new IntPtr(w.Id)) Fault("FOCUS_FAILED");
      Session();
      // Literal text only (review 14.11): every SendKeys special is escaped, so {TAB} / %{TAB} / ~ can't move the input
      // to another field or window after the checks above. Control characters are refused by the bridge.
      SendKeys.SendWait(System.Text.RegularExpressions.Regex.Replace(Str(req,"text"), "[+^%~(){}\\[\\]]", "{$0}"));
    } else if (kind=="focus") Focus(e);
    else if (kind=="invoke") ((InvokePattern)NeedPattern(e,InvokePattern.Pattern)).Invoke();
    else if (kind=="set_value") {
      var v=(ValuePattern)NeedPattern(e,ValuePattern.Pattern);
      if (Sensitive(e)) Fault("PASSWORD_FIELD");
      if (v.Current.IsReadOnly) Fault("READ_ONLY");
      v.SetValue(Str(req,"text"));
    } else if (kind=="toggle") ((TogglePattern)NeedPattern(e,TogglePattern.Pattern)).Toggle();
    else if (kind=="select") ((SelectionItemPattern)NeedPattern(e,SelectionItemPattern.Pattern)).Select();
    else {
      var p=(ExpandCollapsePattern)NeedPattern(e,ExpandCollapsePattern.Pattern);
      if (kind=="expand") p.Expand(); else p.Collapse();
    }
    // Never report an action error after the side effect already succeeded.
    try {
      Session();
      if (!IsWindow(new IntPtr(w.Id))) return Obj("ok",true,"acted",true,"window_closed",true);
      Guard(identity);
      var r=Snapshot(w); r["acted"]=true; return r;
    } catch (Exception ex) {
      return Obj("ok",true,"acted",true,"snapshot_error",Code(ex));
    }
  }
  // Wait probes use only locators, never values. A truncated search CANNOT prove disappearance.
  static Dictionary<string,object> ProbeElement(Win w,Dictionary<string,object> filter,int ms) {
    var budget=new Budget(ms);
    var q=new Queue<Node>();
    var root=AutomationElement.FromHandle(new IntPtr(w.Id));
    budget.Scanned=1;
    q.Enqueue(new Node { E=root, Depth=0, S=Locator(root,budget) });
    while (q.Count>0) {
      if (!budget.Time()) break;
      var n=q.Dequeue();
      object off=n.E.GetCurrentPropertyValue(AutomationElement.IsOffscreenProperty,true);
      if (off is bool && !(bool)off) {
        bool match=(Str(filter,"role")=="" || n.S.Role.IndexOf(Str(filter,"role"),StringComparison.OrdinalIgnoreCase)>=0)
          && (Str(filter,"name")=="" || n.S.Name.IndexOf(Str(filter,"name"),StringComparison.OrdinalIgnoreCase)>=0);
        if (match) return Obj("found",true,"complete",true);
      }
      if (n.Depth>=DepthCap) {
        budget.Incomplete=true; // Depth budget reached; do not inspect any deeper node.
        continue;
      }
      var kids=Children(n.E,budget,false);
      if (kids==null) break;
      foreach (var k in kids) q.Enqueue(new Node { E=k.E,S=k.S,Depth=n.Depth+1 });
    }
    return Obj("found",false,"complete",!budget.Incomplete && q.Count==0 && budget.Time());
  }
  static Dictionary<string,object> Wait(Dictionary<string,object> req) {
    long timeout=Num(req,"timeout_ms",5000);
    if (timeout<0 || timeout>15000) Fault("BAD_ARGS");
    string state=Str(req,"state"); if (state=="") state="appeared";
    if (state!="appeared" && state!="disappeared") Fault("BAD_ARGS");
    var filter=Dict(req,"element"); var identity=Dict(req,"identity");
    if (Has(req,"element") && filter==null) Fault("BAD_ARGS");
    if (filter!=null) {
      if (identity==null || (Str(filter,"role")=="" && Str(filter,"name")=="")) Fault("BAD_ARGS");
      foreach (var p in filter) if ((p.Key!="role" && p.Key!="name") || !(p.Value is string) || Text(p.Value).Length>200) Fault("BAD_ARGS");
    } else if (Str(req,"window")=="" && Num(req,"window_id",0)<=0) Fault("BAD_ARGS");
    var clock=Stopwatch.StartNew();
    bool met=false;
    do {
      Session();
      bool found=false, complete=true;
      if (filter==null) {
        var list=Windows();
        foreach (var w in list) {
          bool hit=Num(req,"window_id",0)>0 ? w.Id==Num(req,"window_id",0)
            : w.Title.IndexOf(Str(req,"window"),StringComparison.OrdinalIgnoreCase)>=0;
          if (hit) { if (w.Blocked!=null) Fault(w.Blocked); found=true; }
        }
      } else {
        Win w=null;
        try { w=Guard(identity); }
        catch (UiaFault ex) { if (ex.Code!="STALE_REF") throw; }
        if (w!=null) {
          int remaining=(int)Math.Max(1,timeout-clock.ElapsedMilliseconds);
          var p=ProbeElement(w,filter,Math.Min(WalkMs,remaining));
          found=(bool)p["found"]; complete=(bool)p["complete"];
          Guard(identity);
        }
      }
      met=state=="appeared" ? found : !found && complete;
      if (met || clock.ElapsedMilliseconds>=timeout) break;
      Thread.Sleep((int)Math.Max(0,Math.Min(150,timeout-clock.ElapsedMilliseconds)));
    } while (true);
    return Obj("ok",true,"met",met,"elapsed_ms",clock.ElapsedMilliseconds);
  }
  static string Code(Exception ex) {
    while (ex.InnerException!=null && !(ex is UiaFault)) ex=ex.InnerException;
    if (ex is UiaFault) return ((UiaFault)ex).Code;
    if (ex is UnauthorizedAccessException || ex.HResult==unchecked((int)0x80070005)) return "ELEVATED_TARGET";
    if (ex is ElementNotAvailableException) return "STALE_REF";
    if (ex is InvalidOperationException) return "UIA_UNAVAILABLE";
    if (ex is ArgumentException || ex is FormatException) return "BAD_ARGS";
    return "UIA_ERROR";
  }
  public static string Run(string json) {
    try {
      var req=Json.DeserializeObject(json) as Dictionary<string,object>;
      if (req==null) Fault("BAD_ARGS");
      string action=Str(req,"action");
      Dictionary<string,object> result;
      if (action=="windows") {
        var list=new List<object>(); foreach (var w in Windows()) list.Add(w.Wire());
        result=Obj("ok",true,"windows",list);
      } else if (action=="snapshot") { var w=Guard(Dict(req,"identity")); result=Snapshot(w); }
      else if (action=="act") result=Act(req);
      else if (action=="wait") result=Wait(req);
      else { Fault("BAD_ACTION"); return ""; }
      return Json.Serialize(result);
    } catch (Exception ex) {
      // No provider messages, values, stack traces or localized OS text on the wire.
      string code=Code(ex);
      try { Session(); } catch { code="SESSION_LOCKED"; }
      return Json.Serialize(Obj("ok",false,"code",code));
    }
  }
}
'@
  [Console]::Out.WriteLine([BrUia]::Run($inputJson))
} catch {
  # Decode/compile errors also obey the single-line, stable-code protocol.
  $code = if ($_.Exception.Message -eq 'BAD_ARGS' -or $_.Exception -is [FormatException] -or $_.Exception -is [Text.DecoderFallbackException]) { 'BAD_ARGS' } else { 'UIA_INIT' }
  [Console]::Out.WriteLine(('{"ok":false,"code":"' + $code + '"}'))
}
