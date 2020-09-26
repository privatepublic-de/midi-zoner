const seedrandom = require('seedrandom');
const MIDI = require('./midi');
const DIV_TICKS = [
  192,
  144,
  96,
  72,
  64,
  48,
  36,
  32,
  24,
  18,
  16,
  12,
  9,
  8,
  6,
  4,
  3,
  2
]; // 24ppq

class Note {
  number = 0;
  velo = 0;
  channel = 0;
  portId = '*';
  constructor(number, velo, channel, portId) {
    this.number = number;
    this.velo = velo;
    this.channel = channel;
    if (portId) {
      this.portId = portId;
    }
  }
}

module.exports = class Zone {
  static solocount = 0;
  channel = 0; // 0-based
  preferredOutputPortId = '*';
  outputPortId = '*';
  enabled = true;
  _solo = false;
  programchange = false;
  low = 0;
  high = 127;
  octave = 0;
  fixedvel = false;
  mod = true;
  _sendClock = false;
  sustain = true;
  cc = true;
  cc_controllers = [
    { number: 7, label: 'Volume', val: 100, isBipolar: false },
    { number: 1, label: 'Wheel', val: 0, isBipolar: false }
  ];
  show_cc = false;
  at2mod = false;
  pitchbend = true;
  euclid_hits = 5;
  euclid_length = 8;
  arp_enabled = false;
  arp_direction = 0; // 0=UP, 1=DOWN, 2=UP/DOWN, 3=RANDOM, 4=ORDER
  _arp_octaves = 0;
  _arp_division = 8;
  arp_ticks = DIV_TICKS[8];
  arp_gatelength = 0.5;
  arp_repeat = 0;
  arp_probability = 1;
  arp_velocity = 0; // 0 = as played
  arp_hold = false;
  arp_transpose = false;
  arp_transpose_amount = 0;
  arp_pattern = [true, true, true, true, true, true, true, true];
  arp_holdlist = [];
  arp_sortedHoldList = [];
  arp = {
    orderlist: [],
    sortedlist: [],
    noteindex: -1,
    patternPos: -1,
    inc: 1,
    lastnote: null,
    repeattrig: false,
    repeatnote: null,
    beat: false,
    octave: 0
  };
  activeNotes = [];
  midiActiveNotes = [];
  holdList = [];
  canvasElement = null;
  patternCanvas = null;
  /** @type {MIDI} */
  midi = null;
  dom = {};
  hue = 0;
  saturation = 0;
  lightness = 0.3;
  pgm_no = null; // 1-based: 1-128

  rngArp = null;
  rngArpOct = null;
  rngProb = null;

  /**
   * Creates a new zone with default values.
   * @param {MIDI} midi
   */
  constructor(midi) {
    this.midi = midi;
    this.rngArp = seedrandom();
    this.rngArpOct = seedrandom();
    this.rngProb = seedrandom();
    this.randomizeColor();
  }

  toJSON() {
    return {
      channel: this.channel,
      preferredOutputPortId: this.preferredOutputPortId,
      enabled: this.enabled,
      solo: this.solo,
      programchange: this.programchange,
      low: this.low,
      high: this.high,
      octave: this.octave,
      fixedvel: this.fixedvel,
      mod: this.mod,
      sendClock: this.sendClock,
      sustain: this.sustain,
      cc: this.cc,
      at2mod: this.at2mod,
      pitchbend: this.pitchbend,
      arp_enabled: this.arp_enabled,
      arp_hold: this.arp_hold,
      arp_direction: this.arp_direction,
      arp_octaves: this._arp_octaves,
      arp_division: this._arp_division,
      arp_gatelength: this.arp_gatelength,
      arp_repeat: this.arp_repeat,
      arp_probability: this.arp_probability,
      arp_pattern: this.arp_pattern,
      arp_holdlist: this.arp_holdlist,
      arp_sortedHoldList: this.arp_sortedHoldList,
      hue: this.hue,
      saturation: this.saturation,
      lightness: this.lightness,
      euclid_hits: this.euclid_hits,
      euclid_length: this.euclid_length,
      show_cc: this.show_cc,
      cc_controllers: this.cc_controllers
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
    requestAnimationFrame(this.renderNotes.bind(this));
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

  get sendClock() {
    return this._sendClock;
  }

  set sendClock(v) {
    this._sendClock = v;
    this.midi.updateClockOutputReceiver(
      this.outputPortId != '*' ? this.outputPortId : this.preferredOutputPortId,
      this._sendClock
    );
  }

  addNote(note) {
    if (this.activeNotes.length === 0) {
      this.holdList = [];
    }
    this.activeNotes.push(note);
    const existingIndex = this.holdList.findIndex(
      (n) => n.number == note.number
    );
    if (existingIndex == -1) {
      this.holdList.push(note);
    } else {
      this.holdList[existingIndex] = note;
    }
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

  handleMidi(message, data) {
    let resultMessage = null;
    if (this.enabled && (Zone.solocount === 0 || this.solo)) {
      switch (message) {
        case MIDI.MESSAGE.NOTE_OFF: // note off
        case MIDI.MESSAGE.NOTE_ON: // note on
          let key = data[1];
          const srcKey = key;
          let velo = data[2];
          if (key >= this.low && key <= this.high) {
            if (this.arp_enabled && this.arp_hold && this.arp_transpose) {
              // transposer zone
              this.arp_transpose_amount = ((key + 12) % 24) - 12;
              requestAnimationFrame(this.renderNotes.bind(this));
              return null;
            }
            key = key + (this.arp_enabled ? 0 : this.octave * 12);
            if (key >= 0 && key <= 127) {
              if (this.fixedvel && velo > 0) {
                velo = 127;
              }

              const outevent = new Uint8Array(data);
              if (message == MIDI.MESSAGE.NOTE_ON) {
                if (!this.arp_enabled) {
                  outevent[0] = message + this.channel;
                  outevent[1] = key;
                  outevent[2] = velo;
                  this.midi.send(outevent, this.outputPortId);
                }
                const playNote = new Note(
                  key,
                  velo,
                  this.channel,
                  this.outputPortId
                );
                this.midiActiveNotes[srcKey] = playNote;
                this.addNote(playNote);
              } else {
                const srcNote = this.midiActiveNotes[srcKey];
                if (srcNote) {
                  this.midiActiveNotes[srcKey] = null;
                  this.removeNote(srcNote.number);
                  if (!this.arp_enabled) {
                    outevent[0] = message + srcNote.channel;
                    outevent[1] = srcNote.number;
                    outevent[2] = velo;
                    this.midi.send(outevent, this.outputPortId);
                  }
                } else {
                  console.log(`No src note for ${srcKey}, clearing ${key}`);
                  this.removeNote(key);
                }
              }
            }
            this.notesChanged();
          }
          break;
        case MIDI.MESSAGE.CONTROLLER: // cc
          for (let i = 0; i < this.cc_controllers.length; i++) {
            if (this.cc_controllers[i].number == data[1]) {
              this.cc_controllers[i].val = data[2];
              resultMessage = 'updateCC';
            }
          }
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
          this.midi.send(outevent, this.outputPortId);
          break;
        case MIDI.MESSAGE.PITCH_BEND: // pitch bend
          if (this.pitchbend) {
            const outevent = new Uint8Array(data);
            outevent[0] = message + this.channel;
            this.midi.send(outevent, this.outputPortId);
          }
          break;
        case MIDI.MESSAGE.PGM_CHANGE: // prgm change
          if (this.programchange) {
            const outevent = new Uint8Array(data);
            outevent[0] = message + this.channel;
            this.midi.send(outevent, this.outputPortId);
          }
          break;
        case MIDI.MESSAGE.CHANNEL_PRESSURE:
          if (this.at2mod) {
            const outevent = new Uint8Array(3);
            outevent[0] = MIDI.MESSAGE.CONTROLLER + this.channel;
            outevent[1] = 1;
            outevent[2] = data[1];
            this.midi.send(outevent, this.outputPortId);
            break;
          }
        default: {
          const outevent = new Uint8Array(data);
          outevent[0] = message + this.channel;
          this.midi.send(outevent, this.outputPortId);
        }
      }
    }
    return resultMessage;
  }

  notesChanged() {
    if (this.enabled) {
      this.arp.orderlist = Array.from(this.activeNotes);
      this.arp_holdlist = Array.from(this.holdList);
      this.arp.sortedlist = Array.from(this.arp.orderlist).sort(
        (a, b) => a.number - b.number
      );
      this.arp_sortedHoldList = Array.from(this.arp_holdlist).sort(
        (a, b) => a.number - b.number
      );
    }
    requestAnimationFrame(this.renderNotes.bind(this));
  }

  renderNotes() {
    if (this.canvasElement) {
      this.canvasElement.width = this.canvasElement.parentElement.offsetWidth;
      /** @type {CanvasRenderingContext2D} */
      const ctx = this.canvasElement.getContext('2d');
      this.canvasElement.width =
        this.canvasElement.height *
        (this.canvasElement.clientWidth / this.canvasElement.clientHeight);
      const cwidth = this.canvasElement.width;
      const notewidth = cwidth / 127 - cwidth / 127 / 3;
      ctx.clearRect(0, 0, cwidth, this.canvasElement.height);
      ctx.fillStyle = this.arp_enabled
        ? 'rgba(0,0,0,.2)'
        : 'rgba(255,255,255,.6)';
      // ctx.strokeStyle = 'rgba(0,0,0,.75)';
      const list =
        this.arp_hold && this.arp_enabled
          ? this.arp_holdlist
          : this.activeNotes;
      for (let i = 0; i < list.length; i++) {
        if (this.arp_enabled) {
          for (let ao = 0; ao < this.arp_octaves + 1; ao++) {
            const number =
              list[i].number +
              (this.arp_transpose ? this.arp_transpose_amount : 0) +
              (this.octave + ao) * 12;
            ctx.fillRect((cwidth * number) / 127, 0, notewidth, 16);
          }
        } else {
          const number = list[i].number;
          ctx.fillRect((cwidth * number) / 127, 0, notewidth, 16);
        }
      }
      if (this.arp_enabled) {
        const note = this.arp.lastnote;
        if (note) {
          ctx.fillStyle = 'rgba(255,255,255,.7)';
          ctx.fillRect((cwidth * note.number) / 127, 0, notewidth, 16);
        }
      }
    }
  }

  renderPattern() {
    if (this.patternCanvas) {
      /** @type {CanvasRenderingContext2D} */
      const ctx = this.patternCanvas.getContext('2d');
      const cwidth = this.patternCanvas.width;
      const plen = this.arp_pattern.length;
      const width = cwidth / plen;
      let radius = width / 2 - 1;
      if (radius > 7) {
        radius = 7;
      }
      ctx.clearRect(0, 0, cwidth, this.patternCanvas.height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3';
      for (let i = 0; i < plen; i++) {
        if (i === this.arp.patternPos) {
          ctx.fillStyle = 'rgba(255,255,255,.15)';
          ctx.fillRect(width * i, 0, width, 16);
        }
        // ctx.arc(width * (i + 0.5), 8, radius, 0, 2 * Math.PI);
        if (this.arp_pattern[i]) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
          ctx.fillRect(width * i + 1, 1, width - 2, 16 - 2);
          // ctx.fill();
        } else {
          // ctx.stroke();
          ctx.beginPath();
          ctx.rect(width * i + 2, 2, width - 4, 16 - 4);
          ctx.stroke();
        }
      }
    }
  }

  clock(pos) {
    const tickn = pos % this.arp_ticks;
    const offtick = Math.min(
      this.arp_ticks * this.arp_gatelength,
      this.arp_ticks - 1
    );
    if (tickn === 0) {
      const probable = this.rngProb() < this.arp_probability;
      this.arp.patternPos = (this.arp.patternPos + 1) % this.arp_pattern.length;
      if (this.arp_enabled && this.arp_pattern[this.arp.patternPos]) {
        this.arp.beat = true;
        let notes;
        if (this.arp_hold) {
          notes = Array.from(
            this.arp_direction > 2 ? this.arp_holdlist : this.arp_sortedHoldList
          );
        } else {
          notes = Array.from(
            this.arp_direction > 2 ? this.arp.orderlist : this.arp.sortedlist
          );
        }
        if (notes.length > 0) {
          const repetition = this.arp_repeat && this.arp.repeattrig;
          if (!repetition) {
            const nextArpOctave = (dir) => {
              let noct = this.arp.octave + dir;
              if (noct < 0) {
                noct = this.arp_octaves;
              } else if (noct > this.arp_octaves) {
                noct = 0;
              }
              this.arp.octave = noct;
            };
            switch (this.arp_direction) {
              case 0: // up
              case 4: // order
                this.arp.noteindex++;
                if (this.arp.noteindex >= notes.length) {
                  this.arp.noteindex = 0;
                  nextArpOctave(1);
                }
                break;
              case 1: // down
                this.arp.noteindex--;
                if (this.arp.noteindex < 0) {
                  this.arp.noteindex = notes.length - 1;
                  nextArpOctave(-1);
                }
                break;
              case 2: // updown
                if (notes.length > 1) {
                  this.arp.noteindex += this.arp.inc;
                  if (this.arp.noteindex >= notes.length) {
                    this.arp.noteindex = this.arp.noteindex % notes.length;
                    if (this.arp.octave == this.arp_octaves) {
                      this.arp.inc = -1;
                      this.arp.noteindex = notes.length - 2;
                    } else {
                      nextArpOctave(this.arp.inc);
                    }
                  } else if (this.arp.noteindex < 0) {
                    if (this.arp.octave == 0) {
                      this.arp.inc = 1;
                      this.arp.noteindex = 1;
                    } else {
                      this.arp.noteindex = notes.length - 1;
                      nextArpOctave(this.arp.inc);
                    }
                  }
                } else {
                  this.arp.noteindex = 0;
                }
                break;
              case 3: // random
                this.arp.noteindex = Math.floor(this.rngArp() * notes.length);
                this.arp.octave = Math.floor(
                  this.rngArpOct() * (this.arp_octaves + 1)
                );
                break;
            }
          }
          if (
            probable &&
            this.arp.noteindex > -1 &&
            this.arp.noteindex < notes.length
          ) {
            const activeNote = repetition
              ? this.arp.repeatnote
              : notes[this.arp.noteindex];
            let number = repetition
              ? activeNote.number
              : activeNote.number +
                (this.octave + this.arp.octave) * 12 +
                (this.arp_transpose ? this.arp_transpose_amount : 0);
            while (number > 127) number -= 12;
            while (number < 0) number += 12;
            const note = new Note(
              number,
              activeNote.velo,
              this.channel,
              this.outputPortId
            );
            this.arp.lastnote = note;
            this.midi.send(
              Uint8Array.from([
                MIDI.MESSAGE.NOTE_ON + this.channel,
                note.number,
                this.fixedvel ? 127 : note.velo
              ]),
              this.outputPortId
            );
          }
        }
        this.arp.repeattrig = !this.arp.repeattrig;
        requestAnimationFrame(this.renderNotes.bind(this));
      }
      requestAnimationFrame(this.renderPattern.bind(this));
    } else if (tickn >= offtick) {
      this.arp.beat = false;
      this.arpNoteOff();
    }
  }

  arpNoteOff() {
    if (this.arp.lastnote) {
      // send note off
      const note = this.arp.lastnote;
      this.midi.send(
        Uint8Array.from([
          MIDI.MESSAGE.NOTE_OFF + note.channel,
          note.number,
          note.velo
        ]),
        note.portId
      );
      this.arp.lastnote = null;
      this.arp.repeatnote = note;
      requestAnimationFrame(this.renderNotes.bind(this));
    }
  }

  stopped() {
    this.arp.noteindex = -1;
    this.arp.patternPos = -1;
    this.arp.repeattrig = false;
    this.arp.inc = 1;
    this.arp.octave = 0;
    this.arpNoteOff();
    requestAnimationFrame(this.renderPattern.bind(this));
  }

  dismiss() {
    this.sendClock = false;
    this.solo = false;
    this.arp_enabled = false;
    this.enabled = false;
    this.arpNoteOff();
    const outevent = new Uint8Array([0, 0, 0]);
    this.activeNotes.forEach((n) => {
      outevent[0] = MIDI.MESSAGE.NOTE_OFF + n.channel;
      outevent[1] = n.number;
      this.midi.send(outevent, this.outputPortId);
    });
  }

  panic() {
    this.activeNotes = [];
    this.midiActiveNotes = [];
    this.holdList = [];
    this.notesChanged();
  }

  randomizeColor() {
    this.hue = Math.random();
    this.saturation = Math.random() * 0.9;
    this.lightness = 0.2 + Math.random() * 0.2;
  }

  createEuclidianPattern(length, hits) {
    this.euclid_length = length;
    this.euclid_hits = hits;
    const s = hits / length;
    const result = [];
    let previous = -1;
    for (let i = 0; i < length; i++) {
      let current = Math.floor(i * s);
      result.push(current != previous);
      previous = current;
    }
    this.arp_pattern = result;
    this.renderPattern();
  }

  sendCC(index) {
    this.midi.send(
      Uint8Array.from([
        MIDI.MESSAGE.CONTROLLER + this.channel,
        this.cc_controllers[index].number,
        this.cc_controllers[index].val
      ]),
      this.outputPortId
    );
  }

  sendProgramChange() {
    if (this.pgm_no) {
      this.midi.sendProgramChange(
        this.outputPortId,
        this.channel,
        this.pgm_no - 1
      );
    }
  }

  sendAllCC() {
    for (let i = 0; i < this.cc_controllers.length; i++) {
      this.sendCC(i);
    }
  }
};
