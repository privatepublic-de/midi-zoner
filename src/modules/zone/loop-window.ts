import { Take, takeNote, songNote } from './take';
import type { SongNote } from './take';
import type { TakeNoteJSON, LoopLinkJSON, LoopFixJSON } from './interfaces';
import { loopFromNotes } from './looper';
import { DIV_TICKS } from './seq-layer';
import { barTicks } from '../meter';
import { GesturesJSON, cutGestures, shiftGestures } from './gestures';

/**
 * A loop cut from a take is a window on it: its bars can be moved over the take again (an
 * edge dragged, the whole window slid), and the loop is cut anew from the take each time.
 *
 * - The take's notes come in as recorded, quantized by the loop's quantize (`link.q`, so it
 *   applies to bars brought in later too and can be redone with another strength).
 * - Take notes changed in the loop (`link.fix`: pitch, place, length, velocity) stay changed
 *   and stay with the take's notes; take notes deleted in the loop (`link.hide`) stay out.
 *   Both by key: the take note's tick and pitch as recorded.
 * - The loop's own notes (`o`: overdubbed or added there) are kept: an edge drag keeps them
 *   with the take's notes they were played over, a slide keeps their place in the loop;
 *   outside its bars they wait in its spare notes.
 *
 * Pure (takes and notes only), so it can be checked without the app.
 */

export type NoteKey = [number, number];

/** Where a loop note came from: its take note's key and where that lands in the take (song position, quantized) */
export interface NoteSource {
  key: NoteKey;
  s: number;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
export const keyText = (k: NoteKey): string => `${round3(k[0])}|${k[1]}`;
// notes cut the same way again match closely; saved ones are rounded to 1/1000 tick
const NEAR = 0.01;

/** The bar of a take at a song position (its own meter there) */
export function takeBar(take: Take, s: number): number {
  return barTicks(take.sectionAt(s - take.start + take.offset).meter);
}

/** A position moved `strength` of the way to the nearest step of the grid, counted from `from` */
function quantized(s: number, from: number, q: LoopLinkJSON['q']): number {
  if (!q) return s;
  const ticks = DIV_TICKS[q.g];
  if (!ticks) return s;
  const t = s - from;
  return from + t + q.s * (Math.round(t / ticks) * ticks - t);
}

/** The take's notes as the loop hears them: hidden ones out, quantized, changed ones changed */
function playedOf(take: Take, link: LoopLinkJSON, from: number): { played: SongNote[]; src: Map<SongNote, NoteSource> } {
  const hide = new Set((link.hide ?? []).map(keyText));
  const fix = new Map<string, LoopFixJSON>((link.fix ?? []).map((f) => [keyText(f.k), f]));
  const played: SongNote[] = [];
  const src = new Map<SongNote, NoteSource>();
  const last = take.offset + take.length;
  for (let i = take.firstAtOrAfter(take.offset); i < take.notes.length && take.notes[i].t < last; i++) {
    const n = take.notes[i];
    const key: NoteKey = [round3(n.t), n.n];
    const text = keyText(key);
    if (hide.has(text)) continue;
    const s = quantized(take.start + n.t - take.offset, from, link.q);
    const f = fix.get(text);
    const p = f
      ? songNote({ d: f.d, n: f.n, v: f.v, ...(f.x ? { x: f.x } : {}) }, s + f.dt)
      : songNote(n, s, Math.min(n.d, last - n.t));
    played.push(p);
    src.set(p, { key, s });
  }
  played.sort((a, b) => a.s - b.s);
  return { played, src };
}

/**
 * The loop of the take's bars `from`…`to` (song positions), cut as the link says, with its
 * own notes (ticks from its start) added; `gestures` (ticks from its start) in place of the
 * take's. `sources`: where each of its notes came from (own notes have none).
 */
export function cutWindow(
  take: Take,
  from: number,
  to: number,
  link: LoopLinkJSON,
  own: TakeNoteJSON[] = [],
  gestures?: GesturesJSON
): { loop: Take; sources: Map<TakeNoteJSON, NoteSource> } | null {
  const { played, src } = playedOf(take, link, from);
  const bySong = new Map<TakeNoteJSON, SongNote>();
  const loop = loopFromNotes(played, from, to, takeBar(take, from), true, shiftGestures(take.g, take.start - take.offset), bySong);
  if (!loop) return null;
  if (gestures !== undefined) loop.g = gestures;
  const sources = new Map<TakeNoteJSON, NoteSource>();
  bySong.forEach((p, note) => {
    const s = src.get(p);
    if (s) sources.set(note, s);
  });
  const len = loop.length;
  for (const n of own) {
    const note = takeNote({ ...n, o: 1 }, n.t);
    if (n.t >= 0 && n.t < len) {
      if (loop.notes.length < Take.MAX_NOTES) loop.notes.push(note);
    } else if (loop.spare.length < Take.MAX_SPARE) loop.spare.push(note);
  }
  loop.sort();
  loop.spare.sort((a, b) => a.t - b.t);
  if (link.plain) loop.clearExpression();
  loop.link = cloneLink(link);
  return { loop, sources };
}

export function cloneLink(link: LoopLinkJSON | null): LoopLinkJSON {
  return link ? (JSON.parse(JSON.stringify(link)) as LoopLinkJSON) : {};
}

/** Where a loop's first bar lies in its take (song position), from where it was cut in the run */
export function windowFrom(loop: Take, take: Take): number {
  return loop.origin ? loop.origin.run - take.runOffset : NaN;
}

/**
 * Pair a loop's notes (not its own) with the notes of the same bars cut anew: same pitch and
 * velocity, place and length within NEAR
 */
function pairUp(loop: Take, fresh: Take): { pairs: Map<TakeNoteJSON, TakeNoteJSON>; loose: TakeNoteJSON[]; missing: TakeNoteJSON[] } {
  const byPitch = new Map<number, TakeNoteJSON[]>();
  for (const n of loop.notes) {
    if (n.o) continue;
    const list = byPitch.get(n.n);
    if (list) list.push(n);
    else byPitch.set(n.n, [n]);
  }
  const pairs = new Map<TakeNoteJSON, TakeNoteJSON>();
  const missing: TakeNoteJSON[] = [];
  for (const f of fresh.notes) {
    const list = byPitch.get(f.n);
    const i = list ? list.findIndex((n) => Math.abs(n.t - f.t) <= NEAR && Math.abs(n.d - f.d) <= NEAR && n.v === f.v) : -1;
    if (list && i >= 0) {
      pairs.set(list[i], f);
      list.splice(i, 1);
    } else missing.push(f);
  }
  const loose: TakeNoteJSON[] = [];
  byPitch.forEach((list) => loose.push(...list));
  return { pairs, loose, missing };
}

/**
 * Whether a loop still follows its take (its bars cut anew give its notes), and where each
 * of its notes came from. A loop without a link yet (from before windows, or recorded with
 * Rec) is taken on when most of it matches: notes the take doesn't give become its own, take
 * notes it lacks are hidden, so it plays just as before. Null: it doesn't follow (cut from
 * another take, its take changed under it, or changed beyond recognition): no window.
 */
export function follows(loop: Take, take: Take): { from: number; to: number; sources: Map<TakeNoteJSON, NoteSource> } | null {
  if (!loop.origin || loop.origin.at !== take.at || !take.at) return null;
  const from = windowFrom(loop, take);
  const to = from + loop.length;
  if (!isFinite(from)) return null;
  const cut = cutWindow(take, from, to, loop.link ?? {});
  if (!cut) return null;
  const { pairs, loose, missing } = pairUp(loop, cut.loop);
  const theirs = loop.notes.filter((n) => !n.o).length;
  // a loop already linked gives its notes exactly (else its take changed under it: no window);
  // one without a link yet (from before, or recorded) is taken on when most of it matches
  if (loop.link && (loose.length || missing.length)) return null;
  if (cut.loop.notes.length === 0 || pairs.size < 0.8 * cut.loop.notes.length || pairs.size < 0.5 * theirs) return null;
  // taken on: what's left over is the loop's own, what's missing stays out
  if (loose.length || missing.length || !loop.link) {
    loop.link = loop.link ?? {};
    for (const n of loose) n.o = 1;
    const hide = loop.link.hide ?? [];
    for (const f of missing) {
      const s = cut.sources.get(f);
      if (s) hide.push(s.key);
    }
    if (hide.length) loop.link.hide = hide;
  }
  const sources = new Map<TakeNoteJSON, NoteSource>();
  pairs.forEach((f, n) => {
    const s = cut.sources.get(f);
    if (s) sources.set(n, s);
  });
  return { from, to, sources };
}

/**
 * The loop with its bars moved over its take: `from`…`to` (song positions in the take).
 * 'edge': its own notes stay with the take's notes they were played over; 'slide': they
 * keep their place in the loop. Gestures come from the take, unless the loop's were
 * overdubbed (then the loop keeps its own, moved like its own notes).
 */
export function recutWindow(loop: Take, take: Take, from: number, to: number, how: 'edge' | 'slide'): Take | null {
  const was = windowFrom(loop, take);
  if (!isFinite(was) || to - from < 1) return null;
  const shift = how === 'slide' ? 0 : was - from;
  const own = [...loop.notes, ...loop.spare].filter((n) => n.o).map((n) => takeNote(n, n.t + shift));
  const link = loop.link ?? {};
  const before = cutWindow(take, was, was + loop.length, link);
  const dubbed = JSON.stringify(loop.g ?? null) !== JSON.stringify(before?.loop.g ?? null);
  const gestures = dubbed ? (shift ? cutGestures(loop.g, -Take.MAX_LENGTH, Take.MAX_LENGTH, -shift) : loop.g) : undefined;
  const cut = cutWindow(take, from, to, link, own, gestures);
  if (!cut) return null;
  const next = cut.loop;
  next.id = loop.id;
  next.sections = loop.sections.map((s) => ({ t: s.t, meter: s.meter }));
  next.origin = { at: take.at, run: from + take.runOffset };
  return next;
}

/** The loop quantized: the take's notes by the grid from now on (`grid` an index of DIV_TICKS), its own notes now */
export function quantizeWindow(loop: Take, take: Take, grid: number, strength: number): Take | null {
  const from = windowFrom(loop, take);
  if (!isFinite(from)) return null;
  const q = { g: grid, s: strength };
  const copy = loop.copy();
  copy.origin = loop.origin;
  copy.link = { ...cloneLink(loop.link), q };
  for (const n of [...copy.notes, ...copy.spare]) if (n.o) n.t = quantized(n.t, 0, q);
  return recutWindow(copy, take, from, from + loop.length, 'edge');
}

/** A note's values, to tell afterwards what an edit changed */
type Values = { t: number; d: number; n: number; v: number };

/**
 * An edit of a loop that follows its take (in the Notes editor) begins: returns what to do
 * once it's done, which notes it records in the loop's link: take notes changed (they stay
 * changed when the loop is cut anew), take notes deleted (they stay out) and notes added
 * (the loop's own).
 */
export function beginEdit(loop: Take, take: Take): (() => void) | null {
  const found = follows(loop, take);
  if (!found) return null;
  const before = new Map<TakeNoteJSON, Values>();
  for (const n of loop.notes) before.set(n, { t: n.t, d: n.d, n: n.n, v: n.v });
  return () => {
    const link = (loop.link = loop.link ?? {});
    const now = new Set(loop.notes);
    const fixes = new Map<string, LoopFixJSON>((link.fix ?? []).map((f) => [keyText(f.k), f]));
    const hide = link.hide ?? [];
    found.sources.forEach((src, note) => {
      const text = keyText(src.key);
      const was = before.get(note)!;
      if (!now.has(note)) {
        fixes.delete(text);
        if (!hide.some((k) => keyText(k) === text)) hide.push(src.key);
        return;
      }
      if (note.t === was.t && note.d === was.d && note.n === was.n && note.v === was.v) return;
      const dt = (fixes.get(text)?.dt ?? 0) + (note.t - was.t);
      fixes.set(text, { k: src.key, dt, d: note.d, n: note.n, v: note.v, ...(note.x ? { x: note.x } : {}) });
    });
    for (const n of loop.notes) if (!before.has(n)) n.o = 1;
    if (hide.length) link.hide = hide;
    if (fixes.size) link.fix = [...fixes.values()];
    else delete link.fix;
  };
}

/**
 * The take is about to be edited: returns what to do afterwards, for the loops that follow
 * it: their keys follow the take notes that moved (or are dropped with deleted ones) and
 * each is cut anew (null: it doesn't follow; the loop stays as it is)
 */
export function beginTakeEdit(take: Take, loops: Take[]): () => (Take | null)[] {
  const following = loops.map((loop) => (follows(loop, take) ? loop : null));
  const keys = new Map<TakeNoteJSON, string>(take.notes.map((n) => [n, keyText([n.t, n.n])]));
  return () => {
    const moved = new Map<string, NoteKey | null>();
    const now = new Set(take.notes);
    keys.forEach((text, n) => {
      if (!now.has(n)) moved.set(text, null);
      else if (keyText([n.t, n.n]) !== text) moved.set(text, [round3(n.t), n.n]);
    });
    return following.map((loop) => {
      if (!loop) return null;
      const link = cloneLink(loop.link);
      const remap = (k: NoteKey): NoteKey | null => {
        const m = moved.get(keyText(k));
        return m === undefined ? k : m;
      };
      link.hide = (link.hide ?? []).map(remap).filter((k): k is NoteKey => k !== null);
      link.fix = (link.fix ?? [])
        .map((f) => {
          const k = remap(f.k);
          return k ? { ...f, k } : null;
        })
        .filter((f): f is LoopFixJSON => f !== null);
      if (!link.hide.length) delete link.hide;
      if (!link.fix.length) delete link.fix;
      const copy = loop.copy();
      copy.origin = loop.origin;
      copy.link = link;
      const from = windowFrom(loop, take);
      return recutWindow(copy, take, from, from + loop.length, 'edge');
    });
  };
}
