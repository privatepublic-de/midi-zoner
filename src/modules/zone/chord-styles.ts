/**
 * Styles for chords zones: one pick sets the chords zone and the bass zone on a line together
 * (how the two play as a band). Each style gives the chords settings and the bass settings; the
 * bass gets the chords' Harmony, Chord changes and Rhythm too (they count when it leads, and its
 * push follows the rhythm). Settings not named are the defaults, so a style always sets all.
 */
import { ChordPart, ChordSettings, DEFAULT_CHORD_SETTINGS } from './chord-settings';

export interface ChordStyle {
  id: string;
  name: string;
  /** the group it is listed under (STYLE_GROUPS) */
  group: string;
  chords: Partial<ChordSettings>;
  bass: Partial<ChordSettings>;
  /** the zones' Swing (0 … 1; missing: straight) */
  swing?: number;
}

// rhythm: 0 Held, 1 Beats, 2 Pushes, 3 Backbeat, 4 Off-beats, 5 Eighths, 6 Scattered, 7 Comping, 8 Broken. harmony over 0.85: free. colour under 0.1: power chords. accents 0.5 = the rhythm's own strong hits
export const CHORD_STYLES: ChordStyle[] = [
  {
    id: 'strings',
    group: 'Calm',
    name: 'String pad',
    chords: { harmony: 0.25, colour: 0.45, rhythm: 0, length: 0.9, changes: 0.25, unfold: 0.7, register: 3, tensions: 0.4, vary: 0.1 },
    bass: { bass: 0.05, length: 0.9, vary: 0.05 }
  },
  {
    id: 'piano',
    group: 'Calm',
    name: 'Piano accomp',
    chords: { harmony: 0.3, colour: 0.5, rhythm: 0, length: 0.7, bark: 0.15, unfold: 0.3, strum: 1, vary: 0.35 },
    bass: { bass: 0.3, length: 0.7, sync: 0.1, vary: 0.2 }
  },
  {
    id: 'pop',
    group: 'Pop & rock',
    name: 'Pop',
    chords: { harmony: 0.35, colour: 0.3, rhythm: 5, length: 0.5, bark: 0.3, strum: 3, register: 0, vary: 0.2 },
    bass: { bass: 0.3, length: 0.55, sync: 0.3, vary: 0.15 }
  },
  {
    id: 'souljazz',
    group: 'Jazz',
    name: 'Soul jazz',
    chords: { harmony: 0.3, colour: 0.85, rhythm: 4, length: 0.3, bark: 0.7, changes: 0.5, unfold: 0.2, tensions: 0.7, vary: 0.3 },
    bass: { bass: 0.8, length: 0.6, sync: 0.5, vary: 0.3 }
  },
  {
    id: 'freejazz',
    group: 'Jazz',
    name: 'Free jazz',
    chords: { harmony: 0.97, colour: 0.9, rhythm: 6, length: 0.2, bark: 0.7, changes: 0.9, unfold: 0.3, tensions: 0.7, vary: 1 },
    bass: { bass: 1, length: 0.4, sync: 1, vary: 1 }
  },
  {
    id: 'bebop',
    group: 'Jazz',
    name: 'Jazz comping',
    chords: { harmony: 0.15, colour: 0.8, rhythm: 7, length: 0.35, bark: 0.4, changes: 0.75, tensions: 0.6, vary: 0.35 },
    bass: { bass: 0.95, length: 0.7, sync: 0.2, vary: 0.3 },
    swing: 0.67
  },
  {
    id: 'blues',
    group: 'Pop & rock',
    name: 'Blues shuffle',
    chords: { harmony: 0.1, colour: 0.5, rhythm: 5, length: 0.45, bark: 0.4, changes: 0.35, blues: 1, vary: 0.25 },
    bass: { bass: 0.55, length: 0.6, sync: 0.1, vary: 0.2 },
    swing: 0.67
  },
  {
    id: 'ballad',
    group: 'Calm',
    name: 'Ballad',
    chords: { harmony: 0.25, colour: 0.8, rhythm: 8, length: 0.9, changes: 0.35, unfold: 0.55, register: 0, tensions: 0.45, vary: 0.2 },
    bass: { bass: 0.3, length: 0.9, vary: 0.1 }
  },
  {
    id: 'naive',
    group: 'Pop & rock',
    name: 'Naive',
    chords: { harmony: 0.05, colour: 0.15, rhythm: 1, length: 0.6, changes: 0.25 },
    bass: { bass: 0.05, length: 0.6 }
  },
  {
    id: 'country',
    group: 'Pop & rock',
    name: 'Country',
    chords: { harmony: 0.1, colour: 0.15, rhythm: 3, length: 0.3, bark: 0.3, strum: 1, changes: 0.4, vary: 0.15 },
    bass: { bass: 0.3, length: 0.45, vary: 0.1 }
  },
  {
    id: 'rock',
    group: 'Pop & rock',
    name: 'Rock',
    chords: { harmony: 0.2, colour: 0.05, rhythm: 5, length: 0.45, bark: 0.45, accents: 0.3, changes: 0.45, register: -3, vary: 0.2 },
    bass: { bass: 0.1, length: 0.5, sync: 0.3, vary: 0.15 }
  },
  {
    id: 'motown',
    group: 'Soul & groove',
    name: 'Motown',
    chords: { harmony: 0.3, colour: 0.25, rhythm: 3, length: 0.35, bark: 0.5, changes: 0.5, register: 1, vary: 0.2 },
    bass: { bass: 0.65, length: 0.45, sync: 0.55, vary: 0.25 }
  },
  {
    id: 'reggae',
    group: 'Soul & groove',
    name: 'Reggae',
    chords: { harmony: 0.3, colour: 0.4, rhythm: 4, length: 0.15, bark: 0.2, changes: 0.35, register: 1, vary: 0.15 },
    bass: { bass: 0.35, length: 0.65, sync: 0.6, vary: 0.4 }
  },
  {
    id: 'funk',
    group: 'Soul & groove',
    name: 'Funk',
    chords: { harmony: 0.45, colour: 0.9, rhythm: 4, length: 0.1, bark: 0.9, changes: 0.3, register: 1, tensions: 0.6, vary: 0.3 },
    bass: { bass: 0.3, length: 0.3, sync: 1, vary: 0.35 }
  },
  {
    id: 'bossa',
    group: 'Jazz',
    name: 'Bossa',
    chords: { harmony: 0.3, colour: 0.8, rhythm: 2, length: 0.65, bark: 0.1, changes: 0.5, unfold: 0.15, tensions: 0.45, vary: 0.2 },
    bass: { bass: 0.3, length: 0.55, sync: 0.3, vary: 0.15 }
  },
  {
    id: 'modal',
    group: 'Calm',
    name: 'Modal',
    chords: { harmony: 0.8, colour: 0.7, rhythm: 0, length: 0.85, changes: 0.2, unfold: 0.5, vary: 0.15 },
    bass: { bass: 0.05, length: 0.85, vary: 0.05 }
  },
  {
    id: 'ambient',
    group: 'Calm',
    name: 'Ambient',
    chords: { harmony: 0.75, colour: 0.6, rhythm: 0, length: 1, changes: 0.1, unfold: 0.9, register: 4, tensions: 0.4, vary: 0.1 },
    bass: { bass: 0, length: 1 }
  },
  {
    id: 'gospel',
    group: 'Soul & groove',
    name: 'Gospel',
    chords: { harmony: 0.15, colour: 0.6, rhythm: 1, length: 0.55, bark: 0.55, accents: 0.9, changes: 0.55, unfold: 0.3, tensions: 0.55, vary: 0.3 },
    bass: { bass: 0.75, length: 0.6, sync: 0.2, vary: 0.25 }
  }
];

/** The style dropdown's groups, in order; styles alphabetical within each */
export const STYLE_GROUPS = ['Calm', 'Jazz', 'Soul & groove', 'Pop & rock'];

export function stylesIn(group: string): ChordStyle[] {
  return CHORD_STYLES.filter((s) => s.group === group).sort((a, b) => a.name.localeCompare(b.name));
}

/** Ids of styles that were dropped → the style that took their place (Nov 20: Jazz waltz, its settings close to Jazz comping's) */
const DROPPED: Record<string, string> = { jazzwaltz: 'bebop' };

export function styleById(id: string): ChordStyle | undefined {
  const want = DROPPED[id] ?? id;
  return CHORD_STYLES.find((s) => s.id === want);
}

/** A part's full settings in a style (the other settings at their defaults) */
export function styleSettings(style: ChordStyle, part: ChordPart): ChordSettings {
  const chords = { ...DEFAULT_CHORD_SETTINGS, ...style.chords, seed: 0, style: style.id };
  if (part === 'chords') return chords;
  return {
    ...DEFAULT_CHORD_SETTINGS,
    harmony: chords.harmony,
    changes: chords.changes,
    rhythm: chords.rhythm,
    ...style.bass,
    seed: 0,
    style: style.id
  };
}

/** The zone's settings were changed away from its style (Other chords doesn't count) */
export function differsFromStyle(s: ChordSettings, part: ChordPart): boolean {
  const style = styleById(s.style);
  if (!style) return false;
  const want = styleSettings(style, part);
  return (Object.keys(want) as (keyof ChordSettings)[]).some(
    (k) => k !== 'seed' && k !== 'style' && Math.abs((want[k] as number) - (s[k] as number)) > 0.001
  );
}
