import { TakeJSON, TakeNoteJSON } from './interfaces';
import { PPQ } from './seq-layer';
import { Meter, DEFAULT_METER, barTicks, unitTicks, parseMeter } from '../meter';

/**
 * A take: what was played into a zone during one run of an arrangement, at free
 * (sub-tick) times. `start` is its place in the arrangement's song (ticks from its
 * bar 1). Note times count from the recording's start; trimming only moves the window
 * (`offset`, `length`) the take shows of them, so a trimmed take can grow back.
 */
export class Take {
  static MAX_BARS = 1024; // of 4/4
  static MAX_LENGTH = Take.MAX_BARS * PPQ * 4;
  static MAX_NOTES = 16384;
  /** A loop's spare notes at most (they're in the scene and every undo step) */
  static MAX_SPARE = 4096;
  // identifies a recorded take, so the session's list can hide it while it's kept
  id = Math.random().toString(36).slice(2, 10);
  start = 0;
  length = PPQ * 4;
  offset = 0; // where in the recording the take's start lies
  notes: TakeNoteJSON[] = []; // sorted by t
  /** When it was recorded (ms since 1970; 0: unknown) */
  at = 0;
  /** Recording order (Take.counter when it was recorded) */
  seq = 0;
  /** Sections of the run it was recorded in: where each began (take ticks, the first at 0) and its meter */
  sections: { t: number; meter: Meter }[] = [];
  /**
   * A loop's notes outside its bars, from what it was cut from (ticks from its start: before
   * it negative, after it from its length on), so its edges can be dragged out again
   */
  spare: TakeNoteJSON[] = [];
  /** A take: where it starts in its run (run ticks; the lead before its first bar was cut) */
  runOffset = 0;
  /** A loop: the run it was cut from (as a take's `at`) and where its first bar was in it (run ticks) */
  origin: { at: number; run: number } | null = null;
  /** Counts recordings (the last seq handed out) */
  static counter = 0;

  /** The section a position (take ticks) lies in: its start and meter, so bars line up as played */
  sectionAt(t: number): { t: number; meter: Meter } {
    let found = this.sections[0] ?? { t: 0, meter: DEFAULT_METER };
    for (const s of this.sections) if (s.t <= t) found = s;
    return found;
  }

  /** The bar line at or before (floor), nearest to (round) or after (ceil) a position, in its section's bars */
  barLine(t: number, how: 'floor' | 'round' | 'ceil' = 'round'): number {
    const sec = this.sectionAt(t);
    const bar = barTicks(sec.meter);
    return sec.t + Math[how]((t - sec.t) / bar) * bar;
  }

  /** The notes inside the window, at song positions, lengths clipped to the take's end */
  visibleNotes(): { s: number; d: number; n: number; v: number }[] {
    const result: { s: number; d: number; n: number; v: number }[] = [];
    const last = this.offset + this.length;
    for (let i = this.firstAtOrAfter(this.offset); i < this.notes.length && this.notes[i].t < last; i++) {
      const n = this.notes[i];
      result.push({ s: this.start + n.t - this.offset, d: Math.min(n.d, last - n.t), n: n.n, v: n.v });
    }
    return result;
  }

  get end(): number {
    return this.start + this.length;
  }

  /** Song position of a note of the recording */
  songOf(note: TakeNoteJSON): number {
    return this.start + note.t - this.offset;
  }

  /** The earliest song position a note can start at: the take's start, not before the recording */
  get floor(): number {
    return this.start + Math.max(0, -this.offset);
  }

  /** Add notes at song positions (none before `floor`, up to MAX_NOTES); returns the added ones */
  addNotes(notes: { s: number; d: number; n: number; v: number }[]): TakeNoteJSON[] {
    const added: TakeNoteJSON[] = [];
    for (const n of notes) {
      if (this.notes.length >= Take.MAX_NOTES) break;
      const s = Math.max(this.floor, n.s);
      const note = {
        t: s - this.start + this.offset,
        d: Math.max(0.01, n.d),
        n: Math.max(0, Math.min(127, Math.round(n.n))),
        v: Math.max(1, Math.min(127, Math.round(n.v)))
      };
      this.notes.push(note);
      added.push(note);
    }
    this.sort();
    return added;
  }

  removeNotes(notes: Set<TakeNoteJSON>): void {
    this.notes = this.notes.filter((n) => !notes.has(n));
  }

  /** Index of the first note starting at or after tick t (take-relative) */
  firstAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  sort(): void {
    this.notes.sort((a, b) => a.t - b.t || a.n - b.n);
  }

  /** The part between two song positions, as a take of its own */
  slice(from: number, to: number): Take {
    const part = new Take();
    part.start = from;
    part.length = Math.max(1, Math.round(to - from));
    part.notes = this.visibleNotes()
      .filter((n) => n.s >= from && n.s < to)
      .map((n) => ({ t: n.s - from, d: Math.min(n.d, to - n.s), n: n.n, v: n.v }));
    return part;
  }

  /**
   * Move the notes that start at the given song positions (`from` → `to`), e.g. after
   * quantizing; none moves before the take's start. Keeps them sorted.
   */
  moveNotes(moves: Map<number, number>, songFloor: number): void {
    // matched to a millionth of a tick: positions computed in other ways may differ slightly
    const key = (s: number): number => Math.round(s * 1e6);
    const byKey = new Map<number, number>();
    moves.forEach((to, from) => byKey.set(key(from), to));
    for (const n of this.notes) {
      const s = this.start + n.t - this.offset;
      const to = byKey.get(key(s));
      if (to === undefined) continue;
      n.t = Math.max(0, n.t + Math.max(songFloor, to) - s);
    }
    this.sort();
  }

  /** Cut at a song position inside the take: this keeps the part before, the part after is returned */
  cutAt(at: number): Take {
    const after = this.copy();
    after.id = new Take().id;
    after.start = at;
    after.offset = this.offset + (at - this.start);
    after.length = this.end - at;
    this.length = at - this.start;
    return after;
  }

  /**
   * "3 bars", "2 bars 3 beats", "5 beats" (x/8: eighths), or bars with decimals off
   * the grid, in the arrangement's meter
   */
  static lengthLabel(ticks: number, meter: Meter = DEFAULT_METER): string {
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    const bar = barTicks(meter);
    const unit = unitTicks(meter);
    if (ticks % unit !== 0) return plural(Math.round((ticks / bar) * 100) / 100, 'bar');
    const bars = Math.floor(ticks / bar);
    const rest = (ticks % bar) / unit;
    const word = meter.d === 8 ? 'eighth' : 'beat';
    if (bars === 0) return plural(rest, word);
    return rest === 0 ? plural(bars, 'bar') : `${plural(bars, 'bar')} ${plural(rest, word)}`;
  }

  toJSON(): TakeJSON {
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      id: this.id,
      start: this.start,
      length: this.length,
      offset: this.offset,
      ...(this.at ? { at: this.at } : {}),
      ...(this.seq ? { seq: this.seq } : {}),
      ...(this.sections.length ? { sections: this.sections.map((s) => ({ t: s.t, meter: s.meter })) } : {}),
      notes: this.notes.map((n) => ({ t: round(n.t), d: round(n.d), n: n.n, v: n.v, ...(n.p ? { p: 1 as const } : {}) })),
      ...(this.runOffset ? { runOffset: this.runOffset } : {}),
      ...(this.origin ? { origin: { at: this.origin.at, run: this.origin.run } } : {}),
      ...(this.spare.length
        ? { spare: this.spare.map((n) => ({ t: round(n.t), d: round(n.d), n: n.n, v: n.v, ...(n.p ? { p: 1 as const } : {}) })) }
        : {})
    };
  }

  /** From a scene file or undo snapshot: untrusted, so every field is checked */
  static from(data: unknown): Take | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Partial<TakeJSON>;
    const take = new Take();
    const start = Math.round(Number(d.start));
    const length = Math.round(Number(d.length));
    if (!(start >= 0 && start <= Take.MAX_LENGTH) || !(length >= 1)) return null;
    take.start = start;
    take.length = Math.min(Take.MAX_LENGTH, length);
    if (typeof d.id === 'string' && /^[a-z0-9]{1,16}$/.test(d.id)) take.id = d.id;
    const offset = Number(d.offset ?? 0);
    if (isFinite(offset) && Math.abs(offset) <= Take.MAX_LENGTH) take.offset = offset;
    const at = Number(d.at);
    if (at > 0 && at < 1e14) take.at = at;
    const seq = Math.round(Number(d.seq));
    if (seq > 0 && seq < 1e9) {
      take.seq = seq;
      Take.counter = Math.max(Take.counter, seq);
    }
    if (Array.isArray(d.sections)) {
      for (const sec of d.sections.slice(0, 256)) {
        const t = Number(sec?.t);
        const meter = parseMeter(sec?.meter);
        if (isFinite(t) && t >= 0 && t <= Take.MAX_LENGTH && meter) take.sections.push({ t, meter });
      }
      take.sections.sort((a, b) => a.t - b.t);
    }
    const note = (raw: unknown, lo: number, hi: number): TakeNoteJSON | null => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Partial<TakeNoteJSON>;
      const t = Number(r.t);
      const dur = Number(r.d);
      const n = Math.round(Number(r.n));
      const v = Math.round(Number(r.v));
      if (!isFinite(t) || t < lo || t >= hi || !isFinite(dur) || dur <= 0) return null;
      if (!(n >= 0 && n <= 127) || !(v >= 1 && v <= 127)) return null;
      return { t, d: Math.min(dur, Take.MAX_LENGTH), n, v, ...(r.p === 1 ? { p: 1 as const } : {}) };
    };
    if (Array.isArray(d.notes)) {
      for (const raw of d.notes.slice(0, Take.MAX_NOTES)) {
        const n = note(raw, 0, Take.MAX_LENGTH);
        if (n) take.notes.push(n);
      }
    }
    const runOffset = Number(d.runOffset);
    if (runOffset > 0 && runOffset <= Take.MAX_LENGTH) take.runOffset = runOffset;
    const oAt = Number(d.origin?.at);
    const oRun = Number(d.origin?.run);
    if (oAt > 0 && oAt < 1e14 && isFinite(oRun) && Math.abs(oRun) <= 4 * Take.MAX_LENGTH) take.origin = { at: oAt, run: oRun };
    if (Array.isArray(d.spare)) {
      for (const raw of d.spare.slice(0, Take.MAX_SPARE)) {
        const n = note(raw, -Take.MAX_LENGTH, 2 * Take.MAX_LENGTH);
        if (n) take.spare.push(n);
      }
      take.spare.sort((a, b) => a.t - b.t);
    }
    take.sort();
    return take;
  }

  /** Back to what it was (undo of an edit): from its own JSON, in place */
  restore(json: TakeJSON): void {
    const from = Take.from(json);
    if (!from) return;
    this.start = from.start;
    this.length = from.length;
    this.offset = from.offset;
    this.notes = from.notes;
    this.spare = from.spare;
  }

  copy(): Take {
    return Take.from(this.toJSON())!;
  }

  /** A list of takes from a scene file, the broken ones left out */
  static listFrom(data: unknown): Take[] {
    if (!Array.isArray(data)) return [];
    return data.map((t) => Take.from(t)).filter((t): t is Take => t !== null);
  }
}
