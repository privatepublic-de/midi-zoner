import { Note } from './note';
import type { ParamLock } from './param-locks';

export const UPDATE_ZONE_VIEW_EVENT = 'update-zone-view';
// After every change that is saved (an action, an edit in a panel): views showing zone data redraw
export const ZONES_CHANGED_EVENT = 'zones-changed';
/** A zone's knobs show other values: parameter locks were sent or reverted (detail: the zone) */
export const CC_LOCK_VALUES_EVENT = 'cc-lock-values';
/** zones.tempo changed outside the BPM field (a MIDI file's tempo): the field shows it */
export const TEMPO_CHANGED_EVENT = 'tempo-changed';

export enum CCControllerType {
  UNIPOLAR_ROTARY = 0,
  BIPOLAR_ROTARY = 1,
  SPACER = 2, // shown as "Gap": half a knob of space inside a row
  BUTTON_BANK = 3,
  NOTE_TO_CC = 4,
  UNIPOLAR_14BIT = 5,
  BIPOLAR_14BIT = 6,
  NRPN = 7,
  SECTION = 8, // named, coloured group of the controllers after it; starts a new row
  SELECTOR = 9, // list of named values (discreteValues + valueNames), each sent as is
  PAGE = 10 // named page: the zone shows one page of controllers at a time
}

/** Layout entries: no value, no MIDI output, no MIDI learn */
export function isLayoutEntry(type: number): boolean {
  return type == CCControllerType.SPACER || type == CCControllerType.SECTION || type == CCControllerType.PAGE;
}

/** Types that send one 7-bit CC: controllers on the same CC number stay in sync */
export function isSevenBitCC(type: number): boolean {
  return (
    type == CCControllerType.UNIPOLAR_ROTARY ||
    type == CCControllerType.BIPOLAR_ROTARY ||
    type == CCControllerType.BUTTON_BANK ||
    type == CCControllerType.SELECTOR
  );
}

/** Types whose value runs 0–16383 instead of 0–127 */
export function isHiResCC(type: number): boolean {
  return (
    type == CCControllerType.UNIPOLAR_14BIT ||
    type == CCControllerType.BIPOLAR_14BIT ||
    type == CCControllerType.NRPN
  );
}

export enum ArpDirection {
  UP = 0,
  DOWN = 1,
  UP_DOWN = 2,
  RANDOM = 3,
  ORDER = 4,
  STRUM_DOWN = 5,
  STRUM_UP = 6,
  STRUM_ALT = 7
}

export enum StepCondition {
  ALWAYS = 0,
  PREVIOUS = 1,
  NOT_PREVIOUS = 2,
  FIRST_CYCLE = 3,
  NOT_FIRST_CYCLE = 4,
  // Values from here on index Sequence.CYCLE_CONDITIONS (every N cycles)
  CYCLES = 5
}

export interface CCController {
  number: number;
  number_in: number | null;
  number_lsb?: number;
  // 14-bit types: bits carried by the LSB CC (7 = 14 bit, 3 = 10 bit as on Korg logue
  // devices, where CC63 holds the low 3 bits) and whether the MSB CC is sent first
  lsb_bits?: number;
  msb_first?: boolean;
  // NRPN: parameter number, and how the value is split into Data Entry MSB (CC6) and a
  // low-bits CC: CC38 with 7 bits (standard), CC63 with 3 bits (Korg logue), or none (CC6 only)
  nrpn_msb?: number;
  nrpn_lsb?: number;
  nrpn_data_lsb_cc?: number | null;
  nrpn_data_lsb_bits?: number;
  // NRPN: drawn from the centre and shown relative to the middle of min–max
  bipolar?: boolean;
  // Shown under the knob: one name per snap step, or per value from min on
  valueNames?: string[];
  label: string;
  val: number;
  type: number;
  min: number;
  max: number;
  note_cc: number | null;
  velocity_cc: number | null;
  discreteValues?: number[];
  // Colour: on a section the colour of its controllers, on a controller an override (0 = the section's)
  group?: number;
  // Sections: false continues the current row (behind a divider) instead of starting a new one
  new_row?: boolean;
}

export interface ArpState {
  orderlist: Note[];
  sortedlist: Note[];
  noteindex: number;
  patternPos: number;
  inc: number;
  lastnote: Note | null;
  repeattrig: boolean;
  repeatnote: Note | null;
  beat: boolean;
  octave: number;
  lastStrumNotes: Note[];
}

export interface SeqStepJSON {
  notesArray: Note[];
  length: number;
  probability: number;
  condition: number;
  lastPlayedArray?: Note[];
  gateLength: number;
  ratchetCount?: number;
  ratchetResolution?: number;
  ratchetVelocityDelta?: number;
  locks?: ParamLock[];
  slide?: boolean;
}

export interface DrumLaneJSON {
  steps: (SeqStepJSON | null)[];
  note: number;
  enabled: boolean;
  solo?: boolean;
  length?: number;
  label?: string;
}

// Retained for loading legacy scene files that used the 4-layer structure
export interface SeqLayerJSON {
  steps: (SeqStepJSON | null)[];
  length: number;
  ticks: number;
  division: number;
  drum_lanes: DrumLaneJSON[];
}

/** A note of a take: start (take-relative) and duration in clock ticks (fractional), pitch, velocity */
export interface TakeNoteJSON {
  t: number;
  d: number;
  n: number;
  v: number;
  /** a loop's pick-up: played before its first 1, at its end so it leads into every repeat */
  p?: 1;
  /** a loop's own note: overdubbed or added there, not cut from its take (kept when it's cut anew) */
  o?: 1;
  /** the note's MPE expression as played (zone/note-curve.ts) */
  x?: NoteCurveJSON;
}

/** A take note changed in a loop cut from it: by its key (the take note's tick and pitch as recorded) */
export interface LoopFixJSON {
  k: [number, number];
  /** moved this far from where the take note lands (after the loop's quantize) */
  dt: number;
  d: number;
  n: number;
  v: number;
  x?: NoteCurveJSON;
}

/**
 * A loop cut from a take (zone/loop-window.ts): how it's cut, so its bars can be moved over
 * the take again. Quantize applied to the take's notes, take notes deleted in the loop and
 * take notes changed there (keys: the take note's tick and pitch as recorded)
 */
export interface LoopLinkJSON {
  q?: { g: number; s: number };
  /** its MPE expression was cleared: cut anew, it stays plain */
  plain?: 1;
  hide?: [number, number][];
  fix?: LoopFixJSON[];
}

/** Flat [dt, value, …], dt in 1/8 ticks since the previous point (see zone/note-curve.ts) */
export type CurveSeries = number[];

/** A note's MPE expression: bend (1/100 semitone of the keyboard), slide (CC 74), pressure (before the threshold) */
export interface NoteCurveJSON {
  bend?: CurveSeries;
  slide?: CurveSeries;
  press?: CurveSeries;
}

/** A kept take: its place in the arrangement's song (ticks from bar 1), length, notes */
export interface TakeJSON {
  id?: string;
  start: number;
  length: number;
  /** where in the recording the take's start lies (trimming moves it) */
  offset?: number;
  notes: TakeNoteJSON[];
  /** when it was recorded (ms since 1970) */
  at?: number;
  /** recording order across the session (undo tells takes recorded after a snapshot by it) */
  seq?: number;
  /** where each arrangement's section of the run began (take ticks) and its meter: its bars */
  sections?: { t: number; meter: unknown }[];
  /** a loop's notes outside its bars (ticks from its start, before it negative), for dragging its edges out again */
  spare?: TakeNoteJSON[];
  /** channel gestures (sustain, wheels, aftertouch, passed CCs), per control `[t, value, …]` (zone/gestures.ts) */
  g?: Record<string, number[]>;
  /** a take: where it starts in its run (run ticks; its lead before the first bar was cut) */
  runOffset?: number;
  /** a loop: the run it was cut from (its start time, as a take's `at`) and where its first bar was (run ticks) */
  origin?: { at: number; run: number };
  /** a loop cut from a take: how (zone/loop-window.ts) */
  link?: LoopLinkJSON;
}

export interface SequenceJSON {
  active: boolean;
  steps: (SeqStepJSON | null)[];
  length: number;
  ticks: number;
  division: number;
  isDrumSequence: boolean;
  drumLanes: number;
  drum_lanes: DrumLaneJSON[];
}

export interface ZoneArrangementJSON {
  enabled: boolean;
  solo: boolean;
  octave: number;
  fixedvel: boolean;
  fixedvel_value: number;
  velocity_scaling: number;
  mod: boolean;
  sustain: boolean;
  cc: boolean;
  at2mod: boolean;
  pitchbend: boolean;
  programchange: boolean;
  arp_enabled: boolean;
  arp_hold: boolean;
  arp_direction: number;
  arp_octaves: number;
  arp_division: number;
  arp_gatelength: number;
  arp_repeat: number;
  arp_probability: number;
  arp_transpose: boolean;
  arp_transpose_amount: number;
  arp_pattern: boolean[];
  arp_holdlist: Note[];
  arp_sortedHoldList: Note[];
  arp_strum_taper?: number;
  arp_ratchet_probability?: number;
  arp_ratchet_count?: number;
  euclid_hits: number;
  euclid_length: number;
  sequence: SequenceJSON;
  swingAmount?: number;
  /** Before Nov 2026: kept takes, this arrangement's song for the zone (migrated on load) */
  takes?: TakeJSON[];
  /** Before Nov 2026: whether they played */
  takes_on?: boolean;
  /** The zone's loop in this arrangement (the looper's, played from bar 1) */
  loop?: TakeJSON;
  /** false: the loop is switched off (kept, silent); missing: on */
  loop_on?: boolean;
  /** the loop plays its notes' recorded MPE expression (missing = yes) */
  loop_mpe?: boolean;
  /** Chords zones: false = the chords are switched off (missing: on) */
  chords_on?: boolean;
  /** Chords zones: the settings (chord-settings.ts, sanitized on load) */
  chord_set?: unknown;
  /** Chords zones: the chords the loop was made of (for its chord names and redoing it) */
  chord_plan?: unknown;
}

export interface ZoneJSON {
  /** Stable id (the take store keys the zone's takes by it) */
  id?: string;
  /** Its takes, in scene and zone files only (not in undo snapshots or localStorage) */
  takes?: TakeJSON[];
  channel: number;
  preferredOutputPortId: string;
  inputPortId?: string | null;
  inputChannel?: number | null;
  /** MpeMode: 0 off, 1 pass through, 2 collapse to the zone channel */
  mpe?: number;
  /** Collapse: bend range of the MPE input and of the target synth, in semitones */
  mpe_bend_in?: number;
  mpe_bend_out?: number;
  /** Pass through: the MPE synth's member bend range */
  mpe_pass_bend_out?: number;
  /** Collapse: pressure threshold */
  mpe_at_from?: number;
  /** Collapse: each key's pressure as poly aftertouch */
  mpe_poly_at?: boolean;
  label?: string;
  colorIndex: number | null;
  low: number;
  high: number;
  show_cc: boolean;
  show_seq_panel?: boolean;
  show_arp_panel?: boolean;
  pgm_no?: number | null;
  bank_msb?: number | null;
  bank_lsb?: number | null;
  cc_controllers: CCController[];
  // Device preset the controllers were taken from (they are a copy)
  devicePreset?: { id: string; name: string } | null;
  // Index of the controller page the zone shows
  cc_page?: number;
  /** Plays chords or a bass line to another zone's line (chord-settings.ts ChordRole) */
  chords?: unknown;
  /** The id of the zone's take that plays along (Zone.playTake) */
  play_take?: string;
  arrangements: ZoneArrangementJSON[];
}
