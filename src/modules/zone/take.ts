import { TakeJSON, TakeNoteJSON } from './interfaces';
import { PPQ } from './seq-layer';
import { Meter, DEFAULT_METER, barTicks, unitTicks } from '../meter';

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
  // identifies a recorded take, so the session's list can hide it while it's kept
  id = Math.random().toString(36).slice(2, 10);
  start = 0;
  length = PPQ * 4;
  offset = 0; // where in the recording the take's start lies
  notes: TakeNoteJSON[] = []; // sorted by t

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
      notes: this.notes.map((n) => ({ t: round(n.t), d: round(n.d), n: n.n, v: n.v }))
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
    if (Array.isArray(d.notes)) {
      for (const raw of d.notes.slice(0, Take.MAX_NOTES)) {
        if (!raw || typeof raw !== 'object') continue;
        const t = Number(raw.t);
        const dur = Number(raw.d);
        const n = Math.round(Number(raw.n));
        const v = Math.round(Number(raw.v));
        if (!isFinite(t) || t < 0 || t >= Take.MAX_LENGTH || !isFinite(dur) || dur <= 0) continue;
        if (!(n >= 0 && n <= 127) || !(v >= 1 && v <= 127)) continue;
        take.notes.push({ t, d: Math.min(dur, Take.MAX_LENGTH), n, v });
      }
    }
    take.sort();
    return take;
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
