/**
 * Chord accompaniment for a line (experiment, Nov 2026): finds the line's key and mode,
 * picks a chord progression for it and plays it out as notes for another zone's loop.
 *
 * Three pure stages, no zone or DOM:
 * - analyse(): weighs the line's pitch classes (length × beat strength × velocity) and ranks
 *   keys in all 7 modes; the tonic comes from emphasis (first, last, long and downbeat notes).
 * - progress(): one chord per beat group of the meter, chosen over the whole loop at once
 *   (Viterbi on a cycle: the last chord leads into the first). `harmony` 0 = circle of
 *   fifths (ii–V–I, secondary dominants, cadence into the 1) … 1 = modal (tonic, the mode's
 *   own chord, steps, sus and fourths, no leading tone). `changes` sets how often chords
 *   change. `frozen` fixes the first chords (live: the ones already played).
 * - realise(): voices the chords with the least movement under the line and plays them in
 *   a rhythm from on-beat (pads, quarters) to off-beat (pushes, backbeat chops, off-beat 8ths).
 */
import { Meter, DEFAULT_METER, barTicks, beatOffsets } from '../meter';
import { PPQ } from './seq-layer';
import { hashRoll } from '../prng';

export interface LineNote {
  t: number;
  d: number;
  n: number;
  v: number;
  p?: 1;
}

export const MODES = ['Ionian', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Aeolian', 'Locrian'] as const;
const IONIAN = [0, 2, 4, 5, 7, 9, 11];
/** Scale steps of each mode from its tonic */
const MODE_STEPS = MODES.map((_, m) => IONIAN.map((_, i) => (IONIAN[(i + m) % 7] - IONIAN[m] + 12) % 12));
/** The degree (0-based) whose triad carries the mode's own colour; -1: none */
const CHARACTERISTIC = [-1, 3, 1, 1, 6, 5, -1];
const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export interface Key {
  tonic: number; // pitch class
  mode: number; // index of MODES
  score: number;
}

export interface Analysis {
  keys: Key[]; // best first
  /** how far ahead the best is of the next with another tonic or pitch set (0…1, low = unsure) */
  margin: number;
  /** pitch classes the line never uses (left for the harmony to choose) */
  missing: number[];
}

type Quality = 'maj' | 'min' | 'dim' | 'aug' | '7' | 'sus4' | 'sus2' | 'q';
const QUALITY: Record<Quality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '7': [0, 4, 7, 10],
  sus4: [0, 5, 7],
  sus2: [0, 2, 7],
  q: [0, 5, 10]
};

export interface Chord {
  root: number; // pitch class
  quality: Quality;
  /** scale degree in the key (0-based), -1 if borrowed or chromatic */
  degree: number;
  /** what kind: diatonic, secondary dominant, borrowed, modal colour */
  /** `out`: free harmony (Harmony past FREE_FROM), a chord from outside the key on any root */
  kind: 'dia' | 'sec' | 'bor' | 'mod' | 'out';
  prior: number;
}

export interface HarmonyOptions {
  harmony: number; // 0 circle of fifths … 1 modal
  changes: number; // 0 slow (every 2 bars) … 1 fast (on beats)
  rhythm: number; // 0 on-beat … 1 off-beat
  colour: number; // 0 triads … 1 sevenths and ninths
  /** 0 = the best; others give other good choices ("Other chords") */
  seed: number;
  /** voicing range (MIDI notes); default under the line */
  low?: number;
  high?: number;
  /** 0 short stabs … 0.5 the rhythm's own lengths … 1 legato (up to the next hit) */
  length?: number;
  /** -1 louder on the beats … 0 flat … 1 louder off the beat (8ths and 16ths between) */
  accents?: number;
  /** -1 7ths, 9ths and b5 softer … 1 louder than the triad */
  tensions?: number;
  /** 0 even … 1 velocities vary by up to ±14 (with the seed) */
  vary?: number;
  /** 0 chords together … 1 rolled, the 7th / b5 and 9th coming in later */
  unfold?: number;
  /** semitones up or down from where the voicing would go */
  register?: number;
  /** the bass: 0 roots held … root and fifth … with approach notes … 1 walking, with skips */
  bassMove?: number;
  /** the bass: 0 straight … anticipations and off-beats … 1 wild (16th pickups and re-strikes) */
  syncopation?: number;
  /** chords: 0 even … 1 barking (strong hits loud and short, the others soft and held) */
  dynamics?: number;
  /** chords: 0 off, 1 down (low notes first, a guitar's downstroke), 2 up (high first), 3 down on the beats and up between */
  strum?: number;
  /** the zone's swing (0 straight … 1): each beat's second half later, the rest stretched along */
  swing?: number;
  /** chords: leave out the root (and the fifth with 9ths) when a bass zone plays it (shell voicings) */
  shell?: boolean;
  /** blues: the key's I, IV and V are dominant seventh chords */
  blues?: boolean;
  /** live: chords kept, per segment (null: free to choose) */
  frozen?: (Chord | null)[];
  /** live: the key found earlier (hysteresis), else analysed */
  key?: Key;
}

const EARLY = 3; // ticks before a beat that belong to it (as the looper's)

function lerp(a: number, b: number, x: number): number {
  return a + (b - a) * x;
}

export function chordTones(c: Chord): number[] {
  return QUALITY[c.quality].map((i) => (c.root + i) % 12);
}

export function chordName(c: Chord): string {
  const r = NAMES[c.root];
  switch (c.quality) {
    case 'maj': return r;
    case 'min': return r + 'm';
    case 'dim': return r + '°';
    case 'aug': return r + '+';
    case '7': return r + '7';
    case 'sus4': return r + 'sus4';
    case 'sus2': return r + 'sus2';
    case 'q': return r + '4ths'; // stacked fourths
  }
}

export function keyName(k: Key): string {
  return `${NAMES[k.tonic]} ${MODES[k.mode]}`;
}

// ---------------------------------------------------------------- segments

export interface Segment {
  t: number;
  end: number;
  bar: number;
  beat: number; // index of the beat group in its bar
  beats: number; // beat groups in its bar
}

/** One segment per beat group of the meter, over the loop (a last part bar too) */
export function segmentsOf(length: number, meter: Meter = DEFAULT_METER): Segment[] {
  const bar = barTicks(meter);
  const offs = beatOffsets(meter);
  const segs: Segment[] = [];
  for (let b = 0; b * bar < length; b++) {
    offs.forEach((o, i) => {
      const t = b * bar + o;
      if (t >= length) return;
      const end = Math.min(length, i + 1 < offs.length ? b * bar + offs[i + 1] : (b + 1) * bar);
      segs.push({ t, end, bar: b, beat: i, beats: offs.length });
    });
  }
  return segs;
}

/** How strong a note start is: on the bar 1, on a beat 0.7, on an 8th 0.45, else 0.3 */
function strength(t: number, meter: Meter): number {
  const bar = barTicks(meter);
  const at = ((t % bar) + bar) % bar;
  if (at < 0.5) return 1;
  if (beatOffsets(meter).some((o) => Math.abs(o - at) < 0.5)) return 0.7;
  if (Math.abs(at % (PPQ / 2)) < 0.5) return 0.45;
  return 0.3;
}

/** Notes a few ticks early belong to the beat; pick-ups keep their place (they lead into the 1) */
function onBeat(n: LineNote, segs: Segment[]): number {
  for (const s of segs) if (s.t - n.t > 0 && s.t - n.t <= EARLY) return s.t;
  return n.t;
}

/** Weighted pitch classes per segment: overlap in beats × start strength × velocity */
function weighSegments(line: LineNote[], length: number, segs: Segment[], meter: Meter): number[][] {
  const w = segs.map(() => new Array(12).fill(0));
  for (const n of line) {
    const t = onBeat(n, segs);
    const end = Math.min(length, t + Math.max(n.d, 1));
    const st = strength(t, meter) * (n.p ? 0.6 : 1);
    const vel = 0.6 + 0.4 * (n.v / 127);
    segs.forEach((s, i) => {
      const o = Math.min(end, s.end) - Math.max(t, s.t);
      if (o <= 0) return;
      // where the note starts it counts with its strength, held on into later segments less
      const k = t >= s.t && t < s.end ? st : 0.35;
      w[i][n.n % 12] += (o / PPQ) * k * vel + (t >= s.t && t < s.end ? 0.25 * st : 0);
    });
  }
  return w;
}

// ---------------------------------------------------------------- analyse

/** Minor modes (Dorian, Aeolian): their raised 7th leads into the tonic as in harmonic minor (D# in E minor) */
const MINOR_MODES = [1, 5];

/**
 * Ranks keys for a line. `begins`: the line begins here, so its first strong note names the
 * tonic; live it is a window of what was played last, whose first note is only a beginning when
 * nothing came before it. `window`: a live window, which doesn't end where the line ends: its
 * latest note is only where the line is now (often the fifth, a tune starting again), so the
 * tonic comes from where its phrases came to rest instead
 */
export function analyse(line: LineNote[], length: number, meter: Meter = DEFAULT_METER, harmony = 0.5, begins = true, window = false): Analysis {
  const segs = segmentsOf(length, meter);
  const seg = weighSegments(line, length, segs, meter);
  const hist = new Array(12).fill(0);
  seg.forEach((s) => s.forEach((x, pc) => (hist[pc] += x)));
  const total = hist.reduce((a, b) => a + b, 0) || 1;

  // emphasis: the first strong note, the last note (live: where phrases rest), notes on bar 1s, the longest notes
  const emph = new Array(12).fill(0);
  const sorted = [...line].filter((n) => !n.p).sort((a, b) => a.t - b.t);
  // live, an emphasised note may also be the fifth of the tonic (`fifth`: how likely): a tune's first
  // note and a phrase's rest (a half cadence) often are, a downbeat less so (a riff's IV and V)
  const vote = (pc: number, w: number, fifth: number) => {
    emph[pc] += w;
    if (window) emph[(pc + 5) % 12] += fifth * w;
  };
  if (sorted.length) {
    const first = sorted.find((n) => strength(n.t, meter) >= 0.7) ?? sorted[0];
    if (begins) vote(first.n % 12, 1, 0.6);
    if (!window) {
      // the last note names the tonic when it lands: on a 1, or held with a rest after it; a loop goes
      // round, so a long note leading straight back into its first (a turnaround) isn't an ending
      const last = sorted.reduce((a, b) => (b.t + b.d >= a.t + a.d ? b : a));
      const rest = length - (last.t + last.d) + sorted[0].t >= PPQ;
      emph[last.n % 12] += strength(onBeat(last, segs), meter) === 1 || (last.d >= PPQ * 1.5 && rest) ? 2 : last.d >= PPQ * 1.5 ? 1.4 : 0.6;
    } else {
      // where its phrases came to rest
      phraseEndings(line, length, meter).forEach((w, pc) => vote(pc, w, 0.8));
    }
    const longest = Math.max(...sorted.map((n) => n.d));
    for (const n of sorted) {
      if (strength(onBeat(n, segs), meter) === 1) vote(n.n % 12, 0.5, 0.3);
      if (n.d >= longest * 0.8) vote(n.n % 12, 0.4, 0.3);
    }
    // the lowest note often names the tonic in a riff
    const lowest = Math.min(...sorted.map((n) => n.n));
    emph[lowest % 12] += 0.15;
  }
  const emphTotal = emph.reduce((a, b) => a + b, 0) || 1;

  const prior = [0.06, 0.035, 0.0, 0.015, 0.035, 0.05, -0.25];
  // with the line open between two modes, the modal end likes the colourful one
  const modalLean = [0, 0.04, 0.01, 0.03, 0.04, -0.01, 0];
  const keys: Key[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (let mode = 0; mode < 7; mode++) {
      const steps = MODE_STEPS[mode];
      let fit = 0;
      for (let pc = 0; pc < 12; pc++) {
        const rel = (pc - tonic + 12) % 12;
        const deg = steps.indexOf(rel);
        let p = -0.7;
        if (deg === 0) p = 1;
        else if (deg === 4 || deg === 2) p = 0.8;
        else if (deg >= 0) p = 0.55;
        // minor: the leading tone belongs to the key (harmonic minor), Aeolian's raised 6th leads up to it (melodic minor)
        else if (MINOR_MODES.includes(mode) && rel === 11) p = 0.35;
        else if (mode === 5 && rel === 9) p = -0.2;
        fit += (hist[pc] / total) * p;
      }
      const fifth = (tonic + steps[4]) % 12;
      const score = fit + 0.5 * (emph[tonic] / emphTotal) + 0.12 * (emph[fifth] / emphTotal) + prior[mode] + harmony * modalLean[mode];
      keys.push({ tonic, mode, score });
    }
  }
  keys.sort((a, b) => b.score - a.score);
  const best = keys[0];
  const bestSet = scaleOf(best).join();
  const rival = keys.find((k) => k.tonic !== best.tonic || scaleOf(k).join() !== bestSet);
  const missing = hist.map((x, pc) => (x < total * 0.005 ? pc : -1)).filter((pc) => pc >= 0);
  return { keys, margin: rival ? Math.max(0, Math.min(1, (best.score - rival.score) * 4)) : 1, missing };
}

/**
 * Where a line's phrases came to rest, per pitch class: notes on a beat held two beats or
 * followed by a beat's rest (1 on a bar's 1, 0.6 on another beat)
 */
export function phraseEndings(line: LineNote[], length: number, meter: Meter = DEFAULT_METER): number[] {
  const segs = segmentsOf(length, meter);
  const sorted = [...line].filter((n) => !n.p).sort((a, b) => a.t - b.t);
  const out = new Array(12).fill(0);
  sorted.forEach((n, i) => {
    // a long note rushed by up to an 8th rests on the beat it anticipates
    const ahead = n.d >= PPQ ? segs.find((sg) => sg.t > n.t && sg.t - n.t <= PPQ / 2) : undefined;
    const st = Math.max(strength(onBeat(n, segs), meter), ahead ? strength(ahead.t, meter) : 0);
    if (st < 0.7) return;
    const next = sorted.slice(i + 1).find((m) => m.t > n.t + EARLY);
    const rest = next ? next.t - (n.t + n.d) >= PPQ : n.t + n.d + PPQ <= length;
    if (n.d >= 2 * PPQ || rest) out[n.n % 12] += st === 1 ? 1 : 0.6;
  });
  return out;
}

export function scaleOf(k: Key): number[] {
  return MODE_STEPS[k.mode].map((s) => (k.tonic + s) % 12).sort((a, b) => a - b);
}

/** The notes that belong to the key: its scale, in minor modes with the leading tone (not for voicing: no Em(maj7)) */
export function keyTones(k: Key): number[] {
  const s = scaleOf(k);
  return MINOR_MODES.includes(k.mode) ? [...s, (k.tonic + 11) % 12] : s;
}

// ---------------------------------------------------------------- chords

function triadOn(key: Key, deg: number): Quality {
  const s = MODE_STEPS[key.mode];
  const third = (s[(deg + 2) % 7] - s[deg] + 12) % 12;
  const fifth = (s[(deg + 4) % 7] - s[deg] + 12) % 12;
  if (third === 4 && fifth === 7) return 'maj';
  if (third === 3 && fifth === 7) return 'min';
  if (third === 3 && fifth === 6) return 'dim';
  return 'aug';
}

/**
 * How much the circle-of-fifths end likes a chord, by its root's distance from the tonic: in
 * major I, IV, V first; in minor the relative major (bIII), bVI and bVII are as common as ii and vi
 */
const FUNCTIONAL = [1, 0.3, 0.5, 0.55, 0.15, 0.7, 0.05, 0.8, 0.5, 0.5, 0.5, 0.05];

/** The chords to choose from, with how much the harmony setting likes each */
export function vocabulary(key: Key, h: number, blues = false): Chord[] {
  const s = MODE_STEPS[key.mode];
  const out: Chord[] = [];
  const add = (c: Chord) => {
    if (c.prior <= -0.4) return;
    const same = out.find((o) => o.root === c.root && o.quality === c.quality);
    if (same) same.prior = Math.max(same.prior, c.prior);
    else out.push(c);
  };
  for (let deg = 0; deg < 7; deg++) {
    const quality = triadOn(key, deg);
    const root = (key.tonic + s[deg]) % 12;
    let modal = deg === 0 ? 1.2 : deg === CHARACTERISTIC[key.mode] ? 0.9 : 0.3;
    // a diminished fifth against the tonic chord blurs a mode
    if (quality === 'dim' || quality === 'aug') modal = -0.5;
    let fn = FUNCTIONAL[s[deg]];
    if (quality === 'dim' || quality === 'aug') fn -= 0.6;
    // in minor modes the fifth degree's own chord is weak functionally (no leading tone)
    if (deg === 4 && quality === 'min') fn = 0.35;
    // blues: I, IV and V as dominant sevenths (in place of their triads)
    const q = blues && (deg === 0 || deg === 3 || deg === 4) && quality !== 'dim' ? ('7' as Quality) : quality;
    add({ root, quality: q, degree: deg, kind: 'dia', prior: lerp(fn, modal, h) + (q !== quality ? 0.2 : 0) });
  }
  const fifths = 1 - h;
  const middle = 4 * h * (1 - h);
  // the dominant seventh with a leading tone, also in minor modes
  add({ root: (key.tonic + 7) % 12, quality: '7', degree: 4, kind: 'sec', prior: 0.85 * fifths - 0.5 * h });
  // secondary dominants: the seventh chord a fifth above a major or minor degree
  for (const deg of [1, 3, 4, 5]) {
    const q = triadOn(key, deg);
    if (q !== 'maj' && q !== 'min') continue;
    const target = (key.tonic + s[deg]) % 12;
    add({ root: (target + 7) % 12, quality: '7', degree: -1, kind: 'sec', prior: 0.12 * fifths - 0.6 * h });
  }
  // borrowed: iv, bVI, bVII in major modes; IV major in minor ones
  const major = s[2] === 4;
  if (major) {
    // (not with blues 7ths: the blues' IV is a dominant seventh, not a minor iv)
    if (!blues) add({ root: (key.tonic + 5) % 12, quality: 'min', degree: -1, kind: 'bor', prior: 0.35 * middle });
    add({ root: (key.tonic + 8) % 12, quality: 'maj', degree: -1, kind: 'bor', prior: 0.35 * middle });
    add({ root: (key.tonic + 10) % 12, quality: 'maj', degree: -1, kind: 'bor', prior: 0.4 * middle });
  } else {
    add({ root: (key.tonic + 5) % 12, quality: 'maj', degree: -1, kind: 'bor', prior: 0.3 * middle });
  }
  // modal colour: sus and stacked fourths on the tonic and the characteristic degree
  add({ root: key.tonic, quality: 'sus4', degree: 0, kind: 'mod', prior: 0.9 * h - 0.45 });
  add({ root: key.tonic, quality: 'sus2', degree: 0, kind: 'mod', prior: 0.9 * h - 0.45 });
  add({ root: key.tonic, quality: 'q', degree: 0, kind: 'mod', prior: 1.0 * h - 0.55 });
  const ch = CHARACTERISTIC[key.mode];
  if (ch > 0) add({ root: (key.tonic + s[ch]) % 12, quality: 'q', degree: ch, kind: 'mod', prior: 0.8 * h - 0.5 });
  // free harmony: past FREE_FROM chords leave the key: stacked fourths, dominant sevenths (tritone
  // substitutes and more), augmented and minor chords on every root; the line still decides
  if (h > FREE_FROM) {
    const free = (h - FREE_FROM) / (1 - FREE_FROM);
    for (let root = 0; root < 12; root++) {
      add({ root, quality: 'q', degree: -1, kind: 'out', prior: -0.35 + 0.6 * free });
      add({ root, quality: '7', degree: -1, kind: 'out', prior: -0.39 + 0.5 * free });
      add({ root, quality: 'aug', degree: -1, kind: 'out', prior: -0.39 + 0.4 * free });
      add({ root, quality: 'min', degree: -1, kind: 'out', prior: -0.39 + 0.4 * free });
    }
  }
  return out;
}

/** How well a chord carries the line in one segment (weighted pitch classes) */
export function fitOf(w: number[], c: Chord, key: Key): number {
  const cp = chordTones(c);
  const scale = keyTones(key);
  let f = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (!w[pc]) continue;
    let x: number;
    if (pc === c.root) x = 1.1;
    else if (cp.includes(pc)) x = 1;
    // a half step over a chord tone (b9) clashes most
    else if (cp.includes((pc + 11) % 12)) x = -1.3;
    else if (scale.includes(pc)) x = -0.15;
    else x = -0.8;
    f += w[pc] * x;
  }
  return f;
}

/**
 * Free harmony's unpredictability: past FREE_FROM each chord gets a push up or down per beat
 * (with the seed: the same each time round), growing towards the right edge
 */
export function freeNoise(o: HarmonyOptions, seg: { bar: number; beat: number }, c: Chord): number {
  const h = Math.max(0, Math.min(1, o.harmony));
  if (h <= FREE_FROM) return 0;
  const free = (h - FREE_FROM) / (1 - FREE_FROM);
  return (hashRoll(o.seed + 1301, seg.bar * 16 + seg.beat, c.root, QUALITY_INDEX[c.quality]) - 0.5) * 2.4 * free;
}

/** Harmony above this: free harmony (chords from outside the key) */
export const FREE_FROM = 0.85;

/** Root motion a → b, as the harmony setting likes it */
export function transition(a: Chord, b: Chord, key: Key, h: number): number {
  if (a.root === b.root && a.quality === b.quality) return 0;
  const i = (b.root - a.root + 12) % 12;
  const F = [0.1, -0.3, 0.45, 0.3, 0.3, 1.0, -0.5, 0.35, 0.4, 0.5, 0.45, 0.1];
  const M = [0.3, 0.2, 0.6, 0.3, 0.2, 0.3, -0.3, 0.4, 0.4, 0.3, 0.7, 0.2];
  let t = lerp(F[i], M[i], h);
  if (a.quality === '7') t += (i === 5 ? 0.4 : -1) * (1 - h) - 0.3 * h;
  // one secondary dominant at a time: a chain of them reads as a modulation
  if (a.kind === 'sec' && b.kind === 'sec' && b.root !== (key.tonic + 7) % 12) t -= 0.8;
  if (b.root === key.tonic || a.root === key.tonic) t += 0.3 * h;
  return t;
}

// ---------------------------------------------------------------- progress

export interface Progression {
  key: Key;
  analysis?: Analysis;
  segments: Segment[];
  chords: Chord[]; // one per segment
}

/** The cost of a chord change at a segment's start */
export function changeCost(s: Segment, changes: number): number {
  if (s.beat === 0) return s.bar % 2 === 1 ? lerp(0.6, 0, changes) : lerp(0.1, 0, changes);
  if (s.beats % 2 === 0 && s.beat === s.beats / 2) return lerp(1.6, 0.15, changes);
  return lerp(3, 0.35, changes);
}

export function progress(line: LineNote[], length: number, meter: Meter, o: HarmonyOptions): Progression {
  const h = Math.max(0, Math.min(1, o.harmony));
  const analysis = o.key ? undefined : analyse(line, length, meter, h);
  const key = o.key ?? analysis!.keys[0];
  const segs = segmentsOf(length, meter);
  const w = weighSegments(line, length, segs, meter);
  const voc = vocabulary(key, h, !!o.blues);
  const K = voc.length;
  const N = segs.length;
  const frozen = o.frozen ?? [];
  const fixed = frozen.map((c) => (c ? voc.findIndex((v) => v.root === c.root && v.quality === c.quality) : -1));
  frozen.forEach((c, i) => {
    if (c && fixed[i] < 0) {
      // a chord from outside this key's choices: one entry for all its beats (so it holds)
      let k = voc.findIndex((v) => v.root === c.root && v.quality === c.quality);
      if (k < 0) {
        voc.push({ ...c, prior: 0 });
        k = voc.length - 1;
      }
      fixed[i] = k;
    }
  });
  const KK = voc.length;

  // per segment and chord: fit + prior (+ seeded noise per bar and chord for "Other chords")
  const node: number[][] = segs.map((s, i) =>
    voc.map((c, k) => {
      const len = (s.end - s.t) / PPQ;
      let x = fitOf(w[i], c, key) + 0.25 * c.prior * len;
      if (o.seed) x += (hashRoll(o.seed, s.bar, c.root, QUALITY_INDEX[c.quality]) - 0.5) * 1.2 * len;
      x += freeNoise(o, s, c) * len;
      return x;
    })
  );
  const trans: number[][] = voc.map((a) => voc.map((b) => transition(a, b, key, h)));
  const cadenceFirst = (c: Chord) => (c.root === key.tonic && c.degree === 0 ? 0.6 * (1 - h) + 0.4 * h : 0);
  const cadenceLast = (c: Chord) => (c.root === (key.tonic + 7) % 12 && (c.quality === 'maj' || c.quality === '7') ? 0.6 * (1 - h) : 0);
  // a change into segment i costs trans[a][b] + off[i] (staying costs nothing)
  const off = segs.map((s) => -changeCost(s, o.changes) + (s.beat === 0 ? 0.25 * (1 - h) : 0));
  const step = (i: number, a: number, b: number) => (a === b ? 0 : trans[a][b] + off[i]);
  const allowed = (i: number, k: number) => (fixed[i] >= 0 ? fixed[i] === k : k < K);
  const lastBonus = voc.map(cadenceLast);

  // An upper bound per first chord, from one backward pass: rest[b] = the best from segment i on
  // in chord b, with the closing step (last → first) bounded by its best over every first chord
  let rest = new Array(KK).fill(-Infinity);
  for (let b = 0; b < KK; b++) {
    if (!allowed(N - 1, b)) continue;
    let close = N > 1 ? -Infinity : 0;
    if (N > 1) for (let f = 0; f < K; f++) close = Math.max(close, step(0, b, f));
    rest[b] = node[N - 1][b] + lastBonus[b] + close;
  }
  for (let i = N - 2; i >= 1; i--) {
    const prev = rest;
    rest = new Array(KK).fill(-Infinity);
    for (let a = 0; a < KK; a++) {
      if (!allowed(i, a)) continue;
      let m = -Infinity;
      for (let b = 0; b < KK; b++) if (prev[b] > -Infinity) m = Math.max(m, prev[b] + step(i + 1, a, b));
      rest[a] = node[i][a] + m;
    }
  }

  // Viterbi for each first chord, then close the cycle (last → first). The most promising first
  // chords go first, and one whose bound can't beat the best is skipped: the same result, far fewer runs
  const firsts = (fixed[0] >= 0 ? [fixed[0]] : [...Array(K).keys()]).map((f) => {
    let u = node[0][f] + cadenceFirst(voc[f]);
    if (N > 1) {
      let m = -Infinity;
      for (let b = 0; b < KK; b++) if (rest[b] > -Infinity) m = Math.max(m, rest[b] + step(1, f, b));
      u += m;
    } else u += lastBonus[f];
    return { f, u };
  });
  firsts.sort((x, y) => y.u - x.u || x.f - y.f);
  let best = -Infinity;
  let bestFirst = -1;
  let bestPath: number[] = [];
  const EPS = 1e-9;
  for (const { f, u } of firsts) {
    if (u < best - EPS || (u <= best + EPS && f > bestFirst)) continue;
    let score = new Array(KK).fill(-Infinity);
    score[f] = node[0][f] + cadenceFirst(voc[f]);
    const back: number[][] = [];
    for (let i = 1; i < N; i++) {
      const next = new Array(KK).fill(-Infinity);
      const from = new Array(KK).fill(0);
      const o_i = off[i];
      for (let b = 0; b < KK; b++) {
        if (!allowed(i, b)) continue;
        let nb = -Infinity;
        let fb = 0;
        for (let a = 0; a < KK; a++) {
          const sa = score[a];
          if (sa === -Infinity) continue;
          const x = a === b ? sa : sa + trans[a][b] + o_i;
          if (x > nb) {
            nb = x;
            fb = a;
          }
        }
        next[b] = nb + node[i][b];
        from[b] = fb;
      }
      back.push(from);
      score = next;
    }
    for (let last = 0; last < KK; last++) {
      if (score[last] === -Infinity) continue;
      const total = score[last] + (N > 1 ? step(0, last, f) : 0) + lastBonus[last];
      // ties go to the lower first chord, as when they were tried in order
      if (total > best || (total === best && f < bestFirst)) {
        best = total;
        bestFirst = f;
        const path = [last];
        for (let i = N - 2; i >= 0; i--) path.unshift(back[i][path[0]]);
        bestPath = path;
      }
    }
  }
  return { key, analysis, segments: segs, chords: bestPath.map((k) => voc[k]) };
}

export const QUALITY_INDEX: Record<Quality, number> = { maj: 0, min: 1, dim: 2, aug: 3, '7': 4, sus4: 5, sus2: 6, q: 7 };

/** Chords merged over segments: where each one starts and ends */
export function spans(p: Progression): { chord: Chord; t: number; end: number }[] {
  const out: { chord: Chord; t: number; end: number }[] = [];
  p.chords.forEach((c, i) => {
    const s = p.segments[i];
    const last = out[out.length - 1];
    if (last && last.chord === c) last.end = s.end;
    else out.push({ chord: c, t: s.t, end: s.end });
  });
  return out;
}

/** "| Dm . G7 . | C . . . |": the chart, a dot where the chord holds */
export function chart(p: Progression): string {
  let s = '';
  p.chords.forEach((c, i) => {
    const seg = p.segments[i];
    if (seg.beat === 0) s += '| ';
    const name = i > 0 && p.chords[i - 1] === c ? '.' : chordName(c);
    s += name.padEnd(6);
  });
  return s + '|';
}

// ---------------------------------------------------------------- realise

export interface Accompaniment {
  progression: Progression;
  notes: LineNote[]; // chords
  bass: LineNote[]; // roots, for a second zone
  rhythm: string; // the rhythm's name
}

/** Chord tones with the colour: sevenths, then ninths, left out where they'd clash with the line */
function voicedTones(c: Chord, key: Key, colour: number, line: number[], h: number, shell = false): number[] {
  const base = QUALITY[c.quality].map((i) => (c.root + i) % 12);
  const scale = scaleOf(key);
  const clash = (pc: number) => line.includes((pc + 1) % 12) || line.includes((pc + 11) % 12);
  const add = (pc: number) => {
    if (!base.includes(pc) && !clash(pc) && (scale.includes(pc) || c.quality === '7')) base.push(pc);
  };
  if (c.quality === 'maj' || c.quality === 'min' || c.quality === 'dim') {
    if (colour > 0.3) {
      // the scale's seventh over the root (maj7, m7, m7b5), or b7 when it isn't in the scale
      const seventh = [11, 10].map((i) => (c.root + i) % 12).find((pc) => scale.includes(pc));
      if (seventh !== undefined) add(seventh);
    }
    // the modal end trades the seventh for a sixth on the tonic now and then: plainer
    if (colour > 0.65) add((c.root + 2) % 12);
  } else if (c.quality === '7' && colour > 0.65) {
    add((c.root + 2) % 12);
  } else if (c.quality === 'q' && colour > 0.5) {
    add((c.root + 3 * 5) % 12); // a fourth fourth
  }
  void h;
  // shells: over a bass zone, a chord with its seventh leaves the root out (and the fifth with a 9th)
  if (shell && base.length >= 4 && base.some((pc) => pc === (c.root + 10) % 12 || pc === (c.root + 11) % 12)) {
    base.splice(base.indexOf(c.root % 12), 1);
    const fifth = (c.root + 7) % 12;
    if (base.length >= 4 && base.includes(fifth)) base.splice(base.indexOf(fifth), 1);
  }
  return base;
}

/** Colour below this: power chords */
export const POWER_BELOW = 0.1;

export function isPower(o: HarmonyOptions): boolean {
  return (o.colour ?? 1) < POWER_BELOW;
}

/** Root, the chord's own fifth and the octave (or root and fifth where the octave doesn't fit) */
function powerVoicings(chord: Chord, low: number, high: number): number[][] {
  const tones = QUALITY[chord.quality];
  const fifth = tones.includes(7) ? 7 : tones.includes(6) ? 6 : tones.includes(8) ? 8 : 7;
  const out: number[][] = [];
  // a little slack: three notes an octave wide don't always fit a narrow range (the cost keeps it near)
  for (let r = low - 5; r <= high; r++) {
    if (r % 12 !== chord.root) continue;
    if (r + 12 <= high + 5) out.push([r, r + fifth, r + 12]);
    else if (r + fifth <= high + 5) out.push([r, r + fifth]);
  }
  return out;
}

function voicings(tones: number[], low: number, high: number): number[][] {
  // every inversion, close and open (drop 2), in range
  const out: number[][] = [];
  const n = tones.length;
  for (let inv = 0; inv < n; inv++) {
    const order = [...tones.slice(inv), ...tones.slice(0, inv)];
    for (let base = low - 12; base <= high; base++) {
      if (base % 12 !== order[0]) continue;
      const close = [base];
      for (let i = 1; i < n; i++) {
        let x = close[i - 1] + 1;
        while (x % 12 !== order[i]) x++;
        close.push(x);
      }
      const drop2 = n >= 4 ? [close[n - 2] - 12, ...close.filter((_, i) => i !== n - 2)].sort((a, b) => a - b) : null;
      for (const v of drop2 ? [close, drop2] : [close]) {
        if (v[0] >= low && v[v.length - 1] <= high) out.push(v);
      }
    }
  }
  return out;
}

function movement(a: number[], b: number[]): number {
  // the nearest note of a for each of b, both ways (voice counts may differ)
  const near = (x: number, set: number[]) => Math.min(...set.map((y) => Math.abs(x - y)));
  return b.reduce((s, x) => s + near(x, a), 0) + a.reduce((s, x) => s + near(x, b), 0) * 0.5;
}

interface Hit {
  t: number; // from the chord's start (may be negative: a push)
  d: number;
  v: number;
}

export const RHYTHMS = ['Held', 'Beats', 'Pushes', 'Backbeat', 'Off-beats', 'Eighths', 'Scattered', 'Charleston'] as const;
/** The order the Rhythm dropdown lists them: on the beat from held to busy, then off the beat, then free (indices of RHYTHMS; new ones are appended there, saved settings keep theirs) */
export const RHYTHM_ORDER = [0, 1, 3, 5, 2, 7, 4, 6];

/** The 8ths of a span, from its start (ticks from the span's start) */
function eighthsOf(span: { t: number; end: number }, meter: Meter): number[] {
  const out: number[] = [];
  const eighth = PPQ / 2;
  void meter;
  for (let t = Math.ceil(span.t / eighth) * eighth; t < span.end - 0.5; t += eighth) out.push(t - span.t);
  return out;
}

/**
 * Irregular hits: each 16th of the span may hit, by a density that changes from bar to bar (some
 * bars nearly empty, some busy) and leans off the beat; a hit sometimes runs into the next 16th
 * (a burst). Positions come from the bar and the seed, so a bar plays the same each time round
 */
function scatteredHits(span: { t: number; end: number }, meter: Meter, seed: number): Hit[] {
  const sixteenth = PPQ / 4;
  const bar = barTicks(meter);
  const offs = beatOffsets(meter);
  const hits: Hit[] = [];
  let burst = false;
  for (let t = Math.ceil(span.t / sixteenth) * sixteenth; t < span.end - 0.5; t += sixteenth) {
    const b = Math.floor(t / bar);
    const at = ((t % bar) + bar) % bar;
    const i = Math.round(at / sixteenth);
    const density = 0.12 + 0.4 * hashRoll(seed + 911, b, 999, 2);
    const onBeat = offs.some((o) => Math.abs(o - at) < 0.5);
    const onEighth = Math.abs(at % (PPQ / 2)) < 0.5;
    const chance: number = density * (onBeat ? 0.7 : onEighth ? 1.3 : 0.8) + (burst ? 0.35 : 0);
    burst = hashRoll(seed + 911, b, i, 1) < chance;
    if (burst) hits.push({ t: t - span.t, d: sixteenth, v: 70 + Math.round(25 * hashRoll(seed + 911, b, i, 3)) });
  }
  // at least one hit for the chord, on an 8th of it
  if (!hits.length) {
    const len = span.end - span.t;
    const t = Math.floor((hashRoll(seed + 911, Math.floor(span.t / bar), 77, 4) * len) / (PPQ / 2)) * (PPQ / 2);
    hits.push({ t: Math.min(t, Math.max(0, len - sixteenth)), d: sixteenth, v: 80 });
  }
  // each up to the next hit (an 8th at most)
  hits.forEach((h, k) => (h.d = Math.min(PPQ / 2, (k + 1 < hits.length ? hits[k + 1].t : span.end - span.t) - h.t) * 0.9));
  return hits;
}

/** Charleston patterns in a bar (ticks from its 1, 4/4 positions; cut to shorter bars) */
const CHARLESTON: number[][] = [
  [0, 36], // the Charleston: 1, & of 2
  [0, 36], // (twice as likely)
  [12, 48], // reverse: & of 1, 3
  [0, 36, 84], // with a push on the & of 4
  [36, 84], // only the off-beats
  [0, 60] // 1 and & of 3
];

/** Bebop comping: a Charleston pattern per bar (the same each time round); a short hit, the 1 a little longer */
function charlestonHits(span: { t: number; end: number }, meter: Meter, seed: number): Hit[] {
  const bar = barTicks(meter);
  const hits: Hit[] = [];
  for (let b = Math.floor(span.t / bar); b * bar < span.end; b++) {
    const pattern = CHARLESTON[Math.floor(hashRoll(seed + 2203, b, 5, 6) * CHARLESTON.length)];
    pattern.forEach((p, i) => {
      const t = b * bar + p;
      if (p < bar && t >= span.t && t < span.end) hits.push({ t: t - span.t, d: p === 0 ? PPQ * 0.9 : PPQ * 0.45, v: i === 0 ? 88 : 80 });
    });
  }
  if (!hits.length) hits.push({ t: 0, d: PPQ * 0.45, v: 80 });
  hits.forEach((h, k) => (h.d = Math.min(h.d, (k + 1 < hits.length ? hits[k + 1].t : span.end - span.t) - h.t - 1)));
  return hits.filter((h) => h.d > 0);
}

/**
 * Swing: within each beat its second half moves later (by `swing` × half of an 8th, up to a dotted
 * feel; 0.67 is a triplet swing) and everything in it is stretched along, so 16ths keep their order
 */
export function swingWarp(t: number, swing: number): number {
  if (!swing) return t;
  const beat = Math.floor(t / PPQ) * PPQ;
  const at = t - beat;
  const half = PPQ / 2;
  const mid = half + swing * (half / 2);
  return beat + (at < half ? (at * mid) / half : mid + ((at - half) * (PPQ - mid)) / half);
}

/** A note swung: its start and its end moved by the warp */
function swungNote(n: LineNote, swing: number): LineNote {
  if (!swing) return n;
  const t = swingWarp(n.t, swing);
  const end = swingWarp(n.t + n.d, swing);
  return { ...n, t, d: Math.max(1, end - t) };
}

/** The hits of one chord span, by rhythm style */
export function hitsOf(style: number, span: { t: number; end: number }, meter: Meter, segs: Segment[], seed = 0): Hit[] {
  const len = span.end - span.t;
  const beats = segs.filter((s) => s.t >= span.t && s.t < span.end);
  const eighth = PPQ / 2;
  switch (style) {
    case 0: // a held chord
      return [{ t: 0, d: len, v: 76 }];
    case 1: // every beat, the bar's 1 louder
      return beats.map((s) => ({ t: s.t - span.t, d: (s.end - s.t) * 0.9, v: s.beat === 0 ? 90 : 72 }));
    case 2: // pushed: the chord comes an 8th early and holds, a short hit on the following beat's &
      return [
        { t: -eighth, d: len - eighth * 0.2, v: 92 },
        ...(len >= PPQ * 2 ? [{ t: len - PPQ - eighth, d: eighth * 0.8, v: 68 }] : [])
      ];
    case 3: // chops on the bar's backbeats (2 and 4; in x/8 the later groups)
      return beats.filter((s) => s.beat % 2 === 1).map((s) => ({ t: s.t - span.t, d: Math.min(eighth, s.end - s.t) * 0.7, v: 84 }));
    case 6: // scattered: irregular comping on 8ths and 16ths, a different pattern every bar (with the seed)
      return scatteredHits(span, meter, seed);
    case 7: // Charleston: 1 and the & of 2, with variations per bar (with the seed)
      return charlestonHits(span, meter, seed);
    case 5: // every 8th, driving: the bar's 1 loudest, then the beats, the &s lighter
      return eighthsOf(span, meter).map((t) => {
        const at = (((span.t + t) % barTicks(meter)) + barTicks(meter)) % barTicks(meter);
        const beat = beatOffsets(meter).some((o) => Math.abs(o - at) < 0.5);
        return { t, d: eighth * 0.8, v: at < 0.5 ? 96 : beat ? 86 : 72 };
      });
    default: // the & of every beat (in x/8: the middle of each group)
      return beats.map((s) => {
        const mid = s.t + Math.max(eighth, Math.floor((s.end - s.t) / 2 / eighth) * eighth);
        return { t: mid - span.t, d: Math.min(eighth * 0.7, s.end - mid), v: s.beat === 0 ? 80 : 74 };
      }).filter((x) => x.t < len && x.d > 0);
  }
}

/** Where chords stay clear down low: lowest note, close intervals over it (low interval limits) */
const FLOOR = 48; // C3: nothing under it
const CLOSE_FLOOR = 52; // E3: no second under it, no third under D3
function mud(v: number[]): number {
  let c = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] < FLOOR) c += 6 + (FLOOR - v[i]);
    if (i === 0) continue;
    const gap = v[i] - v[i - 1];
    if (gap <= 2 && v[i - 1] < CLOSE_FLOOR + 3) c += 6;
    else if (gap <= 4 && v[i - 1] < CLOSE_FLOOR - 2) c += 4;
  }
  return c;
}

/**
 * The chords' range: under a line that sits high, over one that sits low (as a right hand
 * over a bass line), in the middle for a wide one; `register` shifts it (semitones)
 */
export function registerFor(line: LineNote[], register = 0): { low: number; high: number; over: boolean; around: boolean } {
  const sorted = line.map((n) => n.n).sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 72);
  const lineLow = at(0.2);
  const lineHigh = at(0.8);
  // under the line, as a pianist's left hand under a melody: centred 8 semitones under its lower notes,
  // never under G3 (lower gets muddy) nor over G#4; a line lower than that has the chords around it,
  // only a bass line (under E3) has them over it. It moves smoothly with the line, no jumps
  const bassLine = lineHigh < BASS_LINE_UNDER;
  const centre = bassLine
    ? Math.min(64, Math.max(CENTRE_LOW + 4, lineHigh + 8))
    : Math.min(CENTRE_HIGH, Math.max(CENTRE_LOW, lineLow - 8));
  const low = centre - 7;
  const high = centre + 8;
  const over = bassLine;
  const around = !over && lineLow - 1 < high - 2;
  const shift = Math.round(register);
  return { low: Math.max(FLOOR - 12, low + shift), high: Math.min(108, high + shift), over, around };
}

/** Chords centre: not under G3, not over G#4 (a 15-semitone range around it) */
const CENTRE_LOW = 55;
const CENTRE_HIGH = 68;
/** A line all under this (E3) is a bass line: the chords go over it */
const BASS_LINE_UNDER = 52;

/** A hit's length: 0 a stab (a 16th at most), 0.5 the rhythm's own, 1 up to the next hit (legato) */
function hitLength(hit: Hit, next: number, length: number): number {
  const stab = Math.min(hit.d, PPQ / 4 * 0.8);
  const legato = Math.max(hit.d, next - hit.t - 1);
  return length < 0.5 ? lerp(stab, hit.d, length * 2) : lerp(hit.d, legato, (length - 0.5) * 2);
}

/**
 * How far off the beat a position is: -1 on a bar's 1, -0.5 on its middle beat (3 in 4/4),
 * 0.3 on the other beats (the backbeat), 0.7 on an 8th between, 1 on a 16th (syncopated)
 */
function offBeatness(t: number, meter: Meter): number {
  const bar = barTicks(meter);
  const at = ((t % bar) + bar) % bar;
  const offs = beatOffsets(meter);
  const beat = offs.findIndex((o) => Math.abs(o - at) < 0.5);
  if (beat === 0) return -1;
  if (beat > 0) return offs.length % 2 === 0 && beat === offs.length / 2 ? -0.5 : 0.3;
  return Math.abs(at % (PPQ / 2)) < 0.5 ? 0.7 : 1;
}

/**
 * How late a voice comes in when chords unfold: 0 the triad (root, third, fifth; sus and
 * fourths chords all), 1 the 7th, 6th or a diminished fifth, 2 the 9th
 */
function tensionRank(n: number, c: Chord): number {
  const i = (n - c.root + 120) % 12;
  if (c.quality === 'q' || c.quality === 'sus4' || c.quality === 'sus2') return i === 0 || QUALITY[c.quality].includes(i) ? 0 : 2;
  if (i === 0 || i === 3 || i === 4 || i === 7) return 0;
  if (i === 6 && c.quality !== 'dim') return 2;
  if (i === 2 || i === 1 || i === 5) return 2;
  return 1; // 6 (dim), 8, 9, 10, 11
}

/** The rhythm's index in RHYTHMS */
export function styleOf(o: HarmonyOptions): number {
  return Math.min(RHYTHMS.length - 1, Math.floor(Math.max(0, Math.min(1, o.rhythm)) * RHYTHMS.length));
}

export interface Range {
  low: number;
  high: number;
  over: boolean;
  /** the chords sit around the line (it's too low to go under): crossing it is fine */
  around: boolean;
  shift: number;
}

export function rangeFor(line: LineNote[], o: HarmonyOptions): Range {
  const reg = registerFor(line, o.register ?? 0);
  // a register moved towards the line may cross into it
  return { low: o.low ?? reg.low, high: o.high ?? reg.high, over: reg.over, around: reg.around, shift: Math.round(o.register ?? 0) };
}

/** A chord's voicing: near the last one, clear of the line's notes (`lineNotes`: sounding with it) */
export function voiceChord(chord: Chord, key: Key, o: HarmonyOptions, lineNotes: number[], prev: number[] | null, r: Range): number[] {
  const { low, high, over, around, shift } = r;
  const tones = voicedTones(chord, key, o.colour, lineNotes.map((n) => n % 12), o.harmony, !!o.shell);
  // power chords (Colour at its very bottom): root, fifth and the octave, no third
  let cands = isPower(o) ? powerVoicings(chord, low, high) : voicings(tones, low, high);
  if (!cands.length) cands = voicings(QUALITY[chord.quality].map((x) => (chord.root + x) % 12), low - 3, high + 7);
  if (!cands.length) cands = [QUALITY[chord.quality].map((x) => low + ((chord.root + x - low + 120) % 12))].map((v) => v.sort((a, b) => a - b));
  const cost = (v: number[]) =>
    (prev ? movement(prev, v) : 0) +
    // kept near the middle of its range, so the voicing doesn't wander off (and Register moves it)
    Math.abs(v.reduce((a, b) => a + b, 0) / v.length - (low + high) / 2) * (prev ? 0.6 : 2) +
    // no voice a half step from the line
    v.filter((x) => lineNotes.some((m) => m - x === 1 || x - m === 1)).length * 4 +
    (around
      ? 0
      : over
        ? Math.max(0, (lineNotes.length ? Math.max(...lineNotes) : 0) + Math.min(0, shift) - v[0]) * 0.8
        : Math.max(0, v[v.length - 1] - (lineNotes.length ? Math.min(...lineNotes) : 127) - Math.max(0, shift)) * 0.8) +
    mud(v);
  return cands.reduce((a, b) => (cost(b) < cost(a) ? b : a), cands[0]);
}

/** Each rhythm's loudest hit (hitsOf): its strong hits bark when the accents are in the middle */
const STYLE_LOUDEST = [76, 90, 92, 84, 80, 96, 92, 88];

/**
 * Dynamics of a hit (`o.dynamics`: 0 even … 1 barking). How strong a hit is comes from the
 * accent setting (on or off the beat), or, when that's in the middle, from the rhythm's own
 * pattern (its louder hits; with Pads a chord coming in on the bar's 1). Strong hits get louder
 * and shorter, up to e-piano barks (velocity 112–127, a short stab); the others get softer and
 * held longer; every bar of four a little swell (with the seed). Returns the velocity change
 * and the length (undefined: the usual)
 */
function dynamicsOf(hit: Hit, style: number, pos: number, next: number, o: HarmonyOptions, meter: Meter): { dv: number; d?: number; floor?: number } {
  const D = Math.max(0, Math.min(1, o.dynamics ?? 0));
  if (D < 0.02) return { dv: 0 };
  const a = o.accents ?? 0;
  const bar = barTicks(meter);
  const onOne = Math.abs(((pos % bar) + bar) % bar) < 0.5;
  const e = Math.max(
    -1,
    Math.min(
      1,
      Math.abs(a) >= 0.15
        ? a * offBeatness(pos, meter) * 1.4
        : style === 0
          ? onOne ? 0.6 : 0
          : // the rhythm's loudest hits are its strong ones
            0.6 - (STYLE_LOUDEST[style] - hit.v) / 12
    )
  );
  const usual = hitLength(hit, next, o.length ?? 0.5);
  // a swell over four bars: softer at the start, fuller towards the fourth
  const barNo = Math.floor(pos / bar);
  const swell = D * ((((barNo % 4) + 4) % 4) / 3 - 0.5) * 14 + D * (hashRoll(o.seed + 3301, barNo, 1, 2) - 0.5) * 8;
  if (e > 0.3) {
    // a bark: up to 112–127, a short stab (an 8th at most)
    const target = 112 + 15 * e;
    const dv = (target - hit.v) * D + swell * 0.5;
    // held chords (Pads, a push) bark and ring on; in the other rhythms a bark is a short stab
    if (style === 0 || usual > PPQ * 1.5) return { dv };
    const stab = Math.min(usual, PPQ * 0.4);
    return { dv, d: lerp(usual, stab, Math.min(1, D * 1.3)) };
  }
  // the cushion: softer (not under about 45, where an e-piano stops sounding) and held on towards the next hit
  const dv = -D * (20 + 12 * Math.max(0, -e)) + swell;
  const legato = Math.max(hit.d, next - hit.t - 1);
  return { dv, d: lerp(usual, Math.max(usual, legato), D * 0.7), floor: Math.min(hit.v, 45) };
}

/**
 * The notes a voiced chord plays over its span (song or loop ticks) in the rhythm, with
 * build-up and expression. `wrap`: a loop's length (a push before 0 goes at its end), 0 = none
 */
export function spanNotes(
  chord: Chord,
  v: number[],
  s: { t: number; end: number },
  segs: Segment[],
  style: number,
  o: HarmonyOptions,
  meter: Meter,
  wrap: number
): LineNote[] {
  const notes: LineNote[] = [];
  const unfold = Math.max(0, Math.min(1, o.unfold ?? 0));
  const ranks = v.map((n) => tensionRank(n, chord));
  const most = Math.max(...ranks);
  const spanLen = s.end - s.t;
  // where each tension tone comes in (from the chord's start, on the 8th grid): later with more build-up
  const enter = (r: number) => {
    if (!r || unfold < 0.15) return -Infinity;
    const at = Math.round((spanLen * unfold * r) / (most + 1) / (PPQ / 2)) * (PPQ / 2);
    return Math.min(Math.max(PPQ / 2, at), spanLen - PPQ / 2);
  };
  const hits = hitsOf(style, s, meter, segs, o.seed);
  hits.forEach((hit, h) => {
    // the next hit of this chord (or the next chord's, pushed an 8th early with Pushes)
    const next = h + 1 < hits.length ? hits[h + 1].t : spanLen - (style === 2 ? PPQ / 2 : 0);
    const pos = s.t + hit.t;
    const where = pos < 0 && wrap ? pos + wrap : pos;
    const accent = (o.accents ?? 0) * 22 * offBeatness(where, meter);
    // dynamics: strong hits bark (loud and short), the others are a soft held cushion
    const dyn = dynamicsOf(hit, style, where, next, o, meter);
    const d0 = dyn.d ?? hitLength(hit, next, o.length ?? 0.5);
    // a strum: down (low notes first) or up (high first, lighter); Down & up: down on the beats
    const strum = o.strum ?? 0;
    const up = strum === 2 || (strum === 3 && offBeatness(where, meter) > 0.3);
    let rolled = 0;
    v.forEach((n, k) => {
      const late = enter(ranks[k]);
      let from = Math.max(hit.t, late);
      let until = hit.t + d0;
      if (late > hit.t && until - late < PPQ / 4) {
        // a tension tone coming in after a short hit: its own short hit there, if it's before the next one
        if (late >= next - PPQ / 4 || late < hit.t + PPQ / 4) return;
        from = late;
        until = Math.min(next, late + Math.max(PPQ / 4, d0));
      }
      // a tension tone too late for this hit waits for a later one
      if (until - from < (from > hit.t ? PPQ / 4 : 0.5)) return;
      // rolled bottom up: a few ticks per voice that starts with the hit; strummed: a fraction of one
      const order = up ? v.length - 1 - k : k;
      const strumAt = strum && from === hit.t ? order * STRUM_STEP : 0;
      const roll = (from === hit.t ? rolled++ * 1.5 * Math.min(1, unfold * 2) : 0) + strumAt;
      const start = s.t + from + roll;
      // a rolled voice keeps its length (up to the next hit)
      let d = Math.min(s.t + until + roll, s.t + Math.max(until, next)) - start;
      let t = start;
      if (wrap) {
        // a push into bar 1 goes at the loop's end and rings on into the next round's 1
        if (t < 0) t += wrap;
        else d = Math.min(d, wrap - t);
      }
      d = Math.max(1, d);
      let vel = hit.v + dyn.dv + (from > hit.t ? -6 : accent);
      if (dyn.floor) vel = Math.max(dyn.floor, vel);
      if (ranks[k]) vel += (o.tensions ?? 0) * 22;
      // later strings a little softer, an upstroke lighter
      if (strum && from === hit.t) vel -= order * 3 + (up ? 8 : 0);
      if (o.vary) vel += (hashRoll(o.seed + 7919, Math.round(t * 8), n, 3) - 0.5) * 2 * 14 * o.vary;
      notes.push(swungNote({ t, d, n, v: Math.round(Math.max(1, Math.min(127, vel))) }, o.swing ?? 0));
    });
  });
  return notes;
}

/** A strum's spread per note, in ticks (about 8 ms at 120 BPM) */
const STRUM_STEP = 0.4;

const BASS_LOW = 28; // E1
const BASS_HIGH = 52; // E3

/** Pitch class `pc` nearest to `to`, kept within lo…hi */
function nearestPitch(pc: number, to: number, lo = BASS_LOW, hi = BASS_HIGH): number {
  let n = to + ((((pc - to) % 12) + 18) % 12) - 6;
  while (n < lo) n += 12;
  while (n > hi) n -= 12;
  return n;
}

/** The beats (beat groups) of a span, song or loop ticks */
function spanBeats(s: { t: number; end: number }, meter: Meter): { t: number; strong: boolean; first: boolean }[] {
  const bar = barTicks(meter);
  const offs = beatOffsets(meter);
  const mid = offs.length % 2 === 0 ? offs.length / 2 : -1;
  const out: { t: number; strong: boolean; first: boolean }[] = [];
  for (let b = Math.floor(s.t / bar); b * bar < s.end; b++) {
    offs.forEach((o, i) => {
      const t = b * bar + o;
      if (t >= s.t - 0.5 && t < s.end - 0.5) out.push({ t, strong: i === 0 || i === mid, first: i === 0 });
    });
  }
  if (!out.length || out[0].t > s.t + 0.5) out.unshift({ t: s.t, strong: true, first: false });
  return out;
}

/**
 * The bass of a chord span. With `bassMove` 0 its root held (octave 2, on the chord's 1, pushed
 * with it); with more: root and fifth on the strong beats, then an approach note into the next
 * chord's root (`next`, pitch class; null: unknown, back to its own), then walking on every beat,
 * then 8th skips. `prev`: the last bass note (voice leading). Returns the notes and the last pitch
 */
export function bassLine(
  chord: Chord,
  s: { t: number; end: number },
  key: Key,
  next: number | null,
  prev: number | null,
  o: HarmonyOptions,
  style: number,
  meter: Meter,
  wrap: number
): { notes: LineNote[]; last: number } {
  const m = Math.max(0, Math.min(1, o.bassMove ?? 0));
  const push = style === 2 ? -PPQ / 2 : 0;
  const place = (t0: number, d0: number, n: number, v: number): LineNote => {
    // swung on the song's grid, before a loop's wrap
    const sw = swungNote({ t: t0, d: d0, n, v }, o.swing ?? 0);
    let t = sw.t;
    let d = sw.d;
    // an anticipation of bar 1 goes at the loop's end and rings on into the next round
    if (wrap && t < 0) t += wrap;
    else if (wrap) d = Math.min(d, wrap - t);
    return { t, d: Math.max(1, d), n, v: Math.round(Math.max(1, Math.min(127, v))) };
  };
  const roll = (a: number, b: number) => hashRoll(o.seed + 4243, Math.round(s.t), a, b);
  if (m < 0.2) {
    const n = 36 + ((chord.root - 36 + 120) % 12);
    const held: RawBass[] = [{ t: s.t + push, until: s.end + push, n, v: 96, first: true }];
    const raw = syncopate(style === 5 ? pump(held) : held, o, push !== 0, roll);
    return { notes: raw.map((r) => place(r.t, r.d ?? (r.until - r.t) * (raw.length > 1 ? lerp(0.55, 0.97, o.length ?? 0.5) : 0.95), r.n, r.v)), last: n };
  }
  const tones = QUALITY[chord.quality];
  const fifthI = tones.includes(7) ? 7 : tones.includes(6) ? 6 : tones.includes(8) ? 8 : 7;
  const chordPcs = tones.map((i) => (chord.root + i) % 12);
  const scale = scaleOf(key);
  const beats = spanBeats(s, meter);
  // the root low, near the last bass note
  const root = prev === null ? 36 + ((chord.root - 36 + 120) % 12) : nearestPitch(chord.root, prev, 31, 47);
  const fifth = nearestPitch(chord.root + fifthI, root - (root >= 40 ? 3 : -3));
  // which beats sound and what they play
  const slot: (number | null)[] = beats.map(() => null);
  const kind: string[] = beats.map(() => '');
  slot[0] = root;
  kind[0] = 'root';
  const strong = beats.map((b, i) => i > 0 && b.strong);
  if (!strong.some(Boolean) && beats.length >= 2) strong[Math.floor(beats.length / 2)] = true;
  let alt = 0;
  strong.forEach((x, i) => {
    if (!x) return;
    alt++;
    // root and fifth by turns; with more movement the root comes back an octave up now and then
    const octave = alt % 2 === 0 && m >= 0.35 && roll(i, 1) < m && root + 12 <= BASS_HIGH;
    slot[i] = alt % 2 === 1 ? fifth : octave ? root + 12 : root;
    kind[i] = alt % 2 === 1 ? 'fifth' : 'root';
  });
  const last = beats.length - 1;
  if (m >= 0.45 && last >= 1) {
    // into the next chord: a half step, a scale step or its fifth
    const target = nearestPitch(next ?? chord.root, slot[last - 1] ?? root);
    const r = roll(last, 2);
    const chromatic = m >= 0.7 ? 0.55 : 0.25;
    let a: number;
    if (r < chromatic) a = target + (roll(last, 3) < 0.6 ? -1 : 1);
    else if (r < chromatic + 0.3) {
      const below = scale.map((pc) => nearestPitch(pc, target - 2)).filter((n) => n < target && n >= target - 2);
      const above = scale.map((pc) => nearestPitch(pc, target + 2)).filter((n) => n > target && n <= target + 2);
      a = (roll(last, 4) < 0.5 ? below[0] : above[0]) ?? below[0] ?? above[0] ?? target - 1;
    } else a = nearestPitch((next ?? chord.root) + 7, target);
    if (a === slot[last - 1]) a = target - 1; // not the note before again
    if (a < BASS_LOW) a += 12;
    if (a > BASS_HIGH) a -= 12;
    slot[last] = a;
    kind[last] = 'approach';
  }
  if (m >= 0.7) {
    // walking: every beat, scale and chord tones from the root towards the approach note
    const end = slot[last] ?? root;
    for (let i = 1; i < beats.length; i++) {
      if (slot[i] !== null && (kind[i] === 'approach' || kind[i] === 'root')) continue;
      const before = slot[i - 1]!;
      const f = i / Math.max(1, last);
      let ideal = root + (end - root) * f;
      // little way to go: an arch up (or down from high) through the chord
      if (Math.abs(end - root) <= 2) ideal += (root < 42 ? 1 : -1) * 5 * Math.sin(Math.PI * f);
      let best = before;
      let bestCost = Infinity;
      for (let n = BASS_LOW; n <= BASS_HIGH; n++) {
        const pc = n % 12;
        const inChord = chordPcs.includes(pc);
        if (!inChord && !scale.includes(pc)) continue;
        const cost =
          Math.abs(n - ideal) +
          (n === before || n === slot[i + 1] ? 3 : 0) +
          (Math.abs(n - before) > 7 ? 2 : 0) -
          (inChord ? (strong[i] ? 2 : 0.6) : 0) +
          roll(i, n) * 1.5;
        if (cost < bestCost) {
          bestCost = cost;
          best = n;
        }
      }
      slot[i] = best;
      kind[i] = 'walk';
    }
  }
  // the notes: each up to the next (with Length), velocity by weight
  const lenK = lerp(0.55, 0.97, o.length ?? 0.5);
  const raw: RawBass[] = [];
  const playing = beats.map((b, i) => ({ b, i })).filter(({ i }) => slot[i] !== null);
  playing.forEach(({ b, i }, j) => {
    const t = b.t + (i === 0 ? push : 0);
    const until = j + 1 < playing.length ? playing[j + 1].b.t : s.end + push;
    let v = kind[i] === 'root' && b.first ? 100 : b.strong ? 92 : kind[i] === 'approach' ? 88 : 84;
    v += (o.accents ?? 0) * 10 * offBeatness(b.t, meter);
    // skips: an 8th before the next note, its pitch again or the octave
    const skip = m >= 0.85 && until - t >= PPQ && roll(i, 6) < (m - 0.85) * 4 * 0.6;
    raw.push({ t, until: skip ? until - PPQ / 2 : until, n: slot[i]!, v, first: i === 0 });
    if (skip) {
      const nextPitch = j + 1 < playing.length ? slot[playing[j + 1].i]! : nearestPitch(next ?? chord.root, slot[i]!);
      const g = roll(i, 7) < 0.5 ? nextPitch : slot[i]! + (slot[i]! + 12 <= BASS_HIGH ? 12 : -12);
      raw.push({ t: until - PPQ / 2, until, n: g, v: v - 26, first: false, d: (PPQ / 2) * 0.6 });
    }
  });
  // Eighths: the bass pumps 8ths of each note (the first of each a little louder)
  const pumped = style === 5 ? pump(raw) : raw;
  const notes = syncopate(pumped, o, push !== 0, roll).map((r) => {
    let v = r.v;
    if (o.vary) v += (hashRoll(o.seed + 7919, Math.round(r.t * 8), r.n, 5) - 0.5) * 2 * 12 * o.vary;
    return place(r.t, r.d ?? (r.until - r.t) * lenK, r.n, v);
  });
  return { notes, last: slot[playing[playing.length - 1].i]! };
}

/** Each note as 8ths of its pitch up to the next note (skips stay as they are) */
function pump(raw: RawBass[]): RawBass[] {
  const out: RawBass[] = [];
  for (const r of raw) {
    if (r.d !== undefined) {
      out.push(r);
      continue;
    }
    for (let t = r.t; t < r.until - PPQ / 4; t += PPQ / 2) {
      out.push({ t, until: Math.min(r.until, t + PPQ / 2), n: r.n, v: t === r.t ? r.v : r.v - 10, first: r.first && t === r.t });
    }
  }
  return out;
}

interface RawBass {
  t: number;
  /** where the next note comes in */
  until: number;
  n: number;
  v: number;
  /** the chord's first note */
  first: boolean;
  /** a fixed length (skips) */
  d?: number;
}

/**
 * Syncopation of a chord's bass notes (`o.syncopation`, with the seed): the first note
 * anticipated an 8th, tied over the 1 (unless pushed already); others moved onto the "and";
 * from the middle up re-strikes on the "and" of a held note, near the top 16th pickups just
 * before the next beat (the octave, the fifth or the note again)
 */
function syncopate(raw: RawBass[], o: HarmonyOptions, pushed: boolean, roll: (a: number, b: number) => number): RawBass[] {
  const y = Math.max(0, Math.min(1, o.syncopation ?? 0));
  if (y < 0.05) return raw;
  const end = raw.length ? raw[raw.length - 1].until : 0;
  // moves: the first note anticipated, others onto the "and"
  let moved = raw.map((r, j) => {
    let t = r.t;
    if (r.first && !pushed && roll(j, 11) < y * 0.7) t -= PPQ / 2;
    else if (!r.first && r.d === undefined && roll(j, 12) < y * 0.45) t += PPQ / 2;
    return { ...r, t, v: r.v + (t !== r.t ? 8 : 0) };
  });
  // one note per place (a moved note wins over a skip there), each up to the next
  moved.sort((a, b) => a.t - b.t || Number(a.d !== undefined) - Number(b.d !== undefined));
  moved = moved.filter((r, i) => i === 0 || r.t - moved[i - 1].t >= PPQ / 8);
  moved.forEach((r, i) => (r.until = i + 1 < moved.length ? moved[i + 1].t : end));
  moved = moved.filter((r) => r.until - r.t >= PPQ / 8);
  // re-strikes in a held note's time: the "and" after it, near the top the 16th before the next beat
  const out: RawBass[] = [];
  moved.forEach((n, j) => {
    out.push(n);
    if (n.d !== undefined || y < 0.35 || n.until - n.t < PPQ || roll(j, 13) >= (y - 0.35) * 1.4) return;
    const sixteenth = y > 0.65 && roll(j, 14) < (y - 0.65) * 2.2;
    const at = sixteenth ? Math.ceil((n.t + PPQ / 2) / PPQ) * PPQ - PPQ / 4 : Math.floor(n.t / (PPQ / 2) + 1) * (PPQ / 2);
    if (at <= n.t + PPQ / 4 || at >= n.until - PPQ / 8) return;
    const pick = roll(j, 15);
    const pitch =
      pick < 0.4 && n.n + 12 <= BASS_HIGH ? n.n + 12 : pick < 0.65 && n.n + 7 <= BASS_HIGH ? n.n + 7 : pick < 0.8 && n.n - 5 >= BASS_LOW ? n.n - 5 : n.n;
    out.push({ t: at, until: n.until, n: pitch, v: n.v - (sixteenth ? 14 : 8), first: false, d: sixteenth ? (PPQ / 4) * 0.8 : undefined });
    n.until = at;
  });
  return out;
}

/** Bass notes in time order, each cut where the next one starts (a pushed chord cuts the one before) */
export function tidyBass(notes: LineNote[], length = 0): LineNote[] {
  // stable: at the same place the later chord's note (an anticipation) comes last and wins
  notes.sort((a, b) => a.t - b.t);
  for (let i = notes.length - 2; i >= 0; i--) if (notes[i + 1].t - notes[i].t < PPQ / 8) notes.splice(i, 1);
  for (let i = 0; i + 1 < notes.length; i++) notes[i].d = Math.max(1, Math.min(notes[i].d, notes[i + 1].t - notes[i].t - 1));
  // a loop's last note rings into the next round up to its first note
  const last = notes[notes.length - 1];
  if (length && last) last.d = Math.max(1, Math.min(last.d, length - last.t + notes[0].t - 1));
  return notes;
}

export function harmonize(line: LineNote[], length: number, meter: Meter, o: HarmonyOptions): Accompaniment {
  const p = progress(line, length, meter, o);
  const style = styleOf(o);
  const r = rangeFor(line, o);
  const sp = spans(p);
  const sounding = (s: { t: number; end: number }) => line.filter((n) => n.t < s.end && n.t + n.d > s.t).map((n) => n.n);
  // twice round: the first chord's voicing follows on from the last
  const voiced: number[][] = [];
  let prev: number[] | null = null;
  for (let round = 0; round < 2; round++) {
    sp.forEach((s, i) => {
      voiced[i] = prev = voiceChord(s.chord, p.key, o, sounding(s), prev, r);
    });
  }
  const notes: LineNote[] = [];
  const bass: LineNote[] = [];
  // the bass twice round as well: the first chord's root follows on from the last note
  let low: number | null = null;
  for (let round = 0; round < 2; round++) {
    sp.forEach((s, i) => {
      const b = bassLine(s.chord, s, p.key, sp[(i + 1) % sp.length].chord.root, low, o, style, meter, length);
      low = b.last;
      if (round === 1) bass.push(...b.notes);
    });
  }
  sp.forEach((s, i) => notes.push(...spanNotes(s.chord, voiced[i], s, p.segments, style, o, meter, length)));
  notes.sort((a, b) => a.t - b.t || a.n - b.n);
  return { progression: p, notes, bass: tidyBass(bass, length), rhythm: RHYTHMS[style] };
}
