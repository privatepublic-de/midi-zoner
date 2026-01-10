import seedrandom from 'seedrandom';
import MIDI from '../midi';
import { Note } from './note';
import { ZoneElements } from './zone-elements';
import { Sequence } from './sequence';
import { SeqStep } from './seq-step';
import { CCController, ArpState, ZoneJSON } from './interfaces';
import { NoteDisplay } from './note-display';
import { DIV_TICKS, DivTick } from './seq-layer';

export class Zone {
  static solocount = 0;
  static seqClipboardStep: Map<number, SeqStep> | null = null;
  static seqClipboardSequence: string | null = null;
  static updateZoneViewEventName = 'update-zone-view';

  static scaledCanvasContext(canvas: HTMLCanvasElement): {
    context: CanvasRenderingContext2D;
    rect: DOMRect;
  } {
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    return { context: ctx, rect: rect };
  }

  channel = 0;
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
  sustain_state = false;
  cc = false;
  cc_controllers: CCController[] = [
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
  arp_direction = 0;
  _arp_octaves = 0;
  _arp_division = 11;
  arp_ticks: DivTick = DIV_TICKS[8];
  arp_gatelength = 0.5;
  arp_repeat = 0;
  arp_probability = 1;
  arp_velocity = 0;
  arp_hold = false;
  arp_transpose = false;
  arp_transpose_amount = 0;
  arp_pattern: boolean[] = [true, true, true, true, true, true, true, true];
  arp_holdlist: Note[] = [];
  arp_sortedHoldList: Note[] = [];
  arp: ArpState = {
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
  activeNotes: Note[] = [];
  midiActiveNotes: (Note | null)[] = [];
  holdList: Note[] = [];
  midi: MIDI;
  elements = new ZoneElements();
  _colorIndex: number | null = null;
  pgm_no: number | null = null;
  rngArp: () => number;
  rngArpOct: () => number;
  rngProb: () => number;
  sequence: Sequence;
  lastTouchedRangePoint = 0;

  constructor(midi: MIDI, colorIndex?: number) {
    this.midi = midi;
    this.rngArp = seedrandom();
    this.rngArpOct = seedrandom();
    this.rngProb = seedrandom();
    this.colorIndex = colorIndex || 0;
    this.sequence = new Sequence(this);
  }

  toJSON(): ZoneJSON {
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

  _$(selector: string): Element | null {
    return this.elements.get(selector);
  }

  randomizeColor(index?: number): void {
    const paletteIndex =
      typeof index == 'number' ? Math.floor(index % 5) : this.colorIndex + 1;
    this.colorIndex = paletteIndex;
  }

  scaledVelocity(v: number): number {
    return Math.max(1, Math.min(127, Math.floor(v * this.velocity_scaling)));
  }

  set colorIndex(i: number) {
    i = i % 5;
    this._colorIndex = i;
  }

  get colorIndex(): number {
    return this._colorIndex || 0;
  }

  get configId(): string {
    return this.outputPortId + ',' + this.channel;
  }

  get arp_division(): number {
    return this._arp_division;
  }

  set arp_division(v: number) {
    this._arp_division = v;
    this.arp_ticks = DIV_TICKS[v] as DivTick;
  }

  get arp_octaves(): number {
    return this._arp_octaves;
  }

  set arp_octaves(v: number) {
    this._arp_octaves = v;
    requestAnimationFrame(this.renderNotes.bind(this));
  }

  get solo(): boolean {
    return this._solo;
  }

  set solo(v: boolean) {
    if (this._solo !== v) {
      if (this._solo) {
        Zone.solocount--;
      } else {
        Zone.solocount++;
      }
      this._solo = v;
    }
  }

  get sustain_on(): boolean {
    return this._sustain_on;
  }

  set sustain_on(v: boolean) {
    this._sustain_on = v;
    this.sustain_state = v;
    this.midi.send(
      Uint8Array.from([
        MIDI.MESSAGE.CONTROLLER + this.channel,
        64,
        v ? 127 : 0
      ]),
      this.outputPortId
    );
  }

  addNote(note: Note): void {
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

  removeNote(number: number): void {
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

  shouldHandleMidi(message: number, fromSequencer?: boolean): boolean {
    return (
      (this.enabled && (Zone.solocount === 0 || this.solo)) ||
      (message === MIDI.MESSAGE.CONTROLLER && this.show_cc) ||
      !!fromSequencer
    );
  }

  handleMidi(
    message: number,
    data: Uint8Array,
    fromSequencer?: boolean
  ): string | void {
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
              this.arp_transpose_amount = ((key + 12) % 24) - 12;
              requestAnimationFrame(this.renderNotes.bind(this));
              return;
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
        case MIDI.MESSAGE.CONTROLLER:
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
              handledByCCControl = true;
            }
          }
          if (handledByCCControl) return 'updateCC';
          if (data[1] == 0x40 && !this.sustain) return;
          if (data[1] == 0x01 && !this.mod) return;
          if (data[1] == 0x40) {
            this.sustain_state = data[2] > 0;
            requestAnimationFrame(this.renderNotes.bind(this));
          }
          if (!this.cc && data[1] != 0x40 && data[1] != 0x01) return;
          const ccOutevent = new Uint8Array(data);
          ccOutevent[0] = message + this.channel;
          this.midi.send(ccOutevent, this.outputPortId);
          break;
        case MIDI.MESSAGE.PITCH_BEND:
          if (this.pitchbend) {
            const pbOutevent = new Uint8Array(data);
            pbOutevent[0] = message + this.channel;
            this.midi.send(pbOutevent, this.outputPortId);
          }
          break;
        case MIDI.MESSAGE.PGM_CHANGE:
          if (this.programchange) {
            const pgmOutevent = new Uint8Array(data);
            pgmOutevent[0] = message + this.channel;
            this.midi.send(pgmOutevent, this.outputPortId);
          }
          break;
        case MIDI.MESSAGE.CHANNEL_PRESSURE:
          if (this.at2mod) {
            const atOutevent = new Uint8Array(3);
            atOutevent[0] = MIDI.MESSAGE.CONTROLLER + this.channel;
            atOutevent[1] = 1;
            atOutevent[2] = data[1];
            this.midi.send(atOutevent, this.outputPortId);
            break;
          }
        // fallthrough
        default: {
          const defaultOutevent = new Uint8Array(data);
          defaultOutevent[0] = message + this.channel;
          this.midi.send(defaultOutevent, this.outputPortId);
        }
      }
    }
    return;
  }

  convertNote2CC(key: number, velo: number): void {
    if (!this.cc_controllers.some((ctrl) => ctrl.type == 4)) return;
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

  notesChanged(fromSequencer?: boolean): void {
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

  renderNotes(): void {
    if (this.elements.isReady && this.elements.canvasElement) {
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

      if (this.sustain_state) {
        context.fillStyle = NoteDisplay.fillSustain;
        context.fillRect(0, rect.height - 2, cwidth, 2);
      }

      const drawNote = (
        number: number,
        fillStyle: string,
        fillStyleBlack: string
      ): void => {
        const isBlack = Note.isBlackKey(number);
        const wkIndex = Note.nearestWhiteKeyIndex(number);
        context.fillStyle = isBlack ? fillStyleBlack : fillStyle;
        context.beginPath();
        if (isBlack) {
          context.roundRect(
            notewidth * wkIndex + blackkeyoffset,
            NoteDisplay.top,
            blackkeywidth,
            NoteDisplay.heightBlack,
            [0, 0, 1, 1]
          );
        } else {
          context.roundRect(
            whitekeyoffset + notewidth * wkIndex,
            NoteDisplay.top,
            whitekeywidth,
            NoteDisplay.height,
            [0, 0, 2, 2]
          );
        }
        context.fill();
        if (isBlack && !this.arp_enabled) context.stroke();
      };

      const drawNoteList = (
        list: number[],
        fillStyle: string,
        fillStyleBlack: string
      ): void => {
        list.sort((a, b) => {
          const ba = Note.isBlackKey(a);
          const bb = Note.isBlackKey(b);
          if (ba && !bb) return 1;
          if (bb && !ba) return -1;
          return 0;
        });
        list.forEach((n) => drawNote(n, fillStyle, fillStyleBlack));
      };

      const noteList =
        this.arp_hold && this.arp_enabled
          ? this.arp_holdlist
          : this.activeNotes;
      const drawNumbers: number[] = [];
      for (let i = 0; i < noteList.length; i++) {
        if (this.arp_enabled) {
          for (let ao = 0; ao < this.arp_octaves + 1; ao++) {
            const number =
              noteList[i].number +
              (this.arp_transpose ? this.arp_transpose_amount : 0) +
              (this.octave + ao) * 12;
            drawNumbers.push(number);
          }
        } else {
          drawNumbers.push(noteList[i].number);
        }
      }
      drawNoteList(
        drawNumbers,
        this.arp_enabled ? NoteDisplay.fillArp : NoteDisplay.fill,
        this.arp_enabled ? NoteDisplay.fillArpBlack : NoteDisplay.fillBlack
      );
      if (this.arp_enabled) {
        const note = this.arp.lastnote;
        if (note)
          drawNote(
            note.number,
            NoteDisplay.fillArpPlayed,
            NoteDisplay.fillArpPlayed
          );
      }
    }
  }

  renderPattern(): void {
    if (this.elements.isReady && this.elements.patternCanvas) {
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

  renderSequence(): void {
    if (this.sequence.active && this.elements.isReady) {
      if (this.sequence.isDrumSequence) {
        const progressPercent =
          this.sequence.currentStepNumber / this.sequence.activeLayer.length;
        this.elements.sequencerGridElement?.scrollTo(
          (this.elements.sequencerGridElement.scrollWidth -
            this.elements.sequencerGridElement.offsetWidth * 0.75) *
            progressPercent,
          0
        );
        if (this.sequence.previousStepNumber > -1) {
          this.elements.sequencerDrumLanes.forEach((dl) => {
            (
              dl[this.sequence.previousStepNumber] as HTMLElement
            )?.classList.remove('playhead');
          });
        }
        if (this.sequence.currentStepNumber > -1) {
          this.elements.sequencerDrumLanes.forEach((dl) => {
            (dl[this.sequence.currentStepNumber] as HTMLElement)?.classList.add(
              'playhead'
            );
          });
        } else if (
          this.sequence.previousStepNumber == -1 &&
          this.sequence.currentStepNumber == -1
        ) {
          this.elements.sequencerDrumStepElements.forEach((e) => {
            (e as HTMLElement).classList.remove('playhead');
          });
        }
      } else {
        if (this.sequence.previousStepNumber > -1) {
          (
            this.elements.sequencerGridStepElements[
              this.sequence.previousStepNumber
            ] as HTMLElement
          )?.classList.remove('playhead');
        }
        if (this.sequence.currentStepNumber > -1) {
          (
            this.elements.sequencerGridStepElements[
              this.sequence.currentStepNumber
            ] as HTMLElement
          )?.classList.add('playhead');
        } else if (
          this.sequence.previousStepNumber == -1 &&
          this.sequence.currentStepNumber == -1
        ) {
          this.elements.sequencerGridStepElements.forEach((e) => {
            (e as HTMLElement).classList.remove('playhead');
          });
        }
      }
    } else {
      if (
        this.sequence.currentStepNumber > -1 &&
        this.sequence.steps.length > 0 &&
        this.elements.sequencerProgressElementInner
      ) {
        this.elements.sequencerProgressElementInner.style.left = `${
          (this.sequence.currentStepNumber / this.sequence.length) * 100
        }%`;
      } else if (this.elements.sequencerProgressElementInner) {
        this.elements.sequencerProgressElementInner.style.left = '-100%';
      }
    }
  }

  clock(pos: number): void {
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
        let notes: Note[];
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
            const nextArpOctave = (dir: number): void => {
              let noct = this.arp.octave + dir;
              if (noct < 0) noct = this.arp_octaves;
              else if (noct > this.arp_octaves) noct = 0;
              this.arp.octave = noct;
            };
            switch (this.arp_direction) {
              case 0:
              case 4:
                this.arp.noteindex++;
                if (this.arp.noteindex >= notes.length) {
                  this.arp.noteindex = 0;
                  nextArpOctave(1);
                }
                break;
              case 1:
                this.arp.noteindex--;
                if (this.arp.noteindex < 0) {
                  this.arp.noteindex = notes.length - 1;
                  nextArpOctave(-1);
                }
                break;
              case 2:
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
                if (notes.length == 1) this.arp.noteindex = 0;
                break;
              case 3:
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
              ? this.arp.repeatnote!
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

  arpNoteOff(): void {
    if (this.arp.lastnote) {
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

  stopped(): void {
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

  dismiss(): void {
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

  panic(): void {
    this.activeNotes = [];
    this.midiActiveNotes = [];
    this.holdList = [];
    this.notesChanged();
  }

  createEuclidianPattern(length: number, hits: number): void {
    this.euclid_length = length;
    this.euclid_hits = hits;
    const s = hits / length;
    const result: boolean[] = [];
    let previous = -1;
    for (let i = 0; i < length; i++) {
      const current = Math.floor(i * s);
      result.push(current != previous);
      previous = current;
    }
    this.arp_pattern = result;
    this.renderPattern();
  }

  sendCC(index: number): void {
    const is14bit =
      this.cc_controllers[index].type == 5 ||
      this.cc_controllers[index].type == 6;
    if (is14bit) {
      this.midi.send(
        Uint8Array.from([
          MIDI.MESSAGE.CONTROLLER + this.channel,
          this.cc_controllers[index].number_lsb || 0,
          this.cc_controllers[index].val & 0x7f
        ]),
        this.outputPortId
      );
      this.midi.send(
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

  sendProgramChange(): void {
    if (this.pgm_no) {
      this.midi.sendProgramChange(
        this.outputPortId,
        this.channel,
        this.pgm_no - 1
      );
    }
  }

  sendAllCC(): void {
    for (let i = 0; i < this.cc_controllers.length; i++) {
      this.sendCC(i);
    }
  }

  remapCCValue(valueIn: number, ccIndex: number): number {
    const ctrl = this.cc_controllers[ccIndex];
    return Math.floor(ctrl.min + (ctrl.max - ctrl.min) * (valueIn / 127.0));
  }

  snap2DiscreteValue(value: number, ccIndex: number): void {
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
