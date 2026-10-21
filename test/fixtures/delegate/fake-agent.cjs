// A fake agent CLI (Codex / Claude Code / Gemini CLI) for test/delegate*.test.mjs — never a real model.
// Which CLI it plays comes from its arguments (exec → codex, -p → claude, --prompt= → gemini). What it
// does comes from the task: the JSON after "Task:" in the prompt:
//   { answer, write: {relPath: text}, delete: [relPath], sleep: ms, exit: code, fail: true, stderr,
//     answerFrom: absPath (the answer is that file's text),
//     dump: absPath (argv, env, cwd, pid), child: absPath (start a sleeping grandchild, its pid → file) }
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('fake-agent 1.2.3\n'); process.exit(0); }
const kind = argv[0] === 'exec' ? 'codex' : argv.includes('-p') ? 'claude' : 'gemini';
const prompt = kind === 'gemini' ? (argv.find((a) => a.startsWith('--prompt=')) || '').slice(9) : argv[argv.indexOf('--') + 1] || '';
const m = /\nTask:\n([\s\S]*)$/.exec(prompt);
let spec = {};
try { spec = JSON.parse(m[1]); } catch { spec = { answer: m ? m[1] : '' }; }

if (spec.dump) fs.writeFileSync(spec.dump, JSON.stringify({ kind, argv, env: process.env, cwd: process.cwd(), pid: process.pid }));
if (spec.child) {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(spec.child, String(c.pid));
}
for (const [f, t] of Object.entries(spec.write || {})) { fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true }); fs.writeFileSync(f, t); }
for (const f of spec.delete || []) fs.rmSync(f, { force: true });

function done() {
  const answer = spec.answerFrom ? fs.readFileSync(spec.answerFrom, 'utf8') : spec.answer === undefined ? 'ok' : spec.answer;
  if (kind === 'codex') {
    const ev = [{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } }];
    if (spec.fail) ev.push({ type: 'turn.failed', error: { message: 'usage limit reached' } });
    else ev.push({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: answer } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    process.stdout.write(ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  } else if (kind === 'claude') {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: spec.fail ? 'error_during_execution' : 'success', is_error: !!spec.fail, result: answer, session_id: 's1', total_cost_usd: 0 }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ response: answer, stats: { models: {} }, ...(spec.fail ? { error: { type: 'Error', message: 'quota exceeded' } } : {}) }) + '\n');
  }
  if (spec.stderr) process.stderr.write(spec.stderr);
  process.exit(spec.exit || 0);
}
if (spec.sleep) setTimeout(done, spec.sleep); else done();
