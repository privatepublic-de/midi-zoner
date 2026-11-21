/**
 * Meters: each arrangement has one (4/4 unless set), saved with the scene. A bar is
 * `n` notes of 1/`d`; the beats are quarters in x/4 and the starts of the groups in
 * x/8 (6/8 = 3+3, 7/8 = 2+2+3), so 7/8 clicks on 3 uneven beats.
 */
import { PPQ } from './zone/seq-layer';

export interface Meter {
  n: number; // notes per bar, 1–32
  d: 4 | 8;
  groups?: number[]; // x/8 only: eighths per beat, summing to n
}

export const DEFAULT_METER: Meter = { n: 4, d: 4 };

/** Meters offered in the A–D menu */
export const METER_CHOICES: Meter[] = [
  { n: 4, d: 4 },
  { n: 3, d: 4 },
  { n: 2, d: 4 },
  { n: 5, d: 4 },
  { n: 7, d: 4 },
  { n: 5, d: 8, groups: [3, 2] },
  { n: 5, d: 8, groups: [2, 3] },
  { n: 6, d: 8 },
  { n: 7, d: 8, groups: [2, 2, 3] },
  { n: 7, d: 8, groups: [3, 2, 2] },
  { n: 9, d: 8 },
  { n: 12, d: 8 }
];

/** Ticks of one note of the meter's denominator */
function unitTicks(m: Meter): number {
  return (PPQ * 4) / m.d;
}

function barTicks(m: Meter): number {
  return m.n * unitTicks(m);
}

/** x/8 without a grouping: threes when they fit (6/8, 9/8), else twos (and a final three) */
function groupsOf(m: Meter): number[] {
  if (m.d === 4) return Array(m.n).fill(1);
  if (m.groups) return m.groups;
  if (m.n % 3 === 0) return Array(m.n / 3).fill(3);
  if (m.n % 2 === 0) return Array(m.n / 2).fill(2);
  if (m.n < 3) return [m.n];
  return [...Array((m.n - 3) / 2).fill(2), 3];
}

const offsetsCache = new Map<string, number[]>();

/** Where the beats start within a bar (ticks), the first at 0 */
function beatOffsets(m: Meter): number[] {
  const key = meterLabel(m);
  let offsets = offsetsCache.get(key);
  if (!offsets) {
    offsets = [];
    let at = 0;
    for (const g of groupsOf(m)) {
      offsets.push(at * unitTicks(m));
      at += g;
    }
    offsetsCache.set(key, offsets);
  }
  return offsets;
}

/** Position within its bar (also for negative positions: the count-in) */
function inBar(m: Meter, t: number): number {
  const bar = barTicks(m);
  return ((t % bar) + bar) % bar;
}

/** The beat starting at song position t: -1 if none, 0 the bar's first */
function beatIndexAt(m: Meter, t: number): number {
  return beatOffsets(m).indexOf(inBar(m, t));
}

/** The beat t is in (0 = the first), for counting */
function beatNumberAt(m: Meter, t: number): number {
  const at = inBar(m, t);
  const offsets = beatOffsets(m);
  let i = offsets.length - 1;
  while (i > 0 && offsets[i] > at) i--;
  return i;
}

/** Snaps t to a bar or a beat line: nearest, or the one at or before / after it */
function snapToBeat(m: Meter, t: number, bars: boolean, how: 'round' | 'floor' | 'ceil' = 'round'): number {
  const bar = barTicks(m);
  const start = Math.floor(t / bar) * bar;
  const lines = bars ? [0, bar] : [...beatOffsets(m), bar];
  const rel = t - start;
  if (how === 'floor') return start + Math.max(...lines.filter((l) => l <= rel + 1e-6));
  if (how === 'ceil') return start + Math.min(...lines.filter((l) => l >= rel - 1e-6));
  return start + lines.reduce((best, l) => (Math.abs(l - rel) < Math.abs(best - rel) ? l : best), lines[0]);
}

/** Beat lines from song position `from` up to `to`: positions and whether a bar starts there */
function beatLines(m: Meter, from: number, to: number): { t: number; bar: boolean }[] {
  const bar = barTicks(m);
  const lines: { t: number; bar: boolean }[] = [];
  for (let start = Math.floor(from / bar) * bar; start <= to; start += bar) {
    for (const o of beatOffsets(m)) {
      const t = start + o;
      if (t >= from && t <= to) lines.push({ t, bar: o === 0 });
    }
  }
  return lines;
}

/** "bar.beat" of a song position, both from 1 */
function positionLabel(m: Meter, t: number): string {
  return `${Math.floor(t / barTicks(m)) + 1}.${beatNumberAt(m, t) + 1}`;
}

/** "7/8 2+2+3"; without a grouping in x/4 and for the usual threes (6/8 = 3+3) */
function meterLabel(m: Meter): string {
  const base = `${m.n}/${m.d}`;
  const groups = groupsOf(m);
  return m.d === 8 && groups.length > 1 && groups.some((g) => g !== 3) ? `${base} ${groups.join('+')}` : base;
}

function sameMeter(a: Meter, b: Meter): boolean {
  return meterLabel(a) === meterLabel(b);
}

/** A meter from a scene file or typed text ("7/8 2+2+3"); null if it isn't one */
function parseMeter(data: unknown): Meter | null {
  let n: number, d: number, groups: number[] | undefined;
  if (typeof data === 'string') {
    const m = data.trim().match(/^(\d{1,2})\s*\/\s*(\d)\s*(?:\(?\s*(\d(?:\s*\+\s*\d)+)\s*\)?)?$/);
    if (!m) return null;
    n = parseInt(m[1]);
    d = parseInt(m[2]);
    groups = m[3]?.split('+').map((g) => parseInt(g));
  } else if (data && typeof data === 'object') {
    n = Number((data as any).n);
    d = Number((data as any).d);
    const g = (data as any).groups;
    groups = Array.isArray(g) ? g.map(Number) : undefined;
  } else {
    return null;
  }
  if (!Number.isInteger(n) || n < 1 || n > 32 || (d !== 4 && d !== 8)) return null;
  if (d === 4) return { n, d };
  if (groups && (groups.some((g) => !Number.isInteger(g) || g < 1 || g > 9) || groups.reduce((a, b) => a + b, 0) !== n)) return null;
  if (!groups || groups.length < 2 || groups.join('+') === groupsOf({ n, d }).join('+')) return { n, d };
  return { n, d, groups };
}

/**
 * Whether step `i` of steps `stepTicks` long starts a beat, counting step 0 as a bar's 1: the
 * sequencer's steps, the arp pattern's cells and the piano roll mark these (Nov 22, the user's
 * ask: 6/8 marks every 6 sixteenths, 7/8 2+2+3 at 4, 4, 6). A step a beat starts inside of has no mark
 */
function startsBeat(i: number, stepTicks: number, m: Meter): boolean {
  if (!(stepTicks > 0)) return false;
  return beatOffsets(m).includes((i * stepTicks) % barTicks(m));
}

export { startsBeat, barTicks, unitTicks, beatOffsets, beatIndexAt, beatNumberAt, snapToBeat, beatLines, positionLabel, meterLabel, sameMeter, parseMeter };
