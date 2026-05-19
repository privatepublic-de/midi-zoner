import DOM from '../domutils';
import MIDI from '../midi';
import DragZone from '../dragzone';
import * as zoneTemplate from '../zone-template';
import { Zone } from '../zone/zone-class';
import { Sequence } from '../zone/sequence';
import { Note } from '../zone/note';

import { initToast, toast } from './toast';
import { NumberInputController } from './number-input-controller';
import { createActionHandlers } from './actions';
import {
  updateControllerValues,
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

const contextMenuActionLabel: Record<string, string> = {
  seq_copy_step: '<i class="material-icons">content_copy</i> Copy ',
  seq_paste_step: '<i class="material-icons">content_paste</i> Paste steps',
  seq_clear_step: '<i class="material-icons">clear</i> Clear step',
  seq_clear_all:
    '<i class="material-icons">playlist_remove</i> Clear complete sequence',
  seq_copy: '<i class="material-icons">content_copy</i> Copy sequence',
  seq_paste: '<i class="material-icons">content_paste</i> Paste sequence',
  seq_copy_to_layer_0:
    '<i class="material-icons">double_arrow</i> Copy to layer A',
  seq_copy_to_layer_1:
    '<i class="material-icons">double_arrow</i> Copy to layer B',
  seq_copy_to_layer_2:
    '<i class="material-icons">double_arrow</i> Copy to layer C',
  seq_copy_to_layer_3:
    '<i class="material-icons">double_arrow</i> Copy to layer D',
  cc_edit: '<i class="material-icons">edit</i> Edit CC controllers',
  cc_send_all: '<i class="material-icons">double_arrow</i> Send all CC values',
  step_copy_length: 'Step lenght',
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
let triggerSave: () => void = () => {};

interface ControllerInitParams {
  saveData: () => void;
  data: ZonesData;
  midi: MIDIInstance;
}

function initController({ saveData, data, midi }: ControllerInitParams): void {
  initToast();
  triggerSave = saveData;
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
    selectSequencerLayer(zones.list[0]?.sequence.activeLayerIndex ?? 0);
  }) as EventListener);
  numberInputController = new NumberInputController();
  numberInputController.addInputElements(
    DOM.all(`#midisettings input[type=number]`)
  );
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
  const params = actionString!.split(':');
  const zoneindex = parseInt(params[0]);
  const action = params[1];
  const actionProperty = action.substring(action.indexOf('_') + 1);
  const actionParam1 = params[2];
  const actionParam2 = params[3];
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
    element.title = inputElement.value + '%';
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
    triggerSave,
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
    selectSequencerLayer
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

function contextHandler(ev: MouseEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  const element = ev.currentTarget as HTMLElement;
  const menuSpecification = element.getAttribute('data-contextmenu')!;
  const menuActions = menuSpecification.split(',');
  const contextMenuElement = DOM.get('#contextmenu') as HTMLElement;

  DOM.empty(contextMenuElement);

  function isEnabled(parts: string[]): boolean {
    const zoneindex = parseInt(parts[0]);
    const zone: ZoneType = zones.list[zoneindex];
    switch (parts[1]) {
      case 'seq_copy_step':
        return zone.sequence.steps[parseInt(parts[2])] != null;
      case 'seq_paste_step':
        return Zone.seqClipboardStep != null;
      case 'seq_paste':
        return Zone.seqClipboardSequence != null;
      case 'seq_copy_to_layer_0':
        return (zones.list[0]?.sequence.activeLayerIndex ?? 0) !== 0;
      case 'seq_copy_to_layer_1':
        return (zones.list[0]?.sequence.activeLayerIndex ?? 0) !== 1;
      case 'seq_copy_to_layer_2':
        return (zones.list[0]?.sequence.activeLayerIndex ?? 0) !== 2;
      case 'seq_copy_to_layer_3':
        return (zones.list[0]?.sequence.activeLayerIndex ?? 0) !== 3;
    }
    return true;
  }

  function labelString(parts: string[]): string {
    const zoneindex = parseInt(parts[0]);
    const zone: ZoneType = zones.list[zoneindex];
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
    } else if (act.startsWith('label:')) {
      const label = act.substr(6);
      DOM.addHTML(
        contextMenuElement,
        'beforeend',
        `<li class="label">${label}</li>`
      );
    } else {
      const parts = act.split(':');
      const name = labelString(parts);
      const styleClass = isEnabled(parts) ? '' : 'disabled';
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
  contextMenuElement.style.display = 'block';
  const srcRect = element.getBoundingClientRect();
  const menuRect = contextMenuElement.getBoundingClientRect();

  let top = ev.clientY;
  let left = ev.clientX;
  if (left + menuRect.width > window.innerWidth) {
    left = window.innerWidth - menuRect.width;
  }
  if (top + menuRect.height > window.innerHeight) {
    top = window.innerHeight - menuRect.height;
    if (top < srcRect.top && srcRect.width < menuRect.width) {
      left += srcRect.width;
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
  updateValuesForZone(zoneindex);
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
}

function addPlaceholder(): void {
  DOM.all('#zones .zone.addnewzone', (e) => e.remove());
  DOM.addHTML(
    '#zones',
    'beforeend',
    '<div class="zone addnewzone"><a class="action" data-action="0:add_new_zone" title="Add new zone">+ Add zone</a></div>'
  );
  DOM.on('#zones .zone.addnewzone a', 'click', () => {
    (DOM.get('#newzone') as HTMLElement).click();
  });
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
}

function renderControllersForZone(zone: ZoneType, index: number): void {
  renderControllersForZoneInternal(zone, index, actionHandler, triggerSave);
  updateValuesForZone(index);
  updateControllerValues(zone, index);
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
  const sequence = zone.sequence;
  const dragHandler = zone._$('.dragzone') as HTMLElement;
  dragHandler.addEventListener('mousedown', (ev) => {
    if (zones.list.length > 1) {
      new DragZone(zones, index, ev, () => {
        triggerSave();
        renderZones();
        zone.elements.zoneElement!.scrollIntoView({
          behavior: 'instant'
        } as ScrollIntoViewOptions);
      });
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
  DOM.all(`#zone${index} *[data-focus-change]`).forEach((e) => {
    e.addEventListener('focus', actionHandler as EventListener);
    e.addEventListener('blur', actionHandler as EventListener);
  });

  let isDragSelect = false;
  function updateDragSelectStyle(): void {
    const grid = sequence.isDrumSequence
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
  DOM.on(`#zone${index} .seq_transpose`, 'mouseup', (ev) => {
    ev.stopPropagation();
  });
  DOM.on(zone.elements.sequencerElement!, 'mouseup', (ev) => {
    if ((ev as MouseEvent).button != 0) return;
    if (!isDragSelect) {
      sequence.clearSelection();
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
      if (sequence.selectedStepNumbers.has(stepnumber)) {
        isDragSelect = false;
        sequence.clearSelection();
      } else {
        isDragSelect = true;
        if (sequence.hasSelection && (ev as MouseEvent).shiftKey) {
          sequence.selectedStepNumbers.add(stepnumber);
        } else {
          sequence.clearSelection();
          sequence.selectedStepNumber = stepnumber;
        }
      }
      updateDragSelectStyle();
      updateValuesForZone(index);
    });
    e.addEventListener('mouseenter', (ev) => {
      if (isDragSelect) {
        if (sequence.isStepUsed(stepnumber)) {
          sequence.selectedStepNumbers.add(stepnumber);
          updateValuesForZone(index);
        }
      }
    });
  });
  DOM.all(`#zone${index} *[data-hover]`).forEach((e) => {
    e.addEventListener('mousemove', hoverHandler as EventListener);
    e.addEventListener('mouseleave', hoverOutHandler as EventListener);
    e.addEventListener('dblclick', dblClickHandler as EventListener);
  });
  DOM.all(`input[type="text"],input[type="number"]`).forEach((e) => {
    e.addEventListener('keyup', function (this: HTMLElement, event) {
      if ((event as KeyboardEvent).keyCode === 13) {
        event.preventDefault();
        this.dispatchEvent(new Event('input'));
      }
    });
    e.addEventListener('focus', () => {
      (e as HTMLInputElement).select();
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

function renderMarkersForZone(
  index: number,
  tempLo?: number,
  tempHigh?: number
): void {
  const zone: ZoneType = zones.list[index];
  const low = tempLo != undefined ? tempLo : zone.low;
  const high = tempHigh != undefined ? tempHigh : zone.high;
  const xlow = low / 127.0;
  const xhi = high / 127.0;
  const xclow = zone.low / 127.0;
  const xchi = zone.high / 127.0;
  const width = zone.elements.rangeContainer!.offsetWidth;
  const xpad = (0.75 / 127.0) * width;
  zone.elements.rangeMarkerLow!.style.left = `${xlow * width}px`;
  zone.elements.rangeMarkerHigh!.style.right = `${
    width - xhi * width - xpad
  }px`;
  zone.elements.rangeMarkerLow!.innerHTML =
    MIDI.NOTENAMES[low % 12] + (parseInt(String(low / 12)) - 1);
  zone.elements.rangeMarkerHigh!.innerHTML =
    MIDI.NOTENAMES[high % 12] + (parseInt(String(high / 12)) - 1);
  zone.elements.rangeJoin!.style.left = `${xlow * width}px`;
  zone.elements.rangeJoin!.style.right = `${width - xhi * width - xpad}px`;
  zone.elements.rangeCurrent!.style.left = `${xclow * width}px`;
  zone.elements.rangeCurrent!.style.right = `${width - xchi * width - xpad}px`;
  let ocount = 0;
  zone.elements.rangeOctaveElements!.forEach((e) => {
    ocount++;
    (e as HTMLElement).style.left = `${((ocount * 12.0) / 127.0) * width}px`;
    e.innerHTML = String(ocount - 1);
  });
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
    zone.elements.sequencerProgressElement!.style.backgroundSize = `${
      100 / sequence.length
    }% 100%`;
    zone.elements.sequencerProgressElementInner!.style.width = `${
      100 / sequence.length
    }%`;

    DOM.switchClass(zoneElement, !zone.enabled, 'disabled');
    const zoneIsEnabled = zone.enabled && (Zone.solocount === 0 || zone.solo);
    DOM.switchClass(zoneElement, !zoneIsEnabled, 'disabled');
    DOM.switchClass(zoneElement, zone.show_cc, 'show-cc');

    if (sequence.active) {
      DOM.addClass(zoneElement, 'show-seq');
      DOM.hide(zone.elements.sequencerProgressElement!);
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
          const isEnabled = sequence.getDrumLane(laneIndex).enabled;
          if (isEnabled) {
            zone.elements
              .get(`.lane${laneIndex}`)!
              .classList.remove('disabled');
          } else {
            zone.elements.get(`.lane${laneIndex}`)!.classList.add('disabled');
          }
          zone.elements.addSelectedStyle(
            `.lane${laneIndex} .seq_toggle_lane_enabled`,
            isEnabled
          );
          const numberElement = zone.elements.get(
            `input[data-change="${index}:seq_drumlane_note:${laneIndex}"]`
          ) as HTMLInputElement;
          numberElement.value = String(sequence.getDrumLane(laneIndex).note);
          numberElement.title =
            'Trigger note: ' +
            Note.display(sequence.getDrumLane(laneIndex).note);
          for (
            let stepIndex = 0;
            stepIndex < Sequence.MAX_STEPS_DRUMS;
            stepIndex++
          ) {
            const stepElement =
              zone.elements.sequencerDrumLanes![laneIndex][stepIndex];
            if (stepIndex < sequence.length && laneIndex < sequence.drumLanes) {
              DOM.removeClass(stepElement, 'unused');
              if (sequence.hasDrumStep(laneIndex, stepIndex)) {
                DOM.addClass(stepElement, 'active');
              } else {
                DOM.removeClass(stepElement, 'active');
              }
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
        zone.elements.sequencerGridStepElements!.forEach((stepElement, i) => {
          if (i < sequence.length) {
            DOM.removeClass(stepElement, 'unused');
            if (sequence.selectedStepNumbers.has(i)) {
              DOM.addClass(stepElement, 'selected');
            } else {
              DOM.removeClass(stepElement, 'selected');
            }
            if (
              (sequence.steps[i] && sequence.steps[i].length > 0) ||
              sequence.liveTargetStepNumber == i
            ) {
              DOM.addClass(stepElement, 'active');
            } else {
              DOM.removeClass(stepElement, 'active');
            }
          } else {
            DOM.addClass(stepElement, 'unused');
          }
        });
        DOM.switchClass(zoneElement, sequence.isLiveRecoding, 'liveRecording');
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
            parseInt(String(sequence.velocityMediumSelectedStep() * 100)),
            index
          );
          zone.elements.setSelectedIndex('.seq_step_condition', step.condition);
          (zone._$('.seq_step_length') as HTMLInputElement).value = String(
            step.length
          );
        } else {
          if (sequence.selectedStepNumbers.size == 1) {
            (zone._$('.seq_step_length') as HTMLInputElement).value = '1';
            zone.elements.setSelectedIndex('.seq_step_condition', 0);
            zone.elements.setPercentage('.seq_step_probability', 100, index);
            zone.elements.setPercentage('.seq_gatelength', 100, index);
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
      } else {
        DOM.removeClass(
          zone.elements.sequencerElement!,
          'has-selection',
          'multi-selection'
        );
      }
      (zone._$('.seq_steps') as HTMLInputElement).value = String(
        sequence.length
      );
      zone.elements.setSelectedIndex('.seq_division', sequence.division);
    } else {
      DOM.removeClass(zoneElement, 'show-seq');
      if (sequence.steps.length > 0) {
        DOM.show(zone.elements.sequencerProgressElement!);
      } else {
        DOM.hide(zone.elements.sequencerProgressElement!);
      }
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
    ['channel', 'arp_direction', 'arp_division', 'arp_octaves'].forEach((p) => {
      zone.elements.setSelectedIndex('.' + p, (zone as any)[p]);
    });
    ['arp_gatelength', 'arp_probability'].forEach((p) => {
      zone.elements.setPercentage(
        '.' + p,
        parseInt(String((zone as any)[p] * 100)),
        index
      );
    });
    DOM.switchClass(zoneElement, zone.arp_enabled, 'arp-enabled');
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
    (zone._$('input.fixedvel_value') as HTMLInputElement).value = String(
      zone.fixedvel_value
    );
    const nameField = zone._$('.output-config-name') as HTMLInputElement;
    if (zones.outputConfigNames[zones.list[index].configId]) {
      nameField.value = zones.outputConfigNames[zones.list[index].configId];
    } else {
      nameField.value = '';
      nameField.placeholder = (
        zone._$('select.outport') as HTMLSelectElement
      ).selectedOptions[0].innerHTML;
    }
    const labelField = zone._$('.zone-label') as HTMLInputElement;
    if (labelField && document.activeElement !== labelField) {
      labelField.value = zone.label || '';
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
    }
    const routingText = zone._$('.iorouting-text') as HTMLElement;
    if (routingText) {
      const isPreset = !!zones.outputConfigNames[zones.list[index].configId];
      const outPortName = nameField.value || nameField.placeholder || '';
      const outStr = isPreset
        ? `${outPortName.substring(0, 18)}`
        : `${outPortName.substring(0, 14)} (Ch${zone.channel + 1})`;
      let display = outStr;
      if (zone.inputPortId) {
        const inPort = getCachedInputPorts().find(
          (p) => p.id === zone.inputPortId
        );
        const inName = inPort ? inPort.name.substring(0, 10) : '?';
        const chStr =
          zone.inputChannel !== null ? `:${zone.inputChannel + 1}` : '';
        display = `${inName}${chStr} → ${outStr}`;
      }
      routingText.textContent = display;
    }
    updateControllerValues(zone, index);
    updateGeneralButtons();
  }
}

function allMuteOff(): void {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].enabled = true;
  }
  updateValuesForAllZones();
  triggerSave();
}

function allSoloOff(): void {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].solo = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

function allHoldOff(): void {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].arp_hold = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

function soloZone(index: number): void {
  const zone = zones.list[index];
  if (zone) {
    if (!zone.solo) {
      if (index < zones.list.length) {
        for (var i = 0; i < zones.list.length; i++) {
          zones.list[i].solo = false;
        }
        zone.solo = true;
        zone.enabled = true;
      }
    } else {
      zone.solo = false;
    }
    updateValuesForAllZones();
    triggerSave();
  }
}

function toggleZoneMute(index: number): void {
  const zone = zones.list[index];
  if (zone) {
    zone.enabled = !zone.enabled;
    updateValuesForAllZones();
    triggerSave();
  }
}

function toggleSequencerOnZone(index: number): void {
  const zone = zones.list[index];
  if (zone) {
    zone.sequence.active = !zone.sequence.active;
    updateValuesForAllZones();
    triggerSave();
  }
}

function selectSequencerLayer(layerIndex: number): void {
  const clockRunning = midiController.isClockRunning;
  DOM.removeClass('#tools *[data-select-seq-layer]', 'selected', 'pending');
  zones.list.forEach((z) => (z.sequence.nextLayerIndex = layerIndex));
  const currentActiveLayer =
    zones.list[0]?.sequence.activeLayerIndex ?? layerIndex;
  if (clockRunning) {
    if (currentActiveLayer !== layerIndex) {
      DOM.addClass(
        DOM.all('#tools *[data-select-seq-layer]')[layerIndex],
        'pending'
      );
    }
  } else {
    zones.list.forEach((z) => {
      z.sequence.activeLayerIndex = layerIndex;
      z.sequence.nextLayerIndex = layerIndex;
    });
  }
  DOM.addClass(
    DOM.all('#tools *[data-select-seq-layer]')[
      zones.list[0]?.sequence.activeLayerIndex ?? layerIndex
    ],
    'selected'
  );
  updateValuesForAllZones();
}

function deleteAllZones(): void {
  zones.list.forEach((zone) => {
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
  renderLastZone,
  renderMarkersForAllZones,
  updateOutputPortsForAllZones as updateOutputPortsForAllZone,
  updateInputPortsForAllZones,
  updateControllerValues,
  updateValuesForAllZones,
  soloZone,
  toggleZoneMute,
  allSoloOff,
  selectSequencerLayer,
  toggleSequencerOnZone,
  toast,
  deleteAllZones
};
