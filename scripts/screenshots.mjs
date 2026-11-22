// Screenshots for the manual (the GitHub wiki, images/scr). Runs the real app in a throwaway
// profile with virtual MIDI ports only (see app-harness.mjs), sets up a demo scene, and
// captures each shot at 2× (the window is 1150 × 900: two columns of cards).
//
//   npm run screenshots                     all shots into ../midi-zoner.wiki/images/scr
//   npm run screenshots -- --out <dir>      somewhere else
//   npm run screenshots -- --only a,b       only these shots (names as in SHOTS)
//   npm run screenshots -- --list           list the shots
//   npm run screenshots -- --width 1400     another window width (default 1150: two columns of cards)
//   npm run screenshots -- --no-anim        only the stills
//   npm run screenshots -- --keep           keep the profile (to look at it in the app)
//
// Animations (anim-*) are GIFs: the GitHub wiki plays them inline (a video there would be a link).
// They are screencasts with a drawn pointer (a screencast has none), encoded by ffmpeg at the
// frames' own timing. Needs ffmpeg on the PATH; --no-anim leaves them out.
//
// The window must stay visible while it runs: lanes are drawn in requestAnimationFrame,
// which a hidden window doesn't run. Takes ~2 minutes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, wait, createApp, fakeMidiSource, withFakeMidi } from './app-harness.mjs';

const require = createRequire(import.meta.url);
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const OUT = path.resolve(arg('--out') ?? path.join(ROOT, '..', 'midi-zoner.wiki', 'images', 'scr'));
// shots taken inside another one
const PART_OF = { 'param-locks': 'seq-melodic', 'device-presets': 'controller-edit' };
const ONLY = arg('--only')?.split(',').map((n) => PART_OF[n] ?? n);
const KEEP = process.argv.includes('--keep');
const NO_ANIM = process.argv.includes('--no-anim');
const DEBUG = process.argv.includes('--debug');

// the narrowest window with two columns of cards (styles.css: 2 × 560 + gaps + scrollbar)
const W = Number(arg('--width') ?? 1150);
const H = 900;
const TEMPO = 100;
const BAR = 96;
const BEAT = 24;

// ---------- ports (invented names, so no one's real gear shows) ----------

const INPUTS = [
  { id: 'kbd', name: 'Keyboard' },
  { id: 'mpekbd', name: 'MPE Keyboard' },
  { id: 'pads', name: 'Pad Controller' }
];
const OUTPUTS = [
  { id: 'mpesynth', name: 'MPE Synth' },
  { id: 'poly', name: 'Poly Synth' },
  { id: 'bass', name: 'Bass Synth' },
  { id: 'drums', name: 'Drum Machine' },
  { id: 'mxd', name: 'minilogue xd' }
];

// ---------- the demo scene ----------

/** A small seeded PRNG, so every run gives the same humanised takes */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PC = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const pitch = (name) => {
  const m = name.match(/^([A-G][#b]?)(\d)$/);
  return 12 * (+m[2] + 1) + PC[m[1]];
};

/**
 * A played line: bars of "Name:beats" (r = rest), from bar `from`, humanised (timing,
 * length, velocity), as take notes {t, d, n, v}
 */
function played(bars, seed, from = 0) {
  const r = rng(seed);
  const notes = [];
  bars.forEach((bar, i) => {
    let beat = 0;
    for (const tok of bar.trim().split(/\s+/)) {
      const [name, len] = tok.split(':');
      const L = parseFloat(len);
      if (name !== 'r') {
        const t = (from + i) * BAR + beat * BEAT + (r() - 0.4) * 4;
        notes.push({ t: Math.max(0, t), d: L * BEAT * (0.78 + r() * 0.15), n: pitch(name), v: Math.round(72 + r() * 38 + (beat === 0 ? 8 : 0)) });
      }
      beat += L;
    }
  });
  return notes;
}

/** A series [dt, value, …], dt in 1/8 ticks since the previous point (note-curve.ts) */
function series(points) {
  const out = [];
  let prev = 0;
  for (const [t, v] of points) {
    const at = Math.round(t * 8);
    out.push(at - prev, Math.round(v));
    prev = at;
  }
  return out;
}

/** MPE expression for a played note: a press that swells and fades, vibrato on long ones, a slide drifting */
function expression(note, r) {
  const d = note.d;
  const peak = 85 + r() * 40;
  const press = [[0, 40], [Math.min(4, d * 0.2), peak * 0.8], [d * 0.5, peak], [d, peak * 0.55], [d + 6, 0]];
  const slide = [[0, 50 + r() * 20], [d, 60 + r() * 40]];
  const x = { press: series(press), slide: series(slide) };
  if (d > 30) {
    const bend = [[0, 0]];
    for (let t = 8; t < d; t += 4) bend.push([t, Math.sin((t - 8) / 4 * 1.6) * Math.min(1, (t - 8) / 16) * 25]);
    bend.push([d, 0]);
    x.bend = series(bend);
  }
  return x;
}

// The newest take: an original line in D minor, a pick-up into bar 1, eight bars, a bar's rest
const LINE = [
  'r:3 A3:0.5 C4:0.5',
  'D4:0.5 F4:0.5 A4:1 G4:0.5 F4:0.5 E4:1',
  'D4:1.5 C4:0.5 D4:2',
  'F4:0.5 A4:0.5 C5:1 Bb4:0.5 A4:0.5 G4:1',
  'A4:3 A3:0.5 C4:0.5',
  'D5:1 C5:0.5 A4:0.5 G4:1 F4:0.5 G4:0.5',
  'A4:1.5 G4:0.5 F4:1 E4:1',
  'D4:0.5 E4:0.5 F4:0.5 G4:0.5 A4:1 C5:0.5 Bb4:0.5',
  'A4:1 G4:0.5 E4:0.5 D4:2',
  'r:4'
];
const NOODLE_1 = ['D4:1 F4:1 A4:2', 'G4:1 F4:0.5 E4:0.5 D4:2', 'r:2 A4:1 C5:1', 'D5:2 r:2'];
const NOODLE_2 = ['A4:0.5 G4:0.5 F4:1 E4:1 D4:1', 'C4:2 D4:2', 'F4:1 G4:1 A4:2', 'r:4', 'D5:0.5 C5:0.5 A4:1 G4:2', 'F4:1 E4:1 D4:2'];

function takeOf(id, bars, seed, at, seq, mpe) {
  const r = rng(seed + 1);
  const notes = played(bars, seed);
  if (mpe) for (const n of notes) n.x = expression(n, r);
  const length = bars.length * BAR;
  // the pedal down for two bars at a time, the mod wheel brought in over the second half
  const c64 = [];
  for (let b = 1; b < bars.length - 1; b += 2) c64.push(b * BAR + 2, 127, (b + 2) * BAR - 3, 0);
  const half = Math.floor(bars.length / 2) * BAR;
  const g = { c64, c1: [0, 0, half, 0, half + 2 * BAR, 70, length - BAR, 20] };
  return { id, start: 0, length, notes, at, seq, runOffset: 0, g };
}

const step = (notes, extra = {}) => ({
  notesArray: notes.map((n) => ({ number: typeof n === 'string' ? pitch(n) : n, velo: 100, channel: 0 })),
  length: 1,
  probability: 1,
  condition: 0,
  gateLength: 0.6,
  ...extra
});

function buildScene(template) {
  const { styleById, styleSettings } = require(path.join(ROOT, 'dist/modules/zone/chord-styles.js'));
  const base = template.list[0];
  let colour = 0;
  const zone = (id, label, port, channel, set = {}, arr = {}) => {
    const z = structuredClone(base);
    Object.assign(z, { id, label, channel, preferredOutputPortId: port, colorIndex: colour++ }, set);
    z.arrangements = z.arrangements.map((a, i) => (i === 0 ? { ...a, ...arr } : a));
    return z;
  };

  // Pluck: the minilogue xd's Filter/EG controllers, a 16-step line with locks on the cutoff
  const preset = JSON.parse(fs.readFileSync(path.join(ROOT, 'res/device-presets/korg-minilogue-xd-filter-eg.json'), 'utf8'));
  // locks by the app's own addresses (10-bit knobs: 0–1023)
  const { controllerAddress } = require(path.join(ROOT, 'dist/modules/zone/param-locks.js'));
  const addr = (label) => controllerAddress(preset.controllers.find((c) => c.label === label));
  const cutoff = addr('Cutoff');
  const resonance = addr('Resonance');
  const pluckSteps = Array(16).fill(null);
  const line = ['D3', null, 'A3', 'D4', null, 'C4', 'A3', null, 'F3', null, 'C4', 'F4', 'E4', null, 'C4', 'A3'];
  line.forEach((n, i) => {
    if (!n) return;
    const extra = {};
    if (i === 3) Object.assign(extra, { locks: [{ a: cutoff, v: 820 }, { a: resonance, v: 610 }], slide: true });
    if (i === 11) extra.locks = [{ a: cutoff, v: 240 }];
    if (i === 12) Object.assign(extra, { probability: 0.5 });
    if (i === 14) Object.assign(extra, { ratchetCount: 3, ratchetResolution: 3 });
    pluckSteps[i] = step([n], extra);
  });

  // Drums: kick, snare, closed hat, clap
  const lane = (label, note, hits, velo = 100) => ({
    label,
    note,
    enabled: true,
    solo: false,
    length: 16,
    steps: Array.from({ length: 16 }, (_, i) => (hits.includes(i) ? { ...step([note]), notesArray: [{ number: note, velo, channel: 9 }] } : null))
  });
  const drumLanes = [
    lane('Kick', 36, [0, 6, 8, 11]),
    lane('Snare', 38, [4, 12]),
    lane('Hat', 42, [0, 2, 4, 6, 8, 10, 12, 14, 15], 80),
    lane('Clap', 39, [12])
  ];
  while (drumLanes.length < 12) drumLanes.push({ label: '', note: 36 + drumLanes.length, enabled: true, solo: false, length: 16, steps: Array(16).fill(null) });

  const seqOf = (steps, more = {}) => ({ ...base.arrangements[0].sequence, active: true, steps, length: steps.length, ...more });
  const piano = styleById('piano');
  const held = ['D3', 'F3', 'A3', 'C4'].map((n) => ({ number: pitch(n), velo: 96, channel: 0, isBlackKey: false }));

  const list = [
    zone('lead', 'Lead', 'mpesynth', 0, { inputPortId: 'mpekbd', mpe: 2, low: 48, high: 96 }),
    zone('keys', 'Keys', 'poly', 0, { chords: { part: 'chords', follows: 'lead' } }, { chord_set: styleSettings(piano, 'chords') }),
    zone('bass', 'Bass', 'bass', 0, { chords: { part: 'bass', follows: 'lead' } }, { chord_set: styleSettings(piano, 'bass') }),
    zone('drums', 'Drums', 'drums', 9, { show_seq_panel: true }, { sequence: seqOf(Array(16).fill(null), { isDrumSequence: true, drumLanes: 4, drum_lanes: drumLanes }) }),
    zone('pluck', 'Pluck', 'mxd', 0, { inputPortId: 'pads', inputChannel: 0, cc_controllers: preset.controllers, devicePreset: { id: 'factory/korg-minilogue-xd-filter-eg', name: preset.name }, show_seq_panel: true, show_cc: true }, { sequence: seqOf(pluckSteps), swingAmount: 0.2 }),
    zone('arp', 'Arp', 'poly', 1, { show_arp_panel: true }, { arp_enabled: true, arp_hold: true, arp_direction: 2, arp_octaves: 1, arp_holdlist: held, arp_sortedHoldList: held, euclid_hits: 7, euclid_length: 8 })
  ];
  const scene = {
    ...template,
    list,
    tempo: TEMPO,
    toggleQuantOn: true,
    clockOutputPorts: {},
    selectedInputPorts: { kbd: { id: 'kbd', ch: 0, isSelected: true } },
    outputConfigNames: { 'poly,0': 'E-Piano', 'poly,1': 'Strings', 'mxd,0': 'minilogue xd' },
    knownPortNames: Object.fromEntries([...INPUTS, ...OUTPUTS].map((p) => [p.id, p.name]))
  };
  const day = Date.UTC(2026, 10, 21, 20, 0);
  const takes = {
    format: 'midi-zoner-takes',
    version: 1,
    zones: {
      lead: [takeOf('lt1', NOODLE_1, 11, day, 1, true), takeOf('lt2', NOODLE_2, 12, day + 300000, 2, true), takeOf('lt3', LINE, 13, day + 600000, 3, true)]
    }
  };
  return { scene, takes };
}

// ---------- driving the app ----------

let cdp = null;
let vw = 0;
let vh = 0;
/** Sets the window's size (CSS px, at 2×) */
async function viewport(width = W, height = H) {
  vw = width;
  vh = height;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await wait(400);
}
/** Runs `fn` in a window tall enough that the cards never scroll (shots of one element) */
async function tall(fn) {
  await viewport(W, 2800);
  try {
    await fn();
  } finally {
    await viewport();
  }
}
const js = (expr) => cdp.eval(expr);
const click = (sel, i = 0) => js(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); return true; })()`);
const rect = (sel, i = 0) =>
  js(`(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);

async function mouse(type, x, y, buttons = 1) {
  await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : buttons, clickCount: 1 });
}
async function press(x, y) {
  await mouse('mouseMoved', x, y, 0);
  await mouse('mousePressed', x, y);
  await mouse('mouseReleased', x, y);
}
/** Moves the pointer out of the way, so nothing shows hovered */
const parkMouse = () => mouse('mouseMoved', vw - 2, vh - 2, 0);

const view = async (v) => {
  await click(v === 'tracks' ? '#viewTracks' : '#viewCards');
  await wait(400);
};
const running = () => js(`document.querySelector('#startClockButton').classList.contains('active') || document.body.classList.contains('running')`);
async function transport(on) {
  const now = await js(`!!(window.__zonerRunning)`);
  if (now === on) return;
  await click('#startClockButton');
  await js(`window.__zonerRunning = ${on}; true`);
  await wait(300);
}
/** Waits for `bars` bars at the demo tempo */
const bars = (n) => wait((n * 4 * 60000) / TEMPO);

/** Captures `clip` ({x, y, width, height} in CSS pixels, grown by `pad`) into OUT/name.png */
async function capture(name, clip = null, pad = 0) {
  clip ??= { x: 0, y: 0, width: vw, height: vh };
  await parkMouse();
  await wait(250);
  const c = {
    x: Math.max(0, clip.x - pad),
    y: Math.max(0, clip.y - pad),
    width: Math.min(vw, clip.width + 2 * pad),
    height: Math.min(vh, clip.height + 2 * pad),
    scale: 1
  };
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: c });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
  console.log(`  ${name}.png  ${Math.round(c.width * 2)} × ${Math.round(c.height * 2)}`);
}
const captureEl = async (name, sel, pad = 8, i = 0) => {
  const r = await rect(sel, i);
  if (!r) throw new Error(`${name}: no ${sel}`);
  await capture(name, r, pad);
};
/** The union of several elements' rectangles */
async function union(sels) {
  const rs = (await Promise.all(sels.map((s) => (Array.isArray(s) ? rect(...s) : rect(s))))).filter(Boolean);
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  return { x, y, width: Math.max(...rs.map((r) => r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.y + r.height)) - y };
}
const zoneSel = (i) => `#zones > .zone:nth-of-type(${i + 1})`;

// ---------- the shots ----------

async function key(k) {
  const code = { Escape: 'Escape' }[k] ?? k;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: k === 'Escape' ? 27 : 0 });
  await wait(200);
}
/** Presses the middle of an element (a real mouse press, for handlers on mousedown) */
async function pressEl(sel, i = 0) {
  const r = await rect(sel, i);
  if (!r) throw new Error('no ' + sel);
  await press(r.x + r.width / 2, r.y + r.height / 2);
  await wait(200);
}
const top = () => js(`window.scrollTo({ top: 0, behavior: 'instant' }); document.querySelector('#zones').scrollTop = 0; true`);
const dock = async (open) => {
  const folded = await js(`document.body.classList.contains('dock-closed')`);
  if (folded === open) await click('.td-collapse');
  await wait(300);
};
/** Selects the lead's track: a press on the empty bottom left of its header */
async function selectLead() {
  const r = await rect(zoneSel(0));
  await press(r.x + 12, r.y + r.height - 10);
  await wait(200);
}
/** Picks the lead's shown take in the track view: a click on its pick-up bar, left of the loop's window */
async function pickLeadTake() {
  await selectLead();
  const r = await rect(`${zoneSel(0)} .track-lane`);
  await press(r.x + r.width * 0.3 + 30, r.y + 28 + 30);
  await wait(300);
}
/** Picks the lead's loop: a click on its block in the song lane */
async function pickLeadLoop() {
  await selectLead();
  const r = await rect(`${zoneSel(0)} .track-lane`);
  await press(r.x + r.width * 0.3 + 200, r.y + r.height - 30);
  await wait(300);
}

// ---------- animations ----------

/** A drawn pointer for screencasts: follows the mouse events sent, rings on a press */
const POINTER = `(() => {
  if (document.getElementById('__ptr')) return true;
  const p = document.createElement('div');
  p.id = '__ptr';
  p.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;' +
    'background:rgba(255,255,255,.9);box-shadow:0 0 0 2px rgba(0,0,0,.55);pointer-events:none;display:none;transition:transform .12s, box-shadow .12s';
  document.body.appendChild(p);
  addEventListener('mousemove', (e) => { p.style.left = e.clientX + 'px'; p.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => { p.style.transform = 'scale(.75)'; p.style.boxShadow = '0 0 0 2px rgba(0,0,0,.55), 0 0 0 9px rgba(255,255,255,.35)'; }, true);
  addEventListener('mouseup', () => { p.style.transform = ''; p.style.boxShadow = '0 0 0 2px rgba(0,0,0,.55)'; }, true);
  return true;
})()`;
let pointerAt = [0, 0];
const showPointer = (on) => js(`${POINTER} && (document.getElementById('__ptr').style.display = '${on ? 'block' : 'none'}', true)`);
/** Moves the pointer to (x, y) over `ms`, as a hand would */
async function glide(x, y, ms = 500) {
  const [x0, y0] = pointerAt;
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await mouse('mouseMoved', x0 + (x - x0) * e, y0 + (y - y0) * e, 0);
    await wait(16);
  }
  pointerAt = [x, y];
}
/** Glides to the middle of an element and clicks it */
async function glideClick(sel, i = 0, ms = 500) {
  const r = await rect(sel, i);
  if (!r) throw new Error('no ' + sel);
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  await glide(x, y, ms);
  await wait(150);
  await mouse('mousePressed', x, y);
  await wait(90);
  await mouse('mouseReleased', x, y);
}

/**
 * Records `fn` as OUT/name.gif, cropped to `clip` (CSS px; a selector, a list of them, or a
 * rectangle; the whole window when left out), at 1× and `fps` frames a second
 */
async function record(name, clip, fn, { fps = 12, colours = 128 } = {}) {
  if (NO_ANIM) return;
  const frames = [];
  const off = cdp.on('Page.screencastFrame', (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await showPointer(true);
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  try {
    await fn();
    await wait(300);
  } finally {
    await cdp.send('Page.stopScreencast');
    off();
    await showPointer(false);
  }
  if (frames.length < 2) throw new Error(`${name}: no frames`);
  const r = typeof clip === 'string' ? await rect(clip) : Array.isArray(clip) ? await union(clip) : clip ?? { x: 0, y: 0, width: vw, height: vh };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoner-anim-'));
  try {
    let list = '';
    frames.forEach((f, i) => {
      const file = path.join(dir, `f${String(i).padStart(5, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      const d = i + 1 < frames.length ? frames[i + 1].t - f.t : 1.5;
      list += `file '${file}'\nduration ${Math.max(0.001, d).toFixed(3)}\n`;
    });
    // the concat demuxer takes the last frame's duration only when it is listed again
    list += `file '${path.join(dir, `f${String(frames.length - 1).padStart(5, '0')}.png`)}'\n`;
    fs.writeFileSync(path.join(dir, 'list.txt'), list);
    // frames are at 2× (the device scale): crop there, then down to 1×
    const k = 2;
    const crop = `crop=${Math.round(r.width * k)}:${Math.round(r.height * k)}:${Math.round(r.x * k)}:${Math.round(r.y * k)}`;
    const filter = `${crop},fps=${fps},scale=iw/2:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colours}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    const out = path.join(OUT, name + '.gif');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', filter, '-loop', '0', out]);
    const secs = frames[frames.length - 1].t - frames[0].t;
    console.log(`  ${name}.gif  ${Math.round(r.width)} × ${Math.round(r.height)}, ${secs.toFixed(1)} s, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Keys and Bass without their loops: they follow the lead live (its key, "live", Finish / Open end) */
async function followLive(fn) {
  const off = async () => {
    await click(`${zoneSel(1)} .showloopsw`);
    await click(`${zoneSel(2)} .showloopsw`);
    await wait(300);
  };
  await off();
  try {
    await fn();
  } finally {
    await off();
  }
}

// Each one leaves the app as it found it: cards, stopped, nothing open, scrolled to the top
const SHOTS = {
  // ---- cards ----
  async 'mz-full-dark'() {
    await followLive(async () => {
      await transport(true);
      await bars(5);
      await capture('mz-full-dark');
      await transport(false);
    });
  },
  async toolbar() {
    await captureEl('toolbar', '#midisettings', 0);
  },
  async 'setup-drawer'() {
    await click('#setupToggle');
    await wait(400);
    await capture('setup-drawer', await union(['#midisettings', '#setupDrawer']), 0);
    await click('#setupToggle');
    await wait(300);
  },
  async 'single-zone'() {
    await tall(async () => {
      await captureEl('single-zone', zoneSel(0), 4);
    });
  },
  async routing() {
    await tall(async () => {
      await click(`${zoneSel(4)} .iorouting-display`);
      await wait(400);
      await capture('routing', await union([`${zoneSel(4)} .iorouting`, `${zoneSel(4)} .iorouting-popup`]), 4);
      await click(`${zoneSel(4)} .iorouting-display`);
      await wait(300);
    });
  },
  async mpe() {
    await tall(async () => {
      await click(`${zoneSel(0)} .iorouting-display`);
      await wait(400);
      await capture('mpe', await union([`${zoneSel(0)} .iorouting`, `${zoneSel(0)} .iorouting-popup`]), 8);
      await click(`${zoneSel(0)} .iorouting-display`);
      await wait(300);
    });
  },
  async 'zone-settings'() {
    await tall(async () => {
      await click(`${zoneSel(0)} .cf-thru`);
      await wait(400);
      await captureEl('zone-settings', `${zoneSel(0)} .thru-panel`, 6);
      await click(`${zoneSel(0)} .cf-thru`);
      await wait(300);
    });
  },
  async arp() {
    await tall(async () => {
      await captureEl('arp', `${zoneSel(5)} .arp-settings-block`, 6);
    });
  },
  async 'seq-drum'() {
    await tall(async () => {
      await captureEl('seq-drum', `${zoneSel(3)} .seq`, 6);
    });
  },
  async 'mz-controllers'() {
    await tall(async () => {
      await captureEl('mz-controllers', `${zoneSel(4)} .ccpots`, 6);
    });
  },
  async 'seq-melodic'() {
    await tall(async () => {
      await pressEl(`${zoneSel(4)} .seq .step`, 3);
      await captureEl('seq-melodic', `${zoneSel(4)} .seq`, 6);
      // the step with locks still selected: its knobs show the locked values
      await capture('param-locks', await union([`${zoneSel(4)} .seq`, `${zoneSel(4)} .ccpots`]), 6);
      await key('Escape');
    });
  },
  async 'piano-roll'() {
    await click(`${zoneSel(4)} .seq-pianoroll`);
    await wait(700);
    await capture('piano-roll');
    await key('Escape');
  },
  async 'controller-edit'() {
    await click(`${zoneSel(4)} [data-action$=":cc_edit"]`);
    await wait(700);
    // Cutoff, the second row (the first is its section): its settings show the most
    await pressEl('#ccEditor .cce-rows .cce-row', 1);
    await wait(300);
    await capture('controller-edit');
    await click('#ccEditor .cce-preset-button');
    await wait(500);
    await captureEl('device-presets', '#contextmenu', 6);
    await key('Escape');
    await key('Escape');
  },
  async 'chords-cards'() {
    await tall(() =>
      followLive(async () => {
        await transport(true);
        await bars(3);
        await capture('chords-cards', await union([zoneSel(0), zoneSel(1), zoneSel(2)]), 4);
        await transport(false);
      })
    );
  },
  async 'chords-sheet'() {
    await click(`${zoneSel(1)} .cs-edit`);
    await wait(700);
    await capture('chords-sheet');
    await key('Escape');
  },
  async 'add-control'() {
    await tall(async () => {
      await captureEl('add-control', '#zones .addnewzone', 8);
    });
  },
  async 'mini-view'() {
    // the mini window: 420 CSS px at its zoom of 0.8
    await click('#miniViewBtn');
    await viewport(336, H);
    await wait(600);
    if (process.argv.includes('--debug')) console.log('  mini:', await js(`[innerWidth, devicePixelRatio, document.querySelector('#midisettings').scrollWidth]`));
    await capture('mini-view', await union(['#midisettings', '#zones']), 0);
    await click('#miniViewBtn');
    await viewport();
  },

  // ---- tracks ----
  async 'track-view'() {
    await view('tracks');
    await pressEl(`${zoneSel(0)} .track-lane`);
    await pickLeadLoop();
    await click('.td-tab[data-tab="notes"]');
    await wait(500);
    await capture('track-view');
    await view('cards');
  },
  async 'take-editor'() {
    await view('tracks');
    // a taller dock than the default, so the take's rows are readable (set first: the editor fits its notes when it opens)
    await js(`document.body.style.setProperty('--dock-open-h', '560px'); true`);
    await wait(300);
    await pickLeadTake();
    await click('.td-tab[data-tab="notes"]');
    await wait(500);
    await captureEl('take-editor', '#trackDock', 0);
    await js(`document.body.style.removeProperty('--dock-open-h'); true`);
    await view('cards');
  },
  async 'loop-window'() {
    await view('tracks');
    await pickLeadLoop();
    await captureEl('loop-window', zoneSel(0), 4);
    await view('cards');
  },
  async 'track-view-running'() {
    await view('tracks');
    await dock(false);
    await transport(true);
    await bars(6);
    await capture('track-view-running');
    await transport(false);
    await dock(true);
    await view('cards');
  },
  // ---- animations ----
  // Recording a loop: Rec on a 1, a phrase, Rec again; it plays at once (Pluck has an input of its own)
  async 'anim-loop-record'() {
    await viewport(W, 1200);
    await view('tracks');
    await dock(false);
    // only what is played shows: Pluck's sequence off for this (stopped, so at once); its track selected
    await click(`${zoneSel(4)} .showseq`);
    const r = await rect(zoneSel(4));
    await press(r.x + 12, r.y + r.height - 10);
    pointerAt = [r.x + 200, r.y + r.height - 20];
    await wait(300);
    const beat = 60000 / TEMPO;
    const chip = `${zoneSel(4)} .showloop`;
    const chipText = () => js(`document.querySelector('${chip}').textContent.replace(/\\s+/g, ' ').trim()`);
    const chipLog = [];
    const logger = DEBUG ? setInterval(() => chipText().then((t) => (chipLog.length === 0 || chipLog[chipLog.length - 1][1] !== t) && chipLog.push([Date.now() % 100000, t])), 50) : null;
    try {
    // Pluck's row grows a take lane once it records: Arp's row below keeps the crop steady
    await record('anim-loop-record', [zoneSel(4), zoneSel(5)], async () => {
      await transport(true);
      // Rec late in bar 1: it waits for the coming 1 (blinks)
      await wait(1300);
      await glideClick(chip, 0, 600);
      // recording from that 1: two bars of a phrase in eighths
      await cdp.until(`/Rec 1/.test(document.querySelector('${chip}').textContent)`, 5000, 'the recording');
      const phrase = ['D4', 'F4', 'A4', 'C5', 'A4', 'F4', 'G4', 'E4', 'D4', 'E4', 'F4', 'A4', 'G4', 'E4', 'C4', 'D4'];
      const t0 = Date.now();
      const playing = (async () => {
        for (let i = 0; i < phrase.length; i++) {
          const n = pitch(phrase[i]);
          await wait(Math.max(0, t0 + (i * beat) / 2 - Date.now()));
          await js(`__check.play([0x90, ${n}, 100], 'pads'); true`);
          await wait(Math.max(0, t0 + (i * beat) / 2 + beat * 0.38 - Date.now()));
          await js(`__check.play([0x80, ${n}, 0], 'pads'); true`);
        }
      })();
      // Rec again while the chip says a press makes 2 bars (it says so for a bar, from the middle
      // of the second): the loop closes at that 1 and plays at once
      await cdp.until(`/Rec 2/.test(document.querySelector('${chip}').textContent)`, 8000, 'Rec 2');
      const r = await rect(chip);
      await glide(r.x + r.width / 2, r.y + r.height / 2, 500);
      await wait(400);
      if (DEBUG) console.log('    pressing at', await chipText(), await js('performance.now()'));
      await glideClick(chip, 0, 50);
      await playing;
      if (DEBUG) {
        await wait(600);
        console.log('    after:', await chipText(), JSON.stringify(chipLog));
      }
      // it comes round twice
      await wait(2 * 4 * beat + 1500);
      await transport(false);
    });
    } finally {
      if (logger) clearInterval(logger);
      if (DEBUG) console.log('    chip:', JSON.stringify(chipLog));
    }
    if (DEBUG) console.log('    loop:', await js(`(() => { const l = JSON.parse(localStorage.zones).list[4].arrangements[0].loop; return l && [l.length / ${BAR}, l.notes.length, l.notes.map(n => n.p ? 'p' : '').join('')]; })()`));
    // back as it was: no loop on Pluck, its sequence on
    await click('#undoBtn');
    await wait(300);
    await click(`${zoneSel(4)} .showseq`);
    await dock(true);
    await view('cards');
    await viewport();
  },
  // Chords and bass follow the lead live: the key heard, the chord in each switch, their lanes
  async 'anim-chords'() {
    await followLive(async () => {
      await transport(true);
      await bars(1);
      await record('anim-chords', [zoneSel(0), zoneSel(1)], () => bars(4), { fps: 10 });
      await transport(false);
    });
  },
  // A take becomes the loop: another take, Loop n bars hovered (its bars outlined), clicked
  async 'anim-take-to-loop'() {
    await view('tracks');
    await pickLeadTake();
    await record('anim-take-to-loop', zoneSel(0), async () => {
      await wait(500);
      await glideClick('.tc-prev', 0, 700);
      await wait(700);
      const r = await rect('.tc-keep');
      await glide(r.x + r.width / 2, r.y + r.height / 2, 600);
      await wait(1400);
      await glideClick('.tc-keep', 0, 100);
      await wait(1500);
    });
    // the scene as before: the newest take's loop, its take shown
    await click('#undoBtn');
    await wait(300);
    await click('.tc-next').catch(() => undefined);
    await view('cards');
  },
  // last: it leaves a loop on Pluck
  async 'loop-recording'() {
    await view('tracks');
    await dock(false);
    await transport(true);
    await bars(1);
    await click(`${zoneSel(4)} .showloop`);
    const line = ['D4', 'F4', 'A4', 'C5', 'A4', 'F4', 'G4', 'E4', 'D4', 'A3', 'C4', 'D4'];
    for (const n of line) {
      await js(`__check.play([0x90, ${pitch(n)}, 96], 'pads'); true`);
      await wait(((60000 / TEMPO) / 2) * 0.8);
      await js(`__check.play([0x80, ${pitch(n)}, 0], 'pads'); true`);
      await wait(((60000 / TEMPO) / 2) * 0.2);
    }
    await capture('loop-recording', await union(['#trackRuler', zoneSel(4)]), 4);
    await transport(false);
    await dock(true);
    await view('cards');
  }
};

// ---------- run ----------

async function main() {
  if (process.argv.includes('--list')) return console.log(Object.keys(SHOTS).join('\n'));
  const zoner = createApp({ prefix: 'zoner-shots-' });
  const FAKE = fakeMidiSource(INPUTS, OUTPUTS);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    console.log('first launch: a zone as the template');
    cdp = await zoner.launch();
    await withFakeMidi(cdp, FAKE);
    await click('.addnewzone a.action:not([data-part])');
    const template = await cdp.until(`(() => { const z = JSON.parse(localStorage.zones || '{}'); return z.list && z.list.length ? z : null; })()`);
    const { scene, takes } = buildScene(template);
    await js(`localStorage.setItem('zones', ${JSON.stringify(JSON.stringify(scene))}); localStorage.setItem('viewMode', 'tracks'); true`);
    await zoner.quit(cdp);
    fs.writeFileSync(path.join(zoner.profile, 'takes.json'), JSON.stringify(takes));

    console.log('second launch: the demo scene');
    cdp = await zoner.launch();
    await withFakeMidi(cdp, FAKE);
    await viewport();
    await cdp.until(`document.querySelectorAll('#zones > .zone').length >= ${scene.list.length}`, 10000, 'the demo zones').catch(async (e) => {
      console.log(await js(`[document.querySelectorAll('#zones .zone').length, (JSON.parse(localStorage.zones).list || []).map(z => z.id + ':' + z.label).join(' ')]`));
      throw e;
    });
    // no toasts in the pictures
    await js(`(() => { const s = document.createElement('style'); s.textContent = '#toast { display: none !important; }'; document.head.appendChild(s); return true; })()`);

    // The lead's newest take becomes its loop (Loop n bars in the track view); its followers make theirs
    await wait(800);
    await press(...(await js(`(() => { const r = document.querySelector('${zoneSel(0)} .track-lane').getBoundingClientRect(); return [r.x + 40, r.y + 20]; })()`)));
    await wait(300);
    await click('.tc-keep');
    await wait(500);
    // Keys keeps the chords it works out from the lead's loop as its own loop (Bass gets one with it)
    await click(`${zoneSel(1)} .showloop`);
    await wait(1500);
    const loops = await js(`JSON.parse(localStorage.zones).list.map(z => z.label + ':' + !!(z.arrangements[0].loop))`);
    console.log('  loops:', loops.join(' '));
    await view('cards');

    for (const [name, shot] of Object.entries(SHOTS)) {
      if (ONLY && !ONLY.includes(name)) continue;
      await top();
      await shot();
    }
    await zoner.quit(cdp);
  } finally {
    await zoner.cleanup(KEEP);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
