import { SeriesBuilder } from './note-curve';

/**
 * Channel gestures of a take or loop: the zone channel's controls as played (sustain, mod
 * wheel, pitch bend, channel aftertouch and the CCs the zone passes on), one series per
 * control, apart from the notes. A series is flat `[t, value, t, value, …]`, t ascending
 * in the take's ticks (a loop's: from its start, negative before it, as its spare notes).
 *
 * Keys: `b` pitch bend (14 bit, 8192 = centre), `a` channel aftertouch, `c<n>` CC n
 * (`c64` sustain, `c1` mod wheel). Pedals and switches (`c64`–`c69`) hold their value
 * until the next point; the others run in straight lines between points (thinned).
 */
export type GesturesJSON = Record<string, number[]>;

export const BEND = 'b';
export const PRESSURE = 'a';
export const SUSTAIN = 'c64';
export const MOD = 'c1';

/** Points one take or loop from a file keeps (an hour of wheel playing is a few 10 000) */
export const MAX_FILE_GESTURE_POINTS = 1000000;
/** A loop's gestures at most (loops are in the scene and every undo step); thinned harder beyond */
export const LOOP_GESTURE_BUDGET = 20000;
/** Ticks are kept to 1/8 */
const STEPS = 8;

const KEY = /^(b|a|c(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))$/;

export function isGestureKey(key: string): boolean {
  return KEY.test(key);
}

/** Held until the next point (pedals and switches, CC 64–69), not a line between points */
export function isStepped(key: string): boolean {
  if (key[0] !== 'c') return false;
  const cc = Number(key.slice(1));
  return cc >= 64 && cc <= 69;
}

/** Highest value of a control */
export function maxValue(key: string): number {
  return key === BEND ? 16383 : 127;
}

/** Where a control rests: bend centred, the others at 0 */
export function restValue(key: string): number {
  return key === BEND ? 8192 : 0;
}

/** The key of a channel message's control, null when it isn't a gesture */
export function gestureOf(status: number, d1: number): string | null {
  const type = status & 0xf0;
  if (type === 0xe0) return BEND;
  if (type === 0xd0) return PRESSURE;
  if (type === 0xb0 && d1 < 120) return 'c' + d1; // 120–127: channel mode messages
  return null;
}

/** Thinning tolerance (swing door: up to about twice that off): bend 8 of 16384, the others half a step */
function tolerance(key: string): number {
  return key === BEND ? 8 : 0.5;
}

const round = (t: number): number => Math.round(t * STEPS) / STEPS;

/** Index of the last point at or before t, -1 when none */
function lastAtOrBefore(series: number[], t: number): number {
  let lo = 0;
  let hi = series.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[2 * mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Index (of the flat series) of the first point at or after t */
export function firstPointAtOrAfter(series: number[], t: number): number {
  let lo = 0;
  let hi = series.length / 2;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[2 * mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return 2 * lo;
}

/** A control's value at t (undefined before its first point) */
export function valueAt(key: string, series: number[], t: number): number | undefined {
  const i = lastAtOrBefore(series, t);
  if (i < 0) return undefined;
  const v = series[2 * i + 1];
  if (isStepped(key) || 2 * i + 2 >= series.length) return v;
  const t0 = series[2 * i];
  const t1 = series[2 * i + 2];
  return t1 > t0 ? v + ((series[2 * i + 3] - v) * (t - t0)) / (t1 - t0) : v;
}

/** The value sent for a control: whole, in range */
export function sendValue(key: string, v: number): number {
  return Math.max(0, Math.min(maxValue(key), Math.round(v)));
}

export function countGesturePoints(g: GesturesJSON | undefined): number {
  if (!g) return 0;
  let n = 0;
  for (const k in g) n += g[k].length / 2;
  return n;
}

/** Without controls that only rest (a series of one point at rest says nothing) */
function tidy(g: GesturesJSON): GesturesJSON | undefined {
  const out: GesturesJSON = {};
  let any = false;
  for (const k in g) {
    const s = g[k];
    if (s.length === 0 || (s.length === 2 && s[1] === restValue(k))) continue;
    out[k] = s;
    any = true;
  }
  return any ? out : undefined;
}

/**
 * The part from `from` to `to` (exclusive), times from `origin`: what a control held when
 * the part begins is its first point there, so a pedal held down into it stays down
 */
export function cutGestures(g: GesturesJSON | undefined, from: number, to: number, origin = from): GesturesJSON | undefined {
  if (!g) return undefined;
  const out: GesturesJSON = {};
  for (const k in g) {
    const s = g[k];
    const part: number[] = [];
    const before = valueAt(k, s, from);
    for (let i = 0; i + 1 < s.length; i += 2) {
      const t = s[i];
      if (t < from || t >= to) continue;
      if (part.length === 0 && t > from && before !== undefined) part.push(round(from - origin), before);
      part.push(round(t - origin), s[i + 1]);
    }
    if (part.length === 0 && before !== undefined) part.push(round(from - origin), before);
    // a line going on past the end ends there with its value, so it keeps its slope
    if (!isStepped(k) && part.length > 0 && isFinite(to) && s.length >= 2 && s[s.length - 2] >= to) {
      const end = valueAt(k, s, to);
      if (end !== undefined) part.push(round(to - origin), end);
    }
    if (part.length > 0) out[k] = part;
  }
  return tidy(out);
}

/** Moved by `by` ticks */
export function shiftGestures(g: GesturesJSON | undefined, by: number): GesturesJSON | undefined {
  if (!g) return undefined;
  const out: GesturesJSON = {};
  for (const k in g) out[k] = g[k].map((v, i) => (i % 2 === 0 ? round(v + by) : v));
  return out;
}

/**
 * Points in order, a moment's last value winning; repeats dropped where they say nothing
 * (stepped: every repeat; lines: the middle of three equal values, the ends of a plateau stay)
 */
function normalize(key: string, points: [number, number][]): number[] {
  points.sort((a, b) => a[0] - b[0]);
  const byTime: [number, number][] = [];
  for (const p of points) {
    const last = byTime[byTime.length - 1];
    if (last && last[0] === p[0]) last[1] = p[1];
    else byTime.push([p[0], p[1]]);
  }
  const stepped = isStepped(key);
  const out: number[] = [];
  byTime.forEach(([t, v]) => {
    const n = out.length;
    const prev = n > 0 ? out[n - 1] : undefined;
    if (stepped && prev === v) return;
    if (!stepped && prev === v && n >= 4 && out[n - 3] === v) {
      out[n - 2] = t; // the plateau goes on: its end moves
      return;
    }
    out.push(t, v);
  });
  return out;
}

/** A stepped series of what's played along: values over `[a, b)` (in the loop's ticks) */
export interface GesturePart {
  series: number[];
  a: number;
  b: number;
}

/**
 * Pedals overdubbed: in `[0, len)` the control is down as far as the loop's or any part's
 * (the highest value); the loop's points outside its bars stay
 */
export function mergeHighest(key: string, loop: number[] | undefined, parts: GesturePart[], len: number): number[] {
  const base = loop ?? [];
  const at = new Set<number>([0]);
  for (let i = 0; i < base.length; i += 2) if (base[i] >= 0 && base[i] < len) at.add(base[i]);
  for (const p of parts) {
    at.add(Math.max(0, p.a));
    if (p.b < len) at.add(p.b);
    for (let i = 0; i < p.series.length; i += 2) if (p.series[i] >= p.a && p.series[i] < p.b) at.add(p.series[i]);
  }
  const points: [number, number][] = [];
  for (let i = 0; i < base.length; i += 2) if (base[i] < 0 || base[i] >= len) points.push([base[i], base[i + 1]]);
  for (const t of at) {
    let v = valueAt(key, base, t) ?? 0;
    for (const p of parts) if (t >= p.a && t < p.b) v = Math.max(v, valueAt(key, p.series, t) ?? 0);
    points.push([t, v]);
  }
  return normalize(key, points);
}

/**
 * A wheel moved during an overdub (touch automation): from `a` to `b` (its first and last
 * move there) the part's points take the place of the loop's; before and after, the loop's
 * values go on as they were
 */
export function replaceSpan(key: string, loop: number[] | undefined, part: number[], a: number, b: number): number[] {
  const base = loop ?? [];
  const gap = 1 / STEPS;
  const points: [number, number][] = [];
  for (let i = 0; i < base.length; i += 2) if (base[i] < a - gap || base[i] > b + gap) points.push([base[i], base[i + 1]]);
  const before = valueAt(key, base, a - gap);
  if (before !== undefined) points.push([round(a - gap), before]);
  for (let i = 0; i < part.length; i += 2) if (part[i] >= a && part[i] <= b) points.push([part[i], part[i + 1]]);
  const after = valueAt(key, base, b + gap) ?? restValue(key);
  points.push([round(b + gap), after]);
  return normalize(key, points);
}

/** A series thinned with `factor` times the tolerance (stepped ones only lose repeats) */
export function thinSeries(key: string, series: number[], factor = 1): number[] {
  if (isStepped(key) || series.length <= 4) return series;
  const b = new SeriesBuilder(tolerance(key) * factor);
  for (let i = 0; i + 1 < series.length; i += 2) b.add(series[i], series[i + 1]);
  // back from the builder's steps between points to times
  const steps = b.series();
  const out: number[] = [];
  let t = 0;
  for (let i = 0; i + 1 < steps.length; i += 2) {
    t = i === 0 ? steps[0] : t + steps[i];
    out.push(round(t), steps[i + 1]);
  }
  return out;
}

/** Gestures with more points than the budget are thinned harder (doubling the tolerances) */
export function fitGestures(g: GesturesJSON | undefined, budget = LOOP_GESTURE_BUDGET): GesturesJSON | undefined {
  if (!g || countGesturePoints(g) <= budget) return g;
  let out = g;
  for (let factor = 2; factor <= 256 && countGesturePoints(out) > budget; factor *= 2) {
    out = {};
    for (const k in g) out[k] = thinSeries(k, g[k], factor);
  }
  return out;
}

/**
 * From a file or undo snapshot (untrusted): known controls, finite times within `lo`…`hi`,
 * whole values in range, in order, at most `budget` points (thinned beyond, cut past 4×)
 */
export function sanitizeGestures(raw: unknown, lo: number, hi: number, budget = MAX_FILE_GESTURE_POINTS): GesturesJSON | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: GesturesJSON = {};
  let left = 4 * budget;
  for (const [k, s] of Object.entries(raw as Record<string, unknown>)) {
    if (!isGestureKey(k) || !Array.isArray(s) || left <= 0) continue;
    const points: [number, number][] = [];
    for (let i = 0; i + 1 < s.length && points.length < left; i += 2) {
      const t = Number(s[i]);
      const v = Math.round(Number(s[i + 1]));
      if (!isFinite(t) || t < lo || t >= hi || !(v >= 0 && v <= maxValue(k))) continue;
      points.push([round(t), v]);
    }
    const series = normalize(k, points);
    left -= series.length / 2;
    if (series.length > 0) out[k] = series;
  }
  return fitGestures(tidy(out), budget);
}

/**
 * Records a zone's channel gestures as they come in (ticks): stepped controls keep every
 * change, the others are thinned on the way (swing door, as MPE curves). What a control
 * held when recording (re)started is stamped as its first point (`heldAt`), so a move can
 * be told from a value that was only held.
 */
export class GestureRecorder {
  private builders = new Map<string, { b: SeriesBuilder | null; raw: number[] }>();
  private last = new Map<string, number>();
  private held = new Map<string, number>();
  /** The earliest point kept */
  start = Infinity;

  add(key: string, t: number, v: number): void {
    if (this.last.get(key) === v) return;
    this.last.set(key, v);
    this.put(key, t, v);
  }

  private put(key: string, t: number, v: number): void {
    let entry = this.builders.get(key);
    if (!entry) {
      entry = { b: isStepped(key) ? null : new SeriesBuilder(tolerance(key)), raw: [] };
      this.builders.set(key, entry);
    }
    if (entry.b) entry.b.add(t, v);
    else entry.raw.push(round(t), v);
    this.start = Math.min(this.start, t);
  }

  /** Where a control's held value was stamped (-Infinity: it has none, every point is a move) */
  heldAt(key: string): number {
    return this.held.get(key) ?? -Infinity;
  }

  /** What was recorded so far */
  gestures(): GesturesJSON | undefined {
    const out: GesturesJSON = {};
    this.builders.forEach((e, k) => {
      if (!e.b) {
        out[k] = normalize(k, pairs(e.raw));
        return;
      }
      const steps = e.b.series();
      const s: number[] = [];
      let t = 0;
      for (let i = 0; i + 1 < steps.length; i += 2) {
        t = i === 0 ? steps[0] : t + steps[i];
        s.push(round(t), steps[i + 1]);
      }
      out[k] = s;
    });
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Forget points before t: what a control held there stays, as its first point */
  prune(t: number): void {
    const g = cutGestures(this.gestures(), t, Infinity, 0) ?? {};
    this.builders.clear();
    this.held.clear();
    this.start = Infinity;
    for (const k in g) {
      const s = g[k];
      for (let i = 0; i < s.length; i += 2) this.put(k, s[i], s[i + 1]);
      // a first point at t is the value held there; a later one is a move
      if (s[0] <= t) this.held.set(k, s[0]);
    }
  }

  /** Recording starts over at t (a new section, Start): values held then are its first points */
  restart(t: number, values: Map<string, number> = this.last): void {
    const held = new Map(values);
    this.builders.clear();
    this.held.clear();
    this.last.clear();
    this.start = Infinity;
    held.forEach((v, k) => {
      this.last.set(k, v);
      if (v === restValue(k)) return;
      this.put(k, t, v);
      this.held.set(k, t);
    });
  }
}

function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/** Where a control springs back to when let go (undefined: a fader or pad stays where it is) */
export function springsBackTo(key: string): number | undefined {
  if (key === BEND) return 8192;
  if (key === PRESSURE || key === MOD || isStepped(key)) return 0;
  return undefined;
}

/**
 * What goes out on the zone channel for each control when you and the zone's loop both
 * play it: pedals are down as far as either holds them (the Pedal button too); a wheel off
 * its rest is yours, at rest the loop's comes back.
 */
export class GestureMix {
  /** What you play (the value passed on last) */
  live = new Map<string, number>();
  /** What the loop plays now */
  private loop = new Map<string, number>();
  /** What went out last (not in it: unknown) */
  private out = new Map<string, number>();
  /** The zone's Pedal button holds sustain down */
  pedal = false;
  /** An old zone object after undo: the new one sends from now on */
  private detached = false;

  constructor(private emit: (key: string, value: number) => void) {}

  private mixed(key: string): number | undefined {
    const live = this.live.get(key);
    const loop = this.loop.get(key);
    if (isStepped(key)) {
      const pedal = key === SUSTAIN && this.pedal;
      if (live === undefined && loop === undefined && !pedal && key !== SUSTAIN) return undefined;
      return Math.max(live ?? 0, loop ?? 0, pedal ? 127 : 0);
    }
    if (live !== undefined && live !== restValue(key)) return live;
    return loop ?? live;
  }

  /** Sends a control's value if it changed (`always`: a value you play goes out as it came) */
  update(key: string, always = false): void {
    if (this.detached) return;
    const v = this.mixed(key);
    if (v === undefined || (!always && this.out.get(key) === v)) return;
    this.out.set(key, v);
    this.emit(key, v);
  }

  /** A value you play */
  played(key: string, value: number): void {
    if (this.detached) return;
    this.live.set(key, value);
    this.update(key, true);
  }

  /** A value the loop plays */
  fromLoop(key: string, value: number): void {
    if (this.detached) return;
    this.loop.set(key, sendValue(key, value));
    this.update(key);
  }

  get loopPlaying(): boolean {
    return this.loop.size > 0;
  }

  /**
   * The loop lets go of its controls (`keys`, else all): yours go out again, or ones that
   * spring back rest there (a pedal lifts unless you hold it)
   */
  loopEnded(keys?: Iterable<string>): void {
    // handed over (undo): the maps are the new zone's now
    if (this.detached) return;
    for (const key of [...(keys ?? this.loop.keys())]) {
      if (!this.loop.delete(key)) continue;
      if (this.live.has(key) || key === SUSTAIN) {
        this.update(key);
        continue;
      }
      const rest = springsBackTo(key);
      if (rest === undefined || this.out.get(key) === rest) continue;
      this.out.set(key, rest);
      this.emit(key, rest);
    }
  }

  /** The synth was reset (panic: CC 121): nothing is known to be sent */
  forget(): void {
    this.out.clear();
  }

  /** Undo: the replacing zone takes over what's held, played and sent; this one goes quiet */
  handOver(to: GestureMix): void {
    to.live = this.live;
    to.loop = this.loop;
    to.out = this.out;
    to.pedal = this.pedal;
    this.detached = true;
  }
}

/** Where a pedal is down (half way or more) between `from` and `to`: [start, end] pairs */
export function pedalSpans(key: string, series: number[], from: number, to: number): [number, number][] {
  const spans: [number, number][] = [];
  let downAt = (valueAt(key, series, from) ?? 0) >= 64 ? from : null;
  for (let i = firstPointAtOrAfter(series, from); i < series.length && series[i] < to; i += 2) {
    if (series[i] <= from) continue;
    const down = series[i + 1] >= 64;
    if (down && downAt === null) downAt = series[i];
    else if (!down && downAt !== null) {
      spans.push([downAt, series[i]]);
      downAt = null;
    }
  }
  if (downAt !== null) spans.push([downAt, to]);
  return spans;
}
