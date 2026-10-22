import { Note } from './note';

export const UPDATE_ZONE_VIEW_EVENT = 'update-zone-view';

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
}

export interface ZoneJSON {
  channel: number;
  preferredOutputPortId: string;
  inputPortId?: string | null;
  inputChannel?: number | null;
  label?: string;
  colorIndex: number | null;
  low: number;
  high: number;
  show_cc: boolean;
  pgm_no?: number | null;
  bank_msb?: number | null;
  bank_lsb?: number | null;
  cc_controllers: CCController[];
  // Device preset the controllers were taken from (they are a copy)
  devicePreset?: { id: string; name: string } | null;
  // Index of the controller page the zone shows
  cc_page?: number;
  arrangements: ZoneArrangementJSON[];
}
