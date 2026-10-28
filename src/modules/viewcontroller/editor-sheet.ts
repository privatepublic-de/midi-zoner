import DOM from '../domutils';
import { ZoneType } from './types';
import { zonePrefix } from './action-labels';

/**
 * The header shared by the full-window editor panels (piano roll, controller editor):
 * zone chip, play/stop, the panel's own tools, undo/redo naming the step, Done.
 * Edits apply as they happen, so Done (like Esc or a click outside) only closes.
 */

interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

let history: HistoryState = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
const sheets: HTMLElement[] = [];

// The chip names the zone, so its steps drop the "Zone 1 (name) – " prefix; steps of other zones keep it
function stepName(sheet: HTMLElement, label: string | null): string {
  if (!label) return '';
  const prefix = sheet.dataset.zonePrefix ? `${sheet.dataset.zonePrefix} – ` : '';
  return prefix && label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

function renderHistory(sheet: HTMLElement): void {
  const undo = sheet.querySelector('.es-undo') as HTMLButtonElement;
  const redo = sheet.querySelector('.es-redo') as HTMLButtonElement;
  const undoName = stepName(sheet, history.undoLabel);
  const redoName = stepName(sheet, history.redoLabel);
  undo.disabled = !history.canUndo;
  (undo.querySelector('.es-step') as HTMLElement).textContent = undoName;
  undo.title = undoName ? `Undo ${undoName} (⌘Z)` : 'Undo (⌘Z)';
  redo.disabled = !history.canRedo;
  redo.title = redoName ? `Redo ${redoName} (⇧⌘Z)` : 'Redo (⇧⌘Z)';
}

/** Called by the app whenever the undo history changes */
export function updateSheetHistory(state: HistoryState): void {
  history = state;
  sheets.forEach(renderHistory);
}

/** Names the zone being edited; call on open and when the zone may have changed */
export function setSheetZone(sheet: HTMLElement, zone: ZoneType, index: number): void {
  (sheet.querySelector('.es-zone') as HTMLElement).textContent = zone.label || `Zone ${index + 1}`;
  sheet.dataset.zonePrefix = zonePrefix(zone, index);
  renderHistory(sheet);
}

export function initSheetHeader(sheet: HTMLElement, done: () => void): void {
  sheets.push(sheet);
  sheet.querySelector('.es-done')!.addEventListener('click', done);
  sheet.querySelector('.es-undo')!.addEventListener('click', () => (DOM.get('#undoBtn') as HTMLElement).click());
  sheet.querySelector('.es-redo')!.addEventListener('click', () => (DOM.get('#redoBtn') as HTMLElement).click());
  sheet.querySelector('.es-play')!.addEventListener('click', () => (DOM.get('#startClockButton') as HTMLElement).click());
  renderHistory(sheet);
}
