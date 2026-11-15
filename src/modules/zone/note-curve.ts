import type { NoteCurveJSON, CurveSeries } from './interfaces';

/**
 * A note's MPE expression as played (see zone/mpe.ts): its pitch bend, slide and pressure
 * over time, carried with the note through every edit of a take or loop. Times count
 * from the note's start, so moving, quantizing or wrapping a note round a loop leaves
 * its curve as it is; only changing its length trims it.
 *
 * Each series is flat [dt, value, dt, value, …]: dt in 1/8 ticks since the previous point
 * (the first one since the note's start, usually 0: the value when the key went down,
 * which MPE sends before the note-on), integers. Points after the note's end are its
 * release tail. Values are as the keyboard sent them, before the zone's settings, so a
 * loop follows a later change of bend range or pressure threshold:
 * - bend: hundredths of a semitone of the keyboard's range, 0 = centre
 * - slide: CC 74, 0–127
 * - press: channel pressure 0–127, before the threshold
 *
 * Curves are never changed in place: an edit makes a new one, so copies can share them.
 */

export type CurveName = 'bend' | 'slide' | 'press';
export const CURVE_NAMES: readonly CurveName[] = ['bend', 'slide', 'press'];

/** Curve times are in 1/8 ticks */
export const CURVE_STEPS_PER_TICK = 8;
/** Points one series keeps at most */
export const MAX_CURVE_POINTS = 2048;
/**
 * How far a release tail reaches past the note's end at most, in ticks (500 ms of tail,
 * RELEASE_KEEP_MS in mpe.ts, is 60 ticks at 300 BPM)
 */
export const MAX_TAIL_TICKS = 64;

/** Value range of each series */
const RANGE: Record<CurveName, [number, number]> = {
  bend: [-9600, 9600], // ±96 semitones, the widest bend range
  slide: [0, 127],
  press: [0, 127]
};

/** The points of a series, at ticks from the note's start */
export function curvePoints(series: CurveSeries): { t: number; v: number }[] {
  const points: { t: number; v: number }[] = [];
  let at = 0;
  for (let i = 0; i + 1 < series.length; i += 2) {
    at += series[i];
    points.push({ t: at / CURVE_STEPS_PER_TICK, v: series[i + 1] });
  }
  return points;
}

/** A series' value at a tick from the note's start: straight lines between points, held after the last */
export function sampleSeries(series: CurveSeries, t: number): number | null {
  if (series.length < 2) return null;
  const at = t * CURVE_STEPS_PER_TICK;
  let prevT = series[0];
  let prevV = series[1];
  if (at <= prevT) return prevV;
  for (let i = 2; i + 1 < series.length; i += 2) {
    const nextT = prevT + series[i];
    const nextV = series[i + 1];
    if (at < nextT) return prevV + ((nextV - prevV) * (at - prevT)) / Math.max(1, nextT - prevT);
    prevT = nextT;
    prevV = nextV;
  }
  return prevV;
}

/** Where a curve's last point lies, in ticks from the note's start (0 for none) */
export function curveEnd(curve: NoteCurveJSON | undefined): number {
  let end = 0;
  if (!curve) return end;
  for (const name of CURVE_NAMES) {
    const series = curve[name];
    if (!series) continue;
    let at = 0;
    for (let i = 0; i < series.length; i += 2) at += series[i];
    end = Math.max(end, at / CURVE_STEPS_PER_TICK);
  }
  return end;
}

/** How many points a curve has */
export function countPoints(curve: NoteCurveJSON | undefined): number {
  if (!curve) return 0;
  return CURVE_NAMES.reduce((sum, name) => sum + (curve[name]?.length ?? 0) / 2, 0);
}

/**
 * The curve for a note now `length` ticks long: points past its release tail are left out
 * (the same curve when none is; undefined when nothing is left)
 */
export function trimCurve(curve: NoteCurveJSON | undefined, length: number): NoteCurveJSON | undefined {
  if (!curve) return undefined;
  const limit = (length + MAX_TAIL_TICKS) * CURVE_STEPS_PER_TICK;
  let changed = false;
  const trimmed: NoteCurveJSON = {};
  for (const name of CURVE_NAMES) {
    const series = curve[name];
    if (!series) continue;
    let at = 0;
    let keep = 0;
    while (keep + 1 < series.length && (at += series[keep]) <= limit) keep += 2;
    if (keep < series.length) changed = true;
    if (keep > 0) trimmed[name] = keep < series.length ? series.slice(0, keep) : series;
  }
  if (!changed) return curve;
  return CURVE_NAMES.some((name) => trimmed[name]) ? trimmed : undefined;
}

/**
 * A curve from a scene or takes file (untrusted): whole numbers, an even count, times not
 * going back, values in range, at most MAX_CURVE_POINTS each; undefined when nothing's left
 */
export function sanitizeCurve(raw: unknown): NoteCurveJSON | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const curve: NoteCurveJSON = {};
  for (const name of CURVE_NAMES) {
    const series = (raw as Record<string, unknown>)[name];
    if (!Array.isArray(series)) continue;
    const [lo, hi] = RANGE[name];
    const clean: number[] = [];
    for (let i = 0; i + 1 < series.length && clean.length < 2 * MAX_CURVE_POINTS; i += 2) {
      const dt = Number(series[i]);
      const v = Number(series[i + 1]);
      if (!Number.isInteger(dt) || dt < 0 || dt > 1e9 || !Number.isInteger(v)) break;
      clean.push(dt, Math.max(lo, Math.min(hi, v)));
    }
    if (clean.length > 0) curve[name] = clean;
  }
  return CURVE_NAMES.some((name) => curve[name]) ? curve : undefined;
}

/**
 * How far thinning lets a series' line stray from what was played (bend: hundredths of a
 * semitone): the line can miss by up to twice this where a new one starts, so at most 2
 * cents of bend and 2 steps of slide or pressure
 */
const TOLERANCE: Record<CurveName, number> = { bend: 1, slide: 0.5, press: 1 };
/**
 * Points after the key went up wait this long (ms): an MPE keyboard sends the next key's
 * bend and slide on the channel just before its note-on (a Seaboard in the same ms), and
 * those aren't this key's release tail
 */
const NEXT_KEY_MS = 2;
/** A loop's expression points at most (it's in the scene and every undo step): beyond, it's thinned harder */
export const LOOP_CURVE_BUDGET = 20000;
/** How long a released key's expression is recorded (its release tail), in ms; RELEASE_KEEP_MS in mpe.ts */
export const TAIL_MS = 500;

/**
 * One series as it comes in, thinned on the way (swing door): a point is kept only where a
 * straight line from the last kept one would miss what was played by more than the tolerance.
 * Times are whole 1/8 ticks from the note's start and never go back.
 */
class SeriesBuilder {
  /** Encoded kept points */
  private kept: number[] = [];
  private keptT = 0;
  private keptV = 0;
  /** The latest point, not kept (yet) */
  private lastT = -1;
  private lastV = 0;
  /** Slopes from the last kept point that stay within the tolerance of every point since */
  private lo = -Infinity;
  private hi = Infinity;

  constructor(private tol: number) {}

  get size(): number {
    return this.kept.length / 2 + (this.lastT > this.keptT ? 1 : 0);
  }

  add(t: number, v: number): void {
    if (this.kept.length === 0) {
      this.keep(t, v);
      return;
    }
    t = Math.max(t, this.lastT, this.keptT);
    if (t === this.keptT) {
      // the same moment as the kept point: it takes the newer value
      this.kept[this.kept.length - 1] = this.keptV = v;
      this.lastT = t;
      this.lastV = v;
      this.lo = -Infinity;
      this.hi = Infinity;
      return;
    }
    const dt = t - this.keptT;
    const lo = Math.max(this.lo, (v - this.tol - this.keptV) / dt);
    const hi = Math.min(this.hi, (v + this.tol - this.keptV) / dt);
    if (lo <= hi) {
      this.lo = lo;
      this.hi = hi;
    } else {
      // no straight line covers this one too: the previous point is kept, a new line starts there
      if (this.lastT > this.keptT) this.keep(this.lastT, this.lastV);
      if (t === this.keptT) {
        this.kept[this.kept.length - 1] = this.keptV = v;
      } else {
        this.lo = (v - this.tol - this.keptV) / (t - this.keptT);
        this.hi = (v + this.tol - this.keptV) / (t - this.keptT);
      }
    }
    this.lastT = t;
    this.lastV = v;
  }

  private keep(t: number, v: number): void {
    this.kept.push(t - (this.kept.length ? this.keptT : 0), v);
    this.keptT = this.lastT = t;
    this.keptV = this.lastV = v;
    this.lo = -Infinity;
    this.hi = Infinity;
  }

  /** The series so far, the latest point included */
  series(): CurveSeries {
    return this.lastT > this.keptT ? [...this.kept, this.lastT - this.keptT, this.lastV] : this.kept.slice();
  }
}

/** A curve thinned again with `factor` times the tolerances (to fit a budget) */
export function thinCurve(curve: NoteCurveJSON, factor: number): NoteCurveJSON {
  const thinned: NoteCurveJSON = {};
  for (const name of CURVE_NAMES) {
    const series = curve[name];
    if (!series) continue;
    const b = new SeriesBuilder(TOLERANCE[name] * factor);
    let at = 0;
    for (let i = 0; i + 1 < series.length; i += 2) b.add((at += series[i]), series[i + 1]);
    thinned[name] = b.series();
  }
  return thinned;
}

/**
 * Notes with more expression points than the budget get their curves thinned harder
 * (doubling the tolerances until they fit), so nothing is dropped
 */
export function fitCurves(notes: { x?: NoteCurveJSON }[], budget = LOOP_CURVE_BUDGET): void {
  const original = notes.map((n) => n.x);
  const total = (): number => notes.reduce((sum, n) => sum + countPoints(n.x), 0);
  for (let factor = 2; factor <= 256 && total() > budget; factor *= 2) {
    notes.forEach((n, i) => {
      const x = original[i];
      if (x) n.x = thinCurve(x, factor);
    });
  }
}

/** What a key's channel held when it went down (MPE sends it before the note-on) */
export interface CurveStart {
  /** Hundredths of a semitone of the keyboard */
  bend: number;
  slide: number | null;
  press: number;
}

/**
 * Records one key's expression while it's held and through its release tail. The notes it
 * belongs to (in the take being recorded and the looper's input) are its owners: when it's
 * finished they get the whole curve. Copies made before that (a loop closed over a held
 * key) got `curve()` as it was then, and are found again by it (`handedOut`).
 */
export class CurveBuilder {
  private series: Partial<Record<CurveName, SeriesBuilder>> = {};
  private cached: NoteCurveJSON | undefined;
  private dirty = true;
  /** When the key went up (performance.now()), -1 while held */
  releasedAt = -1;
  /** Release tail points waiting NEXT_KEY_MS (they may be the next key's) */
  private waiting: { name: CurveName; tick: number; value: number; ms: number }[] = [];
  done = false;
  /** Every curve handed out so far, so copies of the note can be brought up to date */
  readonly handedOut = new WeakSet<NoteCurveJSON>();
  readonly owners: { x?: NoteCurveJSON; cb?: CurveBuilder }[] = [];

  /** `start`: the note's start (ticks), `key` the key as it came in */
  constructor(readonly start: number, readonly key: number, at: CurveStart) {
    this.add('bend', start, at.bend);
    if (at.slide !== null) this.add('slide', start, at.slide);
    this.add('press', start, at.press);
  }

  /**
   * A point of the key's expression; `ms` (performance.now()) after its release, where it
   * waits a moment before it counts (see NEXT_KEY_MS)
   */
  add(name: CurveName, tick: number, value: number, ms = -1): void {
    if (this.done) return;
    if (this.releasedAt >= 0 && ms >= 0) {
      this.settle(ms);
      this.waiting.push({ name, tick, value, ms });
      return;
    }
    this.put(name, tick, value);
  }

  /** Waiting tail points from before `ms` − NEXT_KEY_MS count (all of them by default) */
  private settle(ms = Infinity): void {
    while (this.waiting.length > 0 && this.waiting[0].ms < ms - NEXT_KEY_MS) {
      const p = this.waiting.shift()!;
      this.put(p.name, p.tick, p.value);
    }
  }

  private put(name: CurveName, tick: number, value: number): void {
    const series = (this.series[name] ??= new SeriesBuilder(TOLERANCE[name]));
    if (series.size >= MAX_CURVE_POINTS) return;
    series.add(Math.max(0, Math.round((tick - this.start) * CURVE_STEPS_PER_TICK)), value);
    this.dirty = true;
  }

  /** Its release tail is over */
  expired(ms: number): boolean {
    return this.releasedAt >= 0 && ms - this.releasedAt >= TAIL_MS;
  }

  /** The curve so far (the same object until something new comes in); undefined: nothing but rest */
  curve(): NoteCurveJSON | undefined {
    if (!this.dirty) return this.cached;
    this.dirty = false;
    const curve: NoteCurveJSON = {};
    for (const name of CURVE_NAMES) {
      const series = this.series[name]?.series();
      // bend at the centre and no pressure throughout say nothing
      if (!series || (name !== 'slide' && series.length === 2 && series[1] === 0)) continue;
      curve[name] = series;
    }
    this.cached = CURVE_NAMES.some((name) => curve[name]) ? curve : undefined;
    if (this.cached) this.handedOut.add(this.cached);
    return this.cached;
  }

  /**
   * No more points: the owners get the whole curve; returns it. `nextKeyMs`: the channel's
   * next note-on came then, so tail points just before it were that key's
   */
  finish(nextKeyMs?: number): NoteCurveJSON | undefined {
    this.settle(nextKeyMs);
    this.waiting = [];
    const curve = this.curve();
    this.done = true;
    for (const owner of this.owners) {
      if (curve) owner.x = curve;
      delete owner.cb;
    }
    return curve;
  }
}

/**
 * A key's expression is finished: copies of its note made while it was still coming in
 * (they have a curve it handed out) get the whole curve, trimmed to their length
 */
export function updateCurves(notes: { d: number; x?: NoteCurveJSON }[], builder: CurveBuilder, curve: NoteCurveJSON): number {
  let count = 0;
  for (const n of notes) {
    if (!n.x || !builder.handedOut.has(n.x)) continue;
    const x = trimCurve(curve, n.d);
    if (x) n.x = x;
    else delete n.x;
    count++;
  }
  return count;
}

/** One series read forward in time: straight lines between its points, held after the last */
class SeriesCursor {
  private i = 0;
  private t0: number;
  private t1: number;

  constructor(private series: CurveSeries) {
    this.t0 = series[0];
    this.t1 = series.length > 2 ? this.t0 + series[2] : Infinity;
  }

  /** The value at `at` (1/8 ticks from the note's start), never earlier than the last call */
  at(at: number): number {
    const s = this.series;
    while (at >= this.t1) {
      this.i += 2;
      this.t0 = this.t1;
      this.t1 = this.i + 2 < s.length ? this.t0 + s[this.i + 2] : Infinity;
    }
    const v0 = s[this.i + 1];
    if (at <= this.t0 || this.t1 === Infinity) return v0;
    return v0 + ((s[this.i + 3] - v0) * (at - this.t0)) / (this.t1 - this.t0);
  }
}

/**
 * A note's curve read forward in time, as playback needs it: bend and pressure missing
 * are at rest (0), slide missing is null (nothing sent)
 */
export class CurveCursor {
  private bend: SeriesCursor | null;
  private slide: SeriesCursor | null;
  private press: SeriesCursor | null;

  constructor(curve: NoteCurveJSON) {
    this.bend = curve.bend?.length ? new SeriesCursor(curve.bend) : null;
    this.slide = curve.slide?.length ? new SeriesCursor(curve.slide) : null;
    this.press = curve.press?.length ? new SeriesCursor(curve.press) : null;
  }

  /** Values at `t` ticks from the note's start (call with times that don't go back) */
  at(t: number): { bend: number; slide: number | null; press: number } {
    const at = t * CURVE_STEPS_PER_TICK;
    return {
      bend: this.bend ? Math.round(this.bend.at(at)) : 0,
      slide: this.slide ? Math.round(this.slide.at(at)) : null,
      press: this.press ? Math.round(this.press.at(at)) : 0
    };
  }
}
