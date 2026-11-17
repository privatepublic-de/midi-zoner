/**
 * Live chords (experiment, Nov 2026): plays chords to a line as it is played. It can't know
 * a bar before it's played, so at each beat it guesses from what it has: notes held now,
 * the last notes before the beat, and what was played 1, 2 and 4 bars earlier (riffs
 * repeat). A moment after the beat it listens again and, if the note on the beat clashes
 * with its guess, changes chord (as an accompanist reacting). The key is found from the
 * last 8 bars and only changes when another one wins twice in a row.
 *
 * Positions are song ticks (the arrangement's bar 1 = 0). The chords it played are kept per
 * beat (`log`), so a loop closed over them can keep what was heard.
 */
import { Meter, barTicks } from '../meter';
import { PPQ } from './seq-layer';
import { hashRoll } from '../prng';
import {
  Chord,
  Key,
  HarmonyOptions,
  LineNote,
  Segment,
  analyse,
  vocabulary,
  fitOf,
  transition,
  changeCost,
  segmentsOf,
  styleOf,
  rangeFor,
  voiceChord,
  spanNotes,
  bassLine,
  chordName,
  QUALITY_INDEX
} from './harmonize';

/** A note of the line, at song positions; `held`: still down */
export interface HeardNote {
  s: number;
  d: number;
  n: number;
  v: number;
  held: boolean;
}

/** A note on or off for the chord zone (`bass`: for the bass zone) */
export type Send = (on: boolean, n: number, v: number, bass: boolean) => void;

interface Event {
  at: number;
  on: boolean;
  n: number;
  v: number;
  bass: boolean;
  token: number;
}

const WINDOW_BARS = 8;
/** Ticks after the beat when it listens again */
const LISTEN = 6;

export class LiveChords {
  key: Key | null = null;
  chord: Chord | null = null;
  /** the chords played, per beat (song ticks of the beat → chord) */
  log = new Map<number, Chord>();
  private rival: { key: Key; count: number } | null = null;
  private voicing: number[] | null = null;
  /** the last bass note played (voice leading for the next) */
  private lastBass: number | null = null;
  private queue: Event[] = [];
  /** notes sounding: pitch (+128 for bass) → the token of their note-on */
  private sounding = new Map<number, number>();
  private token = 0;
  /** the span playing: its notes' tokens */
  private spanTokens = new Set<number>();
  private spanEnd = 0;
  private check: { seg: Segment; at: number } | null = null;

  /** Called on every clock tick while running; true when the chord or key changed */
  tick(pos: number, heard: HeardNote[], o: HarmonyOptions, meter: Meter, send: Send): boolean {
    let changed = false;
    const style = styleOf(o);
    // with pushes the chord is decided an 8th before its beat (it comes in there)
    const lead = style === 2 ? PPQ / 2 : 0;
    const target = pos + lead;
    const bar = barTicks(meter);
    const segs = barSegments(Math.floor(target / bar), meter);
    const seg = segs.find((s) => s.t === target);
    if (seg) changed = this.decide(seg, segs, pos, heard, o, meter, send) || changed;
    if (this.check && pos >= this.check.at) {
      const c = this.check;
      this.check = null;
      changed = this.correct(c.seg, pos, heard, o, meter, send) || changed;
    }
    this.fire(pos, send);
    return changed;
  }

  /** Stop, or the chord zone got a loop: everything off, the next run starts fresh (the key stays) */
  stop(send: Send): void {
    for (const [key] of this.sounding) send(false, key % 128, 0, key >= 128);
    this.sounding.clear();
    this.queue = [];
    this.spanTokens.clear();
    this.chord = null;
    this.voicing = null;
    this.lastBass = null;
    this.check = null;
    this.rival = null;
  }

  get name(): string {
    return this.chord ? chordName(this.chord) : '';
  }

  // ------------------------------------------------------------------ choosing

  private updateKey(seg: Segment, heard: HeardNote[], o: HarmonyOptions, meter: Meter): void {
    const bar = barTicks(meter);
    const from = seg.t - WINDOW_BARS * bar;
    const line: LineNote[] = heard
      .filter((h) => h.s >= from && h.s < seg.t)
      .map((h) => ({ t: h.s - from, d: Math.max(1, Math.min(h.d, seg.t - h.s)), n: h.n, v: h.v }));
    // a key needs a few notes and at least three pitch classes
    if (line.length < 4 || new Set(line.map((n) => n.n % 12)).size < 3) return;
    const a = analyse(line, seg.t - from, meter, o.harmony);
    const best = a.keys[0];
    const same = (x: Key, y: Key) => x.tonic === y.tonic && x.mode === y.mode;
    if (!this.key) {
      this.key = best;
      return;
    }
    if (same(best, this.key)) {
      this.rival = null;
      return;
    }
    const current = a.keys.find((k) => same(k, this.key!));
    if (current && best.score - current.score < 0.04) {
      this.rival = null;
      return;
    }
    this.rival = this.rival && same(this.rival.key, best) ? { key: best, count: this.rival.count + 1 } : { key: best, count: 1 };
    if (this.rival.count >= 2) {
      this.key = best;
      this.rival = null;
    }
  }

  /** The line's pitch classes for a beat, as far as they can be known now */
  private weights(seg: Segment, now: number, heard: HeardNote[], meter: Meter, onBeat: boolean): number[] {
    const w = new Array(12).fill(0);
    const bar = barTicks(meter);
    const add = (h: HeardNote, from: number, to: number, k: number) => {
      const o = Math.min(to, h.s + h.d) - Math.max(from, h.s);
      if (o > 0) w[h.n % 12] += (Math.max(o, PPQ / 4) / PPQ) * k * (0.6 + 0.4 * (h.v / 127));
    };
    for (const h of heard) {
      // held now: it sounds into the beat
      if (h.held || h.s + h.d > seg.t) add({ ...h, d: Math.max(h.d, seg.end - h.s) }, seg.t, seg.end, 1);
      // what led into the beat
      else if (h.s >= seg.t - PPQ / 2 && h.s < seg.t) w[h.n % 12] += 0.4;
      // played on the beat (listening again just after it)
      if (onBeat && h.s >= seg.t - 3 && h.s <= now) w[h.n % 12] += 2;
      // what was played here 1, 2, 4 and 8 bars ago (riffs and phrases repeat)
      [1, 2, 4, 8].forEach((bars, i) => add(h, seg.t - bars * bar, seg.end - bars * bar, [0.5, 0.3, 0.3, 0.4][i]));
    }
    return w;
  }

  private scores(seg: Segment, w: number[], o: HarmonyOptions, meter: Meter): { chord: Chord; score: number }[] {
    const key = this.key!;
    const h = Math.max(0, Math.min(1, o.harmony));
    const len = (seg.end - seg.t) / PPQ;
    const prev = this.chord;
    return vocabulary(key, h).map((c) => {
      let x = fitOf(w, c, key) + 0.25 * c.prior * len;
      if (prev) {
        const same = prev.root === c.root && prev.quality === c.quality;
        x += same ? 0.15 : transition(prev, c, key, h) - changeCost(seg, o.changes) + (seg.beat === 0 ? 0.25 * (1 - h) : 0);
      } else if (c.root === key.tonic && c.degree === 0) x += 0.5;
      if (o.seed) x += (hashRoll(o.seed, seg.bar, c.root, QUALITY_INDEX[c.quality]) - 0.5) * 1.2 * len;
      // the form: what was played here 4 and 8 bars ago
      for (const [bars, k] of [[4, 0.3], [8, 0.5]]) {
        const then = this.log.get(seg.t - bars * barTicks(meter));
        if (then && then.root === c.root && then.quality === c.quality) x += k;
      }
      return { chord: c, score: x };
    });
  }

  private decide(seg: Segment, segs: Segment[], now: number, heard: HeardNote[], o: HarmonyOptions, meter: Meter, send: Send): boolean {
    const keyBefore = this.key;
    if (seg.beat === 0 || !this.key) this.updateKey(seg, heard, o, meter);
    if (!this.key) return false;
    const ranked = this.scores(seg, this.weights(seg, now, heard, meter, false), o, meter).sort((a, b) => b.score - a.score);
    const best = ranked[0].chord;
    const prev = this.chord;
    const same = prev && prev.root === best.root && prev.quality === best.quality;
    this.log.set(seg.t, same ? prev! : best);
    this.check = { seg, at: seg.t + LISTEN };
    const barEnd = segs[segs.length - 1].end;
    if (same && seg.beat !== 0) return this.key !== keyBefore;
    this.chord = same ? prev : best;
    this.play(this.chord!, { t: seg.t, end: barEnd }, segs, now, heard, o, meter, send, !!same);
    return !same || this.key !== keyBefore;
  }

  /** Just after the beat: the note played on it decides between the guess and a better chord */
  private correct(seg: Segment, now: number, heard: HeardNote[], o: HarmonyOptions, meter: Meter, send: Send): boolean {
    if (!this.key || !this.chord) return false;
    const w = this.weights(seg, now, heard, meter, true);
    const ranked = this.scores(seg, w, o, meter).sort((a, b) => b.score - a.score);
    const cur = this.chord;
    const best = ranked[0];
    if (best.chord.root === cur.root && best.chord.quality === cur.quality) return false;
    const mine = ranked.find((r) => r.chord.root === cur.root && r.chord.quality === cur.quality);
    // only when the guess clashes with what was played and the better chord is clearly better
    if (fitOf(w, cur, this.key) >= 0 || (mine && best.score - mine.score < 1.2)) return false;
    this.chord = best.chord;
    this.log.set(seg.t, best.chord);
    const segs = barSegments(seg.bar, meter);
    this.play(best.chord, { t: seg.t, end: segs[segs.length - 1].end }, segs, now, heard, o, meter, send, false);
    return true;
  }

  // ------------------------------------------------------------------ playing

  private play(
    chord: Chord,
    span: { t: number; end: number },
    segs: Segment[],
    now: number,
    heard: HeardNote[],
    o: HarmonyOptions,
    meter: Meter,
    send: Send,
    continuing: boolean
  ): void {
    const style = styleOf(o);
    const sounding = heard.filter((h) => h.held || (h.s < span.end && h.s + h.d > span.t)).map((h) => h.n);
    const recent: LineNote[] = heard.map((h) => ({ t: h.s, d: h.d, n: h.n, v: h.v }));
    const v = continuing && this.voicing ? this.voicing : voiceChord(chord, this.key!, o, sounding, this.voicing, rangeFor(recent, o));
    this.voicing = v;
    let notes = spanNotes(chord, v, span, segs, style, o, meter, 0);
    // a chord coming in late (a correction): what it would have played up to now comes in now
    notes = notes
      .map((n) => (n.t < now ? { ...n, t: now, d: n.d - (now - n.t) } : n))
      .filter((n) => n.d >= 3);
    // the next chord isn't known yet: a moving bass leads back to this one's root
    const line = bassLine(chord, span, this.key!, null, this.lastBass, o, style, meter, 0);
    this.lastBass = line.last;
    const bass = line.notes.map((n) => (n.t < now ? { ...n, t: now, d: n.d - (now - n.t) } : n)).filter((n) => n.d >= 3);
    const first = Math.min(...notes.map((n) => n.t), ...bass.map((n) => n.t));
    if (continuing && style === 0) {
      // a held chord going on into the next bar: its notes keep sounding, held to the new end
      const keep = new Set(notes.filter((n) => n.t === first && this.sounding.has(n.n)).map((n) => n.n));
      this.queue = this.queue.filter((e) => !(this.spanTokens.has(e.token) && !e.on && keep.has(e.n)));
      for (const n of notes) {
        if (n.t === first && keep.has(n.n)) this.queue.push({ at: n.t + n.d, on: false, n: n.n, v: 0, bass: false, token: this.sounding.get(n.n)! });
        else this.schedule(n, false);
      }
      for (const n of bass) this.schedule(n, true);
      this.spanEnd = span.end;
      return;
    }
    // the chord before stops where this one comes in
    this.queue = this.queue.filter((e) => !(this.spanTokens.has(e.token) && e.at >= first));
    for (const [key, token] of this.sounding) if (this.spanTokens.has(token)) this.queue.push({ at: first, on: false, n: key % 128, v: 0, bass: key >= 128, token });
    this.spanTokens.clear();
    for (const n of notes) this.schedule(n, false);
    for (const n of bass) this.schedule(n, true);
    this.spanEnd = span.end;
  }

  private schedule(n: LineNote, bass: boolean): void {
    const token = ++this.token;
    this.spanTokens.add(token);
    this.queue.push({ at: n.t, on: true, n: n.n, v: n.v, bass, token });
    this.queue.push({ at: n.t + n.d, on: false, n: n.n, v: 0, bass, token });
  }

  /** Events due by `pos`: note-offs before note-ons at the same time */
  private fire(pos: number, send: Send): void {
    const due = this.queue.filter((e) => e.at <= pos + 0.5).sort((a, b) => a.at - b.at || Number(a.on) - Number(b.on));
    if (!due.length) return;
    const set = new Set(due);
    this.queue = this.queue.filter((e) => !set.has(e));
    for (const e of due) {
      const key = e.n + (e.bass ? 128 : 0);
      if (e.on) {
        if (this.sounding.has(key)) send(false, e.n, 0, e.bass);
        send(true, e.n, e.v, e.bass);
        this.sounding.set(key, e.token);
      } else if (this.sounding.get(key) === e.token) {
        send(false, e.n, 0, e.bass);
        this.sounding.delete(key);
      }
    }
  }
}

/** The beats of bar `bar` (song ticks) */
function barSegments(bar: number, meter: Meter): Segment[] {
  const len = barTicks(meter);
  return segmentsOf(len, meter).map((s) => ({ ...s, t: s.t + bar * len, end: s.end + bar * len, bar }));
}

/**
 * The chords heard for a loop's beats: for each, the last time it was played before `now`
 * (song ticks; the loop's bar 1 lies on `anchor` + n × its length); null where none was
 */
export function heardChords(log: Map<number, Chord>, segs: Segment[], length: number, anchor: number, now: number): (Chord | null)[] {
  return segs.map((s) => {
    const m = Math.floor((now - 1 - (anchor + s.t)) / length);
    return log.get(anchor + s.t + m * length) ?? null;
  });
}
