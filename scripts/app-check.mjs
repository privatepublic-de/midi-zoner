// In-app check of loop playback, overdub, the loop's pedal, the takes file, long-run rollover
// and taking on an old loop. Runs the real app in a throwaway profile with virtual MIDI ports
// only (navigator.requestMIDIAccess is replaced before the app loads), so no device hears it.
// Run with `npm run check:app` (builds first; --keep keeps the profile, --debug prints the zones).
// Needs Node 22+ (global WebSocket). Takes about 40 s; the app's window shows while it runs.
//
// Against the code before the Nov 22 review fixes only the held key across a rollover fails:
// the take-on was saved by a later save anyway, setLoopOn() already lifted the pedal, the
// takes-file race isn't hit on purpose, and the timing then was 20 ms worst instead of 9 (both
// pass). Those stay as guards; the exact cases are in check:loops and the review's notes.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, wait, createApp, fakeMidiSource, withFakeMidi as reloadWithFakeMidi } from './app-harness.mjs';

const require = createRequire(import.meta.url);
const zoner = createApp();
const PROFILE = zoner.profile;
const KEEP = process.argv.includes('--keep');
const PROBE = process.argv.includes('--probe');

let fails = 0;
const ok = (c, m) => {
  console.log((c ? '  ok  ' : '  FAIL ') + m);
  if (!c) fails++;
};

const launch = () => zoner.launch();
const quit = (cdp) => zoner.quit(cdp);

// Virtual MIDI: one input (notes are put in with __check.play) and one output (records
// what's sent). Only these exist for the app: real devices are never opened.
const FAKE_MIDI = fakeMidiSource([{ id: 'chk-in', name: 'Check In' }], [{ id: 'chk-out', name: 'Check Out' }]);
const withFakeMidi = (cdp) => reloadWithFakeMidi(cdp, FAKE_MIDI);

// ---------- the scene ----------

const BAR = 96; // ticks of a 4/4 bar
const TEMPO = 240; // a bar is a second
const BAR_MS = 1000;
const LOOP_BARS = 4;
const OLD_AT = 1700000000000;

/** The test scene from a zone the app made (so every field is as the app writes it) */
function buildScene(template) {
  const { Take } = require(path.join(ROOT, 'dist/modules/zone/take.js'));
  const W = require(path.join(ROOT, 'dist/modules/zone/loop-window.js'));
  const zone = (id, label, channel, loop, enabled = true) => {
    const z = structuredClone(template.list[0]);
    Object.assign(z, { id, label, channel, preferredOutputPortId: 'chk-out', colorIndex: channel });
    z.arrangements = z.arrangements.map((a, i) => (i === 0 ? { ...a, enabled, loop: loop.toJSON(), loop_on: true } : a));
    return z;
  };
  // zA: 32 eighths over 4 bars, 60…75 twice, the pedal down throughout
  const a = new Take();
  a.length = LOOP_BARS * BAR;
  for (let i = 0; i < 32; i++) a.notes.push({ t: i * 12, d: 6, n: 60 + (i % 16), v: 100 });
  a.g = { c64: [0, 127] };
  // zB: a dense loop (3000 notes in 4 bars): what the clock path looks up every tick
  const b = new Take();
  b.length = LOOP_BARS * BAR;
  for (let i = 0; i < 3000; i++) b.notes.push({ t: (i * b.length) / 3000, d: 0.4, n: 30 + (i % 24), v: 80 });
  // zL: an old loop cut from a take (no link yet): the track view takes it on when it draws it
  const take = new Take();
  take.at = OLD_AT;
  take.length = 8 * BAR;
  for (let bar = 0; bar < 8; bar++) for (const p of [0, 24, 48, 72]) take.notes.push({ t: bar * BAR + p, d: 12, n: 48 + ((bar * 4 + p / 24) % 12), v: 90 });
  const old = W.cutWindow(take, 2 * BAR, 5 * BAR, {}).loop;
  old.origin = { at: OLD_AT, run: 2 * BAR };
  old.link = null;
  // zB and zL muted: what's played in goes to zA only (their loops play on: mute is for what you play)
  const list = [zone('chka', 'Loop', 0, a), zone('chkb', 'Dense', 1, b, false), zone('chkl', 'Old', 2, old, false)];
  const scene = {
    ...template,
    list,
    tempo: TEMPO,
    toggleQuantOn: false,
    clockOutputPorts: {},
    selectedInputPorts: { 'chk-in': { id: 'chk-in', ch: 0, isSelected: true } }
  };
  const takes = { format: 'midi-zoner-takes', version: 1, zones: { chkl: [take.toJSON()] } };
  return { scene, takes };
}

// ---------- reading what was sent ----------

const isOn = (m) => (m.d[0] & 0xf0) === 0x90 && m.d[2] > 0;
const chOf = (m) => m.d[0] & 0x0f;

/** The cycles of zA's loop: when each began (its first note, 60, on ch 1) */
function cycleStarts(sent) {
  const starts = [];
  let i = 0;
  for (const m of sent) {
    if (!isOn(m) || chOf(m) !== 0 || m.d[1] < 60 || m.d[1] > 75) continue;
    if (i % 32 === 0 && m.d[1] === 60) starts.push(m.t);
    i++;
  }
  return starts;
}

// ---------- run ----------

async function main() {
  try {
    if (PROBE) {
      const cdp = await launch();
      await withFakeMidi(cdp);
      console.log('visibility', await cdp.eval('document.visibilityState'));
      console.log('rAF', await cdp.eval('new Promise(r => { requestAnimationFrame(() => r("runs")); setTimeout(() => r("never"), 1000); })'));
      await quit(cdp);
      return;
    }

    console.log('setting up (first launch: a zone as the template)');
    let cdp = await launch();
    await withFakeMidi(cdp);
    await cdp.eval(`document.querySelector('.addnewzone a.action:not([data-part])').click()`);
    const template = await cdp.until(`(() => { const z = JSON.parse(localStorage.zones || '{}'); return z.list && z.list.length ? z : null; })()`);
    const { scene, takes } = buildScene(template);
    await cdp.eval(`localStorage.setItem('zones', ${JSON.stringify(JSON.stringify(scene))}); localStorage.setItem('viewMode', 'tracks'); true`);
    await quit(cdp);
    fs.writeFileSync(path.join(PROFILE, 'takes.json'), JSON.stringify(takes));

    console.log('second launch: the test scene');
    cdp = await launch();
    await withFakeMidi(cdp);
    await cdp.until(`document.querySelectorAll('#zones .track-lane').length >= 3 && JSON.parse(localStorage.zones).list.some(z => z.id === 'chkl')`, 10000, 'the three zones');

    if (process.argv.includes('--debug')) console.log(await cdp.eval(`JSON.parse(localStorage.zones).list.map(z => z.id + ':' + z.label + ':' + !!z.arrangements[0].loop).join(' ')`), await cdp.eval('document.querySelectorAll("#zones .track-lane").length'));
    // -- an old loop is taken on while drawn: saved, no undo step --
    await wait(1500);
    if (process.argv.includes('--debug')) console.log('after 1.5 s:', await cdp.eval(`JSON.parse(localStorage.zones).list.map(z => z.id + ':' + z.label + ':' + !!z.arrangements[0].loop).join(' ')`));
    const oldLoop = await cdp.eval(`JSON.parse(localStorage.zones).list.find(z => z.id === 'chkl').arrangements[0].loop`);
    ok(oldLoop && oldLoop.link, 'old loop taken on by the track view, and saved (its link is in localStorage)');
    ok(await cdp.eval(`document.querySelector('#undoBtn').disabled || document.querySelector('#undoBtn').classList.contains('disabled')`), 'taking it on is no undo step');

    // -- playing: the loop, the dense loop --
    await cdp.eval(`__check.sent.length = 0; document.querySelector('#startClockButton').click(); true`);
    await wait(LOOP_BARS * BAR_MS * 2 + 600);
    let sent = await cdp.eval('__check.sent');
    let starts = cycleStarts(sent);
    ok(starts.length >= 2, `zA's loop came round (${starts.length} cycles seen)`);
    const first = sent.filter((m) => isOn(m) && chOf(m) === 0 && m.t >= starts[0] && m.t < starts[0] + LOOP_BARS * BAR_MS - 50);
    ok(first.map((m) => m.d[1]).join() === [...Array(32).keys()].map((i) => 60 + (i % 16)).join(), 'a full cycle: all 32 notes, in order');
    const gaps = first.slice(1).map((m, i) => m.t - first[i].t);
    const worst = Math.max(...gaps.map((g) => Math.abs(g - 125)));
    ok(worst < 30, `eighths evenly spaced with 3000 notes looked up beside them (worst ${worst.toFixed(1)} ms off 125)`);
    const dense = sent.filter((m) => isOn(m) && chOf(m) === 1 && m.t >= starts[0] && m.t < starts[1]);
    ok(Math.abs(dense.length - 3000) <= 10, `zB's dense loop: ${dense.length} of 3000 notes in a cycle`);
    ok(sent.some((m) => m.d[0] === 0xb0 && m.d[1] === 64 && m.d[2] === 127), "zA's pedal went down with its loop");

    // -- overdub: press Dub just after a cycle's 1, play two notes, close a cycle later --
    const cyc = LOOP_BARS * BAR_MS;
    const nextStart = (now) => starts[0] + Math.ceil((now - starts[0]) / cyc) * cyc;
    const at = async (t) => cdp.eval(`new Promise(r => { const w = () => performance.now() >= ${t} ? r(true) : setTimeout(w, 1); w(); })`);
    const zA = await cdp.eval(`(() => { const el = [...document.querySelectorAll('#zones .showloop')][0]; return !!el; })()`);
    ok(zA, 'the Rec/Dub chip is there');
    const c1 = nextStart(await cdp.eval('performance.now()') + 300);
    await at(c1 + 100);
    await cdp.eval(`[...document.querySelectorAll('#zones .showloop')][0].click(); true`);
    await at(c1 + 500);
    await cdp.eval('__check.play([0x90, 90, 110]); true');
    await at(c1 + 600);
    await cdp.eval('__check.play([0x80, 90, 0]); true');
    await at(c1 + 2500);
    await cdp.eval('__check.play([0x90, 91, 110]); true');
    await at(c1 + 2600);
    await cdp.eval('__check.play([0x80, 91, 0]); true');
    // the second cycle: the overdub's layer plays them; close just after the third cycle's 1
    await at(c1 + 2 * cyc + 100);
    await cdp.eval(`[...document.querySelectorAll('#zones .showloop')][0].click(); true`);
    await at(c1 + 3 * cyc - 200);
    sent = await cdp.eval('__check.sent');
    starts = cycleStarts(sent);
    const offsets = (pitch) =>
      sent
        .filter((m) => isOn(m) && chOf(m) === 0 && m.d[1] === pitch)
        .map((m) => {
          const s = [...starts].reverse().find((c) => c <= m.t + 150) ?? starts[0];
          return { cycle: Math.round((s - c1) / cyc), off: m.t - s };
        });
    for (const [pitch, want] of [[90, 500], [91, 2500]]) {
      const o = offsets(pitch);
      const live = o.find((x) => x.cycle === 0);
      const layer = o.find((x) => x.cycle === 1);
      const merged = o.find((x) => x.cycle === 2);
      ok(live && Math.abs(live.off - want) < 150, `dub: ${pitch} played through live (${live?.off.toFixed(0)} ms into the cycle)`);
      ok(layer && live && Math.abs(layer.off - live.off) < 120, `dub: ${pitch} plays from the overdub's layer on its next cycle (${layer?.off.toFixed(0)} ms)`);
      ok(merged && live && Math.abs(merged.off - live.off) < 120, `dub closed: ${pitch} is in the loop (${merged?.off.toFixed(0)} ms)`);
    }
    const stored = await cdp.eval(`JSON.parse(localStorage.zones).list.find(z => z.id === 'chka').arrangements[0].loop.notes.map(n => n.n)`);
    ok(stored.includes(90) && stored.includes(91), 'the overdubbed loop is saved with both notes');

    // -- the loop switched off: its pedal lifts --
    // the time before the click: the lift goes out while the click is handled
    const offAt = await cdp.eval(`(() => { const t = performance.now(); [...document.querySelectorAll('#zones .showloopsw')][0].click(); return t; })()`);
    await wait(1200);
    sent = await cdp.eval('__check.sent');
    ok(sent.some((m) => m.t >= offAt - 5 && m.d[0] === 0xb0 && m.d[1] === 64 && m.d[2] === 0), "loop off: zA's pedal lifted");
    ok(!sent.some((m) => m.t > offAt + 300 && isOn(m) && chOf(m) === 0 && m.d[1] >= 60 && m.d[1] <= 75), 'loop off: no more of its notes');

    // -- a run past a take's limit: rolls over into a second take, a held key tied over --
    await cdp.eval(`(() => {
      __check.play([0x90, 50, 100]);
      for (let i = 0; i < 16400; i++) { __check.play([0x90, 100, 60]); __check.play([0x80, 100, 0]); }
      return true;
    })()`);
    await wait(500);
    await cdp.eval('__check.play([0x80, 50, 0]); true');
    await wait(300);

    // -- Stop, and close a moment later (the takes' async save under way, then the one on close) --
    await cdp.eval(`document.querySelector('#startClockButton').click(); true`);
    await wait(1020);
    await quit(cdp);
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(path.join(PROFILE, 'takes.json'), 'utf8'));
    } catch (e) {
      ok(false, 'takes.json is valid JSON: ' + e.message);
    }
    if (saved) {
      ok(true, 'takes.json is valid JSON after Stop and closing');
      const runTakes = (saved.zones.chka ?? []).filter((t) => t.at && t.at !== OLD_AT);
      ok(runTakes.length === 2 && runTakes[0].at === runTakes[1].at, `the long run rolled over: ${runTakes.length} takes of one run`);
      const held = runTakes.map((t) => t.notes.filter((n) => n.n === 50));
      ok(held.length === 2 && held[0].length === 1 && held[1].length === 1 && held[1][0].d > 1, 'the key held across it is in both parts, released in the second');
      ok(runTakes[0]?.notes.some((n) => n.n === 90), 'the first part has what was played into the overdub');
      ok(fs.readdirSync(PROFILE).every((f) => !f.endsWith('.tmp')), 'no temp files left');
    }
  } finally {
    await zoner.cleanup(KEEP);
  }
}

main().then(
  () => {
    if (!PROBE) console.log(fails ? `${fails} FAILED` : 'all ok');
    process.exitCode = fails ? 1 : 0;
  },
  (e) => {
    console.error(e);
    process.exitCode = 2;
  }
);
