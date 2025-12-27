import DOM = require('./domutils');
import MIDI = require('./midi');
import DragZone = require('./dragzone');
import zoneTemplate = require('./zone-template');
import potDragHandler = require('./potdraghandler');
import { Zone } from './zone/zone-class';
import { Sequence } from './zone/sequence';
import { Note } from './zone/note';
const { ipcRenderer } = require('electron');

// Type alias for the Zone class type
type ZoneType = Zone;
type SequenceType = Sequence;

interface ZonesData {
  list: ZoneType[];
  outputConfigNames: Record<string, string>;
  clockOutputPorts: Record<string, boolean>;
}

interface ControllerInitParams {
  saveData: () => void;
  data: ZonesData;
  midi: InstanceType<typeof MIDI>;
}

interface ToastProperties {
  longer?: boolean;
  warning?: boolean;
}

interface TouchedNoteResult {
  isLow: boolean;
  low: number | null;
  high: number | null;
}

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
  send_all_cc: '<i class="material-icons">double_arrow</i> Send all CC values',
  step_copy_length: 'Step lenght',
  step_copy_gate: 'Gate length',
  step_copy_condition: 'Condition',
  step_copy_chance: 'Chance'
};

let zones: ZonesData = {} as ZonesData;
let midiController: InstanceType<typeof MIDI>;
let elAllMuteOff: HTMLElement;
let elAllSoloOff: HTMLElement;
let elAllHoldOff: HTMLElement;
let numberInputController: NumberInputController;

let triggerSave: () => void = () => {};
let toastElement: HTMLElement;

/**
 * Init view controller with references to data and MIDI controller.
 */
function initController({ saveData, data, midi }: ControllerInitParams): void {
  toastElement = DOM.get('#toast') as HTMLElement;
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
    selectSequencerLayer(Sequence.ACTIVE_LAYER_INDEX);
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
    String(((ev.clientX - DOM.clientOffsets(e).offsetLeft) / e.offsetWidth) * 128)
  );
  const isLow =
    zone.lastTouchedRangePoint === 1 ||
    (zone.lastTouchedRangePoint === 0 &&
      Math.abs(num - zone.low) < Math.abs(num - zone.high));
  if (zone.lastTouchedRangePoint === 0) {
    zone.lastTouchedRangePoint = isLow ? 1 : 2;
  }
  if (ev.shiftKey) {
    // constrain to octaves
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
    (zone as any)[actionProperty] = (element as HTMLSelectElement).selectedIndex;
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
  const actions: Record<string, () => void> = {
    // zone actions -----------------------------------------
    zone_enabled: () => {
      zone.enabled = !zone.enabled;
      if (zone.solo && !zone.enabled) {
        zone.solo = false;
        updateValuesForAllZones();
      } else {
        updateValuesForZone(zoneindex);
      }
      if (!zone.enabled && sequence.active) {
        sequence.clearSelection();
        sequence.isLiveRecoding = false;
        updateValuesForZone(zoneindex);
      }
    },
    zone_solo: () => {
      zone.solo = !zone.solo;
      if (zone.solo) {
        zone.enabled = true;
      }
      updateValuesForAllZones();
    },
    zone_delete: async () => {
      const number = zoneindex + 1;
      await ipcRenderer
        .invoke(
          'open-confirm',
          'Delete zone #' + number,
          'Do you really want to delete zone number ' + number + '?'
        )
        .then((result: boolean) => {
          if (result == true) {
            const scrollPos = window.scrollY;
            zone.dismiss();
            zones.list.splice(zoneindex, 1);
            midiController.updateUsedPorts(listUsedPorts());
            renderZones();
            triggerSave();
            window.scrollTo({ top: scrollPos });
          }
        });
    },
    zone_change_color: () => {
      zone.randomizeColor();
      updateValuesForZone(zoneindex);
    },
    zone_outport: () => {
      const selectElement = element as HTMLSelectElement;
      if (selectElement.value.charAt(0) == '$') {
        const parts = selectElement.value.substr(1).split(',');
        zone.channel = parseInt(parts[1]);
        zone.preferredOutputPortId = zone.outputPortId = parseInt(parts[0]) as any;
        updateOutputPortsForZone(zoneindex, cachedOutputPorts);
        midiController.updateUsedPorts(listUsedPorts());
      } else {
        zone.preferredOutputPortId = zone.outputPortId = selectElement.value;
        updateValuesForZone(zoneindex);
        midiController.updateUsedPorts(listUsedPorts());
      }
    },
    zone_output_config_name: () => {
      const inputElement = element as HTMLInputElement;
      if (inputElement.value == '') {
        delete zones.outputConfigNames[zone.configId];
      } else {
        zones.outputConfigNames[zone.configId] = inputElement.value;
      }
      updateOutputPortsForAllZones(cachedOutputPorts);
      updateValuesForAllZones();
    },
    zone_send_clock: () => {
      let state = !(
        midiController.clockOutputPorts[zone.outputPortId] === true
      );
      midiController.updateClockOutputReceiver(
        zone.outputPortId != MIDI.INTERNAL_PORT_ID
          ? zone.outputPortId
          : zone.preferredOutputPortId,
        state
      );
      zones.clockOutputPorts = midiController.clockOutputPorts;
      updateValuesForAllZones();
    },
    zone_channel: applySelectedIndex,
    zone_range: () => {
      const touchedNote = findTouchedNote(ev, element, zone);
      if (touchedNote.isLow) {
        zone.low = touchedNote.low!;
      } else {
        zone.high = touchedNote.high!;
      }
      renderMarkersForZone(zoneindex);
    },
    zone_octave: () => {
      zone.octave = parseInt(actionParam1);
      updateValuesForZone(zoneindex);
    },
    // filter actions -----------------------------------------
    filters_toggle: () => {
      const settings = zone._$('.popupsettings') as HTMLElement;
      if (settings.style.display == 'flex') {
        settings.style.display = 'none';
      } else {
        settings.style.display = 'flex';
      }
    },
    filters_fixedvel_value: () => {
      zone.fixedvel_value = parseInt((zone._$('input.fixedvel_value') as HTMLInputElement).value);
    },
    filters_fixedvel: () => {
      actions.filters_fixedvel_value();
      applyParamToggle();
    },
    filters_velocity_scaling: applyPercentage,
    filters_cc: applyParamToggle,
    filters_sustain: applyParamToggle,
    filters_sustain_on: applyParamToggle,
    filters_mod: applyParamToggle,
    filters_at2mod: applyParamToggle,
    filters_pitchbend: applyParamToggle,
    filters_programchange: applyParamToggle,
    filters_changeprogram: () => {
      const v = parseInt((element as HTMLInputElement).value);
      if (v > 0 && v < 129) {
        zone.pgm_no = v;
        zone.sendProgramChange();
      }
    },
    // arpeggiator actions -----------------------------------------
    zone_arp_enabled: () => {
      applyParamToggle();
      if (zone.arp_enabled) {
        updateValuesForZone(zoneindex);
        zone.renderPattern();
      }
      zone.renderNotes();
    },
    zone_arp_hold: () => {
      applyParamToggle();
      zone.renderNotes();
    },
    zone_arp_transpose: applyParamToggle,
    zone_arp_repeat: applyParamToggle,
    zone_arp_direction: applySelectedIndex,
    zone_arp_octaves: applySelectedIndex,
    zone_arp_division: applySelectedIndex,
    zone_arp_probability: applyPercentage,
    zone_arp_gatelength: applyPercentage,
    zone_arp_pattern: () => {
      if ((ev.target as HTMLElement).tagName == 'CANVAS') {
        const index = parseInt(
          String((ev.offsetX / element.offsetWidth) * zone.arp_pattern.length)
        );
        zone.arp_pattern[index] = !zone.arp_pattern[index];
        zone.renderPattern();
      }
    },
    zone_arp_showeuclid: () => {
      const dialog = zone._$('.euclid') as HTMLElement;
      if (dialog.style.display == 'block') {
        DOM.hide(dialog);
      } else {
        DOM.show(dialog);
      }
    },
    zone_arp_euclid: () => {
      let hits = parseInt((zone._$('.euchits') as HTMLInputElement).value);
      let len = parseInt((zone._$('.euclen') as HTMLInputElement).value);
      if (!isNaN(hits) && !isNaN(len)) {
        hits = Math.min(32, Math.max(1, hits));
        len = Math.min(32, Math.max(2, len));
        zone.createEuclidianPattern(len, hits);
      }
    },
    zone_arp_pattern_shift: () => {
      if (actionParam1 == '-1') {
        zone.arp_pattern.push(zone.arp_pattern.shift()!);
      } else if (actionParam1 == '1') {
        zone.arp_pattern.unshift(zone.arp_pattern.pop()!);
      }
      zone.renderPattern();
    },
    // cc controller actions -----------------------------------------
    cc_toggle: () => {
      zone.show_cc = !zone.show_cc;
      updateValuesForZone(zoneindex);
      if (zone.show_cc) {
        toast('Right click to edit CC controllers.');
      }
    },
    cc_send_all: () => {
      zone.sendAllCC();
      toast('All CC values sent!');
    },
    cc_edit: () => {
      // TODO rename to toggle
      zone.editCC = !zone.editCC;
      if (actionParam1 != null) {
        zone.selectedCCIndex = parseInt(actionParam1);
      }
      updateControllerValues(zone, zoneindex);
    },
    cc_select: () => {
      if (actionParam1 == '-1' || zone.selectedCCIndex == parseInt(actionParam1)) {
        zone.editCC = false;
        updateControllerValues(zone, zoneindex);
      } else {
        zone.selectedCCIndex = parseInt(actionParam1);
        if (zone.editCC) {
          updateControllerValues(zone, zoneindex);
        }
      }
    },
    cc_label: () => {
      zone.cc_controllers[zone.selectedCCIndex].label = (element as HTMLInputElement).value;
      updateControllerValues(zone, zoneindex);
    },
    cc_number: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number = parseInt(
          inputElement.value
        );
      }
    },
    cc_number_lsb: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_lsb = parseInt(
          inputElement.value
        );
      }
    },
    cc_number_in: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_in = parseInt(
          inputElement.value
        );
      }
    },
    cc_min: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].min = parseInt(inputElement.value);
        updateControllerValues(zone, zoneindex);
      }
    },
    cc_max: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].max = parseInt(inputElement.value);
        updateControllerValues(zone, zoneindex);
      }
    },
    cc_discrete_values: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9,]/, '');
      const discreteValues = inputElement.value
        .split(',')
        .map((v) => (v != '' ? parseInt(v) : v)) as number[];
      zone.cc_controllers[zone.selectedCCIndex].discreteValues = discreteValues;
      updateControllerValues(zone, zoneindex);
    },
    cc_notenum2cc: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].note_cc = parseInt(
          inputElement.value
        );
      } else {
        zone.cc_controllers[zone.selectedCCIndex].note_cc = null;
      }
      updateControllerValues(zone, zoneindex);
    },
    cc_notevelocity2cc: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].velocity_cc = parseInt(
          inputElement.value
        );
      } else {
        zone.cc_controllers[zone.selectedCCIndex].velocity_cc = null;
      }
      updateControllerValues(zone, zoneindex);
    },
    cc_button_label: () => {
      (zone.cc_controllers[zone.selectedCCIndex] as any)[`buttonlabel${actionParam1}`] =
        (element as HTMLInputElement).value;
      updateControllerValues(zone, zoneindex);
    },
    cc_button_value: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        (zone.cc_controllers[zone.selectedCCIndex] as any)[
          `buttonvalue${actionParam1}`
        ] = parseInt(inputElement.value);
        updateControllerValues(zone, zoneindex);
      }
    },
    cc_button_trig: () => {
      const ccindex = parseInt(actionParam1);
      const btnindex = actionParam2;
      zone.cc_controllers[ccindex].val =
        (zone.cc_controllers[ccindex] as any)[`buttonvalue${btnindex}`];
      zone.sendCC(ccindex);
      updateControllerValues(zone, zoneindex);
    },
    cc_add: () => {
      zone.cc_controllers.splice(zone.selectedCCIndex + 1, 0, {
        number: 1,
        number_in: null,
        min: 0,
        max: 127,
        type:
          zone.selectedCCIndex > -1
            ? zone.cc_controllers[zone.selectedCCIndex].type
            : 0,
        label: `Ctrl #${zone.selectedCCIndex + 1}`,
        val: 0,
        note_cc: null,
        velocity_cc: null
      } as any);
      zone.selectedCCIndex++;
      renderControllersForZone(zone, zoneindex);
    },
    cc_remove: async () => {
      let description =
        '#' +
        (zone.selectedCCIndex + 1) +
        ' "' +
        zone.cc_controllers[zone.selectedCCIndex].label +
        '"';
      await ipcRenderer
        .invoke(
          'open-confirm',
          'CC' + description,
          'Do you really want to delete controller ' + description + '?'
        )
        .then((result: boolean) => {
          if (result == true) {
            zone.cc_controllers.splice(zone.selectedCCIndex, 1);
            zone.selectedCCIndex--;
            renderControllersForZone(zone, zoneindex);
          }
        });
    },
    cc_change_type: () => {
      zone.cc_controllers[zone.selectedCCIndex].type = parseInt((element as HTMLSelectElement).value);
      renderControllersForZone(zone, zoneindex);
      updateControllerValues(zone, zoneindex);
    },
    cc_change_group: () => {
      zone.cc_controllers[zone.selectedCCIndex].group = (element as HTMLSelectElement).selectedIndex;
      renderControllersForZone(zone, zoneindex);
      updateControllerValues(zone, zoneindex);
    },
    _cc_move: (direction?: number) => {
      const dir = direction !== undefined ? direction : parseInt(actionParam1);
      const pos = zone.selectedCCIndex;
      let targetPos = pos;
      if (dir < 0) {
        if (pos > 0) {
          targetPos = pos - (ev.shiftKey ? 4 : 1);
          if (targetPos < 0) {
            targetPos = 0;
          }
        }
      } else {
        if (pos < zone.cc_controllers.length - 1) {
          targetPos = pos + (ev.shiftKey ? 4 : 1);
          if (targetPos >= zone.cc_controllers.length) {
            targetPos = zone.cc_controllers.length - 1;
          }
        }
      }
      if (pos != targetPos) {
        const v2 = zone.cc_controllers[targetPos];
        zone.cc_controllers[targetPos] = zone.cc_controllers[pos];
        zone.cc_controllers[pos] = v2;
        zone.selectedCCIndex = targetPos;
        renderControllersForZone(zone, zoneindex);
      }
    },
    cc_left: () => {
      (actions._cc_move as any)(-1);
    },
    cc_right: () => {
      (actions._cc_move as any)(1);
    },
    // sequencer actions -----------------------------------------
    toggle_seq: () => {
      sequence.active = !sequence.active;
      sequence.clearSelection();
      if (sequence.active) {
        zone.renderNotes();
      } else {
        sequence.isLiveRecoding = false;
      }
      updateValuesForZone(zoneindex);
    },
    seq_division: () => {
      sequence.division = (element as HTMLSelectElement).selectedIndex;
      updateValuesForZone(zoneindex);
    },
    seq_steps: () => {
      const v = parseInt((element as HTMLInputElement).value);
      sequence.length = v;
      updateValuesForZone(zoneindex);
    },
    seq_drum_lanes: () => {
      sequence.drumLanes = parseInt((element as HTMLInputElement).value);
      updateValuesForZone(zoneindex);
    },
    seq_drumlane_note: () => {
      const laneNo = parseInt(actionParam1);
      sequence.getDrumLane(laneNo).note = parseInt((element as HTMLInputElement).value);
      console.log(sequence.getDrumLane(laneNo));
      updateValuesForZone(zoneindex);
    },
    seq_drumstep_select: () => {
      if (ev.shiftKey) {
        actions.seq_clear_step();
      } else {
        sequence.turnOnDrumStep(
          ...Sequence.getLaneAndStepIndexForDrumStepId(parseInt(actionParam1))
        );
      }
      updateValuesForZone(zoneindex);
    },
    seq_toggle_lane_enabled: () => {
      const dl = sequence.getDrumLane(parseInt(actionParam1));
      dl.enabled = !dl.enabled;
      updateValuesForZone(zoneindex);
    },
    seq_step_length: () => {
      const v = parseInt((element as HTMLInputElement).value);
      sequence.selectedStepNumbers.forEach((n) => {
        if (sequence.steps[n]) sequence.steps[n].length = v;
      });
      updateValuesForZone(zoneindex);
    },
    seq_clear_all: () => {
      if (sequence.isDrumSequence) {
        for (let i = 0; i < Sequence.MAX_LANES_DRUMS; i++) {
          const lane = sequence.getDrumLane(i);
          lane.steps.length = 0;
        }
        updateValuesForZone(zoneindex);
        sequence.selectedStepNumber = sequence.selectedStepNumber;
        toast('Drum sequence lanes cleared');
      } else {
        sequence.steps.length = 0;
        updateValuesForZone(zoneindex);
        sequence.selectedStepNumber = sequence.selectedStepNumber;
        toast('Sequence cleared');
      }
    },
    seq_transpose: () => {
      const selectElement = element as HTMLSelectElement;
      const semitones = parseInt(selectElement.options[selectElement.selectedIndex].value);
      sequence.transpose(semitones);
      toast(
        (sequence.hasSelection ? 'Selected steps' : 'Sequence') +
          ' transposed by ' +
          semitones +
          ' semitones'
      );
      selectElement.selectedIndex = 0;
      updateValuesForZone(zoneindex);
    },
    seq_adjust: () => {
      const selectElement = element as HTMLSelectElement;
      const adjustment = selectElement.options[selectElement.selectedIndex].value;
      let seq = sequence;
      let srcLength = seq.length;
      let steps: any[] = [];
      for (let i = 0; i < srcLength; i++) {
        steps[i] = seq.steps[i];
      }
      let stepsCopy = JSON.parse(JSON.stringify(steps));
      switch (adjustment) {
        case 'double':
          seq.length = seq.length * 2;
          for (let i = 0; i < srcLength; i++) {
            seq.steps[srcLength + i] = stepsCopy[i];
          }
          updateValuesForZone(zoneindex);
          toast('Sequence doubled');
          break;
        case 'halftime':
          seq.length = seq.length * 2;
          for (let i = 0; i < srcLength; i++) {
            seq.steps[i * 2] = stepsCopy[i];
            if (seq.steps[i * 2]) {
              seq.steps[i * 2].length = seq.steps[i * 2].length * 2;
            }
            seq.steps[i * 2 + 1] = null;
          }
          updateValuesForZone(zoneindex);
          toast('Sequence made half time slower');
          break;
        case 'thirdtime':
          seq.length = seq.length * 3;
          for (let i = 0; i < srcLength; i++) {
            seq.steps[i * 3] = stepsCopy[i];
            if (seq.steps[i * 3]) {
              seq.steps[i * 3].length = seq.steps[i * 3].length * 3;
            }
            seq.steps[i * 3 + 1] = seq.steps[i * 3 + 2] = null;
          }
          updateValuesForZone(zoneindex);
          toast('Sequence made one-third time slower');
          break;
        case 'veloup':
        case 'velodown':
          let factor = adjustment == 'veloup' ? 1 + 1 / 3 : 0.75;
          sequence.steps.forEach((step) => {
            if (step != null) {
              step.notesArray.forEach((note) => {
                const newvelo = note.velo * factor;
                note.velo = Math.max(1, Math.min(127, newvelo));
              });
            }
          });
          toast(
            'All steps changed velocity by ' + parseInt(String(factor * 100)) + '%'
          );
          updateValuesForZone(zoneindex);
          break;
      }
      setTimeout(() => {
        selectElement.selectedIndex = 0;
      }, 100);
    },
    seq_clear_step: () => {
      // clear right clicked or double clicked step
      if (actionParam1 != 'undefined') {
        const stepno = parseInt(actionParam1);
        if (sequence.isDrumSequence) {
          const [laneIndex, stepIndex] =
            Sequence.getLaneAndStepIndexForDrumStepId(stepno);
          sequence.getDrumLane(laneIndex).steps[stepIndex] = null;
        } else {
          if (sequence.selectedStepNumbers.has(stepno)) {
            sequence.selectedStepNumbers.forEach((n) => {
              sequence.steps[n] = null;
            });
          } else {
            sequence.steps[stepno] = null;
          }
        }
        sequence.clearSelection();
        updateValuesForZone(zoneindex);
      }
    },
    seq_clear_selected_step: () => {
      if (sequence.selectedStepNumbers.size > 0) {
        sequence.selectedStepNumbers.forEach((n) => {
          if (sequence.isDrumSequence) {
            const [laneIndex, stepIndex] =
              Sequence.getLaneAndStepIndexForDrumStepId(n);
            sequence.getDrumLane(laneIndex).steps[stepIndex] = null;
          } else {
            sequence.steps[n] = null;
          }
        });
        updateValuesForZone(zoneindex);
      }
    },
    seq_step_probability: () => {
      sequence.selectedStepNumbers.forEach((n) => {
        if (sequence.steps[n] != null) {
          sequence.steps[n].probability = calcAndDisplayPercentage();
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_velocity: () => {
      if (sequence.selectedStep) {
        const velo = calcAndDisplayPercentage() * 127;
        sequence.selectedStep.notesArray.forEach((note) => {
          note.velo = Math.max(1, Math.min(127, velo));
        });
        updateValuesForZone(zoneindex);
      }
    },
    _seq_step_apply_to_all: (actionIndex?: number) => {
      const idx = actionIndex !== undefined ? actionIndex : parseInt(actionParam1);
      if (sequence.selectedStep && idx > 0) {
        let what = '';
        sequence.steps.forEach((s) => {
          if (s) {
            switch (idx) {
              case 1:
                s.length = sequence.selectedStep!.length;
                what = 'step length';
                break;
              case 2:
                s.gateLength = sequence.selectedStep!.gateLength;
                what = 'gate length';
                break;
              case 3:
                s.condition = sequence.selectedStep!.condition;
                what = 'trigger condition';
                break;
              case 4:
                s.probability = sequence.selectedStep!.probability;
                what = 'probability';
                break;
            }
          }
        });
        toast('Applied ' + what + ' to all steps in sequence');
        (element as HTMLSelectElement).selectedIndex = 0;
        updateValuesForZone(zoneindex);
      }
    },
    step_copy_length: () => {
      (actions._seq_step_apply_to_all as any)(1);
    },
    step_copy_gate: () => {
      (actions._seq_step_apply_to_all as any)(2);
    },
    step_copy_condition: () => {
      (actions._seq_step_apply_to_all as any)(3);
    },
    step_copy_chance: () => {
      (actions._seq_step_apply_to_all as any)(4);
    },
    seq_gatelength: () => {
      sequence.selectedSteps.forEach((step) => {
        if (step) {
          step.gateLength = calcAndDisplayPercentage();
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_copy_step: () => {
      if (actionParam1 != 'undefined') {
        const selStepIndex = parseInt(actionParam1);
        const stepsMap = new Map<number, any>();
        if (
          sequence.hasSelection &&
          sequence.selectedStepNumbers.has(selStepIndex)
        ) {
          // selected note is inside step selection
          const sortedIndexes = [...sequence.selectedStepNumbers].sort(
            (a, b) => a - b
          );
          const offset = sortedIndexes[0];
          sortedIndexes.forEach((stepindex) => {
            if (sequence.isStepUsed(stepindex)) {
              stepsMap.set(stepindex - offset, sequence.steps[stepindex]);
            }
          });
        } else {
          // copy single selected step
          if (sequence.isStepUsed(selStepIndex)) {
            stepsMap.set(0, sequence.steps[selStepIndex]);
          }
        }
        Zone.seqClipboardStep = stepsMap;
      }
    },
    seq_paste_step: () => {
      if (actionParam1 != 'undefined' && Zone.seqClipboardStep) {
        sequence.clearSelection();
        const targetStep = parseInt(actionParam1);
        const targetSteps = sequence.steps;
        Array.from(Zone.seqClipboardStep.keys()).forEach((stepindex: number) => {
          targetSteps[(targetStep + stepindex) % sequence.length] =
            Sequence.cloneStep(Zone.seqClipboardStep!.get(stepindex));
        });
        updateValuesForZone(zoneindex);
      } else {
        toast('Nothing to paste, clipboard is empty.');
      }
    },
    seq_step_move: () => {
      if (sequence.hasSelection) {
        const direction = parseInt(actionParam1);
        const newSelection = new Set<number>();
        const sortedNumbers =
          direction < 0
            ? [...sequence.selectedStepNumbers].sort((a, b) => a - b)
            : [...sequence.selectedStepNumbers].sort((a, b) => a - b).reverse();
        sortedNumbers.forEach((stepnumber) => {
          if (sequence.isStepUsed(stepnumber)) {
            let newPos = (stepnumber + direction) % sequence.length;
            if (newPos < 0) {
              newPos = sequence.length - 1;
            }
            if (sequence.isStepEmpty(newPos)) {
              sequence.steps[newPos] = sequence.steps[stepnumber];
              sequence.steps[stepnumber] = null;
              newSelection.add(newPos);
            } else {
              newSelection.add(stepnumber);
            }
          }
        });
        sequence.selectedStepNumbers = newSelection;
        updateValuesForZone(zoneindex);
      }
    },
    seq_move: () => {
      sequence.clearSelection();
      const direction = parseInt(actionParam1);
      const limit = sequence.length;
      const newSeq: any[] = [];
      for (let i = 0; i < Sequence.MAX_STEPS; i++) {
        newSeq[i] = sequence.steps[i];
      }
      const srcOffset = direction > 0 ? limit - 1 : 1;
      for (let i = 0; i < limit; i++) {
        newSeq[i] = sequence.steps[(i + srcOffset) % limit];
      }
      sequence.steps = newSeq;
      updateValuesForZone(zoneindex);
    },
    seq_copy: () => {
      const copyData = {
        steps: sequence.steps,
        length: sequence.length,
        division: sequence.division
      };
      Zone.seqClipboardSequence = JSON.stringify(copyData);
      toast('Sequence copied to clipboard');
    },
    seq_paste: () => {
      if (Zone.seqClipboardSequence) {
        const copyData = JSON.parse(Zone.seqClipboardSequence);
        Object.assign(sequence, copyData);
        updateValuesForZone(zoneindex);
        toast('Sequence pasted from clipboard');
      } else {
        toast('Clipboard is empty, nothing to paste');
      }
    },
    seq_copy_to_layer_0: () => {
      const targetLayer = parseInt(actionParam1);
      const copyData = JSON.parse(
        JSON.stringify({
          steps: sequence.steps,
          length: sequence.length,
          division: sequence.division,
          ticks: sequence.ticks
        })
      );
      Object.assign(sequence.layers[targetLayer], copyData);
      updateValuesForZone(zoneindex);
      toast(
        'Sequence duplicated to layer ' + String.fromCharCode(65 + targetLayer)
      );
    },
    seq_copy_to_layer_1: () => {
      actions.seq_copy_to_layer_0();
    },
    seq_copy_to_layer_2: () => {
      actions.seq_copy_to_layer_0();
    },
    seq_copy_to_layer_3: () => {
      actions.seq_copy_to_layer_0();
    },
    seq_step_condition: () => {
      sequence.selectedSteps.forEach((step) => {
        if (step) {
          step.condition = (element as HTMLSelectElement).selectedIndex;
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_add_notes: () => {
      sequence.stepAddNotes = !sequence.stepAddNotes;
      updateValuesForZone(zoneindex);
    },
    seq_step_advance: () => {
      sequence.stepAdvance = !sequence.stepAdvance;
      updateValuesForZone(zoneindex);
    },
    seq_record_live: () => {
      sequence.clearSelection();
      sequence.isLiveRecoding = !sequence.isLiveRecoding;
      updateValuesForZone(zoneindex);
      toast(
        sequence.isLiveRecoding
          ? 'Live recording enabled!'
          : 'Stopped live recording'
      );
    },
    seq_drum_tracks: () => {
      sequence.clearSelection();
      sequence.isDrumSequence = !sequence.isDrumSequence;
      updateValuesForZone(zoneindex);
      toast(
        sequence.isDrumSequence ? 'Drum sequence mode' : 'Note sequence mode'
      );
    }
  };
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
        return Sequence.ACTIVE_LAYER_INDEX != 0;
      case 'seq_copy_to_layer_1':
        return Sequence.ACTIVE_LAYER_INDEX != 1;
      case 'seq_copy_to_layer_2':
        return Sequence.ACTIVE_LAYER_INDEX != 2;
      case 'seq_copy_to_layer_3':
        return Sequence.ACTIVE_LAYER_INDEX != 3;
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
    case 'range':
      const result = findTouchedNote(ev, e, zone);
      renderMarkersForZone(zoneindex, result.low ?? undefined, result.high ?? undefined);
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
    case 'range':
      zone.high = 127;
      zone.low = 0;
      renderMarkersForZone(zoneindex);
      break;
    case 'arp_pattern':
      zone.arp_pattern.length = 8;
      for (let i = 0; i < zone.arp_pattern.length; i++) {
        zone.arp_pattern[i] = true;
      }
      zone.renderPattern();
      break;
    case 'solo':
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

/**
 * Render all zones completely. #zones element will be cleared first.
 */
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

/**
 * Append and render the last zone in zones list. Call this only after inserting a new zone, not multiple times.
 */
function renderLastZone(): void {
  const index = zones.list.length - 1;
  const zone = zones.list[index];
  appendZone(zone, index);
  addPlaceholder();
}

function appendZone(zone: ZoneType, index: number): void {
  DOM.addHTML('#zones', 'beforeend', zoneTemplate.getHTML(zone, index));
  zone.elements.init(index);
  renderMarkersForZone(index);
  renderControllersForZone(zone, index);
  initOutputPortsForZone(index);
  updateValuesForZone(index);
  zone.renderPattern();
  const sequence = zone.sequence;
  const dragHandler = zone._$('.dragzone') as HTMLElement;
  dragHandler.addEventListener('mousedown', (ev) => {
    if (zones.list.length > 1) {
      new DragZone(index, ev, () => {
        triggerSave();
        renderZones();
        zone.elements.zoneElement!.scrollIntoView({ behavior: 'instant' } as ScrollIntoViewOptions);
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
  // drag select multiple steps
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
    e.addEventListener('keyup', function(this: HTMLElement, event) {
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
        ((ev as MouseEvent).relatedTarget as HTMLElement).classList.contains('preventLeave')
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

/**
 * Render zone markers (lowest and highest note) for all zones.
 */
function renderMarkersForAllZones(): void {
  for (let i = 0; i < zones.list.length; i++) {
    renderMarkersForZone(i);
  }
}

function renderMarkersForZone(index: number, tempLo?: number, tempHigh?: number): void {
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
  zone.elements.rangeMarkerHigh!.style.right = `${width - xhi * width - xpad}px`;
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

function renderControllersForZone(zone: ZoneType, index: number): void {
  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((e) => e.remove());
  DOM.addHTML(
    `#zone${index} .ccpots .container`,
    'afterbegin',
    zoneTemplate.getControllerHTML(zone, index)
  );
  zone.elements.emptyCache();
  const suckEvent = (e: Event): void => {
    e.stopPropagation();
  };
  DOM.on(`#zone${index} .ccpots .cc-editor`, 'click', suckEvent);
  DOM.on(`#zone${index} .ccpots input`, 'keyup', suckEvent);
  DOM.on(`#zone${index} .ccpots input`, 'focus', (e) => {
    (e.target as HTMLInputElement).select();
  });

  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((pot, ix) => {
    const is14bit =
      zone.cc_controllers[ix].type == 5 || zone.cc_controllers[ix].type == 6;
    pot.addEventListener('wheel', (e) => {
      if (
        zone.cc_controllers[ix].type > 1 &&
        zone.cc_controllers[ix].type < 5
      ) {
        return;
      }
      e.preventDefault();
      if (zone.editCC) {
        return;
      }
      const wheelEvent = e as WheelEvent;
      const factor = is14bit ? (wheelEvent.shiftKey ? 1 : 8) : 1;
      const newV = Math.min(
        Math.max(
          parseInt(
            String(zone.cc_controllers[ix].val +
              Math.sign(wheelEvent.deltaY + wheelEvent.deltaX) * factor)
          ),
          0
        ),
        is14bit ? 16383 : 127
      );
      if (newV != zone.cc_controllers[ix].val) {
        if (is14bit) {
          zone.cc_controllers[ix].val = newV;
        } else {
          const discreteValues = zone.cc_controllers[ix].discreteValues;
          if (discreteValues?.length > 0) {
            const nextiX =
              discreteValues.indexOf(zone.cc_controllers[ix].val) +
              (newV < zone.cc_controllers[ix].val ? -1 : 1);
            zone.cc_controllers[ix].val =
              discreteValues[
                nextiX < 0
                  ? 0
                  : nextiX >= discreteValues.length
                  ? discreteValues.length - 1
                  : nextiX
              ];
          } else {
            zone.cc_controllers[ix].val = newV;
          }
        }
        zone.sendCC(ix);
        updateControllerValues(zone, index);
        triggerSave();
      }
    });
    pot.addEventListener('mousedown', (e) => {
      const mouseEvent = e as MouseEvent;
      if (
        (zone.cc_controllers[ix].type > 1 &&
          zone.cc_controllers[ix].type < 5) ||
        zone.editCC ||
        mouseEvent.button !== 0
      ) {
        return;
      }
      potDragHandler.startDrag(
        pot as HTMLElement,
        mouseEvent,
        (v) => {
          const oldVal = zone.cc_controllers[ix].val;
          if (v != oldVal) {
            if (is14bit) {
              zone.cc_controllers[ix].val = v;
            } else {
              zone.snap2DiscreteValue(v >> 7, ix);
            }
            zone.sendCC(ix);
            updateControllerValues(zone, index);
          }
        },
        () => {
          triggerSave();
        }
      );
    });
  });
  DOM.all(`#zone${index} .ccpots *[data-action]`).forEach((e) => {
    e.addEventListener('click', actionHandler as EventListener);
  });
  DOM.all(`#zone${index} .ccpots *[data-change]`).forEach((e) => {
    e.addEventListener('input', actionHandler as EventListener);
  });
  updateValuesForZone(index);
  updateControllerValues(zone, index);
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
    (zoneElement as HTMLElement).dataset['colorindex'] = String(zone.colorIndex);
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
        (zone.elements.get('.seq_lanes') as HTMLInputElement).value = String(sequence.drumLanes);
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
            zone.elements.get(`.lane${laneIndex}`)!.classList.remove('disabled');
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
          (zone._$('.seq_step_length') as HTMLInputElement).value = String(step.length);
        } else {
          if (sequence.selectedStepNumbers.size == 1) {
            (zone._$('.seq_step_length') as HTMLInputElement).value = '1';
            zone.elements.setSelectedIndex('.seq_step_condition', 0);
            zone.elements.setPercentage('.seq_step_probability', 100, index);
            zone.elements.setPercentage('.seq_gatelength', 100, index);
          }
        }
        // mark selected step lengths
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
      (zone._$('.seq_steps') as HTMLInputElement).value = String(sequence.length);
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
      zone.elements.setPercentage('.' + p, parseInt(String((zone as any)[p] * 100)), index);
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
    (zone._$('input.programnumber') as HTMLInputElement).value = zone.pgm_no ? String(zone.pgm_no) : '';

    (zone._$('input.fixedvel_value') as HTMLInputElement).value = String(zone.fixedvel_value);
    const nameField = zone._$('.output-config-name') as HTMLInputElement;
    if (zones.outputConfigNames[zones.list[index].configId]) {
      nameField.value = zones.outputConfigNames[zones.list[index].configId];
    } else {
      nameField.value = '';
      nameField.placeholder =
        (zone._$('select.outport') as HTMLSelectElement).selectedOptions[0].innerHTML;
    }
    zone.elements.addSelectedStyle(
      '.sendClock',
      midiController.clockOutputPorts[zone.outputPortId] === true
    );
    updateControllerValues(zone, index);
    updateGeneralButtons();
  }
}

function polarToCartesian(centerX: number, centerY: number, radius: number, degrees: number): { x: number; y: number } {
  const rad = ((degrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(rad),
    y: centerY + radius * Math.sin(rad)
  };
}

function describeArc(x: number, y: number, radius: number, startAngle: number, endAngle: number): string {
  if (startAngle > endAngle) {
    const temp = startAngle;
    startAngle = endAngle;
    endAngle = temp;
  }
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return [
    'M',
    start.x,
    start.y,
    'A',
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y
  ].join(' ');
}

function describeDiscreteValues(values: number[]): string {
  let path = '';
  if (values != null && values.length > 0) {
    for (let i = 0; i < values.length; i++) {
      const degrees = -135 + 270 * (values[i] / 127);
      const point1 = polarToCartesian(28, 30, 15, degrees);
      const point2 = polarToCartesian(28, 30, 21, degrees);
      path +=
        'M ' + point1.x + ' ' + point1.y + 'L ' + point2.x + ' ' + point2.y;
    }
  }
  return path;
}

const rangePath = describeArc(28, 30, 18, -135, 135);

function updateControllerValues(zone: ZoneType, zoneindex: number): void {
  zone.cc_controllers.forEach((c, ix) => {
    const potselector = `#pot_${zoneindex}_${ix}`;
    const is14bit = c.type == 5 || c.type == 6;
    const isBiploar = c.type == 1 || c.type == 6;
    const valDegrees = is14bit
      ? 270 * (isBiploar ? (c.val - 8192) / 8192 : c.val / 16383)
      : 270 * (isBiploar ? (c.val - 64) / 64 : c.val / 127);
    const valuePath = isBiploar
      ? describeArc(28, 30, 18, 0, valDegrees / 2)
      : describeArc(28, 30, 18, -135, -135 + valDegrees);
    zone._$(`${potselector}_range`)?.setAttribute('d', rangePath);
    zone._$(`${potselector}_value`)?.setAttribute('d', valuePath);
    (zone._$(`${potselector}_zero`) as HTMLElement).style.display = isBiploar ? 'block' : 'none';
    zone
      ._$(`${potselector}_discrete`)
      ?.setAttribute('d', describeDiscreteValues(c.discreteValues || []));
    const potcontainer = zone._$(potselector) as HTMLElement;
    potcontainer.dataset.type = String(c.type);
    potcontainer.dataset.group = String(c.group || 0);
    (zone._$(`${potselector} div.cclabel`) as HTMLElement).innerHTML =
      c.type == 4 ? 'Note to CC' : c.label;
    let displayValue: number = c.val;
    if (c.type == 0) {
      displayValue = zone.remapCCValue(c.val, ix);
    } else if (isBiploar) {
      displayValue = is14bit ? displayValue - 8192 : displayValue - 64;
    }
    (zone._$(`${potselector} .value`) as HTMLElement).innerHTML = String(displayValue);
    if (c.type == 4) {
      let infotext = '';
      if (c.note_cc != null) {
        infotext += '<div>Note: <br/>#' + c.note_cc + '</div>';
      }
      if (c.velocity_cc != null) {
        infotext += '<div>Velocity: <br/>#' + c.velocity_cc + '</div>';
      }
      (zone._$(`${potselector} .info`) as HTMLElement).innerHTML = infotext;
    }
    if (c.type == 3) {
      // buttons
      for (let i = 0; i < 8; i++) {
        const btn = zone._$(`${potselector} .ccbtn${i}`) as HTMLElement;
        const label = (c as any)[`buttonlabel${i}`];
        const value = (c as any)[`buttonvalue${i}`];
        if (
          typeof label != 'undefined' &&
          typeof value != 'undefined' &&
          label.trim() != ''
        ) {
          btn.style.display = 'block';
          btn.innerHTML = label;
          if (value == c.val) {
            btn.classList.add('selected');
          } else {
            btn.classList.remove('selected');
          }
        } else {
          btn.style.display = 'none';
        }
        if (ix == zone.selectedCCIndex) {
          const labelin = zone._$(
            `input[data-change="${zoneindex}:cc_button_label:${i}"]`
          ) as HTMLInputElement;
          const valuein = zone._$(
            `input[data-change="${zoneindex}:cc_button_value:${i}"]`
          ) as HTMLInputElement;
          labelin.value = label || '';
          valuein.value = typeof value == 'undefined' ? '' : value;
        }
      }
    }
    if (ix == zone.selectedCCIndex) {
      DOM.addClass(potselector, 'selected');
      if (zone.editCC) {
        (zone._$('.cc-editor') as HTMLElement).dataset.type = String(c.type);
        (zone._$('.cc-editor .cclabel') as HTMLInputElement).value = c.label;
        (zone._$('.cc-editor .cc-out-lsb') as HTMLInputElement).value =
          typeof c.number_lsb == 'undefined' ? '' : String(c.number_lsb);
        (zone._$('.cc-editor .cc-in') as HTMLInputElement).value =
          typeof c.number_in == 'undefined' ? '' : String(c.number_in);
        (zone._$('.cc-editor .cc-out') as HTMLInputElement).value = String(c.number);
        (zone._$('.cc-editor .cc-min') as HTMLInputElement).value = String(c.min || 0);
        (zone._$('.cc-editor .cc-max') as HTMLInputElement).value = String(c.max || 127);
        (zone._$('.cc-editor .cc_change_type') as HTMLSelectElement).value = String(c.type);
        (zone._$('.cc-editor .cc_change_group') as HTMLSelectElement).selectedIndex = c.group || 0;
        (zone._$('.cc-editor .cc_notenum2cc') as HTMLInputElement).value = c.note_cc != null ? String(c.note_cc) : '';
        (zone._$('.cc-editor .cc_notevelocity2cc') as HTMLInputElement).value = c.velocity_cc != null ? String(c.velocity_cc) : '';
        (zone._$('.cc-editor .cc_discrete_values') as HTMLInputElement).value =
          c.discreteValues?.join(',') || '';
      }
    } else {
      DOM.removeClass(potselector, 'selected');
    }
  });
  DOM.switchClass(zone.elements.ccPots!, zone.editCC, 'cc-edit');
}

let cachedOutputPorts: any[];

/**
 * Update available MIDI output ports.
 */
function updateOutputPortsForAllZones(outputs: any[]): Set<string> {
  cachedOutputPorts = outputs;
  for (let i = 0; i < zones.list.length; i++) {
    updateOutputPortsForZone(i, outputs);
  }
  return listUsedPorts();
}

function listUsedPorts(): Set<string> {
  const usedPorts = new Set<string>();
  for (let i = 0; i < zones.list.length; i++) {
    usedPorts.add(zones.list[i].outputPortId);
  }
  return usedPorts;
}

function initOutputPortsForZone(index: number): void {
  if (cachedOutputPorts) {
    updateOutputPortsForZone(index, cachedOutputPorts);
  }
}

function updateOutputPortsForZone(index: number, outputs: any[]): void {
  const select = DOM.get(`#zone${index} select.outport`) as HTMLSelectElement;
  DOM.empty(select);
  const noSelectionLabel =
    outputs.length > 0 ? '(select MIDI output)' : '(no outputs available)';
  DOM.addHTML(
    select,
    'beforeend',
    `<option value="*">${noSelectionLabel}</option>`
  );

  DOM.addHTML(
    select,
    'beforeend',
    '<optgroup label="---- PORTS ----"></optgroup>'
  );
  const preferredOutputPortId = zones.list[index].preferredOutputPortId;
  let preferredPortAvailable = false;
  outputs.forEach((port) => {
    DOM.addHTML(
      select,
      'beforeend',
      `<option value="${port.id}">${port.name}</option>`
    );
    if (port.id == preferredOutputPortId) {
      preferredPortAvailable = true;
    }
  });
  if (zones.outputConfigNames) {
    let html = '<optgroup label="---- PRESETS ----"></optgroup>';
    [...Object.keys(zones.outputConfigNames)]
      .sort((a, b) =>
        zones.outputConfigNames[a].localeCompare(zones.outputConfigNames[b])
      )
      .forEach((preset) => {
        const psPort = preset.split(',')[0];
        if (outputs.filter((p) => p.id == psPort).length > 0) {
          html += `<option value="$${preset}">${zones.outputConfigNames[preset]}</option>`;
        }
      });
    DOM.addHTML(select, 'beforeend', html);
  }
  if (preferredPortAvailable) {
    select.value = preferredOutputPortId;
    zones.list[index].outputPortId = preferredOutputPortId;
  } else {
    select.value = MIDI.INTERNAL_PORT_ID;
    zones.list[index].outputPortId = MIDI.INTERNAL_PORT_ID;
  }
  updateValuesForAllZones();
}

function allMuteOff(): void {
  for (var i = 0; i < zones.list.length; i++) {
    const zone = zones.list[i];
    zone.enabled = true;
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
  Sequence.NEXT_LAYER_INDEX = layerIndex;
  if (clockRunning) {
    if (Sequence.ACTIVE_LAYER_INDEX != layerIndex) {
      DOM.addClass(
        DOM.all('#tools *[data-select-seq-layer]')[Sequence.NEXT_LAYER_INDEX],
        'pending'
      );
    }
  } else {
    Sequence.ACTIVE_LAYER_INDEX = layerIndex;
  }
  DOM.addClass(
    DOM.all('#tools *[data-select-seq-layer]')[Sequence.ACTIVE_LAYER_INDEX],
    'selected'
  );
  updateValuesForAllZones();
}

let toastTimer: ReturnType<typeof setTimeout> | null;
function toast(message: string, properties?: ToastProperties): void {
  const longer = properties ? properties.longer : false;
  if (toastTimer) {
    clearTimeout(toastTimer);
  }
  const warning = properties ? properties.warning : false;
  let timeoutMS = 2000;
  if (warning) {
    DOM.addClass('#toast', 'warning');
    timeoutMS += 5000;
  } else {
    DOM.removeClass('#toast', 'warning');
  }
  if (longer) {
    timeoutMS += 5000;
  }
  (DOM.get('#toast .toastinner') as HTMLElement).innerHTML = message;
  toastElement.style.top = toastElement.style.left = '';
  toastShow(longer);
  toastTimer = setTimeout(
    () => {
      toastHide();
      toastTimer = null;
    },
    longer ? 5000 : 2000
  );
}

function toastHide(): void {
  DOM.hide(toastElement);
}

function toastShow(longer?: boolean): void {
  DOM.show(toastElement);
}

function deleteAllZones(): void {
  zones.list.forEach((zone) => {
    zone.dismiss();
  });
  zones.list.length = 0;
  midiController.updateUsedPorts(listUsedPorts());
  renderZones();
  window.scrollTo({ top: 0 });
  triggerSave();
}

class NumberInputController {
  elValueDown: HTMLElement | null = null;
  elValueUp: HTMLElement | null = null;
  elValueBtnAttachedInput: HTMLInputElement | null = null;
  timeoutValueRepeatDelay: ReturnType<typeof setTimeout> | null = null;
  intervalValueRepeat: ReturnType<typeof setInterval> | null = null;
  valueRepeatIncrement = 0;

  constructor() {
    this.elValueUp = DOM.get('#valueUp') as HTMLElement;
    this.elValueDown = DOM.get('#valueDown') as HTMLElement;
    this.elValueBtnAttachedInput = null;
    this.elValueUp.addEventListener('mousedown', (ev) =>
      this.startValueChange(ev as MouseEvent, 1)
    );
    this.elValueDown.addEventListener('mousedown', (ev) =>
      this.startValueChange(ev as MouseEvent, -1)
    );
    this.elValueUp.addEventListener('mouseup', (ev) => this.endValueChange(ev as MouseEvent));
    this.elValueDown.addEventListener('mouseup', (ev) =>
      this.endValueChange(ev as MouseEvent)
    );
    this.elValueUp.addEventListener('mouseleave', (ev) => {
      this.detachValueButtons(this.elValueBtnAttachedInput!);
    });
    this.elValueDown.addEventListener('mouseleave', (ev) => {
      this.detachValueButtons(this.elValueBtnAttachedInput!);
    });
  }

  changeAttachedInputValue(v: number): void {
    if (this.elValueBtnAttachedInput) {
      let nv: number;
      if (this.elValueBtnAttachedInput.value == '') {
        nv = parseInt(this.elValueBtnAttachedInput.min);
      } else {
        nv = parseInt(this.elValueBtnAttachedInput.value) + v;
      }
      if (
        nv >= parseInt(this.elValueBtnAttachedInput.min) &&
        nv <= parseInt(this.elValueBtnAttachedInput.max)
      ) {
        this.elValueBtnAttachedInput.value = String(nv);
        this.elValueBtnAttachedInput.dispatchEvent(new CustomEvent('input'));
      }
      this.elValueBtnAttachedInput.focus();
    }
  }

  startValueChange(ev: MouseEvent, v: number): void {
    ev.preventDefault();
    this.valueRepeatIncrement = v;
    if (this.timeoutValueRepeatDelay) clearTimeout(this.timeoutValueRepeatDelay);
    if (this.intervalValueRepeat) clearInterval(this.intervalValueRepeat);
    this.intervalValueRepeat = null;
    this.timeoutValueRepeatDelay = setTimeout(() => {
      this.intervalValueRepeat = setInterval(() => {
        this.changeAttachedInputValue(this.valueRepeatIncrement);
      }, 80);
    }, 400);
  }

  endValueChange(ev: MouseEvent): void {
    ev.preventDefault();
    if (this.timeoutValueRepeatDelay) clearTimeout(this.timeoutValueRepeatDelay);
    if (this.intervalValueRepeat) {
      clearInterval(this.intervalValueRepeat);
    } else {
      this.changeAttachedInputValue(this.valueRepeatIncrement);
    }
  }

  breakValueChange(ev?: MouseEvent): void {
    if (this.timeoutValueRepeatDelay) clearTimeout(this.timeoutValueRepeatDelay);
    if (this.intervalValueRepeat) clearInterval(this.intervalValueRepeat);
    this.intervalValueRepeat = null;
    this.timeoutValueRepeatDelay = null;
  }

  addInputElements(elementlist: Element[]): void {
    elementlist.forEach((e) => {
      e.addEventListener('mouseenter', (ev) => {
        this.attachValueButtons(e as HTMLInputElement);
      });
      e.addEventListener('mouseleave', (ev) => {
        this.breakValueChange(ev as MouseEvent);
        if (
          (ev as MouseEvent).relatedTarget &&
          ((ev as MouseEvent).relatedTarget as HTMLElement).classList.contains('valuebtn')
        ) {
          return;
        }
        this.detachValueButtons(e as HTMLInputElement);
      });
    });
  }
  attachValueButtons(inputelement: HTMLInputElement): void {
    this.elValueBtnAttachedInput = inputelement;
    this.elValueUp!.style.display = this.elValueDown!.style.display = 'block';
    const valueUpRect = this.elValueUp!.getBoundingClientRect();
    const inputElementOffsets = DOM.clientOffsets(inputelement);
    this.elValueDown!.style.top = this.elValueUp!.style.top =
      window.scrollY +
      inputElementOffsets.offsetTop +
      inputElementOffsets.offsetHeight / 2 -
      valueUpRect.height / 2 +
      'px';
    this.elValueUp!.style.left =
      inputElementOffsets.offsetLeft +
      inputElementOffsets.offsetWidth -
      valueUpRect.width +
      'px';
    this.elValueDown!.style.left = inputElementOffsets.offsetLeft + 'px';
  }
  detachValueButtons(inputelement: HTMLInputElement): void {
    this.breakValueChange();
    this.elValueUp!.style.display = this.elValueDown!.style.display = 'none';
  }
}

export = {
  initController,
  renderZones,
  renderLastZone,
  renderMarkersForAllZones,
  updateOutputPortsForAllZone: updateOutputPortsForAllZones,
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
