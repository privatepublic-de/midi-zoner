import { SeqStep } from './seq-step';

export class DrumLane {
  steps: (SeqStep | null)[] = [];
  note = 36;
  enabled = true;
  solo = false;
  length = 16;
  label = '';
  currentStep = -1;
  previousStep = -1;
  cycleCount = -1;
  isFirstCycle = true;
  previousStepPlayed = false;
}
