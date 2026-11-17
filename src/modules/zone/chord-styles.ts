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
  chords: Partial<ChordSettings>;
  bass: Partial<ChordSettings>;
}

// rhythm: 0 Held, 1 Beats, 2 Pushes, 3 Backbeat, 4 Off-beats, 5 Eighths. colour under 0.1: power chords. accents 0.5 = the rhythm's own strong hits
export const CHORD_STYLES: ChordStyle[] = [
  {
    id: 'strings',
    name: 'Slow string pad',
    chords: { harmony: 0.25, colour: 0.45, rhythm: 0, length: 0.9, changes: 0.25, unfold: 0.7, register: 5, tensions: 0.4, vary: 0.1 },
    bass: { bass: 0.05, length: 0.9, vary: 0.05 }
  },
  {
    id: 'piano',
    name: 'Piano accomp',
    chords: { harmony: 0.3, colour: 0.5, rhythm: 0, length: 0.7, bark: 0.15, unfold: 0.3, strum: 1, vary: 0.35 },
    bass: { bass: 0.3, length: 0.7, sync: 0.1, vary: 0.2 }
  },
  {
    id: 'pop',
    name: 'Pop',
    chords: { harmony: 0.35, colour: 0.3, rhythm: 5, length: 0.5, bark: 0.3, strum: 3, register: 2, vary: 0.2 },
    bass: { bass: 0.3, length: 0.55, sync: 0.3, vary: 0.15 }
  },
  {
    id: 'souljazz',
    name: 'Soul jazz',
    chords: { harmony: 0.3, colour: 0.85, rhythm: 4, length: 0.3, bark: 0.7, changes: 0.5, unfold: 0.2, tensions: 0.7, vary: 0.3 },
    bass: { bass: 0.8, length: 0.6, sync: 0.5, vary: 0.3 }
  },
  {
    id: 'naive',
    name: 'Naive',
    chords: { harmony: 0.05, colour: 0.15, rhythm: 1, length: 0.6, changes: 0.25 },
    bass: { bass: 0.05, length: 0.6 }
  },
  {
    id: 'country',
    name: 'Country',
    chords: { harmony: 0.1, colour: 0.15, rhythm: 3, length: 0.3, bark: 0.3, strum: 1, changes: 0.4, vary: 0.15 },
    bass: { bass: 0.3, length: 0.45, vary: 0.1 }
  },
  {
    id: 'rock',
    name: 'Rock',
    chords: { harmony: 0.2, colour: 0.05, rhythm: 5, length: 0.45, bark: 0.45, accents: 0.3, changes: 0.45, register: -3, vary: 0.2 },
    bass: { bass: 0.1, length: 0.5, sync: 0.3, vary: 0.15 }
  },
  {
    id: 'reggae',
    name: 'Reggae',
    chords: { harmony: 0.3, colour: 0.4, rhythm: 4, length: 0.15, bark: 0.2, changes: 0.35, register: 3, vary: 0.15 },
    bass: { bass: 0.35, length: 0.65, sync: 0.6, vary: 0.4 }
  },
  {
    id: 'funk',
    name: 'Funk',
    chords: { harmony: 0.45, colour: 0.9, rhythm: 4, length: 0.1, bark: 0.9, changes: 0.3, register: 3, tensions: 0.6, vary: 0.3 },
    bass: { bass: 0.3, length: 0.3, sync: 1, vary: 0.35 }
  },
  {
    id: 'bossa',
    name: 'Bossa',
    chords: { harmony: 0.3, colour: 0.8, rhythm: 2, length: 0.65, bark: 0.1, changes: 0.5, unfold: 0.15, tensions: 0.45, vary: 0.2 },
    bass: { bass: 0.3, length: 0.55, sync: 0.3, vary: 0.15 }
  },
  {
    id: 'modal',
    name: 'Modal',
    chords: { harmony: 0.95, colour: 0.7, rhythm: 0, length: 0.85, changes: 0.2, unfold: 0.5, vary: 0.15 },
    bass: { bass: 0.05, length: 0.85, vary: 0.05 }
  },
  {
    id: 'gospel',
    name: 'Gospel',
    chords: { harmony: 0.15, colour: 0.6, rhythm: 1, length: 0.55, bark: 0.55, accents: 0.9, changes: 0.55, unfold: 0.3, tensions: 0.55, vary: 0.3 },
    bass: { bass: 0.75, length: 0.6, sync: 0.2, vary: 0.25 }
  }
];

export function styleById(id: string): ChordStyle | undefined {
  return CHORD_STYLES.find((s) => s.id === id);
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
