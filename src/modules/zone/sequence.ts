import { mulberry32 } from '../prng';
import MIDI from '../midi';
import { Note } from './note';
import { SeqStep } from './seq-step';
import { DrumLane } from './drum-lane';
import { DIV_TICKS, DivTick } from './seq-layer';
import { SequenceJSON, UPDATE_ZONE_VIEW_EVENT } from './interfaces';
import type { Zone } from './zone-class';

export class Sequence {
  static MAX_STEPS = 256;
  static MAX_STEPS_DRUMS = 64;
  static MAX_LANES_DRUMS = 12;
  static CYCLE_CONDITIONS: [number, number][] = [];
  static QUANT_TICK_N = 0;
  static QUANT_TICKS: DivTick = DIV_TICKS[2];

  static {
    for (let cycles = 2; cycles < 9; cycles++) {
      for (let b = 0; b < cycles; b++) {
        Sequence.CYCLE_CONDITIONS.push([cycles, b + 1]);
      }
    }
  }

  static setQuantDiv(index: number): void {
    Sequence.QUANT_TICKS = DIV_TICKS[index] as DivTick;
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
  _steps: (SeqStep | null)[] = [];
  _length = 16;
  _division = 14;
  _ticks: DivTick = DIV_TICKS[14] as DivTick;
  drum_lanes: DrumLane[] = [];
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
  private ratchetQueue: { note: Note; noteOnPos: number; noteOffPos: number }[] = [];
  private readonly _midiMsgBuf = new Uint8Array(3);
  private rngProb = mulberry32();
  currentPos = 0; // Track current clock position for swing timing
  // Swing pending steps
  private swingPendingDrumSteps: {
    laneIndex: number;
    stepIndex: number;
    fireAtPos: number;
  }[] = [];
  private swingPendingRegularSteps: {
    stepIndex: number;
    fireAtPos: number;
  }[] = [];
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
      steps: this._steps,
      length: this._length,
      ticks: this._ticks,
      division: this._division,
      isDrumSequence: this.isDrumSequence,
      drumLanes: this.drumLanes,
      drum_lanes: this.drum_lanes
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
    return this._length;
  }

  set length(len: number) {
    this._length = len;
  }

  get division(): number {
    return this._division;
  }

  set division(v: number) {
    this._division = v;
    this._ticks = DIV_TICKS[v] as DivTick;
  }

  get ticks(): number {
    return this._ticks;
  }

  set ticks(v: number) {
    // backward compatibility only — ticks are derived from division at runtime
  }

  get steps(): (SeqStep | null)[] {
    return this._steps;
  }

  set steps(steplist: (SeqStep | null)[]) {
    this._steps = steplist;
  }

  get drumSteps(): (SeqStep | null)[] {
    const result = [];
    this.drum_lanes.forEach((drumlane) => {
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
    window.dispatchEvent(new CustomEvent(UPDATE_ZONE_VIEW_EVENT, {
      detail: allZones ? null : this.zone
    }));
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
    this.currentPos = pos;
    this.tickn = pos % this.ticks;
    
    // Process pending swung steps first (before ratchet processing)
    if (this.zone.swingAmount > 0) {
      if (this.isDrumSequence) {
        this.processPendingSwingDrumSteps(pos);
      } else {
        this.processPendingSwingRegularSteps(pos);
      }
    }
    
    if (this.ratchetQueue.length > 0) {
      // note-offs first so same-tick transitions are clean
      for (let i = this.ratchetQueue.length - 1; i >= 0; i--) {
        const ev = this.ratchetQueue[i];
        if (ev.noteOnPos === -1 && pos >= ev.noteOffPos) {
          this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_OFF + ev.note.channel;
          this._midiMsgBuf[1] = ev.note.number;
          this._midiMsgBuf[2] = 0;
          this.zone.handleMidi(MIDI.MESSAGE.NOTE_OFF, this._midiMsgBuf, true);
          this.ratchetQueue.splice(i, 1);
        }
      }
      for (const ev of this.ratchetQueue) {
        if (ev.noteOnPos !== -1 && pos >= ev.noteOnPos) {
          this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_ON + ev.note.channel;
          this._midiMsgBuf[1] = ev.note.number;
          this._midiMsgBuf[2] = ev.note.velo;
          this.zone.handleMidi(MIDI.MESSAGE.NOTE_ON, this._midiMsgBuf, true);
          ev.noteOnPos = -1;
        }
      }
    }
    if (this.activeSteps.length > 0) {
      const clearSteps: SeqStep[] = [];
      this.activeSteps.forEach((astep) => {
        if (this.tickn === 0) astep.played++;
        const offtick = Math.min(this.ticks * astep.gateLength, this.ticks - 1);
        if (astep.length - 1 - astep.played === 0 && this.tickn >= offtick) {
          clearSteps.push(astep);
          for (const note of astep.lastPlayedArray) {
            this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_OFF + note.channel;
            this._midiMsgBuf[1] = note.number;
            this._midiMsgBuf[2] = note.velo;
            this.zone.handleMidi(MIDI.MESSAGE.NOTE_OFF, this._midiMsgBuf, true);
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
        if (this.isDrumSequence) {
          this.processDrumSequenceStep(pos);
        } else {
          this.processRegularSequenceStep(pos);
        }
      }
      requestAnimationFrame(this.zone._renderSequenceBound);
    }
  }

  /**
   * Process drum sequence steps at step boundary
   */
  private processDrumSequenceStep(pos: number): void {
    const soloCount = this.getDrumLaneSoloCount();
    for (let ln = 0; ln < this.drumLanes; ln++) {
      const lane = this.getDrumLane(ln);
      lane.previousStep = lane.currentStep;
      lane.currentStep = (lane.currentStep + 1) % lane.length;
      if (lane.currentStep === 0) {
        lane.cycleCount++;
        if (lane.cycleCount === 1) lane.isFirstCycle = false;
      }

      if (!lane.enabled || (soloCount > 0 && !lane.solo)) {
        lane.previousStepPlayed = false;
        continue;
      }
      const step = lane.steps[lane.currentStep];
      if (step == null || step.notesArray.length === 0) {
        // Don't update previousStepPlayed for empty steps
        continue;
      }

      // Evaluate condition and probability exactly once at step boundary
      const shouldPlay =
        this.checkCondition(step, lane.cycleCount, lane.isFirstCycle, lane.previousStepPlayed) &&
        this.rngProb() < step.probability;
      lane.previousStepPlayed = shouldPlay;

      if (!shouldPlay) continue;

      if (this.zone.swingAmount > 0) {
        const swingOffset = this.calculateSwingOffset(lane.currentStep);
        if (swingOffset > 0) {
          this.swingPendingDrumSteps.push({
            laneIndex: ln,
            stepIndex: lane.currentStep,
            fireAtPos: pos + swingOffset
          });
          continue;
        }
      }
      this.playDrumStep(ln, lane.currentStep);
    }
  }

  /**
   * Process regular sequence steps at step boundary
   */
  private processRegularSequenceStep(pos: number): void {
    const currentStep = this.steps[this.currentStepNumber];
    if (!currentStep) return;

    // Evaluate condition and probability exactly once at step boundary
    const shouldPlay = this.checkCondition(currentStep) && this.rngProb() < currentStep.probability;
    this.previousStepPlayed = shouldPlay;

    if (!shouldPlay) return;

    if (this.zone.swingAmount > 0) {
      const swingOffset = this.calculateSwingOffset(this.currentStepNumber);
      if (swingOffset > 0) {
        this.swingPendingRegularSteps.push({
          stepIndex: this.currentStepNumber,
          fireAtPos: pos + swingOffset
        });
        return;
      }
    }

    this.playRegularStep(this.currentStepNumber);
  }

  stopped(): void {
    this.activeSteps.forEach((astep) => {
      for (const note of astep.lastPlayedArray) {
        this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_OFF + note.channel;
        this._midiMsgBuf[1] = note.number;
        this._midiMsgBuf[2] = 0;
        this.zone.handleMidi(MIDI.MESSAGE.NOTE_OFF, this._midiMsgBuf, true);
      }
      astep.lastPlayedArray.length = 0;
    });
    this.activeSteps.length = 0;
    for (const ev of this.ratchetQueue) {
      if (ev.noteOnPos === -1) {
        this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_OFF + ev.note.channel;
        this._midiMsgBuf[1] = ev.note.number;
        this._midiMsgBuf[2] = 0;
        this.zone.handleMidi(MIDI.MESSAGE.NOTE_OFF, this._midiMsgBuf, true);
      }
    }
    this.ratchetQueue.length = 0;
    this.currentStepNumber = this.previousStepNumber = -1;
    this.drum_lanes.forEach((lane) => {
      if (lane) {
        lane.currentStep = -1;
        lane.previousStep = -1;
        lane.cycleCount = -1;
        lane.isFirstCycle = true;
        lane.previousStepPlayed = false;
      }
    });
    this.cycleCount = -1;
    this.previousStepPlayed = false;
    this.isFirstCycle = true;
    this.liveTargetLength = 0;
    this.liveTargetStep = null;
    this.isLiveRecoding = false;
    this.updateRecordingState();
    requestAnimationFrame(this.zone._renderSequenceBound);
    requestAnimationFrame(this.zone._renderNotesBound);
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

  checkCondition(step: SeqStep, cycleCnt = this.cycleCount, firstCycle = this.isFirstCycle, previousStepPlayed = this.previousStepPlayed): boolean {
    switch (step.condition) {
      case 0:
        return true;
      case 1:
        return previousStepPlayed;
      case 2:
        return !previousStepPlayed;
      case 3:
        return firstCycle;
      case 4:
        return !firstCycle;
    }
    const condition = Sequence.CYCLE_CONDITIONS[step.condition - 5];
    return cycleCnt % condition[0] === condition[1] - 1;
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
    if (this.drum_lanes[lane] == null) {
      const nl = new DrumLane();
      nl.note = lane + 36;
      nl.length = this._length;
      this.drum_lanes[lane] = nl;
    }
    return this.drum_lanes[lane];
  }

  getDrumLaneSoloCount(): number {
    return this.drum_lanes.filter((l) => l != null && l.solo).length;
  }

  fillDrumLaneEuclidean(laneIndex: number, hits: number, offset = 0): void {
    const lane = this.getDrumLane(laneIndex);
    const length = lane.length;
    hits = Math.max(0, Math.min(hits, length));
    offset = ((offset % length) + length) % length;
    for (let i = 0; i < length; i++) {
      lane.steps[i] = null;
    }
    if (hits === 0) return;
    const s = hits / length;
    let previous = -1;
    for (let i = 0; i < length; i++) {
      const current = Math.floor(i * s);
      if (current !== previous) {
        this.turnOnDrumStep(laneIndex, (i + offset) % length);
      }
      previous = current;
    }
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

  // ========== SWING METHODS ==========

  /**
   * Calculate swing offset in ticks for a given step index
   * Off-beat steps (1, 3, 5...) are delayed based on swingAmount
   */
  private calculateSwingOffset(stepIndex: number): number {
    // stepIndex 0, 2, 4, 6... = on-beat (no swing)
    // stepIndex 1, 3, 5, 7... = off-beat (swing applied)
    if (stepIndex % 2 === 0) {
      return 0; // On-beat, no swing
    }

    // Off-beat: calculate delay in ticks
    // swingAmount of 0.5 = 50% swing (16th triplet feel)
    const ticksPerStep = this.ticks;
    const offset = this.zone.swingAmount * ticksPerStep * 0.5;
    return Math.floor(offset);
  }

  /**
   * Process any pending drum steps that should fire at the current position
   */
  private processPendingSwingDrumSteps(pos: number): void {
    for (let i = this.swingPendingDrumSteps.length - 1; i >= 0; i--) {
      const pending = this.swingPendingDrumSteps[i];
      if (pos >= pending.fireAtPos) {
        this.playDrumStep(pending.laneIndex, pending.stepIndex);
        this.swingPendingDrumSteps.splice(i, 1);
      }
    }
  }

  /**
   * Process any pending regular sequence steps that should fire at the current position
   */
  private processPendingSwingRegularSteps(pos: number): void {
    for (let i = this.swingPendingRegularSteps.length - 1; i >= 0; i--) {
      const pending = this.swingPendingRegularSteps[i];
      if (pos >= pending.fireAtPos) {
        this.playRegularStep(pending.stepIndex);
        this.swingPendingRegularSteps.splice(i, 1);
      }
    }
  }

  /**
   * Play a drum step unconditionally (condition/probability already evaluated at boundary).
   */
  private playDrumStep(laneIndex: number, stepIndex: number): void {
    const lane = this.getDrumLane(laneIndex);
    if (!lane || !lane.enabled) return;

    const soloCount = this.getDrumLaneSoloCount();
    if (soloCount > 0 && !lane.solo) return;

    const step = lane.steps[stepIndex];
    if (step == null || step.notesArray.length === 0) return;

    const ratchetCount = step.ratchetCount ?? 1;
    if (ratchetCount > 1) {
      const baseVelo = step.notesArray[0].velo;
      const ratchetRes = step.ratchetResolution;
      const ratchetDelta = step.ratchetVelocityDelta ?? 0;
      const gateLen = Math.max(1, ratchetRes - 1);
      for (let hitIdx = 0; hitIdx < ratchetCount; hitIdx++) {
        const hitVelo = Math.max(1, Math.min(127, baseVelo + hitIdx * ratchetDelta));
        const hitNote = new Note(lane.note, hitVelo);
        hitNote.channel = this.zone.channel;
        hitNote.portId = this.zone.outputPortId;
        if (hitIdx === 0) {
          this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_ON + hitNote.channel;
          this._midiMsgBuf[1] = hitNote.number;
          this._midiMsgBuf[2] = hitNote.velo;
          this.zone.handleMidi(MIDI.MESSAGE.NOTE_ON, this._midiMsgBuf, true);
          this.ratchetQueue.push({ note: hitNote, noteOnPos: -1, noteOffPos: this.currentPos + gateLen });
        } else {
          const firePos = this.currentPos + hitIdx * ratchetRes;
          this.ratchetQueue.push({ note: hitNote, noteOnPos: firePos, noteOffPos: firePos + gateLen });
        }
      }
    } else {
      step.played = 0;
      this.activeSteps.push(step);
      const velo = step.notesArray[0].velo;
      const note = new Note(lane.note, velo);
      note.channel = this.zone.channel;
      note.portId = this.zone.outputPortId;
      this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_ON + note.channel;
      this._midiMsgBuf[1] = note.number;
      this._midiMsgBuf[2] = note.velo;
      this.zone.handleMidi(MIDI.MESSAGE.NOTE_ON, this._midiMsgBuf, true);
      step.lastPlayedArray.push(note);
    }
  }

  /**
   * Play a regular sequence step unconditionally (condition/probability already evaluated at boundary).
   */
  private playRegularStep(stepIndex: number): void {
    const step = this.steps[stepIndex];
    if (!step) return;
    step.played = 0;
    this.activeSteps.push(step);
    for (const inote of step.notesArray) {
      const note = Note.clone(inote);
      note.channel = this.zone.channel;
      note.portId = this.zone.outputPortId;
      this._midiMsgBuf[0] = MIDI.MESSAGE.NOTE_ON + note.channel;
      this._midiMsgBuf[1] = note.number;
      this._midiMsgBuf[2] = note.velo;
      this.zone.handleMidi(MIDI.MESSAGE.NOTE_ON, this._midiMsgBuf, true);
      step.lastPlayedArray.push(note);
    }
  }
}
