import seedrandom from 'seedrandom';
import MIDI from '../midi';
import { Note } from './note';
import { ZoneElements } from './zone-elements';
import { Sequence } from './sequence';
import { SeqStep } from './seq-step';
import { CCController, ArpState, ZoneJSON, ZoneArrangementJSON, SeqStepJSON, UPDATE_ZONE_VIEW_EVENT } from './interfaces';
import { NoteDisplay } from './note-display';
import { DIV_TICKS, DivTick } from './seq-layer';

export class Zone {
  static solocount = 0;
  static seqClipboardStep: Map<number, SeqStep> | null = null;
  static seqClipboardSequence: string | null = null;
  static seqClipboardDrumLane: { steps: (SeqStepJSON | null)[], length: number } | null = null;
  static updateZoneViewEventName = UPDATE_ZONE_VIEW_EVENT;

  private static _canvasSizeCache = new WeakMap<HTMLCanvasElement, DOMRect>();
  private static _resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      Zone._canvasSizeCache.delete(entry.target as HTMLCanvasElement);
    }
  });

  static scaledCanvasContext(canvas: HTMLCanvasElement): {
    context: CanvasRenderingContext2D;
    rect: DOMRect;
  } {
    const ctx = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio;
    let rect = Zone._canvasSizeCache.get(canvas);
    if (!rect) {
      rect = canvas.getBoundingClientRect();
      Zone._canvasSizeCache.set(canvas, rect);
      Zone._resizeObserver.observe(canvas);
    }
    const newW = Math.round(rect.width * dpr);
    const newH = Math.round(rect.height * dpr);
    if (canvas.width !== newW || canvas.height !== newH) {
      canvas.width = newW;
      canvas.height = newH;
      ctx.scale(dpr, dpr);
    }
    return { context: ctx, rect };
  }

  channel = 0;
  preferredOutputPortId = MIDI.INTERNAL_PORT_ID;
  outputPortId = MIDI.INTERNAL_PORT_ID;
  inputPortId: string | null = null;
  inputChannel: number | null = null;
  label = '';
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
  private _arp_enabled = false;
  get arp_enabled(): boolean { return this._arp_enabled; }
  set arp_enabled(v: boolean) {
    this._arp_enabled = v;
    if (v) this.notesChanged();
  }
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
  private readonly _midiMsgBuf = new Uint8Array(3);
  _colorIndex: number | null = null;
  private _cachedZoneColor: string | null = null;
  pgm_no: number | null = null;
  rngArp: () => number;
  rngArpOct: () => number;
  rngProb: () => number;
  sequence: Sequence;
  arrangements: ZoneArrangementJSON[] = [];
  currentArrangementIndex = 0;
  lastTouchedRangePoint = 0;
  readonly _renderNotesBound = this.renderNotes.bind(this);
  readonly _renderPatternBound = this.renderPattern.bind(this);
  readonly _renderSequenceBound = this.renderSequence.bind(this);

  constructor(midi: MIDI, colorIndex?: number) {
    this.midi = midi;
    this.rngArp = seedrandom();
    this.rngArpOct = seedrandom();
    this.rngProb = seedrandom();
    this.colorIndex = colorIndex || 0;
    this.sequence = new Sequence(this);
    const defaultArr = this.captureArrangement();
    this.arrangements = [0, 1, 2, 3].map(() => JSON.parse(JSON.stringify(defaultArr)));
  }

  toJSON(): ZoneJSON {
    this.arrangements[this.currentArrangementIndex] = this.captureArrangement();
    return {
      channel: this.channel,
      preferredOutputPortId: this.preferredOutputPortId,
      inputPortId: this.inputPortId,
      inputChannel: this.inputChannel,
      label: this.label,
      colorIndex: this._colorIndex,
      low: this.low,
      high: this.high,
      show_cc: this.show_cc,
      cc_controllers: this.cc_controllers,
      arrangements: this.arrangements
    };
  }

  captureArrangement(): ZoneArrangementJSON {
    return {
      enabled: this.enabled,
      solo: this.solo,
      octave: this.octave,
      fixedvel: this.fixedvel,
      fixedvel_value: this.fixedvel_value,
      velocity_scaling: this.velocity_scaling,
      mod: this.mod,
      sustain: this.sustain,
      cc: this.cc,
      at2mod: this.at2mod,
      pitchbend: this.pitchbend,
      programchange: this.programchange,
      arp_enabled: this.arp_enabled,
      arp_hold: this.arp_hold,
      arp_direction: this.arp_direction,
      arp_octaves: this._arp_octaves,
      arp_division: this._arp_division,
      arp_gatelength: this.arp_gatelength,
      arp_repeat: this.arp_repeat,
      arp_probability: this.arp_probability,
      arp_velocity: this.arp_velocity,
      arp_transpose: this.arp_transpose,
      arp_transpose_amount: this.arp_transpose_amount,
      arp_pattern: this.arp_pattern,
      arp_holdlist: this.arp_holdlist,
      arp_sortedHoldList: this.arp_sortedHoldList,
      euclid_hits: this.euclid_hits,
      euclid_length: this.euclid_length,
      sequence: this.sequence.toJSON()
    };
  }

  applyArrangement(data: ZoneArrangementJSON): void {
    this.enabled = data.enabled ?? true;
    this.solo = data.solo ?? false;
    this.octave = data.octave ?? 0;
    this.fixedvel = data.fixedvel ?? false;
    this.fixedvel_value = data.fixedvel_value ?? 127;
    this.velocity_scaling = data.velocity_scaling ?? 1;
    this.mod = data.mod ?? true;
    this.sustain = data.sustain ?? true;
    this.cc = data.cc ?? false;
    this.at2mod = data.at2mod ?? false;
    this.pitchbend = data.pitchbend ?? true;
    this.programchange = data.programchange ?? false;
    this.arp_enabled = data.arp_enabled ?? false;
    this.arp_hold = data.arp_hold ?? false;
    this.arp_direction = data.arp_direction ?? 0;
    this.arp_octaves = data.arp_octaves ?? 0;
    this.arp_division = data.arp_division ?? 11;
    this.arp_gatelength = data.arp_gatelength ?? 0.5;
    this.arp_repeat = data.arp_repeat ?? 0;
    this.arp_probability = data.arp_probability ?? 1;
    this.arp_velocity = data.arp_velocity ?? 0;
    this.arp_transpose = data.arp_transpose ?? false;
    this.arp_transpose_amount = data.arp_transpose_amount ?? 0;
    this.arp_pattern = data.arp_pattern ?? [true, true, true, true, true, true, true, true];
    this.arp_holdlist = data.arp_holdlist ?? [];
    this.arp_sortedHoldList = data.arp_sortedHoldList ?? [];
    this.euclid_hits = data.euclid_hits ?? 5;
    this.euclid_length = data.euclid_length ?? 8;

    const seq = new Sequence(this);
    const sd = data.sequence || {};
    seq._steps = (sd as any).steps || [];
    seq.division = (sd as any).division ?? 14;
    seq._length = (sd as any).length ?? 16;
    seq.drum_lanes = (sd as any).drum_lanes || [];
    seq.isDrumSequence = (sd as any).isDrumSequence ?? false;
    seq.drumLanes = (sd as any).drumLanes ?? 4;
    seq.active = (sd as any).active ?? false;
    seq._steps.forEach((st: any) => { if (st) st.lastPlayedArray = []; });
    seq.drum_lanes.forEach((lane: any) => {
      if (lane?.steps) {
        lane.steps.forEach((st: any) => { if (st) st.lastPlayedArray = []; });
      }
    });
    this.sequence = seq;
  }

  saveArrangement(index: number): void {
    this.arrangements[index] = this.captureArrangement();
  }

  loadArrangement(index: number): void {
    this.currentArrangementIndex = index;
    this.applyArrangement(this.arrangements[index]);
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
    this._cachedZoneColor = null;
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
    requestAnimationFrame(this._renderNotesBound);
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
    this.activeNotes = this.activeNotes.filter((n) => n.number !== number);
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
              requestAnimationFrame(this._renderNotesBound);
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
            requestAnimationFrame(this._renderNotesBound);
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
      if (this.arp_enabled) {
        this.arp.sortedlist = this.arp.orderlist.slice().sort((a, b) => a.number - b.number);
        this.arp_sortedHoldList = this.arp_holdlist.slice().sort((a, b) => a.number - b.number);
      }
    }
    requestAnimationFrame(this._renderNotesBound);
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
      const cellW = rect.width / plen;
      const h = rect.height;

      context.clearRect(0, 0, rect.width, rect.height);

      // Subtle group separators every 8 steps for long patterns
      if (plen > 8) {
        context.fillStyle = 'rgba(255, 255, 255, 0.07)';
        for (let g = 8; g < plen; g += 8) {
          context.fillRect(Math.round(cellW * g) - 1, 0, 1, h);
        }
      }

      const gap = cellW > 3 ? Math.min(1.5, cellW * 0.12) : 0;
      const barW = Math.max(1, cellW - gap * 2);
      const barH = h * 0.6;
      const barY = (h - barH) / 2;
      const radius = cellW >= 6 ? Math.min(2, barW / 2, barH / 2) : 0;

      for (let i = 0; i < plen; i++) {
        const x = cellW * i + gap;
        if (this.arp_pattern[i]) {
          context.fillStyle = 'rgba(255, 255, 255, 0.65)';
          if (radius > 0 && typeof context.roundRect === 'function') {
            context.beginPath();
            context.roundRect(x, barY, barW, barH, radius);
            context.fill();
          } else {
            context.fillRect(x, barY, barW, barH);
          }
        } else {
          context.fillStyle = 'rgba(255, 255, 255, 0.13)';
          context.fillRect(x, h / 2 - 0.5, barW, 1);
        }
      }

      // Playhead: zone-color tinted vertical bar with glow
      const playX = cellW * this.arp.patternPos + cellW / 2;
      if (!this._cachedZoneColor) {
        this._cachedZoneColor = getComputedStyle(this.elements.patternCanvas).getPropertyValue('--zone-color').trim() || '#e9c46a';
      }
      const zoneColor = this._cachedZoneColor;
      context.filter = 'brightness(2.4) saturate(2)';
      context.shadowColor = zoneColor;
      context.shadowBlur = 6;
      context.fillStyle = zoneColor;
      context.fillRect(Math.round(playX) - 1, 0, 3, h);
      context.shadowBlur = 0;
      context.filter = 'none';
    }
  }

  renderSequence(): void {
    if (this.sequence.active && this.elements.isReady) {
      if (this.sequence.isDrumSequence) {
        const progressPercent =
          this.sequence.currentStepNumber / this.sequence.length;
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
        const notes: Note[] = this.arp_hold
          ? (this.arp_direction > 2 ? this.arp_holdlist : this.arp_sortedHoldList)
          : (this.arp_direction > 2 ? this.arp.orderlist : this.arp.sortedlist);
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
            this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_ON + this.channel;
            this._midiMsgBuf[1] = note.number;
            this._midiMsgBuf[2] = this.fixedvel ? this.fixedvel_value || 127 : note.velo;
            this.midi.send(this._midiMsgBuf, this.outputPortId);
          }
        }
        this.arp.repeattrig = !this.arp.repeattrig;
        requestAnimationFrame(this._renderNotesBound);
      }
      requestAnimationFrame(this._renderPatternBound);
    } else if (tickn >= offtick) {
      this.arp.beat = false;
      this.arpNoteOff();
    }
  }

  arpNoteOff(): void {
    if (this.arp.lastnote) {
      const note = this.arp.lastnote;
      this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_OFF + note.channel;
      this._midiMsgBuf[1] = note.number;
      this._midiMsgBuf[2] = note.velo;
      this.midi.send(this._midiMsgBuf, note.portId);
      this.arp.lastnote = null;
      this.arp.repeatnote = note;
      requestAnimationFrame(this._renderNotesBound);
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
    requestAnimationFrame(this._renderPatternBound);
    requestAnimationFrame(this._renderSequenceBound);
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
