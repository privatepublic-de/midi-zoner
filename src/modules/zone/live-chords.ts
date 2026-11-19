/**
 * Live chords: plays chords to a line as it is played, for every chords or bass zone that
 * follows it (one decision per line, so they agree). It can't know
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
  chordTones,
  scaleOf,
  freeNoise,
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

/** A zone playing to the line: its id, part and settings; `out` is where its notes go (the zone object) */
export interface Follower {
  id: string;
  part: 'chords' | 'bass';
  o: HarmonyOptions;
  out: unknown;
}

/** A note on or off, through the follower's `out` */
/** `delay`: ticks into this tick (a strum's later notes); 0 = now */
export type Send = (out: unknown, on: boolean, n: number, v: number, delay?: number) => void;

interface Event {
  at: number;
  on: boolean;
  n: number;
  v: number;
  /** the follower's id */
  f: string;
  token: number;
}

/** What one follower is playing */
interface Voice {
  out: unknown;
  voicing: number[] | null;
  lastBass: number | null;
  /** pitch → token of its note-on */
  sounding: Map<number, number>;
  /** the span playing: its notes' tokens */
  spanTokens: Set<number>;
}

const WINDOW_BARS = 8;
/** Ticks after the beat when it listens again */
const LISTEN = 12; // an 8th: passing and approach notes are mostly let go by then

/** How calm live chords are, from Chord changes: 1 at Slow … 0 at Fast */
function calmOf(o: HarmonyOptions): number {
  return 1 - Math.max(0, Math.min(1, o.changes));
}

/**
 * How well a chord carries the notes, live: as fitOf(), but a 6th or 9th of the chord that is
 * in the key counts as its colour (C6, Cadd9), not against it, so a 6th on the beat doesn't
 * turn C into Am
 */
function liveFit(w: number[], c: Chord, key: Key): number {
  let f = fitOf(w, c, key);
  const tones = chordTones(c);
  const scale = scaleOf(key);
  // a chromatic neighbour (out of the key, a half step from a chord tone: G Ab G, G F# G) decorates
  // the chord instead of fighting it
  for (let pc = 0; pc < 12; pc++) {
    if (!w[pc] || scale.includes(pc) || tones.includes(pc)) continue;
    const above = tones.includes((pc + 11) % 12);
    const below = tones.includes((pc + 1) % 12);
    if (above) f += w[pc] * (1.3 - 0.2);
    else if (below) f += w[pc] * (0.8 - 0.2);
  }
  // a 6th or 9th in the key colours a chord of the key (C6, Cadd9)
  if (c.kind !== 'dia' || c.quality === 'q' || c.quality === 'sus2' || c.quality === 'sus4' || c.quality === 'dim') return f;
  for (const i of [2, 9]) {
    const pc = (c.root + i) % 12;
    if (w[pc] && scale.includes(pc) && !tones.includes(pc)) f += w[pc] * 0.25;
  }
  return f;
}

/** The weight of notes that really clash with a chord: a half step over a chord tone, or out of the key */
function clashOf(w: number[], c: Chord, key: Key): number {
  const tones = chordTones(c);
  const scale = scaleOf(key);
  let x = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (!w[pc] || tones.includes(pc)) continue;
    const inKey = scale.includes(pc);
    const neighbour = tones.includes((pc + 11) % 12) || tones.includes((pc + 1) % 12);
    // in the key: a half step over a chord tone clashes (F over C-E); out of it: anything but a neighbour
    if (inKey ? tones.includes((pc + 11) % 12) : !neighbour) x += w[pc];
  }
  return x;
}

export class LiveChords {
  key: Key | null = null;
  chord: Chord | null = null;
  /** the chords played, per beat (song ticks of the beat → chord) */
  log = new Map<number, Chord>();
  private rival: { key: Key; count: number } | null = null;
  private queue: Event[] = [];
  private voices = new Map<string, Voice>();
  private token = 0;
  private check: { seg: Segment; at: number } | null = null;

  /**
   * Called on every clock tick while running with the zones following the line (the first one's
   * settings choose the chords); true when the chord or key changed
   */
  tick(pos: number, heard: HeardNote[], followers: Follower[], meter: Meter, send: Send): boolean {
    this.sync(followers, send);
    if (!followers.length) return false;
    let changed = false;
    const o = followers[0].o;
    // with pushes the chord is decided an 8th before its beat (it comes in there)
    // (and when a syncopated bass anticipates the next chord)
    const lead = followers.some((f) => styleOf(f.o) === 2 || (f.part === 'bass' && (f.o.syncopation ?? 0) >= 0.3)) ? PPQ / 2 : 0;
    const target = pos + lead;
    const bar = barTicks(meter);
    const segs = barSegments(Math.floor(target / bar), meter);
    const seg = segs.find((s) => s.t === target);
    if (seg) changed = this.decide(seg, segs, pos, heard, o, followers, meter, send) || changed;
    if (this.check && pos >= this.check.at) {
      const c = this.check;
      this.check = null;
      changed = this.correct(c.seg, pos, heard, o, followers, meter, send) || changed;
    }
    this.fire(pos, send);
    return changed;
  }

  /** Followers gone or replaced (undo gives new zone objects): what they sound goes off */
  private sync(followers: Follower[], send: Send): void {
    for (const [id, v] of this.voices) {
      const f = followers.find((x) => x.id === id);
      if (!f || f.out !== v.out) this.release(id, send);
    }
  }

  /** One follower stops: its notes off, its events dropped */
  release(id: string, send: Send): void {
    const v = this.voices.get(id);
    if (!v) return;
    for (const [n] of v.sounding) send(v.out, false, n, 0);
    this.queue = this.queue.filter((e) => e.f !== id);
    this.voices.delete(id);
  }

  /** Stop, or nobody follows any more: everything off, the next run starts fresh (the key stays) */
  stop(send: Send): void {
    for (const id of [...this.voices.keys()]) this.release(id, send);
    this.queue = [];
    this.chord = null;
    this.check = null;
    this.rival = null;
  }

  /** Starting over: the key and the chords heard are forgotten too */
  reset(send: Send): void {
    this.stop(send);
    this.key = null;
    this.log.clear();
  }

  /** Panic: the synths were reset, nothing to send */
  forget(): void {
    this.voices.clear();
    this.queue = [];
    this.chord = null;
    this.check = null;
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
      // played on the beat (listening again an 8th after it), by its length: a 16th counts half, an 8th or more fully
      if (onBeat && h.s >= seg.t - 3 && h.s <= now) w[h.n % 12] += 2 * Math.min(1, (h.held ? now - h.s : h.d) / (PPQ / 2));
      // what was played here 1, 2, 4 and 8 bars ago (riffs and phrases repeat)
      [1, 2, 4, 8].forEach((bars, i) => add(h, seg.t - bars * bar, seg.end - bars * bar, [0.5, 0.3, 0.3, 0.4][i]));
    }
    // a note outside the key counts half, unless held a beat or more or played again within the bar:
    // a passing or approach note doesn't take the chord along, a note that stays does
    if (this.key) {
      const scale = scaleOf(this.key);
      for (let pc = 0; pc < 12; pc++) {
        if (!w[pc] || scale.includes(pc)) continue;
        const recent = heard.filter((h) => h.n % 12 === pc && h.s >= seg.t - bar && h.s <= now);
        const stays = recent.length >= 2 || recent.some((h) => (h.held ? now - h.s : h.d) >= PPQ);
        if (!stays) w[pc] *= 0.5;
      }
    }
    return w;
  }

  private scores(seg: Segment, w: number[], o: HarmonyOptions, meter: Meter): { chord: Chord; score: number }[] {
    const key = this.key!;
    const h = Math.max(0, Math.min(1, o.harmony));
    const len = (seg.end - seg.t) / PPQ;
    const prev = this.chord;
    return vocabulary(key, h, !!o.blues).map((c) => {
      const calm = calmOf(o);
      let x = liveFit(w, c, key) + 0.25 * c.prior * len;
      if (prev) {
        const same = prev.root === c.root && prev.quality === c.quality;
        x += same ? 0.15 + 0.5 * calm : transition(prev, c, key, h) - changeCost(seg, o.changes) + (seg.beat === 0 ? 0.25 * (1 - h) : 0);
      } else if (c.root === key.tonic && c.degree === 0) x += 0.5;
      // a chord from outside the key (a secondary dominant, borrowed) needs clearer reasons live
      if (c.kind === 'sec' || c.kind === 'bor' || c.kind === 'out') x -= 0.25 + 0.4 * calm;
      if (o.seed) x += (hashRoll(o.seed, seg.bar, c.root, QUALITY_INDEX[c.quality]) - 0.5) * 1.2 * len;
      x += freeNoise(o, seg, c) * len;
      // the form: what was played here 4 and 8 bars ago
      for (const [bars, k] of [[4, 0.3], [8, 0.5]]) {
        const then = this.log.get(seg.t - bars * barTicks(meter));
        if (then && then.root === c.root && then.quality === c.quality) x += k;
      }
      return { chord: c, score: x };
    });
  }

  private decide(seg: Segment, segs: Segment[], now: number, heard: HeardNote[], o: HarmonyOptions, followers: Follower[], meter: Meter, send: Send): boolean {
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
    for (const f of followers) this.play(f, this.chord!, { t: seg.t, end: barEnd }, segs, now, heard, meter, !!same);
    return !same || this.key !== keyBefore;
  }

  /** Just after the beat: the note played on it decides between the guess and a better chord */
  private correct(seg: Segment, now: number, heard: HeardNote[], o: HarmonyOptions, followers: Follower[], meter: Meter, send: Send): boolean {
    if (!this.key || !this.chord) return false;
    const w = this.weights(seg, now, heard, meter, true);
    const ranked = this.scores(seg, w, o, meter).sort((a, b) => b.score - a.score);
    const cur = this.chord;
    const best = ranked[0];
    if (best.chord.root === cur.root && best.chord.quality === cur.quality) return false;
    const mine = ranked.find((r) => r.chord.root === cur.root && r.chord.quality === cur.quality);
    // only when the guess clashes with what was played and the better chord is clearly better
    // only when the guess really clashes with a note held on the beat, and the better chord is clearly better
    if (clashOf(w, cur, this.key) < 1.5 || (mine && best.score - mine.score < 1.2 + 0.8 * calmOf(o))) return false;
    this.chord = best.chord;
    this.log.set(seg.t, best.chord);
    const segs = barSegments(seg.bar, meter);
    for (const f of followers) this.play(f, best.chord, { t: seg.t, end: segs[segs.length - 1].end }, segs, now, heard, meter, false);
    return true;
  }

  // ------------------------------------------------------------------ playing

  private play(
    f: Follower,
    chord: Chord,
    span: { t: number; end: number },
    segs: Segment[],
    now: number,
    heard: HeardNote[],
    meter: Meter,
    continuing: boolean
  ): void {
    let v = this.voices.get(f.id);
    if (!v) {
      v = { out: f.out, voicing: null, lastBass: null, sounding: new Map(), spanTokens: new Set() };
      this.voices.set(f.id, v);
    }
    const o = f.o;
    const style = styleOf(o);
    // a chord coming in late (a correction): what it would have played up to now comes in now
    const fromNow = (ns: LineNote[]) => ns.map((n) => (n.t < now ? { ...n, t: now, d: n.d - (now - n.t) } : n)).filter((n) => n.d >= 3);
    let notes: LineNote[];
    if (f.part === 'bass') {
      // the next chord isn't known yet: a moving bass leads back to this one's root
      const line = bassLine(chord, span, this.key!, null, v.lastBass, o, style, meter, 0);
      v.lastBass = line.last;
      notes = fromNow(line.notes);
    } else {
      const sounding = heard.filter((h) => h.held || (h.s < span.end && h.s + h.d > span.t)).map((h) => h.n);
      const recent: LineNote[] = heard.map((h) => ({ t: h.s, d: h.d, n: h.n, v: h.v }));
      const voicing = continuing && v.voicing ? v.voicing : voiceChord(chord, this.key!, o, sounding, v.voicing, rangeFor(recent, o));
      v.voicing = voicing;
      notes = fromNow(spanNotes(chord, voicing, span, segs, style, o, meter, 0));
    }
    if (!notes.length) return;
    const first = Math.min(...notes.map((n) => n.t));
    if (continuing && style === 0 && f.part === 'chords') {
      // a held chord going on into the next bar: its notes keep sounding, held to the new end
      const keep = new Set(notes.filter((n) => n.t === first && v!.sounding.has(n.n)).map((n) => n.n));
      this.queue = this.queue.filter((e) => !(e.f === f.id && v!.spanTokens.has(e.token) && !e.on && keep.has(e.n)));
      for (const n of notes) {
        if (n.t === first && keep.has(n.n)) this.queue.push({ at: n.t + n.d, on: false, n: n.n, v: 0, f: f.id, token: v.sounding.get(n.n)! });
        else this.schedule(f.id, v, n);
      }
      return;
    }
    // the chord before stops where this one comes in
    this.queue = this.queue.filter((e) => !(e.f === f.id && v!.spanTokens.has(e.token) && e.at >= first));
    for (const [n, token] of v.sounding) if (v.spanTokens.has(token)) this.queue.push({ at: first, on: false, n, v: 0, f: f.id, token });
    v.spanTokens.clear();
    for (const n of notes) this.schedule(f.id, v, n);
  }

  private schedule(f: string, v: Voice, n: LineNote): void {
    const token = ++this.token;
    v.spanTokens.add(token);
    this.queue.push({ at: n.t, on: true, n: n.n, v: n.v, f, token });
    this.queue.push({ at: n.t + n.d, on: false, n: n.n, v: 0, f, token });
  }

  /** Events due within this tick, each sent with its delay into it (strums): note-offs before note-ons at the same time */
  private fire(pos: number, send: Send): void {
    const due = this.queue.filter((e) => e.at < pos + 1 - 1e-6).sort((a, b) => a.at - b.at || Number(a.on) - Number(b.on));
    if (!due.length) return;
    const set = new Set(due);
    this.queue = this.queue.filter((e) => !set.has(e));
    for (const e of due) {
      const v = this.voices.get(e.f);
      if (!v) continue;
      const delay = Math.max(0, e.at - pos);
      if (e.on) {
        if (v.sounding.has(e.n)) send(v.out, false, e.n, 0, delay);
        send(v.out, true, e.n, e.v, delay);
        v.sounding.set(e.n, e.token);
      } else if (v.sounding.get(e.n) === e.token) {
        send(v.out, false, e.n, 0, delay);
        v.sounding.delete(e.n);
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
