/**
 * Chords zones: a zone that plays chords (or a bass line) to another zone's line. The role
 * and the zone it follows are zone-global (`ChordRole`); the switch, the settings and the
 * chords its loop was made from are per arrangement, like the arp's.
 */
import { Chord, Key, HarmonyOptions, MODES, QUALITY_INDEX, RHYTHMS } from './harmonize';
import { Take } from './take';

export type ChordPart = 'chords' | 'bass';

export interface ChordRole {
  part: ChordPart;
  /** Zone.id of the zone whose line it follows ('' = none chosen yet) */
  follows: string;
  /** Seq and Arp switches per arrangement before the role (they come back when it ends) */
  stash?: { seq: boolean[]; arp: boolean[] };
}

export interface ChordSettings {
  harmony: number; // 0 circle of fifths … 1 modal
  colour: number; // 0 triads … 1 7 / 9
  rhythm: number; // index in RHYTHMS
  length: number; // 0 stabs … 1 legato
  accents: number; // 0 on-beat … 1 off-beat (0.5 flat)
  changes: number; // 0 slow … 1 fast
  unfold: number; // build-up
  register: number; // semitones
  tensions: number; // 0 softer … 1 louder (0.5 even)
  vary: number;
  bass: number; // bass moves: 0 roots … 1 walking
  sync: number; // bass syncopation: 0 straight … 1 wild
  bark: number; // chord dynamics: 0 even … 1 barking
  seed: number; // 0 = the best ("Other chords" counts up)
  /** the style it was set from (chord-styles.ts; '' none) */
  style: string;
}

export const DEFAULT_CHORD_SETTINGS: ChordSettings = {
  harmony: 0.3,
  colour: 0.4,
  rhythm: 0,
  length: 0.5,
  accents: 0.5,
  changes: 0.5,
  unfold: 0,
  register: 0,
  tensions: 0.5,
  vary: 0,
  bass: 0.5,
  sync: 0,
  bark: 0,
  seed: 0,
  style: ''
};

/** The chords a zone's loop was made of: per beat of the loop, with the key */
export interface ChordPlan {
  key: Key;
  length: number;
  chords: (Chord | null)[];
  /** the loop's notes when it was made: an edit elsewhere (Notes, − bar…) makes the plan stale */
  sig: number;
}

const clamp01 = (x: unknown, d: number) => (typeof x === 'number' && isFinite(x) ? Math.max(0, Math.min(1, x)) : d);

export function chordSettingsFrom(x: unknown): ChordSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const d = DEFAULT_CHORD_SETTINGS;
  const reg = typeof o.register === 'number' && isFinite(o.register) ? Math.round(Math.max(-12, Math.min(12, o.register))) : 0;
  const rhythm = typeof o.rhythm === 'number' && isFinite(o.rhythm) ? Math.max(0, Math.min(RHYTHMS.length - 1, Math.round(o.rhythm))) : 0;
  const seed = typeof o.seed === 'number' && isFinite(o.seed) ? Math.max(0, Math.min(9999, Math.round(o.seed))) : 0;
  return {
    harmony: clamp01(o.harmony, d.harmony),
    colour: clamp01(o.colour, d.colour),
    rhythm,
    length: clamp01(o.length, d.length),
    accents: clamp01(o.accents, d.accents),
    changes: clamp01(o.changes, d.changes),
    unfold: clamp01(o.unfold, d.unfold),
    register: reg,
    tensions: clamp01(o.tensions, d.tensions),
    vary: clamp01(o.vary, d.vary),
    bass: clamp01(o.bass, d.bass),
    sync: clamp01(o.sync, d.sync),
    bark: clamp01(o.bark, d.bark),
    seed,
    style: typeof o.style === 'string' && /^[a-z]{1,16}$/.test(o.style) ? o.style : ''
  };
}

/** A role from a scene or zone file (untrusted) */
export function chordRoleFrom(x: unknown): ChordRole | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (o.part !== 'chords' && o.part !== 'bass') return null;
  const follows = typeof o.follows === 'string' && /^[a-z0-9]{0,16}$/.test(o.follows) ? o.follows : '';
  const role: ChordRole = { part: o.part, follows };
  const s = o.stash as Record<string, unknown> | undefined;
  const bools = (a: unknown) => (Array.isArray(a) ? [0, 1, 2, 3].map((i) => a[i] === true) : null);
  if (s && typeof s === 'object') {
    const seq = bools(s.seq);
    const arp = bools(s.arp);
    if (seq && arp) role.stash = { seq, arp };
  }
  return role;
}

const QUALITIES = Object.keys(QUALITY_INDEX) as Chord['quality'][];

function chordFrom(x: unknown): Chord | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const root = typeof o.root === 'number' ? Math.round(o.root) : -1;
  if (root < 0 || root > 11 || !QUALITIES.includes(o.quality as Chord['quality'])) return null;
  const degree = typeof o.degree === 'number' ? Math.max(-1, Math.min(6, Math.round(o.degree))) : -1;
  const kind = (['dia', 'sec', 'bor', 'mod'] as const).find((k) => k === o.kind) ?? 'dia';
  return { root, quality: o.quality as Chord['quality'], degree, kind, prior: 0 };
}

export function chordPlanFrom(x: unknown): ChordPlan | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const k = o.key as Record<string, unknown> | undefined;
  if (!k || typeof k.tonic !== 'number' || typeof k.mode !== 'number') return null;
  const tonic = Math.round(k.tonic);
  const mode = Math.round(k.mode);
  if (tonic < 0 || tonic > 11 || mode < 0 || mode >= MODES.length) return null;
  if (typeof o.length !== 'number' || !(o.length > 0) || !Array.isArray(o.chords) || o.chords.length > 4096) return null;
  return {
    key: { tonic, mode, score: 0 },
    length: o.length,
    chords: o.chords.map(chordFrom),
    sig: typeof o.sig === 'number' ? o.sig : 0
  };
}

/** A fingerprint of a loop's notes: changes when they are edited */
export function loopSig(loop: Take | null): number {
  if (!loop) return 0;
  let h = loop.length;
  for (const n of loop.notes) h = (h * 31 + Math.round(n.t * 8) * 7 + n.n * 131 + Math.round(n.d * 8)) % 1000000007;
  return h + loop.notes.length;
}

/** The engine's options for a zone's settings */
export function harmonyOptions(s: ChordSettings): HarmonyOptions {
  return {
    harmony: s.harmony,
    changes: s.changes,
    rhythm: (s.rhythm + 0.5) / RHYTHMS.length,
    colour: s.colour,
    register: s.register,
    unfold: s.unfold,
    length: s.length,
    accents: s.accents * 2 - 1,
    tensions: s.tensions * 2 - 1,
    vary: s.vary,
    bassMove: s.bass,
    syncopation: s.sync,
    dynamics: s.bark,
    seed: s.seed
  };
}
