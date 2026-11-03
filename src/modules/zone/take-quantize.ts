import { DIV_TICKS } from './seq-layer';
import { Note } from './note';
import { SeqStep } from './seq-step';
import { DrumLane } from './drum-lane';
import type { Sequence } from './sequence';

/**
 * Turning a take (or a stretch of it) into steps. Note starts snap to the nearest
 * step of a grid, optionally swung (odd steps late by swing × half a step, as the
 * zone's Swing plays them); a step's notes share one length and gate, taken from
 * its longest note.
 */

export const DIV_NAMES = [
  '2/1', '1/1•', '1/1', '1/2•', '1/1t', '1/2', '1/4•', '1/2t', '1/4',
  '1/8•', '1/4t', '1/8', '1/16•', '1/8t', '1/16', '1/16t', '1/32', '1/32t'
];

/** Grids the analysis tries, coarse to fine (DIV_TICKS indices): 1/4 … 1/32 with triplets */
const CANDIDATES = [8, 10, 11, 13, 14, 15, 16];
const SWINGS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
// a grid fits when notes are off it by less than this share of a step on average,
// and only a few notes (sloppy ones) lie far off it: a line with some notes in
// between needs the finer grid, or they'd become chords with their neighbours
const FIT = 0.15;
const FAR = 0.3;
const FAR_SHARE = 0.05;
// swing is suggested when it cuts the error by this much
const SWING_GAIN = 0.35;
export const MAX_STEPS = 256;
export const MAX_STEPS_DRUMS = 64;
export const MAX_LANES_DRUMS = 12;

export interface PlayedNote {
  s: number; // song position (ticks)
  d: number;
  n: number;
  v: number;
}

export interface Analysis {
  grid: number; // DIV_TICKS index
  swing: number; // 0–1, 0 = straight
  error: number; // mean distance to the grid, in steps (0–0.5)
  loose: boolean; // no grid fitted closely
}

export interface Quantized {
  grid: number;
  swing: number;
  drums: boolean;
  steps: number; // sequence length
  max: number;
  fits: boolean;
  lanes: number[]; // drum lane notes
  chords: number;
  merged: number; // same pitch on one step: the louder kept
  /** per step: its notes, length (steps) and gate */
  cells: ({ notes: { n: number; v: number }[]; length: number; gate: number } | null)[];
  /** where each note was played and the step start it lands on (song positions), for the preview */
  moves: { from: number; to: number; n: number }[];
}

/** Position of step i on a grid of `ticks`, swung */
export function stepPos(i: number, ticks: number, swing: number): number {
  return i * ticks + (i % 2 === 1 ? swing * ticks * 0.5 : 0);
}

/** The nearest (swung) step to a position relative to the range start */
function nearestStep(t: number, ticks: number, swing: number): number {
  const i = Math.round(t / ticks);
  let best = i;
  let bestErr = Infinity;
  for (const k of [i - 1, i, i + 1]) {
    if (k < 0) continue;
    const err = Math.abs(t - stepPos(k, ticks, swing));
    if (err < bestErr) {
      bestErr = err;
      best = k;
    }
  }
  return best;
}

/** Mean distance of the notes to the grid (in steps), and the share of notes far off it */
function gridError(notes: PlayedNote[], from: number, ticks: number, swing: number): { error: number; far: number } {
  if (notes.length === 0) return { error: 0, far: 0 };
  let sum = 0;
  let far = 0;
  for (const note of notes) {
    const t = note.s - from;
    const err = Math.abs(t - stepPos(nearestStep(t, ticks, swing), ticks, swing)) / ticks;
    sum += err;
    if (err > FAR) far++;
  }
  return { error: sum / notes.length, far: far / notes.length };
}

/** The coarsest grid the notes fit closely (straight or swung), and a swing if it helps clearly */
export function analyse(notes: PlayedNote[], from: number): Analysis {
  let fallback: Analysis | null = null;
  for (const grid of CANDIDATES) {
    const ticks = DIV_TICKS[grid];
    const triplet = DIV_NAMES[grid].endsWith('t');
    const straight = { swing: 0, ...gridError(notes, from, ticks, 0) };
    let best = straight;
    if (!triplet) {
      for (const swing of SWINGS) {
        const e = gridError(notes, from, ticks, swing);
        if (e.error < best.error) best = { swing, ...e };
      }
      if (best.swing > 0 && best.error > straight.error * (1 - SWING_GAIN)) best = straight;
    }
    if (best.error <= FIT && best.far <= FAR_SHARE) return { grid, swing: best.swing, error: best.error, loose: false };
    if (!fallback || best.error < fallback.error) fallback = { grid, swing: best.swing, error: best.error, loose: true };
  }
  return fallback ?? { grid: 14, swing: 0, error: 0, loose: false };
}

/** For a grid picked by hand: the swing that fits it (0 if it doesn't help clearly) */
export function swingFor(notes: PlayedNote[], from: number, grid: number): number {
  if (DIV_NAMES[grid].endsWith('t')) return 0;
  const ticks = DIV_TICKS[grid];
  const straight = gridError(notes, from, ticks, 0).error;
  let best = { swing: 0, error: straight };
  for (const swing of SWINGS) {
    const error = gridError(notes, from, ticks, swing).error;
    if (error < best.error) best = { swing, error };
  }
  return best.swing > 0 && best.error <= straight * (1 - SWING_GAIN) ? best.swing : 0;
}

/** Quantize the notes in [from, to) onto steps of `grid` */
export function quantize(notes: PlayedNote[], from: number, to: number, grid: number, swing: number, drums: boolean): Quantized {
  const ticks = DIV_TICKS[grid];
  const max = drums ? MAX_STEPS_DRUMS : MAX_STEPS;
  const steps = Math.max(1, Math.ceil((to - from) / ticks - 0.001));
  const lanes = drums ? [...new Set(notes.map((n) => n.n))].sort((a, b) => a - b) : [];
  const fits = steps <= max && lanes.length <= MAX_LANES_DRUMS;
  const cells: Quantized['cells'] = new Array(Math.min(steps, max)).fill(null);
  const moves: Quantized['moves'] = [];
  let merged = 0;
  const sorted = [...notes].sort((a, b) => a.s - b.s);
  sorted.forEach((note, k) => {
    const t = note.s - from;
    let i = nearestStep(t, ticks, swing);
    if (i >= steps) i = steps - 1; // a note right at the end stays in
    moves.push({ from: note.s, to: from + stepPos(i, ticks, swing), n: note.n });
    if (i >= cells.length) return;
    // length in steps, from the swung start of its step; released just before the
    // next note (within a fifth of a step) counts as legato
    const next = sorted.slice(k + 1).find((o) => o.s > note.s + ticks * 0.5);
    let end = note.s + note.d - from;
    if (next && next.s - from - end < ticks * 0.2 && next.s - from > end) end = next.s - from;
    const span = Math.max(0.05, (end - stepPos(i, ticks, swing)) / ticks);
    const length = Math.max(1, Math.min(max, Math.ceil(span - 0.05)));
    let gate = Math.round((span - (length - 1)) * 20) / 20;
    gate = gate >= 0.9 ? 1 : Math.max(0.1, Math.min(1, gate));
    const cell = (cells[i] ??= { notes: [], length, gate });
    const same = cell.notes.find((o) => o.n === note.n);
    if (same) {
      merged++;
      same.v = Math.max(same.v, note.v);
    } else {
      cell.notes.push({ n: note.n, v: note.v });
    }
    // a chord sounds as long as its longest note
    if (length > cell.length || (length === cell.length && gate > cell.gate)) {
      cell.length = length;
      cell.gate = gate;
    }
  });
  const chords = cells.filter((c) => c && c.notes.length > 1).length;
  return { grid, swing, drums, steps, max, fits, lanes, chords, merged, cells, moves };
}

/** Write the result into a sequence: its steps (or drum lanes), length and step size */
export function applyToSequence(seq: Sequence, q: Quantized): void {
  const length = Math.min(q.steps, q.max);
  seq.clearSelection();
  seq.division = q.grid;
  seq.length = length;
  if (q.drums) {
    seq.isDrumSequence = true;
    seq.drumLanes = Math.max(1, q.lanes.length);
    seq.drum_lanes = q.lanes.map((pitch) => {
      const lane = new DrumLane();
      lane.note = pitch;
      lane.length = length;
      q.cells.forEach((cell, i) => {
        const hit = cell?.notes.find((o) => o.n === pitch);
        if (!hit) return;
        const step = new SeqStep();
        step.notesArray.push(new Note(pitch, hit.v));
        lane.steps[i] = step;
      });
      return lane;
    });
  } else {
    seq.isDrumSequence = false;
    seq.steps = q.cells.map((cell) => {
      if (!cell) return null;
      const step = new SeqStep();
      step.length = cell.length;
      step.gateLength = cell.gate;
      cell.notes.sort((a, b) => a.n - b.n).forEach((o) => step.notesArray.push(new Note(o.n, o.v)));
      return step;
    });
  }
  seq.active = true;
}
