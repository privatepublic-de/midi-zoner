const seedrandom = require('seedrandom');
const DOM = require('./domutils');
const MIDI = require('./midi');
const DIV_TICKS = [
  192, 144, 96, 72, 64, 48, 36, 32, 24, 18, 16, 12, 9, 8, 6, 4, 3, 2
]; // 24ppq
const COLOR_PALETTE = [
  DOM.rgb2hsl(DOM.hexToRgb('2A4F5F')),
  DOM.rgb2hsl(DOM.hexToRgb('2A9D8F')),
  DOM.rgb2hsl(DOM.hexToRgb('E9C46A')),
  DOM.rgb2hsl(DOM.hexToRgb('F4A261')),
  DOM.rgb2hsl(DOM.hexToRgb('E76F51'))
];

const note_fill = 'rgba(255,255,255,.6)';
const note_fill_arp = 'rgba(0,0,0,.2)';
const note_fill_arp_played = 'rgba(255,255,255,.7)';
const note_fill_black = 'rgba(255,255,255,.4)';
const note_top = 8;
const note_top_black = 4;
const note_height = 12;
const note_height_black = 12;

class Note {
  static isBlackKey = function (n) {
    const nn = n % 12;
    return nn == 1 || nn == 3 || nn == 6 || nn == 8 || nn == 10;
  };

  static display(number) {
    return MIDI.NOTENAMES[number % 12] + (parseInt(number / 12) - 1);
  }

  static clone(other) {
    const result = new Note(
      other.number,
      other.velo,
      other.channel,
      other.portId
    );
    result.isBlackKey = other.isBlackKey;
    return result;
  }

  static transpose(note, semitones) {
    let newnumber = note.number + semitones;
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
  constructor(number, velo, channel, portId) {
    this.number = number;
    this.velo = velo;
    this.channel = channel;
    if (portId) {
      this.portId = portId;
    }
    this.isBlackKey = Note.isBlackKey(number);
  }
}
class Zone {
  static solocount = 0;
  static seqClipboardStep = null;
  static seqClipboardSequence = null;
  static updateZoneViewEventName = 'update-zone-view';
  channel = 0; // 0-based
  preferredOutputPortId = MIDI.INTERNAL_PORT_ID;
  outputPortId = MIDI.INTERNAL_PORT_ID;
  enabled = true;
  _solo = false;
  programchange = false;
  low = 0;
  high = 127;
  octave = 0;
  fixedvel = false;
  fixedvel_value = 127;
  scale_velocity = false;
  scale_velocity_value = 100;
  mod = true;
  sustain = true;
  _sustain_on = false;
  cc = false;
  cc_controllers = [
    // type 0: unipolar, 1: bipolar, 2: spacer
    { number: 7, number_in: 7, label: 'Volume', val: 100, type: 0 },
    { number: 1, number_in: 1, label: 'Mod Wheel', val: 0, type: 0 }
  ];
  show_cc = false;
  editCC = false;
  learnCCIndex = -1;
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

  _colorIndex = null;
  hue = 0;
  saturation = 0;
  lightness = 0.3;

  pgm_no = null; // 1-based: 1-128

  rngArp = null;
  rngArpOct = null;
  rngProb = null;

  sequence = new Sequence(this);
  sequencerGridElement = null;
  sequencerGridStepElements = null;
  sequencerProgressElement = null;

  lastTouchedRangePoint = 0; // 0=none, 1=low, 2=high

  /**
   * Creates a new zone with default values.
   * @param {MIDI} midi
   */
  constructor(midi, colorIndex) {
    this.midi = midi;
    this.rngArp = seedrandom();
    this.rngArpOct = seedrandom();
    this.rngProb = seedrandom();
    this.colorIndex = colorIndex || 0;
    // this.randomizeColor(colorIndex + 1);
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
      fixedvel_value: this.fixedvel_value,
      scale_velocity: this.scale_velocity,
      scale_velocity_value: this.scale_velocity_value,
      mod: this.mod,
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
      colorIndex: this._colorIndex,
      /* hue: this.hue,
      saturation: this.saturation,
      lightness: this.lightness, */
      euclid_hits: this.euclid_hits,
      euclid_length: this.euclid_length,
      show_cc: this.show_cc,
      cc_controllers: this.cc_controllers,
      sequence: this.sequence
    };
  }

  randomizeColor(index) {
    const paletteIndex =
      typeof index == 'number'
        ? parseInt(index % COLOR_PALETTE.length)
        : this.colorIndex + 1;
    this.colorIndex = paletteIndex;
  }

  set colorIndex(i) {
    i = i % COLOR_PALETTE.length;
    this.hue = COLOR_PALETTE[i][0];
    this.saturation = COLOR_PALETTE[i][1];
    this.lightness = COLOR_PALETTE[i][2];
    this._colorIndex = i;
  }

  get colorIndex() {
    return this._colorIndex;
  }

  get configId() {
    return this.outputPortId + ',' + this.channel;
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

  get sustain_on() {
    return this._sustain_on;
  }

  set sustain_on(v) {
    this._sustain_on = v;
    this.midi.send(
      Uint8Array.from([
        MIDI.MESSAGE.CONTROLLER + this.channel,
        64,
        v ? 127 : 0
      ]),
      this.outputPortId
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
    do {
      index = -1;
      for (let i = 0; i < this.activeNotes.length; i++) {
        if (this.activeNotes[i].number === number) {
          index = i;
          break;
        }
      }
      if (index > -1) {
        this.activeNotes.splice(index, 1);
      }
    } while (index > -1);
  }

  handleMidi(message, data) {
    if (this.enabled && (Zone.solocount === 0 || this.solo)) {
      switch (message) {
        case MIDI.MESSAGE.NOTE_OFF: // note off
        case MIDI.MESSAGE.NOTE_ON: // note on
          let key = data[1];
          const srcKey = key;
          let velo = this.scale_velocity
            ? Math.max(
                1,
                Math.min(
                  127,
                  parseInt(data[2] * (this.scale_velocity_value / 100))
                )
              )
            : data[2];
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
                velo = this.fixedvel_value || 127;
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
                this.sequence.recordNote(playNote, this.activeNotes.length);
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
                this.sequence.noteReleased(this.activeNotes.length);
              }
            }
            this.notesChanged();
          }
          break;
        case MIDI.MESSAGE.CONTROLLER: // cc
          if (this.editCC && this.learnCCIndex > -1) {
            this.cc_controllers[this.learnCCIndex].number_in = data[1];
            return 'updateCC';
          }
          let handledByCCControl = false;
          for (let i = 0; i < this.cc_controllers.length; i++) {
            if (
              this.cc_controllers[i].type != 2 &&
              this.cc_controllers[i].number_in == data[1]
            ) {
              this.cc_controllers[i].val = data[2];
              const outevent = new Uint8Array(3);
              outevent[0] = MIDI.MESSAGE.CONTROLLER + this.channel;
              outevent[1] = this.cc_controllers[i].number;
              outevent[2] = data[2];
              this.midi.send(outevent, this.outputPortId);
              handledByCCControl = true;
            }
          }
          if (handledByCCControl) {
            return 'updateCC';
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
    return;
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
      /** @type {CanvasRenderingContext2D} */
      const ctx = this.canvasElement.getContext('2d');
      this.canvasElement.width = this.canvasElement.parentElement.offsetWidth;
      this.canvasElement.width =
        this.canvasElement.height *
        (this.canvasElement.clientWidth / this.canvasElement.clientHeight);
      const cwidth = this.canvasElement.width;
      const notewidth = Math.floor(cwidth / 127.0 - cwidth / 127.0 / 2.0);
      ctx.clearRect(0, 0, cwidth, this.canvasElement.height);

      function drawNote(number, isBlack, fillStyle, fillStyleBlack) {
        ctx.fillStyle = isBlack ? fillStyleBlack : fillStyle;
        ctx.fillRect(
          Math.floor((cwidth * number) / 127),
          isBlack ? note_top_black : note_top,
          notewidth,
          isBlack ? note_height_black : note_height
        );
      }

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
            drawNote(
              number,
              Note.isBlackKey(number),
              note_fill_arp,
              note_fill_arp
            );
          }
        } else {
          const number = list[i].number;
          drawNote(number, Note.isBlackKey(number), note_fill, note_fill_black);
        }
      }
      if (this.sequence.active) {
        for (let snote of this.sequence.activeNotes()) {
          const number = snote.number;
          drawNote(number, Note.isBlackKey(number), note_fill, note_fill_black);
        }
      }
      if (this.arp_enabled) {
        const note = this.arp.lastnote;
        if (note) {
          drawNote(
            note.number,
            note.isBlackKey,
            note_fill_arp_played,
            note_fill_arp_played
          );
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
      const width = (cwidth - 2) / plen;
      ctx.clearRect(0, 0, cwidth, this.patternCanvas.height);
      ctx.beginPath();

      ctx.strokeStyle = '#fff';
      ctx.rect(0, 0, cwidth, this.patternCanvas.height);
      ctx.stroke();
      ctx.lineWidth = 1;
      for (let i = 0; i < plen; i++) {
        const isCurrent = i === this.arp.patternPos;
        const color = isCurrent ? '#fff' : 'rgba(255, 255, 255, 0.34)';
        ctx.fillStyle = color;
        if (this.arp_pattern[i]) {
          ctx.fillRect(0.5 + width * i, 1, width - 0.5, 14);
        } else {
          if (isCurrent) {
            ctx.fillRect(0.5 + width * i, 15, width - 0.5, 1);
          }
        }
      }
    }
  }

  renderSequence() {
    if (this.sequence.active) {
      if (this.sequence.previousStepNumber > -1) {
        this.sequencerGridStepElements[
          this.sequence.previousStepNumber
        ].classList.remove('playhead');
      }
      if (this.sequence.currentStepNumber > -1) {
        this.sequencerGridStepElements[
          this.sequence.currentStepNumber
        ].classList.add('playhead');
      } else if (
        this.sequence.previousStepNumber == -1 &&
        this.sequence.currentStepNumber == -1
      ) {
        this.sequencerGridStepElements.forEach((e) => {
          e.classList.remove('playhead');
        });
      }
    } else {
      if (
        this.sequence.currentStepNumber > -1 &&
        this.sequence.steps.length > 0
      ) {
        this.sequencerProgressElement.value =
          ((this.sequence.currentStepNumber + 1) / this.sequence.length) * 100;
      } else {
        this.sequencerProgressElement.value = 0;
      }
    }
  }

  clock(pos) {
    this.sequence.clock(pos);
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
                this.arp.noteindex += this.arp.inc;
                // console.log(
                //   `i: ${this.arp.noteindex}/${notes.length}, inc: ${this.arp.inc}`
                // );
                if (this.arp.noteindex >= notes.length) {
                  this.arp.noteindex = this.arp.noteindex % notes.length;
                  if (this.arp.octave >= this.arp_octaves) {
                    this.arp.inc = -1;
                    this.arp.noteindex = notes.length - 2;
                    if (notes.length == 1) nextArpOctave(this.arp.inc);
                  } else {
                    nextArpOctave(this.arp.inc);
                  }
                } else if (this.arp.noteindex < 0) {
                  if (this.arp.octave == 0) {
                    this.arp.inc = 1;
                    this.arp.noteindex = 1;
                    if (notes.length == 1) nextArpOctave(this.arp.inc);
                  } else {
                    this.arp.noteindex = notes.length - 1;
                    nextArpOctave(this.arp.inc);
                  }
                }
                if (notes.length == 1) {
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
                this.fixedvel ? this.fixedvel_value || 127 : note.velo
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
    this.sequence.stopped();
    requestAnimationFrame(this.renderPattern.bind(this));
    requestAnimationFrame(this.renderSequence.bind(this));
  }

  dismiss() {
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
}

class SeqStep {
  notesArray = [];
  lastPlayedArray = [];
  length = 1;
  probability = 1;
  condition = 0;
  played = 0;
  gateLength = 1;
  toJSON() {
    return {
      notesArray: this.notesArray,
      length: this.length,
      probability: this.probability,
      condition: this.condition,
      lastPlayedArray: this.lastPlayedArray,
      gateLength: this.gateLength
    };
  }
}

class Sequence {
  static MAX_STEPS = 256;
  static CYCLE_CONDITIONS = [];
  _active = false;
  steps = [];
  _division = 14;
  ticks = DIV_TICKS[this._division];
  currentStepNumber = -1;
  previousStepNumber = -1;
  length = 16;
  zone = null;
  _selectedStep = -1;
  isHotRecordingNotes = false;
  isLiveRecoding = false;
  activeSteps = [];
  rngProb = seedrandom();
  cycleCount = -1;
  previousStepPlayed = false;
  isFirstCycle = true;
  stepAdvance = false;
  stepAddNotes = false;
  liveTargetStep = null;
  liveTargetLength = 0;
  tickn = 0;

  constructor(zone) {
    this.zone = zone;
  }

  toJSON() {
    return {
      active: this.active,
      steps: this.steps,
      ticks: this.ticks,
      length: this.length,
      division: this._division
    };
  }

  set active(v) {
    this._active = v;
    if (v && this.zone.sequencerGridStepElements) {
      requestAnimationFrame(
        (() => {
          this.zone.sequencerGridStepElements.forEach((e) => {
            e.classList.remove('playhead');
          });
        }).bind(this)
      );
    }
  }

  get active() {
    return this._active;
  }

  get division() {
    return this._division;
  }

  set division(v) {
    this._division = v;
    this.ticks = DIV_TICKS[v];
  }

  get selectedStepNumber() {
    return this._selectedStep;
  }

  get selectedStep() {
    return this._selectedStep > -1 ? this.steps[this._selectedStep] : null;
  }

  /**
   * @param {number} v
   */
  set selectedStepNumber(v) {
    this._selectedStep = v;
    if (this._selectedStep > -1) {
      this.isLiveRecoding = false;
      this.isHotRecordingNotes = true;
      // console.log('Start recording', this._selectedStep);
    } else {
      this.isHotRecordingNotes = false;
    }
    this.updateRecordingState();
  }

  recordNote(note, count) {
    if (this.isLiveRecoding && this.currentStepNumber > -1) {
      const rec2step =
        this.tickn > this.ticks * 0.8
          ? (this.currentStepNumber + 1) % this.length
          : this.currentStepNumber;
      if (this.liveTargetStep == null) {
        if (!this.steps[rec2step]) {
          this.steps[rec2step] = new SeqStep();
        }
        this.liveTargetStep = this.steps[rec2step];
        this.liveTargetLength = 1;
      }
      this.liveTargetStep.notesArray.push(note);
      this.updateRecordingState();
      this.updateZoneView();
    } else {
      if (this.isHotRecordingNotes && this.selectedStepNumber > -1) {
        let seqstep = this.steps[this.selectedStepNumber] || new SeqStep();
        if (count == 1 && !this.stepAddNotes) {
          seqstep.notesArray.length = 0;
        }
        seqstep.notesArray.push(note);
        this.steps[this.selectedStepNumber] = seqstep;
        // console.log('Recorded note', seqstep.notesArray.length, note.number);
        this.updateRecordingState();
      }
    }
  }

  noteReleased(count) {
    if (this.isLiveRecoding && this.liveTargetStep) {
      this.liveTargetStep.length = this.liveTargetLength;
      this.liveTargetStep = null;
      this.liveTargetLength = 0;
      this.updateRecordingState();
      this.updateZoneView();
    }
    if (
      this.isHotRecordingNotes &&
      this.selectedStepNumber > -1 &&
      count === 0
    ) {
      this.isHotRecordingNotes = false;
      this.selectedStep.notesArray.sort((a, b) => a.number - b.number);
      if (this.stepAdvance) {
        this.selectedStepNumber = (this.selectedStepNumber + 1) % this.length;
        this.updateZoneView();
      }
      this.updateRecordingState();
    }
  }

  updateZoneView() {
    const event = new CustomEvent(Zone.updateZoneViewEventName, {
      detail: this.zone
    });
    window.dispatchEvent(event);
  }

  updateRecordingState() {
    requestAnimationFrame(
      (() => {
        if (this.selectedStepNumber > -1) {
          const notesArray = this.steps[this.selectedStepNumber]
            ? this.steps[this.selectedStepNumber].notesArray
            : null;
          let infoText =
            '<div class="stepmarker listen-indicator">' +
            (this.selectedStepNumber + 1) +
            '</div> ';
          if (notesArray && notesArray.length > 0) {
            notesArray.forEach((note) => {
              infoText +=
                '<span class="note">' + Note.display(note.number) + '</span> ';
            });
          } else {
            infoText += '(... play notes on keyboard ...)';
          }
          this.zone.sequencerGridElement.querySelector(
            '.step-notes'
          ).innerHTML = infoText;

          if (this.isHotRecordingNotes) {
            this.zone.sequencerGridElement.classList.add('hot');
          } else {
            this.zone.sequencerGridElement.classList.remove('hot');
          }
        }
      }).bind(this)
    );
  }

  clock(pos) {
    this.tickn = pos % this.ticks;
    let refreshNotesDisplay = false;
    // check for active steps ending
    if (this.activeSteps.length > 0) {
      const clearSteps = [];
      this.activeSteps.forEach((astep) => {
        if (this.tickn === 0) astep.played++;
        const offtick = Math.min(this.ticks * astep.gateLength, this.ticks - 1);
        if (astep.length - 1 - astep.played === 0 && this.tickn >= offtick) {
          clearSteps.push(astep);
          for (let note of astep.lastPlayedArray) {
            this.zone.midi.send(
              Uint8Array.from([
                MIDI.MESSAGE.NOTE_OFF + note.channel,
                note.number,
                note.velo
              ]),
              note.portId
            );
          }
          astep.lastPlayedArray.length = 0;
          refreshNotesDisplay = true;
        }
      });
      this.activeSteps = this.activeSteps.filter(
        (item) => !clearSteps.includes(item)
      );
    }
    if (this.tickn == this.ticks / 2) {
      // quantized record note lengths
      this.liveTargetLength++;
    }
    if (this.tickn === 0) {
      this.previousStepNumber = this.currentStepNumber;
      this.currentStepNumber = (this.currentStepNumber + 1) % this.length;
      if (this.currentStepNumber === 0) {
        this.cycleCount++;
        if (this.cycleCount === 1) {
          this.isFirstCycle = false;
        }
      }
      if (this.active) {
        const currentStep = this.steps[this.currentStepNumber];
        if (this.active && currentStep) {
          if (
            this.checkCondition(currentStep) &&
            this.rngProb() < currentStep.probability
          ) {
            currentStep.played = 0;
            this.activeSteps.push(currentStep);
            // currentStep.lastPlayedArray.length = 0;
            for (let inote of currentStep.notesArray) {
              let note = Note.clone(inote);
              note.number = note.number; // + this.zone.octave * 12;
              note.channel = this.zone.channel;
              note.portId = this.zone.outputPortId;
              this.zone.midi.send(
                Uint8Array.from([
                  MIDI.MESSAGE.NOTE_ON + note.channel,
                  note.number,
                  this.zone.fixedvel ? this.zone.fixedvel_value : note.velo
                ]),
                note.portId
              );
              currentStep.lastPlayedArray.push(note);
              refreshNotesDisplay = true;
            }
            this.previousStepPlayed = true;
          } else {
            this.previousStepPlayed = false;
          }
        }
      }
      requestAnimationFrame(this.zone.renderSequence.bind(this.zone));
    }
    if (refreshNotesDisplay) {
      requestAnimationFrame(this.zone.renderNotes.bind(this.zone));
    }
  }

  stopped() {
    this.activeSteps.forEach((astep) => {
      for (let note of astep.lastPlayedArray) {
        this.zone.midi.send(
          Uint8Array.from([
            MIDI.MESSAGE.NOTE_OFF + note.channel,
            note.number,
            note.velo
          ]),
          note.portId
        );
      }
      astep.lastPlayedArray.length = 0;
    });
    this.activeSteps.length = 0;
    this.currentStepNumber = this.previousStepNumber = -1;
    this.cycleCount = -1;
    this.previousStepPlayed = false;
    this.isFirstCycle = true;
    this.liveTargetLength = 0;
    this.liveTargetStep = null;
    this.isLiveRecoding = false;
    this.updateRecordingState();
    requestAnimationFrame(this.zone.renderSequence.bind(this.zone));
    requestAnimationFrame(this.zone.renderNotes.bind(this.zone));
    this.updateZoneView();
  }

  activeNotes() {
    const result = [];
    this.activeSteps.forEach((astep) => {
      result.push(...astep.lastPlayedArray);
    });
    return result;
  }

  transpose(semitones) {
    this.steps.forEach((astep) => {
      if (astep) {
        astep.notesArray.forEach((anote) => {
          if (anote) {
            Note.transpose(anote, semitones);
          }
        });
      }
    });
  }

  checkCondition(step) {
    switch (step.condition) {
      case 0:
        return true;
      case 1:
        return this.previousStepPlayed;
      case 2:
        return !this.previousStepPlayed;
      case 3:
        return this.isFirstCycle;
      case 4:
        return !this.isFirstCycle;
    }
    const condition = Sequence.CYCLE_CONDITIONS[step.condition - 5];
    // console.log(condition, this.cycleCount, this.cycleCount % condition[0]);
    return this.cycleCount % condition[0] === condition[1] - 1;
  }
}

if (Sequence.CYCLE_CONDITIONS.length == 0) {
  for (let cycles = 2; cycles < 9; cycles++) {
    for (let b = 0; b < cycles; b++) {
      Sequence.CYCLE_CONDITIONS.push([cycles, b + 1]);
    }
  }
  console.log('Seq: Initialized cycle conditions: ', Sequence.CYCLE_CONDITIONS);
}

module.exports = {
  Zone,
  Sequence
};
