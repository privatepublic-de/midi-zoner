import DOM from '../domutils';
import { ZoneType } from './types';
import { CCController, CCControllerType } from '../zone/interfaces';
import { describeActionForZone } from './action-labels';
import {
  effectiveGroup,
  dropIndex,
  isPage,
  isSection,
  moveUnit,
  pageBlocks,
  pageName,
  pageNumberOf,
  sectionBlocks,
  sectionIndexOf
} from '../zone/cc-layout';
import {
  controllerDisplay,
  devicePresetLabel,
  selectorDisplay,
  isRotary,
  knobPaths,
  knobRangePath,
  onControllersChanged,
  startControllerDrag
} from './cc-controller-view';
import { initSheetHeader, setSheetZone } from './editor-sheet';

/**
 * The controller editor: a full-window panel (like the piano roll) for setting up a
 * zone's CC controllers. The zone's CC panel is only for playing them. All changes go
 * through the cc_* actions (undo, saving), and the panel redraws whenever the zone's
 * controllers are updated (onControllersChanged).
 */

export interface CCEditorHooks {
  zone: (index: number) => ZoneType | undefined;
  actionHandler: (ev: Event, overrideaction?: string) => void;
  contextHandler: (ev: MouseEvent) => void;
  gestureStart: (label: string) => void;
  gestureEnd: () => void;
  triggerSave: () => void;
  showPage: (index: number, page: number) => void;
}

let hooks: CCEditorHooks;
let overlay: HTMLElement;
let zoneIndex = -1;
// Undo replaces the zone objects; the panel keeps its selection across that
let shownZone: ZoneType | undefined;
let shownSelection = -1;
// Structure of the value rows, so typing doesn't rebuild the input it happens in
let valueRowsKey = '';
// Collapsed pages and sections in the list (view only: not saved, no undo), per zone
const collapsedByZone = new Map<number, Set<string>>();
// Rows inside a collapsed page or section, from the last render
let hiddenRows: boolean[] = [];

const TYPE_NAMES: Record<number, string> = {
  [CCControllerType.UNIPOLAR_ROTARY]: 'Knob',
  [CCControllerType.BIPOLAR_ROTARY]: 'Bipolar',
  [CCControllerType.SPACER]: 'Gap',
  [CCControllerType.BUTTON_BANK]: 'Buttons',
  [CCControllerType.NOTE_TO_CC]: 'Note to CC',
  [CCControllerType.UNIPOLAR_14BIT]: '14 bit',
  [CCControllerType.BIPOLAR_14BIT]: '14 bit ±',
  [CCControllerType.NRPN]: 'NRPN',
  [CCControllerType.SECTION]: 'Section',
  [CCControllerType.SELECTOR]: 'Selector',
  [CCControllerType.PAGE]: 'Page'
};

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  return overlay.querySelector(selector) as T;
}

function currentZone(): ZoneType | undefined {
  return zoneIndex < 0 ? undefined : hooks.zone(zoneIndex);
}

function act(ev: Event, action: string): void {
  hooks.actionHandler(ev, `${zoneIndex}:${action}`);
}

/** Sets a field unless the user is typing in it */
function setField(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (el !== document.activeElement && el.value !== value) el.value = value;
}

function setCheck(el: HTMLElement, on: boolean): void {
  el.classList.toggle('selected', on);
  el.setAttribute('aria-pressed', String(on));
  (el.querySelector('.material-icons') as HTMLElement).textContent = on ? 'check_box' : 'check_box_outline_blank';
}

function typeName(c: CCController): string {
  if (c.type == CCControllerType.UNIPOLAR_14BIT && c.lsb_bits == 3) return '10 bit';
  if (c.type == CCControllerType.BIPOLAR_14BIT && c.lsb_bits == 3) return '10 bit ±';
  return TYPE_NAMES[c.type] ?? '';
}

function sendsText(c: CCController): string {
  switch (c.type) {
    case CCControllerType.SPACER:
    case CCControllerType.SECTION:
    case CCControllerType.PAGE:
      return '';
    case CCControllerType.NOTE_TO_CC:
      return [c.note_cc != null ? `note → CC ${c.note_cc}` : '', c.velocity_cc != null ? `vel. → CC ${c.velocity_cc}` : '']
        .filter((t) => t)
        .join(', ');
    case CCControllerType.UNIPOLAR_14BIT:
    case CCControllerType.BIPOLAR_14BIT:
      return `CC ${c.number} + ${c.number_lsb ?? 0}`;
    case CCControllerType.NRPN:
      return `NRPN ${c.nrpn_msb || 0}:${c.nrpn_lsb || 0}`;
    default:
      return `CC ${c.number}`;
  }
}

function rangeText(c: CCController): string {
  if (c.type == CCControllerType.UNIPOLAR_ROTARY && c.discreteValues?.length) return `${c.discreteValues.length} steps`;
  if (c.type == CCControllerType.NRPN) return `${c.min || 0}–${c.max ?? 16383}`;
  if (c.type == CCControllerType.UNIPOLAR_ROTARY || c.type == CCControllerType.BIPOLAR_ROTARY) {
    const min = c.min || 0;
    const max = c.max ?? 127;
    return min == 0 && max == 127 ? '' : `${min}–${max}`;
  }
  if (c.type == CCControllerType.SELECTOR) {
    const count = c.discreteValues?.length ?? 0;
    return `${count} entr${count == 1 ? 'y' : 'ies'}`;
  }
  if (c.type == CCControllerType.BUTTON_BANK) {
    const count = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => ((c as any)[`buttonlabel${i}`] ?? '').trim() != '').length;
    return `${count} button${count == 1 ? '' : 's'}`;
  }
  return '';
}

function cell(text: string, className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** Text input wired to an action, with one undo entry per edit */
function actionInput(type: 'text' | 'number', action: () => string, attrs: Record<string, string> = {}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
  input.addEventListener('input', (ev) => act(ev, action()));
  bindGesture(input, action);
  return input;
}

function bindGesture(input: HTMLInputElement | HTMLSelectElement, action: () => string): void {
  input.addEventListener('focus', () => {
    if (input instanceof HTMLInputElement) input.select();
    const zone = currentZone();
    if (zone) hooks.gestureStart(describeActionForZone(`${zoneIndex}:${action()}`, zone, zoneIndex));
  });
  input.addEventListener('blur', () => hooks.gestureEnd());
}

function select(ix: number): void {
  const zone = currentZone();
  if (!zone || ix < 0 || ix >= zone.cc_controllers.length) return;
  zone.selectedCCIndex = ix;
  zone.midiLearnCC = false;
  refresh();
  overlay.querySelector('.cce-rows .cce-row.selected')?.scrollIntoView({ block: 'nearest' });
}

// ---------- list ----------

function isHeader(c: CCController | undefined): boolean {
  return isPage(c) || isSection(c);
}

/**
 * Names the page and section rows by kind, label and occurrence, so a collapsed one stays
 * collapsed when others are added or moved, and across undo (which replaces the objects)
 */
function headerKeys(controllers: CCController[]): Map<number, string> {
  const keys = new Map<number, string>();
  const seen = new Map<string, number>();
  controllers.forEach((c, ix) => {
    if (!isHeader(c)) return;
    const base = `${isPage(c) ? 'p' : 's'}:${c.label.trim()}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    keys.set(ix, `${base}:${n}`);
  });
  return keys;
}

function collapsedSet(): Set<string> {
  let set = collapsedByZone.get(zoneIndex);
  if (!set) collapsedByZone.set(zoneIndex, (set = new Set()));
  return set;
}

/** Collapses or expands a page or section row; `all` does it for every one of its kind */
function toggleCollapsed(ix: number, collapse?: boolean, all = false): void {
  const zone = currentZone();
  const c = zone?.cc_controllers[ix];
  if (!zone || !isHeader(c)) return;
  const keys = headerKeys(zone.cc_controllers);
  const set = collapsedSet();
  const fold = collapse ?? !set.has(keys.get(ix)!);
  const targets = all ? [...keys.keys()].filter((h) => isPage(zone.cc_controllers[h]) == isPage(c)) : [ix];
  for (const h of targets) {
    if (fold) set.add(keys.get(h)!);
    else set.delete(keys.get(h)!);
    // The selection stays visible: inside a collapsed row it moves up to it
    const [start, end] = moveUnit(zone.cc_controllers, h);
    if (fold && zone.selectedCCIndex > start && zone.selectedCCIndex < end) zone.selectedCCIndex = h;
  }
  refresh();
  overlay.querySelector('.cce-rows .cce-row.selected')?.scrollIntoView({ block: 'nearest' });
}

/** Marks the rows inside collapsed pages and sections; expands those around the selection */
function updateHiddenRows(zone: ZoneType): void {
  const controllers = zone.cc_controllers;
  const set = collapsedSet();
  hiddenRows = controllers.map(() => false);
  for (const [h, key] of headerKeys(controllers)) {
    if (!set.has(key)) continue;
    const [start, end] = moveUnit(controllers, h);
    if (zone.selectedCCIndex > start && zone.selectedCCIndex < end) {
      set.delete(key);
      continue;
    }
    for (let i = start + 1; i < end; i++) hiddenRows[i] = true;
  }
  // Keys of entries that are gone
  const live = new Set(headerKeys(controllers).values());
  for (const key of set) if (!live.has(key)) set.delete(key);
}

/** The next row up or down that isn't inside a collapsed page or section */
function nextVisible(from: number, dir: number): number {
  for (let i = from + dir; i >= 0 && i < hiddenRows.length; i += dir) if (!hiddenRows[i]) return i;
  return from;
}

let dragFrom = -1;

function clearDropMarks(rows: HTMLElement): void {
  rows.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
}

function dropsAfter(row: HTMLElement, e: DragEvent): boolean {
  const rect = row.getBoundingClientRect();
  return e.clientY > rect.top + rect.height / 2;
}

function renderRows(zone: ZoneType): void {
  const rows = $('.cce-rows');
  rows.replaceChildren();
  updateHiddenRows(zone);
  const collapsed = collapsedSet();
  const keys = headerKeys(zone.cc_controllers);
  const sectionSizes = new Map(sectionBlocks(zone.cc_controllers).map((b) => [b.section, b.items.length]));
  for (const p of pageBlocks(zone.cc_controllers)) {
    const controls = zone.cc_controllers.slice(p.start, p.end).filter((c) => !isSection(c)).length;
    if (p.page >= 0) sectionSizes.set(p.page, controls);
  }
  zone.cc_controllers.forEach((c, ix) => {
    const page = isPage(c);
    const section = isSection(c) || page;
    const gap = c.type == CCControllerType.SPACER;
    const row = document.createElement('div');
    row.className = 'cce-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(ix == zone.selectedCCIndex));
    row.classList.toggle('selected', ix == zone.selectedCCIndex);
    row.classList.toggle('spacer', gap);
    row.classList.toggle('cce-section-row', section);
    row.classList.toggle('cce-page-row', page);
    row.classList.toggle('in-section', !section && sectionIndexOf(zone.cc_controllers, ix) >= 0);
    row.classList.toggle('collapsed', section && collapsed.has(keys.get(ix)!));
    row.hidden = hiddenRows[ix];
    row.dataset.group = String(effectiveGroup(zone.cc_controllers, ix));
    row.draggable = true;
    const swatch = cell('', 'cce-swatch');
    const name = cell(
      page ? c.label.trim() || 'Page' : section ? c.label.trim() || 'Row break' : gap ? 'Gap' : c.label || '(no name)',
      'cce-row-name'
    );
    name.title = name.textContent!;
    if (section) {
      const fold = document.createElement('i');
      fold.className = 'material-icons cce-fold';
      fold.textContent = 'expand_more';
      fold.title = `Collapse or expand (⌥-click: all ${page ? 'pages' : 'sections'})`;
      fold.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapsed(ix, undefined, e.altKey);
        overlay.focus();
      });
      // Not a drag handle: a quick click shouldn't start dragging the row
      fold.addEventListener('mousedown', (e) => e.stopPropagation());
      name.prepend(fold);
      row.addEventListener('dblclick', () => toggleCollapsed(ix));
    }
    const size = sectionSizes.get(ix) ?? 0;
    row.append(
      swatch,
      name,
      cell(gap ? '' : typeName(c), 'cce-row-type'),
      cell(sendsText(c), 'cce-row-sends'),
      cell(section ? `${size} control${size == 1 ? '' : 's'}` : rangeText(c), 'cce-row-range'),
      cell(c.number_in != null && !gap && !section ? `CC ${c.number_in}` : '', 'cce-row-in')
    );
    row.addEventListener('click', () => {
      select(ix);
      overlay.focus();
    });
    row.addEventListener('dragstart', (e) => {
      // A section or page takes its controllers along
      dragFrom = ix;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', String(ix));
      const [start, end] = moveUnit(zone.cc_controllers, ix);
      for (let k = start; k < end; k++) rows.children[k]?.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragFrom = -1;
      clearDropMarks(rows);
      rows.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
    });
    row.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      // Mark where it lands: above the row at that index, or below the last one
      const at = dropIndex(zone.cc_controllers, dragFrom, ix, dropsAfter(row, e));
      clearDropMarks(rows);
      // Rows inside a collapsed page or section aren't shown: mark the next one that is
      let mark = at;
      while (mark < rows.children.length && hiddenRows[mark]) mark++;
      if (mark < rows.children.length) rows.children[mark].classList.add('drop-before');
      else [...rows.children].reverse().find((r) => !(r as HTMLElement).hidden)?.classList.add('drop-after');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragFrom < 0) return;
      const [start, end] = moveUnit(zone.cc_controllers, dragFrom);
      const at = dropIndex(zone.cc_controllers, dragFrom, ix, dropsAfter(row, e));
      if (at < start || at > end) act(e, `cc_move_range:${start}:${end - start}:${at}`);
    });
    rows.append(row);
  });
  $('.cce-empty').hidden = zone.cc_controllers.length > 0;
  overlay.querySelectorAll<HTMLButtonElement>('[data-needs-selection]').forEach((b) => {
    b.disabled = !zone.cc_controllers[zone.selectedCCIndex];
  });
  overlay.querySelectorAll<HTMLButtonElement>('[data-needs-controllers]').forEach((b) => {
    b.disabled = zone.cc_controllers.length === 0;
  });
}

function div(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** The controllers as they are laid out in the zone: sections, 8 knobs per row */
function renderLayout(zone: ZoneType): void {
  const layout = $('.cce-layout');
  layout.replaceChildren();
  const cs = zone.cc_controllers;
  // The page of the selected controller
  const pages = pageBlocks(cs);
  const pageNo = Math.min(zone.ccPage, pages.length - 1);
  const page = pages[pageNo];
  if (pages.length > 1) {
    const caption = div('cce-layout-caption');
    caption.textContent = `Page ${pageNo + 1} of ${pages.length}: ${pageName(cs, pages, pageNo)}`;
    layout.append(caption);
  }
  sectionBlocks(cs, page.start, page.end).forEach((block, n) => {
    const section = block.section >= 0 ? cs[block.section] : null;
    const inline = section?.new_row === false && n > 0;
    if (n > 0 && !inline) layout.append(div('cce-mini-break'));
    const sectionEl = div(`cce-mini-section${inline ? ' inline' : ''}`);
    if (section) {
      const head = div('cce-mini-head');
      head.dataset.group = String(section.group || 0);
      head.classList.toggle('unnamed', !section.label.trim());
      head.classList.toggle('selected', block.section == zone.selectedCCIndex);
      head.title = section.label.trim() || 'Row break';
      head.addEventListener('click', () => select(block.section));
      sectionEl.append(head);
    }
    const pots = div('cce-mini-pots');
    for (const ix of block.items) {
      const mini = div('cce-mini');
      mini.dataset.group = String(effectiveGroup(cs, ix));
      mini.dataset.type = String(cs[ix].type);
      mini.classList.toggle('selected', ix == zone.selectedCCIndex);
      mini.title = cs[ix].type == CCControllerType.SPACER ? 'Gap' : cs[ix].label;
      mini.addEventListener('click', () => select(ix));
      pots.append(mini);
    }
    sectionEl.append(pots);
    layout.append(sectionEl);
  });
  layout.hidden = cs.length == 0;
}

// ---------- inspector ----------

function renderKnob(zone: ZoneType, c: CCController, ix: number): void {
  if (isRotary(c)) {
    // Drawn like the zone's knob: the arc in the controller's colour
    $('.cce-knob').dataset.group = String(effectiveGroup(zone.cc_controllers, ix));
    const paths = knobPaths(c);
    $('.cce-knob-value').setAttribute('d', paths.value);
    $('.cce-knob-discrete').setAttribute('d', paths.discrete);
    $('.cce-knob-zero').style.display = paths.bipolar ? '' : 'none';
    const display = controllerDisplay(zone, c, ix);
    $('.cce-knob-value-text').textContent = display.value;
    $('.cce-knob-name').textContent = display.name;
  }
  if (c.type == CCControllerType.SELECTOR) {
    const display = selectorDisplay(c);
    $('.cce-sel-name').textContent = display.name;
    $('.cce-sel-name').dataset.empty = display.index < 0 ? '1' : '';
    $('.cce-sel-pos').textContent = display.position;
    $('.cce-selector-preview').dataset.group = String(effectiveGroup(zone.cc_controllers, ix));
  }
  if (c.type == CCControllerType.BUTTON_BANK) {
    $('.cce-button-preview')
      .querySelectorAll<HTMLElement>('.ccbtn')
      .forEach((b) => b.classList.toggle('selected', (c as any)[`buttonvalue${b.dataset.button}`] == c.val));
  }
  markCurrentValue(zone, c, ix);
}

function renderButtonPreview(c: CCController): void {
  const preview = $('.cce-button-preview');
  preview.replaceChildren();
  let count = 0;
  for (let i = 0; i < 8; i++) {
    const label = ((c as any)[`buttonlabel${i}`] ?? '').trim();
    if (label == '' || (c as any)[`buttonvalue${i}`] === undefined) continue;
    const button = document.createElement('div');
    button.className = 'ccbtn';
    button.dataset.button = String(i);
    button.textContent = label;
    button.addEventListener('click', (ev) => act(ev, `cc_button_trig:${currentZone()!.selectedCCIndex}:${i}`));
    preview.append(button);
    count++;
  }
  preview.style.setProperty('--button-rows', String(count <= 3 ? Math.max(count, 1) : Math.ceil(count / 2)));
}

function renderButtonFields(c: CCController): void {
  overlay.querySelectorAll<HTMLElement>('.cce-button-row').forEach((row, i) => {
    const label = (c as any)[`buttonlabel${i}`];
    const value = (c as any)[`buttonvalue${i}`];
    setField(row.querySelector('.cce-button-label') as HTMLInputElement, label ?? '');
    setField(row.querySelector('.cce-button-value') as HTMLInputElement, value === undefined ? '' : String(value));
  });
}

/** Values listed one row each with an editable value: snap steps, or a selector's entries */
function isSnapping(c: CCController): boolean {
  return (
    (c.type == CCControllerType.UNIPOLAR_ROTARY && !!c.discreteValues?.length) || c.type == CCControllerType.SELECTOR
  );
}

function renderValues(zone: ZoneType, c: CCController, ix: number): void {
  const snap = isSnapping(c);
  const selector = c.type == CCControllerType.SELECTOR;
  setCheck($('.cce-snap'), snap);
  $('.cce-spread').hidden = c.type != CCControllerType.UNIPOLAR_ROTARY;
  $('.cce-values-head').hidden = c.type != CCControllerType.UNIPOLAR_ROTARY;
  $('.cce-value-add span').textContent = selector ? 'Add entry' : snap ? 'Add step' : 'Add name';
  $('.cce-values-hint').textContent = selector
    ? 'Each entry sends its value; the selector steps through them in this order.'
    : snap
    ? 'The knob stops at these values; the names show under it.'
    : c.type == CCControllerType.NRPN
      ? 'Names for the values from Min upwards, shown under the knob.'
      : 'Names for the sent values from Min upwards, shown under the knob. Snap to steps turns the knob into a selector.';
  const names = c.valueNames ?? [];
  const count = snap ? c.discreteValues!.length : names.length;
  const key = `${zoneIndex}:${ix}:${c.type}:${snap}:${count}`;
  const list = $('.cce-values');
  if (key != valueRowsKey) {
    valueRowsKey = key;
    list.replaceChildren();
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'cce-value-row';
      if (snap) {
        row.append(
          actionInput('number', () => `cc_step_value:${i}`, {
            min: '0',
            max: '127',
            class: 'cce-step-value',
            title: selector ? 'The value it sends, 0–127' : 'Knob position, 0–127'
          })
        );
      } else {
        row.append(cell('', 'cce-value-fixed'));
      }
      row.append(cell('', 'cce-value-sends'));
      row.append(actionInput('text', () => `cc_value_name:${i}`, { maxlength: '24', class: 'cce-value-name', placeholder: 'name' }));
      if (snap) {
        const remove = document.createElement('button');
        remove.className = 'cce-icon-button';
        remove.title = selector ? 'Remove this entry' : 'Remove this step';
        remove.innerHTML = '<i class="material-icons">close</i>';
        remove.addEventListener('click', (ev) => act(ev, `cc_step_remove:${i}`));
        row.append(remove);
      }
      list.append(row);
    }
  }
  list.querySelectorAll<HTMLElement>('.cce-value-row').forEach((row, i) => {
    const sends = row.querySelector('.cce-value-sends') as HTMLElement;
    if (snap) {
      const v = c.discreteValues![i];
      setField(row.querySelector('.cce-step-value') as HTMLInputElement, String(v));
      const sent = selector ? v : zone.remapCCValue(v, ix);
      sends.textContent = sent != v ? `sends ${sent}` : '';
    } else {
      (row.querySelector('.cce-value-fixed') as HTMLElement).textContent = String((c.min || 0) + i);
      sends.textContent = '';
    }
    setField(row.querySelector('.cce-value-name') as HTMLInputElement, names[i] ?? '');
  });
}

function markCurrentValue(zone: ZoneType, c: CCController, ix: number): void {
  let current = -1;
  if (isSnapping(c)) {
    current = c.discreteValues!.indexOf(c.val);
  } else if (c.type == CCControllerType.UNIPOLAR_ROTARY) {
    current = zone.remapCCValue(c.val, ix) - (c.min || 0);
  } else if (c.type == CCControllerType.NRPN) {
    current = zone.nrpnValue(c) - (c.min || 0);
  }
  $('.cce-values')
    .querySelectorAll('.cce-value-row')
    .forEach((row, i) => row.classList.toggle('cce-current', i == current));
}

function renderInspector(zone: ZoneType): void {
  const ix = zone.selectedCCIndex;
  const c = zone.cc_controllers[ix];
  overlay.classList.toggle('cce-no-selection', !c);
  if (!c) return;
  const type = String(c.type);
  overlay.querySelectorAll<HTMLElement>('.cce-inspector [data-types]').forEach((el) => {
    el.hidden = !el.dataset.types!.split(' ').includes(type);
  });
  setField($<HTMLInputElement>('.cce-name'), c.label ?? '');
  setField($<HTMLSelectElement>('.cce-type'), type);
  overlay.querySelectorAll<HTMLElement>('.cce-colour').forEach((b) => {
    b.classList.toggle('selected', b.dataset.group == String(c.group || 0));
  });
  // The first swatch: the section's colour for its controllers, standard otherwise
  const sectionIx = isSection(c) ? -1 : sectionIndexOf(zone.cc_controllers, ix);
  const sectionGroup = sectionIx >= 0 ? zone.cc_controllers[sectionIx].group || 0 : 0;
  const defaultSwatch = $('.cce-colour-default');
  defaultSwatch.title = sectionIx >= 0 ? 'Section colour' : 'Standard';
  defaultSwatch.classList.toggle('inherit', sectionIx >= 0);
  if (sectionGroup) defaultSwatch.style.setProperty('--cce-group', `var(--group-surface-${sectionGroup})`);
  else defaultSwatch.style.removeProperty('--cce-group');
  setCheck($('.cce-new-row'), c.new_row !== false);
  setField($<HTMLInputElement>('.cce-cc'), String(c.number));
  setField($<HTMLInputElement>('.cce-cc-msb'), String(c.number));
  setField($<HTMLInputElement>('.cce-cc-lsb'), String(c.number_lsb ?? 0));
  setField($<HTMLSelectElement>('.cce-14bit-format'), `${c.lsb_bits ?? 7}:${c.msb_first ? 'msb' : 'lsb'}`);
  setField($<HTMLInputElement>('.cce-nrpn-msb'), String(c.nrpn_msb || 0));
  setField($<HTMLInputElement>('.cce-nrpn-lsb'), String(c.nrpn_lsb || 0));
  setField(
    $<HTMLSelectElement>('.cce-nrpn-data'),
    c.nrpn_data_lsb_cc != null ? `${c.nrpn_data_lsb_cc}:${c.nrpn_data_lsb_bits ?? 7}` : 'none'
  );
  setField($<HTMLInputElement>('.cce-note-cc'), c.note_cc != null ? String(c.note_cc) : '');
  setField($<HTMLInputElement>('.cce-velocity-cc'), c.velocity_cc != null ? String(c.velocity_cc) : '');
  const nrpn = c.type == CCControllerType.NRPN;
  const minInput = $<HTMLInputElement>('.cce-min');
  const maxInput = $<HTMLInputElement>('.cce-max');
  minInput.max = maxInput.max = nrpn ? '16383' : '127';
  setField(minInput, String(c.min || 0));
  setField(maxInput, String(c.max ?? (nrpn ? 16383 : 127)));
  setCheck($('[data-cce-action="cc_nrpn_bipolar"]'), !!c.bipolar);
  $('.cce-range-hint').textContent = nrpn
    ? 'In device units: the knob covers Min to Max.'
    : 'The CC values the knob covers, from left to right.';
  setField($<HTMLInputElement>('.cce-in'), c.number_in != null ? String(c.number_in) : '');
  const learn = $('.cce-learn');
  learn.classList.toggle('armed', zone.midiLearnCC);
  learn.setAttribute('aria-pressed', String(zone.midiLearnCC));
  (learn.querySelector('span') as HTMLElement).textContent = zone.midiLearnCC ? 'Move a control…' : 'Learn';
  $<HTMLButtonElement>('.cce-clear-in').disabled = c.number_in == null;
  if (c.type == CCControllerType.UNIPOLAR_ROTARY || nrpn || c.type == CCControllerType.SELECTOR) renderValues(zone, c, ix);
  if (c.type == CCControllerType.BUTTON_BANK) {
    renderButtonPreview(c);
    renderButtonFields(c);
  }
  renderKnob(zone, c, ix);
}

function refresh(onlyIndex?: number): void {
  const zone = currentZone();
  if (!zone) {
    closeCCEditor();
    return;
  }
  if (onlyIndex !== undefined) {
    // A knob moved: only its value changed
    const c = zone.cc_controllers[onlyIndex];
    if (onlyIndex == zone.selectedCCIndex && c) renderKnob(zone, c, onlyIndex);
    return;
  }
  if (zone !== shownZone && shownZone) zone.selectedCCIndex = shownSelection;
  if (zone.selectedCCIndex >= zone.cc_controllers.length) zone.selectedCCIndex = zone.cc_controllers.length - 1;
  if (zone.selectedCCIndex < 0 && zone.cc_controllers.length > 0) zone.selectedCCIndex = 0;
  setSheetZone(overlay, zone, zoneIndex);
  $('.cce-preset-button .cc-preset-name').textContent = devicePresetLabel(zone);
  shownZone = zone;
  shownSelection = zone.selectedCCIndex;
  // The zone shows the page being edited
  if (zone.cc_controllers[zone.selectedCCIndex]) {
    const page = pageNumberOf(zone.cc_controllers, zone.selectedCCIndex);
    if (page != zone.ccPage) {
      hooks.showPage(zoneIndex, page); // redraws the panel through onControllersChanged
      return;
    }
  }
  renderRows(zone);
  renderLayout(zone);
  renderInspector(zone);
}

// ---------- open / close ----------

/** Redraws the panel after zones were re-rendered (undo may have removed its zone) */
export function refreshCCEditor(): void {
  if (isCCEditorOpen()) refresh();
}

export function isCCEditorOpen(): boolean {
  return overlay?.classList.contains('open') ?? false;
}

export function openCCEditor(index: number, ccIndex?: number): void {
  const zone = hooks.zone(index);
  if (!zone) return;
  zoneIndex = index;
  shownZone = undefined;
  valueRowsKey = '';
  if (ccIndex !== undefined && ccIndex >= 0 && ccIndex < zone.cc_controllers.length) zone.selectedCCIndex = ccIndex;
  // The editor sets up the controllers themselves: selected steps would turn its knob into a lock
  if (zone.sequence.hasSelection) {
    zone.sequence.clearSelection();
    zone.sequence.updateZoneView();
  }
  overlay.dataset.colorindex = zone.elements.zoneElement?.dataset.colorindex ?? '0';
  $('.cce-preset-button').dataset.contextmenu = `ccpresets:${index}`;
  overlay.classList.add('open');
  overlay.focus();
  refresh();
  overlay.querySelector('.cce-rows .cce-row.selected')?.scrollIntoView({ block: 'nearest' });
}

export function closeCCEditor(): void {
  if (!isCCEditorOpen()) return;
  // Ends a pending text edit (one undo entry) before the panel goes away
  if (overlay.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  const zone = currentZone();
  if (zone) zone.midiLearnCC = false;
  overlay.classList.remove('open');
  zoneIndex = -1;
  window.dispatchEvent(new CustomEvent('closeContextMenu'));
}

function handleKey(ev: KeyboardEvent): void {
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && ev.code == 'KeyZ') return; // the app's undo / redo (app.ts)
  const typing = (ev.target as HTMLElement).matches('input, select, textarea');
  if (ev.code == 'Space' && !typing) {
    ev.preventDefault(); // play / stop (app.ts), not a press of the focused button
    return;
  }
  // The app's other shortcuts (digits, letters) must not fire behind the panel
  ev.stopPropagation();
  const zone = currentZone();
  if (!zone) return;
  if (ev.key == 'Escape') {
    const menu = DOM.get('#contextmenu') as HTMLElement | null;
    if (menu && menu.style.display == 'block') window.dispatchEvent(new CustomEvent('closeContextMenu'));
    else closeCCEditor();
    return;
  }
  if (typing) return;
  const sel = zone.selectedCCIndex;
  if (ev.key == 'ArrowUp' || ev.key == 'ArrowDown') {
    ev.preventDefault();
    if (ev.altKey) act(ev, ev.key == 'ArrowUp' ? 'cc_left' : 'cc_right');
    else select(nextVisible(sel, ev.key == 'ArrowUp' ? -1 : 1));
  } else if ((ev.key == 'ArrowLeft' || ev.key == 'ArrowRight') && zone.cc_controllers[sel]) {
    // Like a tree: ← collapses (or goes up to the section / page), → expands
    ev.preventDefault();
    const left = ev.key == 'ArrowLeft';
    const row = overlay.querySelectorAll('.cce-rows .cce-row')[sel];
    if (isHeader(zone.cc_controllers[sel])) {
      if (left && row?.classList.contains('collapsed') && isSection(zone.cc_controllers[sel])) {
        const page = pageBlocks(zone.cc_controllers).find((p) => sel < p.end)?.page ?? -1;
        if (page >= 0) select(page);
      } else toggleCollapsed(sel, left);
    } else if (left) {
      const section = sectionIndexOf(zone.cc_controllers, sel);
      const page = pageBlocks(zone.cc_controllers).find((p) => sel < p.end)?.page ?? -1;
      if (section >= 0 || page >= 0) select(Math.max(section, page));
    }
  } else if ((ev.key == 'Delete' || ev.key == 'Backspace') && ev.target === overlay && zone.cc_controllers[sel]) {
    // Only with the list focused: a just-clicked button (Learn, a colour) keeps focus
    ev.preventDefault();
    act(ev, 'cc_remove');
  } else if (mod && ev.code == 'KeyD' && zone.cc_controllers[sel]) {
    ev.preventDefault();
    act(ev, 'cc_duplicate');
  }
}

export function initCCEditor(editorHooks: CCEditorHooks): void {
  hooks = editorHooks;
  overlay = DOM.get('#ccEditor') as HTMLElement;
  $('.cce-knob-range').setAttribute('d', knobRangePath);

  overlay.querySelectorAll<HTMLElement>('[data-cce-action]').forEach((el) => {
    el.addEventListener('click', (ev) => act(ev, el.dataset.cceAction!));
  });
  overlay.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-cce-change]').forEach((el) => {
    el.addEventListener('input', (ev) => act(ev, el.dataset.cceChange!));
    bindGesture(el, () => el.dataset.cceChange!);
  });
  $('.cce-spread-button').addEventListener('click', (ev) => {
    act(ev, `cc_step_spread:${$<HTMLInputElement>('.cce-spread-count').value}`);
  });
  $('.cce-preset-button').addEventListener('click', (ev) => hooks.contextHandler(ev as MouseEvent));
  initSheetHeader(overlay, closeCCEditor);

  // The test knob sends like the zone's knob
  $('.cce-knob').addEventListener('mousedown', (ev) => {
    const zone = currentZone();
    const c = zone?.cc_controllers[zone.selectedCCIndex];
    if (!zone || !c || !isRotary(c) || ev.button !== 0) return;
    ev.preventDefault();
    startControllerDrag(zone, zoneIndex, zone.selectedCCIndex, ev, hooks.gestureStart, hooks.gestureEnd, hooks.triggerSave);
  });

  // The test selector: arrows, drag and scroll like the zone's
  overlay.querySelectorAll<HTMLElement>('.cce-sel-step').forEach((b) => {
    b.addEventListener('click', (ev) => act(ev, `cc_step:${currentZone()!.selectedCCIndex}:${b.dataset.dir}`));
  });
  $('.cce-sel-name').addEventListener('mousedown', (ev) => {
    const zone = currentZone();
    if (!zone || ev.button !== 0) return;
    ev.preventDefault();
    startControllerDrag(zone, zoneIndex, zone.selectedCCIndex, ev, hooks.gestureStart, hooks.gestureEnd, hooks.triggerSave);
  });
  let wheel = 0;
  $('.cce-selector-preview').addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      wheel += ev.deltaY;
      if (Math.abs(wheel) < 40) return;
      const dir = wheel > 0 ? 1 : -1;
      wheel = 0;
      act(ev, `cc_step:${currentZone()!.selectedCCIndex}:${dir}`);
    },
    { passive: false }
  );

  const buttons = $('.cce-buttons-edit');
  for (let i = 0; i < 8; i++) {
    const row = document.createElement('div');
    row.className = 'cce-button-row';
    row.append(
      cell(String(i + 1), 'cce-button-number'),
      actionInput('text', () => `cc_button_label:${i}`, { maxlength: '32', class: 'cce-button-label', placeholder: 'label' }),
      actionInput('number', () => `cc_button_value:${i}`, { min: '0', max: '127', class: 'cce-button-value', placeholder: 'value' })
    );
    buttons.append(row);
  }

  overlay.addEventListener('keydown', handleKey);
  overlay.addEventListener('keyup', (ev) => ev.stopPropagation());
  document.addEventListener('mousedown', (ev) => {
    if (!isCCEditorOpen()) return;
    const target = ev.target as Element;
    // Menus and dialogs opened from the panel live outside it
    if (target.closest('#contextmenu')) {
      ev.preventDefault(); // keeps keyboard focus in the panel
      return;
    }
    if (overlay.contains(target) || target.closest('dialog, #toast')) return;
    closeCCEditor();
  });
  // Back to the panel after a preset dialog, so keys don't reach the app behind it
  document.addEventListener(
    'close',
    (ev) => {
      if (isCCEditorOpen() && ev.target instanceof HTMLDialogElement) overlay.focus();
    },
    true
  );

  onControllersChanged((zone, index, onlyIndex) => {
    if (isCCEditorOpen() && index == zoneIndex) refresh(onlyIndex);
  });
}
