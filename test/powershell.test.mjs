// The PowerShell side of the bridge (src/*.ps1, install.ps1): parsed by the real PowerShell 5.1
// parser exactly as the bridge loads it, every C# fragment compiled the way Add-Type compiles it on
// PowerShell 5.1 (C# 5), and the question helpers (ask-lib.ps1) exercised WITHOUT showing anything:
// no window, notification or tray icon is ever shown by these tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_WIN, psAst, runPs } from './helpers/ps.mjs';
import { runFilesPs } from '../src/ask.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const LIB = path.join(SRC, 'ask-lib.ps1'), TRAY = path.join(SRC, 'tray.ps1'), ASK = path.join(SRC, 'ask.ps1');
const PS_FILES = [...fs.readdirSync(SRC).filter((f) => f.endsWith('.ps1')).map((f) => path.join(SRC, f)), path.join(ROOT, 'install.ps1')];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-ps-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const nonAscii = (f) => /[^\x00-\x7f]/.test(fs.readFileSync(f, 'utf8'));

test('every .ps1 parses without errors, also as the one scriptblock the bridge builds (ask-lib + ask / tray)', { skip: NOT_WIN }, async () => {
  assert.ok(PS_FILES.length >= 4);
  for (const f of await psAst(PS_FILES)) assert.deepEqual(f.errors, [], path.basename(f.file));
  // runFilesPs joins the files with a newline into one scriptblock: parse exactly that text.
  const joined = await runPs(String.raw`
$r = @{}
foreach ($pair in ($env:PST_PAIRS -split ';')) {
  $files = $pair -split '\|'
  $text = ($files | ForEach-Object { [IO.File]::ReadAllText($_, [Text.Encoding]::UTF8) }) -join [Environment]::NewLine
  $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$t, [ref]$e)
  $r[(Split-Path -Leaf $files[1])] = @($e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" })
}
$r | ConvertTo-Json -Compress -Depth 4
`, { env: { PST_PAIRS: `${LIB}|${ASK};${LIB}|${TRAY}` } });
  assert.deepEqual(Object.fromEntries(Object.entries(joined).map(([k, v]) => [k, [v].flat()])), { 'ask.ps1': [], 'tray.ps1': [] });
});

test('signed scripts (release build: Authenticode block at the end of each .ps1) still run joined: lib + main', { skip: NOT_WIN }, async () => {
  const sig = '\r\n# SIG # Begin signature block\r\n# MIIfake+base64==\r\n# SIG # End signature block\r\n';
  const lib = path.join(tmp, 'signed-lib.ps1'), main = path.join(tmp, 'signed-main.ps1');
  fs.writeFileSync(lib, 'function Get-BrX { 41 }' + sig);
  fs.writeFileSync(main, '@{ v = (Get-BrX) + 1 } | ConvertTo-Json -Compress' + sig);
  assert.deepEqual(await runPs(runFilesPs(lib, main)), { v: 42 });
});

test('encoding: valid UTF-8; non-ASCII scripts without a BOM are only loaded as UTF-8 text (runFilesPs), never with -File', () => {
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (const f of PS_FILES) assert.doesNotThrow(() => dec.decode(fs.readFileSync(f)), path.basename(f));
  assert.match(runFilesPs('C:\\a b\\x.ps1'), /^\. \(\[scriptblock\]::Create\(\(\(\[IO\.File\]::ReadAllText\('C:\\a b\\x\.ps1', \[Text\.Encoding\]::UTF8\) -replace '\(\?s\)# SIG # Begin signature block\.\*\$', ''\)\)\)\)$/);
  const js = fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs')).map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  assert.doesNotMatch(js, /['"]-File['"]/, 'no PowerShell -File anywhere in the bridge');
  for (const f of PS_FILES.filter((x) => x.startsWith(SRC))) {
    const bom = fs.readFileSync(f).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
    if (!nonAscii(f) || bom) continue;
    const name = path.basename(f);
    // Every place that names this file reads it as text (fileURLToPath(new URL(...)) → runFilesPs, or read()).
    const uses = js.match(new RegExp(`[^\\n]*${name.replace('.', '\\.')}[^\\n]*`, 'g')) || [];
    assert.ok(uses.length, `${name} is used`);
    for (const u of uses) assert.match(u, /fileURLToPath\(new URL\('\.\/[\w-]+\.ps1', import\.meta\.url\)\)|read\('\.\/[\w-]+\.ps1'\)|^\s*\/\//, `${name}: ${u.trim()}`);
  }
});

test('every C# fragment compiles with the PowerShell 5.1 compiler (C# 5); a C# 6 feature would be caught', { skip: NOT_WIN }, async () => {
  const frags = (await psAst(PS_FILES)).flatMap((f) => f.csharp.map((c) => ({ ...c, file: path.basename(f.file) })));
  // The known fragments must be found (the extractor works); fragments in new .ps1 files are compiled too.
  const found = frags.map((c) => c.file);
  for (const [f, n] of Object.entries({ 'ask-lib.ps1': 2, 'install.ps1': 1, 'tray.ps1': 1 })) assert.ok(found.filter((x) => x === f).length >= n, `${f}: ${n} C# fragment(s) found (got ${found.join(', ')})`);
  // The C# 6 probe proves the compiler really is C# 5 (else this test would pass on anything).
  frags.push({ file: 'probe', code: 'public static class BrProbe6 { public static string Hi(string n) => $"hi {n}"; }', refs: [] });
  const r = await runPs(String.raw`
$out = @()
$i = 0
foreach ($c in ($env:PST_FRAGS | ConvertFrom-Json)) {
  $dll = Join-Path $env:PST_DIR "frag$i.dll"; $i++
  $refs = @($c.refs | Where-Object { $_ })
  $msg = $null
  try {
    if ($refs.Count) { Add-Type -TypeDefinition $c.code -ReferencedAssemblies $refs -OutputAssembly $dll -OutputType Library -ErrorAction Stop }
    else { Add-Type -TypeDefinition $c.code -OutputAssembly $dll -OutputType Library -ErrorAction Stop }
  } catch { $msg = "$_" }
  $out += @{ file = $c.file; line = $c.line; ok = [IO.File]::Exists($dll) -and -not $msg; msg = $msg }
}
ConvertTo-Json -InputObject @($out) -Compress
`, { env: { PST_FRAGS: JSON.stringify(frags), PST_DIR: tmp } });
  const probe = r.pop();
  for (const c of r) assert.ok(c.ok, `${c.file}:${c.line} does not compile: ${c.msg}`);
  assert.equal(probe.ok, false, 'C# 6 (=> member, $"") must not compile here');
});

// ask-lib.ps1 loaded the way the bridge loads it, with its DLL cache in a throw-away LOCALAPPDATA.
const askLib = (script, local, env = {}) => runPs(`. ([scriptblock]::Create([IO.File]::ReadAllText($env:PST_LIB, [Text.Encoding]::UTF8)))\n${script}`, { env: { PST_LIB: LIB, LOCALAPPDATA: local, ...env } });

test('toast answer sink (BrWait): first answer wins, unknown = deny, "failed" kept, JSON line only for a safe id', { skip: NOT_WIN }, async () => {
  const local = fs.mkdtempSync(path.join(tmp, 'la-'));
  const r = await askLib(String.raw`
$orig = [Console]::Out; $sw = New-Object IO.StringWriter; [Console]::SetOut($sw)
$w = New-Object BrWait; $w.Keys = [string[]]@('allow', 'allow10', 'deny'); $w.Id = 'a7-kz1'; $w.Report = $true
$first = $w.Finish('allow10'); $second = $w.Finish('deny'); $over = $w.IsOver; $res1 = $w.Result
$u = New-Object BrWait; $u.Keys = [string[]]@('allow', 'deny'); [void]$u.Finish('format-c')
$f = New-Object BrWait; $f.Keys = [string[]]@('allow'); [void]$f.Finish('failed')
$bad = New-Object BrWait; $bad.Keys = [string[]]@('allow'); $bad.Id = 'x","t":"menu'; $bad.Report = $true; [void]$bad.Finish('allow')
$quiet = New-Object BrWait; $quiet.Keys = [string[]]@('allow'); $quiet.Id = 'q1'; [void]$quiet.Finish('allow')
# Stand-ins with the same CLR property names as the WinRT event args (the sink reads them by reflection).
Add-Type 'public class BrFakeToastArgs { public object Reason { get; set; } public string Arguments { get; set; } }'
$e = New-Object BrWait; $e.Keys = [string[]]@('allow', 'deny')
$e.OnDismissed($null, (New-Object BrFakeToastArgs -Property @{ Reason = 'TimedOut' })); $afterTimeout = $e.IsOver
$e.OnDismissed($null, (New-Object BrFakeToastArgs -Property @{ Reason = 'UserCanceled' }))
$a = New-Object BrWait; $a.Keys = [string[]]@('allow', 'deny'); $a.OnActivated($null, (New-Object BrFakeToastArgs -Property @{ Arguments = 'allow' }))
[Console]::SetOut($orig)
@{ first = $first; second = $second; over = $over; res1 = $res1; unknown = $u.Result; failed = $f.Result; badRes = $bad.Result; printed = $sw.ToString(); dismissedTimeout = $afterTimeout; dismissedUser = $e.Result; activated = $a.Result; signaled = $a.Done.WaitOne(0) } | ConvertTo-Json -Compress
`, local);
  assert.deepEqual([r.first, r.second, r.over, r.res1], [true, false, true, 'allow10']);
  assert.equal(r.unknown, 'deny'); assert.equal(r.failed, 'failed'); assert.equal(r.badRes, 'allow');
  assert.equal(r.printed.trim(), '{"t":"answer","id":"a7-kz1","key":"allow10"}', 'one JSON line, and none for an id that could break it');
  assert.equal(r.dismissedTimeout, false, 'a toast that times out into the Action Center is not an answer');
  assert.equal(r.dismissedUser, 'deny', 'closing it = Deny');
  assert.equal(r.activated, 'allow'); assert.equal(r.signaled, true);
});

test('compiled helpers are cached per code in LOCALAPPDATA\\Bridgerator\\cache; the next start loads the DLL; a broken cache still works', { skip: NOT_WIN }, async () => {
  const local = path.join(fs.mkdtempSync(path.join(tmp, 'cache-')), 'Пользователь');
  fs.mkdirSync(local);
  const probe = String.raw`
Add-CachedType 'public static class BrCacheProbe { public static int V() { return 7; } }'
$d = Join-Path $env:LOCALAPPDATA 'Bridgerator\cache'
@{ files = @(if ([IO.Directory]::Exists($d)) { Get-ChildItem -LiteralPath $d | ForEach-Object { @{ n = $_.Name; t = $_.LastWriteTimeUtc.Ticks } } }); v = [BrCacheProbe]::V(); wait = [bool]('BrWait' -as [type]); fromCache = ([BrWait].Assembly.Location -like '*\Bridgerator\cache\br-*.dll') } | ConvertTo-Json -Compress -Depth 4`;
  const one = await askLib(probe, local);
  const two = await askLib(probe, local);
  const names = one.files.map((f) => f.n).sort();
  assert.equal(names.length, 2, 'one DLL per code fragment (BrWait sink + the probe)');
  for (const n of names) assert.match(n, /^br-[0-9a-f]{24}\.dll$/, 'no temp <PID>.dll left');
  assert.deepEqual(two.files, one.files, 'second start compiles nothing (same files, same times)');
  assert.equal(two.v, 7); assert.equal(two.wait, true); assert.equal(two.fromCache, true);
  // The cache folder can't be created (a file is in the way): compiled in memory instead.
  const broken = fs.mkdtempSync(path.join(tmp, 'broken-'));
  fs.mkdirSync(path.join(broken, 'Bridgerator')); fs.writeFileSync(path.join(broken, 'Bridgerator', 'cache'), 'not a folder');
  const three = await askLib(probe, broken);
  assert.equal(three.v, 7); assert.equal(three.wait, true); assert.equal(three.fromCache, false);
});

test('notification text escaping (X) and the logo drawn at tray sizes', { skip: NOT_WIN }, async () => {
  const r = await askLib(String.raw`
$sizes = @{}
foreach ($n in 16, 24, 64) {
  $b = New-LogoBitmap $n; $c = $b.GetPixel(2, [int]($n / 2)); $k = $b.GetPixel(0, 0)
  $sizes["$n"] = @{ w = $b.Width; h = $b.Height; tile = '{0:x2}{1:x2}{2:x2}' -f $c.R, $c.G, $c.B; cornerA = $k.A }; $b.Dispose()
}
@{ x = (X "<a & 'b'>""c"" — Привет"); sizes = $sizes } | ConvertTo-Json -Compress -Depth 4
`, fs.mkdtempSync(path.join(tmp, 'logo-')));
  assert.equal(r.x, '&lt;a &amp; &apos;b&apos;&gt;&quot;c&quot; — Привет');
  for (const n of ['16', '24', '64']) {
    assert.equal(r.sizes[n].w, Number(n)); assert.equal(r.sizes[n].h, Number(n));
    assert.equal(r.sizes[n].tile, '2251e6', `${n} px: blue tile`);
    assert.ok(r.sizes[n].cornerA < 255, `${n} px: rounded corner`);
  }
});

test('fallback question window, built but never shown: buttons, Deny = Esc, disabled at first, bottom-right, long text cut', { skip: NOT_WIN }, async () => {
  const r = await askLib(String.raw`
$q = @{ specs = @(@('allow', 'Allow', ''), @('allow10', 'Allow 10 min', ''), @('always', 'Allow always', ''), @('deny', 'Deny', 'deny')); head = 'ChatGPT wants to delete files'
  detail = ('Remove-Item -Recurse "C:\Users\Иван Петров\Документы\Проект & Co" ' * 12); attr = 'PC · auto-deny in 2 min'; host = 'PC'; auto = 'auto-deny'; secs = 120; theme = 'dark'; scale = 1 }
$f = New-AskForm $q
$btn = @($f.Controls | Where-Object { $_ -is [Windows.Forms.Button] })
$cmd = @($f.Controls | Where-Object { $_ -is [Windows.Forms.Label] -and $_.Font.Name -eq 'Consolas' })[0]
$wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$res = @{ labels = @($btn | ForEach-Object { $_.Text }); tags = @($btn | ForEach-Object { $_.Tag }); enabled = @($btn | Where-Object { $_.Enabled }).Count
  real = @($btn | Where-Object { $_.GetType().Name -eq 'BrRealButton' }).Count; mnemonic = @($btn | Where-Object { $_.UseMnemonic }).Count
  cancel = [string]$f.CancelButton.Tag; width = $f.ClientSize.Width; right = $wa.Right - ($f.Left + $f.Width); bottom = $wa.Bottom - ($f.Top + $f.Height)
  cmd = $cmd.Text; cmdLen = $q.detail.Length; topMost = $f.TopMost; taskbar = $f.ShowInTaskbar; visible = $f.Visible; handle = $f.IsHandleCreated }
$f.Dispose()
$res | ConvertTo-Json -Compress
`, fs.mkdtempSync(path.join(tmp, 'form-')));
  assert.deepEqual(r.labels, ['Allow', 'Deny', 'Allow 10 min', 'Allow always'], 'Allow / Deny on the first row');
  assert.equal(r.cancel, 'deny', 'Esc = Deny');
  assert.equal(r.enabled, 0, 'buttons are off for the first 600 ms');
  assert.equal(r.real, 4, 'only hardware clicks count'); assert.equal(r.mnemonic, 0, '& in labels is shown, not a shortcut');
  assert.ok(r.width >= 380); assert.equal(r.right, 12); assert.equal(r.bottom, 12);
  assert.ok(r.cmd.endsWith('…') && r.cmd.length < r.cmdLen, 'long command cut to three lines');
  assert.ok(r.cmd.includes('Иван Петров'), 'Cyrillic text kept');
  assert.deepEqual([r.topMost, r.taskbar, r.visible, r.handle], [true, false, false, false], 'never shown by the test');
});

test('BrRealButton: a click that is not real input (program / accessibility) does nothing', { skip: NOT_WIN }, async () => {
  const r = await askLib(String.raw`
$f = New-AskForm @{ specs = @(@('allow', 'Allow', ''), @('deny', 'Deny', 'deny')); head = 'h'; detail = 'd'; attr = 'a'; host = 'PC'; auto = 'auto-deny'; secs = 60; theme = 'light'; scale = 1 }
$b = @($f.Controls | Where-Object { $_ -is [Windows.Forms.Button] })[0]
$script:clicks = 0; $b.Add_Click({ $script:clicks++ })
$on = [BrRealButton].GetMethod('OnClick', [Reflection.BindingFlags]'NonPublic, Instance')
$on.Invoke($b, @([EventArgs]::Empty)); $fake = $script:clicks
[BrRealButton].GetField('real', [Reflection.BindingFlags]'NonPublic, Instance').SetValue($b, $true)
$on.Invoke($b, @([EventArgs]::Empty)); $real = $script:clicks
$on.Invoke($b, @([EventArgs]::Empty)); $again = $script:clicks
$f.Dispose()
@{ fake = $fake; real = $real; again = $again } | ConvertTo-Json -Compress
`, fs.mkdtempSync(path.join(tmp, 'btn-')));
  assert.equal(r.fake, 0, 'injected click ignored');
  assert.equal(r.real, 1, 'a real one goes through (proves the guard is what stopped the first)');
  assert.equal(r.again, 1, 'one real input = one click');
});

// Event handlers made inside a PowerShell function run later, outside it: without .GetNewClosure()
// the function's variables ($f, $wv …) are gone when they fire (critical-logic/bridge.md).
const CLOSURE_CHECK = String.raw`
$auto = @('_', 'this', 'args', 'true', 'false', 'null', 'PSItem', 'input', 'sender', 'e')
$out = @()
foreach ($src in ($env:PST_SRC | ConvertFrom-Json)) {
  $t = $null; $er = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($src.text, [ref]$t, [ref]$er)
  foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    $body = $fn.Body
    $owner = { param($n) $p = $n.Parent; while ($p -and -not ($p -is [System.Management.Automation.Language.ScriptBlockAst])) { $p = $p.Parent }; $p }
    $locals = @($fn.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) + @($body.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    $locals += @($body.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) |
      Where-Object { (& $owner $_) -eq $body -and -not $_.Left.VariablePath.IsScript -and -not $_.Left.VariablePath.IsGlobal } | ForEach-Object { $_.Left.VariablePath.UserPath })
    $locals += @($body.FindAll({ param($n) $n -is [System.Management.Automation.Language.ForEachStatementAst] }, $true) | Where-Object { (& $owner $_) -eq $body } | ForEach-Object { $_.Variable.VariablePath.UserPath })
    $handlers = $body.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -like 'Add_*' -and $n.Arguments.Count -ge 1 -and $n.Arguments[0] -is [System.Management.Automation.Language.ScriptBlockExpressionAst] }, $true)
    foreach ($h in $handlers) {
      $sb = $h.Arguments[0].ScriptBlock
      $own = @($sb.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) | ForEach-Object { $_.Left.VariablePath.UserPath }) + @($sb.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
      $used = @($sb.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] -and -not $n.VariablePath.IsScript -and -not $n.VariablePath.IsGlobal -and -not $n.VariablePath.IsDriveQualified }, $true) | ForEach-Object { $_.VariablePath.UserPath } | Where-Object { $_ -notin $auto -and $_ -notin $own -and $_ -in $locals } | Sort-Object -Unique)
      if ($used.Count) { $out += "$($src.name):$($h.Extent.StartLineNumber) $($fn.Name) $($h.Member.Extent.Text) uses $($used -join ', ') without .GetNewClosure()" }
    }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

test('event handlers created inside functions capture their variables (.GetNewClosure()); the check catches a missing one', { skip: NOT_WIN }, async () => {
  const lib = fs.readFileSync(LIB, 'utf8'), tray = fs.readFileSync(TRAY, 'utf8');
  const ok = await runPs(CLOSURE_CHECK, { env: { PST_SRC: JSON.stringify([{ name: 'ask-lib.ps1', text: lib }, { name: 'tray.ps1', text: tray }]) } });
  assert.deepEqual(ok, []);
  // Inversion: drop one .GetNewClosure() (in memory only) — the check must flag it.
  const target = "$f.Add_FormClosing({ param($s, $e) if ($e.CloseReason -eq 'UserClosing' -and -not $W.forceClose) { $e.Cancel = $true; $f.Hide() } }.GetNewClosure())";
  assert.ok(tray.includes(target));
  const broken = tray.replace(target, target.replace('}.GetNewClosure())', '})'));
  const bad = await runPs(CLOSURE_CHECK, { env: { PST_SRC: JSON.stringify([{ name: 'tray.ps1', text: broken }, { name: 'ask-lib.ps1', text: lib.replace("$f.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $f.Tag.pick = 'deny'; $f.Close() } }.GetNewClosure())", "$f.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $f.Tag.pick = 'deny'; $f.Close() } })") }]) } });
  assert.equal(bad.length, 2, JSON.stringify(bad));
  assert.match(bad[0], /tray\.ps1:\d+ Open-Window Add_FormClosing uses f /);
  assert.match(bad[1], /ask-lib\.ps1:\d+ New-AskForm Add_KeyDown uses f /);
});

// The real handlers of Open-Window (taken from tray.ps1 by the parser), made with .GetNewClosure() inside a
// function exactly like the product, on a real (never shown) Form; WebView2 is not needed for the failure path.
const INIT_FAIL = String.raw`
Add-Type -AssemblyName System.Windows.Forms
$t = $null; $er = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($env:PST_TRAY_TEXT, [ref]$t, [ref]$er)
$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Open-Window' }, $true) | Select-Object -First 1
function Get-Handler([string]$name) {
  $h = $fn.Body.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Extent.Text -eq $name }, $true) | Select-Object -First 1
  $a = $h.Arguments[0]; if ($a -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) { $a = $a.Expression }
  $a.Extent.Text
}
$initText = Get-Handler 'Add_CoreWebView2InitializationCompleted'; $closingText = Get-Handler 'Add_FormClosing'
$W = @{ want = ($env:PST_WANT -eq '1'); forceClose = $false }
$R = @{ opened = 0; closed = $false }
$openAccount = { $R.opened++ }
function New-TestWindow {
  $f = New-Object Windows.Forms.Form
  $wv = $null
  $f.Add_FormClosing((. ([scriptblock]::Create($closingText))).GetNewClosure())
  $f.Add_FormClosed({ $R.closed = $true })
  [void]$f.Handle
  $R.f = $f
  (. ([scriptblock]::Create($initText))).GetNewClosure()
}
$init = New-TestWindow
if ($env:PST_USER_CLOSE -eq '1') { $R.f.Close() } else { & $init $null ([pscustomobject]@{ IsSuccess = $false }) }
@{ closed = $R.closed; disposed = $R.f.IsDisposed; opened = $R.opened; force = $W.forceClose } | ConvertTo-Json -Compress
`;

test('tray window: a failed WebView2 init really closes the form (real handlers, real Form); a user close only hides it', { skip: NOT_WIN }, async () => {
  const tray = fs.readFileSync(TRAY, 'utf8');
  const run = (text, env = {}) => runPs(INIT_FAIL, { env: { PST_TRAY_TEXT: text, ...env } });
  assert.deepEqual(await run(tray), { closed: true, disposed: true, opened: 0, force: false }, 'prewarm failure: closed, no browser');
  assert.deepEqual(await run(tray, { PST_WANT: '1' }), { closed: true, disposed: true, opened: 1, force: false }, 'clicked: closed + account page');
  assert.deepEqual(await run(tray, { PST_USER_CLOSE: '1' }), { closed: false, disposed: false, opened: 0, force: false }, 'Alt+F4 / X hides to the tray');
  // Inversion: the first-round flag in $script: (each closure has its own) — the window stays alive, hidden.
  const old = tray.replaceAll('$W.forceClose', '$script:forceClose');
  assert.equal((await run(old)).closed, false, 'the test catches a flag the two closures do not share');
});

test('tray window: only its own page talks to the helper; links open only our https site', { skip: NOT_WIN }, async () => {
  const tray = fs.readFileSync(TRAY, 'utf8');
  assert.match(tray, /\$c\.Add_WebMessageReceived\(\{\s*param\(\$s2, \$m\)\s*try \{\s*# Only our own page may talk to the helper\.\s*if \(\[string\]\$m\.Source -notlike 'https:\/\/bridgerator\.local\/\*'\) \{ return \}/);
  assert.match(tray, /\$c\.Add_NavigationStarting\(\{ param\(\$s2, \$n\) if \(\$n\.Uri -notlike 'https:\/\/bridgerator\.local\/\*'\) \{ \$n\.Cancel = \$true; & \$openUrl \$n\.Uri \} \}/);
  assert.match(tray, /\$c\.Add_NewWindowRequested\(\{ param\(\$s2, \$n\) \$n\.Handled = \$true; & \$openUrl \$n\.Uri \}/);
  assert.match(tray, /SetVirtualHostNameToFolderMapping\('bridgerator\.local', \$ui, 'Deny'\)/);
  // The real $openUrl block, run with Start-Process replaced: what would be opened in the browser?
  const urls = ['https://bridgerator.recondeck.com/app/billing?from=pc', 'HTTPS://BRIDGERATOR.RECONDECK.COM/app', 'http://bridgerator.recondeck.com/app', 'https://bridgerator.recondeck.com.evil.example/', 'https://user:pw@bridgerator.recondeck.com/app',
    'https://evil.example/?u=https://bridgerator.recondeck.com', 'javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'ms-settings:privacy', '\\\\server\\share\\x.exe', 'https://bridgerator.local/index.html', ''];
  const r = await runPs(String.raw`
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($env:PST_TRAY, [Text.Encoding]::UTF8), [ref]$t, [ref]$e)
$a = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$openUrl' }, $true) | Select-Object -First 1
$script:opened = @()
function Start-Process { $script:opened += [string]$args[0] }
$openUrl = . ([scriptblock]::Create($a.Right.Extent.Text))
foreach ($u in ($env:PST_URLS | ConvertFrom-Json)) { & $openUrl $u }
$like = @{}; foreach ($u in 'https://bridgerator.local.evil.example/', 'https://bridgerator.local@evil.example/', 'http://bridgerator.local/index.html', 'https://bridgerator.local/index.html#queue') { $like[$u] = $u -notlike 'https://bridgerator.local/*' }
@{ opened = @($script:opened); refused = $like } | ConvertTo-Json -Compress -Depth 3
`, { env: { PST_TRAY: TRAY, PST_URLS: JSON.stringify(urls) } });
  assert.deepEqual([r.opened].flat(), ['https://bridgerator.recondeck.com/app/billing?from=pc', 'https://bridgerator.recondeck.com/app']);
  assert.deepEqual(r.refused, { 'https://bridgerator.local.evil.example/': true, 'https://bridgerator.local@evil.example/': true, 'http://bridgerator.local/index.html': true, 'https://bridgerator.local/index.html#queue': false });
});

test('ask toast: only an explicit Disabled* notification setting means off; Windows 10 can return none (VM 21.10)', { skip: NOT_WIN }, async () => {
  const lib = fs.readFileSync(LIB, 'utf8');
  const line = lib.split(/\r?\n/).find((l) => /\$n\.Setting/.test(l) && /throw/.test(l));
  assert.ok(line, 'the Setting check exists');
  const cond = /if \((.+?)\) \{ throw/.exec(line)[1];
  const r = await runPs(`$out = @(); foreach ($v in @($null, 'Enabled', 'DisabledForUser', 'DisabledByGroupPolicy', 'DisabledByManifest')) { $n = @{ Setting = $v }; $out += [bool](${cond}) }; ConvertTo-Json -InputObject $out -Compress`);
  assert.deepEqual(r, [false, false, true, true, true]);
});
