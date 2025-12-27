import MIDI = require('../midi');

export class Note {
  static WHITE_KEY_ARRAY: number[] = [];

  static {
    let whiteKeyCount = -1;
    for (let kn = 0; kn < 128; kn++) {
      if (!Note.isBlackKey(kn)) {
        whiteKeyCount++;
      }
      Note.WHITE_KEY_ARRAY[kn] = whiteKeyCount;
    }
  }

  static isBlackKey(n: number): boolean {
    const nn = n % 12;
    return nn == 1 || nn == 3 || nn == 6 || nn == 8 || nn == 10;
  }

  static nearestWhiteKeyIndex(n: number): number {
    return Note.WHITE_KEY_ARRAY[n];
  }

  static display(number: number): string {
    return MIDI.NOTENAMES[number % 12] + (Math.floor(number / 12) - 1);
  }

  static clone(other: Note): Note {
    const result = new Note(
      other.number,
      other.velo,
      other.channel,
      other.portId
    );
    result.isBlackKey = other.isBlackKey;
    return result;
  }

  static transpose(note: Note, semitones: number): void {
    const newnumber = note.number + semitones;
    if (newnumber < 128 && newnumber > -1) {
      note.number = newnumber;
      note.isBlackKey = Note.isBlackKey(note.number);
    }
  }

  number = 0;
  velo = 0;
  channel = 0;
  isBlackKey = false;
  portId = MIDI.INTERNAL_PORT_ID;

  constructor(number: number, velo: number, channel?: number, portId?: string) {
    this.number = number;
    this.velo = velo;
    this.channel = channel || 0;
    if (portId) {
      this.portId = portId;
    }
    this.isBlackKey = Note.isBlackKey(number);
  }
}
