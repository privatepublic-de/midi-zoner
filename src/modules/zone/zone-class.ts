import { mulberry32, BagShuffle } from '../prng';
import MIDI from '../midi';
import { Note } from './note';
import { ZoneElements } from './zone-elements';
import { Sequence } from './sequence';
import { SeqStep } from './seq-step';
import { DrumLane } from './drum-lane';
import { Take } from './take';
import { barTicks } from '../meter';
import { TakePlayer } from './take-player';
import { Looper, PressResult } from './looper';
import { takeStore } from '../take-store';
import { MpeInput, MpeMode, MPE_SLIDE_CC, PressureGlide, DEFAULT_PRESSURE_FROM, mpeSetupMessages, rescaleBend } from './mpe';
import type { MpeDot } from './mpe';
import {
  CCController,
  ArpState,
  ZoneJSON,
  ZoneArrangementJSON,
  SeqStepJSON,
  ArpDirection,
  CCControllerType,
  isHiResCC,
  isSevenBitCC,
  isLayoutEntry,
  UPDATE_ZONE_VIEW_EVENT,
  CC_LOCK_VALUES_EVENT
} from './interfaces';
import { NoteDisplay } from './note-display';
import { NoteHistory, timeline, nowTick } from '../timeline';
import { DIV_TICKS, DivTick, PPQ, swingOffsetMs } from './seq-layer';
import {
  ParamLocks,
  controllerAddress,
  hiResValue,
  knobValueFor,
  nrpnValue,
  remapCCValue,
  snappedKnobValue,
  transmittedValue
} from './param-locks';

// All MIDI notes 0-127 sorted white-first so black keys are drawn on top
const ALL_NOTES_WHITE_FIRST = Array.from({ length: 128 }, (_, i) => i).sort(
  (a, b) => {
    const ba = Note.isBlackKey(a),
      bb = Note.isBlackKey(b);
    return ba === bb ? 0 : ba ? 1 : -1;
  }
);

export class Zone {
  static solocount = 0;
  static seqClipboardStep: Map<number, SeqStep> | null = null;
  static seqClipboardSequence: string | null = null;
  static seqClipboardDrumLane: {
    steps: (SeqStepJSON | null)[];
    length: number;
  } | null = null;
  static updateZoneViewEventName = UPDATE_ZONE_VIEW_EVENT;
  static lockValuesEventName = CC_LOCK_VALUES_EVENT;

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
  /** MPE input handling, see zone/mpe.ts (zone-global: it describes the synth) */
  mpe = MpeMode.OFF;
  mpe_bend_in = 48;
  /** Collapse: the synth's bend range */
  mpe_bend_out = 2;
  /** Pass through: the MPE synth's member bend range (48 = as the keyboard sends it) */
  mpe_pass_bend_out = 48;
  /** Collapse: pressure below this counts as none */
  mpe_at_from = DEFAULT_PRESSURE_FROM;
  /** Collapse: each key's pressure as poly aftertouch instead of merged channel pressure */
  mpe_poly_at = false;
  /** The input's MPE master channel, set by app.ts with every message */
  mpeMaster = 0;
  private mpeIn = new MpeInput();
  private mpePressure = new PressureGlide((value) => this.sendPressure(value));
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
  devicePreset: { id: string; name: string } | null = null;
  /** The controller page shown (pages: PAGE entries in cc_controllers) */
  ccPage = 0;
  selectedCCIndex = 0;
  at2mod = false;
  pitchbend = true;
  euclid_hits = 5;
  euclid_length = 8;
  midiLearnDrumLaneIndex: number | null = null;
  /** Armed by the controller editor's Learn button: the next incoming CC is learned */
  midiLearnCC = false;
  swingAmount: number = 0; // 0 to 1 (0% to 100%)
  private _arp_enabled = false;
  get arp_enabled(): boolean {
    return this._arp_enabled;
  }
  set arp_enabled(v: boolean) {
    this._arp_enabled = v;
    if (v) this.notesChanged();
  }
  arp_direction = 0;
  _arp_octaves = 0;
  _arp_division = 11;
  arp_ticks: DivTick = DIV_TICKS[11]; // matches _arp_division (1/8)
  arp_gatelength = 0.5;
  arp_repeat = 0;
  arp_probability = 1;
  arp_hold = false;
  arp_transpose = false;
  arp_transpose_amount = 0;
  arp_pattern: boolean[] = [true, true, true, true, true, true, true, true];
  arp_holdlist: Note[] = [];
  arp_sortedHoldList: Note[] = [];
  arp_strum_taper = 0;
  arp_ratchet_probability = 0;
  arp_ratchet_count = 0;
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
    octave: 0,
    lastStrumNotes: []
  };
  // Arpeggiator swing pending pattern positions (fireAtMs is a performance.now() timestamp)
  // scheduled via setTimeout; `timer` allows cancellation on stop/dismiss.
  private arpSwingPending: {
    patternPos: number;
    fireAtMs: number;
    probable: boolean;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  // Strum pending note-ons and per-note note-offs for equal gate lengths, scheduled via setTimeout
  private arpStrumPending: {
    note: Note;
    fireAtMs: number;
    gateMs: number;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private arpStrumOffPending: {
    note: Note;
    fireAtMs: number;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  private _lastTickIntervalMs = (60 / 120 / PPQ) * 1000;
  // When the last ring-out note-off is due (performance.now() time)
  private _ringOutUntil = 0;
  private _lockRedrawPending = false;
  // Clock position and time of the last processed tick, used to time ring-outs on stop
  private _lastPos = 0;
  private _lastTickAt = 0;
  // Note-offs scheduled by time after a transport stop so notes finish their gate,
  // keyed by output note number. A new note-on of the same pitch releases it first.
  private ringOuts = new Map<
    number,
    { timer: ReturnType<typeof setTimeout>; release: () => void }
  >();
  static readonly MAX_RING_OUT_MS = 4000;
  private _strumGraceTimer: ReturnType<typeof setTimeout> | null = null;
  activeNotes: Note[] = [];
  // Held notes that were sent straight to the output (arp not running). Their
  // note-off must go out even if the arp has started meanwhile, on the channel the
  // note-on went out on (an MPE member channel in pass-through, else the note's).
  private passedThrough = new Map<Note, number>();
  midiActiveNotes: (Note | null)[] = [];
  seqActiveNotes: (Note | null)[] = [];
  holdList: Note[] = [];
  midi: MIDI;
  elements = new ZoneElements();
  private readonly _midiMsgBuf = new Uint8Array(3);
  _colorIndex: number | null = null;
  pgm_no: number | null = null;
  bank_msb: number | null = null;
  bank_lsb: number | null = null;
  rngArp: BagShuffle;
  rngArpOct: BagShuffle;
  rngProb: () => number;
  sequence: Sequence;
  /** Plays the sequencer's parameter locks; kept across arrangement switches */
  readonly paramLocks = new ParamLocks(this);
  /** What this zone sent during the current run, for the track view */
  noteHistory = new NoteHistory();
  /** The notes its arp played from during the current run, for the track view */
  heldHistory = new NoteHistory();
  /** Stable across undo, reorder and save: the take store keeps the zone's takes under it */
  id = Zone.newId();
  /** The loop of the current arrangement (saved with it), played by the looper's own player */
  loop: Take | null = null;
  /** Recording and overdubbing the loop: a live gesture, handed on across undo */
  looper = new Looper();
  readonly loopPlayer = new TakePlayer(this);
  arrangements: ZoneArrangementJSON[] = [];
  currentArrangementIndex = 0;
  lastTouchedRangePoint = 0;
  readonly _renderNotesBound = this.renderNotes.bind(this);
  readonly _renderPatternBound = this.renderPattern.bind(this);
  readonly _renderSequenceBound = this.renderSequence.bind(this);

  static newId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  constructor(midi: MIDI, colorIndex?: number) {
    this.midi = midi;
    this.rngArp = new BagShuffle(mulberry32());
    this.rngArpOct = new BagShuffle(mulberry32());
    this.rngProb = mulberry32();
    this.colorIndex = colorIndex || 0;
    this.sequence = new Sequence(this);
    const defaultArr = this.captureArrangement();
    this.arrangements = [0, 1, 2, 3].map(() =>
      JSON.parse(JSON.stringify(defaultArr))
    );
  }

  toJSON(): ZoneJSON {
    this.arrangements[this.currentArrangementIndex] = this.captureArrangement();
    return {
      id: this.id,
      channel: this.channel,
      preferredOutputPortId: this.preferredOutputPortId,
      inputPortId: this.inputPortId,
      inputChannel: this.inputChannel,
      mpe: this.mpe,
      mpe_bend_in: this.mpe_bend_in,
      mpe_bend_out: this.mpe_bend_out,
      mpe_pass_bend_out: this.mpe_pass_bend_out,
      mpe_at_from: this.mpe_at_from,
      mpe_poly_at: this.mpe_poly_at,
      label: this.label,
      colorIndex: this._colorIndex,
      low: this.low,
      high: this.high,
      show_cc: this.show_cc,
      pgm_no: this.pgm_no,
      bank_msb: this.bank_msb,
      bank_lsb: this.bank_lsb,
      cc_controllers: this.cc_controllers,
      devicePreset: this.devicePreset,
      cc_page: this.ccPage,
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
      arp_transpose: this.arp_transpose,
      arp_transpose_amount: this.arp_transpose_amount,
      arp_pattern: this.arp_pattern,
      arp_holdlist: this.arp_holdlist,
      arp_sortedHoldList: this.arp_sortedHoldList,
      arp_strum_taper: this.arp_strum_taper,
      arp_ratchet_probability: this.arp_ratchet_probability,
      arp_ratchet_count: this.arp_ratchet_count,
      euclid_hits: this.euclid_hits,
      euclid_length: this.euclid_length,
      sequence: this.sequence.toJSON(),
      swingAmount: this.swingAmount,
      ...(this.loop ? { loop: this.loop.toJSON() } : {})
    };
  }

  applyArrangement(data: ZoneArrangementJSON): void {
    this.enabled = data.enabled ?? true;
    this.solo = data.solo ?? false;
    this.octave = data.octave ?? 0;
    this.fixedvel = data.fixedvel ?? false;
    this.fixedvel_value = data.fixedvel_value ?? 127;
    this.velocity_scaling =
      typeof data.velocity_scaling === 'number' ? data.velocity_scaling : 1;
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
    this.arp_transpose = data.arp_transpose ?? false;
    this.arp_transpose_amount = data.arp_transpose_amount ?? 0;
    this.arp_pattern = data.arp_pattern ?? [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true
    ];
    this.arp_holdlist = data.arp_holdlist ?? [];
    this.arp_sortedHoldList = data.arp_sortedHoldList ?? [];
    this.arp_strum_taper = data.arp_strum_taper ?? 0;
    this.arp_ratchet_probability = data.arp_ratchet_probability ?? 0;
    this.arp_ratchet_count = data.arp_ratchet_count ?? 0;
    this.euclid_hits = data.euclid_hits ?? 5;
    this.euclid_length = data.euclid_length ?? 8;
    const euclid = Zone.euclidianPattern(this.euclid_length, this.euclid_hits);
    if (euclid.some((hit, i) => hit !== !!this.arp_pattern[i]) || euclid.length !== this.arp_pattern.length) {
      // pattern was edited by hand: show its real hits/length, not the last euclid values
      this.euclid_hits = this.arp_pattern.filter(Boolean).length;
      this.euclid_length = this.arp_pattern.length;
    }
    this.swingAmount = data.swingAmount ?? 0;
    this.loop = data.loop ? Take.from(data.loop) : null;
    if (this.loop) this.loop.start = 0;

    const seq = new Sequence(this);
    const sd = data.sequence || {};
    // Real SeqStep instances: fields missing from older scenes (gateLength,
    // probability, condition, ratchet*) get the class defaults
    seq._steps = ((sd as any).steps || []).map((st: any) => (st ? SeqStep.from(st) : null));
    seq.division = (sd as any).division ?? 14;
    seq._length = (sd as any).length ?? 16;
    seq.isDrumSequence = (sd as any).isDrumSequence ?? false;
    seq.drumLanes = (sd as any).drumLanes ?? 4;
    seq.active = (sd as any).active ?? false;
    // map() keeps the holes of the sparse lane array
    seq.drum_lanes = ((sd as any).drum_lanes || []).map((lane: any) =>
      lane ? DrumLane.from(lane, seq._length) : lane
    );
    this.sequence = seq;
    // Switched while playing: the new arrangement's locks start from the controllers' values
    if (this.midi.isClockRunning && seq.active) this.paramLocks.start(seq.lockedAddresses());
  }

  /** The sequencer was switched on or off */
  sequenceActiveChanged(seq: Sequence, active: boolean): void {
    // Ignores sequences being built (arrangement load) and changes while stopped
    if (seq !== this.sequence || !this.midi.isClockRunning) return;
    if (active) this.paramLocks.start(seq.lockedAddresses());
    else this.paramLocks.stop(seq.lockedAddresses());
  }

  /** The step selection ended: while stopped, auditioned locks give way to the controllers' values */
  lockEditEnded(): void {
    if (!this.midi.isClockRunning) this.paramLocks.stop(this.sequence.lockedAddresses());
  }

  /**
   * Starts editing a controller. With sequencer steps selected, `ctrl` is a copy showing
   * their lock and `commit()` writes its value as a lock on them (and auditions it);
   * otherwise `ctrl` is the controller itself and `commit()` sends it. Returns the
   * controllers that followed (same address).
   */
  beginControllerEdit(ix: number): { ctrl: CCController; commit: () => number[] } {
    const real = this.cc_controllers[ix];
    const address = controllerAddress(real);
    if (!this.sequence.hasSelection || !address) return { ctrl: real, commit: () => this.sendCC(ix) };
    const view = this.lockedView(real);
    // Unlocked: start from the controller's own value
    const copy = view.locked ? view.ctrl : { ...real };
    return {
      ctrl: copy,
      commit: () => {
        const value = transmittedValue(copy);
        this.sequence.setLockOnSelected(address, value);
        this.paramLocks.audition(real, value);
        return [];
      }
    };
  }

  /**
   * A controller as its knob shows it: with steps selected, their lock on it (`mixed`
   * when they differ, the first is shown); otherwise the controller itself.
   */
  lockedView(c: CCController): { ctrl: CCController; locked: boolean; mixed: boolean; live: boolean } {
    const address = controllerAddress(c);
    if (!address) return { ctrl: c, locked: false, mixed: false, live: false };
    if (!this.sequence.hasSelection) {
      // Playing: the value a lock or slide sent last, which the device has now
      const live = this.paramLocks.liveValue(address);
      if (live === undefined) return { ctrl: c, locked: false, mixed: false, live: false };
      return { ctrl: { ...c, val: knobValueFor(c, live) }, locked: false, mixed: false, live: true };
    }
    const values = this.sequence.selectedLockValues(address);
    if (values.length === 0) return { ctrl: c, locked: false, mixed: false, live: false };
    return {
      ctrl: { ...c, val: knobValueFor(c, values[0]) },
      locked: true,
      mixed: values.some((v) => v !== values[0]),
      live: false
    };
  }

  /** Redraws the knobs following parameter locks, at most once per frame */
  lockValuesChanged(): void {
    if (this._lockRedrawPending) return;
    this._lockRedrawPending = true;
    requestAnimationFrame(() => {
      this._lockRedrawPending = false;
      window.dispatchEvent(new CustomEvent(CC_LOCK_VALUES_EVENT, { detail: this }));
    });
  }

  saveArrangement(index: number): void {
    this.arrangements[index] = this.captureArrangement();
  }

  loadArrangement(index: number): void {
    this.currentArrangementIndex = index;
    this.applyArrangement(this.arrangements[index]);
  }

  copyArrangementFromTo(sourceIndex: number, targetIndex: number): void {
    if (sourceIndex === targetIndex) return;
    const data =
      sourceIndex === this.currentArrangementIndex
        ? this.captureArrangement()
        : this.arrangements[sourceIndex];
    this.arrangements[targetIndex] = JSON.parse(JSON.stringify(data));
  }

  copyArrangementTo(targetIndex: number): void {
    this.copyArrangementFromTo(this.currentArrangementIndex, targetIndex);
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

  private ledTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Note-on/off through the shared message buffer. Code that sendOut itself can reach
   * (releaseSoundingArpPitch, ring-out callbacks) builds its own Uint8Array instead.
   */
  private sendNote(status: number, channel: number, number: number, velo: number, portId: string): void {
    this._midiMsgBuf[0] = status + channel;
    this._midiMsgBuf[1] = number;
    this._midiMsgBuf[2] = velo;
    this.sendOut(this._midiMsgBuf, portId);
  }

  /**
   * Sends a MIDI message; note-ons flash the activity LED (visible in the mini and track views).
   * live: a note played through from the input, marked so in the note history
   */
  private sendOut(msg: Uint8Array, portId: string, timestamp?: number, live = false): void {
    const status = msg[0] & 0xf0;
    const noteOn = status === MIDI.MESSAGE.NOTE_ON && msg[2] > 0;
    // A still-sounding note of the same pitch is released before it is struck again,
    // so its late note-off cannot cut the new note
    if (noteOn) {
      if (this.ringOuts.size > 0) this.fireRingOut(msg[1]);
      if (this.arp.lastStrumNotes.length > 0) {
        this.releaseSoundingArpPitch(msg[1], msg[0] & 0x0f, portId);
      }
    }
    this.midi.send(msg, portId, timestamp);
    if (noteOn) this.noteHistory.noteOn(msg[1], msg[2], live);
    else if (status === MIDI.MESSAGE.NOTE_ON || status === MIDI.MESSAGE.NOTE_OFF) this.noteHistory.noteOff(msg[1]);
    if (!noteOn || this.ledTimer !== null) return;
    const body = document.body.classList;
    if (!body.contains('minimized') && !body.contains('track-view')) return;
    const led = this.elements.zoneElement?.querySelector('.midi-led');
    if (!led) return;
    led.classList.add('on');
    this.ledTimer = setTimeout(() => {
      led.classList.remove('on');
      this.ledTimer = null;
    }, 70);
  }

  get sustain_on(): boolean {
    return this._sustain_on;
  }

  set sustain_on(v: boolean) {
    this._sustain_on = v;
    this.sustain_state = v;
    this.sendOut(
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

  removeNote(note: Note | number): void {
    if (typeof note === 'number') {
      this.activeNotes = this.activeNotes.filter((n) => n.number !== note);
    } else {
      const idx = this.activeNotes.indexOf(note);
      if (idx !== -1) this.activeNotes.splice(idx, 1);
    }
  }

  shouldHandleMidi(message: number, fromSequencer?: boolean): boolean {
    return (
      (this.enabled && (Zone.solocount === 0 || this.solo)) ||
      (message === MIDI.MESSAGE.CONTROLLER && this.show_cc) ||
      !!fromSequencer
    );
  }

  /**
   * An incoming message (or a note from the sequencer/takes). Returns what the view
   * must do: 'updateCC[:index]', 'midiLearn:index', 'lockCC' or 'updateDrumLaneNote'
   */
  handleMidi(
    message: number,
    data: Uint8Array,
    fromSequencer?: boolean,
    timestamp?: number
  ): string | void {
    const result = this.handleMessage(message, data, fromSequencer, timestamp);
    // Merged MPE slide may have played the zone's controllers on the way
    const slid = this.slideResult;
    this.slideResult = undefined;
    return result || slid;
  }

  /** What playing the controllers from MPE slide needs the view to do (see handleMidi) */
  private slideResult: string | undefined;

  private handleMessage(
    message: number,
    data: Uint8Array,
    fromSequencer?: boolean,
    timestamp?: number
  ): string | void {
    // MPE: the input channel of a message from the keyboard (-1: not MPE)
    const mpeCh = this.mpe !== MpeMode.OFF && !fromSequencer ? data[0] & 0x0f : -1;
    const mpeMember = mpeCh >= 0 && mpeCh !== this.mpeMaster;
    if (mpeMember) {
      // Expression is kept even while muted, so a note after unmuting starts from it
      this.mpeIn.store(mpeCh, message, data);
      this.requestRender(); // the keyboard strip's dots follow
      // A channel's new note is not this zone's until it plays it (see the note-on below)
      if (message === MIDI.MESSAGE.NOTE_ON) this.mpeIn.noteStarted(mpeCh, data[1]);
      else if (message === MIDI.MESSAGE.NOTE_OFF && this.mpeIn.noteEnded(mpeCh, data[1])) {
        if (this.mpe === MpeMode.COLLAPSE) this.sendCollapsed(); // follows the previous key
      }
    }
    // Pass note-off through for actively sounding keyboard notes even when zone is disabled,
    // so held notes are not stuck when the arrangement switches and disables this zone.
    if (
      message === MIDI.MESSAGE.NOTE_OFF &&
      !this.shouldHandleMidi(message, fromSequencer)
    ) {
      const srcNote = this.midiActiveNotes[data[1]];
      if (srcNote?.fromInput) {
        this.midiActiveNotes[data[1]] = null;
        this.removeNote(srcNote);
        const outevent = new Uint8Array(3);
        outevent[0] = MIDI.MESSAGE.NOTE_OFF + (this.passedThrough.get(srcNote) ?? srcNote.channel);
        outevent[1] = srcNote.number;
        this.passedThrough.delete(srcNote);
        this.sendOut(outevent, srcNote.portId);
        this.notesChanged();
      }
      return;
    }
    if (this.shouldHandleMidi(message, fromSequencer)) {
      const fromMidiInput = !fromSequencer;
      const isArpActive = this.arp_enabled && this.midi.isClockRunning;
      if (mpeCh >= 0 && this.handleMpeExpression(message, data, mpeCh, mpeMember)) return;
      switch (message) {
        case MIDI.MESSAGE.NOTE_OFF:
        case MIDI.MESSAGE.NOTE_ON:
          // Handle drum lane MIDI learn - capture note number when input has focus
          if (
            message === MIDI.MESSAGE.NOTE_ON &&
            data[2] > 0 &&
            this.midiLearnDrumLaneIndex !== null &&
            this.sequence.isDrumSequence
          ) {
            const lane = this.sequence.getDrumLane(this.midiLearnDrumLaneIndex);
            if (lane) {
              lane.note = data[1];
              this.midiLearnDrumLaneIndex = null;
              return 'updateDrumLaneNote';
            }
          }
          let key = data[1];
          const srcKey = key;
          // Vel% and Fixed Vel shape the strike; a note-off's (release) velocity, e.g. a
          // Seaboard's lift, passes as it came
          let velo = message === MIDI.MESSAGE.NOTE_ON ? this.scaledVelocity(data[2]) : data[2];
          if (key >= this.low && key <= this.high) {
            if (isArpActive && this.arp_hold && this.arp_transpose) {
              this.arp_transpose_amount = ((key + 12) % 24) - 12;
              requestAnimationFrame(this._renderNotesBound);
              return;
            }
            key = key + (isArpActive || fromSequencer ? 0 : this.octave * 12);
            if (key >= 0 && key <= 127) {
              if (this.fixedvel && message === MIDI.MESSAGE.NOTE_ON && velo > 0) {
                velo = this.fixedvel_value || 127;
              }
              const outevent = new Uint8Array(data);
              if (message == MIDI.MESSAGE.NOTE_ON) {
                this.convertNote2CC(key, velo);
                // Don't let the sequencer retrigger a note the user is already
                // holding live; their held note keeps sounding uninterrupted.
                const heldByLiveInput =
                  fromSequencer && this.midiActiveNotes[srcKey] != null;
                const passThrough = !isArpActive && !heldByLiveInput;
                // MPE pass-through keeps the key's channel; notes the arp plays don't
                // own it, so the arp drops their expression
                const outChannel =
                  mpeMember && this.mpe === MpeMode.PASS && passThrough ? mpeCh : this.channel;
                if (mpeMember && (passThrough || this.mpe === MpeMode.COLLAPSE)) {
                  this.mpeIn.claim(mpeCh, key);
                  // The expression sent before the note-on goes out ahead of it
                  if (this.mpe === MpeMode.PASS) this.sendMpeVoice(mpeCh);
                  else this.sendCollapsed();
                }
                if (passThrough) {
                  outevent[0] = message + outChannel;
                  outevent[1] = key;
                  outevent[2] = velo;
                  this.sendOut(outevent, this.outputPortId, timestamp, fromMidiInput);
                }
                // The zone channel even for an MPE key: the arp, step recording and
                // the hold list play from held notes
                const playNote = new Note(
                  key,
                  velo,
                  this.channel,
                  this.outputPortId
                );
                playNote.fromInput = fromMidiInput;
                if (passThrough) this.passedThrough.set(playNote, outChannel);
                const activeNoteSlots = fromSequencer
                  ? this.seqActiveNotes
                  : this.midiActiveNotes;
                // A still-open previous note in this slot (e.g. an overlapping
                // sequencer step retriggering the same pitch) would otherwise be
                // orphaned in activeNotes and drawn forever as a stuck ghost note.
                const previousNote = activeNoteSlots[srcKey];
                if (previousNote) {
                  this.removeNote(previousNote);
                }
                activeNoteSlots[srcKey] = playNote;
                this.addNote(playNote);
                if (fromMidiInput) {
                  if (velo > 0) this.recordTakeNote(key, velo);
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
                const sourceActiveNotes = fromSequencer
                  ? this.seqActiveNotes
                  : this.midiActiveNotes;
                const srcNote = sourceActiveNotes[srcKey];
                // The sequencer defers to a note the user is holding live: it
                // retires its own bookkeeping but never physically cuts it. A
                // live key release always cuts the note regardless of what the
                // sequencer is doing, since that's the user's direct action.
                const heldByLiveInput =
                  fromSequencer && this.midiActiveNotes[srcKey] != null;
                if (srcNote) {
                  sourceActiveNotes[srcKey] = null;
                  this.removeNote(srcNote);
                  // Decided by whether the note-on went out, not by the current
                  // transport state: a key held across Start would otherwise stick
                  const sentOn = this.passedThrough.get(srcNote);
                  if (this.passedThrough.delete(srcNote) && !heldByLiveInput) {
                    outevent[0] = message + (sentOn ?? srcNote.channel);
                    outevent[1] = srcNote.number;
                    outevent[2] = velo;
                    this.sendOut(outevent, this.outputPortId);
                  }
                } else {
                  this.removeNote(key);
                }
                if (!fromSequencer) {
                  this.recordNoteOff(srcNote ? srcNote.number : key);
                  this.sequence.noteReleased(
                    srcNote ? srcNote.number : key,
                    this.activeNotes.length
                  );
                }
              }
            }
            this.notesChanged(fromSequencer);
          }
          break;
        case MIDI.MESSAGE.CONTROLLER: {
          const played = this.playControllers(data[1], data[2]);
          if (played) return played;
          if (data[1] == 0x40 && !this.sustain) return;
          if (data[1] == 0x01 && !this.mod) return;
          if (data[1] == 0x40) {
            this.sustain_state = data[2] > 0;
            requestAnimationFrame(this._renderNotesBound);
          }
          if (!this.cc && data[1] != 0x40 && data[1] != 0x01) return;
          const ccOutevent = new Uint8Array(data);
          ccOutevent[0] = message + this.channel;
          this.sendOut(ccOutevent, this.outputPortId);
          break;
        }
        case MIDI.MESSAGE.PITCH_BEND:
          if (this.pitchbend) {
            const pbOutevent = new Uint8Array(data);
            pbOutevent[0] = message + this.channel;
            this.sendOut(pbOutevent, this.outputPortId);
          }
          break;
        case MIDI.MESSAGE.PGM_CHANGE:
          if (this.programchange) {
            const pgmOutevent = new Uint8Array(data);
            pgmOutevent[0] = message + this.channel;
            this.sendOut(pgmOutevent, this.outputPortId);
          }
          break;
        case MIDI.MESSAGE.CHANNEL_PRESSURE:
          this.sendPressure(data[1]);
          break;
        default: {
          const defaultOutevent = new Uint8Array(data);
          defaultOutevent[0] = message + this.channel;
          this.sendOut(defaultOutevent, this.outputPortId);
        }
      }
    }
    return;
  }

  /** Channel pressure on the zone channel, or as mod wheel with Aftertouch > MW */
  private sendPressure(value: number): void {
    if (this.at2mod) {
      this.sendOut(new Uint8Array([MIDI.MESSAGE.CONTROLLER + this.channel, 1, value]), this.outputPortId);
    } else {
      this.sendOut(new Uint8Array([MIDI.MESSAGE.CHANNEL_PRESSURE + this.channel, value]), this.outputPortId);
    }
  }

  setMpe(mode: MpeMode): void {
    this.mpe = mode;
    this.mpeIn.reset();
    this.mpePressure.reset();
  }

  /**
   * MPE messages other than notes. Member channels' bend, slide and pressure are kept
   * per channel and acted on only while the zone plays the channel's note: passed on as
   * they are, or merged into the zone channel. Returns true when the message is done.
   */
  private handleMpeExpression(message: number, data: Uint8Array, ch: number, member: boolean): boolean {
    if (message === MIDI.MESSAGE.NOTE_ON || message === MIDI.MESSAGE.NOTE_OFF) return false;
    if (!member) {
      // Master channel: normal path, except that a merged bend adds the master's
      if (this.mpe !== MpeMode.COLLAPSE || message !== MIDI.MESSAGE.PITCH_BEND) return false;
      this.mpeIn.setMasterBend(data);
      this.sendCollapsed();
      return true;
    }
    const expression = MpeInput.isExpression(message, data);
    const owned = this.mpeIn.owns(ch);
    if (this.mpe === MpeMode.COLLAPSE) {
      if (!expression) return false; // anything else merges into the zone channel as before
      if (!owned) return true;
      if (this.mpe_poly_at && message === MIDI.MESSAGE.CHANNEL_PRESSURE) this.sendPolyPressure(ch);
      else this.sendCollapsed();
      return true;
    }
    if (!owned) return true;
    if (message === MIDI.MESSAGE.PITCH_BEND) {
      if (this.pitchbend) this.sendPassBend(ch, this.mpeIn.voice(ch).bend);
      return true;
    }
    const out = new Uint8Array(data);
    out[0] = message + ch;
    this.sendOut(out, this.outputPortId);
    return true;
  }

  /**
   * An incoming controller value (a hardware knob, or merged MPE slide as CC 74) plays
   * the controllers learned to its number, or is learned by the armed one. Returns what
   * the view must do (see handleMidi), undefined when no controller took it.
   */
  private playControllers(number: number, value: number): string | undefined {
    if (this.midiLearnCC && this.cc_controllers[this.selectedCCIndex]) {
      this.cc_controllers[this.selectedCCIndex].number_in = number;
      this.midiLearnCC = false;
      return `midiLearn:${this.selectedCCIndex}`;
    }
    let firstMatchedCC = -1;
    let matchCount = 0;
    let lockEdited = false;
    for (let i = 0; i < this.cc_controllers.length; i++) {
      const ctrl = this.cc_controllers[i];
      if (ctrl.number_in == number && !isLayoutEntry(ctrl.type)) {
        // With sequencer steps selected the knob sets their lock instead
        const edit = this.beginControllerEdit(i);
        if (edit.ctrl !== ctrl) lockEdited = true;
        if (isHiResCC(ctrl.type)) {
          edit.ctrl.val = Math.round((value * 16383) / 127);
        } else if (ctrl.type == CCControllerType.SELECTOR) {
          // A hardware knob sweeps the entries evenly
          const entries = ctrl.discreteValues ?? [];
          if (entries.length > 0) edit.ctrl.val = entries[Math.round((value * (entries.length - 1)) / 127)];
        } else {
          this.snap2DiscreteValue(value, i, edit.ctrl);
        }
        if (edit.commit().length > 0) matchCount++; // others changed too: redraw all
        if (firstMatchedCC === -1) firstMatchedCC = i;
        matchCount++;
      }
    }
    if (lockEdited) return 'lockCC'; // the steps' marks and inspector change too
    if (matchCount > 0) return matchCount === 1 ? `updateCC:${firstMatchedCC}` : 'updateCC';
    return undefined;
  }

  /** Pass-through: a key's bend on its channel, rescaled to the synth's range */
  private sendPassBend(ch: number, bend: number): void {
    const out = rescaleBend(bend, this.mpe_bend_in, this.mpe_pass_bend_out);
    this.sendOut(new Uint8Array([MIDI.MESSAGE.PITCH_BEND + ch, out & 0x7f, out >> 7]), this.outputPortId);
  }

  /** Pass-through: a channel's bend, slide and pressure, sent ahead of its note-on */
  private sendMpeVoice(ch: number): void {
    const v = this.mpeIn.voice(ch);
    if (this.pitchbend) this.sendPassBend(ch, v.bend);
    if (v.slide !== null) {
      this.sendOut(new Uint8Array([MIDI.MESSAGE.CONTROLLER + ch, MPE_SLIDE_CC, v.slide]), this.outputPortId);
    }
    this.sendOut(new Uint8Array([MIDI.MESSAGE.CHANNEL_PRESSURE + ch, v.pressure]), this.outputPortId);
  }

  /** Collapse: the merged bend, slide and pressure on the zone channel, where they changed */
  private sendCollapsed(): void {
    const out = this.mpeIn.collapsed({
      bendIn: this.mpe_bend_in,
      bendOut: this.mpe_bend_out,
      withBend: this.pitchbend,
      pressureFrom: this.mpe_at_from
    });
    if (out.bend !== undefined) {
      this.sendOut(
        new Uint8Array([MIDI.MESSAGE.PITCH_BEND + this.channel, out.bend & 0x7f, out.bend >> 7]),
        this.outputPortId
      );
    }
    // Slide plays the controllers learned to CC 74, like a hardware knob; nothing else
    if (out.slide !== undefined) this.slideResult = this.playControllers(MPE_SLIDE_CC, out.slide) || this.slideResult;
    if (!this.mpe_poly_at) this.mpePressure.to(out.pressure, out.handover);
  }

  /** Collapse with poly aftertouch: a held key's pressure on its own note */
  private sendPolyPressure(ch: number): void {
    const poly = this.mpeIn.polyPressure(ch, this.mpe_at_from);
    if (poly) {
      this.sendOut(
        new Uint8Array([MIDI.MESSAGE.NOTE_PRESSURE + this.channel, poly.note, poly.value]),
        this.outputPortId
      );
    }
  }

  /**
   * Pass-through: the MPE setup for the synth (zone layout and bend ranges), sent on
   * startup, when its port connects, on switching to Pass and from the popup's button
   */
  sendMpeSetup(): boolean {
    if (this.mpe !== MpeMode.PASS || this.outputPortId === MIDI.INTERNAL_PORT_ID) return false;
    const master = this.inputPortId !== null ? this.inputChannel ?? 0 : this.mpeMaster;
    mpeSetupMessages(master, this.mpe_pass_bend_out).forEach((m) => this.sendOut(Uint8Array.from(m), this.outputPortId));
    return true;
  }

  setMpePolyAT(on: boolean): void {
    this.mpe_poly_at = on;
    this.mpePressure.reset();
  }

  convertNote2CC(key: number, velo: number): void {
    if (!this.cc_controllers.some((ctrl) => ctrl.type == CCControllerType.NOTE_TO_CC)) return;
    this.cc_controllers.forEach((ctrl) => {
      if (ctrl.type == CCControllerType.NOTE_TO_CC) {
        const outevent = new Uint8Array(3);
        outevent[0] = MIDI.MESSAGE.CONTROLLER + this.channel;
        if (ctrl.note_cc != null) {
          outevent[1] = ctrl.note_cc;
          outevent[2] = key;
          this.sendOut(outevent, this.outputPortId);
        }
        if (ctrl.velocity_cc != null) {
          outevent[1] = ctrl.velocity_cc;
          outevent[2] = velo;
          this.sendOut(outevent, this.outputPortId);
        }
      }
    });
  }

  notesChanged(fromSequencer?: boolean): void {
    if (this.enabled || fromSequencer) {
      this.arp.orderlist = Array.from(this.activeNotes);
      this.arp_holdlist = Array.from(this.holdList);
      if (this.arp_enabled) {
        this.arp.sortedlist = this.arp.orderlist
          .slice()
          .sort((a, b) => a.number - b.number);
        this.arp_sortedHoldList = this.arp_holdlist
          .slice()
          .sort((a, b) => a.number - b.number);
      }
    }
    // Grace period on key release: defer strum cancellation by one arp step so a
    // quick chord change feels seamless (guitar-like). If new notes arrive within
    // the window the timer is cleared and the strum continues uninterrupted.
    if (this.arp_enabled && this.arp_direction >= ArpDirection.STRUM_DOWN && !this.arp_hold) {
      if (this.activeNotes.length === 0) {
        const graceMs = this.arp_ticks * this._lastTickIntervalMs;
        this._strumGraceTimer = setTimeout(() => {
          this._strumGraceTimer = null;
          this.arpNoteOff();
        }, graceMs);
      } else if (this._strumGraceTimer !== null) {
        clearTimeout(this._strumGraceTimer);
        this._strumGraceTimer = null;
      }
    }
    requestAnimationFrame(this._renderNotesBound);
  }

  renderTransposeAmount(): void {
    const transposeEl = this._$('.arp_transpose_value') as HTMLElement | null;
    if (transposeEl) {
      transposeEl.textContent =
        (this.arp_transpose_amount > 0 ? '+' : '') + this.arp_transpose_amount;
    }
  }

  private _renderQueued = false;

  /** renderNotes() on the next frame, once however many requests come in (MPE floods) */
  requestRender(): void {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this.renderNotes();
    });
  }

  renderNotes(): void {
    this.renderTransposeAmount();
    if (this.elements.isReady && this.elements.canvasElement) {
      const { context, rect } = Zone.scaledCanvasContext(
        this.elements.canvasElement
      );
      const cwidth = rect.width;
      const numberWhiteKeys = 10 * 7 + 5;
      const notewidth = cwidth / numberWhiteKeys;
      const whitekeywidth = notewidth * 0.75;
      const blackkeywidth = notewidth * 0.5;
      const blackkeyoffset = notewidth * 0.75;
      const whitekeyoffset = (notewidth - whitekeywidth) * 0.5;

      context.clearRect(0, 0, cwidth, rect.height);

      if (this.sustain_state) {
        context.fillStyle = NoteDisplay.fillSustain;
        context.fillRect(0, rect.height - 2, cwidth, 2);
      }

      // Draw faint outlines for all 128 keys as a background reference
      ALL_NOTES_WHITE_FIRST.forEach((n) => {
        const isBlack = Note.isBlackKey(n);
        const wkIndex = Note.nearestWhiteKeyIndex(n);
        context.fillStyle = isBlack
          ? NoteDisplay.fillHintBlack
          : NoteDisplay.fillHintWhite;
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
      });

      // Octave number labels at the bottom of each C note
      if (this.enabled) {
        context.save();
        context.font = '6px sans-serif';
        context.textBaseline = 'bottom';
        context.textAlign = 'center';
        context.fillStyle = NoteDisplay.fillOctaveLabel;
        for (let oct = -1; oct <= 9; oct++) {
          const note = (oct + 1) * 12;
          const wkIndex = Note.nearestWhiteKeyIndex(note);
          const x = whitekeyoffset + notewidth * wkIndex + whitekeywidth / 2;
          context.fillText(String(oct), x, NoteDisplay.height);
        }
        context.restore();
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
      if (this.arp_enabled) {
        const drawNumbers: number[] = [];
        for (let i = 0; i < noteList.length; i++) {
          for (let ao = 0; ao < this.arp_octaves + 1; ao++) {
            const number =
              noteList[i].number +
              (this.arp_transpose ? this.arp_transpose_amount : 0) +
              (this.octave + ao) * 12;
            drawNumbers.push(number);
          }
        }
        drawNoteList(drawNumbers, NoteDisplay.fillArp, NoteDisplay.fillArpBlack);
      } else {
        // Dim sequencer-triggered notes so notes the user is actually
        // holding on the keyboard stand out from ones the sequencer is playing.
        const seqNumbers = noteList
          .filter((n) => !n.fromInput)
          .map((n) => n.number);
        const liveNumbers = noteList
          .filter((n) => n.fromInput)
          .map((n) => n.number);
        drawNoteList(seqNumbers, NoteDisplay.fillSeq, NoteDisplay.fillSeqBlack);
        const liveFill = this.mpe !== MpeMode.OFF ? NoteDisplay.fillMpeKey : NoteDisplay.fill;
        drawNoteList(liveNumbers, liveFill, this.mpe !== MpeMode.OFF ? NoteDisplay.fillMpeKey : NoteDisplay.fillBlack);
      }
      if (this.arp_enabled) {
        const note = this.arp.lastnote;
        if (note)
          drawNote(
            note.number,
            NoteDisplay.fillArpPlayed,
            NoteDisplay.fillArpPlayed
          );
        if (this.arp.lastStrumNotes.length > 0) {
          const n = this.arp.lastStrumNotes[this.arp.lastStrumNotes.length - 1];
          drawNote(
            n.number,
            NoteDisplay.fillArpPlayed,
            NoteDisplay.fillArpPlayed
          );
        }
      }
      if (this.mpe !== MpeMode.OFF) {
        const keyX = (n: number): number =>
          Note.isBlackKey(n)
            ? notewidth * Note.nearestWhiteKeyIndex(n) + blackkeyoffset + blackkeywidth / 2
            : whitekeyoffset + notewidth * Note.nearestWhiteKeyIndex(n) + whitekeywidth / 2;
        const dots = this.mpeIn.dots(this.mpe_bend_in);
        this.drawMpeDots(context, rect.height, dots, keyX);
        if (dots.some((d) => d.alpha < 1)) this.requestRender(); // a release still fading
      }
    }
  }

  /**
   * MPE keys as dots in the zone colour, as ROLI's Dashboard draws them: x = the pitch
   * sounding (key + bend, so a glide runs across the keys), y = slide (top = high), size
   * and brightness = pressure. With To one channel the key bend, slide and pressure
   * follow is a filled dot, the others rings.
   */
  private drawMpeDots(
    context: CanvasRenderingContext2D,
    height: number,
    dots: MpeDot[],
    keyX: (note: number) => number
  ): void {
    if (dots.length === 0) return;
    const colour = this.elements.zoneElement
      ? getComputedStyle(this.elements.zoneElement).getPropertyValue('--zone-color').trim() || NoteDisplay.fillMpeDot
      : NoteDisplay.fillMpeDot;
    context.save();
    for (const d of dots) {
      const pitch = Math.max(0, Math.min(127, d.note + d.semis));
      const low = Math.floor(pitch);
      const x = keyX(low) + (keyX(Math.min(127, low + 1)) - keyX(low)) * (pitch - low);
      const press = d.pressure / 127;
      const r = 1.5 + press * 6;
      const y = d.slide === null ? height / 2 : r + (1 - d.slide / 127) * (height - 2 * r);
      const filled = this.mpe !== MpeMode.COLLAPSE || d.followed;
      context.beginPath();
      context.arc(x, y, r, 0, Math.PI * 2);
      // a dark rim keeps the dot apart from the keys under it
      context.globalAlpha = d.alpha;
      context.lineWidth = filled ? 1 : 3;
      context.strokeStyle = NoteDisplay.strokeMpeDot;
      context.stroke();
      // light touch: the zone colour muted on the dark strip; pressed hard: full colour
      context.globalAlpha = d.alpha * (0.35 + 0.65 * press);
      if (filled) {
        context.fillStyle = colour;
        context.fill();
      } else {
        context.lineWidth = 1.5;
        context.strokeStyle = colour;
        context.stroke();
      }
    }
    context.restore();
  }

  renderPattern(): void {
    const el = this.elements.patternElement;
    if (!this.elements.isReady || !el) return;
    const plen = this.arp_pattern.length;
    if (el.childElementCount !== plen) {
      el.innerHTML = '<i></i>'.repeat(plen);
    }
    for (let i = 0; i < plen; i++) {
      const cell = el.children[i];
      cell.classList.toggle('on', !!this.arp_pattern[i]);
      cell.classList.toggle('playhead', i === this.arp.patternPos);
    }
  }

  renderSequence(): void {
    if (this.sequence.active && this.elements.isReady) {
      if (this.sequence.isDrumSequence) {
        if (
          this.sequence.previousStepNumber == -1 &&
          this.sequence.currentStepNumber == -1
        ) {
          this.elements.sequencerDrumStepElements.forEach((e) => {
            (e as HTMLElement).classList.remove('playhead');
          });
        } else {
          let maxFrac = 0;
          for (let ln = 0; ln < this.sequence.drumLanes; ln++) {
            const lane = this.sequence.drum_lanes[ln];
            if (lane && lane.currentStep > -1 && lane.length > 0) {
              const frac = lane.currentStep / lane.length;
              if (frac > maxFrac) maxFrac = frac;
            }
          }
          this.elements.sequencerGridElement?.scrollTo(
            (this.elements.sequencerGridElement.scrollWidth -
              this.elements.sequencerGridElement.offsetWidth * 0.75) *
              maxFrac,
            0
          );
          this.elements.sequencerDrumLanes.forEach((dl, laneIndex) => {
            const lane = this.sequence.drum_lanes[laneIndex];
            if (!lane) return;
            if (lane.previousStep > -1) {
              (dl[lane.previousStep] as HTMLElement)?.classList.remove(
                'playhead'
              );
            }
            if (lane.currentStep > -1) {
              (dl[lane.currentStep] as HTMLElement)?.classList.add('playhead');
            }
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
    }
    this.renderConditionOutcomes();
  }

  /** Marks conditional steps that play (`cond-plays`) or skip (`cond-skips`) this cycle. */
  private renderConditionOutcomes(): void {
    if (!this.elements.isReady || !this.sequence.active) return;
    const mark = (el: Element | undefined, outcome: boolean | null): void => {
      el?.classList.toggle('cond-plays', outcome === true);
      el?.classList.toggle('cond-skips', outcome === false);
    };
    if (this.sequence.isDrumSequence) {
      this.elements.sequencerDrumLanes?.forEach((cells, ln) => {
        const lane = this.sequence.drum_lanes[ln];
        for (let i = 0; i < cells.length; i++) {
          mark(cells[i], lane && i < lane.length ? this.sequence.conditionOutcome(i, lane) : null);
        }
      });
    } else {
      this.elements.sequencerGridStepElements?.forEach((el, i) => {
        mark(el, i < this.sequence.length ? this.sequence.conditionOutcome(i) : null);
      });
    }
  }

  clock(pos: number, tickIntervalMs: number): void {
    this._lastPos = pos;
    this._lastTickAt = performance.now();
    // Slides first: one ending on this tick reaches its value before a new step starts
    this.paramLocks.tick(pos);
    this.sequence.clock(pos, tickIntervalMs);
    const elapsed = pos - timeline.sectionStart;
    const bar = barTicks(timeline.meter);
    this.looper.prune(elapsed, bar);
    if (this.loop) {
      const layer = this.looper.dubLayer(this.loop, elapsed, bar);
      this.loopPlayer.clockLoop(elapsed, tickIntervalMs, this.loop, layer, this.looper.anchor, !this.audible);
    }
    if (tickIntervalMs > 0) this._lastTickIntervalMs = tickIntervalMs;

    const tickn = pos % this.arp_ticks;
    const offtick = Math.min(
      this.arp_ticks * this.arp_gatelength,
      this.arp_ticks - 1
    );
    if (tickn === 0) {
      const probable = this.rngProb() < this.arp_probability;
      this.arp.patternPos = (this.arp.patternPos + 1) % this.arp_pattern.length;

      // Check if this arp pattern position should swing
      if (
        this.swingAmount > 0 &&
        this.arp_enabled &&
        this.arp_pattern[this.arp.patternPos]
      ) {
        const swingOffset = swingOffsetMs(
          this.arp.patternPos,
          this.swingAmount,
          this.arp_ticks,
          tickIntervalMs
        );
        if (swingOffset > 0) {
          const patternPos = this.arp.patternPos;
          const fireAtMs = performance.now() + swingOffset;
          const pending = { patternPos, fireAtMs, probable } as {
            patternPos: number;
            fireAtMs: number;
            probable: boolean;
            timer: ReturnType<typeof setTimeout>;
          };
          // Timer provides the real delay; dispatch always sends immediately when it
          // fires (no MIDI-level timestamp) since Web MIDI scheduled sends aren't
          // reliably honored by all output drivers.
          pending.timer = setTimeout(() => {
            this.arpSwingPending = this.arpSwingPending.filter(
              (p) => p !== pending
            );
            this.triggerArpAtPatternPos(pending.probable);
          }, swingOffset);
          this.arpSwingPending.push(pending);
          requestAnimationFrame(this._renderPatternBound);
          return;
        }
      }

      // Normal arpeggiator processing (not swung)
      if (this.arp_enabled && this.arp_pattern[this.arp.patternPos]) {
        this.triggerArpAtPatternPos(probable);
      }
      requestAnimationFrame(this._renderPatternBound);
    } else if (tickn >= offtick) {
      this.arp.beat = false;
      // Strum modes and active ratchet use per-note timers; off-tick only silences plain arp
      if (
        this.arp_direction < ArpDirection.STRUM_DOWN &&
        this.arpStrumPending.length === 0 &&
        this.arpStrumOffPending.length === 0
      ) {
        this.arpNoteOff();
      }
    }
  }

  /**
   * Schedule a strum/ratchet sub-hit note-on via setTimeout. Dispatch always sends
   * immediately when the timer fires (no MIDI-level timestamp) since Web MIDI
   * scheduled sends aren't reliably honored by all output drivers.
   */
  private scheduleArpNoteOn(
    note: Note,
    delayMs: number,
    fireAtMs: number,
    gateMs: number
  ): void {
    const pending = { note, fireAtMs, gateMs } as {
      note: Note;
      fireAtMs: number;
      gateMs: number;
      timer: ReturnType<typeof setTimeout>;
    };
    pending.timer = setTimeout(() => {
      this.arpStrumPending = this.arpStrumPending.filter((p) => p !== pending);
      this.convertNote2CC(note.number, note.velo);
      this.sendNote(MIDI.MESSAGE.NOTE_ON, note.channel, note.number, note.velo, note.portId);
      this.arp.lastStrumNotes.push(note);
      requestAnimationFrame(this._renderNotesBound);
    }, delayMs);
    this.arpStrumPending.push(pending);
  }

  /**
   * Schedule a strum/ratchet sub-hit note-off via setTimeout (see scheduleArpNoteOn).
   */
  private scheduleArpNoteOff(note: Note, delayMs: number, fireAtMs: number): void {
    const pending = { note, fireAtMs } as {
      note: Note;
      fireAtMs: number;
      timer: ReturnType<typeof setTimeout>;
    };
    pending.timer = setTimeout(() => {
      this.arpStrumOffPending = this.arpStrumOffPending.filter(
        (p) => p !== pending
      );
      this.sendNote(MIDI.MESSAGE.NOTE_OFF, note.channel, note.number, note.velo, note.portId);
      this.arp.lastStrumNotes = this.arp.lastStrumNotes.filter(
        (s) => s !== note
      );
      requestAnimationFrame(this._renderNotesBound);
    }, delayMs);
    this.arpStrumOffPending.push(pending);
  }

  /**
   * Drop scheduled strum/ratchet note-ons that have not fired yet, together with their
   * note-offs. Notes already sounding keep their scheduled note-off.
   */
  private cancelUnsoundedArpNotes(): void {
    if (this.arpStrumPending.length === 0) return;
    const unsounded = new Set(this.arpStrumPending.map((p) => p.note));
    this.arpStrumPending.forEach((p) => clearTimeout(p.timer));
    this.arpStrumPending.length = 0;
    this.arpStrumOffPending = this.arpStrumOffPending.filter((p) => {
      if (!unsounded.has(p.note)) return true;
      clearTimeout(p.timer);
      return false;
    });
  }

  /**
   * Release a still-sounding strum/ratchet note of the given pitch (called from sendOut
   * before a note-on, hence its own message buffer).
   */
  private releaseSoundingArpPitch(number: number, channel: number, portId: string): void {
    const sounding = this.arp.lastStrumNotes;
    this.arpStrumOffPending = this.arpStrumOffPending.filter((p) => {
      const n = p.note;
      if (
        n.number !== number ||
        n.channel !== channel ||
        n.portId !== portId ||
        !sounding.includes(n)
      ) {
        return true;
      }
      clearTimeout(p.timer);
      this.sendOut(
        Uint8Array.from([MIDI.MESSAGE.NOTE_OFF + n.channel, n.number, n.velo]),
        n.portId
      );
      this.arp.lastStrumNotes = this.arp.lastStrumNotes.filter((s) => s !== n);
      return false;
    });
  }

  /**
   * Trigger arpeggiator note at a specific pattern position.
   */
  private triggerArpAtPatternPos(probable: boolean): void {
    this.arp.beat = true;
    const notes: Note[] = this.arp_hold
      ? this.arp_direction > ArpDirection.UP_DOWN
        ? this.arp_holdlist
        : this.arp_sortedHoldList
      : this.arp_direction > ArpDirection.UP_DOWN
        ? this.arp.orderlist
        : this.arp.sortedlist;
    if (notes.length > 0) {
      // Strum modes: play entire chord (across all octaves) staggered across the gate window
      if (
        this.arp_direction === ArpDirection.STRUM_DOWN ||
        this.arp_direction === ArpDirection.STRUM_UP ||
        this.arp_direction === ArpDirection.STRUM_ALT
      ) {
        if (probable) {
          const base = notes.slice().sort((a, b) => a.number - b.number);
          const chord: Note[] = [];
          for (let oct = 0; oct <= this.arp_octaves; oct++) {
            for (const n of base) {
              let number =
                n.number +
                (this.octave + oct) * 12 +
                (this.arp_transpose ? this.arp_transpose_amount : 0);
              while (number > 127) number -= 12;
              while (number < 0) number += 12;
              chord.push(
                new Note(number, n.velo, this.channel, this.outputPortId)
              );
            }
          }
          const strumUp =
            this.arp_direction === ArpDirection.STRUM_UP ||
            (this.arp_direction === ArpDirection.STRUM_ALT && this.arp.inc < 0);
          if (strumUp) chord.reverse();
          if (this.arp_direction === ArpDirection.STRUM_ALT) this.arp.inc = -this.arp.inc;
          const gateMs =
            this.arp_ticks * this._lastTickIntervalMs * this.arp_gatelength;
          const gap = chord.length > 1 ? gateMs / chord.length : 0;
          // Notes of the previous strum keep ringing until their own note-off or until
          // this strum re-strikes the same pitch; only its unsounded notes are dropped.
          this.cancelUnsoundedArpNotes();
          const now = performance.now();
          chord.forEach((note, i) => {
            const taperFactor =
              chord.length > 1
                ? 1 - this.arp_strum_taper * (i / (chord.length - 1)) * 0.9
                : 1;
            const baseVelo = this.fixedvel
              ? this.fixedvel_value || 127
              : note.velo;
            const velo = Math.max(1, Math.round(baseVelo * taperFactor));
            const fireAtMs = now + i * gap;
            const taperedNote = new Note(
              note.number,
              velo,
              note.channel,
              note.portId
            );
            if (i === 0) {
              this.convertNote2CC(note.number, velo);
              this.sendNote(MIDI.MESSAGE.NOTE_ON, this.channel, note.number, velo, this.outputPortId);
              this.arp.lastStrumNotes.push(taperedNote);
              this.scheduleArpNoteOff(taperedNote, gateMs, fireAtMs + gateMs);
            } else {
              this.scheduleArpNoteOn(taperedNote, i * gap, fireAtMs, gateMs);
              this.scheduleArpNoteOff(
                taperedNote,
                i * gap + gateMs,
                fireAtMs + gateMs
              );
            }
          });
        }
        this.arp.repeattrig = !this.arp.repeattrig;
        requestAnimationFrame(this._renderNotesBound);
        return;
      }

      const repetition = this.arp_repeat && this.arp.repeattrig;
      if (!repetition) {
        const nextArpOctave = (dir: number): void => {
          let noct = this.arp.octave + dir;
          if (noct < 0) noct = this.arp_octaves;
          else if (noct > this.arp_octaves) noct = 0;
          this.arp.octave = noct;
        };
        switch (this.arp_direction) {
          case ArpDirection.UP:
          case ArpDirection.ORDER:
            this.arp.noteindex++;
            if (this.arp.noteindex >= notes.length) {
              this.arp.noteindex = 0;
              nextArpOctave(1);
            }
            break;
          case ArpDirection.DOWN:
            this.arp.noteindex--;
            if (this.arp.noteindex < 0) {
              this.arp.noteindex = notes.length - 1;
              nextArpOctave(-1);
            }
            break;
          case ArpDirection.UP_DOWN:
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
          case ArpDirection.RANDOM:
            this.arp.noteindex = this.rngArp.next(notes.length);
            this.arp.octave = this.rngArpOct.next(this.arp_octaves + 1);
            break;
        }
      }
      if (
        probable &&
        this.arp.noteindex > -1 &&
        this.arp.noteindex < notes.length &&
        // nothing to repeat if the previous beat was skipped or ratcheted
        (!repetition || this.arp.repeatnote !== null)
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
        const baseVelo = this.fixedvel ? this.fixedvel_value || 127 : note.velo;
        const ratchetCount =
          this.arp_ratchet_probability > 0 &&
          this.rngProb() < this.arp_ratchet_probability
            ? [2, 3, 4][this.arp_ratchet_count]
            : 1;
        if (ratchetCount > 1) {
          const subIntervalMs =
            (this.arp_ticks * this._lastTickIntervalMs) / ratchetCount;
          const hitGateMs = subIntervalMs * this.arp_gatelength;
          const now = performance.now();
          for (let i = 0; i < ratchetCount; i++) {
            const fireAtMs = now + i * subIntervalMs;
            const velo = Math.max(1, Math.round(baseVelo * Math.pow(0.8, i)));
            const ratchetNote = new Note(
              note.number,
              velo,
              note.channel,
              note.portId
            );
            if (i === 0) {
              this.convertNote2CC(ratchetNote.number, ratchetNote.velo);
              this.sendNote(MIDI.MESSAGE.NOTE_ON, this.channel, ratchetNote.number, ratchetNote.velo, this.outputPortId);
              this.arp.lastStrumNotes.push(ratchetNote);
            } else {
              this.scheduleArpNoteOn(
                ratchetNote,
                i * subIntervalMs,
                fireAtMs,
                hitGateMs
              );
            }
            this.scheduleArpNoteOff(
              ratchetNote,
              i * subIntervalMs + hitGateMs,
              fireAtMs + hitGateMs
            );
          }
        } else {
          this.arp.lastnote = note;
          this.convertNote2CC(note.number, baseVelo);
          this.sendNote(MIDI.MESSAGE.NOTE_ON, this.channel, note.number, baseVelo, this.outputPortId);
        }
      }
    }
    this.arp.repeattrig = !this.arp.repeattrig;
    requestAnimationFrame(this._renderNotesBound);
  }

  arpNoteOff(): void {
    if (this.arp.lastnote) {
      const note = this.arp.lastnote;
      this.sendNote(MIDI.MESSAGE.NOTE_OFF, note.channel, note.number, note.velo, note.portId);
      this.arp.lastnote = null;
      this.arp.repeatnote = note;
      requestAnimationFrame(this._renderNotesBound);
    }
    if (this.arpStrumPending.length > 0 || this.arpStrumOffPending.length > 0) {
      this.arpStrumPending.forEach((p) => clearTimeout(p.timer));
      this.arpStrumPending.length = 0;
      this.arpStrumOffPending.forEach(({ note: n, timer }) => {
        clearTimeout(timer);
        if (!this.arp.lastStrumNotes.includes(n)) return; // never sounded
        this.sendNote(MIDI.MESSAGE.NOTE_OFF, n.channel, n.number, n.velo, n.portId);
      });
      this.arpStrumOffPending.length = 0;
      this.arp.lastStrumNotes = [];
    }
  }

  /**
   * Schedule a note-off `ticks` clock ticks after the last processed tick, timed with
   * the last measured tick interval (the clock itself is no longer running).
   */
  ringOutAfterTicks(noteNumber: number, ticks: number, release: () => void): void {
    this.fireRingOut(noteNumber);
    const elapsedMs = performance.now() - this._lastTickAt;
    const delayMs = Math.min(
      ticks * this._lastTickIntervalMs - elapsedMs,
      Zone.MAX_RING_OUT_MS
    );
    if (delayMs <= 0) {
      release();
      return;
    }
    this._ringOutUntil = Math.max(this._ringOutUntil, performance.now() + delayMs);
    const timer = setTimeout(() => {
      this.ringOuts.delete(noteNumber);
      release();
    }, delayMs);
    this.ringOuts.set(noteNumber, { timer, release });
  }

  private fireRingOut(noteNumber: number): void {
    const pending = this.ringOuts.get(noteNumber);
    if (!pending) return;
    this.ringOuts.delete(noteNumber);
    clearTimeout(pending.timer);
    pending.release();
  }

  /** Send all pending ring-out note-offs now. */
  flushRingOuts(): void {
    for (const noteNumber of [...this.ringOuts.keys()]) {
      this.fireRingOut(noteNumber);
    }
  }

  /**
   * Transport started: the arp takes over held notes, so release the ones that were
   * passed straight through while stopped (a mono synth would otherwise hold them
   * and play the arp legato).
   */
  started(): void {
    // A Continue after a clock dropout keeps the playhead and the locks it holds
    if (this.sequence.active && this.sequence.currentStepNumber < 0) {
      this.paramLocks.start(this.sequence.lockedAddresses());
    }
    if (!this.arp_enabled || this.passedThrough.size === 0) return;
    this.passedThrough.forEach((channel, n) => {
      this.sendOut(
        Uint8Array.from([MIDI.MESSAGE.NOTE_OFF + channel, n.number, 0]),
        n.portId
      );
    });
    this.passedThrough.clear();
  }

  /**
   * Stop arp and sequencer. With `ringOut` (transport stop) sounding notes finish their
   * gate on a timer; otherwise (arrangement switch, delete) they are cut immediately.
   */
  stopped(ringOut = false): void {
    if (!ringOut) this.flushRingOuts();
    this.arp.noteindex = -1;
    this.arp.patternPos = -1;
    this.arp.repeattrig = false;
    this.arp.inc = 1;
    this.arp.octave = 0;
    this.arpSwingPending.forEach((p) => clearTimeout(p.timer));
    this.arpSwingPending.length = 0;
    if (ringOut) {
      // Strum/ratchet note-offs already run on timers; only drop unsounded hits
      this.cancelUnsoundedArpNotes();
      this.ringOutArpNote();
    } else {
      this.arpNoteOff();
    }
    this.arp.repeatnote = null;
    this.sequence.stopped(ringOut);
    this.loopPlayer.release(ringOut);
    // the loop starts over at bar 1 (a recording was finished before, see finishLoop())
    this.looper.reset();
    // Controllers go back to their own values once ringing notes have ended (a little
    // after the last note-off, whose timer is due at the same moment)
    const ringingMs = ringOut && this.ringOuts.size > 0 ? Math.max(0, this._ringOutUntil - performance.now()) + 20 : 0;
    this.paramLocks.stop(this.sequence.lockedAddresses(), ringingMs);
    // Released sequencer notes may have armed the strum grace timer, which would
    // cut the strum's ring-out early
    if (this._strumGraceTimer !== null) {
      clearTimeout(this._strumGraceTimer);
      this._strumGraceTimer = null;
    }
    requestAnimationFrame(this._renderPatternBound);
    requestAnimationFrame(this._renderSequenceBound);
  }

  /**
   * External clock ticks halted without Stop: sounding notes ring out like on stop,
   * but arp and sequencer positions are kept so playback continues with the next tick.
   */
  paused(): void {
    this.arpSwingPending.forEach((p) => clearTimeout(p.timer));
    this.arpSwingPending.length = 0;
    this.cancelUnsoundedArpNotes();
    this.ringOutArpNote();
    this.sequence.paused();
    this.loopPlayer.release(true);
    if (this._strumGraceTimer !== null) {
      clearTimeout(this._strumGraceTimer);
      this._strumGraceTimer = null;
    }
  }

  /** Let the plain arp note finish its gate after a transport stop. */
  private ringOutArpNote(): void {
    const note = this.arp.lastnote;
    if (!note) return;
    this.arp.lastnote = null;
    this.arp.repeatnote = note;
    const offTick = Math.ceil(
      Math.min(this.arp_ticks * this.arp_gatelength, this.arp_ticks - 1)
    );
    const remaining = offTick - (this._lastPos % this.arp_ticks);
    this.ringOutAfterTicks(note.number, remaining, () => {
      this.sendOut(
        Uint8Array.from([MIDI.MESSAGE.NOTE_OFF + note.channel, note.number, note.velo]),
        note.portId
      );
      requestAnimationFrame(this._renderNotesBound);
    });
  }

  /** A key pressed while running: into the take being recorded and the looper's input */
  private recordTakeNote(pitch: number, velo: number): void {
    if (!timeline.running) return;
    const now = nowTick();
    this.looper.noteOn(now - timeline.sectionStart, pitch, velo);
    takeStore.noteOn(this.id, now, pitch, velo);
  }

  /** A key released: its note ends in the take and in the looper's input */
  private recordNoteOff(pitch: number): void {
    if (!timeline.running) return;
    const now = nowTick();
    this.looper.noteOff(now - timeline.sectionStart, pitch);
    takeStore.noteOff(this.id, now, pitch);
  }

  /** Whether takes were recorded into this zone, or one is being now */
  get hasRecorded(): boolean {
    return takeStore.has(this.id);
  }

  /** Whether what the zone plays by itself is heard: not muted, not silenced by a solo */
  get audible(): boolean {
    return this.enabled && (Zone.solocount === 0 || this.solo);
  }

  /** The looper's position: ticks since the section began (-1 while stopped: a press waits for bar 1) */
  private loopNow(): number {
    return timeline.running ? nowTick() - timeline.sectionStart : -1;
  }

  /** The loop button (chip, Mackie Rec) at `ms` (performance.now(), for the double press) */
  loopPress(ms: number): PressResult {
    const result = this.looper.press(this.loopNow(), barTicks(timeline.meter), this.loop, ms, (to) =>
      this.closeLoop(to, this.loopNow())
    );
    if (result.kind === 'cleared') {
      this.loop = null;
      this.loopPlayer.release(true);
    }
    return result;
  }

  /** Where a recording or overdub ends on the tick at `elapsed` (null: none ends) */
  loopDueAt(elapsed: number): number | null {
    return this.looper.dueAt(elapsed, barTicks(timeline.meter));
  }

  /** A recording or overdub ends at `to` (elapsed ticks, now or passed) */
  closeLoop(to: number, now: number): PressResult {
    const bar = barTicks(timeline.meter);
    if (this.looper.mode === 'rec') {
      const loop = this.looper.closeRecording(to, bar, now);
      if (!loop) return { kind: 'empty' };
      this.loopPlayer.release(true);
      loop.origin = { at: takeStore.runAt, run: this.looper.anchor + timeline.sectionStart };
      this.loop = loop;
      this.looper.lastRun = 'rec';
      return { kind: 'recorded', loop };
    }
    if (this.looper.mode === 'dub' && this.loop) {
      const added = this.looper.closeDub(this.loop, to, bar, now);
      if (added > 0 && this.looper.lastRun !== 'rec') this.looper.lastRun = 'dub';
      return { kind: 'dubbed', added };
    }
    this.looper.mode = 'idle';
    return { kind: 'none' };
  }

  /** Stop or an arrangement switch: a recording or overdub under way ends at its nearest 1 */
  finishLoop(): PressResult | null {
    const now = this.loopNow();
    const to = this.looper.finishAt(now, barTicks(timeline.meter));
    return to === null ? null : this.closeLoop(to, now);
  }

  /** While recording: how long the loop gets when the press comes now (ticks) */
  loopPressLength(): number {
    const bar = barTicks(timeline.meter);
    return Math.max(bar, Looper.nearestOne(this.loopNow(), bar) - this.looper.from);
  }

  /** The loop chip: what it says and how it looks */
  get loopChip(): { label: string; state: 'off' | 'on' | 'wait' | 'rec' | 'closing' } {
    const bar = barTicks(timeline.meter);
    const lp = this.looper;
    const now = this.loopNow();
    const bars = (ticks: number): string => `${Math.round((ticks / bar) * 10) / 10}`;
    const word = lp.mode === 'dub' ? 'Dub' : 'Rec';
    if (lp.mode !== 'idle') {
      if (lp.from > now) return { label: word, state: 'wait' };
      if (lp.to !== null) return { label: `${word} ${bars(lp.mode === 'dub' && this.loop ? this.loop.length : lp.to - lp.from)}`, state: 'closing' };
      // recording: the length a press now makes (it counts for the nearest 1, at least a bar)
      const length = lp.mode === 'dub' && this.loop ? this.loop.length : this.loopPressLength();
      return { label: `${word} ${bars(length)}`, state: 'rec' };
    }
    return this.loop ? { label: `Loop ${bars(this.loop.length)}`, state: 'on' } : { label: 'Rec', state: 'off' };
  }

  /** Undo replaces the zone objects: the replacement keeps showing what was played */
  adoptHistory(previous: Zone): void {
    this.noteHistory = previous.noteHistory;
    this.heldHistory = previous.heldHistory;
    this.looper = previous.looper;
    // the old player isn't clocked any more: what it still sounds rings out on timers
    previous.loopPlayer.release(true);
    // A held Pedal is a live gesture, not scene data: it stays down across undo,
    // without an up/down blip that would cut sustained notes. On another
    // output or channel the old one lets go (releasePedal() after the carry-over).
    if (
      previous._sustain_on &&
      previous.outputPortId === this.outputPortId &&
      previous.channel === this.channel
    ) {
      this._sustain_on = true;
      this.sustain_state = true;
      previous._sustain_on = false;
    }
  }

  /** Lets go of a pedal held with Pedal (zone deleted, scene replaced) */
  releasePedal(): void {
    if (this._sustain_on) this.sustain_on = false;
  }

  dismiss(): void {
    this.solo = false;
    this.arp_enabled = false;
    this.enabled = false;
    if (this._strumGraceTimer !== null) {
      clearTimeout(this._strumGraceTimer);
      this._strumGraceTimer = null;
    }
    // A swung arp hit still waiting would send a note-on after the zone is gone
    this.arpSwingPending.forEach((p) => clearTimeout(p.timer));
    this.arpSwingPending.length = 0;
    this.flushRingOuts();
    this.arpNoteOff();
    const outevent = new Uint8Array([0, 0, 0]);
    this.activeNotes.forEach((n) => {
      outevent[0] = MIDI.MESSAGE.NOTE_OFF + n.channel;
      outevent[1] = n.number;
      this.sendOut(outevent, this.outputPortId);
    });
    this.passedThrough.clear();
    this.sequence.stopped();
    this.paramLocks.stop(this.sequence.lockedAddresses());
  }

  panic(): void {
    // Global all-notes-off follows; just drop pending ring-outs
    this.paramLocks.cancelPending();
    this.noteHistory.closeAll();
    this.ringOuts.forEach((p) => clearTimeout(p.timer));
    this.ringOuts.clear();
    this.activeNotes = [];
    this.midiActiveNotes = [];
    this.seqActiveNotes = [];
    this.passedThrough.clear();
    this.holdList = [];
    this.mpeIn.reset();
    this.mpePressure.reset();
    // CC 121 (reset controllers) has already let go of the pedal
    this._sustain_on = false;
    this.sustain_state = false;
    this.notesChanged();
  }

  static euclidianPattern(length: number, hits: number): boolean[] {
    const s = hits / length;
    const result: boolean[] = [];
    let previous = -1;
    for (let i = 0; i < length; i++) {
      const current = Math.floor(i * s);
      result.push(current != previous);
      previous = current;
    }
    return result;
  }

  createEuclidianPattern(length: number, hits: number): void {
    this.euclid_length = length;
    this.euclid_hits = hits;
    this.arp_pattern = Zone.euclidianPattern(length, hits);
    this.renderPattern();
  }

  /** After a hand edit the euclid fields show the pattern's actual hits and length. */
  syncEuclidToPattern(): void {
    this.euclid_hits = this.arp_pattern.filter(Boolean).length;
    this.euclid_length = this.arp_pattern.length;
    const hitsEl = this._$('.euchits') as HTMLInputElement | null;
    const lenEl = this._$('.euclen') as HTMLInputElement | null;
    if (hitsEl) hitsEl.value = String(this.euclid_hits);
    if (lenEl) lenEl.value = String(this.euclid_length);
  }

  /** Sends a controller's value; returns the other controllers that followed it (same address) */
  sendCC(index: number): number[] {
    const ctrl = this.cc_controllers[index];
    this.sendTransmitted(ctrl, transmittedValue(ctrl));
    return this.syncSameAddress(index);
  }

  /**
   * Sends `value` (as transmittedValue() returns it) for a controller without changing
   * the controller: its own value, a parameter lock or a step of a lock's slide.
   */
  sendTransmitted(ctrl: CCController, value: number): void {
    const status = MIDI.MESSAGE.CONTROLLER + this.channel;
    if (ctrl.type == CCControllerType.NRPN) {
      this.sendNRPN(ctrl, Math.max(0, Math.min(16383, value)));
    } else if (isHiResCC(ctrl.type)) {
      const lsbBits = ctrl.lsb_bits ?? 7;
      value = Math.max(0, Math.min((1 << (7 + lsbBits)) - 1, value));
      const lsb = Uint8Array.from([status, (ctrl.number_lsb || 0) & 0x7f, value & ((1 << lsbBits) - 1)]);
      const msb = Uint8Array.from([status, ctrl.number & 0x7f, (value >> lsbBits) & 0x7f]);
      if (ctrl.msb_first) {
        this.sendOut(msb, this.outputPortId);
        this.sendOut(lsb, this.outputPortId);
      } else {
        this.sendOut(lsb, this.outputPortId);
        this.sendOut(msb, this.outputPortId);
      }
    } else {
      value = Math.max(0, Math.min(127, value));
      this.sendOut(Uint8Array.from([status, ctrl.number & 0x7f, value]), this.outputPortId);
    }
    const address = controllerAddress(ctrl);
    if (address) this.paramLocks.noteTransmitted(address, value);
  }

  /**
   * Controllers that address the same parameter as `index` take over the value it just
   * sent, so they all show what the device has. Returns the ones that changed.
   */
  syncSameAddress(index: number): number[] {
    const source = this.cc_controllers[index];
    const changed: number[] = [];
    const sent = this.ccOutputValue(index);
    this.cc_controllers.forEach((c, j) => {
      if (j == index) return;
      const before = c.val;
      if (isSevenBitCC(source.type) && isSevenBitCC(c.type) && c.number == source.number) {
        c.val = knobValueFor(c, sent);
      } else if (
        source.type == CCControllerType.NRPN &&
        c.type == CCControllerType.NRPN &&
        (c.nrpn_msb || 0) == (source.nrpn_msb || 0) &&
        (c.nrpn_lsb || 0) == (source.nrpn_lsb || 0)
      ) {
        c.val = knobValueFor(c, sent);
      } else if (
        (source.type == CCControllerType.UNIPOLAR_14BIT || source.type == CCControllerType.BIPOLAR_14BIT) &&
        (c.type == CCControllerType.UNIPOLAR_14BIT || c.type == CCControllerType.BIPOLAR_14BIT) &&
        c.number == source.number &&
        (c.number_lsb ?? 0) == (source.number_lsb ?? 0)
      ) {
        c.val = source.val;
      }
      if (c.val !== before) changed.push(j);
    });
    return changed;
  }

  /** 14-bit type value at its resolution: 0–16383, or 0–1023 at 10 bit */
  hiResValue(ctrl: CCController): number {
    return hiResValue(ctrl);
  }

  /** NRPN value in device units: the knob's 0–16383 mapped onto min–max */
  nrpnValue(ctrl: CCController): number {
    return nrpnValue(ctrl);
  }

  private sendNRPN(ctrl: CCController, value: number): void {
    const status = MIDI.MESSAGE.CONTROLLER + this.channel;
    const lsbCC = ctrl.nrpn_data_lsb_cc;
    const lsbBits = lsbCC != null ? ctrl.nrpn_data_lsb_bits ?? 7 : 0;
    const send = (cc: number, v: number): void =>
      this.sendOut(Uint8Array.from([status, cc, v & 0x7f]), this.outputPortId);
    send(99, ctrl.nrpn_msb || 0);
    send(98, ctrl.nrpn_lsb || 0);
    // Low bits first: receivers latch the value on Data Entry MSB
    if (lsbCC != null && lsbBits > 0) send(lsbCC, value & ((1 << lsbBits) - 1));
    send(6, value >> lsbBits);
  }

  sendProgramChange(): void {
    if (!this.pgm_no) return;
    if (this.bank_msb != null) {
      this.sendOut(
        Uint8Array.from([
          MIDI.MESSAGE.CONTROLLER + this.channel,
          0,
          this.bank_msb
        ]),
        this.outputPortId
      );
    }
    if (this.bank_lsb != null) {
      this.sendOut(
        Uint8Array.from([
          MIDI.MESSAGE.CONTROLLER + this.channel,
          32,
          this.bank_lsb
        ]),
        this.outputPortId
      );
    }
    this.midi.sendProgramChange(
      this.outputPortId,
      this.channel,
      this.pgm_no - 1
    );
  }

  sendAllCC(): void {
    for (let i = 0; i < this.cc_controllers.length; i++) {
      // Gaps, sections and note-to-CC have no value of their own
      const type = this.cc_controllers[i].type;
      if (isLayoutEntry(type) || type == CCControllerType.NOTE_TO_CC) continue;
      this.sendCC(i);
    }
  }

  remapCCValue(valueIn: number, ccIndex: number): number {
    return remapCCValue(this.cc_controllers[ccIndex], valueIn);
  }

  /** The value sendCC() transmits for a controller, to skip sends that wouldn't change it */
  ccOutputValue(index: number): number {
    return transmittedValue(this.cc_controllers[index]);
  }

  /** Sets a controller's value, snapped to its discreteValues; `target` edits a copy of it instead */
  snap2DiscreteValue(value: number, ccIndex: number, target = this.cc_controllers[ccIndex]): void {
    target.val = snappedKnobValue(target, value);
  }
}
