import { Note } from './note';

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
