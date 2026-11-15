import DOM, { escapeHTML } from '../domutils';
import MIDI from '../midi';
import { differsFromPreset, findDevicePreset, matchesPort, presetsByMaker, PresetDevice } from '../device-presets';

import DragZone from '../dragzone';
import potDragHandler from '../potdraghandler';
import * as zoneTemplate from '../zone-template';
import { Zone } from '../zone/zone-class';
import { showThruAndProgram } from './actions/filter-actions';
import { MpeMode } from '../zone/mpe';
import { Sequence } from '../zone/sequence';
import { ZONES_CHANGED_EVENT, UPDATE_ZONE_VIEW_EVENT } from '../zone/interfaces';
import { Note } from '../zone/note';
import { showStepProperties } from './step-marks';

import { initToast, toast } from './toast';
import { NumberInputController } from './number-input-controller';
import { UndoHistory } from '../undo-history';
import {
  createActionHandlers,
  ticksToRatchetIndex,
  velocityDeltaToPercent
} from './actions';
import { closeCCEditor, initCCEditor, isCCEditorOpen, refreshCCEditor } from './cc-editor';
import { initPianoRoll } from './piano-roll';
import { initTrackView, isTrackView, setTrackView, followTrack, updateLoopChips, invalidateTrackView } from './track-view';
import { takeStore } from '../take-store';
import { renderStepLocks } from './step-locks';
import { isQuantizable, requestToggle, isPending, hasPendingToggles, takePendingToggles, markPending, setToggleBoundary } from './pending-toggles';
import { describeAction, labelForZone, zonePrefix, ARRANGEMENT_LETTERS } from './action-labels';
import { Meter, DEFAULT_METER, METER_CHOICES, meterLabel, sameMeter, parseMeter } from '../meter';
import type { PressResult } from '../zone/looper';
import {
  updateControllerValues,
  setMenuHandler,
  onLockEdited,
  renderControllersForZone as renderControllersForZoneInternal
} from './cc-controller-view';
import {
  updateOutputPortsForAllZones as updateOutputPortsForAllZonesInternal,
  updateOutputPortsForZone as updateOutputPortsForZoneInternal,
  initOutputPortsForZone as initOutputPortsForZoneInternal,
  listUsedPorts as listUsedPortsInternal,
  getCachedOutputPorts,
  updateInputPortsForAllZones as updateInputPortsForAllZonesInternal,
  updateInputPortsForZone as updateInputPortsForZoneInternal,
  initInputPortsForZone as initInputPortsForZoneInternal,
  getCachedInputPorts
} from './output-port-manager';
import {
  ZonesData,
  ZoneType,
  SequenceType,
  MIDIInstance,
  TouchedNoteResult,
  PortDescriptor,
  ActionContext,
  ActionHelpers
} from './types';

let onStateChange: (() => void) | null = null;

function setStateChangeCallback(fn: (() => void) | null): void {
  onStateChange = fn;
}

const SEQ_ADJUST_LABELS: Record<string, string> = {
  double: 'Repeat (double length)',
  halftime: 'Half speed',
  thirdtime: 'Third speed',
  veloup: 'Velocity 133%',
  velodown: 'Velocity 75%',
  seq_legato: 'Legato',
  seq_staccato: 'Staccato',
  'euclid-distrib': 'Euclidean distribution'
};
const DRUM_UNSUPPORTED_ADJUSTMENTS = ['seq_legato', 'seq_staccato', 'euclid-distrib'];

const contextMenuActionLabel: Record<string, string> = {
  seq_copy_step: '<i class="material-icons">content_copy</i> Copy ',
  seq_paste_step: '<i class="material-icons">content_paste</i> Paste steps',
  seq_clear_step: '<i class="material-icons">clear</i> Clear step',
  seq_clear_locks: '<i class="material-icons">lock_open</i> Clear parameter locks',
  seq_clear_all:
    '<i class="material-icons">playlist_remove</i> Clear complete sequence',
  seq_copy: '<i class="material-icons">content_copy</i> Copy sequence',
  seq_paste: '<i class="material-icons">content_paste</i> Paste sequence',
  seq_copy_lane: '<i class="material-icons">content_copy</i> Copy lane pattern',
  seq_paste_lane:
    '<i class="material-icons">content_paste</i> Paste lane pattern',
  seq_clear_lane: '<i class="material-icons">clear</i> Clear lane',
  zone_change_color: '<i class="material-icons">palette</i> Change colour',
  zone_export: '<i class="material-icons">save_alt</i> Save zone to file…',
  zone_loop_mpe_clear: '<i class="material-icons">clear</i> Clear the loop’s MPE',
  zone_delete: '<i class="material-icons">delete_outline</i> Delete zone…',
  cc_preset_save: '<i class="material-icons">save</i> Save as new preset…',
  cc_presets_manage: '<i class="material-icons">library_books</i> Manage presets…',
  step_copy_length: 'Step length',
  step_copy_gate: 'Gate length',
  step_copy_condition: 'Condition',
  step_copy_chance: 'Chance'
};

let zones: ZonesData = {} as ZonesData;
let midiController: MIDIInstance;
let elAllMuteOff: HTMLElement;
let elAllSoloOff: HTMLElement;
let elAllHoldOff: HTMLElement;
let numberInputController: NumberInputController;

// View setting, per machine: zones silenced by another zone's solo fold like muted
// ones (default), or keep their layout, dimmed, so nothing moves when soloing
const FOLD_SOLOED_OUT_KEY = 'foldSoloedOut';
let foldSoloedOut = localStorage.getItem(FOLD_SOLOED_OUT_KEY) !== '0';

function isFoldSoloedOut(): boolean {
  return foldSoloedOut;
}

function setFoldSoloedOut(on: boolean): void {
  foldSoloedOut = on;
  localStorage.setItem(FOLD_SOLOED_OUT_KEY, on ? '1' : '0');
  updateValuesForAllZones();
}
let triggerSave: () => void = () => {};
let undoHistory: UndoHistory = new UndoHistory();

interface ControllerInitParams {
  saveData: () => void;
  data: ZonesData;
  midi: MIDIInstance;
  history: UndoHistory;
}

function initController({
  saveData,
  data,
  midi,
  history
}: ControllerInitParams): void {
  initToast();
  undoHistory = history;
  const originalSave = saveData;
  triggerSave = () => {
    undoHistory.afterAction(JSON.stringify(zones));
    originalSave();
    window.dispatchEvent(new CustomEvent(ZONES_CHANGED_EVENT));
  };
  zones = data;
  midiController = midi;
  elAllMuteOff = DOM.get('#allMuteOff') as HTMLElement;
  elAllMuteOff.addEventListener('click', allMuteOff);
  elAllSoloOff = DOM.get('#allSoloOff') as HTMLElement;
  elAllSoloOff.addEventListener('click', allSoloOff);
  elAllHoldOff = DOM.get('#allHoldOff') as HTMLElement;
  elAllHoldOff.addEventListener('click', allHoldOff);
  window.addEventListener(Zone.updateZoneViewEventName, ((ev: CustomEvent) => {
    if (ev.detail != null) {
      const index = zones.list.indexOf(ev.detail);
      if (index > -1) {
        updateValuesForZone(index);
      }
    } else {
      updateValuesForAllZones();
    }
  }) as EventListener);
  window.addEventListener(Zone.lockValuesEventName, ((ev: CustomEvent) => {
    const index = zones.list.indexOf(ev.detail);
    if (index > -1) updateControllerValues(zones.list[index], index);
  }) as EventListener);
  initPianoRoll();
  initTrackView(
    () => zones.list,
    (zoneindex, label, change) => {
      undoHistory.beforeAction(JSON.stringify(zones), labelForZone(zones.list[zoneindex], zoneindex, label));
      change();
      updateValuesForZone(zoneindex);
      triggerSave();
    },
    {
      // takes aren't scene data: an edit is an undo step that patches the take back
      commit: (zoneindex, take, label, change) => {
        const before = take.toJSON();
        change();
        const after = take.toJSON();
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        takeStore.touched();
        const refresh = (): void => {
          takeStore.touched();
          invalidateTrackView();
        };
        undoHistory.pushPatch(labelForZone(zones.list[zoneindex], zoneindex, label), {
          undo: () => {
            take.restore(before);
            refresh();
          },
          redo: () => {
            take.restore(after);
            refresh();
          }
        });
        invalidateTrackView();
      },
      remove: (zoneindex, take) => {
        const zoneId = zones.list[zoneindex].id;
        const at = takeStore.remove(zoneId, take);
        if (at < 0) return;
        undoHistory.pushPatch(labelForZone(zones.list[zoneindex], zoneindex, 'Delete Take'), {
          undo: () => {
            takeStore.add(zoneId, take, at);
            invalidateTrackView();
          },
          redo: () => {
            takeStore.remove(zoneId, take);
            invalidateTrackView();
          }
        });
        invalidateTrackView();
      }
    },
    () => meterOf(zones.arrangementIndex)
  );
  setMenuHandler(contextHandler);
  initCCEditor({
    zone: (index) => zones.list[index],
    actionHandler: actionHandler as (ev: Event, overrideaction?: string) => void,
    contextHandler,
    gestureStart: (label) => undoHistory.startGesture(JSON.stringify(zones), label),
    gestureEnd: () => undoHistory.endGesture(JSON.stringify(zones)),
    triggerSave: () => triggerSave(),
    showPage: showControllerPage
  });
  initStepDeselection();
  // A knob writing parameter locks: the steps' marks and the step editor follow, once per frame
  let lockRedrawPending = false;
  onLockEdited((_zone, zoneindex) => {
    if (lockRedrawPending) return;
    lockRedrawPending = true;
    requestAnimationFrame(() => {
      lockRedrawPending = false;
      updateValuesForZone(zoneindex);
    });
  });
  numberInputController = new NumberInputController();
  numberInputController.onAttach = () =>
    undoHistory.startGesture(
      JSON.stringify(zones),
      describeElementAction(numberInputController.elValueBtnAttachedInput)
    );
  numberInputController.onDetach = () => {
    // Don't end gesture if the input still has keyboard focus — the focus/blur pair
    // will handle that boundary instead (avoids premature commit mid-typing).
    if (
      document.activeElement !== numberInputController.elValueBtnAttachedInput
    ) {
      undoHistory.endGesture(JSON.stringify(zones));
    }
  };
  numberInputController.addInputElements(
    DOM.all(`#midisettings input[type=number]`)
  );

  document.addEventListener('input', (ev) => {
    const target = ev.target as HTMLElement;
    if (target.matches('input[type="range"]')) syncRangeFill(target as HTMLInputElement);
  });

  // Range slider gesture: one undo entry per drag, not per pixel.
  // The one-shot mouseup is added only when a range slider actually starts,
  // so it never fires on unrelated clicks (e.g. focusing a text input).
  document.addEventListener('mousedown', (ev) => {
    const target = ev.target as HTMLElement;
    if (target.matches('input[type="range"]')) {
      undoHistory.startGesture(JSON.stringify(zones), describeElementAction(target));
      window.addEventListener(
        'mouseup',
        () => {
          undoHistory.endGesture(JSON.stringify(zones));
        },
        { once: true }
      );
    }
  });
}

// Reads the data-action/data-change/data-focus-change attribute off an input
// element to build the same kind of undo/redo label the click dispatcher uses.
function describeElementAction(element: HTMLElement | null): string {
  const actionString =
    element?.getAttribute('data-change') ||
    element?.getAttribute('data-action') ||
    element?.getAttribute('data-focus-change');
  return actionString ? describeAction(actionString, zones) : 'Value';
}

function findTouchedNote(
  ev: MouseEvent,
  e: HTMLElement,
  zone: ZoneType
): TouchedNoteResult {
  let num = parseInt(
    String(
      ((ev.clientX - DOM.clientOffsets(e).offsetLeft) / e.offsetWidth) * 128
    )
  );
  const isLow =
    zone.lastTouchedRangePoint === 1 ||
    (zone.lastTouchedRangePoint === 0 &&
      Math.abs(num - zone.low) < Math.abs(num - zone.high));
  if (zone.lastTouchedRangePoint === 0) {
    zone.lastTouchedRangePoint = isLow ? 1 : 2;
  }
  if (ev.shiftKey) {
    num = Math.round(num / 12) * 12;
    if (!isLow) num = num - 1;
  }
  if (num > 127) num = 127;
  if (isLow) {
    num = num < zone.high ? num : zone.high;
  } else {
    num = num > zone.low ? num : zone.low;
  }
  return {
    isLow: isLow,
    low: isLow ? num : null,
    high: isLow ? null : num
  };
}

/** True while waiting toggles land, so they don't wait again */
let landingToggles = false;

/**
 * While the clock runs, a zone toggle waits for the next boundary (Setup → Switching → Zone switches)
 * when quantizing (the Quantize chip; Shift does the opposite). Pressing a waiting
 * toggle again cancels it.
 */
function waitsForBoundary(ev: MouseEvent, actionString: string): boolean {
  const [index, action] = actionString.split(':');
  const zone = zones.list[parseInt(index)];
  if (!zone || !isQuantizable(action) || landingToggles || !midiController.isClockRunning) return false;
  if (!isPending(zone, action) && zones.toggleQuantOn === !!ev.shiftKey) return false;
  requestToggle(zone, action);
  return true;
}

/** The waiting toggles land, each one an undo step as if pressed now */
function applyPendingToggles(): void {
  if (!hasPendingToggles()) return;
  landingToggles = true;
  try {
    takePendingToggles().forEach(({ zone, action }) => {
      const index = zones.list.indexOf(zone);
      if (index >= 0) zoneToggle(index, action);
    });
  } finally {
    landingToggles = false;
  }
}

/**
 * The loop button (the zone's Loop chip, Mackie Rec): records a loop, closes it, overdubs
 * it, at the nearest 1 (see zone/looper.ts); two quick presses clear it
 */
function loopZone(index: number): void {
  const zone = zones.list[index];
  if (!zone) return;
  // the undo snapshot is taken before, but only handed over when the loop changed
  const before = JSON.stringify(zones);
  afterLoop(index, before, zone.loopPress(performance.now()));
}

/** Recordings and overdubs that end on this tick (`elapsed`: ticks since the section began) */
function landLoops(elapsed: number): boolean {
  let landed = false;
  zones.list.forEach((zone, index) => {
    const to = zone.loopDueAt(elapsed);
    if (to === null) return;
    const before = JSON.stringify(zones);
    afterLoop(index, before, zone.closeLoop(to, elapsed));
    landed = true;
  });
  return landed;
}

/** Stop or an arrangement switch: recordings and overdubs under way end at their nearest 1 */
function finishLoops(): void {
  zones.list.forEach((zone, index) => {
    if (zone.looper.mode === 'idle') return;
    const before = JSON.stringify(zones);
    const result = zone.finishLoop();
    if (result) afterLoop(index, before, result);
  });
}

/** One undo step when the loop changed */
function afterLoop(index: number, before: string, result: PressResult): void {
  const zone = zones.list[index];
  const name = zone.label || `Zone ${index + 1}`;
  let label = '';
  if (result.kind === 'recorded') label = 'Record Loop';
  else if (result.kind === 'dubbed' && result.added > 0) label = 'Overdub Loop';
  else if (result.kind === 'cleared') label = 'Clear Loop';
  else if (result.kind === 'empty') toast(`${name}: nothing played, no loop`);
  if (label) {
    undoHistory.beforeAction(before, labelForZone(zone, index, label));
    updateValuesForZone(index);
    triggerSave();
    window.dispatchEvent(new CustomEvent(UPDATE_ZONE_VIEW_EVENT, { detail: zone }));
    if (result.kind === 'cleared') toast(`${name}: loop cleared`);
  }
  updateLoopChips();
  onStateChange?.();
}

/** A zone toggle from a key switch or a Mackie button: like a click on its chip */
function zoneToggle(index: number, action: string): void {
  if (!zones.list[index]) return;
  const press = { type: 'click', shiftKey: false, currentTarget: null, stopPropagation: () => {} };
  actionHandler(press as unknown as MouseEvent, `${index}:${action}`);
}

function actionHandler(ev: MouseEvent, overrideaction?: string): void {
  ev.stopPropagation();
  const element = ev.currentTarget as HTMLElement;
  let actionString =
    overrideaction ||
    element.getAttribute('data-action') ||
    element.getAttribute('data-change');
  if (
    (ev.type == 'blur' || ev.type == 'focus') &&
    element.hasAttribute('data-focus-change')
  ) {
    actionString = element.getAttribute('data-focus-change');
    actionString += ':' + (ev.type == 'focus' ? 1 : 0);
  }
  if (actionString!.endsWith(':zone_loop')) {
    loopZone(parseInt(actionString!));
    return;
  }
  if (waitsForBoundary(ev, actionString!)) return;
  undoHistory.beforeAction(JSON.stringify(zones), describeAction(actionString!, zones));
  const params = actionString!.split(':');
  const zoneindex = parseInt(params[0]);
  const action = params[1];
  const actionProperty = action.substring(action.indexOf('_') + 1);
  const actionParam1 = params[2];
  const actionParam2 = params[3];
  const actionParam3 = params[4];

  if (action === 'global_arr_copy_to') {
    const sourceIndex = parseInt(actionParam1);
    const targetIndex = parseInt(actionParam2);
    if (!isNaN(sourceIndex) && !isNaN(targetIndex) && sourceIndex !== targetIndex) {
      zones.list.forEach(z => z.copyArrangementFromTo(sourceIndex, targetIndex));
      triggerSave();
      toast(`Arrangement ${ARRANGEMENT_LETTERS[sourceIndex]} → ${ARRANGEMENT_LETTERS[targetIndex]} copied for all zones`);
    }
    window.dispatchEvent(new CustomEvent('closeContextMenu'));
    return;
  }

  if (action === 'global_arr_meter') {
    const meter = parseMeter(params.slice(3).join(':'));
    if (meter) setArrangementMeter(parseInt(actionParam1), meter);
    window.dispatchEvent(new CustomEvent('closeContextMenu'));
    return;
  }

  const zone: ZoneType = zones.list[zoneindex];
  const sequence: SequenceType = zone.sequence;

  const applyParamToggle = (): void => {
    (zone as any)[actionProperty] = !(zone as any)[actionProperty];
    updateValuesForZone(zoneindex);
  };
  const applySelectedIndex = (): void => {
    (zone as any)[actionProperty] = (
      element as HTMLSelectElement
    ).selectedIndex;
    updateValuesForZone(zoneindex);
  };
  const calcAndDisplayPercentage = (): number => {
    const inputElement = element as HTMLInputElement;
    const output = element.parentElement?.querySelector(
      `output[for="${element.id}"]`
    ) as HTMLOutputElement | null;
    if (output) {
      output.value = inputElement.value + '%';
    }
    // its description (from the labelled block around it) with the value
    const tip = element.parentElement?.closest('[title]:not(input)')?.getAttribute('title');
    element.title = tip ? `${tip}: ${inputElement.value}%` : inputElement.value + '%';
    return parseInt(inputElement.value) / 100;
  };
  const applyPercentage = (): void => {
    (zone as any)[actionProperty] = calcAndDisplayPercentage();
    updateValuesForZone(zoneindex);
  };

  const ctx: ActionContext = {
    zones,
    midiController,
    zone,
    zoneindex,
    sequence,
    element,
    ev,
    actionParam1,
    actionParam2,
    actionParam3,
    triggerSave,
    pushHistory: (snapshot: string, label: string) => undoHistory.push(snapshot, label),
    updateValuesForZone,
    updateValuesForAllZones,
    renderControllersForZone,
    renderMarkersForZone,
    renderZones,
    listUsedPorts: () => listUsedPortsInternal(zones),
    toast,
    updateOutputPortsForZone: (index: number, outputs: PortDescriptor[]) =>
      updateOutputPortsForZoneInternal(
        zones,
        index,
        outputs,
        updateValuesForAllZones
      ),
    cachedOutputPorts: getCachedOutputPorts(),
    cachedInputPorts: getCachedInputPorts(),
    updateInputPortsForZone: (index: number, inputs: PortDescriptor[]) =>
      updateInputPortsForZoneInternal(zones, index, inputs),
    findTouchedNote,
    updateControllerValues,
    selectArrangement,
    beforeAction: (label: string) => undoHistory.beforeAction(JSON.stringify(zones), label),
    startGesture: (label: string) => undoHistory.startGesture(JSON.stringify(zones), label),
    endGesture: () => undoHistory.endGesture(JSON.stringify(zones))
  };

  const helpers: ActionHelpers = {
    applyParamToggle,
    applySelectedIndex,
    applyPercentage,
    calcAndDisplayPercentage
  };

  const actions = createActionHandlers(ctx, helpers, renderControllersForZone);
  actions[action]?.();
  triggerSave();
  window.dispatchEvent(new CustomEvent('closeContextMenu'));
}

/**
 * Menu entries for the device presets of a zone: presets grouped by device (click
 * replaces, shift-click appends), then update / save / folder.
 */
function devicePresetMenu(zoneindex: number): string[] {
  const zone: ZoneType = zones.list[zoneindex];
  const entries = ['label:Device presets · ⇧-click appends'];
  const groups = presetsByMaker();
  if (groups.length === 0) entries.push('label:No presets saved yet');
  for (const group of groups) {
    if (group.maker) entries.push(`heading:${escapeHTML(group.maker)}`);
    for (const device of group.devices) entries.push(`html:${presetDeviceRow(zone, zoneindex, device)}`);
  }
  entries.push('-', `${zoneindex}:cc_preset_update`, `${zoneindex}:cc_preset_save`, `${zoneindex}:cc_presets_manage`);
  return entries;
}

/** A device with its presets as chips (plus "Add all" with more than one) */
function presetDeviceRow(zone: ZoneType, zoneindex: number, device: PresetDevice): string {
  const portName = zones.knownPortNames?.[zone.outputPortId];
  const chips = device.presets.map((preset) => {
    const linked = zone.devicePreset?.id === preset.id;
    const modified = linked && differsFromPreset(zone.cc_controllers, preset) ? ' •' : '';
    const icon = linked ? 'check' : matchesPort(preset, portName) ? 'star_outline' : '';
    const classes = ['cc-preset-chip', linked ? 'linked' : '', preset.source == 'user' ? 'user' : ''].join(' ');
    const title = preset.source == 'user' ? 'Your preset' : 'Factory preset';
    return `<span class="${classes}" title="${title}" data-action="${zoneindex}:cc_preset_apply:${preset.id}">${
      icon ? `<i class="material-icons">${icon}</i>` : ''
    }${escapeHTML(preset.name)}${modified}</span>`;
  });
  if (device.presets.length > 1) {
    chips.push(
      `<span class="cc-preset-chip all" title="Each preset on a page of its own" data-action="${zoneindex}:cc_preset_apply_all:${device.presets[0].id}">Add all</span>`
    );
  }
  return `<li class="cc-preset-device"><span class="cc-preset-device-name">${escapeHTML(device.label)}</span><span class="cc-preset-chips">${chips.join('')}</span></li>`;
}

/** The entries of a selector ("ccselect:<zone>:<controller>") */
function selectorMenu(spec: string): string[] {
  const [, zoneindex, ccindex] = spec.split(':');
  const c = zones.list[parseInt(zoneindex)]?.cc_controllers[parseInt(ccindex)];
  return (c?.discreteValues ?? []).map((_, i) => `${zoneindex}:cc_select_value:${ccindex}:${i}`);
}

function meterOf(arrIndex: number): Meter {
  return zones.meters?.[arrIndex] ?? DEFAULT_METER;
}

/** An arrangement's meter (an undo step of its own when it comes from the menu's field) */
function setArrangementMeter(arrIndex: number, meter: Meter): void {
  if (!(arrIndex >= 0 && arrIndex < 4)) return;
  const meters = (zones.meters ??= []);
  while (meters.length < 4) meters.push(null);
  meters[arrIndex] = sameMeter(meter, DEFAULT_METER) ? null : meter;
  updateArrangementMeters();
  triggerSave();
  toast(`Arrangement ${ARRANGEMENT_LETTERS[arrIndex]} is in ${meterLabel(meter)}`);
}

/** A–D show their meter when it isn't 4/4 */
function updateArrangementMeters(): void {
  (DOM.all("*[data-select-arrangement]") as HTMLElement[]).forEach((el, i) => {
    const meter = meterOf(i);
    if (sameMeter(meter, DEFAULT_METER)) el.removeAttribute('data-meter');
    else el.setAttribute('data-meter', meterLabel(meter).split(' ')[0]);
    el.title = `Arrangement ${ARRANGEMENT_LETTERS[i]} · ${meterLabel(meter)} (right-click: meter, copy)`;
  });
  // the transport's meter chip: the active arrangement's, its menu for that one
  const chip = DOM.get('#meterChip') as HTMLElement | null;
  if (chip) {
    const [meter, grouping] = meterLabel(meterOf(zones.arrangementIndex)).split(' ');
    chip.innerHTML = `${meter}${grouping ? ` <span class="dim">${grouping}</span>` : ''} <i class="material-icons">expand_more</i>`;
    chip.setAttribute('data-contextmenu', `meters:${zones.arrangementIndex}`);
  }
}

/** The meter entries of an arrangement's menu ("meters:<arrangement>") */
/** The zone menu's entry for its loop's MPE expression, when it has some */
function loopMpeMenu(zoneindex: number): string[] {
  return zones.list[zoneindex]?.loop?.hasExpression ? [`${zoneindex}:zone_loop_mpe_clear`] : [];
}

function meterMenu(spec: string): string[] {
  const arr = parseInt(spec.split(':')[1]);
  return [
    '-',
    'heading:Meter',
    ...METER_CHOICES.map((m) => `-1:global_arr_meter:${arr}:${meterLabel(m)}`),
    `html:<li class="meter-other"><input type="text" class="meter-input" data-arr="${arr}" placeholder="Other, e.g. 11/8 3+3+3+2" spellcheck="false" /></li>`
  ];
}

function contextHandler(ev: MouseEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  const element = ev.currentTarget as HTMLElement;
  const menuSpecification = element.getAttribute('data-contextmenu')!;
  const menuActions = menuSpecification
    .split(',')
    .flatMap((act) =>
      act.startsWith('ccpresets:')
        ? devicePresetMenu(parseInt(act.slice(10)))
        : act.startsWith('ccselect:')
          ? selectorMenu(act)
          : act.startsWith('meters:')
            ? meterMenu(act)
            : act.startsWith('loopmpe:')
              ? loopMpeMenu(parseInt(act.slice(8)))
              : [act]
    );
  // (a menu doesn't start with a divider: the meter chip has only the meter entries)
  while (menuActions[0] === '-') menuActions.shift();
  const contextMenuElement = DOM.get('#contextmenu') as HTMLElement;

  DOM.empty(contextMenuElement);
  contextMenuElement.classList.toggle('cc-presets-menu', menuSpecification.startsWith('ccpresets:'));

  function isEnabled(parts: string[]): boolean {
    if (parseInt(parts[0]) < 0) return true;
    const zoneindex = parseInt(parts[0]);
    const zone: ZoneType = zones.list[zoneindex];
    switch (parts[1]) {
      case 'seq_copy_step':
        return zone.sequence.isStepUsed(parseInt(parts[2]));
      case 'seq_clear_locks': {
        const stepno = parseInt(parts[2]);
        const steps = zone.sequence.selectedStepNumbers.has(stepno) ? [...zone.sequence.selectedStepNumbers] : [stepno];
        return steps.some((n) => zone.sequence.stepAt(n)?.hasLocks());
      }
      case 'seq_paste_step':
        return Zone.seqClipboardStep != null;
      case 'seq_paste':
        return Zone.seqClipboardSequence != null;
      case 'seq_paste_lane':
        return Zone.seqClipboardDrumLane != null;
      case 'cc_preset_update': {
        const linked = findDevicePreset(zone.devicePreset?.id);
        return linked?.source == 'user' && differsFromPreset(zone.cc_controllers, linked);
      }
      case 'cc_preset_save':
        return zone.cc_controllers.length > 0;
      case 'seq_adjust':
        // drum lanes only support length and velocity changes
        return !zone.sequence.isDrumSequence || !DRUM_UNSUPPORTED_ADJUSTMENTS.includes(parts[2]);
    }
    return true;
  }

  function labelString(parts: string[]): string {
    if (parts[1] === 'zone_arr_copy_to') {
      const label = ARRANGEMENT_LETTERS[parseInt(parts[2])];
      return `<i class="material-icons">content_copy</i> Copy to arrangement ${label}`;
    }
    if (parts[1] === 'global_arr_copy_to') {
      const target = ARRANGEMENT_LETTERS[parseInt(parts[3])];
      return `<i class="material-icons">content_copy</i> Copy all zones → ${target}`;
    }
    if (parts[1] === 'global_arr_meter') {
      const meter = parseMeter(parts.slice(3).join(':'));
      const current = !!meter && sameMeter(meter, meterOf(parseInt(parts[2])));
      return `<i class="material-icons">${current ? 'check' : ''}</i> ${meter ? meterLabel(meter) : ''}`;
    }
    const zoneindex = parseInt(parts[0]);
    const zone: ZoneType = zones.list[zoneindex];
    if (parts[1] === 'seq_transpose') {
      const n = parseInt(parts[2]);
      const interval = Math.abs(n) === 12 ? ' (octave)' : Math.abs(n) === 7 ? ' (fifth)' : '';
      return `${n > 0 ? '+' : ''}${n}${interval}`;
    }
    if (parts[1] === 'seq_adjust') {
      return SEQ_ADJUST_LABELS[parts[2]] ?? parts[2];
    }
    if (parts[1] === 'cc_select_value') {
      const c = zone.cc_controllers[parseInt(parts[2])];
      const i = parseInt(parts[3]);
      const value = c.discreteValues![i];
      const current = c.val === value;
      // Names come from scene and preset files
      return `<i class="material-icons">${current ? 'check' : ''}</i> ${escapeHTML(c.valueNames?.[i] || String(value))}`;
    }
    if (parts[1] === 'cc_preset_update') {
      const name = findDevicePreset(zone.devicePreset?.id)?.name ?? zone.devicePreset?.name;
      return `<i class="material-icons">save_as</i> Update ${name ? `"${escapeHTML(name)}"` : 'preset'}`;
    }
    if (parts[1] == 'seq_copy_step') {
      let subs;
      if (
        zone.sequence.selectedStepNumbers.has(parseInt(parts[2])) &&
        zone.sequence.selectedStepNumbers.size > 1
      ) {
        subs = ' ' + zone.sequence.selectedStepNumbers.size + ' steps';
      } else {
        subs = ' step';
      }
      return contextMenuActionLabel[parts[1]] + subs;
    }
    return contextMenuActionLabel[parts[1]];
  }

  menuActions.forEach((act) => {
    if (act == '-') {
      DOM.addHTML(contextMenuElement, 'beforeend', `<hr/>`);
    } else if (act.startsWith('html:')) {
      DOM.addHTML(contextMenuElement, 'beforeend', act.slice(5));
    } else if (act.startsWith('heading:')) {
      DOM.addHTML(contextMenuElement, 'beforeend', `<li class="heading">${act.slice(8)}</li>`);
    } else if (act.startsWith('label:')) {
      const label = act.slice(6);
      DOM.addHTML(
        contextMenuElement,
        'beforeend',
        `<li class="label">${label}</li>`
      );
    } else {
      const parts = act.split(':');
      const name = labelString(parts);
      const styleClass = (isEnabled(parts) ? '' : 'disabled') + (parts[1] === 'zone_delete' ? ' danger' : '');
      DOM.addHTML(
        contextMenuElement,
        'beforeend',
        `<li class="${styleClass}" data-action="${act}">${name}</li>`
      );
    }
  });
  DOM.all('#contextmenu *[data-action]').forEach((e) => {
    e.addEventListener('click', (event) => {
      actionHandler(event as MouseEvent);
    });
  });
  contextMenuElement.querySelectorAll<HTMLInputElement>('input.meter-input').forEach((input) => {
    const arr = parseInt(input.dataset.arr!);
    const current = meterOf(arr);
    if (!METER_CHOICES.some((m) => sameMeter(m, current))) input.value = meterLabel(current);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') window.dispatchEvent(new CustomEvent('closeContextMenu'));
      if (e.key !== 'Enter') return;
      const meter = parseMeter(input.value);
      if (!meter) {
        toast('A meter is n/4 or n/8 (n up to 32), x/8 with an optional grouping such as 7/8 2+2+3', { warning: true });
        return;
      }
      undoHistory.push(JSON.stringify(zones), `Meter ${ARRANGEMENT_LETTERS[arr]}: ${meterLabel(meter)}`);
      setArrangementMeter(arr, meter);
      window.dispatchEvent(new CustomEvent('closeContextMenu'));
    });
  });
  contextMenuElement.style.display = 'block';
  const srcRect = element.getBoundingClientRect();
  const menuRect = contextMenuElement.getBoundingClientRect();

  let top = ev.clientY;
  let left = ev.clientX;
  if (element.hasAttribute('data-contextclick')) {
    // menu button: drop down from the button, pushed up only as far as needed
    left = srcRect.left;
    top = srcRect.bottom;
    if (top + menuRect.height > window.innerHeight) {
      top = Math.max(0, window.innerHeight - menuRect.height);
    }
    left = Math.min(left, window.innerWidth - menuRect.width);
  } else {
    if (left + menuRect.width > window.innerWidth) {
      left = window.innerWidth - menuRect.width;
    }
    if (top + menuRect.height > window.innerHeight) {
      top = window.innerHeight - menuRect.height;
      if (top < srcRect.top && srcRect.width < menuRect.width) {
        left += srcRect.width;
      }
    }
  }
  contextMenuElement.style.top = top + 'px';
  contextMenuElement.style.left = left + 'px';

  window.dispatchEvent(new CustomEvent('resetHideOnLeaveContextMenuTimeout'));
  DOM.removeClass('*', 'contextMenuTrigger');
  DOM.addClass(element, 'contextMenuTrigger');
}

function hoverHandler(ev: MouseEvent): void {
  const e = ev.currentTarget as HTMLElement;
  const action = e.getAttribute('data-hover')!;
  const params = action.split(':');
  const zoneindex = parseInt(params[0]);
  const zone: ZoneType = zones.list[zoneindex];
  switch (params[1]) {
    case 'zone_range':
      const result = findTouchedNote(ev, e, zone);
      renderMarkersForZone(
        zoneindex,
        result.low ?? undefined,
        result.high ?? undefined
      );
      break;
  }
}

function hoverOutHandler(ev: MouseEvent): void {
  const e = ev.currentTarget as HTMLElement;
  const action = e.getAttribute('data-hover')!;
  const params = action.split(':');
  const zoneindex = parseInt(params[0]);
  zones.list[zoneindex].lastTouchedRangePoint = 0;
  renderMarkersForZone(zoneindex);
}

function dblClickHandler(ev: MouseEvent): void {
  const e = ev.currentTarget as HTMLElement;
  const action =
    e.getAttribute('data-dblclickaction') || e.getAttribute('data-action');
  undoHistory.beforeAction(JSON.stringify(zones), describeAction(action!, zones));
  const params = action!.split(':');
  const zoneindex = parseInt(params[0]);
  const zone = zones.list[zoneindex];
  switch (params[1]) {
    case 'zone_range':
      zone.high = 127;
      zone.low = 0;
      renderMarkersForZone(zoneindex);
      break;
    case 'zone_arp_pattern':
      zone.arp_pattern.length = 8;
      for (let i = 0; i < zone.arp_pattern.length; i++) {
        zone.arp_pattern[i] = true;
      }
      zone.syncEuclidToPattern();
      zone.renderPattern();
      break;
    case 'zone_solo':
      for (var i = 0; i < zones.list.length; i++) {
        zones.list[i].solo = false;
      }
      zone.solo = true;
      updateValuesForAllZones();
      break;
    case 'seq_clear_step':
      actionHandler(ev, action!);
      break;
  }
  triggerSave();
}

function renderZones(): void {
  DOM.empty('#zones');
  zones.list.forEach((zone) => {
    zone.elements.reset();
  });
  zones.list.forEach((zone, index) => {
    appendZone(zone, index);
  });
  addPlaceholder();
  updateZoneHeaderContextMenus(zones.arrangementIndex);
  refreshCCEditor();
  markPending();
}

function addPlaceholder(): void {
  DOM.all('#zones .zone.addnewzone', (e) => e.remove());
  DOM.addHTML(
    '#zones',
    'beforeend',
    '<div class="zone addnewzone"><a class="action" title="Add a zone">+ Add zone</a>' +
      '<p class="addzone-hint">A zone sends one key range of your keyboard to one MIDI output, with its own arpeggiator, sequencer and controls.</p></div>'
  );
  DOM.all('#zones .zone.placeholder', (e) => e.remove());
  if (zones.list.length % 2 == 0) {
    DOM.addHTML(
      '#zones',
      'beforeend',
      '<section class="zone placeholder"></section>'
    );
  }
}

function renderLastZone(): void {
  const index = zones.list.length - 1;
  const zone = zones.list[index];
  appendZone(zone, index);
  addPlaceholder();
  updateZoneHeaderContextMenus(zones.arrangementIndex);
}

function renderControllersForZone(zone: ZoneType, index: number): void {
  renderControllersForZoneInternal(
    zone,
    index,
    actionHandler,
    triggerSave,
    (label: string) => undoHistory.startGesture(JSON.stringify(zones), label),
    () => undoHistory.endGesture(JSON.stringify(zones)),
    (page: number) => showControllerPage(index, page)
  );
  updateValuesForZone(index);
  updateControllerValues(zone, index);
}

/** Shows another controller page of a zone: saved, but not an undo step */
function showControllerPage(index: number, page: number): void {
  const zone = zones.list[index];
  if (!zone || zone.ccPage == page) return;
  zone.ccPage = page;
  renderControllersForZone(zone, index);
  triggerSave();
}

function appendZone(zone: ZoneType, index: number): void {
  DOM.addHTML('#zones', 'beforeend', zoneTemplate.getHTML(zone, index));
  zone.elements.init(index);
  renderMarkersForZone(index);
  renderControllersForZone(zone, index);
  initOutputPortsForZoneInternal(zones, index, updateValuesForAllZones);
  initInputPortsForZoneInternal(zones, index);
  updateValuesForZone(index);
  zone.renderPattern();
  // the range strip's keys are drawn by renderNotes; next frame, once the canvas has its size
  requestAnimationFrame(zone._renderNotesBound);
  const dragHandler = zone._$('.dragzone') as HTMLElement;
  dragHandler.addEventListener('mousedown', (ev) => {
    if (zones.list.length > 1) {
      undoHistory.beforeAction(JSON.stringify(zones), labelForZone(zone, index, 'Reorder'));
      new DragZone(
        zones,
        index,
        ev,
        () => {
          triggerSave();
          renderZones();
          followTrack(zone);
          zone.elements.zoneElement!.scrollIntoView({
            behavior: 'instant',
            block: isTrackView() ? 'nearest' : 'start'
          } as ScrollIntoViewOptions);
        },
        isTrackView()
      );
    }
  });

  DOM.all(`#zone${index} *[data-action]`).forEach((e) => {
    e.addEventListener('click', actionHandler as EventListener);
  });
  DOM.all(`#zone${index} *[data-contextmenu]`).forEach((e) => {
    e.addEventListener('contextmenu', contextHandler as EventListener);
  });
  DOM.all(`#zone${index} *[data-contextclick]`).forEach((e) => {
    e.addEventListener('click', contextHandler as EventListener);
  });
  DOM.all(`#zone${index} *[data-change]`).forEach((e) => {
    e.addEventListener('input', actionHandler as EventListener);
  });
  // Program and bank go out once a value is committed (Enter, leaving the field,
  // an arrow step), not per keystroke: typing 112 would send 1 and 11 first
  DOM.all(`#zone${index} .programsettings input`).forEach((e) => {
    e.addEventListener('change', (ev) => actionHandler(ev as MouseEvent, `${index}:filters_sendprogram`));
  });
  DOM.all(`#zone${index} *[data-focus-change]`).forEach((e) => {
    e.addEventListener('focus', actionHandler as EventListener);
    e.addEventListener('blur', actionHandler as EventListener);
  });

  // MIDI learn for drum lane note inputs
  DOM.all(
    `#zone${index} input[data-change^="${index}:seq_drumlane_note:"]`
  ).forEach((e) => {
    e.addEventListener('focus', (ev) => {
      const laneIndex = parseInt(
        (ev.target as HTMLInputElement).dataset.change?.split(':')[2] || '-1'
      );
      if (laneIndex >= 0) {
        zone.midiLearnDrumLaneIndex = laneIndex;
        (ev.target as HTMLInputElement).classList.add('midi-learn-active');
      }
    });
    e.addEventListener('blur', (ev) => {
      zone.midiLearnDrumLaneIndex = null;
      (ev.target as HTMLInputElement).classList.remove('midi-learn-active');
    });
  });

  let isDragSelect = false;
  function updateDragSelectStyle(): void {
    const grid = zone.sequence.isDrumSequence
      ? zone._$('.seq .drum-step-container')
      : zone._$('.seq .step-container');
    if (isDragSelect) {
      grid?.classList.add('dragselect');
    } else {
      grid?.classList.remove('dragselect');
    }
  }
  DOM.on(`#zone${index} .step-info`, 'mouseup', (ev) => {
    ev.stopPropagation();
  });
  DOM.on(`#zone${index} .seqtools`, 'mouseup', (ev) => {
    ev.stopPropagation();
  });
  DOM.on(zone.elements.sequencerElement!, 'mouseup', (ev) => {
    if ((ev as MouseEvent).button != 0) return;
    if (!isDragSelect) {
      zone.sequence.clearSelection();
      updateValuesForZone(index);
    }
    isDragSelect = false;
    updateDragSelectStyle();
  });
  DOM.on(zone.elements.sequencerElement!, 'mouseleave', () => {
    isDragSelect = false;
    updateDragSelectStyle();
  });
  DOM.all(`#zone${index} *[data-dragselect]`).forEach((e) => {
    const stepnumber = parseInt((e as HTMLElement).dataset.dragselect!);
    e.addEventListener('mousedown', (ev) => {
      if ((ev as MouseEvent).button != 0) return;
      if (zone.sequence.selectedStepNumbers.has(stepnumber)) {
        isDragSelect = false;
        zone.sequence.clearSelection();
      } else {
        isDragSelect = true;
        if (zone.sequence.hasSelection && (ev as MouseEvent).shiftKey) {
          zone.sequence.selectedStepNumbers.add(stepnumber);
        } else {
          zone.sequence.clearSelection();
          zone.sequence.selectedStepNumber = stepnumber;
        }
      }
      updateDragSelectStyle();
      updateValuesForZone(index);
    });
    e.addEventListener('mouseenter', (ev) => {
      if (isDragSelect) {
        if (zone.sequence.isStepUsed(stepnumber)) {
          zone.sequence.selectedStepNumbers.add(stepnumber);
          updateValuesForZone(index);
        }
      }
    });
  });
  // Arp pattern: press on a cell sets or clears it, dragging paints the same value
  // over further cells; one stroke is one undo step.
  const patternEl = zone.elements.patternElement;
  if (patternEl) {
    let paintValue: boolean | null = null;
    const paint = (target: EventTarget | null): void => {
      const cell = (target as HTMLElement | null)?.closest('.pattern > i');
      if (!cell || paintValue === null) return;
      const i = Array.prototype.indexOf.call(patternEl.children, cell);
      if (zone.arp_pattern[i] === paintValue) return;
      zone.arp_pattern[i] = paintValue;
      zone.syncEuclidToPattern();
      zone.renderPattern();
    };
    const endStroke = (): void => {
      if (paintValue === null) return;
      paintValue = null;
      undoHistory.endGesture(JSON.stringify(zones));
      triggerSave();
    };
    patternEl.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const cell = (ev.target as HTMLElement).closest('.pattern > i');
      if (!cell) return;
      undoHistory.startGesture(JSON.stringify(zones), describeAction(`${index}:zone_arp_pattern`, zones));
      paintValue = !zone.arp_pattern[Array.prototype.indexOf.call(patternEl.children, cell)];
      paint(cell);
    });
    patternEl.addEventListener('mouseover', (ev) => paint(ev.target));
    patternEl.addEventListener('mouseup', endStroke);
    patternEl.addEventListener('mouseleave', endStroke);
  }
  // Arp transpose amount: drag up/down or scroll for -12..+12 semitones, double-click for 0
  const transposeEl = zone._$('.arp_transpose_value') as HTMLElement | null;
  if (transposeEl) {
    const STEP14 = 16383 / 24; // pot drag range 0..16383 mapped to 25 semitone values
    const setAmount = (amount: number): void => {
      zone.arp_transpose_amount = Math.max(-12, Math.min(12, amount));
      zone.renderNotes();
    };
    const commitAmount = (label: string, change: () => void): void => {
      undoHistory.beforeAction(JSON.stringify(zones), labelForZone(zone, index, label));
      change();
      triggerSave();
    };
    transposeEl.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      undoHistory.startGesture(JSON.stringify(zones), labelForZone(zone, index, 'Arp Transpose'));
      potDragHandler.startDrag(
        ev,
        (zone.arp_transpose_amount + 12) * STEP14,
        (v14) => setAmount(Math.round(v14 / STEP14) - 12),
        () => {
          undoHistory.endGesture(JSON.stringify(zones));
          triggerSave();
        }
      );
    });
    transposeEl.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (ev.deltaY === 0) return;
      commitAmount('Arp Transpose', () => setAmount(zone.arp_transpose_amount - Math.sign(ev.deltaY)));
    });
    transposeEl.addEventListener('dblclick', () => commitAmount('Arp Transpose', () => setAmount(0)));
  }
  DOM.all(`#zone${index} *[data-hover]`).forEach((e) => {
    e.addEventListener('mousemove', hoverHandler as EventListener);
    e.addEventListener('mouseleave', hoverOutHandler as EventListener);
    e.addEventListener('dblclick', dblClickHandler as EventListener);
  });
  DOM.all(
    `#zone${index} input[type="text"],#zone${index} input[type="number"]`
  ).forEach((e) => {
    let inputDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Commit the current typing gesture and restart if the field is still focused.
    // Called after 1s of inactivity, on Enter, and on blur.
    const commitInputGesture = (): void => {
      if (inputDebounceTimer) {
        clearTimeout(inputDebounceTimer);
        inputDebounceTimer = null;
      }
      const currentJSON = JSON.stringify(zones);
      undoHistory.endGesture(currentJSON);
      if (document.activeElement === e) {
        undoHistory.startGesture(currentJSON, describeElementAction(e as HTMLElement));
      }
    };

    e.addEventListener('keyup', function (this: HTMLElement, event) {
      if ((event as KeyboardEvent).key === 'Enter') {
        event.preventDefault();
        this.dispatchEvent(new Event('input'));
        commitInputGesture();
      }
    });
    e.addEventListener('focus', () => {
      (e as HTMLInputElement).select();
      undoHistory.startGesture(JSON.stringify(zones), describeElementAction(e as HTMLElement));
    });
    e.addEventListener('input', () => {
      if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
      inputDebounceTimer = setTimeout(commitInputGesture, 1000);
    });
    e.addEventListener('blur', () => {
      commitInputGesture();
    });
  });
  DOM.all(
    `#zone${index} .pattern, #zone${index} .ch.solo,  #zone${index} .step[data-dblclickaction]`
  ).forEach((e) => {
    e.addEventListener('dblclick', dblClickHandler as EventListener);
  });
  let hideOnLeaveTimeout: ReturnType<typeof setTimeout> | null = null;
  const resetHideOnLeaveTimeout = (): void => {
    if (hideOnLeaveTimeout) {
      clearTimeout(hideOnLeaveTimeout);
    }
  };
  DOM.all(`#zone${index} .hideonleave`).forEach((e) => {
    e.addEventListener('mouseleave', function (this: HTMLElement, ev) {
      if (
        (ev as MouseEvent).relatedTarget &&
        ((ev as MouseEvent).relatedTarget as HTMLElement).classList.contains(
          'preventLeave'
        )
      ) {
        return;
      }
      hideOnLeaveTimeout = setTimeout(() => {
        (this as HTMLElement).style.display = 'none';
        (this as HTMLElement)
          .closest('.drum-lane')
          ?.classList.remove('euc-open');
      }, 667);
    });
    e.addEventListener('mousemove', function () {
      resetHideOnLeaveTimeout();
    });
  });
  numberInputController.addInputElements(
    DOM.all(`#zone${index} input[type=number]`)
  );
}

function renderMarkersForAllZones(): void {
  for (let i = 0; i < zones.list.length; i++) {
    renderMarkersForZone(i);
  }
}

// Returns the left and right canvas x-coordinates of a MIDI note key,
// matching the piano geometry used in Zone.renderNotes() (75 white-key slots).
function noteKeyEdges(note: number, width: number): { left: number; right: number } {
  const notewidth = width / 75;
  const wkIndex = Note.nearestWhiteKeyIndex(note);
  if (Note.isBlackKey(note)) {
    const left = notewidth * (wkIndex + 0.75);
    return { left, right: left + notewidth * 0.5 };
  } else {
    const left = notewidth * (wkIndex + 0.125);
    return { left, right: left + notewidth * 0.75 };
  }
}

function renderMarkersForZone(
  index: number,
  tempLo?: number,
  tempHigh?: number
): void {
  const zone: ZoneType = zones.list[index];
  const low = tempLo != undefined ? tempLo : zone.low;
  const high = tempHigh != undefined ? tempHigh : zone.high;
  const width = zone.elements.rangeContainer!.offsetWidth;
  const lo = noteKeyEdges(low, width);
  const hi = noteKeyEdges(high, width);
  const xclo = noteKeyEdges(zone.low, width);
  const xchi = noteKeyEdges(zone.high, width);
  zone.elements.rangeMarkerLow!.style.left = `${lo.left}px`;
  zone.elements.rangeMarkerHigh!.style.right = `${width - hi.right}px`;
  zone.elements.rangeMarkerLow!.textContent = Note.display(low);
  zone.elements.rangeMarkerHigh!.textContent = Note.display(high);
  zone.elements.rangeJoin!.style.left = `${lo.left}px`;
  zone.elements.rangeJoin!.style.right = `${width - hi.right}px`;
  zone.elements.rangeCurrent!.style.left = `${xclo.left}px`;
  zone.elements.rangeCurrent!.style.right = `${width - xchi.right}px`;
  DOM.switchClass(zone.elements.rangeMarkerLow!, tempLo != undefined, 'hover');
  DOM.switchClass(
    zone.elements.rangeMarkerHigh!,
    tempHigh != undefined,
    'hover'
  );
}

function updateValuesForAllZones(): void {
  for (let i = 0; i < zones.list.length; i++) {
    updateValuesForZone(i);
  }
  updateArrangementMeters();
  onStateChange?.();
}

function updateGeneralButtons(): void {
  let muted = 0,
    held = 0;
  for (let i = 0; i < zones.list.length; i++) {
    muted += zones.list[i].enabled ? 0 : 1;
    held += zones.list[i].arp_hold ? 1 : 0;
  }
  DOM.switchClass(elAllMuteOff, muted > 0, 'active');
  DOM.switchClass(elAllSoloOff, Zone.solocount > 0, 'active');
  DOM.switchClass(elAllHoldOff, held > 0, 'active');
}

/** Range inputs have no native "filled" part in Chromium: expose the value as a percentage for the track gradient. */
function syncRangeFill(el: HTMLInputElement): void {
  const min = parseFloat(el.min || '0');
  const max = parseFloat(el.max || '100');
  const pct = max > min ? ((parseFloat(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
}

function syncRangeFills(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(syncRangeFill);
}

/** Steps covered by the tail of a longer step (length > 1), wrapping at the end. */
function tiedStepIndexes(sequence: SequenceType): Set<number> {
  const tied = new Set<number>();
  sequence.steps.forEach((step, i) => {
    if (!step || step.notesArray.length === 0 || i >= sequence.length) return;
    for (let k = 1; k < Math.min(step.length, sequence.length); k++) {
      tied.add((i + k) % sequence.length);
    }
  });
  return tied;
}

function updateValuesForZone(index: number): void {
  const zone: ZoneType = zones.list[index];
  const sequence = zone.sequence;
  const zoneElement = zone.elements.zoneElement;
  if (zone.elements.isReady && zoneElement) {
    (zoneElement as HTMLElement).dataset['colorindex'] = String(
      zone.colorIndex
    );
    DOM.removeClass(zone.elements.actionElements!, 'selected');
    DOM.switchClass(
      zoneElement,
      Zone.solocount > 0 && !zone.solo,
      'soloed-out'
    );
    DOM.switchClass(zoneElement, !zone.enabled, 'disabled');
    const zoneIsEnabled = zone.enabled && (!foldSoloedOut || Zone.solocount === 0 || zone.solo);
    DOM.switchClass(zoneElement, !zoneIsEnabled, 'disabled');
    DOM.switchClass(zoneElement, zone.show_cc, 'show-cc');

    if (sequence.active) {
      DOM.addClass(zoneElement, 'show-seq');
      DOM.switchClass(zoneElement, sequence.isDrumSequence, 'drumSequencer');
      if (sequence.isDrumSequence) {
        DOM.removeClass(
          zone.elements.sequencerDrumStepElements!,
          'selected-step',
          'activelength'
        );
        (zone.elements.get('.seq_lanes') as HTMLInputElement).value = String(
          sequence.drumLanes
        );
        (
          zone.elements.get('.drum-step-container') as HTMLElement
        )?.style.setProperty('--drum-lanes', String(sequence.drumLanes));
        const drumLaneSoloCount = sequence.getDrumLaneSoloCount();
        for (
          let laneIndex = 0;
          laneIndex < Sequence.MAX_LANES_DRUMS;
          laneIndex++
        ) {
          if (laneIndex >= sequence.drumLanes) {
            zone.elements.get(`.lane${laneIndex}`)!.classList.add('unused');
          } else {
            zone.elements.get(`.lane${laneIndex}`)!.classList.remove('unused');
          }
          const lane = sequence.getDrumLane(laneIndex);
          const isEnabled = lane.enabled;
          const isSoloed = lane.solo;
          const soloCount = drumLaneSoloCount;
          DOM.switchClass(
            zone.elements.get(`.lane${laneIndex}`)!,
            !isEnabled,
            'disabled'
          );
          DOM.switchClass(
            zone.elements.get(`.lane${laneIndex}`)!,
            soloCount > 0 && !isSoloed,
            'soloed-out'
          );
          zone.elements.addSelectedStyle(
            `.lane${laneIndex} .seq_toggle_lane_enabled`,
            isEnabled
          );
          zone.elements.addSelectedStyle(
            `.lane${laneIndex} .seq_toggle_lane_solo`,
            isSoloed
          );
          const numberElement = zone.elements.get(
            `input[data-change="${index}:seq_drumlane_note:${laneIndex}"]`
          ) as HTMLInputElement;
          numberElement.value = String(lane.note);
          numberElement.title = 'The lane plays ' + Note.display(lane.note);
          const laneStepsEl = zone.elements.get(
            `input[data-change="${index}:seq_drum_lane_steps:${laneIndex}"]`
          ) as HTMLInputElement | null;
          if (laneStepsEl)
            laneStepsEl.value = String(lane.length ?? sequence.length);
          const laneLabelEl = zone.elements.get(
            `input[data-change="${index}:seq_drum_lane_label:${laneIndex}"]`
          ) as HTMLInputElement | null;
          if (laneLabelEl) laneLabelEl.value = (lane as any).label ?? '';
          for (
            let stepIndex = 0;
            stepIndex < Sequence.MAX_STEPS_DRUMS;
            stepIndex++
          ) {
            const stepElement =
              zone.elements.sequencerDrumLanes![laneIndex][stepIndex];
            if (
              stepIndex < (lane.length ?? sequence.length) &&
              laneIndex < sequence.drumLanes
            ) {
              DOM.removeClass(stepElement, 'unused');
              const step = lane.steps[stepIndex];
              // A step with locks only is no hit: it shows its lock mark
              DOM.switchClass(stepElement, step != null && step.notesArray.length > 0, 'active');
              showStepProperties(stepElement as HTMLElement, step ?? null);
              if (
                sequence.selectedStepNumbers.has(
                  Sequence.getIdForDrumStep(laneIndex, stepIndex)
                )
              ) {
                DOM.addClass(stepElement, 'selected');
              } else {
                DOM.removeClass(stepElement, 'selected');
              }
            } else {
              DOM.addClass(stepElement, 'unused');
            }
          }
        }
      } else {
        DOM.removeClass(
          zone.elements.sequencerGridStepElements!,
          'selected-step',
          'activelength'
        );
        const tiedSteps = tiedStepIndexes(sequence);
        zone.elements.sequencerGridStepElements!.forEach((stepElement, i) => {
          DOM.switchClass(stepElement, tiedSteps.has(i), 'tied');
          if (i < sequence.length) {
            DOM.removeClass(stepElement, 'unused');
            if (sequence.selectedStepNumbers.has(i)) {
              DOM.addClass(stepElement, 'selected');
            } else {
              DOM.removeClass(stepElement, 'selected');
            }
            const stepData = sequence.steps[i];
            if (
              (stepData && stepData.length > 0 && stepData.notesArray.length > 0) ||
              sequence.liveTargetStepNumber == i
            ) {
              DOM.addClass(stepElement, 'active');
            } else {
              DOM.removeClass(stepElement, 'active');
            }
            showStepProperties(stepElement as HTMLElement, stepData ?? null);
          } else {
            DOM.addClass(stepElement, 'unused');
          }
        });
        DOM.switchClass(zoneElement, sequence.isLiveRecording, 'liveRecording');
      }
      if (sequence.hasSelection) {
        DOM.addClass(zone.elements.sequencerElement!, 'has-selection');
        if (sequence.selectedStepNumbers.size > 1) {
          DOM.addClass(zone.elements.sequencerElement!, 'multi-selection');
        }
        if (sequence.stepAddNotes) {
          zone._$('.seq-step-add-notes')?.classList.add('selected');
        }
        if (sequence.stepAdvance) {
          zone._$('.seq-step-advance')?.classList.add('selected');
        }
        const step = sequence.selectedStep;
        if (step && step.length > 0) {
          zone.elements.setPercentage(
            '.seq_step_probability',
            parseInt(String(step.probability * 100)),
            index
          );
          zone.elements.setPercentage(
            '.seq_gatelength',
            parseInt(String(step.gateLength * 100)),
            index
          );
          zone.elements.setPercentage(
            '.seq_step_velocity',
            // rounded: velocities are whole MIDI values, 76/127 reads back as 60%, not 59%
            Math.round(sequence.velocityMediumSelectedStep() * 100),
            index
          );
          zone.elements.setSelectedIndex('.seq_step_condition', step.condition);
          (zone._$('.seq_step_length') as HTMLInputElement).value = String(
            step.length
          );
          const ratchetCountEl = zone._$(
            '.seq_step_ratchet_count'
          ) as HTMLSelectElement | null;
          if (ratchetCountEl) {
            const countVal = step.ratchetCount ?? 1;
            ratchetCountEl.value = String(countVal);
            const stepControls = ratchetCountEl.closest(
              '.step-controls'
            ) as HTMLElement | null;
            if (stepControls) {
              stepControls.classList.toggle('ratchet-off', countVal <= 1);
            }
          }
          const ratchetDeltaEl = zone._$(
            '.seq_step_ratchet_delta'
          ) as HTMLInputElement | null;
          if (ratchetDeltaEl) {
            const pct = velocityDeltaToPercent(step.ratchetVelocityDelta ?? 0);
            ratchetDeltaEl.value = String(pct);
            const deltaOut = ratchetDeltaEl.parentElement?.querySelector(
              `output[for="${ratchetDeltaEl.id}"]`
            ) as HTMLOutputElement | null;
            if (deltaOut) deltaOut.value = (pct > 0 ? '+' : '') + pct + '%';
          }
          const ratchetResEl = zone._$(
            '.seq_step_ratchet_res'
          ) as HTMLSelectElement | null;
          if (ratchetResEl) {
            ratchetResEl.value = String(ticksToRatchetIndex(step.ratchetResolution ?? 6));
          }
        } else {
          if (sequence.selectedStepNumbers.size == 1) {
            (zone._$('.seq_step_length') as HTMLInputElement).value = '1';
            zone.elements.setSelectedIndex('.seq_step_condition', 0);
            zone.elements.setPercentage('.seq_step_probability', 100, index);
            zone.elements.setPercentage('.seq_gatelength', 100, index);
            const ratchetCountEl2 = zone._$(
              '.seq_step_ratchet_count'
            ) as HTMLSelectElement | null;
            if (ratchetCountEl2) {
              ratchetCountEl2.value = '1';
              (
                ratchetCountEl2.closest('.step-controls') as HTMLElement | null
              )?.classList.add('ratchet-off');
            }
          }
        }
        sequence.selectedStepNumbers.forEach((n) => {
          const selectedIndex = n;
          const step = sequence.steps[selectedIndex];
          if (step && step.length > 0) {
            const length = step.length;
            const overlapLength =
              selectedIndex + length > sequence.length
                ? (selectedIndex + length) % sequence.length
                : -1;
            zone.elements.sequencerGridStepElements!.forEach((e, i) => {
              if (
                (i > selectedIndex && i < selectedIndex + length) ||
                i < overlapLength
              ) {
                DOM.addClass(e, 'activelength');
              }
            });
          }
        });
        sequence.updateRecordingState();
        renderStepLocks(zone, index, actionHandler as (ev: Event, overrideaction?: string) => void);
      } else {
        DOM.removeClass(
          zone.elements.sequencerElement!,
          'has-selection',
          'multi-selection'
        );
      }
      if (!sequence.isDrumSequence) {
        (zone._$('.seq_steps') as HTMLInputElement).value = String(
          sequence.length
        );
      }
      zone.elements.setSelectedIndex('.seq_division', sequence.division);
    } else {
      DOM.removeClass(zoneElement, 'show-seq');
    }
    [
      'cc',
      'mod',
      'at2mod',
      'sustain',
      'fixedvel',
      'pitchbend',
      'enabled',
      'solo',
      'programchange',
      'arp_enabled',
      'arp_hold',
      'arp_transpose',
      'sustain_on',
      'arp_repeat'
    ].forEach((p) => {
      zone.elements.addSelectedStyle('.' + p, (zone as any)[p]);
    });
    [
      'channel',
      'arp_direction',
      'arp_division',
      'arp_octaves',
      'arp_ratchet_count'
    ].forEach((p) => {
      zone.elements.setSelectedIndex('.' + p, (zone as any)[p]);
    });
    [
      'arp_gatelength',
      'arp_probability',
      'arp_strum_taper',
      'arp_ratchet_probability'
    ].forEach((p) => {
      zone.elements.setPercentage(
        '.' + p,
        parseInt(String((zone as any)[p] * 100)),
        index
      );
    });
    DOM.switchClass(zoneElement, zone.arp_enabled, 'arp-enabled');
    DOM.switchClass(zoneElement, zone.arp_direction >= 5, 'strum-mode');
    zone.renderTransposeAmount();

    const swingSliders = zone.elements.get(
      '.swing-amount'
    ) as HTMLInputElement | null;
    if (swingSliders) {
      DOM.all(`#zone${index} .swing-amount`).forEach((el) => {
        (el as HTMLInputElement).value = String(
          Math.round(zone.swingAmount * 100)
        );
        // Update the associated output element
        const output = document.querySelector(
          `output[for="${(el as HTMLInputElement).id}"]`
        ) as HTMLOutputElement;
        if (output) {
          output.value = String(Math.round(zone.swingAmount * 100)) + '%';
        }
      });
    }

    zone.elements.octaveSelectors!.forEach((e) => {
      const parts = e.getAttribute('data-action')!.split(':');
      if (parts[2] == String(zone.octave)) {
        DOM.addClass(e, 'selected');
      }
    });
    zone.elements.setPercentage(
      '.velocity_scaling',
      parseInt(String(zone.velocity_scaling * 100)),
      index
    );
    (zone._$('.euchits') as HTMLInputElement).value = String(zone.euclid_hits);
    (zone._$('.euclen') as HTMLInputElement).value = String(zone.euclid_length);
    (zone._$('input.programnumber') as HTMLInputElement).value = zone.pgm_no
      ? String(zone.pgm_no)
      : '';
    (zone._$('input.bank_msb') as HTMLInputElement).value =
      zone.bank_msb != null ? String(zone.bank_msb) : '';
    (zone._$('input.bank_lsb') as HTMLInputElement).value =
      zone.bank_lsb != null ? String(zone.bank_lsb) : '';
    showThruAndProgram(zone);
    (zone._$('input.fixedvel_value') as HTMLInputElement).value = String(
      zone.fixedvel_value
    );
    const nameField = zone._$('.output-config-name') as HTMLInputElement;
    // the port as the selector shows it (long names shortened in the middle); the
    // rename field offers the full name
    const outOption = (zone._$('select.outport') as HTMLSelectElement).selectedOptions[0];
    const shortPortName = outOption?.textContent ?? '';
    if (zones.outputConfigNames[zones.list[index].configId]) {
      nameField.value = zones.outputConfigNames[zones.list[index].configId];
    } else {
      nameField.value = '';
      nameField.placeholder = outOption?.dataset.fullName ?? shortPortName;
    }
    // no port chosen (and no named output config): the zone sends nowhere
    const noOutput = !nameField.value && (!zone.outputPortId || zone.outputPortId === MIDI.INTERNAL_PORT_ID);
    const labelField = zone._$('.zone-label') as HTMLInputElement;
    if (labelField && document.activeElement !== labelField) {
      labelField.value = zone.label || '';
    }
    if (labelField) {
      // minimized view: unnamed zones show their output port / preset instead of "Zone N"
      labelField.dataset.defaultPlaceholder ??= labelField.placeholder;
      const portName = noOutput ? '' : nameField.value || shortPortName;
      labelField.placeholder =
        document.body.classList.contains('minimized') && portName
          ? portName
          : labelField.dataset.defaultPlaceholder;
    }
    zone.elements.addSelectedStyle(
      '.sendClock',
      midiController.clockOutputPorts[zone.outputPortId] === true
    );
    const inportSelect = zone._$('select.inport') as HTMLSelectElement;
    if (inportSelect) {
      inportSelect.value = zone.inputPortId || '';
    }
    const inchannelSelect = zone._$('select.inchannel') as HTMLSelectElement;
    if (inchannelSelect) {
      inchannelSelect.value =
        zone.inputChannel !== null ? String(zone.inputChannel) : '-1';
      // Global input: the channel is set per port in the input window, so there's none here
      inchannelSelect.hidden = !zone.inputPortId;
    }
    const mpeSelect = zone._$('select.mpe') as HTMLSelectElement;
    if (mpeSelect) mpeSelect.value = String(zone.mpe);
    (zone._$('.ior-link') as HTMLElement)?.classList.toggle('off', zone.mpe === MpeMode.OFF);
    // MPE zones get a taller keyboard strip for the keys' dots
    zone.elements.zoneElement?.classList.toggle('mpe-on', zone.mpe !== MpeMode.OFF);
    zone.elements.zoneElement?.querySelectorAll<HTMLElement>('.ior-row-collapse').forEach((row) => {
      row.hidden = zone.mpe !== MpeMode.COLLAPSE;
    });
    zone.elements.zoneElement?.querySelectorAll<HTMLElement>('.ior-row-pass').forEach((row) => {
      row.hidden = zone.mpe !== MpeMode.PASS;
    });
    (['mpe_bend_in', 'mpe_bend_out', 'mpe_pass_bend_out', 'mpe_at_from'] as const).forEach((p) => {
      zone.elements.zoneElement?.querySelectorAll<HTMLInputElement>('.iorouting-popup input.' + p).forEach((field) => {
        if (document.activeElement !== field) field.value = String(zone[p]);
      });
    });
    const polySelect = zone._$('select.mpe_poly_at') as HTMLSelectElement;
    if (polySelect) polySelect.value = zone.mpe_poly_at ? '1' : '0';
    const routingText = zone._$('.iorouting-text') as HTMLElement;
    if (routingText) {
      const portnameEl = routingText.querySelector(
        '.iorouting-portname'
      ) as HTMLElement;
      const chEl = routingText.querySelector('.iorouting-ch') as HTMLElement;
      const isPreset = !!zones.outputConfigNames[zones.list[index].configId];
      const outPortName = noOutput ? 'No output' : nameField.value || shortPortName;
      let portLabel = outPortName;
      if (zone.inputPortId) {
        const inPort = getCachedInputPorts().find(
          (p) => p.id === zone.inputPortId
        );
        const inName = inPort ? inPort.name : '?';
        const chStr =
          zone.inputChannel !== null ? `:${zone.inputChannel + 1}` : '';
        // Its maker's or model's first word is enough to tell the input; the synth must fit
        portLabel = `${inName.split(' ')[0]}${chStr} → ${outPortName}`;
      }
      if (portnameEl) portnameEl.textContent = portLabel;
      routingText.classList.toggle('missing', noOutput || outPortName.startsWith('⚠'));
      let chText = isPreset || noOutput ? '' : `Ch ${zone.channel + 1}`;
      if (zone.mpe === MpeMode.PASS) chText = 'MPE';
      else if (zone.mpe === MpeMode.COLLAPSE) chText = `MPE→${zone.channel + 1}`;
      if (chEl) chEl.textContent = chText;
    }
    updateControllerValues(zone, index);
    updateGeneralButtons();
    syncRangeFills(zoneElement as HTMLElement);
  }
}

function allMuteOff(): void {
  undoHistory.beforeAction(JSON.stringify(zones), 'Unmute All Zones');
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].enabled = true;
  }
  updateValuesForAllZones();
  triggerSave();
}

function allSoloOff(): void {
  undoHistory.beforeAction(JSON.stringify(zones), 'Un-solo All Zones');
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].solo = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

function allHoldOff(): void {
  undoHistory.beforeAction(JSON.stringify(zones), 'Arp Hold Off (All Zones)');
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].arp_hold = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

function toggleZoneMute(index: number): void {
  zoneToggle(index, 'zone_enabled');
}

function toggleZoneSolo(index: number): void {
  zoneToggle(index, 'zone_solo');
}

function toggleSequencerOnZone(index: number): void {
  zoneToggle(index, 'toggle_seq');
}

function updateZoneHeaderContextMenus(currentArrIndex: number): void {
  const others = [0, 1, 2, 3].filter(i => i !== currentArrIndex);
  zones.list.forEach((z, i) => {
    const copyItems = others.map(t => `${i}:zone_arr_copy_to:${t}`).join(',');
    // the header's right-click menu and its ⋯ button show the same entries
    z.elements.zoneElement?.querySelectorAll<HTMLElement>('.channels, .zonemenu').forEach((el) => {
      el.dataset.contextmenu = `${i}:zone_change_color,${i}:zone_export,loopmpe:${i},-,${copyItems},-,${i}:zone_delete`;
    });
  });
}

/**
 * A step selection lasts while you work in that zone's sequencer panel (grid,
 * toolbar, step editor) or its controllers (they set the steps' parameter locks).
 * A press anywhere else, or Escape, ends it. The context menu and the piano roll
 * act on the selection, so presses there keep it.
 */
function initStepDeselection(): void {
  const clearSelections = (keepInside: Element | null): void => {
    zones.list.forEach((zone, i) => {
      if (!zone.sequence.hasSelection) return;
      if (keepInside && zone.elements.sequencerElement?.contains(keepInside)) return;
      if (keepInside?.closest('.ccpots') && zone.elements.zoneElement?.contains(keepInside)) return;
      zone.sequence.clearSelection();
      updateValuesForZone(i);
    });
  };
  // capture phase: controls that stop propagation (pots, velocity bars) still count
  document.addEventListener(
    'mousedown',
    (ev) => {
      const target = ev.target as Element;
      if (target.closest('#contextmenu, #pianoRollOverlay, #ccEditor')) return;
      // The +/− buttons of number fields float outside the zone: count them as their field
      const field = target.closest('.valuebtn') ? numberInputController.elValueBtnAttachedInput : null;
      clearSelections(field ?? target);
    },
    true
  );
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (DOM.get('#pianoRollOverlay')?.classList.contains('open')) return; // closes itself
    const menu = DOM.get('#contextmenu') as HTMLElement | null;
    if (menu && menu.style.display === 'block') {
      window.dispatchEvent(new CustomEvent('closeContextMenu'));
      return;
    }
    // The editor handles its keys itself; this only comes here with the focus outside it
    if (isCCEditorOpen()) {
      closeCCEditor();
      return;
    }
    clearSelections(null);
  });
}

/**
 * Saves the current arrangement of every zone, stops and loads `arrIndex`.
 * Live recording ends with the switch, so say so when it was on.
 */
function switchZonesToArrangement(arrIndex: number): void {
  const recordingZones: string[] = [];
  zones.list.forEach((z, i) => {
    // the toast renders HTML; zone labels come from scene files
    if (z.sequence.isLiveRecording) recordingZones.push(escapeHTML(zonePrefix(z, i)));
    z.saveArrangement(zones.arrangementIndex);
    z.stopped();
    z.loadArrangement(arrIndex);
  });
  zones.arrangementIndex = arrIndex;
  if (recordingZones.length > 0) {
    toast(
      `Stopped live recording on ${recordingZones.join(', ')}: switched to arrangement ${ARRANGEMENT_LETTERS[arrIndex]}`,
      { warning: true }
    );
  }
}

function selectArrangement(arrIndex: number): void {
  const clockRunning = midiController.isClockRunning;
  DOM.removeClass('*[data-select-arrangement]', 'selected', 'pending');
  zones.nextArrangementIndex = arrIndex;
  if (clockRunning) {
    if (zones.arrangementIndex !== arrIndex) {
      DOM.addClass(
        DOM.all('*[data-select-arrangement]')[arrIndex],
        'pending'
      );
    }
  } else {
    switchZonesToArrangement(arrIndex);
    triggerSave();
  }
  updateZoneHeaderContextMenus(zones.arrangementIndex);
  DOM.addClass(
    DOM.all('*[data-select-arrangement]')[zones.arrangementIndex],
    'selected'
  );
  updateValuesForAllZones();
}

function showContextMenuFor(ev: MouseEvent): void {
  contextHandler(ev);
}

function deleteAllZones(): void {
  undoHistory.beforeAction(JSON.stringify(zones), 'Delete All Zones');
  zones.list.forEach((zone) => {
    zone.releasePedal();
    zone.dismiss();
  });
  zones.list.length = 0;
  midiController.updateUsedPorts(listUsedPortsInternal(zones));
  renderZones();
  window.scrollTo({ top: 0 });
  triggerSave();
}

function updateOutputPortsForAllZones(outputs: PortDescriptor[]): Set<string> {
  return updateOutputPortsForAllZonesInternal(
    zones,
    outputs,
    updateValuesForAllZones
  );
}

function updateInputPortsForAllZones(inputs: PortDescriptor[]): void {
  updateInputPortsForAllZonesInternal(zones, inputs);
  updateValuesForAllZones();
}

export {
  initController,
  renderZones,
  showContextMenuFor,
  renderLastZone,
  renderMarkersForAllZones,
  updateOutputPortsForAllZones as updateOutputPortsForAllZone,
  updateInputPortsForAllZones,
  updateControllerValues,
  updateValuesForAllZones,
  updateValuesForZone,
  toggleZoneMute,
  toggleZoneSolo,
  applyPendingToggles,
  hasPendingToggles,
  loopZone,
  landLoops,
  finishLoops,
  setToggleBoundary,
  selectArrangement,
  switchZonesToArrangement,
  toggleSequencerOnZone,
  toast,
  deleteAllZones,
  setStateChangeCallback,
  isFoldSoloedOut,
  setFoldSoloedOut,
  isTrackView,
  setTrackView
};
