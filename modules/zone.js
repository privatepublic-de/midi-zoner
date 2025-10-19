const seedrandom = require('seedrandom');
const MIDI = require('./midi');
const DIV_TICKS = [
  192, // 2/1
  144, // 1/1.
  96, // 1/1
  72, // 1/2.
  64, // 1/1t
  48, // 1/2
  36, // 1/4.
  32, // 1/2t
  24, // 1/4
  18, // 1/8.
  16, // 1/4t
  12, // 1/8
  9, // 1/16.
  8, // 1/8t
  6, // 1/16
  4, // 1/32.
  3, // 1/32
  2 // 1/16t
]; // 24ppq

const note_fill = 'rgba(255,255,255,1)';
const note_fill_arp = 'rgba(0,0,0,.2)';
const note_fill_arp_black = 'rgba(0,0,0,.2)';
const note_fill_arp_played = 'rgba(255,255,196,1)';
const note_fill_black = 'rgba(0,0,0,1)';
const note_top = 2;
const note_height = 16;
const note_height_black = 13;

class Note {
  static WHITE_KEY_ARRAY = [];
  static isBlackKey(n) {
    const nn = n % 12;
    return nn == 1 || nn == 3 || nn == 6 || nn == 8 || nn == 10;
  }

  static nearestWhiteKeyIndex(n) {
    return Note.WHITE_KEY_ARRAY[n];
  }

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

// Initialize whitekey index numbers
let whiteKeyCount = -1;
for (let kn = 0; kn < 128; kn++) {
  if (!Note.isBlackKey(kn)) {
    whiteKeyCount++;
  }
  Note.WHITE_KEY_ARRAY[kn] = whiteKeyCount;
}

class Zone {
  static solocount = 0;
  /** @type {Map} */
  static seqClipboardStep = null;
  static seqClipboardSequence = null;
  static updateZoneViewEventName = 'update-zone-view';

  static scaledCanvasContext(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    // Set the "actual" size of the canvas
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    // Scale the context to ensure correct drawing operations
    ctx.scale(dpr, dpr);
    return { context: ctx, rect: rect };
  }

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
  velocity_scaling = 1;
  mod = true;
  sustain = true;
  _sustain_on = false;
  cc = false;
  cc_controllers = [
    // type 0: unipolar, 1: bipolar, 2: spacer, 3: button, 4: note2cc, 5: unipolar 14bit, 6: bipolar 14bit
    {
      number: 7,
      number_in: null,
      label: 'Volume',
      val: 100,
      type: 0,
      min: 0,
      max: 127,
      note_cc: null,
      velocity_cc: null
    },
    {
      number: 1,
      number_in: null,
      label: 'Mod Wheel',
      val: 0,
      type: 0,
      min: 0,
      max: 127,
      note_cc: null,
      velocity_cc: null
    }
  ];
  show_cc = false;
  editCC = false;
  selectedCCIndex = 0;
  at2mod = false;
  pitchbend = true;
  euclid_hits = 5;
  euclid_length = 8;
  arp_enabled = false;
  arp_direction = 0; // 0=UP, 1=DOWN, 2=UP/DOWN, 3=RANDOM, 4=ORDER
  _arp_octaves = 0;
  _arp_division = 11;
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

  /** @type {MIDI} */
  midi = null;

  /** @type {ZoneElements} */
  elements = new ZoneElements();

  _colorIndex = null;
  pgm_no = null; // 1-based: 1-128

  rngArp = null;
  rngArpOct = null;
  rngProb = null;

  sequence = new Sequence(this);
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
      velocity_scaling: this.velocity_scaling,
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
      euclid_hits: this.euclid_hits,
      euclid_length: this.euclid_length,
      show_cc: this.show_cc,
      cc_controllers: this.cc_controllers,
      sequence: this.sequence
    };
  }

  _$(selector) {
    return this.elements.get(selector);
  }

  randomizeColor(index) {
    const paletteIndex =
      typeof index == 'number' ? parseInt(index % 5) : this.colorIndex + 1;
    this.colorIndex = paletteIndex;
  }

  scaledVelocity(v) {
    return Math.max(1, Math.min(127, parseInt(v * this.velocity_scaling)));
  }

  set colorIndex(i) {
    i = i % 5; // Color variant count
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

  shouldHandleMidi(message, fromSequencer) {
    return (
      (this.enabled && (Zone.solocount === 0 || this.solo)) ||
      (message === MIDI.MESSAGE.CONTROLLER && this.show_cc) ||
      fromSequencer
    );
  }

  handleMidi(message, data, fromSequencer) {
    if (this.shouldHandleMidi(message, fromSequencer)) {
      const fromMidiInput = !fromSequencer;
      const isArpActive = this.arp_enabled && this.midi.isClockRunning;
      switch (message) {
        case MIDI.MESSAGE.NOTE_OFF:
        case MIDI.MESSAGE.NOTE_ON:
          let key = data[1];
          const srcKey = key;
          let velo = this.scaledVelocity(data[2]);
          if (key >= this.low && key <= this.high) {
            if (isArpActive && this.arp_hold && this.arp_transpose) {
              // transposer zone
              this.arp_transpose_amount = ((key + 12) % 24) - 12;
              requestAnimationFrame(this.renderNotes.bind(this));
              return null;
            }
            key = key + (isArpActive || fromSequencer ? 0 : this.octave * 12);
            if (key >= 0 && key <= 127) {
              if (this.fixedvel && velo > 0) {
                velo = this.fixedvel_value || 127;
              }

              const outevent = new Uint8Array(data);
              if (message == MIDI.MESSAGE.NOTE_ON) {
                this.convertNote2CC(key, velo);
                if (!isArpActive) {
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
                if (fromMidiInput) {
                  let filteredActiveNotes = [...this.activeNotes];
                  this.sequence.activeNotes().forEach((seqNote) => {
                    filteredActiveNotes = filteredActiveNotes.filter(
                      (activeNote) => activeNote.number !== seqNote.number
                    );
                  });
                  this.sequence.recordNote(
                    playNote,
                    filteredActiveNotes.length
                  );
                }
              } else {
                const srcNote = this.midiActiveNotes[srcKey];
                if (srcNote) {
                  this.midiActiveNotes[srcKey] = null;
                  this.removeNote(srcNote.number);
                  if (!isArpActive) {
                    outevent[0] = message + srcNote.channel;
                    outevent[1] = srcNote.number;
                    outevent[2] = velo;
                    this.midi.send(outevent, this.outputPortId);
                  }
                } else {
                  this.removeNote(key);
                }
                if (!fromSequencer) {
                  this.sequence.noteReleased(this.activeNotes.length);
                }
              }
            }
            this.notesChanged(fromSequencer);
          }
          break;
        case MIDI.MESSAGE.CONTROLLER: // cc
          if (this.editCC && this.selectedCCIndex > -1) {
            this.cc_controllers[this.selectedCCIndex].number_in = data[1];
            return 'updateCC';
          }
          let handledByCCControl = false;
          for (let i = 0; i < this.cc_controllers.length; i++) {
            const ctrl = this.cc_controllers[i];
            if (ctrl.type != 2 && ctrl.number_in == data[1]) {
              const is14bit = ctrl.type == 5 || ctrl.type == 6;
              ctrl.val = is14bit ? data[2] << 7 : data[2];
              this.sendCC(i);
              // const outevent = new Uint8Array(3);

              // outevent[0] = MIDI.MESSAGE.CONTROLLER + this.channel;
              // outevent[1] = ctrl.number;
              // outevent[2] = this.remapCCValue(data[2], i);
              // this.midi.send(outevent, this.outputPortId);
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

  convertNote2CC(key, velo) {
    if (!this.cc_controllers.some((ctrl) => ctrl.type == 4)) {
      return;
    }
    this.cc_controllers.forEach((ctrl) => {
      if (ctrl.type == 4) {
        const outevent = new Uint8Array(3);
        outevent[0] = MIDI.MESSAGE.CONTROLLER + this.channel;
        if (ctrl.note_cc != null) {
          outevent[1] = ctrl.note_cc;
          outevent[2] = key;
          this.midi.send(outevent, this.outputPortId);
        }
        if (ctrl.velocity_cc != null) {
          outevent[1] = ctrl.velocity_cc;
          outevent[2] = velo;
          this.midi.send(outevent, this.outputPortId);
        }
      }
    });
  }
  notesChanged(fromSequencer) {
    if (this.enabled || fromSequencer) {
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
    if (this.elements.isReady) {
      const { context, rect } = Zone.scaledCanvasContext(
        this.elements.canvasElement
      );

      const cwidth = rect.width;
      const numberWhiteKeys = 10 * 7 + 4;

      const notewidth = cwidth / numberWhiteKeys;
      const whitekeywidth = notewidth * 0.75;
      const blackkeywidth = notewidth * 0.67;
      const blackkeyoffset = notewidth * 0.67;
      const whitekeyoffset = (notewidth - whitekeywidth) * 0.5;

      context.clearRect(0, 0, cwidth, rect.height);

      const drawNote = (number, fillStyle, fillStyleBlack) => {
        const isBlack = Note.isBlackKey(number);
        const wkIndex = Note.nearestWhiteKeyIndex(number);
        context.fillStyle = isBlack ? fillStyleBlack : fillStyle;

        context.beginPath();
        if (isBlack) {
          context.roundRect(
            notewidth * wkIndex + blackkeyoffset,
            note_top,
            blackkeywidth,
            note_height_black,
            [0, 0, 1, 1]
          );
        } else {
          context.roundRect(
            whitekeyoffset + notewidth * wkIndex,
            note_top,
            whitekeywidth,
            note_height,
            [0, 0, 2, 2]
          );
        }
        context.fill();
        if (isBlack && !this.arp_enabled) {
          context.stroke();
        }
      };

      const drawNoteList = (list, fillStyle, fillStyleBlack) => {
        list.sort((a, b) => {
          const ba = Note.isBlackKey(a);
          const bb = Note.isBlackKey(b);
          if (ba && !bb) {
            return 1;
          }
          if (bb & !ba) {
            return -1;
          }
          return 0;
        });
        list.forEach((n) => {
          drawNote(n, fillStyle, fillStyleBlack);
        });
      };

      const list =
        this.arp_hold && this.arp_enabled
          ? this.arp_holdlist
          : this.activeNotes;
      const drawNumbers = [];
      for (let i = 0; i < list.length; i++) {
        if (this.arp_enabled) {
          for (let ao = 0; ao < this.arp_octaves + 1; ao++) {
            const number =
              list[i].number +
              (this.arp_transpose ? this.arp_transpose_amount : 0) +
              (this.octave + ao) * 12;
            drawNumbers.push(number);
          }
        } else {
          drawNumbers.push(list[i].number);
        }
      }
      drawNoteList(
        drawNumbers,
        this.arp_enabled ? note_fill_arp : note_fill,
        this.arp_enabled ? note_fill_arp_black : note_fill_black
      );
      if (this.arp_enabled) {
        const note = this.arp.lastnote;
        if (note) {
          drawNote(note.number, note_fill_arp_played, note_fill_arp_played);
        }
      }
    }
  }

  renderPattern() {
    if (this.elements.isReady) {
      const { context, rect } = Zone.scaledCanvasContext(
        this.elements.patternCanvas
      );

      const plen = this.arp_pattern.length;
      const width = rect.width / plen;
      const colorEnabled = 'rgba(255, 255, 255, 0.25)';
      const colorCurrentStep = '#ffffff';
      context.clearRect(0, 0, rect.width, rect.height);
      context.lineWidth = 2;
      for (let i = 0; i < plen; i++) {
        const isCurrent = i === this.arp.patternPos;
        if (this.arp_pattern[i]) {
          context.fillStyle = colorEnabled;
          context.fillRect(0.5 + width * i, 0.5, width - 0.5, 14.5);
        }
        if (isCurrent) {
          context.fillStyle = colorCurrentStep;
          context.beginPath();
          context.arc(width * i + width / 2, 8, width / 4, 0, 2 * Math.PI);
          context.fill();
        }
      }
    }
  }

  renderSequence() {
    if (this.sequence.active && this.elements.isReady) {
      if (this.sequence.isDrumSequence) {
        if (this.sequence.previousStepNumber > -1) {
          this.elements.sequencerDrumLanes.forEach((dl) => {
            dl[this.sequence.previousStepNumber].classList.remove('playhead');
          });
        }
        if (this.sequence.currentStepNumber > -1) {
          this.elements.sequencerDrumLanes.forEach((dl) => {
            dl[this.sequence.currentStepNumber].classList.add('playhead');
          });
          this.elements.sequencerDrumLanes[0][
            this.sequence.currentStepNumber
          ].scrollIntoView({ inline: 'center' });
        } else if (
          this.sequence.previousStepNumber == -1 &&
          this.sequence.currentStepNumber == -1
        ) {
          this.elements.sequencerDrumStepElements.forEach((e) => {
            e.classList.remove('playhead');
          });
          this.elements.sequencerDrumLanes[0][0].scrollIntoView();
        }
      } else {
        if (this.sequence.previousStepNumber > -1) {
          this.elements.sequencerGridStepElements[
            this.sequence.previousStepNumber
          ].classList.remove('playhead');
        }
        if (this.sequence.currentStepNumber > -1) {
          this.elements.sequencerGridStepElements[
            this.sequence.currentStepNumber
          ].classList.add('playhead');
        } else if (
          this.sequence.previousStepNumber == -1 &&
          this.sequence.currentStepNumber == -1
        ) {
          this.elements.sequencerGridStepElements.forEach((e) => {
            e.classList.remove('playhead');
          });
        }
      }
    } else {
      if (
        this.sequence.currentStepNumber > -1 &&
        this.sequence.steps.length > 0
      ) {
        this.elements.sequencerProgressElementInner.style.left = `${
          (this.sequence.currentStepNumber / this.sequence.length) * 100
        }%`;
      } else {
        this.elements.sequencerProgressElementInner.style.left = '-100%';
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
    this.sequence.stopped();
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
    const is14bit =
      this.cc_controllers[index].type == 5 ||
      this.cc_controllers[index].type == 6;
    if (is14bit) {
      this.midi.send(
        // LSB
        Uint8Array.from([
          MIDI.MESSAGE.CONTROLLER + this.channel,
          this.cc_controllers[index].number_lsb,
          this.cc_controllers[index].val & 0x7f
        ]),
        this.outputPortId
      );
      this.midi.send(
        // MSB
        Uint8Array.from([
          MIDI.MESSAGE.CONTROLLER + this.channel,
          this.cc_controllers[index].number,
          this.cc_controllers[index].val >> 7
        ]),
        this.outputPortId
      );
    } else {
      this.midi.send(
        Uint8Array.from([
          MIDI.MESSAGE.CONTROLLER + this.channel,
          this.cc_controllers[index].number,
          this.remapCCValue(this.cc_controllers[index].val, index)
        ]),
        this.outputPortId
      );
    }
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

  remapCCValue(valueIn, ccIndex) {
    const ctrl = this.cc_controllers[ccIndex];
    return parseInt(ctrl.min + (ctrl.max - ctrl.min) * (valueIn / 127.0));
  }

  snap2DiscreteValue(value, ccIndex) {
    const ctrl = this.cc_controllers[ccIndex];
    if (
      ctrl.type == 0 &&
      ctrl.discreteValues != null &&
      ctrl.discreteValues.length > 0
    ) {
      const closest = ctrl.discreteValues.reduce((prev, curr) => {
        return Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev;
      });
      ctrl.val = closest;
    } else {
      ctrl.val = value;
    }
  }
}

class ZoneElements {
  isReady = false;
  zoneElement;
  actionElements;
  canvasElement;
  patternCanvas;
  sequencerElement;
  sequencerGridStepElements;
  sequencerDrumStepElements;
  sequencerDrumLanes;
  sequencerProgressElement;
  sequencerProgressElementInner;
  rangeContainer;
  rangeOctaveElements;
  rangeMarkerLow;
  rangeMarkerHigh;
  rangeJoin;
  rangeCurrent;
  octaveSelectors;
  ccPots;
  #cachedElements = {};

  init(index) {
    this.#cachedElements = {};
    this.zoneElement = document.querySelector(`#zone${index}`);
    this.actionElements = this.zoneElement.querySelectorAll('*[data-action]');
    this.canvasElement = this.zoneElement.querySelector(`#canvas${index}`);
    this.patternCanvas = this.zoneElement.querySelector(
      `#canvasPattern${index}`
    );
    this.sequencerElement = this.zoneElement.querySelector('.seq');
    this.sequencerProgressElement =
      this.zoneElement.querySelector('.seqprogress');
    this.sequencerProgressElementInner = this.zoneElement.querySelector(
      '.seqprogress .inner'
    );
    this.sequencerGridStepElements = this.zoneElement.querySelectorAll(
      '.seq .grid .step-container .step'
    );
    this.sequencerDrumStepElements = this.zoneElement.querySelectorAll(
      '.seq .grid .drum-step-container .step'
    );
    this.sequencerDrumLanes = [];
    this.zoneElement.querySelectorAll('.drum-lane').forEach((dl) => {
      this.sequencerDrumLanes.push(dl.querySelectorAll('.step'));
    });
    this.rangeContainer = this.zoneElement.querySelector('.range');
    this.rangeOctaveElements = this.zoneElement.querySelectorAll('.range .oct');
    this.rangeMarkerLow = this.zoneElement.querySelector('.marker.low');
    this.rangeMarkerHigh = this.zoneElement.querySelector('.marker.high');
    this.rangeJoin = this.zoneElement.querySelector('.join');
    this.rangeCurrent = this.zoneElement.querySelector('.current');
    this.octaveSelectors = this.zoneElement.querySelectorAll('.octselect');
    this.ccPots = this.zoneElement.querySelectorAll('.ccpots');
    this.isReady = true;
  }

  reset() {
    this.isReady = false;
    this.#cachedElements = {};
  }

  emptyCache() {
    this.#cachedElements = {};
  }

  #getCachedElement(selector) {
    if (!this.#cachedElements[selector]) {
      this.#cachedElements[selector] = this.zoneElement.querySelector(selector);
    }
    return this.#cachedElements[selector];
  }

  addSelectedStyle(selector, isSelected) {
    if (isSelected) {
      this.#getCachedElement(selector).classList.add('selected');
    }
  }

  setSelectedIndex(selector, index) {
    this.#getCachedElement(selector).selectedIndex = index;
  }

  setPercentage(selector, percentage, zoneIndex) {
    this.#getCachedElement(selector).value = percentage;
    if (selector.startsWith('.')) {
      selector = selector.substring(1);
    }
    this.#getCachedElement(`output[for="${selector}${zoneIndex}"]`).value =
      percentage + '%';
  }

  get(selector) {
    return this.#getCachedElement(selector);
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
  static from(cloneStep) {
    const result = new SeqStep();
    if (cloneStep) {
      Object.assign(result, cloneStep);
    }
    return result;
  }
  static addNote(notesArray, /** @type {Note} */ note) {
    if (!notesArray.some((n) => n.number === note.number)) {
      notesArray.push(note);
      notesArray.sort((a, b) => a.number - b.number);
      return true;
    }
    return false;
  }
}

class DrumLane {
  steps = [];
  note = 36;
}

class SeqLayer {
  steps = [];
  division = 14;
  ticks = DIV_TICKS[this.division];
  length = 16;
  drum_lanes = [];

  toJSON() {
    return {
      steps: this.steps,
      length: this.length,
      ticks: this.ticks,
      division: this.division,
      drum_lanes: this.drum_lanes
    };
  }
}

class Sequence {
  static MAX_STEPS = 256;
  static MAX_STEPS_DRUMS = 64;
  static CYCLE_CONDITIONS = [];
  static ACTIVE_LAYER_INDEX = 0;
  static NEXT_LAYER_INDEX = 0;
  static LAYER_TICK_N = 0;
  static LAYER_QUANT_TICKS = DIV_TICKS[2];

  static setQuantDiv(index) {
    Sequence.LAYER_QUANT_TICKS = DIV_TICKS[index];
  }

  _active = false;
  layers = [new SeqLayer(), new SeqLayer(), new SeqLayer(), new SeqLayer()];
  selectedStepNumbers = new Set();
  currentStepNumber = -1;
  previousStepNumber = -1;
  zone = null;
  _selectedStep = -1;
  isHotRecordingNotes = false;
  isLiveRecoding = false;
  isDrumSequence = false;
  activeSteps = [];
  rngProb = seedrandom();
  cycleCount = -1;
  previousStepPlayed = false;
  isFirstCycle = true;
  stepAdvance = false;
  stepAddNotes = false;
  liveTargetStep = null;
  liveTargetLength = 0;
  liveTargetStepNumber = -1;
  tickn = 0;

  static cloneStep(step) {
    return SeqStep.from(step);
  }

  constructor(zone) {
    this.zone = zone;
  }

  toJSON() {
    return {
      active: this.active,
      layers: this.layers,
      isDrumSequence: this.isDrumSequence
    };
  }

  set active(v) {
    this._active = v;
    if (v && this.zone.elements) {
      requestAnimationFrame(
        (() => {
          this.zone.elements.sequencerGridStepElements.forEach((e) => {
            e.classList.remove('playhead');
          });
        }).bind(this)
      );
    }
  }

  get active() {
    return this._active;
  }

  get length() {
    return this.activeLayer.length;
  }

  set length(len) {
    this.activeLayer.length = len;
  }

  get division() {
    return this.activeLayer.division;
  }

  set division(v) {
    this.activeLayer.division = v;
    this.activeLayer.ticks = DIV_TICKS[v];
  }

  get ticks() {
    return this.activeLayer.ticks;
  }

  set ticks(v) {
    // only for backwards compatibility
  }

  get steps() {
    return this.activeLayer.steps;
  }

  /**
   * @param {any[]} steplist
   */
  set steps(steplist) {
    this.activeLayer.steps = steplist;
  }

  clearSelection() {
    this.selectedStepNumbers.clear();
    this.isHotRecordingNotes = false;
  }

  get selectedStepNumber() {
    return this.selectedStepNumbers.size == 1
      ? this.selectedStepNumbers.values().next().value
      : -1;
  }

  /**
   * @param {number} v
   */
  set selectedStepNumber(v) {
    this.selectedStepNumbers.clear();
    if (v > -1) {
      this.selectedStepNumbers.add(v);
      this.isLiveRecoding = false;
      this.isHotRecordingNotes = true;
    } else {
      this.isHotRecordingNotes = false;
    }
    this.updateRecordingState();
  }

  get selectedStep() {
    return this.selectedStepNumber > -1
      ? this.steps[this.selectedStepNumber]
      : null;
  }

  get hasSelection() {
    return this.selectedStepNumbers.size > 0;
  }

  isStepEmpty(index) {
    return this.steps[index] == null || this.steps[index].length === 0;
  }

  isStepUsed(index) {
    return !this.isStepEmpty(index);
  }

  /**
   * @returns {SeqLayer}
   */
  get activeLayer() {
    return this.layers[Sequence.ACTIVE_LAYER_INDEX];
  }

  recordNote(/** @type {Note} */ note, inCount) {
    if (
      !this.isHotRecordingNotes &&
      this.isLiveRecoding &&
      this.currentStepNumber > -1
    ) {
      if (this.liveTargetStep == null) {
        const rec2step =
          this.tickn >= this.ticks - this.ticks / 3
            ? (this.currentStepNumber + 1) % this.length
            : this.currentStepNumber;
        this.liveTargetStepNumber = rec2step;
        this.liveTargetStep = SeqStep.from(this.steps[rec2step]);
        this.liveTargetLength = 1;
      }
      if (SeqStep.addNote(this.liveTargetStep.notesArray, note)) {
        this.updateZoneView();
      }
    } else {
      if (this.isHotRecordingNotes && this.selectedStepNumber > -1) {
        const seqstep = this.steps[this.selectedStepNumber] || new SeqStep();
        if (inCount == 1 && !this.stepAddNotes) {
          seqstep.notesArray.length = 0;
        }
        if (SeqStep.addNote(seqstep.notesArray, note)) {
          this.steps[this.selectedStepNumber] = seqstep;
          this.updateRecordingState();
        }
      }
    }
  }

  noteReleased(count) {
    if (this.isLiveRecoding && this.liveTargetStep) {
      this.liveTargetStep.length = this.liveTargetLength;
      this.steps[this.liveTargetStepNumber] = this.liveTargetStep;
      this.liveTargetStep = null;
      this.liveTargetLength = 0;
      this.liveTargetStepNumber = -1;
      this.updateRecordingState();
      this.updateZoneView();
    }
    if (
      this.isHotRecordingNotes &&
      this.selectedStepNumber > -1 &&
      count === 0
    ) {
      // this.isHotRecordingNotes = false;
      this.selectedStep.notesArray.sort((a, b) => a.number - b.number);
      if (this.stepAdvance) {
        this.selectedStepNumber = (this.selectedStepNumber + 1) % this.length;
      }
      this.updateZoneView();
      this.updateRecordingState();
    }
  }

  updateZoneView(allZones) {
    const event = new CustomEvent(Zone.updateZoneViewEventName, {
      detail: allZones ? null : this.zone
    });
    window.dispatchEvent(event);
  }

  updateRecordingState() {
    requestAnimationFrame(
      (() => {
        if (this.hasSelection) {
          if (this.selectedStepNumber > -1) {
            const notesArray = this.steps[this.selectedStepNumber]
              ? this.steps[this.selectedStepNumber].notesArray
              : null;
            this.zone._$('.stepmarker').innerHTML = this.selectedStepNumber + 1;
            let infoText = '';
            if (notesArray && notesArray.length > 0) {
              notesArray.forEach((note) => {
                const velopcnt = (note.velo / 127) * 100;
                infoText += `<span class="note${
                  note.isBlackKey ? ' black' : ''
                }"><span class="velocity" style="height:${velopcnt}%"></span>${Note.display(
                  note.number
                )}</span> `;
              });
            } else {
              if (this.isHotRecordingNotes) {
                infoText += '<i>Empty step. Play some notes ...</i>';
              }
            }
            this.zone.elements.sequencerElement.querySelector(
              '.step-notes'
            ).innerHTML = infoText;

            if (this.isHotRecordingNotes) {
              this.zone.elements.sequencerElement.classList.add('hot');
            } else {
              this.zone.elements.sequencerElement.classList.remove('hot');
            }
          } else {
            this.zone._$('.stepmarker').innerHTML = '...';
            this.zone._$(
              '.step-notes'
            ).innerHTML = `<i>${this.selectedStepNumbers.size} steps selected</i>`;
          }
        }
      }).bind(this)
    );
  }

  clock(pos) {
    this.tickn = pos % this.ticks;
    Sequence.LAYER_TICK_N = pos % Sequence.LAYER_QUANT_TICKS;
    if (
      Sequence.LAYER_TICK_N === 0 &&
      Sequence.ACTIVE_LAYER_INDEX != Sequence.NEXT_LAYER_INDEX
    ) {
      Sequence.ACTIVE_LAYER_INDEX = Sequence.NEXT_LAYER_INDEX;
      this.updateZoneView(true);
    }
    if (this.activeSteps.length > 0) {
      // check for active steps ending
      const clearSteps = [];
      this.activeSteps.forEach((astep) => {
        if (this.tickn === 0) astep.played++;
        const offtick = Math.min(this.ticks * astep.gateLength, this.ticks - 1);
        if (astep.length - 1 - astep.played === 0 && this.tickn >= offtick) {
          clearSteps.push(astep);
          for (let note of astep.lastPlayedArray) {
            this.zone.handleMidi(
              MIDI.MESSAGE.NOTE_OFF,
              Uint8Array.from([
                MIDI.MESSAGE.NOTE_OFF + note.channel,
                note.number,
                note.velo
              ]),
              true
            );
          }
          astep.lastPlayedArray.length = 0;
        }
      });
      this.activeSteps = this.activeSteps.filter(
        (item) => !clearSteps.includes(item)
      );
    }
    if (this.tickn == this.ticks - 1) {
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
        const currentStepList = [];
        if (this.isDrumSequence) {
          for (let lane of this.activeLayer.drum_lanes) {
            currentStepList.push(lane?.steps[this.currentStepNumber]);
          }
        } else {
          currentStepList.push(this.steps[this.currentStepNumber]);
        }
        for (const currentStep of currentStepList) {
          //const currentStep = this.steps[this.currentStepNumber];
          if (currentStep) {
            if (
              this.checkCondition(currentStep) &&
              this.rngProb() < currentStep.probability
            ) {
              currentStep.played = 0;
              this.activeSteps.push(currentStep);
              for (let inote of currentStep.notesArray) {
                let note = Note.clone(inote);
                note.number = note.number; // + this.zone.octave * 12;
                note.channel = this.zone.channel;
                note.portId = this.zone.outputPortId;
                this.zone.handleMidi(
                  MIDI.MESSAGE.NOTE_ON,
                  Uint8Array.from([
                    MIDI.MESSAGE.NOTE_ON + note.channel,
                    note.number,
                    note.velo
                  ]),
                  true
                );
                currentStep.lastPlayedArray.push(note);
              }
              this.previousStepPlayed = true;
            } else {
              this.previousStepPlayed = false;
            }
          }
        }
      }
      requestAnimationFrame(this.zone.renderSequence.bind(this.zone));
    }
  }

  stopped() {
    this.activeSteps.forEach((astep) => {
      for (let note of astep.lastPlayedArray) {
        this.zone.handleMidi(
          MIDI.MESSAGE.NOTE_OFF,
          Uint8Array.from([
            MIDI.MESSAGE.NOTE_OFF + note.channel,
            note.number,
            note.velo
          ]),
          true
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
    Sequence.ACTIVE_LAYER_INDEX = Sequence.NEXT_LAYER_INDEX;
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
    let steplist;
    if (this.hasSelection) {
      steplist = this.selectedStepNumbers.values().map((n) => this.steps[n]);
    } else {
      steplist = this.steps;
    }
    steplist.forEach((astep) => {
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
    return this.cycleCount % condition[0] === condition[1] - 1;
  }

  velocityMediumSelectedStep() {
    if (
      this.selectedStepNumber > -1 &&
      this.selectedStep &&
      this.selectedStep.notesArray
    ) {
      if (this.selectedStep.notesArray.length > 1) {
        let medium = 0;
        this.selectedStep.notesArray.forEach((note) => {
          medium += note.velo;
        });
        medium = parseInt(medium / this.selectedStep.notesArray.length);
        this.selectedStep.notesArray.forEach((note) => {
          note.velo = medium;
        });
      }
    }
  }

  getDrumLane(lane) {
    if (this.activeLayer.drum_lanes[lane] == null) {
      this.activeLayer.drum_lanes[lane] = new DrumLane();
    }
    return this.activeLayer.drum_lanes[lane];
  }

  toggleDrumStep(lane, stepNo) {
    console.log('toggleDrumStep', lane, stepNo);
    const drumLane = this.getDrumLane(lane);
    if (drumLane.steps[stepNo] == null) {
      const step = new SeqStep();
      step.notesArray.push(new Note(drumLane.note, 96));
      drumLane.steps[stepNo] = step;
    } else {
      drumLane.steps[stepNo] = null;
    }
    console.log('toggleDrumStep', drumLane);
  }

  hasDrumStep(lane, stepNo) {
    return this.getDrumLane(lane).steps[stepNo] != null;
  }
}

if (Sequence.CYCLE_CONDITIONS.length == 0) {
  // Initialize CYCLE_CONDITIONS
  for (let cycles = 2; cycles < 9; cycles++) {
    for (let b = 0; b < cycles; b++) {
      Sequence.CYCLE_CONDITIONS.push([cycles, b + 1]);
    }
  }
  console.log(
    'Sequence: Initialized cycle conditions: ',
    Sequence.CYCLE_CONDITIONS
  );
}

module.exports = {
  Zone,
  Sequence,
  SeqLayer,
  ZoneElements
};
