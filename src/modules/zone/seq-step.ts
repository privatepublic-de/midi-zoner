import { Note } from './note';

export class SeqStep {
  notesArray: Note[] = [];
  lastPlayedArray: Note[] = [];
  length = 1;
  probability = 1;
  condition = 0;
  played = 0;
  gateLength = 1;

  toJSON(): object {
    return {
      notesArray: this.notesArray,
      length: this.length,
      probability: this.probability,
      condition: this.condition,
      lastPlayedArray: this.lastPlayedArray,
      gateLength: this.gateLength
    };
  }

  static from(cloneStep: SeqStep | null): SeqStep {
    const result = new SeqStep();
    if (cloneStep) {
      Object.assign(result, cloneStep);
    }
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
