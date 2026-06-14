import { Note } from './note';
import { SeqStepJSON } from './interfaces';

export class SeqStep {
  notesArray: Note[] = [];
  lastPlayedArray: Note[] = [];
  length = 1;
  probability = 1;
  condition = 0;
  played = 0;
  gateLength = 1;
  ratchetCount = 1;
  ratchetResolution = 6;
  ratchetVelocityDelta = 0;

  toJSON(): SeqStepJSON {
    return {
      notesArray: this.notesArray,
      length: this.length,
      probability: this.probability,
      condition: this.condition,
      gateLength: this.gateLength,
      ratchetCount: this.ratchetCount,
      ratchetResolution: this.ratchetResolution,
      ratchetVelocityDelta: this.ratchetVelocityDelta
    };
  }

  static from(cloneStep: SeqStep | null): SeqStep {
    const result = new SeqStep();
    if (cloneStep) {
      Object.assign(result, cloneStep);
    }
    result.lastPlayedArray = [];
    return result;
  }

  static addNote(notesArray: Note[], note: Note): boolean {
    if (!notesArray.some((n) => n.number === note.number)) {
      notesArray.push(note);
      notesArray.sort((a, b) => a.number - b.number);
      return true;
    }
    return false;
  }
}
