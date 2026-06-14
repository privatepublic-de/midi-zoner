import { SeqStep } from './seq-step';
import { DrumLane } from './drum-lane';
import { SeqLayerJSON } from './interfaces';

export type DivTick = 192 | 144 | 96 | 72 | 64 | 48 | 36 | 32 | 24 | 18 | 16 | 12 | 9 | 8 | 6 | 4 | 3 | 2;

export const DIV_TICKS: DivTick[] = [
  192, // 2/1
  144, // 1/1.
  96, // 1/1
  72, // 1/2.
  64, // 1/1t
  48, // 1/2
  36, // 1/4.
  32, // 1/2t
  24, // 1/4
  18, // 1/8.
  16, // 1/4t
  12, // 1/8
  9, // 1/16.
  8, // 1/8t
  6, // 1/16
  4, // 1/16t
  3, // 1/32
  2 // 1/32t
]; // 24ppq

export class SeqLayer {
  steps: (SeqStep | null)[] = [];
  division = 14;
  ticks = DIV_TICKS[this.division];
  length = 16;
  drum_lanes: DrumLane[] = [];

  toJSON(): SeqLayerJSON {
    return {
      steps: this.steps,
      length: this.length,
      ticks: this.ticks,
      division: this.division,
      drum_lanes: this.drum_lanes
    };
  }
}
