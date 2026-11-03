import { hashRoll, randomSeed } from '../prng';
import MIDI from '../midi';
import { Note } from './note';
import { SeqStep } from './seq-step';
import { DrumLane } from './drum-lane';
import { DIV_TICKS, DivTick, swingOffsetMs } from './seq-layer';
import { SequenceJSON, StepCondition, UPDATE_ZONE_VIEW_EVENT } from './interfaces';
import type { Zone } from './zone-class';

export class Sequence {
  static MAX_STEPS = 256;
  static MAX_STEPS_DRUMS = 64;
  static MAX_LANES_DRUMS = 12;
  static CYCLE_CONDITIONS: [number, number][] = [];

  static {
    for (let cycles = 2; cycles < 9; cycles++) {
      for (let b = 0; b < cycles; b++) {
        Sequence.CYCLE_CONDITIONS.push([cycles, b + 1]);
      }
    }
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
  isLiveRecording = false;
  isDrumSequence = false;
  drumLanes = 4;
  activeSteps: SeqStep[] = [];
  private ratchetQueue: { note: Note; noteOnPos: number; noteOffPos: number }[] = [];
  private readonly _midiMsgBuf = new Uint8Array(3);
  // Chance is decided per run, cycle and step (chanceRoll), so the track view can
  // show ahead which steps will play; renewed on stop
  private chanceSeed = randomSeed();
  currentPos = 0; // Track current clock position for swing timing
  // Outstanding setTimeout handles for swung note-on dispatch; cancelled on stopped().
  private swingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  cycleCount = -1;
  previousStepPlayed = false;
  isFirstCycle = true;
  // Condition result per step as [cycleCount, met], for the live display; not saved
  conditionResults: [number, boolean][] = [];
  stepAdvance = false;
  stepAddNotes = false;
  liveTargetStep: SeqStep | null = null;
  liveTargetStepNumber = -1;
  liveNoteSteps = new Map<number, { stepIndex: number; startPos: number }>();
  liveTargetStepStartPos = 0;
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
    const changed = v !== this._active;
    this._active = v;
    if (changed) this.zone.sequenceActiveChanged(this, v);
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
    const result: (SeqStep | null)[] = [];
    this.drum_lanes.forEach((drumlane) => {
      if (drumlane.steps?.length > 0) result.push(...drumlane.steps);
    });
    return result;
  }

  clearSelection(): void {
    this.selectedStepNumbers.clear();
    this.isHotRecordingNotes = false;
    this.zone.lockEditEnded();
  }

  get selectedStepNumber(): number {
    return this.selectedStepNumbers.size == 1
      ? this.selectedStepNumbers.values().next().value!
      : -1;
  }

  set selectedStepNumber(v: number) {
    this.selectedStepNumbers.clear();
    if (v > -1) {
      this.selectedStepNumbers.add(v);
      this.isLiveRecording = false;
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

  /** A step by its number in the grid (a drum step id in drum mode) */
  stepAt(n: number): SeqStep | null {
    if (!this.isDrumSequence) return this.steps[n] ?? null;
    const [laneIndex, stepIndex] = Sequence.getLaneAndStepIndexForDrumStepId(n);
    return this.getDrumLane(laneIndex).steps[stepIndex] ?? null;
  }

  get hasSelection(): boolean {
    return this.selectedStepNumbers.size > 0;
  }

  isStepEmpty(index: number): boolean {
    if (this.isDrumSequence) {
      const [lindex, sindex] = Sequence.getLaneAndStepIndexForDrumStepId(index);
      return this.getDrumLane(lindex)?.steps[sindex] == null;
    } else {
      return this.steps[index] == null || this.steps[index]!.isBlank();
    }
  }

  isStepUsed(index: number): boolean {
    return !this.isStepEmpty(index);
  }

  recordNote(note: Note, inCount: number): void {
    if (
      !this.isHotRecordingNotes &&
      this.isLiveRecording &&
      this.currentStepNumber > -1
    ) {
      let isSequentialAdvance = false;
      if (this.liveTargetStep && this.currentPos - this.liveTargetStepStartPos >= this.ticks / 2) {
        // Commit notes immediately; length will be resolved when each note is released
        this.steps[this.liveTargetStepNumber] = this.liveTargetStep;
        for (const n of this.liveTargetStep.notesArray) {
          this.liveNoteSteps.set(n.number, {
            stepIndex: this.liveTargetStepNumber,
            startPos: this.liveTargetStepStartPos,
          });
        }
        this.liveTargetStep = null;
        this.liveTargetStepNumber = -1;
        isSequentialAdvance = true;
      }
      if (this.liveTargetStep == null) {
        const rec2step =
          this.tickn >= this.ticks / 2
            ? (this.currentStepNumber + 1) % this.length
            : this.currentStepNumber;
        this.liveTargetStepNumber = rec2step;
        this.liveTargetStep = SeqStep.from(this.steps[rec2step]);
        if ((inCount === 1 || isSequentialAdvance) && !this.stepAddNotes) {
          this.liveTargetStep.notesArray.length = 0;
        }
        this.liveTargetStepStartPos = this.currentPos;
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

  noteReleased(noteNumber: number, count: number): void {
    const pending = this.liveNoteSteps.get(noteNumber);
    if (pending) {
      const step = this.steps[pending.stepIndex];
      if (step) {
        step.length = Math.max(1, Math.round((this.currentPos - pending.startPos) / this.ticks));
      }
      this.liveNoteSteps.delete(noteNumber);
      this.updateZoneView();
    }
    if (this.isLiveRecording && this.liveTargetStep) {
      if (count === 0) {
        // by duration, like a note released after its step was committed (noteReleased above)
        this.liveTargetStep.length = Math.max(1, Math.round((this.currentPos - this.liveTargetStepStartPos) / this.ticks));
        this.steps[this.liveTargetStepNumber] = this.liveTargetStep;
        this.liveTargetStep = null;
        this.liveTargetStepNumber = -1;
        this.updateRecordingState();
        this.updateZoneView();
      }
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
          const stepNotes = this.zone._$('.step-notes');
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

  clock(pos: number, tickIntervalMs: number): void {
    this.currentPos = pos;
    this.tickn = pos % this.ticks;

    if (this.ratchetQueue.length > 0) {
      // note-offs first so same-tick transitions are clean
      for (let i = this.ratchetQueue.length - 1; i >= 0; i--) {
        const ev = this.ratchetQueue[i];
        if (ev.noteOnPos === -1 && pos >= ev.noteOffPos) {
          this.feedNote(MIDI.MESSAGE.NOTE_OFF, ev.note.channel, ev.note.number, 0);
          this.ratchetQueue.splice(i, 1);
        }
      }
      for (const ev of this.ratchetQueue) {
        if (ev.noteOnPos !== -1 && pos >= ev.noteOnPos) {
          this.feedNote(MIDI.MESSAGE.NOTE_ON, ev.note.channel, ev.note.number, ev.note.velo);
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
          for (const note of (astep.lastPlayedArray ?? [])) {
            this.feedNote(MIDI.MESSAGE.NOTE_OFF, note.channel, note.number, note.velo);
          }
          if (astep.lastPlayedArray) astep.lastPlayedArray.length = 0;
        }
      });
      this.activeSteps = this.activeSteps.filter(
        (item) => !clearSteps.includes(item)
      );
    }
    if (this.tickn === 0) {
      this.previousStepNumber = this.currentStepNumber;
      this.currentStepNumber = (this.currentStepNumber + 1) % this.length;
      // Commit a held live-recording step as soon as the playhead exits it so
      // it plays back on subsequent passes and length tracking continues.
      if (this.isLiveRecording && this.liveTargetStep !== null &&
          this.currentStepNumber === (this.liveTargetStepNumber + 1) % this.length) {
        this.steps[this.liveTargetStepNumber] = this.liveTargetStep;
        for (const n of this.liveTargetStep.notesArray) {
          this.liveNoteSteps.set(n.number, {
            stepIndex: this.liveTargetStepNumber,
            startPos: this.liveTargetStepStartPos,
          });
        }
        this.liveTargetStep = null;
        this.liveTargetStepNumber = -1;
        this.updateZoneView();
      }
      if (this.currentStepNumber === 0) {
        this.cycleCount++;
        if (this.cycleCount === 1) {
          this.isFirstCycle = false;
        }
      }
      if (this.isDrumSequence) {
        this.processDrumSequenceStep(tickIntervalMs);
      } else if (this.active) {
        this.processRegularSequenceStep(tickIntervalMs);
      }
      requestAnimationFrame(this.zone._renderSequenceBound);
    }
  }

  private processDrumSequenceStep(tickIntervalMs: number): void {
    const soloCount = this.getDrumLaneSoloCount();
    for (let ln = 0; ln < this.drumLanes; ln++) {
      const lane = this.getDrumLane(ln);
      lane.previousStep = lane.currentStep;
      lane.currentStep = (lane.currentStep + 1) % lane.length;
      if (!this.active) continue;
      if (lane.currentStep === 0) {
        lane.cycleCount++;
        if (lane.cycleCount === 1) lane.isFirstCycle = false;
      }
      if (!lane.enabled || (soloCount > 0 && !lane.solo)) {
        lane.previousStepPlayed = false;
        continue;
      }
      const step = lane.steps[lane.currentStep];
      if (step == null || step.isBlank()) {
        // Don't update previousStepPlayed for empty steps
        continue;
      }

      // Evaluate condition and probability exactly once at step boundary
      const conditionMet = this.checkCondition(step, lane.cycleCount, lane.isFirstCycle, lane.previousStepPlayed);
      lane.conditionResults[lane.currentStep] = [lane.cycleCount, conditionMet];
      const shouldPlay = conditionMet && this.chanceRoll(lane.cycleCount, lane.currentStep, ln) < step.probability;
      lane.previousStepPlayed = shouldPlay;

      if (!shouldPlay) continue;

      if (this.zone.swingAmount > 0 && !this.zone.arp_enabled) {
        const swingOffset = swingOffsetMs(lane.currentStep, this.zone.swingAmount, this.ticks, tickIntervalMs);
        if (swingOffset > 0) {
          const laneIndex = ln;
          const stepIndex = lane.currentStep;
          // Timer provides the real delay; dispatch always sends immediately when it
          // fires (no MIDI-level timestamp) since Web MIDI scheduled sends aren't
          // reliably honored by all output drivers.
          const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
            this.swingTimers.delete(timer);
            this.playDrumStep(laneIndex, stepIndex);
          }, swingOffset);
          this.swingTimers.add(timer);
          continue;
        }
      }
      this.playDrumStep(ln, lane.currentStep);
    }
  }

  /**
   * Process regular sequence steps at step boundary
   */
  private processRegularSequenceStep(tickIntervalMs: number): void {
    const currentStep = this.steps[this.currentStepNumber];
    if (!currentStep) return;

    // Evaluate condition and probability exactly once at step boundary
    const conditionMet = this.checkCondition(currentStep);
    this.conditionResults[this.currentStepNumber] = [this.cycleCount, conditionMet];
    const shouldPlay = conditionMet && this.chanceRoll(this.cycleCount, this.currentStepNumber) < currentStep.probability;
    this.previousStepPlayed = shouldPlay;

    if (!shouldPlay) return;

    if (this.zone.swingAmount > 0 && !this.zone.arp_enabled) {
      const swingOffset = swingOffsetMs(this.currentStepNumber, this.zone.swingAmount, this.ticks, tickIntervalMs);
      if (swingOffset > 0) {
        const stepIndex = this.currentStepNumber;
        const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
          this.swingTimers.delete(timer);
          this.playRegularStep(stepIndex);
        }, swingOffset);
        this.swingTimers.add(timer);
        return;
      }
    }

    this.playRegularStep(this.currentStepNumber);
  }

  /**
   * With `ringOut` (transport stop) sounding notes finish their remaining gate on a
   * timer; otherwise they are released immediately.
   */
  stopped(ringOut = false): void {
    this.releaseSoundingNotes(ringOut);
    this.chanceSeed = randomSeed();
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
    this.liveTargetStep = null;
    this.isLiveRecording = false;
    this.updateRecordingState();
    requestAnimationFrame(this.zone._renderSequenceBound);
    requestAnimationFrame(this.zone._renderNotesBound);
    this.updateZoneView();
  }

  /** Steps whose notes sound right now (over their length and gate; ratchet hits of the current step) */
  soundingSteps(): Set<number> {
    const result = new Set<number>();
    for (const astep of this.activeSteps) {
      const i = this.steps.indexOf(astep);
      if (i > -1 && astep.lastPlayedArray?.length) result.add(i);
    }
    const current = this.steps[this.currentStepNumber];
    if (current && (current.ratchetCount ?? 1) > 1) {
      const pitches = new Set(current.notesArray.map((n) => n.number));
      if (this.ratchetQueue.some((ev) => ev.noteOnPos === -1 && pitches.has(ev.note.number))) {
        result.add(this.currentStepNumber);
      }
    }
    return result;
  }

  activeNotes(): Note[] {
    const result: Note[] = [];
    this.activeSteps.forEach((astep) => {
      result.push(...(astep.lastPlayedArray ?? []));
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

  /** Feeds a sequencer note into the zone as if it came from an input (arp, routing). */
  private feedNote(status: number, channel: number, number: number, velo: number, timestamp?: number): void {
    this._midiMsgBuf[0] = status + channel;
    this._midiMsgBuf[1] = number;
    this._midiMsgBuf[2] = velo;
    this.zone.handleMidi(status, this._midiMsgBuf, true, timestamp);
  }

  /** The chance roll of a step in a cycle of this run (lane -1: the melodic sequence) */
  private chanceRoll(cycle: number, stepIndex: number, lane = -1): number {
    return hashRoll(this.chanceSeed, cycle, stepIndex, lane);
  }

  /**
   * The steps after the current one, each with whether it will play: conditions and
   * chance as playback evaluates them, so exact as long as nothing is edited. Endless,
   * the caller stops. `laneIndex` -1: the melodic sequence, else a drum lane.
   */
  *upcoming(laneIndex = -1): Generator<{ step: number; plays: boolean }> {
    if (laneIndex < 0) {
      const len = this.length;
      if (len < 1) return;
      let cur = this.currentStepNumber;
      let cycle = this.cycleCount;
      let first = this.isFirstCycle;
      let previous = this.previousStepPlayed;
      for (;;) {
        cur = (cur + 1) % len;
        if (cur === 0 && ++cycle === 1) first = false;
        const step = this.steps[cur];
        let plays = false;
        if (step && this.active && !this.isDrumSequence) {
          plays = this.checkCondition(step, cycle, first, previous) && this.chanceRoll(cycle, cur) < step.probability;
          previous = plays;
        }
        yield { step: cur, plays };
      }
    }
    const lane = this.drum_lanes[laneIndex];
    if (!lane || lane.length < 1) return;
    const quiet = !lane.enabled || (this.getDrumLaneSoloCount() > 0 && !lane.solo);
    let cur = lane.currentStep;
    let cycle = lane.cycleCount;
    let first = lane.isFirstCycle;
    let previous = lane.previousStepPlayed;
    for (;;) {
      cur = (cur + 1) % lane.length;
      let plays = false;
      if (this.active) {
        if (cur === 0 && ++cycle === 1) first = false;
        const step = lane.steps[cur];
        if (quiet) {
          previous = false;
        } else if (step && !step.isBlank()) {
          plays =
            this.checkCondition(step, cycle, first, previous) &&
            this.chanceRoll(cycle, cur, laneIndex) < step.probability;
          previous = plays;
        }
      }
      yield { step: cur, plays };
    }
  }

  checkCondition(step: SeqStep, cycleCnt = this.cycleCount, firstCycle = this.isFirstCycle, previousStepPlayed = this.previousStepPlayed): boolean {
    switch (step.condition) {
      case StepCondition.ALWAYS:
        return true;
      case StepCondition.PREVIOUS:
        return previousStepPlayed;
      case StepCondition.NOT_PREVIOUS:
        return !previousStepPlayed;
      case StepCondition.FIRST_CYCLE:
        return firstCycle;
      case StepCondition.NOT_FIRST_CYCLE:
        return !firstCycle;
    }
    const condition = Sequence.CYCLE_CONDITIONS[step.condition - StepCondition.CYCLES];
    return cycleCnt % condition[0] === condition[1] - 1;
  }

  /**
   * Whether a step's play condition is met in the current cycle (chance aside), for
   * the live display: the evaluated result for steps the playhead has passed, a
   * prediction for later ones when it is certain (cycle conditions always, "previous"
   * ones only with no step in between), otherwise null. Null while stopped and for
   * steps without a condition. Pass `lane` for a drum lane.
   */
  conditionOutcome(stepIndex: number, lane?: DrumLane): boolean | null {
    const steps = lane ? lane.steps : this.steps;
    const step = steps[stepIndex];
    if (!step || step.isBlank() || step.condition === StepCondition.ALWAYS) return null;
    const current = lane ? lane.currentStep : this.currentStepNumber;
    const cycle = lane ? lane.cycleCount : this.cycleCount;
    if (current < 0 || cycle < 0) return null;
    if (stepIndex <= current) {
      const result = (lane ? lane.conditionResults : this.conditionResults)[stepIndex];
      return result && result[0] === cycle ? result[1] : null;
    }
    if (step.condition === StepCondition.PREVIOUS || step.condition === StepCondition.NOT_PREVIOUS) {
      // empty drum steps leave "previous" alone, melodic ones only when absent
      const counts = (st: SeqStep | null): boolean => (lane ? !!st && !st.isBlank() : !!st);
      for (let k = current + 1; k < stepIndex; k++) {
        if (counts(steps[k])) return null;
      }
    }
    return lane
      ? this.checkCondition(step, cycle, lane.isFirstCycle, lane.previousStepPlayed)
      : this.checkCondition(step);
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
      // Locks stay where they are; only the hits move
      const step = lane.steps[i];
      if (step?.hasLocks()) step.notesArray = [];
      else lane.steps[i] = null;
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
    const step = drumLane.steps[stepNo] ?? new SeqStep();
    // A step with locks only gets its note
    if (step.notesArray.length === 0) step.notesArray.push(new Note(drumLane.note, 96));
    drumLane.steps[stepNo] = step;
  }

  // ========== SWING METHODS ==========

  /**
   * Clock paused (ticks halted without Stop): sounding notes ring out, but the
   * playhead is kept so playback continues when ticks resume.
   */
  paused(): void {
    this.releaseSoundingNotes(true);
  }

  /** Release sounding notes (by timer with `ringOut`) and drop unsounded swung/ratchet hits. */
  private releaseSoundingNotes(ringOut: boolean): void {
    // Notes feeding the arpeggiator are not audible themselves; release them at once
    const ringOutNotes = ringOut && !this.zone.arp_enabled;
    this.activeSteps.forEach((astep) => {
      const offTick = Math.ceil(Math.min(this.ticks * astep.gateLength, this.ticks - 1));
      const remaining = (astep.length - 1 - astep.played) * this.ticks + offTick - this.tickn;
      for (const note of (astep.lastPlayedArray ?? [])) {
        if (ringOutNotes) {
          this.zone.ringOutAfterTicks(note.number, remaining, () => this.releaseNote(note));
        } else {
          this.releaseNote(note);
        }
      }
      if (astep.lastPlayedArray) astep.lastPlayedArray.length = 0;
    });
    this.activeSteps.length = 0;
    for (const ev of this.ratchetQueue) {
      if (ev.noteOnPos !== -1) continue; // not sounded yet
      if (ringOutNotes) {
        const note = ev.note;
        this.zone.ringOutAfterTicks(note.number, ev.noteOffPos - this.currentPos, () => this.releaseNote(note));
      } else {
        this.releaseNote(ev.note);
      }
    }
    this.ratchetQueue.length = 0;
    this.swingTimers.forEach((t) => clearTimeout(t));
    this.swingTimers.clear();
  }

  /** Send a note-off for a sequencer note through the zone (own buffer: may run inside another send). */
  private releaseNote(note: Note): void {
    const msg = Uint8Array.from([MIDI.MESSAGE.NOTE_OFF + note.channel, note.number, 0]);
    this.zone.handleMidi(MIDI.MESSAGE.NOTE_OFF, msg, true);
  }

  /** Sends a played step's locks (once per step, with its swing; lane -1 = melodic) */
  private playLocks(step: SeqStep, lane: number): void {
    this.zone.paramLocks.stepPlayed(lane, step.locks, step.slide, this.currentPos, step.length * this.ticks);
  }

  /** Every address locked on a step of this sequence (all drum lanes included) */
  lockedAddresses(): Set<string> {
    const addresses = new Set<string>();
    const collect = (steps: (SeqStep | null)[]): void =>
      steps.forEach((st) => st?.locks.forEach((l) => addresses.add(l.a)));
    collect(this.steps);
    this.drum_lanes.forEach((lane) => lane && collect(lane.steps));
    return addresses;
  }

  /**
   * Runs `edit` on the given steps (default: the selected ones; drum step ids in drum
   * mode). With `create`, empty slots get a new step (a step with locks only); steps
   * left with neither notes nor locks are removed.
   */
  private editSteps(edit: (step: SeqStep) => void, create = false, stepNumbers: Iterable<number> = this.selectedStepNumbers): void {
    for (const n of stepNumbers) {
      let steps = this.steps;
      let index = n;
      if (this.isDrumSequence) {
        const [laneIndex, stepIndex] = Sequence.getLaneAndStepIndexForDrumStepId(n);
        steps = this.getDrumLane(laneIndex).steps;
        index = stepIndex;
      }
      const step = steps[index] ?? (create ? new SeqStep() : null);
      if (!step) continue;
      edit(step);
      steps[index] = step.isBlank() ? null : step;
    }
  }

  /** The selected steps' locks on an address */
  selectedLockValues(address: string): number[] {
    const values: number[] = [];
    this.selectedSteps.forEach((st) => {
      const v = st?.lockValue(address);
      if (v !== undefined) values.push(v);
    });
    return values;
  }

  setLockOnSelected(address: string, value: number): void {
    this.editSteps((st) => st.setLock(address, value), true);
  }

  removeLockFromSelected(address: string): void {
    this.editSteps((st) => st.removeLock(address));
  }

  clearLocks(stepNumbers: Iterable<number>): void {
    this.editSteps((st) => {
      st.locks = [];
      st.slide = false;
    }, false, stepNumbers);
  }

  setSlideOnSelected(slide: boolean): void {
    this.editSteps((st) => (st.slide = slide));
  }

  /**
   * Play a drum step unconditionally (condition/probability already evaluated at boundary).
   * timestamp, when provided, is forwarded to Web MIDI for hardware-precise scheduling.
   */
  private playDrumStep(laneIndex: number, stepIndex: number, timestamp?: number): void {
    const lane = this.getDrumLane(laneIndex);
    if (!lane || !lane.enabled) return;

    const soloCount = this.getDrumLaneSoloCount();
    if (soloCount > 0 && !lane.solo) return;

    const step = lane.steps[stepIndex];
    if (step == null || step.isBlank()) return;
    this.playLocks(step, laneIndex);
    if (step.notesArray.length === 0) return;

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
          this.feedNote(MIDI.MESSAGE.NOTE_ON, hitNote.channel, hitNote.number, hitNote.velo, timestamp);
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
      this.feedNote(MIDI.MESSAGE.NOTE_ON, note.channel, note.number, note.velo, timestamp);
      (step.lastPlayedArray ??= []).push(note);
    }
  }

  /**
   * Play a regular sequence step unconditionally (condition/probability already evaluated at boundary).
   * timestamp, when provided, is forwarded to Web MIDI for hardware-precise scheduling.
   */
  private playRegularStep(stepIndex: number, timestamp?: number): void {
    const step = this.steps[stepIndex];
    if (!step || step.isBlank()) return;
    this.playLocks(step, -1);
    if (step.notesArray.length === 0) return;
    const ratchetCount = step.ratchetCount ?? 1;
    if (ratchetCount > 1) {
      const ratchetRes = step.ratchetResolution ?? 6;
      const ratchetDelta = step.ratchetVelocityDelta ?? 0;
      const gateLen = Math.max(1, ratchetRes - 1);
      for (let hitIdx = 0; hitIdx < ratchetCount; hitIdx++) {
        for (const inote of step.notesArray) {
          const note = Note.clone(inote);
          note.channel = this.zone.channel;
          note.portId = this.zone.outputPortId;
          note.velo = Math.max(1, Math.min(127, inote.velo + hitIdx * ratchetDelta));
          if (hitIdx === 0) {
            this.feedNote(MIDI.MESSAGE.NOTE_ON, note.channel, note.number, note.velo, timestamp);
            this.ratchetQueue.push({ note, noteOnPos: -1, noteOffPos: this.currentPos + gateLen });
          } else {
            const firePos = this.currentPos + hitIdx * ratchetRes;
            this.ratchetQueue.push({ note, noteOnPos: firePos, noteOffPos: firePos + gateLen });
          }
        }
      }
    } else {
      step.played = 0;
      this.activeSteps.push(step);
      step.lastPlayedArray ??= [];
      for (const inote of step.notesArray) {
        const note = Note.clone(inote);
        note.channel = this.zone.channel;
        note.portId = this.zone.outputPortId;
        this.feedNote(MIDI.MESSAGE.NOTE_ON, note.channel, note.number, note.velo, timestamp);
        step.lastPlayedArray.push(note);
      }
    }
  }
}
