import DOM from '../domutils';
import MIDI from '../midi';
import { Note } from '../zone/note';
import { SeqStep } from '../zone/seq-step';
import potDragHandler from '../potdraghandler';
import { ActionContext, ZoneType, SequenceType } from './types';
import { labelForZone } from './action-labels';
import { showStepProperties, stepDetails, velocityLabel } from './step-marks';
import { initSheetHeader, setSheetZone } from './editor-sheet';
import { ZONES_CHANGED_EVENT } from '../zone/interfaces';
import { timeline } from '../timeline';
import { meterLabel, startsBeat } from '../meter';
import { DIV_TICKS } from '../zone/seq-layer';

// Steps share the visible width (between these bounds, scrolling beyond); the
// width is set as --pr-cell-w for the grid lines in styles.css.
const MIN_CELL_W = 24; // px per step
const MAX_CELL_W = 96;
const KEYS_W = 56; // .pr-keys width
const ROW_H = 14; // px per pitch row
const VELOCITY_LANE_H = 80; // px
let cellW = MIN_CELL_W;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function stepToX(stepIndex: number): number {
  return stepIndex * cellW;
}

function xToStep(x: number, sequenceLength: number): number {
  return clamp(Math.floor(x / cellW), 0, sequenceLength - 1);
}

function pitchToY(pitch: number): number {
  return (127 - pitch) * ROW_H;
}

function yToPitch(y: number): number {
  return clamp(127 - Math.floor(y / ROW_H), 0, 127);
}

function setPitch(note: Note, pitch: number): void {
  note.number = pitch;
  note.isBlackKey = Note.isBlackKey(pitch);
}

function findNoteLocation(sequence: SequenceType, note: Note): number | null {
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence.steps[i];
    if (step && step.notesArray.includes(note)) return i;
  }
  return null;
}

// Confirmed move rule: an empty target step inherits the moved note's own
// source-step settings (length/gate/probability/condition/ratchet); an occupied
// target step keeps its own settings and the note just joins that chord.
function moveNote(
  sequence: SequenceType,
  fromStepIndex: number,
  note: Note,
  toStepIndex: number,
  toPitch: number
): void {
  const srcStep = sequence.steps[fromStepIndex];
  if (!srcStep) return;

  if (fromStepIndex === toStepIndex) {
    if (note.number === toPitch) return;
    if (srcStep.notesArray.some((n) => n !== note && n.number === toPitch)) return;
    setPitch(note, toPitch);
    srcStep.notesArray.sort((a, b) => a.number - b.number);
    return;
  }

  const idx = srcStep.notesArray.indexOf(note);
  if (idx === -1) return;
  srcStep.notesArray.splice(idx, 1);
  const previousPitch = note.number;
  setPitch(note, toPitch);

  let targetStep = sequence.steps[toStepIndex];
  if (!targetStep) {
    targetStep = SeqStep.from(srcStep);
    targetStep.notesArray = []; // SeqStep.from shallow-clones — must reset, or it aliases srcStep's array
    targetStep.locks = []; // the note moves, the source step's locks stay
    targetStep.slide = false;
    sequence.steps[toStepIndex] = targetStep;
  }
  if (!SeqStep.addNote(targetStep.notesArray, note)) {
    // Target pitch already occupied at that step — put the note back where it was.
    setPitch(note, previousPitch);
    srcStep.notesArray.splice(idx, 0, note);
    return;
  }

  if (srcStep.isBlank()) {
    sequence.steps[fromStepIndex] = null;
  }
}

interface MoveItem {
  note: Note;
  startStep: number;
  startPitch: number;
}

// Moves notes by an offset from where they started. Notes ahead in the direction of
// travel go first, so none lands on a note that is about to move away.
function moveItems(sequence: SequenceType, items: MoveItem[], deltaSteps: number, deltaPitch: number): void {
  const ordered = [...items].sort(
    (a, b) =>
      (deltaSteps >= 0 ? b.startStep - a.startStep : a.startStep - b.startStep) ||
      (deltaPitch >= 0 ? b.startPitch - a.startPitch : a.startPitch - b.startPitch)
  );
  for (const item of ordered) {
    const currentStep = findNoteLocation(sequence, item.note);
    if (currentStep === null) continue;
    const targetStep = clamp(item.startStep + deltaSteps, 0, sequence.length - 1);
    const targetPitch = clamp(item.startPitch + deltaPitch, 0, 127);
    moveNote(sequence, currentStep, item.note, targetStep, targetPitch);
  }
}

// Single in-flight MIDI audition note, sent directly via the MIDI wrapper (not
// zone.handleMidi) so previewing a pitch never triggers arp/note-range/playback bookkeeping.
const previewBuf = new Uint8Array(3);
let previewZone: ZoneType | null = null;
let previewNoteNumber: number | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function stopPreview(): void {
  if (previewTimer) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (previewZone && previewNoteNumber !== null) {
    previewBuf[0] = MIDI.MESSAGE.NOTE_OFF + previewZone.channel;
    previewBuf[1] = previewNoteNumber;
    previewBuf[2] = 0;
    previewZone.midi.send(previewBuf, previewZone.outputPortId);
  }
  previewZone = null;
  previewNoteNumber = null;
}

function previewNote(zone: ZoneType, pitch: number, velocity: number): void {
  stopPreview();
  previewZone = zone;
  previewNoteNumber = pitch;
  previewBuf[0] = MIDI.MESSAGE.NOTE_ON + zone.channel;
  previewBuf[1] = pitch;
  previewBuf[2] = velocity;
  zone.midi.send(previewBuf, zone.outputPortId);
  previewTimer = setTimeout(stopPreview, 180);
}

type DragMode = 'move' | 'resize';
interface DragState {
  mode: DragMode;
  anchorX: number;
  anchorY: number;
  lastDeltaSteps: number;
  lastDeltaPitch: number;
  items: MoveItem[];
  resizeStepIndex?: number;
  resizeStartLength?: number;
}

// A drag on empty grid draws a selection box (⇧ / ⌘ add to the selection); a press
// without movement adds a note. Grid coordinates, so scrolling during the drag is fine.
interface BoxState {
  x0: number;
  y0: number;
  active: boolean;
  base: Set<Note>;
}
const BOX_THRESHOLD = 4; // px before a press becomes a box

// Notes copied in the piano roll (⌘C), as offsets from the first copied step
interface ClipNote {
  offset: number;
  note: Note;
  step: SeqStep; // settings for an empty target step (no notes, locks or slide)
}
interface NoteClip {
  notes: ClipNote[];
  span: number; // steps from the first copied step to the end of the longest note
}
let clipboard: NoteClip | null = null;
let nextPasteStep = 0; // ⌘V goes on after the copied notes, then after each paste

let activeCtx: ActionContext | null = null;
let lastBoundSequence: SequenceType | null = null;
let rafHandle: number | null = null;
let dragState: DragState | null = null;
const selectedNotes = new Set<Note>();
const noteEls = new Map<Note, HTMLElement>();
let boxState: BoxState | null = null;
let keysBuilt = false;
const keyEls: HTMLElement[] = []; // indexed by pitch
let cursorRowPitch: number | null = null;
let lastPointer: { x: number; y: number } | null = null;

let overlayEl: HTMLElement;
let deleteBtn: HTMLButtonElement;
let boxEl: HTMLElement;
let stepsHostEl: HTMLElement; // .pr-steps
let stepsSeqEl: HTMLElement; // its .seq, which holds the zone's step editor while open
let hostedInfo: { el: HTMLElement; parent: HTMLElement; next: Node | null } | null = null;
let redrawPending = false;
let mainScrollEl: HTMLElement;
let keysEl: HTMLElement;
let gridEl: HTMLElement;
let notesEl: HTMLElement;
let playheadEl: HTMLElement;
let stepHeaderEl: HTMLElement;
let stepHeaderKey = '';
// note elements per step, for the live condition marks
let stepNoteEls: HTMLElement[][] = [];
let lastLiveStep: number | null = null;
// playhead step the view last followed (kept across re-renders, -1 = stopped)
let followStep = -1;
let soundingKey = ''; // steps whose notes have .sounding
let velocityScrollEl: HTMLElement;
let velocityLaneEl: HTMLElement;

function buildKeyboardOnce(): void {
  if (keysBuilt) return;
  keysBuilt = true;
  keysEl.style.height = `${128 * ROW_H}px`;
  for (let pitch = 127; pitch >= 0; pitch--) {
    const row = document.createElement('div');
    row.className = 'pr-key' + (Note.isBlackKey(pitch) ? ' black' : '');
    row.style.top = `${pitchToY(pitch)}px`;
    row.style.height = `${ROW_H}px`;
    if (pitch % 12 === 0) {
      row.classList.add('labeled');
      row.textContent = Note.display(pitch);
    }
    row.addEventListener('mousedown', () => {
      if (activeCtx) previewNote(activeCtx.zone, pitch, 96);
    });
    keysEl.appendChild(row);
    keyEls[pitch] = row;
  }
}

function setCursorRow(pitch: number | null): void {
  if (pitch === cursorRowPitch) return;
  if (cursorRowPitch !== null) {
    const prev = keyEls[cursorRowPitch];
    prev.classList.remove('cursor-row');
    if (!prev.classList.contains('labeled')) prev.textContent = '';
  }
  if (pitch !== null) {
    keyEls[pitch].classList.add('cursor-row');
    keyEls[pitch].textContent = Note.display(pitch);
  }
  cursorRowPitch = pitch;
}

// Highlights the key of the row under the pointer; keeps following it during a drag
// even when the pointer leaves the grid.
function updateCursorRow(): void {
  if (!activeCtx || !lastPointer) {
    setCursorRow(null);
    return;
  }
  const rect = mainScrollEl.getBoundingClientRect();
  const inside =
    lastPointer.x >= rect.left &&
    lastPointer.x < rect.right &&
    lastPointer.y >= rect.top &&
    lastPointer.y < rect.bottom;
  if (!inside && !dragState) {
    setCursorRow(null);
    return;
  }
  setCursorRow(yToPitch(lastPointer.y - gridEl.getBoundingClientRect().top));
}

function getZoneColor(zone: ZoneType, prop = '--zone-color', fallback = '#dab249'): string {
  if (zone.elements.zoneElement) {
    const c = getComputedStyle(zone.elements.zoneElement)
      .getPropertyValue(prop)
      .trim();
    if (c) return c;
  }
  return fallback;
}

function updateTools(): void {
  deleteBtn.disabled = selectedNotes.size === 0;
  syncStepSelection();
}

// The zone's step selection follows the notes selected here, so the step editor below
// edits their steps. Set directly: the setter would arm recording notes into the step.
function syncStepSelection(): void {
  if (!activeCtx) return;
  const sequence = activeCtx.zone.sequence;
  const steps = new Set(selectedItems(sequence).map((i) => i.startStep));
  const current = sequence.selectedStepNumbers;
  if (steps.size === current.size && [...steps].every((n) => current.has(n))) return;
  if (steps.size === 0) {
    sequence.clearSelection();
  } else {
    current.clear();
    steps.forEach((n) => current.add(n));
    sequence.isHotRecordingNotes = false;
  }
  activeCtx.updateValuesForZone(activeCtx.zoneindex);
}

// Moves the zone's step editor in. One found in the zone is a fresh one (the zone was
// drawn anew, e.g. after undo), so this runs every frame and takes it over.
function hostStepInfo(zone: ZoneType): void {
  const fresh = zone.elements.zoneElement?.querySelector('.step-info') as HTMLElement | null;
  if (!fresh) return;
  releaseStepInfo();
  hostedInfo = { el: fresh, parent: fresh.parentElement!, next: fresh.nextSibling };
  stepsSeqEl.appendChild(fresh);
  zone.elements.stepInfoHost = fresh; // the zone still finds its fields (zone._$)
}

/** Puts the step editor back into its zone, or drops it when that zone's DOM is gone */
function releaseStepInfo(): void {
  if (!hostedInfo) return;
  const { el, parent, next } = hostedInfo;
  hostedInfo = null;
  if (parent.isConnected) parent.insertBefore(el, next?.parentNode === parent ? next : null);
  else el.remove();
}

// The zone's styles for the editor depend on its .seq's state classes
function mirrorStepState(zone: ZoneType): void {
  const selected = zone.sequence.hasSelection;
  stepsSeqEl.classList.toggle('has-selection', selected);
  stepsSeqEl.classList.toggle('multi-selection', zone.sequence.selectedStepNumbers.size > 1);
  if (stepsHostEl.hidden === selected) stepsHostEl.hidden = !selected;
}

function clearSelection(): void {
  selectedNotes.clear();
  updateTools();
}

function toggleSelection(note: Note, el: HTMLElement): void {
  if (selectedNotes.has(note)) {
    selectedNotes.delete(note);
    el.classList.remove('selected');
  } else {
    selectedNotes.add(note);
    el.classList.add('selected');
  }
  updateTools();
}

function selectedItems(sequence: SequenceType): MoveItem[] {
  const items: MoveItem[] = [];
  selectedNotes.forEach((n) => {
    const loc = findNoteLocation(sequence, n);
    if (loc !== null) items.push({ note: n, startStep: loc, startPitch: n.number });
  });
  return items;
}

/** Arrow keys: by steps and semitones, as one undo entry; nothing moves when a note would leave the grid */
function moveSelected(zone: ZoneType, deltaSteps: number, deltaPitch: number): void {
  if (!activeCtx) return;
  const sequence = zone.sequence;
  const items = selectedItems(sequence);
  const fits = (i: MoveItem): boolean =>
    i.startStep + deltaSteps >= 0 &&
    i.startStep + deltaSteps < sequence.length &&
    i.startPitch + deltaPitch >= 0 &&
    i.startPitch + deltaPitch <= 127;
  if (items.length === 0 || !items.every(fits)) return;
  activeCtx.beforeAction(labelForZone(zone, activeCtx.zoneindex, 'Note Position'));
  moveItems(sequence, items, deltaSteps, deltaPitch);
  renderNotesAndVelocity(zone);
  if (deltaPitch !== 0) previewNote(zone, items[0].note.number, items[0].note.velo);
  commitEdit(activeCtx);
}

function clipSelection(sequence: SequenceType): NoteClip | null {
  const found = selectedItems(sequence);
  if (found.length === 0) return null;
  const first = Math.min(...found.map((i) => i.startStep));
  const end = Math.max(...found.map((i) => i.startStep + sequence.steps[i.startStep]!.length));
  const notes = found.map((i) => {
    const step = SeqStep.from(sequence.steps[i.startStep]);
    step.notesArray = []; // SeqStep.from shallow-clones the array
    step.locks = [];
    step.slide = false;
    return { offset: i.startStep - first, note: Note.clone(i.note), step };
  });
  return { notes, span: end - first };
}

function copySelection(zone: ZoneType): boolean {
  const clip = clipSelection(zone.sequence);
  if (!clip) return false;
  clipboard = clip;
  nextPasteStep = Math.min(...selectedItems(zone.sequence).map((i) => i.startStep)) + clip.span;
  return true;
}

/** Puts the notes of a clip in at `at` as one undo entry; they become the selection */
function pasteClip(zone: ZoneType, clip: NoteClip, at: number, label: string): void {
  if (!activeCtx) return;
  const sequence = zone.sequence;
  activeCtx.beforeAction(labelForZone(zone, activeCtx.zoneindex, label));
  selectedNotes.clear();
  for (const c of clip.notes) {
    const i = at + c.offset;
    if (i >= sequence.length) continue;
    let step = sequence.steps[i];
    if (!step) {
      // as when moving a note: an empty step takes the settings of the copied one
      step = SeqStep.from(c.step);
      step.notesArray = [];
      step.length = Math.min(step.length, sequence.length - i);
      sequence.steps[i] = step;
    }
    const note = Note.clone(c.note);
    note.channel = zone.channel;
    note.portId = zone.outputPortId;
    if (SeqStep.addNote(step.notesArray, note)) selectedNotes.add(note);
    else if (step.isBlank()) sequence.steps[i] = null;
  }
  renderNotesAndVelocity(zone);
  commitEdit(activeCtx);
  if (selectedNotes.size === 0) activeCtx.toast('Nothing pasted: past the end of the sequence, or the notes are already there');
}

function selectAll(zone: ZoneType): void {
  zone.sequence.steps.forEach((step) => step?.notesArray.forEach((n) => selectedNotes.add(n)));
  renderNotesAndVelocity(zone);
}

function commitEdit(ctx: ActionContext): void {
  ctx.updateValuesForZone(ctx.zoneindex);
  ctx.triggerSave();
}

function deleteSelected(zone: ZoneType, label = 'Delete Note'): void {
  if (selectedNotes.size === 0 || !activeCtx) return;
  activeCtx.beforeAction(labelForZone(zone, activeCtx.zoneindex, label));
  const sequence = zone.sequence;
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence.steps[i];
    if (!step) continue;
    if (step.notesArray.some((n) => selectedNotes.has(n))) {
      step.notesArray = step.notesArray.filter((n) => !selectedNotes.has(n));
      if (step.isBlank()) sequence.steps[i] = null;
    }
  }
  selectedNotes.clear();
  renderNotesAndVelocity(zone);
  commitEdit(activeCtx);
}

function wireNoteInteraction(
  noteEl: HTMLElement,
  handle: HTMLElement,
  zone: ZoneType,
  note: Note
): void {
  noteEl.addEventListener('mousedown', (ev) => {
    if ((ev as MouseEvent).button !== 0) return;
    ev.stopPropagation();
    const mev = ev as MouseEvent;
    if (mev.ctrlKey || mev.metaKey || mev.shiftKey) {
      toggleSelection(note, noteEl);
      return;
    }
    if (!selectedNotes.has(note)) {
      selectedNotes.clear();
      selectedNotes.add(note);
      renderNotesAndVelocity(zone);
    }
    const sequence = zone.sequence;
    const items = selectedItems(sequence);
    if (items.length === 0) return;
    if (activeCtx) activeCtx.startGesture(labelForZone(zone, activeCtx.zoneindex, 'Note Position'));
    dragState = {
      mode: 'move',
      anchorX: mev.clientX,
      anchorY: mev.clientY,
      lastDeltaSteps: 0,
      lastDeltaPitch: 0,
      items
    };
  });

  noteEl.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    selectedNotes.clear();
    selectedNotes.add(note);
    deleteSelected(zone);
  });

  handle.addEventListener('mousedown', (ev) => {
    if ((ev as MouseEvent).button !== 0) return;
    ev.stopPropagation();
    const mev = ev as MouseEvent;
    const sequence = zone.sequence;
    const loc = findNoteLocation(sequence, note);
    if (loc === null) return;
    const step = sequence.steps[loc]!;
    if (activeCtx) activeCtx.startGesture(labelForZone(zone, activeCtx.zoneindex, 'Note Length'));
    dragState = {
      mode: 'resize',
      anchorX: mev.clientX,
      anchorY: mev.clientY,
      lastDeltaSteps: 0,
      lastDeltaPitch: 0,
      items: [],
      resizeStepIndex: loc,
      resizeStartLength: step.length
    };
  });
}

function wireVelocityDrag(vbar: HTMLElement, note: Note, zone: ZoneType): void {
  vbar.addEventListener('mousedown', (ev) => {
    if ((ev as MouseEvent).button !== 0) return;
    ev.stopPropagation();
    if (activeCtx) activeCtx.startGesture(labelForZone(zone, activeCtx.zoneindex, 'Note Velocity'));
    potDragHandler.startDrag(
      ev as MouseEvent,
      note.velo << 7,
      (v14) => {
        note.velo = clamp(v14 >> 7, 1, 127);
        vbar.style.height = `${(note.velo / 127) * VELOCITY_LANE_H}px`;
        vbar.title = velocityLabel(note.velo);
      },
      () => {
        if (activeCtx) {
          activeCtx.endGesture();
          commitEdit(activeCtx);
        }
      }
    );
  });
}

function fitCellWidth(sequence: SequenceType): void {
  const available = mainScrollEl.clientWidth - KEYS_W;
  cellW = clamp(Math.floor(available / Math.max(1, sequence.length)), MIN_CELL_W, MAX_CELL_W);
  overlayEl.style.setProperty('--pr-cell-w', `${cellW}px`);
}

// Step numbers above the grid: every step, beat starts emphasised (in the arrangement's meter at
// the step's length); the grid's beat lines on the same steps
function renderStepHeader(sequence: SequenceType): void {
  const meter = timeline.meter;
  const stepTicks = DIV_TICKS[sequence.division];
  const key = `${sequence.length}:${cellW}:${stepTicks}:${meterLabel(meter)}`;
  if (key === stepHeaderKey) return;
  stepHeaderKey = key;
  DOM.empty(stepHeaderEl);
  stepHeaderEl.style.width = `${sequence.length * cellW}px`;
  const stops: string[] = [];
  let from = 0;
  for (let i = 0; i < sequence.length; i++) {
    const beat = startsBeat(i, stepTicks, meter);
    const cell = document.createElement('div');
    cell.className = 'pr-step' + (beat ? ' beat' : '');
    cell.textContent = String(i + 1);
    stepHeaderEl.appendChild(cell);
    if (beat) {
      const x = i * cellW;
      stops.push(`transparent ${from}px ${x}px`, `var(--brighter-1) ${x}px ${x + 1}px`);
      from = x + 1;
    }
  }
  stops.push(`transparent ${from}px`);
  overlayEl.style.setProperty('--pr-beat-lines', `linear-gradient(to right, ${stops.join(', ')})`);
}

function renderNotesAndVelocity(zone: ZoneType): void {
  const sequence = zone.sequence;
  DOM.empty(notesEl);
  DOM.empty(velocityLaneEl);
  fitCellWidth(sequence);
  renderStepHeader(sequence);
  stepNoteEls = [];
  noteEls.clear();
  const gridWidth = sequence.length * cellW;
  notesEl.style.width = `${gridWidth}px`;
  notesEl.style.height = `${128 * ROW_H}px`;
  gridEl.style.width = `${gridWidth}px`;
  gridEl.style.height = `${128 * ROW_H}px`;
  velocityLaneEl.style.width = `${gridWidth}px`;

  for (let stepIndex = 0; stepIndex < sequence.length; stepIndex++) {
    const step = sequence.steps[stepIndex];
    if (!step) continue;
    stepNoteEls[stepIndex] = [];
    for (const note of step.notesArray) {
      const noteEl = document.createElement('div');
      noteEl.className = 'pr-note' + (note.isBlackKey ? ' black' : '');
      if (selectedNotes.has(note)) noteEl.classList.add('selected');
      noteEl.style.left = `${stepToX(stepIndex)}px`;
      noteEl.style.top = `${pitchToY(note.number)}px`;
      noteEl.style.width = `${Math.max(1, step.length * cellW - 2)}px`;
      // step marks (chance, condition, ratchet) as on the grid; fill shade is this note's velocity
      showStepProperties(noteEl, step);
      noteEl.style.setProperty('--velo', (note.velo / 127).toFixed(3));
      noteEl.title = [Note.display(note.number), velocityLabel(note.velo), ...stepDetails(step)].join(', ');
      stepNoteEls[stepIndex].push(noteEl);
      noteEls.set(note, noteEl);
      const chanceMark = document.createElement('span');
      chanceMark.className = 'material-icons chance-mark';
      chanceMark.textContent = 'casino';
      noteEl.appendChild(chanceMark);
      const handle = document.createElement('div');
      handle.className = 'pr-note-handle';
      noteEl.appendChild(handle);
      wireNoteInteraction(noteEl, handle, zone, note);
      notesEl.appendChild(noteEl);

      const vbar = document.createElement('div');
      vbar.className = 'pr-vbar';
      vbar.style.left = `${stepToX(stepIndex)}px`;
      vbar.style.width = `${Math.max(1, cellW - 2)}px`;
      vbar.style.height = `${(note.velo / 127) * VELOCITY_LANE_H}px`;
      vbar.title = velocityLabel(note.velo);
      wireVelocityDrag(vbar, note, zone);
      velocityLaneEl.appendChild(vbar);
    }
  }
  lastLiveStep = null;
  soundingKey = '';
  updateTools();
  updatePlayhead(zone);
}

// Playhead column and header bar; on each new step also the live condition marks
// (see Sequence.conditionOutcome), as in the zone's step grid.
function updatePlayhead(zone: ZoneType): void {
  const sequence = zone.sequence;
  const current = sequence.active ? sequence.currentStepNumber : -1;
  if (current > -1) {
    playheadEl.style.display = 'block';
    playheadEl.style.left = `${stepToX(current)}px`;
    playheadEl.style.width = `${cellW}px`;
  } else {
    playheadEl.style.display = 'none';
  }
  updateSounding(current > -1 ? sequence.soundingSteps() : new Set<number>());
  if (current !== followStep) {
    followPlayhead(followStep, current);
    followStep = current;
  }
  if (current === lastLiveStep) return;
  lastLiveStep = current;
  Array.from(stepHeaderEl.children).forEach((cell, i) => cell.classList.toggle('playhead', i === current));
  stepNoteEls.forEach((els, i) => {
    const outcome = current > -1 ? sequence.conditionOutcome(i) : null;
    els?.forEach((el) => {
      el.classList.toggle('cond-plays', outcome === true);
      el.classList.toggle('cond-skips', outcome === false);
    });
  });
}

// Notes that are sounding now light up (per frame, the DOM only changes with the set)
function updateSounding(steps: Set<number>): void {
  const key = [...steps].join(',');
  if (key === soundingKey) return;
  soundingKey = key;
  stepNoteEls.forEach((els, i) => els?.forEach((el) => el.classList.toggle('sounding', steps.has(i))));
}

function stepVisible(step: number): boolean {
  const left = mainScrollEl.scrollLeft;
  const right = left + mainScrollEl.clientWidth - KEYS_W;
  const x = stepToX(step);
  return x >= left && x + cellW <= right;
}

// Pages the view along when the playhead leaves it (also back to the start on wrap).
// Only while the playhead was in view (or playback just started), so scrolling away
// to edit elsewhere isn't undone on the next step; not during a drag.
function followPlayhead(prev: number, current: number): void {
  if (current < 0 || dragState) return;
  if (prev > -1 && !stepVisible(prev)) return;
  if (stepVisible(current)) return;
  const maxScroll = mainScrollEl.scrollWidth - mainScrollEl.clientWidth;
  mainScrollEl.scrollLeft = clamp(stepToX(current), 0, Math.max(0, maxScroll));
}

function centerScrollOnNotes(zone: ZoneType): void {
  const sequence = zone.sequence;
  let minPitch = 127;
  let maxPitch = 0;
  let found = false;
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence.steps[i];
    if (!step) continue;
    for (const note of step.notesArray) {
      found = true;
      if (note.number < minPitch) minPitch = note.number;
      if (note.number > maxPitch) maxPitch = note.number;
    }
  }
  if (!found) {
    minPitch = zone.low;
    maxPitch = zone.high;
  }
  const midPitch = (minPitch + maxPitch) / 2;
  const targetY = pitchToY(midPitch) - mainScrollEl.clientHeight / 2 + ROW_H / 2;
  mainScrollEl.scrollTop = Math.max(0, targetY);
  mainScrollEl.scrollLeft = 0;
  velocityScrollEl.scrollLeft = 0;
}

function gridPoint(ev: { clientX: number; clientY: number }): { x: number; y: number } {
  const rect = gridEl.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function handleGridMouseDown(ev: MouseEvent): void {
  if (ev.button !== 0 || !activeCtx) return;
  const { x, y } = gridPoint(ev);
  const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
  boxState = { x0: x, y0: y, active: false, base: additive ? new Set(selectedNotes) : new Set() };
}

function updateBox(ev: MouseEvent): void {
  if (!boxState || !activeCtx) return;
  const { x, y } = gridPoint(ev);
  if (!boxState.active && Math.hypot(x - boxState.x0, y - boxState.y0) < BOX_THRESHOLD) return;
  boxState.active = true;
  const left = Math.min(x, boxState.x0);
  const right = Math.max(x, boxState.x0);
  const top = Math.min(y, boxState.y0);
  const bottom = Math.max(y, boxState.y0);
  Object.assign(boxEl.style, {
    display: 'block',
    left: `${left}px`,
    top: `${top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`
  });
  const sequence = activeCtx.zone.sequence;
  selectedNotes.clear();
  boxState.base.forEach((n) => selectedNotes.add(n));
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence.steps[i];
    if (!step) continue;
    const noteLeft = stepToX(i);
    const noteRight = noteLeft + step.length * cellW;
    for (const note of step.notesArray) {
      const noteTop = pitchToY(note.number);
      if (noteLeft < right && noteRight > left && noteTop < bottom && noteTop + ROW_H > top) selectedNotes.add(note);
    }
  }
  noteEls.forEach((el, note) => el.classList.toggle('selected', selectedNotes.has(note)));
  updateTools();
}

function finishBox(): void {
  if (!boxState) return;
  const { x0, y0, active } = boxState;
  boxState = null;
  boxEl.style.display = 'none';
  if (!active && activeCtx) addNoteAt(activeCtx.zone, x0, y0);
}

function addNoteAt(zone: ZoneType, x: number, y: number): void {
  if (!activeCtx) return;
  const sequence = zone.sequence;
  const stepIndex = xToStep(x, sequence.length);
  const pitch = yToPitch(y);

  activeCtx.beforeAction(labelForZone(zone, activeCtx.zoneindex, 'Add Note'));
  let step = sequence.steps[stepIndex];
  if (!step) {
    step = new SeqStep();
    sequence.steps[stepIndex] = step;
  }
  const note = new Note(pitch, 96, zone.channel, zone.outputPortId);
  if (SeqStep.addNote(step.notesArray, note)) {
    selectedNotes.clear();
    selectedNotes.add(note);
    renderNotesAndVelocity(zone);
    previewNote(zone, pitch, note.velo);
  }
  commitEdit(activeCtx);
}

function handleWindowMouseMove(ev: MouseEvent): void {
  if (!activeCtx) return;
  lastPointer = { x: ev.clientX, y: ev.clientY };
  updateCursorRow();
  updateBox(ev);
  if (!dragState) return;
  const zone = activeCtx.zone;
  const sequence = zone.sequence;

  if (dragState.mode === 'move') {
    const dx = ev.clientX - dragState.anchorX;
    const dy = ev.clientY - dragState.anchorY;
    const deltaSteps = Math.round(dx / cellW);
    const deltaPitch = -Math.round(dy / ROW_H);
    if (deltaSteps === dragState.lastDeltaSteps && deltaPitch === dragState.lastDeltaPitch) return;
    dragState.lastDeltaSteps = deltaSteps;
    dragState.lastDeltaPitch = deltaPitch;

    moveItems(sequence, dragState.items, deltaSteps, deltaPitch);
    renderNotesAndVelocity(zone);
    if (deltaPitch !== 0 && dragState.items.length > 0) {
      const previewPitch = clamp(dragState.items[0].startPitch + deltaPitch, 0, 127);
      previewNote(zone, previewPitch, 96);
    }
  } else {
    const dx = ev.clientX - dragState.anchorX;
    const deltaSteps = Math.round(dx / cellW);
    if (deltaSteps === dragState.lastDeltaSteps) return;
    dragState.lastDeltaSteps = deltaSteps;
    const step = sequence.steps[dragState.resizeStepIndex!];
    if (!step) return;
    const maxLen = sequence.length - dragState.resizeStepIndex!;
    step.length = clamp(dragState.resizeStartLength! + deltaSteps, 1, maxLen);
    renderNotesAndVelocity(zone);
  }
}

// Ends an in-progress move/resize drag, committing whatever the drag applied so far.
// Used both by the normal mouseup path and by every path that abandons the popup
// mid-drag (close, arrangement swap) — without this, undo-history's gesture flag
// would stay stuck open and silently swallow every later undo entry.
function finishDrag(): void {
  if (!dragState) return;
  dragState = null;
  if (activeCtx) {
    activeCtx.endGesture();
    commitEdit(activeCtx);
  }
}

function handleWindowMouseUp(): void {
  finishBox();
  finishDrag();
  updateCursorRow();
}

function renderAll(zone: ZoneType): void {
  renderNotesAndVelocity(zone);
}

function tick(): void {
  if (!activeCtx) {
    rafHandle = null;
    return;
  }
  if (activeCtx.zones.list.indexOf(activeCtx.zone) === -1) {
    // Undo/redo replace the zone objects: follow the zone at the same index
    const replacement = activeCtx.zones.list[activeCtx.zoneindex];
    if (!replacement) {
      close();
      return;
    }
    activeCtx.zone = replacement;
    activeCtx.sequence = replacement.sequence;
    setSheetZone(overlayEl, replacement, activeCtx.zoneindex);
  }
  const zone = activeCtx.zone;
  if (zone.sequence !== lastBoundSequence) {
    lastBoundSequence = zone.sequence;
    if (zone.sequence.isDrumSequence) {
      const toast = activeCtx.toast;
      close();
      toast('Piano roll closed: sequence switched to drum mode');
      return;
    }
    finishDrag();
    clearSelection();
    renderAll(zone);
  } else {
    updatePlayhead(zone);
  }
  hostStepInfo(zone);
  mirrorStepState(zone);
  rafHandle = requestAnimationFrame(tick);
}

function close(): void {
  boxState = null;
  boxEl.style.display = 'none';
  finishDrag();
  stopPreview();
  // also ends the zone's step selection: with steps selected its knobs would set locks
  clearSelection();
  releaseStepInfo();
  if (activeCtx) activeCtx.zone.elements.stepInfoHost = null;
  stepsHostEl.hidden = true;
  if (activeCtx) {
    // Idempotent safety net: also ends an in-flight velocity-bar (potDragHandler)
    // gesture if the popup is closed mid-drag, so undo-history never stays wedged open.
    activeCtx.endGesture();
    activeCtx.triggerSave();
  }
  clearSelection();
  setCursorRow(null);
  lastPointer = null;
  overlayEl.classList.remove('open');
  activeCtx = null;
  lastBoundSequence = null;
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

export function openPianoRoll(ctx: ActionContext): void {
  if (ctx.sequence.isDrumSequence) {
    ctx.toast('Piano roll editing is only available for melodic sequences');
    return;
  }
  activeCtx = ctx;
  lastBoundSequence = ctx.zone.sequence;
  selectedNotes.clear();
  // steps selected in the zone: their notes start selected
  ctx.zone.sequence.selectedStepNumbers.forEach((n) =>
    ctx.zone.sequence.steps[n]?.notesArray.forEach((note) => selectedNotes.add(note))
  );
  setSheetZone(overlayEl, ctx.zone, ctx.zoneindex);
  overlayEl.style.setProperty('--zone-color', getZoneColor(ctx.zone));
  overlayEl.style.setProperty('--zone-surface', getZoneColor(ctx.zone, '--zone-surface', '#333330'));
  overlayEl.classList.add('open');
  hostStepInfo(ctx.zone);
  renderAll(ctx.zone);
  mirrorStepState(ctx.zone);
  centerScrollOnNotes(ctx.zone);
  followStep = -1;
  if (rafHandle === null) rafHandle = requestAnimationFrame(tick);
}

export function initPianoRoll(): void {
  overlayEl = DOM.get('#pianoRollOverlay') as HTMLElement;
  deleteBtn = overlayEl.querySelector('.pr-delete') as HTMLButtonElement;
  mainScrollEl = overlayEl.querySelector('.pr-main-scroll') as HTMLElement;
  keysEl = overlayEl.querySelector('.pr-keys') as HTMLElement;
  gridEl = overlayEl.querySelector('.pr-grid') as HTMLElement;
  notesEl = overlayEl.querySelector('.pr-notes') as HTMLElement;
  playheadEl = overlayEl.querySelector('.pr-playhead') as HTMLElement;
  stepHeaderEl = overlayEl.querySelector('.pr-step-numbers') as HTMLElement;
  velocityScrollEl = overlayEl.querySelector('.pr-velocity-scroll-inner') as HTMLElement;
  velocityLaneEl = overlayEl.querySelector('.pr-velocity-lane') as HTMLElement;
  stepsHostEl = overlayEl.querySelector('.pr-steps') as HTMLElement;
  stepsSeqEl = stepsHostEl.querySelector('.seq') as HTMLElement;
  boxEl = document.createElement('div');
  boxEl.className = 'pr-box';
  gridEl.appendChild(boxEl);

  buildKeyboardOnce();

  initSheetHeader(overlayEl, close);
  deleteBtn.addEventListener('click', () => activeCtx && deleteSelected(activeCtx.zone));
  overlayEl.querySelector('.pr-select-all')!.addEventListener('click', () => activeCtx && selectAll(activeCtx.zone));
  gridEl.addEventListener('mousedown', handleGridMouseDown);
  mainScrollEl.addEventListener('scroll', () => {
    velocityScrollEl.scrollLeft = mainScrollEl.scrollLeft;
    updateCursorRow();
  });

  // Capture phase, ahead of the app's shortcuts: only Space (play/stop) and ⌘Z / ⇧⌘Z
  // (undo/redo) reach the app; digits, letters etc. would mute zones or switch the
  // arrangement behind the panel.
  document.addEventListener(
    'keydown',
    (ev) => {
      if (!overlayEl.classList.contains('open') || !activeCtx) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.code === 'KeyZ') return;
      const target = ev.target as HTMLElement;
      if (target.matches('input, select, textarea')) {
        // a field of the step editor keeps its keys (the overlay stops them for the app)
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          target.blur();
        }
        return;
      }
      if (ev.code === 'Space') {
        ev.preventDefault(); // play / stop (app.ts), not a press of the focused button
        return;
      }
      ev.stopPropagation();
      const zone = activeCtx.zone;
      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [ev.shiftKey ? -4 : -1, 0],
        ArrowRight: [ev.shiftKey ? 4 : 1, 0],
        ArrowUp: [0, ev.shiftKey ? 12 : 1],
        ArrowDown: [0, ev.shiftKey ? -12 : -1]
      };
      if (mod && ev.code === 'KeyA') {
        ev.preventDefault();
        selectAll(zone);
      } else if (mod && (ev.code === 'KeyC' || ev.code === 'KeyX')) {
        ev.preventDefault();
        const count = selectedNotes.size;
        if (!copySelection(zone)) return;
        if (ev.code === 'KeyX') deleteSelected(zone, 'Cut Notes');
        else activeCtx.toast(`Copied ${count} note${count == 1 ? '' : 's'}`);
      } else if (mod && ev.code === 'KeyV') {
        ev.preventDefault();
        if (!clipboard) {
          activeCtx.toast('Nothing to paste: copy notes first (⌘C)');
          return;
        }
        const at = nextPasteStep;
        pasteClip(zone, clipboard, at, 'Paste Notes');
        nextPasteStep = at + clipboard.span;
      } else if (mod && ev.code === 'KeyD') {
        ev.preventDefault();
        const clip = clipSelection(zone.sequence);
        if (!clip) return;
        const first = Math.min(...selectedItems(zone.sequence).map((i) => i.startStep));
        pasteClip(zone, clip, first + clip.span, 'Duplicate Notes');
      } else if (arrows[ev.key] && !mod && !ev.altKey) {
        ev.preventDefault();
        moveSelected(zone, ...arrows[ev.key]);
      } else if (ev.key === 'Escape') {
        const menu = DOM.get('#contextmenu') as HTMLElement | null;
        if (menu && menu.style.display === 'block') {
          window.dispatchEvent(new CustomEvent('closeContextMenu'));
        } else if (selectedNotes.size > 0) {
          clearSelection();
          renderNotesAndVelocity(activeCtx.zone);
        } else close();
      } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
        ev.preventDefault();
        deleteSelected(zone);
      }
    },
    true
  );
  overlayEl.addEventListener('keydown', (ev) => {
    if (!((ev.metaKey || ev.ctrlKey) && ev.code === 'KeyZ')) ev.stopPropagation();
  });
  document.addEventListener('mousedown', (ev) => {
    if (!overlayEl.classList.contains('open')) return;
    const target = ev.target as Element;
    // menus (Apply to all), dialogs and toasts opened from the panel live outside it
    if (overlayEl.contains(target) || target.closest('#contextmenu, dialog, #toast')) return;
    close();
  });
  // Changes from the step editor or a menu (marks, lengths, velocities) show here too
  window.addEventListener(ZONES_CHANGED_EVENT, () => {
    if (!activeCtx || redrawPending) return;
    redrawPending = true;
    requestAnimationFrame(() => {
      redrawPending = false;
      if (activeCtx && !dragState && !boxState) renderNotesAndVelocity(activeCtx.zone);
    });
  });

  window.addEventListener('resize', () => {
    if (activeCtx && !dragState) renderAll(activeCtx.zone);
  });
  window.addEventListener('mousemove', handleWindowMouseMove);
  window.addEventListener('mouseup', handleWindowMouseUp);
}
