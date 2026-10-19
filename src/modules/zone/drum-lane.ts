import { SeqStep } from './seq-step';
import { DrumLaneJSON } from './interfaces';

export class DrumLane {
  steps: (SeqStep | null)[] = [];
  note = 36;
  enabled = true;
  solo = false;
  length = 16;
  label = '';
  // Playback state, not saved
  currentStep = -1;
  previousStep = -1;
  cycleCount = -1;
  isFirstCycle = true;
  previousStepPlayed = false;

  toJSON(): DrumLaneJSON {
    return {
      steps: this.steps,
      note: this.note,
      enabled: this.enabled,
      solo: this.solo,
      length: this.length,
      label: this.label
    };
  }

  /**
   * Lane from saved or clipboard data. Missing fields get the defaults (`length`
   * falls back to `defaultLength`); playback state comes from `playing` when a
   * lane is replaced while the sequence runs, so it stays in time.
   */
  static from(data: any, defaultLength: number, playing?: DrumLane | null): DrumLane {
    const lane = new DrumLane();
    lane.steps = (data.steps || []).map((st: any) => (st ? SeqStep.from(st) : null));
    lane.note = data.note ?? lane.note;
    lane.enabled = data.enabled ?? lane.enabled;
    lane.solo = data.solo ?? lane.solo;
    lane.length = data.length ?? defaultLength;
    lane.label = data.label ?? '';
    if (playing) {
      lane.currentStep = playing.currentStep;
      lane.previousStep = playing.previousStep;
      lane.cycleCount = playing.cycleCount;
      lane.isFirstCycle = playing.isFirstCycle;
    }
    return lane;
  }
}
