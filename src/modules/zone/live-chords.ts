/**
 * Live chords: plays chords to a line as it is played, for every chords or bass zone that
 * follows it (one decision per line, so they agree). It can't know
 * a bar before it's played, so at each beat it guesses from what it has: notes held now,
 * the last notes before the beat, and what was played 1, 2 and 4 bars earlier (riffs
 * repeat). A moment after the beat it listens again and, if the note on the beat clashes
 * with its guess, changes chord (as an accompanist reacting). The key is found from the
 * last 8 bars and only changes when another one wins twice in a row.
 *
 * When the line rests for more than two bars, or plays one note over and over for two and a half,
 * the combo waits for it (`waitOf()`): it keeps the vamp
 * heard but plays it looser, as players do while the lead takes a breath: softer, a hit left out
 * here and there, now and then a bar laid back, other lengths and voicings, once in a while
 * another chord or a turnaround at a phrase's end. The first note played brings it back at once.
 *
 * Finish (`finish()`): from the next bar line the combo closes with a cadence (IV or ii, V7) and a
 * final tonic chord held out, or, ending open, a bar of IV and the V held out unresolved (a half
 * cadence, a question), then stays silent while the clock runs on, until Play on, Stop/Start
 * or Start over.
 *
 * Positions are song ticks (the arrangement's bar 1 = 0). The chords it played are kept per
 * beat (`log`), so a loop closed over them can keep what was heard.
 */
import { Meter, barTicks } from '../meter';
import { PPQ } from './seq-layer';
import { hashRoll } from '../prng';
import { MAX_LOOP_BARS } from './looper';
import {
  Chord,
  Key,
  HarmonyOptions,
  LineNote,
  Segment,
  analyse,
  phraseEndings,
  vocabulary,
  fitOf,
  chordTones,
  keyTones,
  freeNoise,
  transition,
  changeCost,
  segmentsOf,
  styleOf,
  rangeFor,
  voiceChord,
  spanNotes,
  hitsOf,
  bassLine,
  triadOn,
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

/** A note on or off, through the follower's `out`; `delay`: ticks into this tick (a strum's later notes), 0 = now */
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
/** How far back the line is listened to (bars), and that in ticks for the longest meter (32/4) */
export const HEARD_BARS = 9;
export const HEARD_TICKS = HEARD_BARS * 32 * PPQ;
/** The chords played are kept this long (bars): a loop closed over them (up to 64 bars) keeps them, the form looks 8 back */
const LOG_BARS = MAX_LOOP_BARS + 8;
/** Ticks after the beat when it listens again */
const LISTEN = 12; // an 8th: passing and approach notes are mostly let go by then

/** Waiting starts after this much rest (bars) and has grown fully WAIT_GROW bars later */
const WAIT_AFTER = 2;
const WAIT_GROW = 2;
/** One note played over and over (at least this often) for this long (bars) counts as resting too */
const REPEAT_AFTER = 2.5;
const REPEAT_NOTES = 4;

/** A number 0…1 for this waiting stretch (`salt`), bar and purpose `k`: the same each time it's asked */
function roll(salt: number, bar: number, k: number, c = 0): number {
  return hashRoll(salt, bar, k + 101, c);
}

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
  const scale = keyTones(key);
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

/**
 * The weight of notes that really clash with a chord: a half step over a chord tone, out of the
 * key, or a minor key's leading tone against a chord holding the tonic (D# over Em wants B)
 */
function clashOf(w: number[], c: Chord, key: Key): number {
  const tones = chordTones(c);
  const scale = keyTones(key);
  const leading = scale.length > 7 ? (key.tonic + 11) % 12 : -1;
  let x = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (!w[pc] || tones.includes(pc)) continue;
    const inKey = scale.includes(pc);
    const neighbour = tones.includes((pc + 11) % 12) || tones.includes((pc + 1) % 12);
    // in the key: a half step over a chord tone clashes (F over C-E); out of it: anything but a neighbour
    if (pc === leading ? tones.includes(key.tonic) : inKey ? tones.includes((pc + 11) % 12) : !neighbour) x += w[pc];
  }
  return x;
}

/** The V7 of a minor key, its leading tone in it (B7 in E minor) */
function isMinorDominant(c: Chord, key: Key): boolean {
  return c.quality === '7' && c.root === (key.tonic + 7) % 12 && keyTones(key).length > 7;
}

export class LiveChords {
  key: Key | null = null;
  chord: Chord | null = null;
  /** the chords played, per beat (song ticks of the beat → chord) */
  log = new Map<number, Chord>();
  private rival: { key: Key; count: number } | null = null;
  /** a key the line seems to have moved to by the beat checks of `newKey()`, and on how many running */
  private moved: { key: Key; count: number } | null = null;
  /** where the line began to be in the key `newKey()` moved to (song ticks): the bar checks don't look further back */
  private movedFrom = -Infinity;
  /** the key `newKey()` moved away from, when (song ticks), and its `keySince` / `movedFrom`: it comes back as quickly */
  private left: { key: Key; at: number; since: number | null; from: number } | null = null;
  /** where the key was found (song ticks) */
  private keySince: number | null = null;
  private queue: Event[] = [];
  private voices = new Map<string, Voice>();
  private token = 0;
  private check: { seg: Segment; at: number } | null = null;
  /** where the line sounded last (song ticks; it outlives what `heard` reaches back) */
  private lastSound: number | null = null;
  /** 0 = the line plays … 1 = it has rested a while, the combo waits for it */
  waiting = 0;
  /** where this waiting stretch began: what makes its variations its own */
  private waitSalt = 0;
  /** Finish: where the cadence starts, its dominant comes in, the final chord comes in and ends (song ticks) */
  private ending: { at: number; dominant: number; final: number; end: number; open: boolean } | null = null;
  /** the ending has been played: silent until Play on, Stop/Start or Start over */
  finished = false;
  /** waiting: the vamp's chord at the last beat (what plays may stray from it) */
  private vamp: Chord | null = null;

  /**
   * Called on every clock tick while running with the zones following the line (the first one's
   * settings choose the chords); true when the chord or key changed. `heard` gives the line as
   * played, asked for only on ticks that decide something. `ahead`: the line's notes still to
   * come (from this tick on, a bar and a beat ahead) when they are known (a take playing along),
   * else null: then each beat is decided on what it will play, not guessed
   */
  tick(pos: number, heard: () => HeardNote[], followers: Follower[], meter: Meter, send: Send, ahead?: () => HeardNote[] | null): boolean {
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
    // up to the cadence the chords go on as before (no bar left empty)
    if (this.finished || (this.ending && target >= this.ending.at)) {
      if (seg && this.ending) changed = this.cadence(seg, segs, pos, heard, o, followers, meter) || changed;
      this.fire(pos, send);
      if (this.ending && pos >= this.ending.end) {
        // done: whatever still sounds goes off, silent from here on
        for (const id of [...this.voices.keys()]) this.release(id, send);
        this.ending = null;
        this.finished = true;
        this.chord = null;
        changed = true;
      }
      return changed;
    }
    if (seg) changed = this.decide(seg, segs, pos, heard(), ahead?.() ?? null, o, followers, meter) || changed;
    if (this.check && pos >= this.check.at) {
      const c = this.check;
      this.check = null;
      changed = this.correct(c.seg, pos, heard(), o, followers, meter) || changed;
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
    this.moved = null;
    // song positions start over with the next run or arrangement
    this.movedFrom = -Infinity;
    this.left = null;
    this.lastSound = null;
    this.waiting = 0;
    this.vamp = null;
    this.ending = null;
    this.finished = false;
  }

  /**
   * Finish (`open`: on the V, unresolved): the cadence starts at the next bar line (the one after when it's less than a beat and a
   * half away, so the change can be decided in time), the final chord a bar later. Nothing heard yet
   * (no key): it just stops. Returns where the final chord comes in, or null when it stopped at once
   */
  finish(pos: number, meter: Meter, send: Send, open = false): number | null {
    if (this.ending) return this.ending.final;
    if (!this.key) {
      for (const id of [...this.voices.keys()]) this.release(id, send);
      this.finished = true;
      return null;
    }
    const bar = barTicks(meter);
    let at = Math.ceil((pos + 1) / bar) * bar;
    if (at - pos < PPQ * 1.5) at += bar;
    const segs = barSegments(at / bar, meter);
    const pre = Math.max(1, Math.floor(segs.length / 2));
    // ending open, the subdominant takes the whole bar and the V is the chord held out
    const dominant = open ? -1 : segs.length > 1 ? segs[pre].t : at + bar / 2;
    // the final chord rings a bar, at least four beats
    this.ending = { at, dominant, final: at + bar, end: at + bar + Math.max(bar, 4 * PPQ), open };
    this.check = null;
    this.waiting = 0;
    return at + bar;
  }

  /** Play on after Finish: the next beat decides as usual and every follower comes in there */
  playOn(): void {
    this.ending = null;
    this.finished = false;
    this.chord = null;
  }

  /** Where the ending's cadence starts (song ticks) and whether it ends open; null when none is coming */
  get endingAt(): { at: number; open: boolean } | null {
    return this.ending ? { at: this.ending.at, open: this.ending.open } : null;
  }

  /** Finishing (the cadence under way): 'closed' or 'open', else null */
  get finishing(): 'closed' | 'open' | null {
    return this.ending ? (this.ending.open ? 'open' : 'closed') : null;
  }

  /**
   * The ending's beats: the subdominant (ii with Jazz subs in a major key, else IV, iv in minor),
   * the dominant seventh, then the tonic held, as one strike (strummed if it strums) with the bass
   * on its root
   */
  private cadence(seg: Segment, segs: Segment[], now: number, heard: () => HeardNote[], o: HarmonyOptions, followers: Follower[], meter: Meter): boolean {
    const e = this.ending!;
    const key = this.key!;
    const major = triadOn(key, 0) === 'maj';
    const sub: Chord =
      o.subs && major
        ? { root: (key.tonic + 2) % 12, quality: 'min', degree: 1, kind: 'dia', prior: 0 }
        : { root: (key.tonic + 5) % 12, quality: major ? 'maj' : 'min', degree: 3, kind: 'dia', prior: 0 };
    const dom: Chord = { root: (key.tonic + 7) % 12, quality: '7', degree: 4, kind: 'sec', prior: 0 };
    const tonic: Chord = { root: key.tonic, quality: major ? 'maj' : 'min', degree: 0, kind: 'dia', prior: 0 };
    const bar = barTicks(meter);
    let chord: Chord;
    let span: { t: number; end: number };
    let next: number | null;
    let final = false;
    if (seg.t === e.at) {
      chord = sub;
      span = { t: e.at, end: e.open ? e.at + bar : e.dominant };
      next = dom.root;
    } else if (seg.t === e.dominant) {
      chord = dom;
      span = { t: e.dominant, end: e.at + bar };
      next = tonic.root;
    } else if (seg.t === e.final) {
      // ending open: the V (a plain major triad, also in minor) rings out, unresolved
      chord = e.open ? { root: dom.root, quality: 'maj', degree: 4, kind: 'dia', prior: 0 } : tonic;
      span = { t: e.final, end: e.end };
      next = null;
      final = true;
    } else return false;
    this.chord = chord;
    this.log.set(seg.t, chord);
    const played = heard();
    for (const f of followers) {
      // the final chord: one strike held out (the bass on the root), a little louder
      const fo: HarmonyOptions = final ? { ...f.o, rhythm: 0, length: 1, dynamics: 0, bassMove: 0, syncopation: 0, unfold: 0 } : f.o;
      this.play(f, chord, span, segs, now, played, meter, false, { o: fo, next, louder: final ? 10 : 0 });
    }
    return true;
  }

  /** Starting over: the key and the chords heard are forgotten too */
  reset(send: Send): void {
    this.stop(send);
    this.key = null;
    this.keySince = null;
    this.log.clear();
  }

  /** Panic: the synths were reset, nothing to send */
  forget(): void {
    this.voices.clear();
    this.queue = [];
    this.chord = null;
    this.check = null;
    this.lastSound = null;
    this.waiting = 0;
    this.vamp = null;
  }

  /** The log is in time order (beats are logged as they come; Start and arrangement switches clear it) */
  private trimLog(before: number): void {
    for (const t of this.log.keys()) {
      if (t >= before) break;
      this.log.delete(t);
    }
  }

  get name(): string {
    return this.chord ? chordName(this.chord) : '';
  }

  // ------------------------------------------------------------------ choosing

  private updateKey(seg: Segment, heard: HeardNote[], o: HarmonyOptions, meter: Meter): void {
    const bar = barTicks(meter);
    // after a move to another key, what came before it is the old key's
    const from = Math.max(seg.t - WINDOW_BARS * bar, this.movedFrom);
    const line: LineNote[] = heard
      .filter((h) => h.s >= from && h.s < seg.t)
      .map((h) => ({ t: h.s - from, d: Math.max(1, Math.min(h.d, seg.t - h.s)), n: h.n, v: h.v }));
    // a key needs a few notes and at least three pitch classes
    if (line.length < 4 || new Set(line.map((n) => n.n % 12)).size < 3) return;
    // the window's first note opens the line only when nothing was heard before it
    const begins = !heard.some((h) => h.s < from);
    const a = analyse(line, seg.t - from, meter, o.harmony, begins, true);
    const best = a.keys[0];
    const same = (x: Key, y: Key) => x.tonic === y.tonic && x.mode === y.mode;
    if (!this.key) {
      this.key = best;
      this.keySince = seg.t;
      return;
    }
    if (same(best, this.key)) {
      this.rival = null;
      return;
    }
    const current = a.keys.find((k) => same(k, this.key!));
    // a key heard for a few bars, with a phrase resting on its tonic or a riff coming back to it on the
    // 1s, holds on: the relative major or the fifth's key share most notes, and a phrase resting on
    // the fifth (a half cadence) looks like its key for a bar or two. One that never came to rest
    // (found from a tune's first bar, which often circles the fifth) gives way easily
    const tonic = this.key.tonic;
    // (a downbeat rushed by up to an 8th still starts its bar)
    const onOne = (n: LineNote) => n.t % bar <= 3 || n.t % bar >= bar - PPQ / 2;
    const ones = new Set(line.filter(onOne).map((n) => Math.round(n.t / bar)));
    const onTonic = new Set(line.filter((n) => n.n % 12 === tonic && onOne(n)).map((n) => Math.round(n.t / bar)));
    const cadenced = phraseEndings(line, seg.t - from, meter)[tonic] > 0 || (ones.size >= 2 && onTonic.size * 2 >= ones.size);
    const settled = this.keySince !== null && seg.t - this.keySince >= 4 * bar && cadenced;
    if (current && best.score - current.score < (settled ? 0.1 : 0.04)) {
      this.rival = null;
      return;
    }
    this.rival = this.rival && same(this.rival.key, best) ? { key: best, count: this.rival.count + 1 } : { key: best, count: 1 };
    if (this.rival.count >= 2) {
      this.key = best;
      this.keySince = seg.t;
      this.rival = null;
    }
  }

  /**
   * Playing in another key (C minor → A minor, C major): checked on every beat, so the chords follow
   * within a bar or two instead of waiting for the new key to fill the 8-bar window. It takes two
   * or more notes outside the key, each on a beat, a beat long or played twice (a slide, a blue note
   * or a passing note is one; chromatic neighbours don't count), and one key holding every note
   * since the bar the first of them came in (at least a bar back, at most two: a line mixing both
   * thirds, as blues does, has none), found on two beats running; one on the same tonic is
   * preferred when it is close. Coming back (an excursion of a bar or two) goes as quickly: for 8
   * bars after a move, once the notes since the last one outside the key it left (three or more,
   * over half a bar) fit it again, that key returns with all it had heard. The relative major and the fifth's key bring no notes outside the key: the bar
   * checks of `updateKey()` decide those
   */
  private newKey(seg: Segment, heard: HeardNote[], o: HarmonyOptions, meter: Meter): boolean {
    if (!this.key) return false;
    const bar = barTicks(meter);
    const scale = keyTones(this.key);
    if (this.left && seg.t - this.left.at > WINDOW_BARS * bar) this.left = null;
    // a chromatic neighbour or passing note (a half step from the notes either side: G Ab G, C C# D) only decorates
    const line0 = heard.filter((h) => h.s < seg.t).sort((a, b) => a.s - b.s);
    const decorates = (i: number) =>
      i > 0 && i < line0.length - 1 && Math.abs(line0[i].n - line0[i - 1].n) === 1 && Math.abs(line0[i + 1].n - line0[i].n) === 1;
    const window = line0.filter((h) => h.s >= seg.t - 2 * bar);
    const recent = line0.filter((h, i) => h.s >= seg.t - 2 * bar && !decorates(i));
    const len = (h: HeardNote) => Math.min(h.d, seg.t - h.s);
    const stressed = (h: HeardNote) => h.s % PPQ <= 3 || h.s % PPQ >= PPQ - 3 || len(h) >= PPQ - 2;
    const outside = recent.filter((h) => !scale.includes(h.n % 12));
    const strong = new Set(outside.filter((h) => stressed(h) || outside.some((x) => x !== h && x.n % 12 === h.n % 12)).map((h) => h.n % 12));
    if (strong.size < 2) return (this.moved = null), false;
    const same = (x: Key, y: Key) => x.tonic === y.tonic && x.mode === y.mode;
    let best: Key | undefined;
    let from = 0;
    // back to the key it left: the notes since the last one outside it (three or more, over half a bar) fit it again
    if (this.left) {
      const home = keyTones(this.left.key);
      let i = recent.length;
      while (i > 0 && home.includes(recent[i - 1].n % 12)) i--;
      const since = recent.slice(i);
      if (since.length >= 3 && seg.t - since[0].s >= bar / 2) best = this.left.key;
    }
    // from the bar the first of them came in, or from that note when the old key's notes came before it in its bar
    const first = Math.min(...outside.map((h) => h.s));
    for (const start of best ? [] : [first - (first % bar), first]) {
      from = Math.min(seg.t - bar, start);
      const line: LineNote[] = window
        .filter((h) => h.s >= from)
        .map((h) => ({ t: h.s - from, d: Math.max(1, len(h)), n: h.n, v: h.v }));
      if (line.length < 4 || new Set(line.map((n) => n.n % 12)).size < 3) break;
      const held = recent.filter((h) => h.s >= from);
      const fitting = analyse(line, seg.t - from, meter, o.harmony, false, true).keys.filter((k) => {
        const tones = keyTones(k);
        return held.every((h) => tones.includes(h.n % 12));
      });
      // a bar or two says little about which note is home: one close behind on the same tonic as
      // before wins (C major → C minor, or blues licks over C, rather than E♭ major)
      const home = fitting.find((k) => k.tonic === this.key!.tonic);
      best = home && fitting[0].score - home.score < 0.06 ? home : fitting[0];
      if (best) break;
    }
    if (!best || same(best, this.key)) return (this.moved = null), false;
    this.moved = this.moved && same(this.moved.key, best) ? { key: best, count: this.moved.count + 1 } : { key: best, count: 1 };
    if (this.moved.count < 2) return false;
    const back = this.left && same(best, this.left.key) ? this.left : null;
    // moving on from a key it only moved to keeps the way home
    this.left = back ? null : this.left ?? { key: this.key, at: seg.t, since: this.keySince, from: this.movedFrom };
    this.key = best;
    this.keySince = back ? back.since : seg.t;
    this.movedFrom = back ? back.from : from;
    this.rival = null;
    this.moved = null;
    return true;
  }

  /**
   * The line's pitch classes for a beat, as far as they can be known now; `until` (the notes to
   * come are known): weighed on to there, without the echoes of earlier bars
   */
  private weights(seg: Segment, now: number, heard: HeardNote[], meter: Meter, onBeat: boolean, until = 0): number[] {
    const w = new Array(12).fill(0);
    const bar = barTicks(meter);
    const add = (h: HeardNote, from: number, to: number, k: number) => {
      const o = Math.min(to, h.s + h.d) - Math.max(from, h.s);
      if (o > 0) w[h.n % 12] += (Math.max(o, PPQ / 4) / PPQ) * k * (0.6 + 0.4 * (h.v / 127));
    };
    for (const h of heard) {
      // held now: it sounds into the beat (a note known to come: as long as it is)
      if (h.held || h.s + h.d > seg.t) add(h.held ? { ...h, d: Math.max(h.d, seg.end - h.s) } : h, seg.t, seg.end, 1);
      // what led into the beat
      else if (h.s >= seg.t - PPQ / 2 && h.s < seg.t) w[h.n % 12] += 0.4;
      // played on the beat (listening again an 8th after it), by its length: a 16th counts half, an 8th or more fully
      if (onBeat && h.s >= seg.t - 3 && h.s <= now) w[h.n % 12] += 2 * Math.min(1, (h.held ? now - h.s : h.d) / (PPQ / 2));
      // known to come: what plays after the beat up to the half bar or the bar's end counts too, and
      // what was played before needn't stand in for it
      if (until > 0) {
        if (until > seg.end) add(h, seg.end, until, 0.6);
        continue;
      }
      // what was played here 1, 2, 4 and 8 bars ago (riffs and phrases repeat)
      [1, 2, 4, 8].forEach((bars, i) => add(h, seg.t - bars * bar, seg.end - bars * bar, [0.5, 0.3, 0.3, 0.4][i]));
    }
    // a note outside the key counts half, unless held a beat or more or played again within the bar:
    // a passing or approach note doesn't take the chord along, a note that stays does
    if (this.key) {
      const scale = keyTones(this.key);
      for (let pc = 0; pc < 12; pc++) {
        if (!w[pc] || scale.includes(pc)) continue;
        const recent = heard.filter((h) => h.n % 12 === pc && h.s >= seg.t - bar && h.s <= now);
        const stays = recent.length >= 2 || recent.some((h) => (h.held ? now - h.s : h.d) >= PPQ);
        if (!stays) w[pc] *= 0.5;
      }
    }
    return w;
  }

  private scores(seg: Segment, w: number[], o: HarmonyOptions, meter: Meter, waiting = false, prev = this.chord): { chord: Chord; score: number }[] {
    const key = this.key!;
    const h = Math.max(0, Math.min(1, o.harmony));
    const len = (seg.end - seg.t) / PPQ;
    return vocabulary(key, h, !!o.blues, !!o.subs).map((c) => {
      const calm = calmOf(o);
      let x = liveFit(w, c, key) + 0.25 * c.prior * len;
      if (prev) {
        const same = prev.root === c.root && prev.quality === c.quality;
        x += same ? 0.15 + 0.5 * calm : transition(prev, c, key, h, !!o.subs) - changeCost(seg, o.changes) + (seg.beat === 0 ? 0.25 * (1 - h) : 0);
      } else if (c.root === key.tonic && c.degree === 0) x += 0.5;
      // a chord from outside the key (a secondary dominant, borrowed) needs clearer reasons live;
      // the dominant of a minor key is its own (harmonic minor), not from outside
      if ((c.kind === 'sec' && !isMinorDominant(c, key)) || c.kind === 'bor' || c.kind === 'out') x -= 0.25 + 0.4 * calm;
      // sus and fourths are the modal end's colour: towards the circle of fifths they need reasons too
      else if (c.kind === 'mod') x -= (0.25 + 0.4 * calm) * (1 - h);
      if (o.seed) x += (hashRoll(o.seed, seg.bar, c.root, QUALITY_INDEX[c.quality]) - 0.5) * 1.2 * len;
      x += freeNoise(o, seg, c) * len;
      // the form: what was played here 4 and 8 bars ago
      for (const [bars, k] of [[4, 0.3], [8, 0.5]]) {
        const then = this.log.get(seg.t - bars * barTicks(meter));
        if (then && then.root === c.root && then.quality === c.quality) x += k;
      }
      if (waiting) x += this.waitScore(seg, c, len);
      return { chord: c, score: x };
    });
  }

  /**
   * How far the combo waits for the line at this beat: 0 while it plays (a note held, or one
   * sounding within the last WAIT_AFTER bars, its loop and sequence too), growing after that much rest.
   * Notes known to come (a take read ahead) within the bar end the wait
   */
  private waitOf(seg: Segment, played: HeardNote[], coming: HeardNote[] | null, meter: Meter, o: HarmonyOptions): number {
    const bar = barTicks(meter);
    for (const h of played) {
      const end = h.held ? seg.t : h.s + h.d;
      if (this.lastSound === null || end > this.lastSound) this.lastSound = end;
    }
    // When you rest: Play on (lastSound is kept, so switching Wait on mid-rest waits at once)
    if (o.wait === false) return 0;
    const grow = (bars: number, after: number) => (bars < after ? 0 : Math.min(1, 0.65 + (0.35 * (bars - after)) / WAIT_GROW));
    const repeat = this.repeatBars(seg, played, coming, bar);
    const waitRepeat = grow(repeat, REPEAT_AFTER);
    if (coming?.some((h) => h.s < seg.t + bar)) return waitRepeat;
    if (this.lastSound === null) return 0;
    return Math.max(waitRepeat, grow((seg.t - this.lastSound) / bar, WAIT_AFTER));
  }

  /**
   * How long (bars, up to this beat) the line has been playing one note over and over (octaves
   * too, at least REPEAT_NOTES times): a lead marking time, the combo waits for more as if it
   * rested. 0 when its latest notes aren't that, or notes known to come (a take read ahead)
   * within the bar leave the note
   */
  private repeatBars(seg: Segment, played: HeardNote[], coming: HeardNote[] | null, bar: number): number {
    const notes = played.filter((h) => h.s <= seg.t).sort((a, b) => b.s - a.s);
    if (!notes.length) return 0;
    const pc = notes[0].n % 12;
    if (coming?.some((h) => h.s < seg.t + bar && h.n % 12 !== pc)) return 0;
    // the note has to go on: the latest one sounding still or within a beat
    const last = notes[0].held ? seg.t : notes[0].s + notes[0].d;
    if (seg.t - last > PPQ) return 0;
    let from = notes[0].s;
    let count = 0;
    for (const h of notes) {
      if (h.n % 12 !== pc) break;
      from = h.s;
      count++;
    }
    return count >= REPEAT_NOTES ? (seg.t - from) / bar : 0;
  }

  /**
   * Waiting: once in a while (a 2-bar stretch in three, about, when fully waiting) another chord
   * than the vamp's, decided per bar, and at a 4-bar phrase's end now and then the dominant, a
   * turnaround handing back to the lead
   */
  private waitScore(seg: Segment, c: Chord, len: number): number {
    const w = this.waiting;
    if (!w || !this.key) return 0;
    let x = 0;
    if (roll(this.waitSalt, seg.bar >> 1, 1) < 0.5 * w) x += (roll(this.waitSalt, seg.bar, 2, c.root * 16 + QUALITY_INDEX[c.quality]) - 0.5) * 2.6 * w * len;
    const dominant = c.root === (this.key.tonic + 7) % 12 && (c.quality === 'maj' || c.quality === '7');
    if (dominant && seg.bar % 4 === 3 && seg.beat >= seg.beats / 2 && roll(this.waitSalt, seg.bar, 3) < 0.7 * w) x += 1.6 * w;
    return x;
  }

  private decide(seg: Segment, segs: Segment[], now: number, played: HeardNote[], coming: HeardNote[] | null, o: HarmonyOptions, followers: Follower[], meter: Meter): boolean {
    const keyBefore = this.key;
    // the notes to come known: the beat is weighed as if listened to after it (and isn't checked again)
    const heard = coming ? [...played, ...coming] : played;
    if (!this.newKey(seg, played, o, meter) && (seg.beat === 0 || !this.key)) this.updateKey(seg, played, o, meter);
    // no key yet: the coming bar may tell it (the chords come in with the line's first bar)
    if (!this.key && coming) this.updateKey({ ...seg, t: seg.t + barTicks(meter) }, heard, o, meter);
    if (!this.key) return false;
    const waited = this.waiting;
    this.waiting = this.waitOf(seg, played, coming, meter, o);
    if (this.waiting && !waited) this.waitSalt = (o.seed * 7919 + Math.round(this.lastSound ?? 0)) | 0;
    // the line is back: what plays now goes on as it did before the wait
    const back = waited > 0 && !this.waiting;
    const until = seg.beats % 2 === 0 && seg.beat < seg.beats / 2 ? segs[seg.beats / 2].t : segs[segs.length - 1].end;
    const w = coming ? this.weights(seg, seg.t + LISTEN, heard, meter, true, until) : this.weights(seg, now, heard, meter, false);
    // waiting: the vamp goes on from its own last chord and is what's logged (the form, a loop kept
    // from it); what's played may stray from it
    const ranked = this.scores(seg, w, o, meter, false, this.waiting && waited ? this.vamp : this.chord).sort((a, b) => b.score - a.score);
    const vamp = ranked[0].chord;
    this.vamp = vamp;
    const best = this.waiting ? this.scores(seg, w, o, meter, true).sort((a, b) => b.score - a.score)[0].chord : vamp;
    const prev = this.chord;
    const same = prev && prev.root === best.root && prev.quality === best.quality;
    this.log.set(seg.t, this.waiting ? vamp : same ? prev! : best);
    this.trimLog(seg.t - LOG_BARS * barTicks(meter));
    this.check = coming ? null : { seg, at: seg.t + LISTEN };
    const barEnd = segs[segs.length - 1].end;
    if (same && seg.beat !== 0 && !back) {
      // the chord goes on; a follower without a voice (just switched on, or its zone replaced by undo) comes in now
      for (const f of followers) if (!this.voices.has(f.id)) this.play(f, prev!, { t: seg.t, end: barEnd }, segs, now, heard, meter, false);
      return this.key !== keyBefore;
    }
    this.chord = same ? prev : best;
    for (const f of followers) this.play(f, this.chord!, { t: seg.t, end: barEnd }, segs, now, heard, meter, !!same);
    return !same || this.key !== keyBefore;
  }

  /** Just after the beat: the note played on it decides between the guess and a better chord */
  private correct(seg: Segment, now: number, heard: HeardNote[], o: HarmonyOptions, followers: Follower[], meter: Meter): boolean {
    if (!this.key || !this.chord) return false;
    const w = this.weights(seg, now, heard, meter, true);
    const ranked = this.scores(seg, w, o, meter).sort((a, b) => b.score - a.score);
    const cur = this.chord;
    const best = ranked[0];
    if (best.chord.root === cur.root && best.chord.quality === cur.quality) return false;
    const mine = ranked.find((r) => r.chord.root === cur.root && r.chord.quality === cur.quality);
    // only when the guess really clashes with a note held on the beat, or two notes struck together on it
    // (a double stop, a chord) both miss it; and the better chord is clearly better
    const struck = this.struckOn(seg, now, heard);
    const missed = struck.length >= 2 && !struck.some((pc) => chordTones(cur).includes(pc)) && struck.every((pc) => chordTones(best.chord).includes(pc));
    if ((!missed && clashOf(w, cur, this.key) < 1.5) || (mine && best.score - mine.score < 1.2 + 0.8 * calmOf(o))) return false;
    this.chord = best.chord;
    this.vamp = best.chord;
    this.log.set(seg.t, best.chord);
    const segs = barSegments(seg.bar, meter);
    for (const f of followers) this.play(f, best.chord, { t: seg.t, end: segs[segs.length - 1].end }, segs, now, heard, meter, false);
    return true;
  }

  /** The pitch classes struck together on the beat (within a few ticks of each other) */
  private struckOn(seg: Segment, now: number, heard: HeardNote[]): number[] {
    const on = heard.filter((h) => h.s >= seg.t - 3 && h.s <= now).sort((a, b) => a.s - b.s);
    if (!on.length) return [];
    return [...new Set(on.filter((h) => h.s - on[0].s <= 3).map((h) => h.n % 12))];
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
    continuing: boolean,
    as: { o?: HarmonyOptions; next?: number | null; louder?: number } = {}
  ): void {
    let v = this.voices.get(f.id);
    if (!v) {
      v = { out: f.out, voicing: null, lastBass: null, sounding: new Map(), spanTokens: new Set() };
      this.voices.set(f.id, v);
    }
    const bar = segs[0].bar;
    const w = this.waiting;
    const o = as.o ?? (w ? this.looser(f, bar) : f.o);
    const style = styleOf(o);
    // a chord coming in late (a correction): what it would have played up to now comes in now
    const fromNow = (ns: LineNote[]) => ns.map((n) => (n.t < now ? { ...n, t: now, d: n.d - (now - n.t) } : n)).filter((n) => n.d >= 3);
    let notes: LineNote[];
    if (f.part === 'bass') {
      // the next chord isn't known yet: a moving bass leads back to this one's root
      const line = bassLine(chord, span, this.key!, as.next ?? null, v.lastBass, o, style, meter, 0);
      v.lastBass = line.last;
      notes = fromNow(line.notes);
    } else {
      const sounding = heard.filter((h) => h.held || (h.s < span.end && h.s + h.d > span.t)).map((h) => h.n);
      const recent: LineNote[] = heard.map((h) => ({ t: h.s, d: h.d, n: h.n, v: h.v }));
      // waiting: now and then the same chord voiced anew on a bar's 1
      const revoice = w > 0 && span.t === segs[0].t && roll(this.waitSalt, bar, 4) < 0.8 * w;
      const voicing = continuing && v.voicing && !revoice ? v.voicing : voiceChord(chord, this.key!, o, sounding, v.voicing, rangeFor(recent, o));
      v.voicing = voicing;
      notes = fromNow(spanNotes(chord, voicing, span, segs, style, o, meter, 0));
    }
    if (as.louder) notes = notes.map((n) => ({ ...n, v: Math.min(127, n.v + as.louder!) }));
    if (w && !as.o) notes = this.thinned(f, notes, span, segs, bar, meter, style, o.seed);
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
    // its notes still to come before then (a strum's later voices, a push) end there too, or they'd hang
    for (const e of [...this.queue]) if (e.on && e.f === f.id && v.spanTokens.has(e.token)) this.queue.push({ at: Math.max(first, e.at + 1), on: false, n: e.n, v: 0, f: f.id, token: e.token });
    v.spanTokens.clear();
    for (const n of notes) this.schedule(f.id, v, n);
  }

  /**
   * A follower's settings for a bar while waiting: other lengths, accents, roll and colour each
   * bar (within reach of its own), the bass moving a little more or less
   */
  private looser(f: Follower, bar: number): HarmonyOptions {
    const w = this.waiting;
    const o = f.o;
    const k = f.part === 'bass' ? 20 : 10;
    const r = (i: number) => (roll(this.waitSalt, bar, k + i) - 0.5) * 2 * w;
    const c01 = (x: number) => Math.max(0, Math.min(1, x));
    if (f.part === 'bass') return { ...o, bassMove: c01((o.bassMove ?? 0) + 0.6 * r(0)), length: c01((o.length ?? 0.5) + 0.45 * r(1)), syncopation: c01((o.syncopation ?? 0) + 0.45 * r(2)), vary: c01((o.vary ?? 0) + 0.5 * w) };
    return {
      ...o,
      length: c01((o.length ?? 0.5) + 0.65 * r(0)),
      dynamics: c01((o.dynamics ?? 0) + 0.6 * r(1)),
      unfold: c01((o.unfold ?? 0) + 0.5 * Math.abs(r(2))),
      colour: c01(o.colour + 0.45 * r(3)),
      register: (o.register ?? 0) + Math.round(4 * r(5)),
      accents: Math.max(-1, Math.min(1, (o.accents ?? 0) + 0.65 * r(4))),
      vary: c01((o.vary ?? 0) + 0.7 * w)
    };
  }

  /**
   * Waiting: the chords play softer and leave hits out (never the chord's first, so a change is
   * heard), now and then a bar's second half laid back; the bass keeps time, a little softer
   */
  private thinned(f: Follower, notes: LineNote[], span: { t: number; end: number }, segs: Segment[], bar: number, meter: Meter, style: number, seed: number): LineNote[] {
    const w = this.waiting;
    const soft = (n: LineNote, k: number) => ({ ...n, v: Math.max(30, Math.round(n.v * (1 - k * w))) });
    if (f.part === 'bass') {
      // the bass keeps time on the chord's first note, the others now and then left out
      const first = Math.min(...notes.map((n) => n.t));
      return notes.filter((n, i) => n.t === first || roll(this.waitSalt, bar, 7, i) >= 0.25 * w).map((n) => soft(n, 0.2));
    }
    // held pads: only softer
    if (style === 0) return notes.map((n) => soft(n, 0.35));
    // each note belongs to the rhythm's hit it came with (a rolled or strummed voice a few ticks
    // after it, a tension tone coming in later with the build-up): a hit left out goes whole
    const hits = hitsOf(style, span, meter, segs, seed).map((h) => span.t + h.t);
    const hitOf = (n: LineNote) => {
      let i = 0;
      while (i + 1 < hits.length && hits[i + 1] <= n.t + 0.5) i++;
      return i;
    };
    const barLen = barTicks(meter);
    const half = span.t - (span.t % barLen) + barLen / 2;
    const layBack = roll(this.waitSalt, bar, 5) < 0.45 * w;
    return notes
      .filter((n) => {
        const i = hitOf(n);
        // the chord's first hit always sounds: a change is heard
        if (i === 0) return true;
        if (layBack && hits[i] >= half) return false;
        return roll(this.waitSalt, bar, 6, i) >= 0.6 * w;
      })
      .map((n) => soft(n, 0.35));
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
