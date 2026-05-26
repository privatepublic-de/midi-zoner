import { Note } from './note';

export const UPDATE_ZONE_VIEW_EVENT = 'update-zone-view';

export enum CCControllerType {
  UNIPOLAR_ROTARY = 0,
  BIPOLAR_ROTARY = 1,
  SPACER = 2,
  BUTTON_BANK = 3,
  NOTE_TO_CC = 4,
  UNIPOLAR_14BIT = 5,
  BIPOLAR_14BIT = 6
}

export enum ArpDirection {
  UP = 0,
  DOWN = 1,
  UP_DOWN = 2,
  RANDOM = 3,
  ORDER = 4
}

export enum StepCondition {
  ALWAYS = 0,
  PREVIOUS = 1,
  NOT_PREVIOUS = 2,
  FIRST_CYCLE = 3,
  NOT_FIRST_CYCLE = 4
}

export interface CCController {
  number: number;
  number_in: number | null;
  number_lsb?: number;
  label: string;
  val: number;
  type: number;
  min: number;
  max: number;
  note_cc: number | null;
  velocity_cc: number | null;
  discreteValues?: number[];
  group?: number;
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
  previousStepPlayed?: boolean;
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
  arp_velocity: number;
  arp_transpose: boolean;
  arp_transpose_amount: number;
  arp_pattern: boolean[];
  arp_holdlist: Note[];
  arp_sortedHoldList: Note[];
  euclid_hits: number;
  euclid_length: number;
  sequence: SequenceJSON;
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
  cc_controllers: CCController[];
  arrangements: ZoneArrangementJSON[];
}
