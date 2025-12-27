import seedrandom = require('seedrandom');
import MIDI = require('./midi');

type DivTick = 192 | 144 | 96 | 72 | 64 | 48 | 36 | 32 | 24 | 18 | 16 | 12 | 9 | 8 | 6 | 4 | 3 | 2;

const DIV_TICKS: DivTick[] = [
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

interface CCController {
  number: number;
  number_in: number | null;
  number_lsb?: number;
  label: string;
  val: number;
  type: number;
  min: number;
  max: number;
  note_cc: number | null;
  velocity_cc: number | null;
  discreteValues?: number[];
  group?: number;
}

interface ArpState {
  orderlist: Note[];
  sortedlist: Note[];
  noteindex: number;
  patternPos: number;
  inc: number;
  lastnote: Note | null;
  repeattrig: boolean;
  repeatnote: Note | null;
  beat: boolean;
  octave: number;
}

class Note {
  static WHITE_KEY_ARRAY: number[] = [];

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

// Initialize whitekey index numbers
let whiteKeyCount = -1;
for (let kn = 0; kn < 128; kn++) {
  if (!Note.isBlackKey(kn)) {
    whiteKeyCount++;
  }
  Note.WHITE_KEY_ARRAY[kn] = whiteKeyCount;
}

class ZoneElements {
  isReady = false;
  zoneElement: HTMLElement | null = null;
  actionElements: NodeListOf<Element> | null = null;
  canvasElement: HTMLCanvasElement | null = null;
  patternCanvas: HTMLCanvasElement | null = null;
  sequencerElement: HTMLElement | null = null;
  sequencerGridElement: HTMLElement | null = null;
  sequencerGridStepElements: NodeListOf<Element> | Element[] = [];
  sequencerDrumStepElements: NodeListOf<Element> | Element[] = [];
  sequencerDrumLanes: (NodeListOf<Element> | Element[])[] = [];
  sequencerProgressElement: HTMLElement | null = null;
  sequencerProgressElementInner: HTMLElement | null = null;
  rangeContainer: HTMLElement | null = null;
  rangeOctaveElements: NodeListOf<Element> | null = null;
  rangeMarkerLow: HTMLElement | null = null;
  rangeMarkerHigh: HTMLElement | null = null;
  rangeJoin: HTMLElement | null = null;
  rangeCurrent: HTMLElement | null = null;
  octaveSelectors: NodeListOf<Element> | null = null;
  ccPots: NodeListOf<Element> | null = null;
  private cachedElements: Record<string, Element | null> = {};

  init(index: number): void {
    this.cachedElements = {};
    this.zoneElement = document.querySelector(`#zone${index}`);
    if (!this.zoneElement) return;

    this.actionElements = this.zoneElement.querySelectorAll('*[data-action]');
    this.canvasElement = this.zoneElement.querySelector(`#canvas${index}`);
    this.patternCanvas = this.zoneElement.querySelector(`#canvasPattern${index}`);
    this.sequencerElement = this.zoneElement.querySelector('.seq');
    this.sequencerGridElement = this.zoneElement.querySelector('.grid');
    this.sequencerProgressElement = this.zoneElement.querySelector('.seqprogress');
    this.sequencerProgressElementInner = this.zoneElement.querySelector('.seqprogress .inner');
    this.sequencerGridStepElements = this.zoneElement.querySelectorAll('.seq .grid .step-container .step');
    this.sequencerDrumStepElements = this.zoneElement.querySelectorAll('.seq .grid .drum-step-container .step');
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

  reset(): void {
    this.isReady = false;
    this.cachedElements = {};
  }

  emptyCache(): void {
    this.cachedElements = {};
  }

  private getCachedElement(selector: string): Element | null {
    if (!this.cachedElements[selector]) {
      this.cachedElements[selector] = this.zoneElement?.querySelector(selector) || null;
    }
    return this.cachedElements[selector];
  }

  addSelectedStyle(selector: string, isSelected: boolean): void {
    const el = this.getCachedElement(selector);
    if (isSelected) {
      el?.classList.add('selected');
    } else {
      el?.classList.remove('selected');
    }
  }

  setSelectedIndex(selector: string, index: number): void {
    const el = this.getCachedElement(selector) as HTMLSelectElement;
    if (el) el.selectedIndex = index;
  }

  setPercentage(selector: string, percentage: number, zoneIndex: number): void {
    const el = this.getCachedElement(selector) as HTMLInputElement;
    if (el) el.value = String(percentage);
    let outputSelector = selector;
    if (outputSelector.startsWith('.')) {
      outputSelector = outputSelector.substring(1);
    }
    const outputEl = this.getCachedElement(`output[for="${outputSelector}${zoneIndex}"]`);
    if (outputEl) (outputEl as HTMLOutputElement).value = percentage + '%';
  }

  get(selector: string): Element | null {
    return this.getCachedElement(selector);
  }
}

class SeqStep {
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

class DrumLane {
  steps: (SeqStep | null)[] = [];
  note = 36;
  enabled = true;
}

class SeqLayer {
  steps: (SeqStep | null)[] = [];
  division = 14;
  ticks = DIV_TICKS[this.division];
  length = 16;
  drum_lanes: DrumLane[] = [];

  toJSON(): object {
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
  static MAX_LANES_DRUMS = 10;
  static CYCLE_CONDITIONS: [number, number][] = [];
  static ACTIVE_LAYER_INDEX = 0;
  static NEXT_LAYER_INDEX = 0;
  static LAYER_TICK_N = 0;
  static LAYER_QUANT_TICKS: DivTick = DIV_TICKS[2];

  static setQuantDiv(index: number): void {
    Sequence.LAYER_QUANT_TICKS = DIV_TICKS[index] as DivTick;
  }

  static getIdForDrumStep(laneIndex: number, stepIndex: number): number {
    return (laneIndex + 1) * 512 + stepIndex;
  }

  static getLaneAndStepIndexForDrumStepId(drumStepId: number): [number, number] {
    return [Math.floor(drumStepId / 512) - 1, drumStepId & 511];
  }

  static cloneStep(step: SeqStep | null): SeqStep {
    return SeqStep.from(step);
  }

  _active = false;
  layers = [new SeqLayer(), new SeqLayer(), new SeqLayer(), new SeqLayer()];
  selectedStepNumbers = new Set<number>();
  currentStepNumber = -1;
  previousStepNumber = -1;
  zone: Zone;
  _selectedStep = -1;
  isHotRecordingNotes = false;
  isLiveRecoding = false;
  isDrumSequence = false;
  drumLanes = 4;
  activeSteps: SeqStep[] = [];
  private rngProb = seedrandom();
  cycleCount = -1;
  previousStepPlayed = false;
  isFirstCycle = true;
  stepAdvance = false;
  stepAddNotes = false;
  liveTargetStep: SeqStep | null = null;
  liveTargetLength = 0;
  liveTargetStepNumber = -1;
  tickn = 0;

  constructor(zone: Zone) {
    this.zone = zone;
  }

  toJSON(): object {
    return {
      active: this.active,
      layers: this.layers,
      isDrumSequence: this.isDrumSequence,
      drumLanes: this.drumLanes
    };
  }

  set active(v: boolean) {
    this._active = v;
    if (v && this.zone.elements) {
      requestAnimationFrame(() => {
        this.zone.elements.sequencerGridStepElements.forEach((e: Element) => {
          e.classList.remove('playhead');
        });
      });
    }
  }

  get active(): boolean {
    return this._active;
  }

  get length(): number {
    return this.activeLayer.length;
  }

  set length(len: number) {
    this.activeLayer.length = len;
  }

  get division(): number {
    return this.activeLayer.division;
  }

  set division(v: number) {
    this.activeLayer.division = v;
    this.activeLayer.ticks = DIV_TICKS[v];
  }

  get ticks(): number {
    return this.activeLayer.ticks;
  }

  set ticks(v: number) {
    // only for backwards compatibility
  }

  get steps(): (SeqStep | null)[] {
    return this.activeLayer.steps;
  }

  set steps(steplist: (SeqStep | null)[]) {
    this.activeLayer.steps = steplist;
  }

  clearSelection(): void {
    this.selectedStepNumbers.clear();
    this.isHotRecordingNotes = false;
  }

  get selectedStepNumber(): number {
    return this.selectedStepNumbers.size == 1
      ? this.selectedStepNumbers.values().next().value
      : -1;
  }

  set selectedStepNumber(v: number) {
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

  get selectedStep(): SeqStep | null {
    if (this.selectedStepNumber > -1) {
      if (this.isDrumSequence) {
        const [laneIndex, stepIndex] = Sequence.getLaneAndStepIndexForDrumStepId(this.selectedStepNumber);
        return this.getDrumLane(laneIndex)?.steps[stepIndex] || null;
      } else {
        return this.steps[this.selectedStepNumber];
      }
    }
    return null;
  }

  get selectedSteps(): (SeqStep | null)[] {
    const result: (SeqStep | null)[] = [];
    this.selectedStepNumbers.forEach((sn) => {
      let step: SeqStep | null;
      if (this.isDrumSequence) {
        const [laneIndex, stepIndex] = Sequence.getLaneAndStepIndexForDrumStepId(sn);
        step = this.getDrumLane(laneIndex)?.steps[stepIndex] || null;
      } else {
        step = this.steps[sn];
      }
      result.push(step);
    });
    return result;
  }

  get hasSelection(): boolean {
    return this.selectedStepNumbers.size > 0;
  }

  isStepEmpty(index: number): boolean {
    if (this.isDrumSequence) {
      const [lindex, sindex] = Sequence.getLaneAndStepIndexForDrumStepId(index);
      return this.getDrumLane(lindex)?.steps[sindex] == null;
    } else {
      return this.steps[index] == null || this.steps[index]?.notesArray.length === 0;
    }
  }

  isStepUsed(index: number): boolean {
    return !this.isStepEmpty(index);
  }

  get activeLayer(): SeqLayer {
    return this.layers[Sequence.ACTIVE_LAYER_INDEX];
  }

  recordNote(note: Note, inCount: number): void {
    if (!this.isHotRecordingNotes && this.isLiveRecoding && this.currentStepNumber > -1) {
      if (this.liveTargetStep == null) {
        const rec2step = this.tickn >= this.ticks - this.ticks / 3
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

  noteReleased(count: number): void {
    if (this.isLiveRecoding && this.liveTargetStep) {
      this.liveTargetStep.length = this.liveTargetLength;
      this.steps[this.liveTargetStepNumber] = this.liveTargetStep;
      this.liveTargetStep = null;
      this.liveTargetLength = 0;
      this.liveTargetStepNumber = -1;
      this.updateRecordingState();
      this.updateZoneView();
    }
    if (this.isHotRecordingNotes && this.selectedStepNumber > -1 && count === 0) {
      this.selectedStep?.notesArray.sort((a, b) => a.number - b.number);
      if (this.stepAdvance) {
        this.selectedStepNumber = (this.selectedStepNumber + 1) % this.length;
      }
      this.updateZoneView();
      this.updateRecordingState();
    }
  }

  updateZoneView(allZones?: boolean): void {
    const event = new CustomEvent(Zone.updateZoneViewEventName, {
      detail: allZones ? null : this.zone
    });
    window.dispatchEvent(event);
  }

  updateRecordingState(): void {
    requestAnimationFrame(() => {
      if (this.hasSelection) {
        if (this.selectedStepNumber > -1) {
          const notesArray = this.selectedStep?.notesArray;
          const stepMarker = this.zone._$('.stepmarker') as HTMLElement;
          if (stepMarker) {
            if (this.isDrumSequence) {
              stepMarker.innerHTML = String(Sequence.getLaneAndStepIndexForDrumStepId(this.selectedStepNumber)[1] + 1);
            } else {
              stepMarker.innerHTML = String(this.selectedStepNumber + 1);
            }
          }
          let infoText = '';
          if (notesArray && notesArray.length > 0) {
            notesArray.forEach((note) => {
              const velopcnt = (note.velo / 127) * 100;
              let noteString: string;
              if (this.isDrumSequence) {
                const [laneNr] = Sequence.getLaneAndStepIndexForDrumStepId(this.selectedStepNumber);
                const lane = this.getDrumLane(laneNr);
                noteString = `#${lane.note} (${Note.display(lane.note)})`;
              } else {
                noteString = Note.display(note.number);
              }
              infoText += `<span class="note${note.isBlackKey ? ' black' : ''}"><span class="velocity" style="height:${velopcnt}%"></span>${noteString}</span> `;
            });
          } else {
            if (this.isHotRecordingNotes) {
              infoText += '<i>Empty step. Play some notes ...</i>';
            }
          }
          const stepNotes = this.zone.elements.sequencerElement?.querySelector('.step-notes');
          if (stepNotes) stepNotes.innerHTML = infoText;

          if (this.isHotRecordingNotes) {
            this.zone.elements.sequencerElement?.classList.add('hot');
          } else {
            this.zone.elements.sequencerElement?.classList.remove('hot');
          }
        } else {
          const stepMarker = this.zone._$('.stepmarker') as HTMLElement;
          if (stepMarker) stepMarker.innerHTML = '...';
          const stepNotes = this.zone._$('.step-notes') as HTMLElement;
          if (stepNotes) stepNotes.innerHTML = `<i>${this.selectedStepNumbers.size} steps selected</i>`;
        }
      }
    });
  }

  clock(pos: number): void {
    this.tickn = pos % this.ticks;
    Sequence.LAYER_TICK_N = pos % Sequence.LAYER_QUANT_TICKS;
    if (Sequence.LAYER_TICK_N === 0 && Sequence.ACTIVE_LAYER_INDEX != Sequence.NEXT_LAYER_INDEX) {
      Sequence.ACTIVE_LAYER_INDEX = Sequence.NEXT_LAYER_INDEX;
      this.updateZoneView(true);
    }
    if (this.activeSteps.length > 0) {
      const clearSteps: SeqStep[] = [];
      this.activeSteps.forEach((astep) => {
        if (this.tickn === 0) astep.played++;
        const offtick = Math.min(this.ticks * astep.gateLength, this.ticks - 1);
        if (astep.length - 1 - astep.played === 0 && this.tickn >= offtick) {
          clearSteps.push(astep);
          for (const note of astep.lastPlayedArray) {
            this.zone.handleMidi(
              MIDI.MESSAGE.NOTE_OFF,
              Uint8Array.from([MIDI.MESSAGE.NOTE_OFF + note.channel, note.number, note.velo]),
              true
            );
          }
          astep.lastPlayedArray.length = 0;
        }
      });
      this.activeSteps = this.activeSteps.filter((item) => !clearSteps.includes(item));
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
        const currentStepList: (SeqStep | null)[] = [];
        if (this.isDrumSequence) {
          for (let ln = 0; ln < this.drumLanes; ln++) {
            const lane = this.getDrumLane(ln);
            if (!lane.enabled) continue;
            const step = lane?.steps[this.currentStepNumber];
            if (step != null && step.notesArray.length > 0) {
              step.notesArray[0].number = lane.note;
            }
            currentStepList.push(step);
          }
        } else {
          currentStepList.push(this.steps[this.currentStepNumber]);
        }
        for (const currentStep of currentStepList) {
          if (currentStep) {
            if (this.checkCondition(currentStep) && this.rngProb() < currentStep.probability) {
              currentStep.played = 0;
              this.activeSteps.push(currentStep);
              for (const inote of currentStep.notesArray) {
                const note = Note.clone(inote);
                note.channel = this.zone.channel;
                note.portId = this.zone.outputPortId;
                this.zone.handleMidi(
                  MIDI.MESSAGE.NOTE_ON,
                  Uint8Array.from([MIDI.MESSAGE.NOTE_ON + note.channel, note.number, note.velo]),
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

  stopped(): void {
    this.activeSteps.forEach((astep) => {
      for (const note of astep.lastPlayedArray) {
        this.zone.handleMidi(
          MIDI.MESSAGE.NOTE_OFF,
          Uint8Array.from([MIDI.MESSAGE.NOTE_OFF + note.channel, note.number, note.velo]),
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

  activeNotes(): Note[] {
    const result: Note[] = [];
    this.activeSteps.forEach((astep) => {
      result.push(...astep.lastPlayedArray);
    });
    return result;
  }

  transpose(semitones: number): void {
    let steplist: (SeqStep | null)[];
    if (this.hasSelection) {
      steplist = Array.from(this.selectedStepNumbers).map((n) => this.steps[n]);
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

  checkCondition(step: SeqStep): boolean {
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

  velocityMediumSelectedStep(): number {
    let medium = 0;
    if (this.selectedStepNumber > -1 && this.selectedStep && this.selectedStep.notesArray) {
      if (this.selectedStep.notesArray.length > 0) {
        this.selectedStep.notesArray.forEach((note) => {
          medium += note.velo;
        });
        medium = Math.floor(medium / this.selectedStep.notesArray.length);
      }
    }
    return medium / 127;
  }

  getDrumLane(lane: number): DrumLane {
    if (this.activeLayer.drum_lanes[lane] == null) {
      const nl = new DrumLane();
      nl.note = lane + 36;
      this.activeLayer.drum_lanes[lane] = nl;
    }
    return this.activeLayer.drum_lanes[lane];
  }

  turnOnDrumStep(lane: number, stepNo: number): void {
    const drumLane = this.getDrumLane(lane);
    if (drumLane.steps[stepNo] == null) {
      const step = new SeqStep();
      step.notesArray.push(new Note(drumLane.note, 96));
      drumLane.steps[stepNo] = step;
    }
  }

  hasDrumStep(lane: number, stepNo: number): boolean {
    return this.getDrumLane(lane).steps[stepNo] != null;
  }
}

// Initialize CYCLE_CONDITIONS
if (Sequence.CYCLE_CONDITIONS.length == 0) {
  for (let cycles = 2; cycles < 9; cycles++) {
    for (let b = 0; b < cycles; b++) {
      Sequence.CYCLE_CONDITIONS.push([cycles, b + 1]);
    }
  }
  console.log('Sequence: Initialized cycle conditions: ', Sequence.CYCLE_CONDITIONS);
}

class Zone {
  static solocount = 0;
  static seqClipboardStep: Map<number, SeqStep> | null = null;
  static seqClipboardSequence: string | null = null;
  static updateZoneViewEventName = 'update-zone-view';

  static scaledCanvasContext(canvas: HTMLCanvasElement): { context: CanvasRenderingContext2D; rect: DOMRect } {
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
  cc = false;
  cc_controllers: CCController[] = [
    { number: 7, number_in: null, label: 'Volume', val: 100, type: 0, min: 0, max: 127, note_cc: null, velocity_cc: null },
    { number: 1, number_in: null, label: 'Mod Wheel', val: 0, type: 0, min: 0, max: 127, note_cc: null, velocity_cc: null }
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

  toJSON(): object {
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
    const paletteIndex = typeof index == 'number' ? Math.floor(index % 5) : this.colorIndex + 1;
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
    this.midi.send(
      Uint8Array.from([MIDI.MESSAGE.CONTROLLER + this.channel, 64, v ? 127 : 0]),
      this.outputPortId
    );
  }

  addNote(note: Note): void {
    if (this.activeNotes.length === 0) {
      this.holdList = [];
    }
    this.activeNotes.push(note);
    const existingIndex = this.holdList.findIndex((n) => n.number == note.number);
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

  handleMidi(message: number, data: Uint8Array, fromSequencer?: boolean): string | void {
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
                const playNote = new Note(key, velo, this.channel, this.outputPortId);
                this.midiActiveNotes[srcKey] = playNote;
                this.addNote(playNote);
                if (fromMidiInput) {
                  let filteredActiveNotes = [...this.activeNotes];
                  this.sequence.activeNotes().forEach((seqNote) => {
                    filteredActiveNotes = filteredActiveNotes.filter(
                      (activeNote) => activeNote.number !== seqNote.number
                    );
                  });
                  this.sequence.recordNote(playNote, filteredActiveNotes.length);
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
      this.arp.sortedlist = Array.from(this.arp.orderlist).sort((a, b) => a.number - b.number);
      this.arp_sortedHoldList = Array.from(this.arp_holdlist).sort((a, b) => a.number - b.number);
    }
    requestAnimationFrame(this.renderNotes.bind(this));
  }

  renderNotes(): void {
    if (this.elements.isReady && this.elements.canvasElement) {
      const { context, rect } = Zone.scaledCanvasContext(this.elements.canvasElement);
      const cwidth = rect.width;
      const numberWhiteKeys = 10 * 7 + 4;
      const notewidth = cwidth / numberWhiteKeys;
      const whitekeywidth = notewidth * 0.75;
      const blackkeywidth = notewidth * 0.67;
      const blackkeyoffset = notewidth * 0.67;
      const whitekeyoffset = (notewidth - whitekeywidth) * 0.5;

      context.clearRect(0, 0, cwidth, rect.height);

      const drawNote = (number: number, fillStyle: string, fillStyleBlack: string): void => {
        const isBlack = Note.isBlackKey(number);
        const wkIndex = Note.nearestWhiteKeyIndex(number);
        context.fillStyle = isBlack ? fillStyleBlack : fillStyle;
        context.beginPath();
        if (isBlack) {
          context.roundRect(notewidth * wkIndex + blackkeyoffset, note_top, blackkeywidth, note_height_black, [0, 0, 1, 1]);
        } else {
          context.roundRect(whitekeyoffset + notewidth * wkIndex, note_top, whitekeywidth, note_height, [0, 0, 2, 2]);
        }
        context.fill();
        if (isBlack && !this.arp_enabled) context.stroke();
      };

      const drawNoteList = (list: number[], fillStyle: string, fillStyleBlack: string): void => {
        list.sort((a, b) => {
          const ba = Note.isBlackKey(a);
          const bb = Note.isBlackKey(b);
          if (ba && !bb) return 1;
          if (bb && !ba) return -1;
          return 0;
        });
        list.forEach((n) => drawNote(n, fillStyle, fillStyleBlack));
      };

      const noteList = this.arp_hold && this.arp_enabled ? this.arp_holdlist : this.activeNotes;
      const drawNumbers: number[] = [];
      for (let i = 0; i < noteList.length; i++) {
        if (this.arp_enabled) {
          for (let ao = 0; ao < this.arp_octaves + 1; ao++) {
            const number = noteList[i].number +
              (this.arp_transpose ? this.arp_transpose_amount : 0) +
              (this.octave + ao) * 12;
            drawNumbers.push(number);
          }
        } else {
          drawNumbers.push(noteList[i].number);
        }
      }
      drawNoteList(drawNumbers, this.arp_enabled ? note_fill_arp : note_fill, this.arp_enabled ? note_fill_arp_black : note_fill_black);
      if (this.arp_enabled) {
        const note = this.arp.lastnote;
        if (note) drawNote(note.number, note_fill_arp_played, note_fill_arp_played);
      }
    }
  }

  renderPattern(): void {
    if (this.elements.isReady && this.elements.patternCanvas) {
      const { context, rect } = Zone.scaledCanvasContext(this.elements.patternCanvas);
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
        const progressPercent = this.sequence.currentStepNumber / this.sequence.activeLayer.length;
        this.elements.sequencerGridElement?.scrollTo(
          (this.elements.sequencerGridElement.scrollWidth - this.elements.sequencerGridElement.offsetWidth * 0.75) * progressPercent,
          0
        );
        if (this.sequence.previousStepNumber > -1) {
          this.elements.sequencerDrumLanes.forEach((dl) => {
            (dl[this.sequence.previousStepNumber] as HTMLElement)?.classList.remove('playhead');
          });
        }
        if (this.sequence.currentStepNumber > -1) {
          this.elements.sequencerDrumLanes.forEach((dl) => {
            (dl[this.sequence.currentStepNumber] as HTMLElement)?.classList.add('playhead');
          });
        } else if (this.sequence.previousStepNumber == -1 && this.sequence.currentStepNumber == -1) {
          this.elements.sequencerDrumStepElements.forEach((e) => {
            (e as HTMLElement).classList.remove('playhead');
          });
        }
      } else {
        if (this.sequence.previousStepNumber > -1) {
          (this.elements.sequencerGridStepElements[this.sequence.previousStepNumber] as HTMLElement)?.classList.remove('playhead');
        }
        if (this.sequence.currentStepNumber > -1) {
          (this.elements.sequencerGridStepElements[this.sequence.currentStepNumber] as HTMLElement)?.classList.add('playhead');
        } else if (this.sequence.previousStepNumber == -1 && this.sequence.currentStepNumber == -1) {
          this.elements.sequencerGridStepElements.forEach((e) => {
            (e as HTMLElement).classList.remove('playhead');
          });
        }
      }
    } else {
      if (this.sequence.currentStepNumber > -1 && this.sequence.steps.length > 0 && this.elements.sequencerProgressElementInner) {
        this.elements.sequencerProgressElementInner.style.left = `${(this.sequence.currentStepNumber / this.sequence.length) * 100}%`;
      } else if (this.elements.sequencerProgressElementInner) {
        this.elements.sequencerProgressElementInner.style.left = '-100%';
      }
    }
  }

  clock(pos: number): void {
    this.sequence.clock(pos);
    const tickn = pos % this.arp_ticks;
    const offtick = Math.min(this.arp_ticks * this.arp_gatelength, this.arp_ticks - 1);
    if (tickn === 0) {
      const probable = this.rngProb() < this.arp_probability;
      this.arp.patternPos = (this.arp.patternPos + 1) % this.arp_pattern.length;
      if (this.arp_enabled && this.arp_pattern[this.arp.patternPos]) {
        this.arp.beat = true;
        let notes: Note[];
        if (this.arp_hold) {
          notes = Array.from(this.arp_direction > 2 ? this.arp_holdlist : this.arp_sortedHoldList);
        } else {
          notes = Array.from(this.arp_direction > 2 ? this.arp.orderlist : this.arp.sortedlist);
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
                this.arp.octave = Math.floor(this.rngArpOct() * (this.arp_octaves + 1));
                break;
            }
          }
          if (probable && this.arp.noteindex > -1 && this.arp.noteindex < notes.length) {
            const activeNote = repetition ? this.arp.repeatnote! : notes[this.arp.noteindex];
            let number = repetition
              ? activeNote.number
              : activeNote.number + (this.octave + this.arp.octave) * 12 + (this.arp_transpose ? this.arp_transpose_amount : 0);
            while (number > 127) number -= 12;
            while (number < 0) number += 12;
            const note = new Note(number, activeNote.velo, this.channel, this.outputPortId);
            this.arp.lastnote = note;
            this.midi.send(
              Uint8Array.from([MIDI.MESSAGE.NOTE_ON + this.channel, note.number, this.fixedvel ? this.fixedvel_value || 127 : note.velo]),
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
      this.midi.send(Uint8Array.from([MIDI.MESSAGE.NOTE_OFF + note.channel, note.number, note.velo]), note.portId);
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
    const is14bit = this.cc_controllers[index].type == 5 || this.cc_controllers[index].type == 6;
    if (is14bit) {
      this.midi.send(
        Uint8Array.from([MIDI.MESSAGE.CONTROLLER + this.channel, this.cc_controllers[index].number_lsb || 0, this.cc_controllers[index].val & 0x7f]),
        this.outputPortId
      );
      this.midi.send(
        Uint8Array.from([MIDI.MESSAGE.CONTROLLER + this.channel, this.cc_controllers[index].number, this.cc_controllers[index].val >> 7]),
        this.outputPortId
      );
    } else {
      this.midi.send(
        Uint8Array.from([MIDI.MESSAGE.CONTROLLER + this.channel, this.cc_controllers[index].number, this.remapCCValue(this.cc_controllers[index].val, index)]),
        this.outputPortId
      );
    }
  }

  sendProgramChange(): void {
    if (this.pgm_no) {
      this.midi.sendProgramChange(this.outputPortId, this.channel, this.pgm_no - 1);
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
    if (ctrl.type == 0 && ctrl.discreteValues != null && ctrl.discreteValues.length > 0) {
      const closest = ctrl.discreteValues.reduce((prev, curr) => {
        return Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev;
      });
      ctrl.val = closest;
    } else {
      ctrl.val = value;
    }
  }
}

export = { Note, Zone, Sequence, SeqLayer, ZoneElements };
