import seedrandom from 'seedrandom';
import MIDI from '../midi';
import { Note } from './note';
import { SeqStep } from './seq-step';
import { SeqLayer, DIV_TICKS, DivTick } from './seq-layer';
import { DrumLane } from './drum-lane';
import { SequenceJSON } from './interfaces';
import type { Zone } from './zone-class';

export class Sequence {
  static MAX_STEPS = 256;
  static MAX_STEPS_DRUMS = 64;
  static MAX_LANES_DRUMS = 10;
  static CYCLE_CONDITIONS: [number, number][] = [];
  static ACTIVE_LAYER_INDEX = 0;
  static NEXT_LAYER_INDEX = 0;
  static LAYER_TICK_N = 0;
  static LAYER_QUANT_TICKS: DivTick = DIV_TICKS[2];

  static {
    for (let cycles = 2; cycles < 9; cycles++) {
      for (let b = 0; b < cycles; b++) {
        Sequence.CYCLE_CONDITIONS.push([cycles, b + 1]);
      }
    }
  }

  static setQuantDiv(index: number): void {
    Sequence.LAYER_QUANT_TICKS = DIV_TICKS[index] as DivTick;
  }

  static getIdForDrumStep(laneIndex: number, stepIndex: number): number {
    return (laneIndex + 1) * 512 + stepIndex;
  }

  static getLaneAndStepIndexForDrumStepId(
    drumStepId: number
  ): [number, number] {
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

  toJSON(): SequenceJSON {
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

  get drumSteps(): (SeqStep | null)[] {
    const result = [];
    this.activeLayer.drum_lanes.forEach((drumlane) => {
      if (drumlane.steps?.length > 0) result.push(...drumlane.steps);
    });
    return result;
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
        const [laneIndex, stepIndex] =
          Sequence.getLaneAndStepIndexForDrumStepId(this.selectedStepNumber);
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
        const [laneIndex, stepIndex] =
          Sequence.getLaneAndStepIndexForDrumStepId(sn);
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
      return (
        this.steps[index] == null || this.steps[index]?.notesArray.length === 0
      );
    }
  }

  isStepUsed(index: number): boolean {
    return !this.isStepEmpty(index);
  }

  get activeLayer(): SeqLayer {
    return this.layers[Sequence.ACTIVE_LAYER_INDEX];
  }

  recordNote(note: Note, inCount: number): void {
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
    if (
      this.isHotRecordingNotes &&
      this.selectedStepNumber > -1 &&
      count === 0
    ) {
      this.selectedStep?.notesArray.sort((a, b) => a.number - b.number);
      if (this.stepAdvance) {
        this.selectedStepNumber = (this.selectedStepNumber + 1) % this.length;
      }
      this.updateZoneView();
      this.updateRecordingState();
    }
  }

  updateZoneView(allZones?: boolean): void {
    // Dynamic import to avoid circular dependency
    import('./zone-class').then(({ Zone }) => {
      const event = new CustomEvent(Zone.updateZoneViewEventName, {
        detail: allZones ? null : this.zone
      });
      window.dispatchEvent(event);
    });
  }

  updateRecordingState(): void {
    requestAnimationFrame(() => {
      if (this.hasSelection) {
        if (this.selectedStepNumber > -1) {
          const notesArray = this.selectedStep?.notesArray;
          const stepMarker = this.zone._$('.stepmarker') as HTMLElement;
          if (stepMarker) {
            if (this.isDrumSequence) {
              stepMarker.innerHTML = String(
                Sequence.getLaneAndStepIndexForDrumStepId(
                  this.selectedStepNumber
                )[1] + 1
              );
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
                const [laneNr] = Sequence.getLaneAndStepIndexForDrumStepId(
                  this.selectedStepNumber
                );
                const lane = this.getDrumLane(laneNr);
                noteString = `#${lane.note} (${Note.display(lane.note)})`;
              } else {
                noteString = Note.display(note.number);
              }
              infoText += `<span class="note${
                note.isBlackKey ? ' black' : ''
              }"><span class="velocity" style="height:${velopcnt}%"></span>${noteString}</span> `;
            });
          } else {
            if (this.isHotRecordingNotes) {
              infoText += '<i>Empty step. Play some notes ...</i>';
            }
          }
          const stepNotes =
            this.zone.elements.sequencerElement?.querySelector('.step-notes');
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
          if (stepNotes)
            stepNotes.innerHTML = `<i>${this.selectedStepNumbers.size} steps selected</i>`;
        }
      }
    });
  }

  clock(pos: number): void {
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
      const clearSteps: SeqStep[] = [];
      this.activeSteps.forEach((astep) => {
        if (this.tickn === 0) astep.played++;
        const offtick = Math.min(this.ticks * astep.gateLength, this.ticks - 1);
        if (astep.length - 1 - astep.played === 0 && this.tickn >= offtick) {
          clearSteps.push(astep);
          for (const note of astep.lastPlayedArray) {
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
            if (
              this.checkCondition(currentStep) &&
              this.rngProb() < currentStep.probability
            ) {
              currentStep.played = 0;
              this.activeSteps.push(currentStep);
              for (const inote of currentStep.notesArray) {
                const note = Note.clone(inote);
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

  stopped(): void {
    this.activeSteps.forEach((astep) => {
      for (const note of astep.lastPlayedArray) {
        this.zone.handleMidi(
          MIDI.MESSAGE.NOTE_OFF,
          Uint8Array.from([
            MIDI.MESSAGE.NOTE_OFF + note.channel,
            note.number,
            0
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
    if (
      this.selectedStepNumber > -1 &&
      this.selectedStep &&
      this.selectedStep.notesArray
    ) {
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
