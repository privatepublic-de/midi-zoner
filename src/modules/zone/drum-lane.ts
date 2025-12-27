import { SeqStep } from './seq-step';

export class DrumLane {
  steps: (SeqStep | null)[] = [];
  note = 36;
  enabled = true;
}
