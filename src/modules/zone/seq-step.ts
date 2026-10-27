import { Note } from './note';
import { SeqStepJSON } from './interfaces';
import { ParamLock, parseLocks } from './param-locks';

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
  locks: ParamLock[] = [];
  /** Locks glide to their value over the step instead of jumping */
  slide = false;

  toJSON(): SeqStepJSON {
    const json: SeqStepJSON = {
      notesArray: this.notesArray,
      length: this.length,
      probability: this.probability,
      condition: this.condition,
      gateLength: this.gateLength,
      ratchetCount: this.ratchetCount,
      ratchetResolution: this.ratchetResolution,
      ratchetVelocityDelta: this.ratchetVelocityDelta
    };
    // Only when used, so scenes without locks stay as they were
    if (this.locks.length > 0) json.locks = this.locks;
    if (this.slide) json.slide = true;
    return json;
  }

  hasLocks(): boolean {
    return this.locks.length > 0;
  }

  /** No notes and no locks: plays nothing */
  isBlank(): boolean {
    return this.notesArray.length === 0 && this.locks.length === 0;
  }

  lockValue(address: string): number | undefined {
    return this.locks.find((l) => l.a === address)?.v;
  }

  setLock(address: string, value: number): void {
    const lock = this.locks.find((l) => l.a === address);
    if (lock) lock.v = value;
    else this.locks.push({ a: address, v: value });
  }

  removeLock(address: string): void {
    this.locks = this.locks.filter((l) => l.a !== address);
  }

  static from(cloneStep: SeqStep | SeqStepJSON | null): SeqStep {
    const result = new SeqStep();
    if (cloneStep) {
      Object.assign(result, cloneStep);
      // Own copies, validated: steps come from scene files and the clipboard too
      result.locks = parseLocks(cloneStep.locks);
      result.slide = cloneStep.slide === true;
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
