// Core MIDI Types
export interface MIDIMessageEvent {
  data: Uint8Array;
  srcElement?: { id: string };
}

export interface PortDescriptor {
  id: string;
  name: string;
  fullName: string;
  isSelectedInput?: boolean;
  isSelectedClockInput?: boolean;
}

// CC Controller Types
export type CCControllerType = 0 | 1 | 2 | 3 | 4 | 5 | 6;
// 0: unipolar, 1: bipolar, 2: spacer, 3: button, 4: note2cc, 5: unipolar 14bit, 6: bipolar 14bit

export interface CCController {
  number: number;
  number_in: number | null;
  number_lsb?: number;
  label: string;
  val: number;
  type: CCControllerType;
  min: number;
  max: number;
  note_cc: number | null;
  velocity_cc: number | null;
  discreteValues?: number[];
  group?: number;
  // Button-specific (type 3)
  buttonlabel0?: string;
  buttonvalue0?: number;
  buttonlabel1?: string;
  buttonvalue1?: number;
  buttonlabel2?: string;
  buttonvalue2?: number;
  buttonlabel3?: string;
  buttonvalue3?: number;
  buttonlabel4?: string;
  buttonvalue4?: number;
  buttonlabel5?: string;
  buttonvalue5?: number;
  buttonlabel6?: string;
  buttonvalue6?: number;
  buttonlabel7?: string;
  buttonvalue7?: number;
}

// Note Data
export interface NoteData {
  number: number;
  velo: number;
  channel: number;
  portId: string;
  isBlackKey: boolean;
}

// Sequence Step Data
export interface SeqStepData {
  notesArray: NoteData[];
  lastPlayedArray: NoteData[];
  length: number;
  probability: number;
  condition: number;
  gateLength: number;
  played: number;
}

// Drum Lane Data
export interface DrumLaneData {
  steps: (SeqStepData | null)[];
  note: number;
  enabled: boolean;
}

// Sequence Layer Data
export interface SeqLayerData {
  steps: (SeqStepData | null)[];
  division: number;
  ticks: number;
  length: number;
  drum_lanes: DrumLaneData[];
}

// Arpeggiator State
export interface ArpState {
  orderlist: NoteData[];
  sortedlist: NoteData[];
  noteindex: number;
  patternPos: number;
  inc: number;
  lastnote: NoteData | null;
  repeattrig: boolean;
  repeatnote: NoteData | null;
  beat: boolean;
  octave: number;
}

// MIDI Handler Callbacks
export interface MIDIHandlers {
  eventHandler: (event: MIDIMessageEvent) => void;
  clockHandler: (pos: number) => void;
  transportHandler: (started: boolean) => void;
  panicHandler: () => void;
  completeHandler: (available: boolean, message: string) => void;
  updatePortsHandler: (inputs: PortDescriptor[], outputs: PortDescriptor[], msg?: string) => void;
  updateClockReceiverHandler: (outputs: PortDescriptor[]) => void;
}

// Global Zones State
export interface ZonesState {
  list: any[]; // Zone[]
  inChannel: number;
  clockOutputPorts: Record<string, boolean>;
  selectedInputPorts: Record<string, { id: string; ch: number; isSelected: boolean }>;
  tempo: number;
  sendInternalClockIfPlaying: boolean;
  outputConfigNames: Record<string, string>;
  arrangementIndex: number;
  nextArrangementIndex: number;
  arrangementQuantIndex: number;
}

// IPC Types
export interface SaveDialogResult {
  canceled: boolean;
  warning: boolean;
  message: string | null;
}

// Window Position
export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// MIDI Constants
export interface MIDIMessageTypes {
  NOTE_OFF: 0x80;
  NOTE_ON: 0x90;
  NOTE_PRESSURE: 0xa0;
  CONTROLLER: 0xb0;
  PGM_CHANGE: 0xc0;
  CHANNEL_PRESSURE: 0xd0;
  PITCH_BEND: 0xe0;
  SYSTEM_EXCLUSIVE: 0xf0;
  SYSTEM_EXCLUSIVE_REAL_TIME: 0x7f;
  SONG_POS: 0xf2;
  SONG_SELECT: 0xf3;
  TUNE_REQUEST: 0xf6;
  CLOCK: 0xf8;
  START: 0xfa;
  CONTINUE: 0xfb;
  STOP: 0xfc;
}
