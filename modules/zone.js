module.exports = class Zone {
  static solocount = 0;
  channel = 0; // 0-based
  enabled = true;
  _solo = false;
  programchange = false;
  low = 0;
  high = 127;
  octave = 0;
  fixedvel = false;
  mod = true;
  sustain = true;
  cc = true;
  pitchbend = true;
  arp_enabled = false;
  arp_direction = 0; // 0=UP, 1=DOWN, 2=UP/DOWN, 3=RANDOM, 4=ORDER
  _arp_octaves = 0;
  _arp_division = 6;
  arp_ticks = DIV_TICKS[6];
  arp_gatelength = 0.5;
  arp_repeat = 0;
  arp_velocity = 0; // 0 = as played
  arp_hold = false;
  arp = {
    // holdlist: [],
    orderlist: [],
    sortedlist: [],
    // holdcount: 0,
    noteindex: -1,
    inc: 1,
    lastnote: null,
    repeattrig: false,
    repeatnote: null,
    beat: false
  };
  activeNotes = [];
  holdList = [];
  canvasElement = null;
  midi = null;
  dom = {};

  constructor(midi) {
    this.midi = midi;
  }

  toJSON() {
    return {
      channel: this.channel,
      enabled: this.enabled,
      solo: this.solo,
      programchange: this.programchange,
      low: this.low,
      high: this.high,
      octave: this.octave,
      fixedvel: this.fixedvel,
      mod: this.mod,
      sustain: this.sustain,
      cc: this.cc,
      pitchbend: this.pitchbend,
      arp_enabled: this.arp_enabled,
      arp_direction: this.arp_direction,
      arp_octaves: this._arp_octaves,
      arp_division: this._arp_division,
      arp_gatelength: this.arp_gatelength,
      arp_repeat: this.arp_repeat
    };
  }

  get arp_division() {
    return this._arp_division;
  }

  set arp_division(v) {
    this._arp_division = v;
    this.arp_ticks = DIV_TICKS[v];
  }

  get arp_octaves() {
    return this._arp_octaves;
  }

  set arp_octaves(v) {
    this._arp_octaves = v;
    this.notesChanged();
  }

  get solo() {
    return this._solo;
  }

  set solo(v) {
    if (this._solo !== v) {
      if (this._solo) {
        Zone.solocount--;
      } else {
        Zone.solocount++;
      }
      this._solo = v;
    }
  }

  addNote(note) {
    if (this.activeNotes.length === 0) {
      this.holdList = [];
    }
    this.activeNotes.push(note);
    this.holdList.push(note);
  }

  removeNote(number) {
    let index = -1;
    for (let i = 0; i < this.activeNotes.length; i++) {
      if (this.activeNotes[i].number === number) {
        index = i;
        break;
      }
    }
    if (index > -1) {
      this.activeNotes.splice(index, 1);
    } else {
      console.log(`Zone.removeNote: Note ${number} not found`);
    }
  }

  handleMidi(message, data, midiOutDevice) {
    if (this.enabled && (Zone.solocount === 0 || this.solo)) {
      switch (message) {
        case MIDI_MESSAGE.NOTE_OFF: // note off
        case MIDI_MESSAGE.NOTE_ON: // note on
          let key = data[1];
          let velo = data[2];
          if (key >= this.low && key <= this.high) {
            key = key + this.octave * 12;
            if (key >= 0 && key <= 127) {
              if (this.fixedvel && velo > 0) {
                velo = 127;
              }
              if (!this.arp_enabled) {
                const outevent = new Uint8Array(data);
                outevent[0] = message + this.channel;
                outevent[1] = key;
                outevent[2] = velo;
                midiOutDevice.send(outevent);
              }
            }
          }
          if (message === MIDI_MESSAGE.NOTE_ON) {
            this.addNote(new Note(key, velo));
          } else {
            this.removeNote(key);
          }
          this.notesChanged();
          break;
        case MIDI_MESSAGE.CONTROLLER: // cc
          if (data[1] == 0x40 && !this.sustain) {
            // no sustain pedal
            return;
          }
          if (data[1] == 0x01 && !this.mod) {
            // no mod wheel
            return;
          }
          if (!this.cc && data[1] != 0x40 && data[1] != 0x01) {
            // no ccs in general
            return;
          }
          const outevent = new Uint8Array(data);
          outevent[0] = message + this.channel;
          midiOutDevice.send(outevent);
          break;
        case MIDI_MESSAGE.PITCH_BEND: // pitch bend
          if (this.pitchbend) {
            const outevent = new Uint8Array(data);
            outevent[0] = message + this.channel;
            midiOutDevice.send(outevent);
          }
          break;
        case MIDI_MESSAGE.PGM_CHANGE: // prgm change
          if (this.programchange) {
            const outevent = new Uint8Array(data);
            outevent[0] = message + this.channel;
            midiOutDevice.send(outevent);
          }
          break;
        default: {
          const outevent = new Uint8Array(data);
          outevent[0] = message + this.channel;
          midiOutDevice.send(outevent);
        }
      }
    }
  }

  notesChanged() {
    this.arp.orderlist = Array.from(this.activeNotes);
    for (let i = 0; i < this._arp_octaves; i++) {
      // add arp octaves
      for (let j = 0; j < this.activeNotes.length; j++) {
        const note = this.activeNotes[j];
        this.arp.orderlist.push(
          new Note(note.number + 12 * (i + 1), note.velo)
        );
      }
    }
    this.arp.sortedlist = Array.from(this.arp.orderlist).sort(
      (a, b) => a.number - b.number
    );
    this.arp.sortedHoldList = Array.from(this.holdList).sort(
      (a, b) => a.number - b.number
    );

    requestAnimationFrame(this.renderNotes.bind(this));
  }

  renderNotes() {
    if (this.canvasElement) {
      this.canvasElement.width = this.canvasElement.parentElement.offsetWidth;
      const ctx = this.canvasElement.getContext('2d');
      const cwidth = this.canvasElement.width;
      ctx.clearRect(0, 0, cwidth, this.canvasElement.height);
      ctx.fillStyle = this.arp_enabled
        ? 'rgba(0,0,0,.5)'
        : 'rgba(255,255,255,.5)';
      const list = this.arp_hold ? this.holdList : this.activeNotes;
      for (let i = 0; i < list.length; i++) {
        const number = list[i].number;
        ctx.fillRect((cwidth * number) / 127, 0, 5, 16);
      }
      if (this.arp_enabled) {
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        const note = this.arp.lastnote;
        if (note) {
          ctx.fillRect((cwidth * note.number) / 127, 0, 5, 16);
        }
      }
    }
  }

  clock(pos) {
    const tickn = pos % this.arp_ticks;
    if (tickn === 0) {
      if (this.arp_enabled) {
        this.arp.beat = true;
        let notes;
        if (this.arp_hold) {
          notes = Array.from(
            this.arp_direction > 2 ? this.holdList : this.arp.sortedHoldList
          );
        } else {
          notes = Array.from(
            this.arp_direction > 2 ? this.arp.orderlist : this.arp.sortedlist
          );
        }
        if (notes.length > 0 /*&& (zones.solocount === 0 || this.solo)*/) {
          // send next note
          const repetition = this.arp_repeat && this.arp.repeattrig;
          if (!repetition) {
            switch (this.arp_direction) {
              case 0: // up
              case 4: // order
                this.arp.noteindex = (this.arp.noteindex + 1) % notes.length;
                break;
              case 1: // down
                this.arp.noteindex--;
                if (this.arp.noteindex < 0) {
                  this.arp.noteindex = notes.length - 1;
                }
                break;
              case 2: // updown
                this.arp.noteindex += this.arp.inc;
                if (this.arp.noteindex >= notes.length - 1) {
                  this.arp.inc = -1;
                  if (this.arp.noteindex > notes.length - 1) {
                    this.arp.noteindex = Math.max(notes.length - 1, 0);
                  }
                } else if (this.arp.noteindex < 1) {
                  this.arp.inc = 1;
                }
                break;
              case 3: // random
                this.arp.noteindex = parseInt(Math.random() * notes.length);
                break;
            }
          }
          if (this.arp.noteindex > -1 && this.arp.noteindex < notes.length) {
            const activeNote = repetition
              ? this.arp.repeatnote
              : notes[this.arp.noteindex];
            let number = repetition
              ? activeNote.number
              : activeNote.number + this.octave * 12;
            while (number > 127) number -= 12;
            while (number < 0) number += 12;
            const note = new Note(number, activeNote.velo);
            this.arp.lastnote = note;
            this.midi.send(
              Uint8Array.from([
                MIDI_MESSAGE.NOTE_ON + this.channel,
                note.number,
                this.fixedvel ? 127 : note.velo
              ])
            );
          }
        }
        this.arp.repeattrig = !this.arp.repeattrig;
        requestAnimationFrame(this.renderNotes.bind(this));
      }
    } else if (tickn > this.arp_ticks * this.arp_gatelength) {
      this.arp.beat = false;
      if (this.arp.lastnote) {
        // send note off
        const note = this.arp.lastnote;
        this.midi.send(
          Uint8Array.from([
            MIDI_MESSAGE.NOTE_OFF + this.channel,
            note.number,
            note.velo
          ])
        );
        this.arp.lastnote = null;
        this.arp.repeatnote = note;
      }
      requestAnimationFrame(this.renderNotes.bind(this));
    }
  }
};
