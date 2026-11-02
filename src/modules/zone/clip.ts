import { ClipJSON, ClipNoteJSON } from './interfaces';
import { PPQ } from './seq-layer';

export const TICKS_PER_BAR = PPQ * 4; // 4/4

/**
 * A recorded take: notes at free (sub-tick) times, looping from bar 1 of the song
 * clock with a length of any number of ticks (whole bars or not). Notes at or after the length are kept, so a
 * clip made shorter and longer again gets them back; they don't play meanwhile.
 */
export class Clip {
  static MAX_BARS = 1024;
  static MAX_LENGTH = Clip.MAX_BARS * TICKS_PER_BAR;
  static MAX_NOTES = 16384;
  length = TICKS_PER_BAR * 4; // any whole number of ticks, not only whole bars
  notes: ClipNoteJSON[] = []; // sorted by t

  get bars(): number {
    return this.length / TICKS_PER_BAR;
  }

  /** In bars, to the beat */
  set bars(v: number) {
    const beats = Math.round(v * 4);
    this.length = Math.max(1, Math.min(Clip.MAX_BARS * 4, beats)) * PPQ;
  }

  /** "3 bars", "2 bars 3 beats", "5 beats", or bars with decimals off the beat grid */
  static lengthLabel(ticks: number): string {
    const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (ticks % PPQ !== 0) return plural(Math.round((ticks / TICKS_PER_BAR) * 100) / 100, 'bar');
    const bars = Math.floor(ticks / TICKS_PER_BAR);
    const beats = (ticks % TICKS_PER_BAR) / PPQ;
    if (bars === 0) return plural(beats, 'beat');
    return beats === 0 ? plural(bars, 'bar') : `${plural(bars, 'bar')} ${plural(beats, 'beat')}`;
  }

  /** The notes that play: those starting within the length */
  get playing(): ClipNoteJSON[] {
    return this.notes.filter((n) => n.t < this.length);
  }

  /** Index of the first note starting at or after tick t */
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

  toJSON(): ClipJSON {
    const round = (v: number): number => Math.round(v * 1000) / 1000;
    return {
      length: this.length,
      notes: this.notes.map((n) => ({ t: round(n.t), d: round(n.d), n: n.n, v: n.v }))
    };
  }

  /** From a scene file or undo snapshot: untrusted, so every field is checked */
  static from(data: unknown): Clip {
    const clip = new Clip();
    if (!data || typeof data !== 'object') return clip;
    const d = data as Partial<ClipJSON>;
    const length = Math.round(Number(d.length));
    if (length >= 1) clip.length = Math.min(Clip.MAX_LENGTH, length);
    const maxT = Clip.MAX_LENGTH;
    if (Array.isArray(d.notes)) {
      for (const raw of d.notes.slice(0, Clip.MAX_NOTES)) {
        if (!raw || typeof raw !== 'object') continue;
        const t = Number(raw.t);
        const dur = Number(raw.d);
        const n = Math.round(Number(raw.n));
        const v = Math.round(Number(raw.v));
        if (!isFinite(t) || t < 0 || t >= maxT || !isFinite(dur) || dur <= 0) continue;
        if (!(n >= 0 && n <= 127) || !(v >= 1 && v <= 127)) continue;
        clip.notes.push({ t, d: Math.min(dur, maxT), n, v });
      }
    }
    clip.sort();
    return clip;
  }
}
