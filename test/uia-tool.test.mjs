import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  defs, handle, createApps, SnapshotStore, validateArgs, pickWindow, protectedWindow,
  ToolError, LIMITS,
} from '../src/uia-tool.mjs';

const win = { id: 123, pid: 456, started: '639000000000000000', title: 'Editor Русский', program: 'editor' };
const step = (name = 'Save', nth = 0, dup = 1) => ({ role: 'button', aid: 'save', name, nth, dup });
const rawSnapshot = (refs = { e1: [], e2: [step()] }) => ({
  ok: true, text: 'e1 window "Editor"\n  e2 button "Save" [invoke]\nincomplete=false', refs,
});
const reply = r => ({ code: 0, stdout: JSON.stringify(r) + '\r\n' });
const read = r => JSON.parse(r.content[0].text);
const code = expected => e => { assert.equal(e.code, expected); assert.ok(e instanceof ToolError); return true; };
function harness(responses) {
  const app = createApps(), calls = [], gated = [];
  const ctx = { runPs: async opts => {
    const req = JSON.parse(Buffer.from(opts.env.BRX_UIA, 'base64').toString('utf8'));
    calls.push({ req, opts });
    assert.ok(Array.isArray(opts.files) && opts.files[0].endsWith('uia.ps1'));
    assert.deepEqual(Object.keys(opts.env), ['BRX_UIA']);
    const next = responses.shift();
    assert.notEqual(next, undefined, 'unexpected worker call');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(req, opts) : reply(next);
  }, gate: { gate: async (name, args) => { gated.push([name, args]); return null; } } };
  return { ...app, calls, gated, ctx, invoke: args => app.handle('apps', args, ctx) };
}
const windows = (...items) => ({ ok: true, windows: items });

test('exports the apps extra-tool contract and all eight action kinds', () => {
  assert.equal(typeof handle, 'function');
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'apps');
  assert.deepEqual(defs[0].inputSchema.properties.kind.enum, ['invoke','set_value','toggle','expand','collapse','select','focus','keys']);
  assert.equal(defs[0].annotations.readOnlyHint, false);
  assert.equal(defs[0].inputSchema.additionalProperties, false);
});

test('windows emits sanitized title/program/pid without internal process identity', async () => {
  const h = harness([windows({ ...win, title: 'a\n' + 'x'.repeat(300) })]);
  const r = read(await h.invoke({ action: 'windows' }));
  assert.equal(r.windows[0].title.length, 200);
  assert.equal(r.windows[0].title.includes('\n'), false);
  assert.equal(r.windows[0].pid, win.pid);
  assert.equal('started' in r.windows[0], false);
});

test('strict title selection never chooses first or exact among multiple matches', () => {
  const other = { ...win, id: 124, title: 'Editor' };
  assert.throws(() => pickWindow([win, other], { window: 'Editor' }), code('AMBIGUOUS_TARGET'));
  assert.equal(pickWindow([win], { window: 'РУССКИЙ' }).id, win.id);
  assert.equal(pickWindow([win, other], { window_id: 124 }).id, 124);
  assert.throws(() => pickWindow([], { window: 'missing' }), code('NO_WINDOW'));
});

test('protected process/title matching is case insensitive and security prompts are refused', () => {
  for (const program of ['bridgerator','BRIDGERATOR.EXE']) assert.equal(protectedWindow({ program }), 'OWN_WINDOW');
  assert.equal(protectedWindow({ program: 'msedgewebview2', title: 'Bridgerator — Safety' }), 'OWN_WINDOW');
  for (const program of ['consent.exe','CredentialUIBroker.EXE','LogonUI','winlogon']) {
    assert.equal(protectedWindow({ program }), 'SESSION_LOCKED');
  }
  assert.equal(protectedWindow({ ...win, blocked: 'ELEVATED_TARGET' }), 'ELEVATED_TARGET');
  assert.equal(protectedWindow(win), null);
});

test('own/elevated/prompt selectors never start a snapshot/action worker', async () => {
  for (const w of [{ ...win, program: 'bridgerator' }, { ...win, title: 'Bridgerator WebView2' },
    { ...win, program: 'consent' }, { ...win, program: 'CredentialUIBroker' }, { ...win, blocked: 'ELEVATED_TARGET' }]) {
    const h = harness([windows(w)]);
    await assert.rejects(h.invoke({ action: 'snapshot', window_id: win.id }), code(protectedWindow(w)));
    assert.equal(h.calls.length, 1);
  }
});

test('snapshot sends identity in base64 UTF8; only text and snapshot id reach model', async () => {
  const h = harness([windows(win), rawSnapshot()]);
  const r = read(await h.invoke({ action: 'snapshot', window: 'Русский' }));
  assert.deepEqual(Object.keys(r).sort(), ['snapshot','text']);
  assert.match(r.snapshot, /^s-/);
  assert.equal('refs' in r, false);
  assert.equal(h.calls[1].req.identity.started, win.started);
  assert.equal(h.calls[1].req.identity.title, win.title);
});

test('explicit snapshot act preserves every hidden ancestor, nth and dup and returns fresh snapshot', async () => {
  const chain = [{ role: 'pane', aid: '', name: '', nth: 0, dup: 1 }, step('Save',1,2)];
  const h = harness([windows(win), rawSnapshot({ e1: chain }), rawSnapshot()]);
  const first = read(await h.invoke({ action: 'snapshot', window_id: win.id }));
  const after = read(await h.invoke({ action: 'act', snapshot: first.snapshot, target: 'e1', kind: 'invoke' }));
  assert.deepEqual(h.calls[2].req.chain, chain);
  assert.deepEqual(h.calls[2].req.identity, h.store.get(first.snapshot).window);
  assert.equal(after.acted, true);
  assert.notEqual(after.snapshot, first.snapshot);
  assert.deepEqual(Object.keys(after).sort(), ['acted','kind','snapshot','target','text']);
});

test('empty chain refers to window itself and is not confused with missing ref', async () => {
  const h = harness([windows(win), rawSnapshot(), rawSnapshot()]);
  const s = read(await h.invoke({ action: 'snapshot', window_id: win.id }));
  await h.invoke({ action: 'act', snapshot: s.snapshot, target: 'e1', kind: 'focus' });
  assert.deepEqual(h.calls[2].req.chain, []);
});

test('act needs the snapshot id (another chat\'s or a later snapshot numbers refs differently, review 14.11); the gate is asked with the window title', async () => {
  const h = harness([windows(win), rawSnapshot(), windows(win), rawSnapshot({ e1: [step('New')] }), rawSnapshot()]);
  const first = read(await h.invoke({ action: 'snapshot', window_id: win.id }));
  await h.invoke({ action: 'snapshot', window_id: win.id });
  await assert.rejects(h.invoke({ action: 'act', window_id: win.id, target: 'e1', kind: 'invoke' }), code('BAD_ARGS'));
  await h.invoke({ action: 'act', snapshot: first.snapshot, target: 'e1', kind: 'invoke' });
  assert.notEqual(h.calls[4].req.chain[0]?.name, 'New', 'the ref of the snapshot the model read');
  assert.deepEqual(h.gated.at(-1)[0], 'apps'); assert.equal(h.gated.at(-1)[1].kind, 'invoke'); assert.ok('window' in h.gated.at(-1)[1]);
});

test('act: refused with the terminal off, without a gate, and when the person says no; console windows are not targets', async () => {
  const h = harness([windows(win), rawSnapshot()]);
  const s = read(await h.invoke({ action: 'snapshot', window_id: win.id }));
  await assert.rejects(h.handle('apps', { action: 'act', snapshot: s.snapshot, target: 'e1', kind: 'invoke' }, { ...h.ctx, cfg: { disabledTools: ['start_process'] } }), code('TERMINAL_OFF'));
  await assert.rejects(h.handle('apps', { action: 'act', snapshot: s.snapshot, target: 'e1', kind: 'invoke' }, { ...h.ctx, gate: undefined }), code('NO_GATE'));
  const no = await h.handle('apps', { action: 'act', snapshot: s.snapshot, target: 'e1', kind: 'invoke' }, { ...h.ctx, gate: { gate: async () => ({ content: [{ type: 'text', text: 'Denied' }], isError: true }) } });
  assert.equal(no.isError, true);
  assert.equal(h.calls.length, 2, 'nothing ran after the refusals');
  for (const program of ['cmd', 'powershell', 'WindowsTerminal', 'ShellExperienceHost']) assert.ok(protectedWindow({ program, title: 'x' }), program);
  await assert.rejects(h.invoke({ action: 'act', snapshot: s.snapshot, target: 'e1', kind: 'keys', text: 'a\tb' }), code('BAD_ARGS'));
});

test('unknown snapshot/reference, wrong window and missing snapshot fail before acting', async () => {
  const h = harness([windows(win), rawSnapshot(), windows({ ...win, id: 999 }), windows(win)]);
  const s = read(await h.invoke({ action: 'snapshot', window_id: win.id }));
  await assert.rejects(h.invoke({ action: 'act', snapshot: 's-missing', target: 'e1', kind: 'invoke' }), code('STALE_REF'));
  await assert.rejects(h.invoke({ action: 'act', snapshot: s.snapshot, target: 'e99', kind: 'invoke' }), code('STALE_REF'));
  await assert.rejects(h.invoke({ action: 'act', snapshot: s.snapshot, window_id: 999, target: 'e1', kind: 'invoke' }), code('STALE_REF'));
  const fresh = harness([]);
  await assert.rejects(fresh.invoke({ action: 'act', window_id: win.id, target: 'e1', kind: 'invoke' }), code('BAD_ARGS'));
});

test('store keeps last 20 snapshots, preserves old explicit refs, isolates ids and copies locators', () => {
  const a = new SnapshotStore(), b = new SnapshotStore(), raw = rawSnapshot();
  const first = a.add(win, raw);
  raw.refs.e2[0].name = 'mutated externally';
  assert.equal(a.get(first.id).refs.e2[0].name, 'Save');
  assert.notEqual(b.add(win, rawSnapshot()).id, first.id);
  for (let i=0;i<19;i++) a.add(win, rawSnapshot());
  assert.ok(a.get(first.id));
  a.add(win, rawSnapshot());
  assert.equal(a.get(first.id), undefined);
  assert.equal(a.latest(win).window.started, win.started);
  assert.equal(LIMITS.snapshots, 20);
});

test('malformed chains fail closed: no invalid nth, dup, oversized chain/name or extra fields retained', () => {
  for (const chain of [[step('',2,2)], [step('',0,0)], [step('',-1,2)],
    [step('x'.repeat(201))], Array.from({ length: 9 }, () => step())]) {
    assert.throws(() => new SnapshotStore().add(win, rawSnapshot({ e1: chain })), code('PS_FAILED'));
  }
  const store = new SnapshotStore();
  const s = store.add(win, rawSnapshot({ e1: [{ ...step(), value: 'secret', x: 99 }] }));
  assert.deepEqual(Object.keys(s.refs.e1[0]).sort(), ['aid','dup','name','nth','role']);
  assert.throws(() => store.add(win, rawSnapshot(Object.fromEntries(Array.from({ length:151 }, (_,i) => ['e'+(i+1),[]])))), code('PS_FAILED'));
});

for (const err of ['OWN_WINDOW','ELEVATED_TARGET','SESSION_LOCKED','PASSWORD_FIELD','STALE_REF','AMBIGUOUS_TARGET','NO_PATTERN','TIMEOUT']) {
  test('worker refusal '+err+' is propagated honestly without localized provider text or retry', async () => {
    const h = harness([windows(win), rawSnapshot(), { ok:false, code:err, message:'PRIVATE PROVIDER TEXT' }]);
    const s=read(await h.invoke({ action:'snapshot', window_id:win.id }));
    await assert.rejects(h.invoke({ action:'act', snapshot:s.snapshot, target:'e2', kind:'set_value', text:'private input' }), e => {
      assert.equal(e.code,err); assert.equal(e.message.includes('PRIVATE'),false); return true;
    });
    assert.equal(h.calls.length,3);
  });
}

test('all action kinds, Unicode text, empty set_value and SendKeys syntax travel only through env', async () => {
  for (const kind of defs[0].inputSchema.properties.kind.enum) {
    const h=harness([windows(win),rawSnapshot(),rawSnapshot()]);
    const s=read(await h.invoke({ action:'snapshot',window_id:win.id }));
    const text=kind==='keys' ? '^a{BACKSPACE}Привет $() " &' : '';
    await h.invoke({ action:'act',snapshot:s.snapshot,target:'e2',kind,...(['keys','set_value'].includes(kind)?{text}:{}) });
    assert.equal(h.calls[2].req.kind,kind);
    if (['keys','set_value'].includes(kind)) assert.equal(h.calls[2].req.text,text);
    assert.equal(h.calls[2].opts.files.length,1);
  }
});

test('window closing and post-action snapshot errors report the side effect without false failure', async () => {
  for (const post of [{window_closed:true},{snapshot_error:'SESSION_LOCKED'}]) {
    const h=harness([windows(win),rawSnapshot(),{ok:true,acted:true,...post}]);
    const s=read(await h.invoke({action:'snapshot',window_id:win.id}));
    const r=read(await h.invoke({action:'act',snapshot:s.snapshot,target:'e2',kind:'invoke'}));
    assert.equal(r.acted,true);
    assert.equal(r.snapshot,undefined);
    assert.deepEqual({[Object.keys(post)[0]]:r[Object.keys(post)[0]]},post);
  }
});

test('window title wait does not require the window to exist beforehand; timeout is bounded', async () => {
  const h=harness([{ok:true,met:true,elapsed_ms:400}]);
  assert.deepEqual(read(await h.invoke({action:'wait',window:'New dialog',state:'appeared',timeout_ms:15000})),{met:true,elapsed_ms:400});
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].req.action,'wait');
  assert.equal(h.calls[0].opts.timeout,25000);
});

test('element wait forwards substring role/name and disappearance plus selected identity', async () => {
  const h=harness([windows(win),{ok:true,met:false,elapsed_ms:5000}]);
  const r=read(await h.invoke({action:'wait',window_id:win.id,element:{role:'but',name:'save'},state:'disappeared'}));
  assert.equal(r.met,false);
  assert.deepEqual(h.calls[1].req.element,{role:'but',name:'save'});
  assert.equal(h.calls[1].req.identity.started,win.started);
  assert.equal(h.calls[1].req.timeout_ms,5000);
});

test('zero timeout is accepted; invalid args never start a worker', async () => {
  const valid={action:'wait',window:'Editor',timeout_ms:0};
  assert.equal(validateArgs(valid),valid);
  const bad=[
    {},{action:'bad'},{action:'snapshot'},{action:'snapshot',window:'x',window_id:1},
    {action:'snapshot',window_id:1.5},{action:'windows',kind:'invoke'},
    {action:'wait',window:'x',timeout_ms:15001},{action:'wait',window:'x',timeout_ms:-1},
    {action:'wait',window:'x',element:{}},{action:'wait',window:'x',element:{role:4}},
    {action:'wait',window:'x',element:{role:'button',aid:'x'}},{action:'wait',window:'x',state:'oops'},
    {action:'act',snapshot:'s',target:'e0',kind:'invoke'},
    {action:'act',snapshot:'s',target:'e1',kind:'mouse'},
    {action:'act',snapshot:'s',target:'e1',kind:'keys',text:''},
    {action:'act',snapshot:'s',target:'e1',kind:'set_value'},
    {action:'act',snapshot:'s',target:'e1',kind:'invoke',text:'bad'},
    {action:'act',snapshot:'s',target:'e1',kind:'set_value',text:'a'.repeat(10001)},
  ];
  for (const args of bad) {
    const h=harness([]);
    await assert.rejects(h.invoke(args), e=>['BAD_ARGS','BAD_ACTION'].includes(e.code));
    assert.equal(h.calls.length,0);
  }
});

test('strict single-line JSON protocol and worker exit status', async () => {
  for (const r of [{code:0,stdout:'log\n{"ok":true}'},{code:0,stdout:'{broken'},
    {code:1,stdout:'{"ok":true}'},{code:0,stdout:''}]) {
    const h=harness([()=>r]);
    await assert.rejects(h.invoke({action:'windows'}),code('PS_FAILED'));
  }
});

test('calls are serialized and failed calls do not poison the queue', async () => {
  let release;
  const gate=new Promise(r=>{release=r;});
  const h=harness([async()=>{await gate;return reply(windows(win));},rawSnapshot()]);
  const p=h.invoke({action:'windows'}), q=h.invoke({action:'snapshot'});
  await new Promise(r=>setImmediate(r));
  assert.equal(h.calls.length,1);
  release(); await p;
  await assert.rejects(q,code('BAD_ARGS'));
  // No PS worker needed for the invalid second call.
  assert.equal(h.calls.length,1);
});

function fakeChild() {
  const child=new EventEmitter();
  child.stdout=new EventEmitter(); child.stderr=new EventEmitter(); child.pid=900001; child.kills=0;
  child.kill=()=>{child.kills++;};
  return child;
}
test('PowerShell boundary retains fail-closed password API and snapshot hard caps', () => {
  const ps=readFileSync(new URL('../src/uia.ps1',import.meta.url),'utf8');
  assert.match(ps,/GetCurrentPropertyValue\(AutomationElement.IsPasswordProperty, false\)/);  // default false = not a password (with true every element counted as one, 14.11)
  assert.match(ps,/return !\(p is bool\) \|\| \(bool\)p/);
  assert.match(ps,/ShownCap = 150, ScanCap = 2000, DepthCap = 8, WalkMs = 4000/);
  assert.match(ps,/TreeWalker.ControlViewWalker/);
  assert.match(ps,/matches.Count!=step.Dup/);
  assert.match(ps,/matches\[step.Nth\]/);
  assert.equal(/SetCursorPos|mouse_event|SendInput/.test(ps),false);
});
