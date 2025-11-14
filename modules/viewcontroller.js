const DOM = require('./domutils');
const MIDI = require('./midi');
const DragZone = require('./dragzone');
const zoneTemplate = require('./zone-template');
const potDragHandler = require('./potdraghandler');
const { Sequence, Zone, Note } = require('./zone');
const { ipcRenderer } = require('electron');

const contextMenuActionLabel = {
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

let zones = {};
/** @type {MIDI} */
let midiController;
let elAllMuteOff, elAllSoloOff, elAllHoldOff;
let numberInputController;

let triggerSave = () => {};
let toastElement;
/**
 * Init view controller with references to data and MIDI controller.
 * @param {Object} references - references to data and data handling
 * @param {function} references.saveData - Function to save zones settings
 * @param {Object} references.data - Storage object containing zone settings
 * @param {MIDI} references.midi - MIDI controller
 */
function initController({ saveData, data, midi }) {
  toastElement = DOM.get('#toast');
  triggerSave = saveData;
  zones = data;
  midiController = midi;
  elAllMuteOff = DOM.get('#allMuteOff');
  elAllMuteOff.addEventListener('click', allMuteOff);
  elAllSoloOff = DOM.get('#allSoloOff');
  elAllSoloOff.addEventListener('click', allSoloOff);
  elAllHoldOff = DOM.get('#allHoldOff');
  elAllHoldOff.addEventListener('click', allHoldOff);
  window.addEventListener(Zone.updateZoneViewEventName, (ev) => {
    if (ev.detail != null) {
      const index = zones.list.indexOf(ev.detail);
      if (index > -1) {
        updateValuesForZone(index);
      }
    } else {
      updateValuesForAllZones();
    }
    selectSequencerLayer(Sequence.ACTIVE_LAYER_INDEX);
  });
  numberInputController = new NumberInputController();
  numberInputController.addInputElements(
    DOM.all(`#midisettings input[type=number]`)
  );
}

function findTouchedNote(
  /** @type {MouseEvent} */ ev,
  /** @type {HTMLElement} */ e,
  /** @type {Zone} */ zone
) {
  let num = parseInt(
    ((ev.clientX - DOM.clientOffsets(e).offsetLeft) / e.offsetWidth) * 128
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

function actionHandler(/** @type {MouseEvent} */ ev, overrideaction) {
  const element = ev.currentTarget;
  let action =
    overrideaction ||
    element.getAttribute('data-action') ||
    element.getAttribute('data-change');
  if (
    (ev.type == 'blur' || ev.type == 'focus') &&
    element.hasAttribute('data-focus-change')
  ) {
    action = element.getAttribute('data-focus-change');
    action += ':' + (ev.type == 'focus' ? 1 : 0);
  }
  const params = action.split(':');
  const zoneindex = params[0];
  /** @type {Zone} */
  const zone = zones.list[zoneindex];
  const sequence = zone.sequence;
  ev.stopPropagation();
  const applyParamToggle = () => {
    zone[params[1]] = !zone[params[1]];
    updateValuesForZone(zoneindex);
  };
  const applySelectedIndex = () => {
    zone[params[1]] = element.selectedIndex;
    updateValuesForZone(zoneindex);
  };
  const calcPercentage = () => {
    const output = element.parentElement.querySelector(
      `output[for="${element.id}"]`
    );
    if (output) {
      output.value = element.value + '%';
    }
    element.title = element.value + '%';
    return parseInt(element.value) / 100;
  };
  const applyPercentage = () => {
    zone[params[1]] = calcPercentage();
    updateValuesForZone(zoneindex);
  };
  const actions = {
    range: () => {
      const touchedNote = findTouchedNote(ev, element, zone);
      if (touchedNote.isLow) {
        zone.low = touchedNote.low;
      } else {
        zone.high = touchedNote.high;
      }
      renderMarkersForZone(zoneindex);
    },
    channel: applySelectedIndex,
    outport: () => {
      if (element.value.charAt(0) == '$') {
        const parts = element.value.substr(1).split(',');
        zone.channel = parseInt(parts[1]);
        zone.preferredOutputPortId = zone.outputPortId = parseInt(parts[0]);
        updateOutputPortsForZone(zoneindex, cachedOutputPorts);
        midiController.updateUsedPorts(listUsedPorts());
      } else {
        zone.preferredOutputPortId = zone.outputPortId = element.value;
        updateValuesForZone(zoneindex);
        midiController.updateUsedPorts(listUsedPorts());
      }
    },
    octave: () => {
      zone.octave = parseInt(params[2]);
      updateValuesForZone(zoneindex);
    },
    toggle_filters: () => {
      const settings = zone._$('.popupsettings');
      if (settings.style.display == 'flex') {
        settings.style.display = 'none';
      } else {
        settings.style.display = 'flex';
      }
    },
    fixedvel_value: () => {
      zone.fixedvel_value = zone._$('input.fixedvel_value').value;
    },
    fixedvel: () => {
      actions.fixedvel_value();
      applyParamToggle();
    },
    velocity_scaling: applyPercentage,
    cc: applyParamToggle,
    sustain: applyParamToggle,
    sustain_on: applyParamToggle,
    mod: applyParamToggle,
    at2mod: applyParamToggle,
    pitchbend: applyParamToggle,
    programchange: applyParamToggle,
    arp_hold: () => {
      applyParamToggle();
      zone.renderNotes();
    },
    arp_transpose: applyParamToggle,
    arp_repeat: applyParamToggle,
    arp_enabled: () => {
      applyParamToggle();
      if (zone.arp_enabled) {
        updateValuesForZone(zoneindex);
        zone.renderPattern();
      }
      zone.renderNotes();
    },
    sendClock: () => {
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
    arp_direction: applySelectedIndex,
    arp_octaves: applySelectedIndex,
    arp_division: applySelectedIndex,
    arp_probability: applyPercentage,
    arp_gatelength: applyPercentage,
    arp_pattern: () => {
      if (ev.target.tagName == 'CANVAS') {
        const index = parseInt(
          (ev.offsetX / element.offsetWidth) * zone.arp_pattern.length
        );
        zone.arp_pattern[index] = !zone.arp_pattern[index];
        zone.renderPattern();
      }
    },
    changeprogram: () => {
      const v = parseInt(element.value);
      if (v > 0 && v < 129) {
        zone.pgm_no = v;
        zone.sendProgramChange();
      }
    },
    enabled: () => {
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
    solo: () => {
      zone.solo = !zone.solo;
      if (zone.solo) {
        zone.enabled = true;
      }
      updateValuesForAllZones();
    },
    delete: async () => {
      const number = parseInt(zoneindex) + 1;
      await ipcRenderer
        .invoke(
          'open-confirm',
          'Delete zone #' + number,
          'Do you really want to delete zone number ' + number + '?'
        )
        .then((result) => {
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
    changeColor: () => {
      zone.randomizeColor();
      updateValuesForZone(zoneindex);
    },
    showeuclid: () => {
      const dialog = zone._$('.euclid');
      if (dialog.style.display == 'block') {
        DOM.hide(dialog);
      } else {
        DOM.show(dialog);
      }
    },
    euclid: () => {
      let hits = parseInt(zone._$('.euchits').value);
      let len = parseInt(zone._$('.euclen').value);
      if (!isNaN(hits) && !isNaN(len)) {
        hits = Math.min(32, Math.max(1, hits));
        len = Math.min(32, Math.max(2, len));
        zone.createEuclidianPattern(len, hits);
      }
    },
    pattern_shift: () => {
      if (params[2] == -1) {
        zone.arp_pattern.push(zone.arp_pattern.shift());
      } else if (params[2] == 1) {
        zone.arp_pattern.unshift(zone.arp_pattern.pop());
      }
      zone.renderPattern();
    },
    toggle_show_cc: () => {
      zone.show_cc = !zone.show_cc;
      updateValuesForZone(zoneindex);
      if (zone.show_cc) {
        toast('Right click to edit CC controllers.');
      }
    },
    add_cc_controller: () => {
      zone.cc_controllers.push({
        number: 1,
        number_in: null,
        label: `Ctrl #${zone.cc_controllers.length + 1}`,
        val: 0
      });
      renderControllersForZone(zone, zoneindex);
      setTimeout(() => {
        zone.editCC = true;
        updateControllerValues(zone, zoneindex);
      }, 0);
    },
    send_all_cc: () => {
      zone.sendAllCC();
      toast('All CC values sent!');
    },
    cc_edit: () => {
      // TODO rename to toggle
      zone.editCC = !zone.editCC;
      if (params[2] != null) {
        zone.selectedCCIndex = params[2];
      }
      updateControllerValues(zone, zoneindex);
    },
    cc_select: () => {
      if (params[2] == -1 || zone.selectedCCIndex == params[2]) {
        zone.editCC = false;
        updateControllerValues(zone, zoneindex);
      } else {
        zone.selectedCCIndex = params[2];
        if (zone.editCC) {
          updateControllerValues(zone, zoneindex);
        }
      }
    },
    cc_label: () => {
      zone.cc_controllers[zone.selectedCCIndex].label = element.value;
      updateControllerValues(zone, zoneindex);
    },
    cc_number: () => {
      element.value = element.value.replace(/[^0-9]/, '');
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number = parseInt(
          element.value
        );
      }
    },
    cc_number_lsb: () => {
      element.value = element.value.replace(/[^0-9]/, '');
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_lsb = parseInt(
          element.value
        );
      }
    },
    cc_number_in: () => {
      element.value = element.value.replace(/[^0-9]/, ''); // TODO generalize
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_in = parseInt(
          element.value
        );
      }
    },
    cc_min: () => {
      element.value = element.value.replace(/[^0-9]/, ''); // TODO generalize
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].min = parseInt(element.value);
        updateControllerValues(zone, zoneindex);
      }
    },
    cc_max: () => {
      element.value = element.value.replace(/[^0-9]/, ''); // TODO generalize
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].max = parseInt(element.value);
        updateControllerValues(zone, zoneindex);
      }
    },
    cc_discrete_values: () => {
      element.value = element.value.replace(/[^0-9,]/, ''); // TODO generalize
      const discreteValues = element.value
        .split(',')
        .map((v) => (v != '' ? parseInt(v) : v));
      zone.cc_controllers[zone.selectedCCIndex].discreteValues = discreteValues;
      updateControllerValues(zone, zoneindex);
    },
    cc_notenum2cc: () => {
      element.value = element.value.replace(/[^0-9]/, ''); // TODO generalize
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].note_cc = parseInt(
          element.value
        );
      } else {
        zone.cc_controllers[zone.selectedCCIndex].note_cc = null;
      }
      updateControllerValues(zone, zoneindex);
    },
    cc_notevelocity2cc: () => {
      element.value = element.value.replace(/[^0-9]/, ''); // TODO generalize
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].velocity_cc = parseInt(
          element.value
        );
      } else {
        zone.cc_controllers[zone.selectedCCIndex].velocity_cc = null;
      }
      updateControllerValues(zone, zoneindex);
    },
    cc_button_label: () => {
      zone.cc_controllers[zone.selectedCCIndex][`buttonlabel${params[2]}`] =
        element.value;
      updateControllerValues(zone, zoneindex);
    },
    cc_button_value: () => {
      element.value = element.value.replace(/[^0-9]/, ''); // TODO generalize
      if (element.value != '') {
        zone.cc_controllers[zone.selectedCCIndex][`buttonvalue${params[2]}`] =
          parseInt(element.value);
        updateControllerValues(zone, zoneindex);
      }
    },
    cc_button_trig: () => {
      const ccindex = params[2];
      const btnindex = params[3];
      zone.cc_controllers[ccindex].val =
        zone.cc_controllers[ccindex][`buttonvalue${btnindex}`];
      zone.sendCC(ccindex);
      updateControllerValues(zone, zoneindex);
    },
    cc_add: () => {
      zone.cc_controllers.splice(parseInt(zone.selectedCCIndex) + 1, 0, {
        number: 1,
        number_in: null,
        min: 0,
        max: 127,
        type:
          zone.selectedCCIndex > -1
            ? zone.cc_controllers[zone.selectedCCIndex].type
            : 0,
        label: `Ctrl #${parseInt(zone.selectedCCIndex) + 1}`,
        val: 0,
        note_cc: null,
        velocity_cc: null
      });
      zone.selectedCCIndex++;
      renderControllersForZone(zone, zoneindex);
    },
    cc_remove: async () => {
      let description =
        '#' +
        (parseInt(zone.selectedCCIndex) + 1) +
        ' "' +
        zone.cc_controllers[zone.selectedCCIndex].label +
        '"';
      await ipcRenderer
        .invoke(
          'open-confirm',
          'CC' + description,
          'Do you really want to delete controller ' + description + '?'
        )
        .then((result) => {
          if (result == true) {
            zone.cc_controllers.splice(zone.selectedCCIndex, 1);
            zone.selectedCCIndex--;
            renderControllersForZone(zone, zoneindex);
          }
        });
    },
    cc_change_type: () => {
      zone.cc_controllers[zone.selectedCCIndex].type = parseInt(element.value);
      renderControllersForZone(zone, zoneindex);
      updateControllerValues(zone, zoneindex);
    },
    cc_change_group: () => {
      zone.cc_controllers[zone.selectedCCIndex].group = element.selectedIndex;
      renderControllersForZone(zone, zoneindex);
      updateControllerValues(zone, zoneindex);
    },
    _cc_move: (direction) => {
      const pos = Number(zone.selectedCCIndex);
      let targetPos = pos;
      if (direction < 0) {
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
      actions._cc_move(-1);
    },
    cc_right: () => {
      actions._cc_move(1);
    },
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
      sequence.division = element.selectedIndex;
      updateValuesForZone(zoneindex);
    },
    seq_steps: () => {
      const v = parseInt(element.value);
      sequence.length = v;
      updateValuesForZone(zoneindex);
    },
    seq_drum_lanes: () => {
      sequence.drumLanes = parseInt(element.value);
      updateValuesForZone(zoneindex);
    },
    seq_drumlane_note: () => {
      const laneNo = parseInt(params[2]);
      sequence.getDrumLane(laneNo).note = parseInt(element.value);
      console.log(sequence.getDrumLane(laneNo));
      updateValuesForZone(zoneindex);
    },
    seq_drumstep_select: () => {
      sequence.turnOnDrumStep(
        parseInt(element.dataset.laneIndex),
        parseInt(element.dataset.stepIndex)
      );
      updateValuesForZone(zoneindex);
    },
    seq_toggle_lane_enabled: () => {
      const dl = sequence.getDrumLane(parseInt(params[2]));
      dl.enabled = !dl.enabled;
      updateValuesForZone(zoneindex);
    },
    seq_step_length: () => {
      const v = parseInt(element.value);
      sequence.selectedStepNumbers.forEach((n) => {
        if (sequence.steps[n]) sequence.steps[n].length = v;
      });
      updateValuesForZone(zoneindex);
    },
    seq_clear_all: () => {
      if (sequence.isDrumSequence) {
        for (let i = 0; i < 8; i++) {
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
      const semitones = parseInt(element.options[element.selectedIndex].value);
      sequence.transpose(semitones);
      toast(
        (sequence.hasSelection ? 'Selected steps' : 'Sequence') +
          ' transposed by ' +
          semitones +
          ' semitones'
      );
      element.selectedIndex = 0;
      updateValuesForZone(zoneindex);
    },
    seq_adjust: () => {
      const adjustment = element.options[element.selectedIndex].value;
      let seq = sequence;
      let srcLength = seq.length;
      let steps = [];
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
            'All steps changed velocity by ' + parseInt(factor * 100) + '%'
          );
          updateValuesForZone(zoneindex);
          break;
      }
      setTimeout(() => {
        element.selectedIndex = 0;
      }, 100);
    },
    seq_clear_step: () => {
      // clear right clicked or double clicked step
      if (params[2] != 'undefined') {
        const stepno = parseInt(params[2]);
        if (sequence.isDrumSequence) {
          let laneIndex, stepIndex;
          [laneIndex, stepIndex] =
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
            let laneIndex, stepIndex;
            [laneIndex, stepIndex] =
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
          sequence.steps[n].probability = calcPercentage();
        }
      });
      updateValuesForZone(zoneindex);
    },
    seq_step_velocity: () => {
      if (sequence.selectedStep) {
        const velo = calcPercentage() * 127;
        sequence.selectedStep.notesArray.forEach((note) => {
          note.velo = Math.max(1, Math.min(127, velo));
        });
        updateValuesForZone(zoneindex);
      }
    },
    _seq_step_apply_to_all: (actionIndex) => {
      if (sequence.selectedStep && actionIndex > 0) {
        let what = '';
        sequence.steps.forEach((s) => {
          if (s) {
            switch (actionIndex) {
              case 1:
                s.length = sequence.selectedStep.length;
                what = 'step length';
                break;
              case 2:
                s.gateLength = sequence.selectedStep.gateLength;
                what = 'gate length';
                break;
              case 3:
                s.condition = sequence.selectedStep.condition;
                what = 'trigger condition';
                break;
              case 4:
                s.probability = sequence.selectedStep.probability;
                what = 'probability';
                break;
            }
          }
        });
        toast('Applied ' + what + ' to all steps in sequence');
        element.selectedIndex = 0;
        updateValuesForZone(zoneindex);
      }
    },
    step_copy_length: () => {
      actions._seq_step_apply_to_all(1);
    },
    step_copy_gate: () => {
      actions._seq_step_apply_to_all(2);
    },
    step_copy_condition: () => {
      actions._seq_step_apply_to_all(3);
    },
    step_copy_chance: () => {
      actions._seq_step_apply_to_all(4);
    },
    seq_gatelength: () => {
      sequence.selectedSteps.forEach((step) => {
        if (step) {
          step.gateLength = calcPercentage();
        }
      });
      // sequence.selectedStepNumbers.forEach((n) => {
      //   if (sequence.steps[n]) sequence.steps[n].gateLength = calcPercentage();
      // });
      updateValuesForZone(zoneindex);
    },
    seq_copy_step: () => {
      if (params[2] != 'undefined') {
        const selStepIndex = parseInt(params[2]);
        const stepsMap = new Map();
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
      if (params[2] != 'undefined' && Zone.seqClipboardStep) {
        sequence.clearSelection();
        const targetStep = parseInt(params[2]);
        const targetSteps = sequence.steps;
        Zone.seqClipboardStep.keys().forEach((stepindex) => {
          targetSteps[(targetStep + stepindex) % sequence.length] =
            Sequence.cloneStep(Zone.seqClipboardStep.get(stepindex));
        });
        updateValuesForZone(zoneindex);
      } else {
        toast('Nothing to paste, clipboard is empty.');
      }
    },
    seq_step_move: () => {
      if (sequence.hasSelection) {
        const direction = parseInt(params[2]);
        const newSelection = new Set();
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
      const direction = parseInt(params[2]);
      const limit = sequence.length;
      const newSeq = [];
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
      const targetLayer = parseInt(params[2]);
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
          step.condition = element.selectedIndex;
        }
      });
      // sequence.selectedStepNumbers.forEach((n) => {
      //   if (sequence.steps[n])
      //     sequence.steps[n].condition = element.selectedIndex;
      // });
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
    },
    output_config_name: () => {
      if (element.value == '') {
        delete zones.outputConfigNames[zone.configId];
      } else {
        zones.outputConfigNames[zone.configId] = element.value;
      }
      updateOutputPortsForAllZones(cachedOutputPorts);
      updateValuesForAllZones();
    }
  };
  actions[params[1]]?.();
  triggerSave();
  window.dispatchEvent(new CustomEvent('closeContextMenu'));
}

function contextHandler(/** @type {MouseEvent} */ ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const element = ev.currentTarget;
  const menuSpecification = element.getAttribute('data-contextmenu');
  const menuActions = menuSpecification.split(',');
  const contextMenuElement = DOM.get('#contextmenu');

  DOM.empty(contextMenuElement);

  function isEnabled(parts) {
    const zoneindex = parseInt(parts[0]);
    /** @type {Zone} */
    const zone = zones.list[zoneindex];
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
  function labelString(parts) {
    const zoneindex = parseInt(parts[0]);
    /** @type {Zone} */
    const zone = zones.list[zoneindex];
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
      const name = labelString(parts); //contextMenuActionLabel[parts[1]];
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
      actionHandler(event);
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

function hoverHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-hover');
  const params = action.split(':');
  const zoneindex = params[0];
  /** @type {Zone} */
  const zone = zones.list[zoneindex];
  switch (params[1]) {
    case 'range':
      const result = findTouchedNote(ev, e, zone);
      renderMarkersForZone(zoneindex, result.low, result.high);
      break;
  }
  updateValuesForZone(zoneindex);
}

function hoverOutHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-hover');
  const params = action.split(':');
  const zoneindex = params[0];
  zones.list[zoneindex].lastTouchedRangePoint = 0;
  renderMarkersForZone(zoneindex);
}

function dblClickHandler(ev) {
  const e = ev.currentTarget;
  const action =
    e.getAttribute('data-dblclickaction') || e.getAttribute('data-action');
  const params = action.split(':');
  const zoneindex = params[0];
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
      actionHandler(ev, action);
      break;
  }
  triggerSave();
}

/**
 * Render all zones completely. #zones element will be cleared first.
 */
function renderZones() {
  DOM.empty('#zones');
  zones.list.forEach((zone) => {
    zone.elements.reset();
  });
  zones.list.forEach((zone, index) => {
    appendZone(zone, index);
  });
  addPlaceholder();
}

function addPlaceholder() {
  DOM.all('#zones .zone.placeholder', (e) => e.remove());
  if (zones.list.length % 2) {
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
function renderLastZone() {
  const index = zones.list.length - 1;
  const zone = zones.list[index];
  appendZone(zone, index);
  addPlaceholder();
}

function appendZone(/** @type {Zone} */ zone, index) {
  DOM.addHTML('#zones', 'beforeend', zoneTemplate.getHTML(zone, index));
  zone.elements.init(index);
  renderMarkersForZone(index);
  renderControllersForZone(zone, index);
  initOutputPortsForZone(index);
  updateValuesForZone(index);
  zone.renderPattern();
  const sequence = zone.sequence;
  const dragHandler = zone._$('.dragzone');
  dragHandler.addEventListener('mousedown', (ev) => {
    if (zones.list.length > 1) {
      new DragZone(index, ev, () => {
        triggerSave();
        renderZones();
        zone.elements.zoneElement.scrollIntoView({ behavior: 'instant' });
      });
    }
  });

  DOM.all(`#zone${index} *[data-action]`).forEach((e) => {
    e.addEventListener('click', actionHandler);
  });
  DOM.all(`#zone${index} *[data-contextmenu]`).forEach((e) => {
    e.addEventListener('contextmenu', contextHandler);
  });
  DOM.all(`#zone${index} *[data-contextclick]`).forEach((e) => {
    e.addEventListener('click', contextHandler);
  });
  DOM.all(`#zone${index} *[data-change]`).forEach((e) => {
    e.addEventListener('input', actionHandler);
  });
  DOM.all(`#zone${index} *[data-focus-change]`).forEach((e) => {
    e.addEventListener('focus', actionHandler);
    e.addEventListener('blur', actionHandler);
  });
  // drag select multiple steps
  let isDragSelect = false;
  function updateDragSelectStyle() {
    const grid = sequence.isDrumSequence
      ? zone._$('.seq .drum-step-container')
      : zone._$('.seq .step-container');
    if (isDragSelect) {
      grid.classList.add('dragselect');
    } else {
      grid.classList.remove('dragselect');
    }
  }
  DOM.on(`#zone${index} .step-info`, 'mouseup', (ev) => {
    ev.stopPropagation();
  });
  DOM.on(`#zone${index} .seq_transpose`, 'mouseup', (ev) => {
    ev.stopPropagation();
  });
  DOM.on(zone.elements.sequencerElement, 'mouseup', (ev) => {
    if (ev.button != 0) return;
    if (!isDragSelect) {
      sequence.clearSelection();
      updateValuesForZone(index);
    }
    isDragSelect = false;
    updateDragSelectStyle();
  });
  DOM.on(zone.elements.sequencerElement, 'mouseleave', () => {
    isDragSelect = false;
    updateDragSelectStyle();
  });
  DOM.all(`#zone${index} *[data-dragselect]`).forEach((e) => {
    const stepnumber = parseInt(e.dataset.dragselect);
    e.addEventListener('mousedown', (ev) => {
      if (ev.button != 0) return;
      if (sequence.selectedStepNumbers.has(stepnumber)) {
        isDragSelect = false;
        sequence.clearSelection();
      } else {
        isDragSelect = true;
        if (sequence.hasSelection && ev.shiftKey) {
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
    e.addEventListener('mousemove', hoverHandler);
    e.addEventListener('mouseleave', hoverOutHandler);
    e.addEventListener('dblclick', dblClickHandler);
  });
  DOM.all(`input[type="text"],input[type="number"]`).forEach((e) => {
    e.addEventListener('keyup', (event) => {
      if (event.keyCode === 13) {
        event.preventDefault();
        this.dispatchEvent(new Event('input'));
      }
    });
    e.addEventListener('focus', () => {
      e.select();
    });
  });
  DOM.all(
    `#zone${index} .pattern, #zone${index} .ch.solo,  #zone${index} .step[data-dblclickaction]`
  ).forEach((e) => {
    e.addEventListener('dblclick', dblClickHandler);
  });
  let hideOnLeaveTimeout = null;
  const resetHideOnLeaveTimeout = () => {
    if (hideOnLeaveTimeout) {
      clearTimeout(hideOnLeaveTimeout);
    }
  };
  DOM.all(`#zone${index} .hideonleave`).forEach((e) => {
    e.addEventListener('mouseleave', function (ev) {
      if (
        ev.relatedTarget &&
        ev.relatedTarget.classList.contains('preventLeave')
      ) {
        return;
      }
      hideOnLeaveTimeout = setTimeout(() => {
        e.style.display = 'none';
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
function renderMarkersForAllZones() {
  for (let i = 0; i < zones.list.length; i++) {
    renderMarkersForZone(i);
  }
}

function renderMarkersForZone(index, tempLo, tempHigh) {
  /** @type {Zone} */
  const zone = zones.list[index];
  const low = tempLo != undefined ? tempLo : zone.low;
  const high = tempHigh != undefined ? tempHigh : zone.high;
  const xlow = low / 127.0;
  const xhi = high / 127.0;
  const xclow = zone.low / 127.0;
  const xchi = zone.high / 127.0;
  const width = zone.elements.rangeContainer.offsetWidth;
  const xpad = (0.75 / 127.0) * width;
  zone.elements.rangeMarkerLow.style.left = `${xlow * width}px`;
  zone.elements.rangeMarkerHigh.style.right = `${width - xhi * width - xpad}px`;
  zone.elements.rangeMarkerLow.innerHTML =
    MIDI.NOTENAMES[low % 12] + (parseInt(low / 12) - 1);
  zone.elements.rangeMarkerHigh.innerHTML =
    MIDI.NOTENAMES[high % 12] + (parseInt(high / 12) - 1);
  zone.elements.rangeJoin.style.left = `${xlow * width}px`;
  zone.elements.rangeJoin.style.right = `${width - xhi * width - xpad}px`;
  zone.elements.rangeCurrent.style.left = `${xclow * width}px`;
  zone.elements.rangeCurrent.style.right = `${width - xchi * width - xpad}px`;
  let ocount = 0;
  zone.elements.rangeOctaveElements.forEach((e) => {
    ocount++;
    e.style.left = `${((ocount * 12.0) / 127.0) * width}px`;
    e.innerHTML = ocount - 1;
  });
  DOM.switchClass(zone.elements.rangeMarkerLow, tempLo != undefined, 'hover');
  DOM.switchClass(
    zone.elements.rangeMarkerHigh,
    tempHigh != undefined,
    'hover'
  );
}

function renderControllersForZone(/** @type {Zone} */ zone, index) {
  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((e) => e.remove());
  DOM.addHTML(
    `#zone${index} .ccpots .container`,
    'afterbegin',
    zoneTemplate.getControllerHTML(zone, index)
  );
  zone.elements.emptyCache();
  const suckEvent = (e) => {
    e.stopPropagation();
  };
  DOM.on(`#zone${index} .ccpots .cc-editor`, 'click', suckEvent);
  DOM.on(`#zone${index} .ccpots input`, 'keyup', suckEvent);
  DOM.on(`#zone${index} .ccpots input`, 'focus', (e) => {
    e.target.select();
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
      const factor = is14bit ? (e.shiftKey ? 1 : 8) : 1;
      const newV = Math.min(
        Math.max(
          parseInt(
            zone.cc_controllers[ix].val +
              Math.sign(e.deltaY + e.deltaX) * factor
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
      if (
        (zone.cc_controllers[ix].type > 1 &&
          zone.cc_controllers[ix].type < 5) ||
        zone.editCC ||
        e.button !== 0
      ) {
        return;
      }
      potDragHandler.startDrag(
        pot,
        e,
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
    e.addEventListener('click', actionHandler);
  });
  DOM.all(`#zone${index} .ccpots *[data-change]`).forEach((e) => {
    e.addEventListener('input', actionHandler);
  });
  updateValuesForZone(index);
  updateControllerValues(zone, index);
}

function updateValuesForAllZones() {
  for (let i = 0; i < zones.list.length; i++) {
    updateValuesForZone(i);
  }
}

function updateGeneralButtons() {
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

function updateValuesForZone(index) {
  /** @type {Zone} */
  const zone = zones.list[index];
  const sequence = zone.sequence;
  const zoneElement = zone.elements.zoneElement;
  if (zone.elements.isReady && zoneElement) {
    zoneElement.dataset['colorindex'] = zone.colorIndex;
    DOM.removeClass(zone.elements.actionElements, 'selected');
    DOM.switchClass(
      zoneElement,
      Zone.solocount > 0 && !zone.solo,
      'soloed-out'
    );
    zone.elements.sequencerProgressElement.style.backgroundSize = `${
      100 / sequence.length
    }% 100%`;
    zone.elements.sequencerProgressElementInner.style.width = `${
      100 / sequence.length
    }%`;

    DOM.switchClass(zoneElement, !zone.enabled, 'disabled');
    const zoneIsEnabled = zone.enabled && (Zone.solocount === 0 || zone.solo);
    DOM.switchClass(zoneElement, !zoneIsEnabled, 'disabled');
    DOM.switchClass(zoneElement, zone.show_cc, 'show-cc');
    if (sequence.active) {
      DOM.addClass(zoneElement, 'show-seq');
      DOM.hide(zone.elements.sequencerProgressElement);
      DOM.switchClass(zoneElement, sequence.isDrumSequence, 'drumSequencer');
      if (sequence.isDrumSequence) {
        DOM.removeClass(
          zone.elements.sequencerDrumStepElements,
          'selected-step',
          'activelength'
        );
        zone.elements.get('.seq_lanes').value = sequence.drumLanes;
        for (let laneIndex = 0; laneIndex < 8; laneIndex++) {
          if (laneIndex >= sequence.drumLanes) {
            zone.elements.get(`.lane${laneIndex}`).classList.add('unused');
          } else {
            zone.elements.get(`.lane${laneIndex}`).classList.remove('unused');
          }
          const isEnabled = sequence.getDrumLane(laneIndex).enabled;
          if (isEnabled) {
            zone.elements.get(`.lane${laneIndex}`).classList.remove('disabled');
          } else {
            zone.elements.get(`.lane${laneIndex}`).classList.add('disabled');
          }
          zone.elements.addSelectedStyle(
            `.lane${laneIndex} .seq_toggle_lane_enabled`,
            isEnabled
          );
          const numberElement = zone.elements.get(
            `input[data-change="${index}:seq_drumlane_note:${laneIndex}"]`
          );
          numberElement.value = sequence.getDrumLane(laneIndex).note;
          numberElement.title =
            'Trigger note: ' +
            Note.display(sequence.getDrumLane(laneIndex).note);
          for (
            let stepIndex = 0;
            stepIndex < Sequence.MAX_STEPS_DRUMS;
            stepIndex++
          ) {
            const stepElement =
              zone.elements.sequencerDrumLanes[laneIndex][stepIndex];
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
          zone.elements.sequencerGridStepElements,
          'selected-step',
          'activelength'
        );
        zone.elements.sequencerGridStepElements.forEach((stepElement, i) => {
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
        DOM.addClass(zone.elements.sequencerElement, 'has-selection');
        if (sequence.selectedStepNumbers.size > 1) {
          DOM.addClass(zone.elements.sequencerElement, 'multi-selection');
        }
        if (sequence.stepAddNotes) {
          zone._$('.seq-step-add-notes').classList.add('selected');
        }
        if (sequence.stepAdvance) {
          zone._$('.seq-step-advance').classList.add('selected');
        }
        const step = sequence.selectedStep;
        if (step && step.length > 0) {
          zone.elements.setPercentage(
            '.seq_step_probability',
            parseInt(step.probability * 100),
            index
          );
          zone.elements.setPercentage(
            '.seq_gatelength',
            parseInt(step.gateLength * 100),
            index
          );
          zone.elements.setPercentage(
            '.seq_step_velocity',
            parseInt(sequence.velocityMediumSelectedStep() * 100),
            index
          );
          zone.elements.setSelectedIndex('.seq_step_condition', step.condition);
          zone._$('.seq_step_length').value = step.length;
        } else {
          if (sequence.selectedStepNumbers.size == 1) {
            zone._$('.seq_step_length').value = 1;
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
            zone.elements.sequencerGridStepElements.forEach((e, i) => {
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
          zone.elements.sequencerElement,
          'has-selection',
          'multi-selection'
        );
      }
      zone._$('.seq_steps').value = sequence.length;
      zone.elements.setSelectedIndex('.seq_division', sequence.division);
    } else {
      DOM.removeClass(zoneElement, 'show-seq');
      if (sequence.steps.length > 0) {
        DOM.show(zone.elements.sequencerProgressElement);
      } else {
        DOM.hide(zone.elements.sequencerProgressElement);
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
      zone.elements.addSelectedStyle('.' + p, zone[p]);
    });
    ['channel', 'arp_direction', 'arp_division', 'arp_octaves'].forEach((p) => {
      zone.elements.setSelectedIndex('.' + p, zone[p]);
    });
    ['arp_gatelength', 'arp_probability'].forEach((p) => {
      zone.elements.setPercentage('.' + p, parseInt(zone[p] * 100), index);
    });
    DOM.switchClass(zoneElement, zone.arp_enabled, 'arp-enabled');
    zone.elements.octaveSelectors.forEach((e) => {
      const parts = e.getAttribute('data-action').split(':');
      if (parts[2] == zone.octave) {
        DOM.addClass(e, 'selected');
      }
    });
    zone.elements.setPercentage(
      '.velocity_scaling',
      parseInt(zone.velocity_scaling * 100),
      index
    );
    zone._$('.euchits').value = zone.euclid_hits;
    zone._$('.euclen').value = zone.euclid_length;
    zone._$('input.programnumber').value = zone.pgm_no ? zone.pgm_no : '';

    zone._$('input.fixedvel_value').value = zone.fixedvel_value;
    const nameField = zone._$('.output-config-name');
    if (zones.outputConfigNames[zones.list[index].configId]) {
      nameField.value = zones.outputConfigNames[zones.list[index].configId];
    } else {
      nameField.value = '';
      nameField.placeholder =
        zone._$('select.outport').selectedOptions[0].innerHTML;
    }
    zone.elements.addSelectedStyle(
      '.sendClock',
      midiController.clockOutputPorts[zone.outputPortId] === true
    );
    updateControllerValues(zone, index);
    updateGeneralButtons();
  }
}

function polarToCartesian(centerX, centerY, radius, degrees) {
  const rad = ((degrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(rad),
    y: centerY + radius * Math.sin(rad)
  };
}

function describeArc(x, y, radius, startAngle, endAngle) {
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

function describeDiscreteValues(/** @type {Array<number>} */ values) {
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

function updateControllerValues(/** @type {Zone} */ zone, zoneindex) {
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
    zone._$(`${potselector}_range`).setAttribute('d', rangePath);
    zone._$(`${potselector}_value`).setAttribute('d', valuePath);
    zone._$(`${potselector}_zero`).style.display = isBiploar ? 'block' : 'none';
    zone
      ._$(`${potselector}_discrete`)
      .setAttribute('d', describeDiscreteValues(c.discreteValues));
    const potcontainer = zone._$(potselector);
    potcontainer.dataset.type = c.type;
    potcontainer.dataset.group = c.group || 0;
    zone._$(`${potselector} div.cclabel`).innerHTML =
      c.type == 4 ? 'Note to CC' : c.label;
    let displayValue = c.val;
    if (c.type == 0) {
      displayValue = zone.remapCCValue(c.val, ix);
    } else if (isBiploar) {
      displayValue = is14bit ? displayValue - 8192 : displayValue - 64;
    }
    zone._$(`${potselector} .value`).innerHTML = displayValue;
    if (c.type == 4) {
      let infotext = '';
      if (c.note_cc != null) {
        infotext += '<div>Note: <br/>#' + c.note_cc + '</div>';
      }
      if (c.velocity_cc != null) {
        infotext += '<div>Velocity: <br/>#' + c.velocity_cc + '</div>';
      }
      zone._$(`${potselector} .info`).innerHTML = infotext;
    }
    if (c.type == 3) {
      // buttons
      for (let i = 0; i < 8; i++) {
        const btn = zone._$(`${potselector} .ccbtn${i}`);
        const label = c[`buttonlabel${i}`];
        const value = c[`buttonvalue${i}`];
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
          );
          const valuein = zone._$(
            `input[data-change="${zoneindex}:cc_button_value:${i}"]`
          );
          labelin.value = label || '';
          valuein.value = typeof value == 'undefined' ? '' : value;
        }
      }
    }
    if (ix == zone.selectedCCIndex) {
      DOM.addClass(potselector, 'selected');
      if (zone.editCC) {
        zone._$('.cc-editor').dataset.type = c.type;
        zone._$('.cc-editor .cclabel').value = c.label;
        zone._$('.cc-editor .cc-out-lsb').value =
          typeof c.number_lsb == 'undefined' ? '' : c.number_lsb;
        zone._$('.cc-editor .cc-in').value =
          typeof c.number_in == 'undefined' ? '' : c.number_in;
        zone._$('.cc-editor .cc-out').value = c.number;
        zone._$('.cc-editor .cc-min').value = c.min || 0;
        zone._$('.cc-editor .cc-max').value = c.max || 127;
        zone._$('.cc-editor .cc_change_type').value = c.type;
        zone._$('.cc-editor .cc_change_group').selectedIndex = c.group || 0;
        zone._$('.cc-editor .cc_notenum2cc').value = c.note_cc || '';
        zone._$('.cc-editor .cc_notevelocity2cc').value = c.velocity_cc || '';
        zone._$('.cc-editor .cc_discrete_values').value =
          c.discreteValues?.join(',') || '';
      }
    } else {
      DOM.removeClass(potselector, 'selected');
    }
  });
  DOM.switchClass(zone.elements.ccPots, zone.editCC, 'cc-edit');
}

let cachedOutputPorts;

/**
 * Update available MIDI output ports.
 * @param {Array} outputs
 * @returns {Set} set of all currently used ports
 */
function updateOutputPortsForAllZones(outputs) {
  cachedOutputPorts = outputs;
  for (let i = 0; i < zones.list.length; i++) {
    updateOutputPortsForZone(i, outputs);
  }
  return listUsedPorts();
}

function listUsedPorts() {
  const usedPorts = new Set();
  for (let i = 0; i < zones.list.length; i++) {
    usedPorts.add(zones.list[i].outputPortId);
  }
  return usedPorts;
}

function initOutputPortsForZone(index) {
  if (cachedOutputPorts) {
    updateOutputPortsForZone(index, cachedOutputPorts);
  }
}

function updateOutputPortsForZone(index, outputs) {
  // const defaultOutput = outputs.filter((op) => op.isDefault);
  const select = DOM.get(`#zone${index} select.outport`);
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

function allMuteOff() {
  for (var i = 0; i < zones.list.length; i++) {
    const zone = zones.list[i];
    zone.enabled = true;
  }
  updateValuesForAllZones();
  triggerSave();
}

function allSoloOff() {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].solo = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

function allHoldOff() {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].arp_hold = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

function soloZone(index) {
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

function toggleZoneMute(index) {
  const zone = zones.list[index];
  if (zone) {
    zone.enabled = !zone.enabled;
    updateValuesForAllZones();
    triggerSave();
  }
}

function toggleSequencerOnZone(index) {
  const zone = zones.list[index];
  if (zone) {
    zone.sequence.active = !zone.sequence.active;
    updateValuesForAllZones();
    triggerSave();
  }
}

function selectSequencerLayer(layerIndex) {
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

let toastTimer;
function toast(message, properties) {
  const longer = properties ? properties.longer : false;
  if (toastTimer) {
    clearTimeout(toastTimer);
    // toastHide();
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
  DOM.get('#toast .toastinner').innerHTML = message;
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

function toastHide() {
  DOM.hide(toastElement);
  toastElement.classList.remove('fade', 'fadelong');
}

function toastShow(longer) {
  DOM.show(toastElement);
  toastElement.classList.add(longer ? 'fadelong' : 'fade');
}

function deleteAllZones() {
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
  elValueDown = null;
  elValueUp = null;
  elValueBtnAttachedInput = null;
  timeoutValueRepeatDelay = null;
  intervalValueRepeat = null;
  valueRepeatIncrement = 0;

  constructor() {
    this.elValueUp = DOM.get('#valueUp');
    this.elValueDown = DOM.get('#valueDown');
    this.elValueBtnAttachedInput = null;
    this.elValueUp.addEventListener('mousedown', (ev) =>
      this.startValueChange(ev, 1)
    );
    this.elValueDown.addEventListener('mousedown', (ev) =>
      this.startValueChange(ev, -1)
    );
    this.elValueUp.addEventListener('mouseup', (ev) => this.endValueChange(ev));
    this.elValueDown.addEventListener('mouseup', (ev) =>
      this.endValueChange(ev)
    );
    this.elValueUp.addEventListener('mouseleave', (ev) => {
      this.detachValueButtons(this.elValueBtnAttachedInput);
    });
    this.elValueDown.addEventListener('mouseleave', (ev) => {
      this.detachValueButtons(this.elValueBtnAttachedInput);
    });
  }

  changeAttachedInputValue(v) {
    if (this.elValueBtnAttachedInput) {
      let nv;
      if (this.elValueBtnAttachedInput.value == '') {
        nv = this.elValueBtnAttachedInput.min;
      } else {
        nv = parseInt(this.elValueBtnAttachedInput.value) + v;
      }
      if (
        nv >= this.elValueBtnAttachedInput.min &&
        nv <= this.elValueBtnAttachedInput.max
      ) {
        this.elValueBtnAttachedInput.value = nv;
        this.elValueBtnAttachedInput.dispatchEvent(new CustomEvent('input'));
      }
      this.elValueBtnAttachedInput.focus();
    }
  }

  startValueChange(ev, v) {
    ev.preventDefault();
    this.valueRepeatIncrement = v;
    clearTimeout(this.timeoutValueRepeatDelay);
    clearInterval(this.intervalValueRepeat);
    this.intervalValueRepeat = null;
    this.timeoutValueRepeatDelay = setTimeout(() => {
      this.intervalValueRepeat = setInterval(() => {
        this.changeAttachedInputValue(this.valueRepeatIncrement);
      }, 80);
    }, 400);
  }

  endValueChange(ev) {
    ev.preventDefault();
    clearTimeout(this.timeoutValueRepeatDelay);
    if (this.intervalValueRepeat) {
      clearInterval(this.intervalValueRepeat);
    } else {
      this.changeAttachedInputValue(this.valueRepeatIncrement);
    }
  }

  breakValueChange(ev) {
    clearTimeout(this.timeoutValueRepeatDelay);
    clearInterval(this.intervalValueRepeat);
    this.intervalValueRepeat = null;
    this.timeoutValueRepeatDelay = null;
  }

  addInputElements(elementlist) {
    elementlist.forEach((e) => {
      e.addEventListener('mouseenter', (ev) => {
        this.attachValueButtons(e);
      });
      e.addEventListener('mouseleave', (ev) => {
        this.breakValueChange(ev);
        if (
          ev.relatedTarget &&
          ev.relatedTarget.classList.contains('valuebtn')
        ) {
          return;
        }
        this.detachValueButtons(e);
      });
    });
  }
  attachValueButtons(inputelement) {
    this.elValueBtnAttachedInput = inputelement;
    this.elValueUp.style.display = this.elValueDown.style.display = 'block';
    const valueUpRect = this.elValueUp.getBoundingClientRect();
    const inputElementOffsets = DOM.clientOffsets(inputelement);
    this.elValueDown.style.top = this.elValueUp.style.top =
      window.scrollY +
      inputElementOffsets.offsetTop +
      inputElementOffsets.offsetHeight / 2 -
      valueUpRect.height / 2 +
      'px';
    this.elValueUp.style.left =
      inputElementOffsets.offsetLeft +
      inputElementOffsets.offsetWidth -
      valueUpRect.width +
      'px';
    this.elValueDown.style.left = inputElementOffsets.offsetLeft + 'px';
  }
  detachValueButtons(inputelement) {
    this.breakValueChange();
    this.elValueUp.style.display = this.elValueDown.style.display = 'none';
  }
}

module.exports = {
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
