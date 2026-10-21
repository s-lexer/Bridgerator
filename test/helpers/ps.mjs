// Runs a Windows PowerShell 5.1 script hidden (no console window) and returns its JSON answer.
// The script text goes through -EncodedCommand (psArgs, like the product); inputs come in as
// environment variables named PST_* (never BR_* / BRIDGERATOR_*, which the product treats as its own).
// Output: the script prints ONE JSON value (ConvertTo-Json) as its last stdout line.
import { execFile } from 'node:child_process';
import { POWERSHELL, psArgs } from '../../src/win.mjs';

export const IS_WIN = process.platform === 'win32';
export const NOT_WIN = IS_WIN ? false : 'PowerShell 5.1 checks run on Windows only (NOT CHECKED here)';

// UTF-8 both ways: the console code page (866 / 1251 on Russian Windows) would garble the JSON.
const PRELUDE = "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n";

/** → parsed JSON of the last stdout line. env: extra variables (PST_* by convention); policy: execution policy of the process. */
export function runPs(script, { env = {}, timeout = 120000, policy = 'Bypass' } = {}) {
  const e = { ...process.env, ...env };
  for (const k of Object.keys(e)) if (/^(BR_|BRIDGERATOR_)/i.test(k)) delete e[k];
  return new Promise((resolve, reject) => {
    const args = psArgs(PRELUDE + script);
    args[args.indexOf('-ExecutionPolicy') + 1] = policy; // 'Restricted' = the customer's default
    execFile(POWERSHELL, args, { windowsHide: true, timeout, env: e, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, out, errOut) => {
      const lines = String(out || '').trim().split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1);
      if (err && !last) return reject(new Error(`PowerShell failed: ${err.message}\n${errOut}`));
      try { resolve(JSON.parse(last)); } catch { reject(new Error(`PowerShell gave no JSON (exit ${err?.code ?? 0}):\n${out}\n${errOut}`)); }
    });
  });
}

/**
 * Parses .ps1 files with the real PowerShell parser → per file: { file, errors[], fileErrors (count when read as by -File), commands[{name,line,args[]}],
 * vars[{name,line}], strings[{value,line}], members[{type,member,line}], csharp[{code,refs[],line}], functions[{name,line,end}] }.
 */
export function psAst(files) {
  return runPs(String.raw`
$out = @()
foreach ($f in ($env:PST_FILES -split '\|')) {
  $tok = $null; $err = $null
  # Parsed as the product loads it: the text read as UTF-8 (runFilesPs / irm), not as the ANSI code page.
  $ast = [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8), $f, [ref]$tok, [ref]$err)
  # How powershell -File would read it (BOM-less = ANSI code page): only for the encoding rule.
  $t2 = $null; $fileErr = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$t2, [ref]$fileErr)
  $cmds = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
    @{ name = [string]$_.GetCommandName(); line = $_.Extent.StartLineNumber; text = $_.Extent.Text; args = @($_.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text }) } })
  $vars = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.VariableExpressionAst] }, $true) | ForEach-Object { @{ name = $_.VariablePath.UserPath; line = $_.Extent.StartLineNumber } })
  $strs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }, $true) | ForEach-Object { @{ value = [string]$_.Value; line = $_.Extent.StartLineNumber } })
  $mem = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object {
    @{ type = $(if ($_.Expression -is [System.Management.Automation.Language.TypeExpressionAst]) { $_.Expression.TypeName.FullName } else { '' }); member = $_.Member.Extent.Text; line = $_.Extent.StartLineNumber; text = $_.Extent.Text } })
  # C# fragments: Add-CachedType <code> | -code <code> [-refs a, b]  and  Add-Type -TypeDefinition <code> [-ReferencedAssemblies ...]
  $cs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and @('Add-CachedType', 'Add-Type') -contains $n.GetCommandName() }, $true) | ForEach-Object {
    $el = @($_.CommandElements | Select-Object -Skip 1); $code = $null; $refs = @(); $i = 0
    while ($i -lt $el.Count) {
      $e = $el[$i]
      if ($e -is [System.Management.Automation.Language.CommandParameterAst]) {
        $p = $e.ParameterName; $v = $el[$i + 1]
        if ($p -in 'code', 'TypeDefinition') { if ($v -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $code = $v.Value }; $i += 2; continue }
        if ($p -in 'refs', 'ReferencedAssemblies') { $refs = @($v.Extent.Text -split '\s*,\s*'); $i += 2; continue }
        $i += 2; continue
      }
      if ($_.GetCommandName() -eq 'Add-CachedType' -and $e -is [System.Management.Automation.Language.StringConstantExpressionAst] -and -not $code) { $code = $e.Value }
      $i++
    }
    if ($code) { @{ code = $code; refs = $refs; line = $_.Extent.StartLineNumber } } })
  $fns = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { @{ name = $_.Name; line = $_.Extent.StartLineNumber; end = $_.Extent.EndLineNumber } })
  $out += @{ file = $f; errors = @($err | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }); fileErrors = @($fileErr).Count; commands = $cmds; vars = $vars; strings = $strs; members = $mem; csharp = $cs; functions = $fns }
}
ConvertTo-Json -InputObject @($out) -Depth 8 -Compress
`, { env: { PST_FILES: files.join('|') } });
}
