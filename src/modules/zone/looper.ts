import { PPQ } from './seq-layer';
import { Take, takeNote, songNote } from './take';
import type { SongNote } from './take';
import type { TakeNoteJSON } from './interfaces';
import { fitCurves } from './note-curve';
import type { CurveBuilder } from './note-curve';

/**
 * The zone's looper: one button records a loop, closes it, overdubs it.
 *
 * - A press counts for the nearest 1: in a bar's first half the 1 just passed (what was
 *   played since is in the buffer), in its second half the coming one (it waits).
 * - No loop: the press starts recording, the next press closes it at its nearest 1 (at
 *   least a bar), the loop plays from there on. A loop: the press starts an overdub,
 *   the next one ends it (merged into the loop then; until then its notes play as a layer).
 * - A press while waiting for the 1 cancels. Two presses in quick succession on a playing
 *   loop clear it.
 * - Pick-ups: the phrase leading into a recording's first 1 (in the bar before it, after
 *   a rest of a beat or more) goes at the loop's end, unless it has it there already, so
 *   it sounds before every repeat.
 *
 * Positions are ticks since the section began (Start, or an arrangement's entry), so the
 * ruler's loop range doesn't move them. The loop's cycle starts at `anchor`: where it was
 * recorded, 0 after Start or an arrangement's entry (the loop starts over at bar 1).
 */

// a note this close before a 1 is that 1's downbeat, played early (3 ticks, ~60 ms at 120 BPM)
export const EARLY = PPQ / 8;
// onsets of the same pitch this close are the same note: played again over the loop, or on
// a later cycle of an overdub (4 ticks, ~80 ms at 120 BPM; same-pitch 16ths are 6 apart)
const SAME = PPQ / 6;
// a pick-up played again at the loop's end, a little off: under a 16th
const MIRROR = PPQ / 4 - 1;
export const DOUBLE_PRESS_MS = 400;
export const MAX_LOOP_BARS = 64;
// a loop keeps what lies this many bars either side of it, so its edges can be dragged out
export const SPARE_BARS = 16;

interface Played extends SongNote {
  open: boolean;
  /** The key's expression while it's still coming in (MPE) */
  cb?: CurveBuilder;
}

export type LooperMode = 'idle' | 'rec' | 'dub';

/** What a press did; `changed`: the loop itself changed (an undo step) */
export type PressResult =
  | { kind: 'none' | 'armed' | 'started' | 'cancelled' | 'closing' }
  | { kind: 'recorded'; loop: Take }
  | { kind: 'dubbed'; added: number }
  | { kind: 'cleared' }
  | { kind: 'empty' };

const posMod = (a: number, m: number): number => ((a % m) + m) % m;

/**
 * A loop of the bars from `from` to `to` of what was played (positions as played): the
 * notes in it from its first 1 (one up to EARLY before it is that 1's downbeat), and the
 * pick-up at its end unless played there already. The pick-up is the phrase leading into
 * the first 1: in the bar before it, the notes after the last rest of a beat or more,
 * starting after that bar's 1 (playing straight through has no such rest, so nothing of
 * it is wrapped round)
 */
/**
 * Where the pick-up into the 1 at `from` begins: in the bar before it, the first note after
 * the last rest of a beat or more, unless that phrase starts on the bar's own 1 (then it's a
 * bar of the line, not a pick-up). Infinity: no pick-up.
 */
export function pickupStart(played: { s: number; d: number }[], from: number, bar: number): number {
  let phrase = -Infinity;
  for (const o of played) {
    if (o.s <= from - bar + EARLY || o.s >= from - EARLY || o.s <= phrase) continue;
    if (!played.some((p) => p.s < o.s && p.s + p.d > o.s - PPQ + EARLY)) phrase = o.s;
  }
  return phrase === -Infinity ? Infinity : phrase;
}

export function loopFromNotes(
  played: SongNote[],
  from: number,
  to: number,
  bar: number,
  empty = false
): Take | null {
  const len = to - from;
  if (len <= 0) return null;
  const used = new Set<object>();
  const notes: TakeNoteJSON[] = [];
  for (const p of played) {
    if (p.s < from - EARLY || p.s >= to - EARLY) continue;
    notes.push(takeNote(p, Math.max(0, p.s - from), Math.min(p.d, len)));
    used.add(p);
  }
  const before = played.filter((p) => p.s >= from - bar && p.s < from - EARLY).sort((a, b) => a.s - b.s);
  const phrase = pickupStart(played, from, bar);
  for (const p of before) {
    if (p.s < phrase) continue;
    const t = p.s - from + len;
    if (t < 0) continue;
    if (notes.some((n) => n.n === p.n && Math.abs(n.t - t) <= MIRROR)) continue;
    notes.push(takeNote(p, t, Math.max(0.25, Math.min(p.d, len)), true));
    used.add(p);
  }
  if ((notes.length === 0 && !empty) || notes.length > Take.MAX_NOTES) return null;
  const loop = new Take();
  loop.start = 0;
  loop.length = len;
  loop.notes = notes;
  loop.spare = spareOf(played.filter((p) => !used.has(p)), from, to, bar);
  loop.sort();
  fitCurves([...loop.notes, ...loop.spare]);
  return loop;
}

/** What lies outside a loop's bars, up to SPARE_BARS on either side (ticks from its start) */
function spareOf(rest: SongNote[], from: number, to: number, bar: number): TakeNoteJSON[] {
  return rest
    .filter((p) => p.s >= from - SPARE_BARS * bar && p.s < to + SPARE_BARS * bar)
    .sort((a, b) => Math.abs(a.s - (from + to) / 2) - Math.abs(b.s - (from + to) / 2))
    .slice(0, Take.MAX_SPARE)
    .map((p) => takeNote(p, p.s - from))
    .sort((a, b) => a.t - b.t);
}

/**
 * The loop with its edges moved: bars `a`…`b`, counted from its start (a < 0 or b > its
 * length drag an edge out, into what it was cut from; in, the bars go to its spare notes).
 * Moving only the end carries the pick-up along with it; moving the start finds the pick-up
 * into the new first 1 by the same rule as recording. A new Take (null: no bars left).
 */
export function recutLoop(loop: Take, a: number, b: number, bar: number): Take | null {
  if (b - a < bar) return null;
  const len = loop.length;
  // a pick-up counts as one only while it's still in the last bar (an edit may have moved it)
  const isPickup = (n: TakeNoteJSON): boolean => n.p === 1 && n.t >= len - bar;
  const asPlayed = (n: TakeNoteJSON, s: number): SongNote => songNote(n, s);
  let next: Take | null;
  if (a === 0) {
    // the pick-up (flagged, before the start: in the last bar, or set aside as played there already)
    const pickups = [
      ...loop.notes.filter(isPickup).map((n) => ({ ...n, t: n.t - len })),
      ...loop.spare.filter((n) => n.p === 1 && n.t < 0 && n.t >= -bar)
    ];
    const regular = [...loop.notes.filter((n) => !isPickup(n)), ...loop.spare.filter((n) => !pickups.includes(n))].map(
      (n) => asPlayed(n, n.t)
    );
    next = new Take();
    next.start = 0;
    next.length = b;
    const used = new Set<object>();
    for (const p of regular) {
      if (p.s < -EARLY || p.s >= b - EARLY) continue;
      next.notes.push(takeNote(p, Math.max(0, p.s), Math.min(p.d, b)));
      used.add(p);
    }
    // carried along with the end, unless the loop has it there already (then aside, flagged)
    const parked: TakeNoteJSON[] = [];
    for (const n of pickups) {
      const t = n.t + b;
      if (next.notes.some((m) => !m.p && m.n === n.n && Math.abs(m.t - t) <= MIRROR)) parked.push(takeNote(n, n.t, n.d, true));
      else next.notes.push(takeNote(n, t, n.d, true));
    }
    next.spare = [...spareOf(regular.filter((p) => !used.has(p)), 0, b, bar), ...parked].sort((x, y) => x.t - y.t);
  } else {
    const all = [
      ...loop.notes.map((n) => asPlayed(n, isPickup(n) ? n.t - len : n.t)),
      ...loop.spare.map((n) => asPlayed(n, n.t))
    ].sort((x, y) => x.s - y.s);
    next = loopFromNotes(all, a, b, bar, true);
  }
  if (!next) return null;
  next.id = loop.id;
  next.sections = loop.sections.map((s) => ({ t: s.t, meter: s.meter }));
  next.origin = loop.origin ? { at: loop.origin.at, run: loop.origin.run + a } : null;
  next.sort();
  return next;
}

export class Looper {
  mode: LooperMode = 'idle';
  /** Where the recording or overdub begins (a 1); ahead of now while it waits for it */
  from = 0;
  /** Where it ends, once the closing press came */
  to: number | null = null;
  /** Where the loop's cycle starts */
  anchor = 0;
  /** What happened to the loop in this run (recorded or overdubbed), so the card offers its bars after Stop */
  lastRun: 'rec' | 'dub' | null = null;
  private played: Played[] = [];
  // counts changes to `played`, so the overdub layer is rebuilt only when it changed
  private version = 0;
  private layerCache: { key: string; notes: TakeNoteJSON[] } | null = null;
  private lastPressMs = -Infinity;
  private lastPressDubbed = false;

  /** Ticks since the section began → bar line nearest to it */
  static nearestOne(now: number, bar: number): number {
    return Math.round(now / bar) * bar;
  }

  /** Waiting for its first 1 */
  isArmed(now: number): boolean {
    return this.mode !== 'idle' && this.from > now;
  }

  /** Recording or overdubbing now */
  isActive(now: number): boolean {
    return this.mode !== 'idle' && this.from <= now;
  }

  /** Returns the note in the input buffer (null when it's full), so its expression can follow */
  noteOn(at: number, n: number, v: number): Played | null {
    this.noteOff(at, n);
    if (this.played.length >= Take.MAX_NOTES) return null;
    this.version++;
    const note: Played = { s: at, d: 0, n, v, open: true };
    this.played.push(note);
    return note;
  }

  /** A note's expression came in completely (the overdub layer is built again) */
  touch(): void {
    this.version++;
  }

  noteOff(at: number, n: number): void {
    for (let i = this.played.length - 1; i >= 0; i--) {
      const p = this.played[i];
      if (p.open && p.n === n) {
        this.version++;
        p.open = false;
        p.d = Math.max(0.25, at - p.s);
        return;
      }
    }
  }

  /** Forget what can't be needed any more: before the bar before now, or before the recording's pick-ups */
  prune(now: number, bar: number): void {
    const keepFrom = (this.mode === 'idle' ? now : Math.min(now, this.from)) - 2 * bar;
    if (this.played.length === 0 || this.played[0].s >= keepFrom) return;
    this.version++;
    this.played = this.played.filter((p) => p.open || p.s + p.d >= keepFrom || p.s >= keepFrom);
  }

  /** Start over: Stop or another arrangement (the loop's cycle restarts at bar 1) */
  reset(): void {
    this.mode = 'idle';
    this.to = null;
    this.anchor = 0;
    this.played = [];
    this.version++;
  }

  /**
   * A press at `now` (ticks since the section began; 0 while stopped: it then waits for
   * bar 1). `close` finishes a recording or overdub at its end (it changes the loop).
   */
  press(now: number, bar: number, loop: Take | null, ms: number, close: (to: number) => PressResult): PressResult {
    const quick = ms - this.lastPressMs < DOUBLE_PRESS_MS;
    const afterDubPress = quick && this.lastPressDubbed;
    this.lastPressMs = ms;
    this.lastPressDubbed = false;
    // a second quick press on a playing loop: the first one started an overdub, this clears
    if (afterDubPress && loop) {
      this.mode = 'idle';
      this.to = null;
      return { kind: 'cleared' };
    }
    const one = Looper.nearestOne(now, bar);
    if (this.mode === 'idle') {
      this.mode = loop ? 'dub' : 'rec';
      this.from = one;
      this.to = null;
      this.lastPressDubbed = !!loop;
      return { kind: one > now ? 'armed' : 'started' };
    }
    // still waiting for its 1: never mind
    if (this.from > now) {
      this.mode = 'idle';
      return { kind: 'cancelled' };
    }
    // already waiting for its end: pressed too late, so a second press ends it at the 1 just
    // passed (as long as that leaves at least a bar)
    if (this.to !== null) {
      const back = this.to - bar;
      if (back < this.from + bar || back > now) return { kind: 'none' };
      this.to = null;
      return close(back);
    }
    // at least a bar (a press just after the start means the bar after it)
    const to = Math.max(one, this.from + bar);
    if (to > now) {
      this.to = to;
      return { kind: 'closing' };
    }
    return close(to);
  }

  /** Whether the recording or overdub ends at elapsed `now` (its end reached, or the longest loop) */
  dueAt(now: number, bar: number): number | null {
    if (this.mode === 'idle' || this.from > now) return null;
    if (this.to !== null && now >= this.to) return this.to;
    if (this.mode === 'rec' && now >= this.from + MAX_LOOP_BARS * bar) return this.from + MAX_LOOP_BARS * bar;
    return null;
  }

  /** Where Stop or a switch ends a recording: its nearest 1 so far, at least a bar (null: nothing to finish) */
  finishAt(now: number, bar: number): number | null {
    if (this.mode === 'idle') return null;
    if (this.from > now) {
      this.mode = 'idle';
      return null;
    }
    return this.to ?? Math.max(Looper.nearestOne(now, bar), this.from + bar);
  }

  /** What was played, positions as played, held notes up to `until` */
  private notesBetween(from: number, to: number, until: number): Played[] {
    return this.played
      .filter((p) => p.s >= from && p.s < to)
      .map((p) => {
        const x = p.cb?.curve() ?? p.x;
        return p.open || x !== p.x ? { ...p, d: p.open ? Math.max(0.25, until - p.s) : p.d, x } : p;
      });
  }

  /** The recording from `from` to `to` becomes the loop (null when nothing was played) */
  closeRecording(to: number, bar: number, now: number): Take | null {
    const from = this.from;
    this.mode = 'idle';
    this.to = null;
    const loop = loopFromNotes(this.notesBetween(from - SPARE_BARS * bar, to + SPARE_BARS * bar, now), from, to, bar);
    if (loop) this.anchor = from;
    return loop;
  }

  /**
   * The overdub's notes from its first 1 (a pick-up up to half a bar before it lands just
   * before it, as played) up to `to`, at places in the loop (held ones up to `now`, or left
   * out with `finished`). Not twice: a note the loop has already (played along with it),
   * or one played again at the same place on a later cycle of the overdub; same-pitch
   * notes close together on one cycle are all kept.
   */
  private dubNotes(loop: Take, to: number, bar: number, now: number, finished = false): TakeNoteJSON[] {
    const len = loop.length;
    const near = (a: number, b: number): boolean => Math.min(posMod(a - b, len), posMod(b - a, len)) <= SAME;
    const kept: { note: TakeNoteJSON; cycle: number }[] = [];
    for (const p of this.notesBetween(this.from - bar / 2, to - EARLY, now)) {
      if (finished && p.open) continue;
      const note = takeNote(p, posMod(p.s - this.anchor, len), Math.min(p.d, len));
      const cycle = Math.floor((p.s - this.anchor) / len);
      if (loop.notes.some((m) => m.n === note.n && near(m.t, note.t))) continue;
      if (kept.some((k) => k.cycle !== cycle && k.note.n === note.n && near(k.note.t, note.t))) continue;
      kept.push({ note, cycle });
    }
    return kept.map((k) => k.note);
  }

  /** While overdubbing: its finished notes so far, to play along on later cycles */
  dubLayer(loop: Take, now: number, bar: number): TakeNoteJSON[] {
    if (this.mode !== 'dub' || this.from > now) return [];
    const key = `${this.version}|${this.from}|${loop.length}|${loop.notes.length}`;
    if (this.layerCache?.key !== key) this.layerCache = { key, notes: this.dubNotes(loop, Infinity, bar, now, true) };
    return this.layerCache.notes;
  }

  /** The overdub ends at `to`: its notes join the loop */
  closeDub(loop: Take, to: number, bar: number, now: number): number {
    const added = this.dubNotes(loop, to, bar, now);
    this.mode = 'idle';
    this.to = null;
    this.layerCache = null;
    let count = 0;
    for (const n of added) {
      if (loop.notes.length >= Take.MAX_NOTES) break;
      loop.notes.push(n);
      count++;
    }
    loop.sort();
    if (count > 0) fitCurves([...loop.notes, ...loop.spare]);
    return count;
  }
}
