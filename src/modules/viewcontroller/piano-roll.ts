import DOM from '../domutils';
import MIDI from '../midi';
import { Note } from '../zone/note';
import { SeqStep } from '../zone/seq-step';
import potDragHandler from '../potdraghandler';
import { ActionContext, ZoneType, SequenceType } from './types';
import { labelForZone } from './action-labels';

// Fixed cell size — no zoom in v1 (per spec), so these can be baked into styles.css too.
const CELL_W = 24; // px per step
const ROW_H = 14; // px per pitch row
const VELOCITY_LANE_H = 80; // px

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function stepToX(stepIndex: number): number {
  return stepIndex * CELL_W;
}

function xToStep(x: number, sequenceLength: number): number {
  return clamp(Math.floor(x / CELL_W), 0, sequenceLength - 1);
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
    sequence.steps[toStepIndex] = targetStep;
  }
  if (!SeqStep.addNote(targetStep.notesArray, note)) {
    // Target pitch already occupied at that step — put the note back where it was.
    setPitch(note, previousPitch);
    srcStep.notesArray.splice(idx, 0, note);
    return;
  }

  if (srcStep.notesArray.length === 0) {
    sequence.steps[fromStepIndex] = null;
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
interface DragItem {
  note: Note;
  startStep: number;
  startPitch: number;
}
interface DragState {
  mode: DragMode;
  anchorX: number;
  anchorY: number;
  lastDeltaSteps: number;
  lastDeltaPitch: number;
  items: DragItem[];
  resizeStepIndex?: number;
  resizeStartLength?: number;
}

let activeCtx: ActionContext | null = null;
let lastBoundSequence: SequenceType | null = null;
let rafHandle: number | null = null;
let dragState: DragState | null = null;
const selectedNotes = new Set<Note>();
let keysBuilt = false;

let overlayEl: HTMLElement;
let titleEl: HTMLElement;
let closeBtn: HTMLElement;
let mainScrollEl: HTMLElement;
let keysEl: HTMLElement;
let gridEl: HTMLElement;
let notesEl: HTMLElement;
let playheadEl: HTMLElement;
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
  }
}

function getZoneColor(zone: ZoneType): string {
  if (zone.elements.zoneElement) {
    const c = getComputedStyle(zone.elements.zoneElement)
      .getPropertyValue('--zone-color')
      .trim();
    if (c) return c;
  }
  return '#e9c46a';
}

function clearSelection(): void {
  selectedNotes.clear();
}

function toggleSelection(note: Note, el: HTMLElement): void {
  if (selectedNotes.has(note)) {
    selectedNotes.delete(note);
    el.classList.remove('selected');
  } else {
    selectedNotes.add(note);
    el.classList.add('selected');
  }
}

function commitEdit(ctx: ActionContext): void {
  ctx.updateValuesForZone(ctx.zoneindex);
  ctx.triggerSave();
}

function deleteSelected(zone: ZoneType): void {
  if (selectedNotes.size === 0 || !activeCtx) return;
  activeCtx.beforeAction(labelForZone(zone, activeCtx.zoneindex, 'Delete Note'));
  const sequence = zone.sequence;
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence.steps[i];
    if (!step) continue;
    if (step.notesArray.some((n) => selectedNotes.has(n))) {
      step.notesArray = step.notesArray.filter((n) => !selectedNotes.has(n));
      if (step.notesArray.length === 0) sequence.steps[i] = null;
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
    const items: DragItem[] = [];
    selectedNotes.forEach((n) => {
      const loc = findNoteLocation(sequence, n);
      if (loc !== null) items.push({ note: n, startStep: loc, startPitch: n.number });
    });
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
        vbar.title = `vel ${note.velo}`;
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

function renderNotesAndVelocity(zone: ZoneType): void {
  const sequence = zone.sequence;
  DOM.empty(notesEl);
  DOM.empty(velocityLaneEl);
  const gridWidth = sequence.length * CELL_W;
  notesEl.style.width = `${gridWidth}px`;
  notesEl.style.height = `${128 * ROW_H}px`;
  gridEl.style.width = `${gridWidth}px`;
  gridEl.style.height = `${128 * ROW_H}px`;
  velocityLaneEl.style.width = `${gridWidth}px`;

  for (let stepIndex = 0; stepIndex < sequence.length; stepIndex++) {
    const step = sequence.steps[stepIndex];
    if (!step) continue;
    for (const note of step.notesArray) {
      const noteEl = document.createElement('div');
      noteEl.className = 'pr-note' + (note.isBlackKey ? ' black' : '');
      if (selectedNotes.has(note)) noteEl.classList.add('selected');
      noteEl.style.left = `${stepToX(stepIndex)}px`;
      noteEl.style.top = `${pitchToY(note.number)}px`;
      noteEl.style.width = `${Math.max(1, step.length * CELL_W - 2)}px`;
      noteEl.title = `${Note.display(note.number)} · vel ${note.velo} · len ${step.length}`;
      const handle = document.createElement('div');
      handle.className = 'pr-note-handle';
      noteEl.appendChild(handle);
      wireNoteInteraction(noteEl, handle, zone, note);
      notesEl.appendChild(noteEl);

      const vbar = document.createElement('div');
      vbar.className = 'pr-vbar';
      vbar.style.left = `${stepToX(stepIndex)}px`;
      vbar.style.width = `${Math.max(1, CELL_W - 2)}px`;
      vbar.style.height = `${(note.velo / 127) * VELOCITY_LANE_H}px`;
      vbar.title = `vel ${note.velo}`;
      wireVelocityDrag(vbar, note, zone);
      velocityLaneEl.appendChild(vbar);
    }
  }
  updatePlayhead(zone);
}

function updatePlayhead(zone: ZoneType): void {
  const sequence = zone.sequence;
  if (sequence.active && sequence.currentStepNumber > -1) {
    playheadEl.style.display = 'block';
    playheadEl.style.left = `${stepToX(sequence.currentStepNumber)}px`;
    playheadEl.style.width = `${CELL_W}px`;
  } else {
    playheadEl.style.display = 'none';
  }
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

function handleGridMouseDown(ev: MouseEvent): void {
  if (ev.button !== 0 || !activeCtx) return;
  const zone = activeCtx.zone;
  const sequence = zone.sequence;
  const rect = gridEl.getBoundingClientRect();
  const stepIndex = xToStep(ev.clientX - rect.left, sequence.length);
  const pitch = yToPitch(ev.clientY - rect.top);

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
  if (!dragState || !activeCtx) return;
  const zone = activeCtx.zone;
  const sequence = zone.sequence;

  if (dragState.mode === 'move') {
    const dx = ev.clientX - dragState.anchorX;
    const dy = ev.clientY - dragState.anchorY;
    const deltaSteps = Math.round(dx / CELL_W);
    const deltaPitch = -Math.round(dy / ROW_H);
    if (deltaSteps === dragState.lastDeltaSteps && deltaPitch === dragState.lastDeltaPitch) return;
    dragState.lastDeltaSteps = deltaSteps;
    dragState.lastDeltaPitch = deltaPitch;

    const ordered = [...dragState.items].sort((a, b) =>
      deltaSteps >= 0 ? b.startStep - a.startStep : a.startStep - b.startStep
    );
    for (const item of ordered) {
      const currentStep = findNoteLocation(sequence, item.note);
      if (currentStep === null) continue;
      const targetStep = clamp(item.startStep + deltaSteps, 0, sequence.length - 1);
      const targetPitch = clamp(item.startPitch + deltaPitch, 0, 127);
      moveNote(sequence, currentStep, item.note, targetStep, targetPitch);
    }
    renderNotesAndVelocity(zone);
    if (deltaPitch !== 0 && dragState.items.length > 0) {
      const previewPitch = clamp(dragState.items[0].startPitch + deltaPitch, 0, 127);
      previewNote(zone, previewPitch, 96);
    }
  } else {
    const dx = ev.clientX - dragState.anchorX;
    const deltaSteps = Math.round(dx / CELL_W);
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
  finishDrag();
}

function renderAll(zone: ZoneType): void {
  renderNotesAndVelocity(zone);
}

function tick(): void {
  if (!activeCtx) {
    rafHandle = null;
    return;
  }
  const zone = activeCtx.zone;
  if (activeCtx.zones.list.indexOf(zone) === -1) {
    close();
    return;
  }
  if (zone.sequence !== lastBoundSequence) {
    lastBoundSequence = zone.sequence;
    if (zone.sequence.isDrumSequence) {
      const toast = activeCtx.toast;
      close();
      toast('Piano roll closed — sequence switched to drum mode');
      return;
    }
    finishDrag();
    clearSelection();
    renderAll(zone);
  } else {
    updatePlayhead(zone);
  }
  rafHandle = requestAnimationFrame(tick);
}

function close(): void {
  finishDrag();
  stopPreview();
  if (activeCtx) {
    // Idempotent safety net: also ends an in-flight velocity-bar (potDragHandler)
    // gesture if the popup is closed mid-drag, so undo-history never stays wedged open.
    activeCtx.endGesture();
    activeCtx.triggerSave();
  }
  clearSelection();
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
  clearSelection();
  titleEl.textContent = ctx.zone.label
    ? `Piano Roll — ${ctx.zone.label}`
    : `Piano Roll — Zone ${ctx.zoneindex + 1}`;
  overlayEl.style.setProperty('--zone-color', getZoneColor(ctx.zone));
  overlayEl.classList.add('open');
  renderAll(ctx.zone);
  centerScrollOnNotes(ctx.zone);
  if (rafHandle === null) rafHandle = requestAnimationFrame(tick);
}

export function initPianoRoll(): void {
  overlayEl = DOM.get('#pianoRollOverlay') as HTMLElement;
  titleEl = overlayEl.querySelector('.pr-title') as HTMLElement;
  closeBtn = overlayEl.querySelector('.pr-close') as HTMLElement;
  mainScrollEl = overlayEl.querySelector('.pr-main-scroll') as HTMLElement;
  keysEl = overlayEl.querySelector('.pr-keys') as HTMLElement;
  gridEl = overlayEl.querySelector('.pr-grid') as HTMLElement;
  notesEl = overlayEl.querySelector('.pr-notes') as HTMLElement;
  playheadEl = overlayEl.querySelector('.pr-playhead') as HTMLElement;
  velocityScrollEl = overlayEl.querySelector('.pr-velocity-scroll-inner') as HTMLElement;
  velocityLaneEl = overlayEl.querySelector('.pr-velocity-lane') as HTMLElement;

  buildKeyboardOnce();

  closeBtn.addEventListener('click', close);
  gridEl.addEventListener('mousedown', handleGridMouseDown);
  mainScrollEl.addEventListener('scroll', () => {
    velocityScrollEl.scrollLeft = mainScrollEl.scrollLeft;
  });

  document.addEventListener('keydown', (ev) => {
    if (!overlayEl.classList.contains('open') || !activeCtx) return;
    if (ev.key === 'Escape') {
      close();
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      const active = document.activeElement as HTMLElement | null;
      if (active && active.matches('input,textarea')) return;
      ev.preventDefault();
      deleteSelected(activeCtx.zone);
    }
  });
  document.addEventListener('mousedown', (ev) => {
    if (!overlayEl.classList.contains('open')) return;
    if (!overlayEl.contains(ev.target as Node)) close();
  });

  window.addEventListener('mousemove', handleWindowMouseMove);
  window.addEventListener('mouseup', handleWindowMouseUp);
}
