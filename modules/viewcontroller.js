const DOM = require('./domutils');
const MIDI = require('./midi');
const DragZone = require('./dragzone');
const Zone = require('./zone').Zone;
const zoneTemplate = require('./zone-template');
const potDragHandler = require('./potdraghandler');
const { Sequence } = require('./zone');

const contextMenuActionLabel = {
  seq_copy_step: 'Copy step',
  seq_paste_step: 'Paste step',
  seq_paste_steps: 'Paste sequence from here',
  seq_clear_step: 'Clear step',
  seq_clear_all: 'Clear complete sequence',
  seq_copy: 'Copy sequence',
  seq_paste: 'Paste sequence',
  seq_copy_to_layer_0: 'Copy sequence to layer A',
  seq_copy_to_layer_1: 'Copy sequence to layer B',
  seq_copy_to_layer_2: 'Copy sequence to layer C',
  seq_copy_to_layer_3: 'Copy sequence to layer D'
};

let zones = {};
/** @type {MIDI} */
let midiController;
let elAllMuteOff, elAllSoloOff, elAllHoldOff;

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
  toastElement = DOM.element('#toast');
  triggerSave = saveData;
  zones = data;
  midiController = midi;
  elAllMuteOff = DOM.element('#allMuteOff');
  elAllMuteOff.addEventListener('click', allMuteOff);
  elAllSoloOff = DOM.element('#allSoloOff');
  elAllSoloOff.addEventListener('click', allSoloOff);
  elAllHoldOff = DOM.element('#allHoldOff');
  elAllHoldOff.addEventListener('click', allHoldOff);
  window.addEventListener(Zone.updateZoneViewEventName, (ev) => {
    const index = zones.list.indexOf(ev.detail);
    if (index > -1) {
      updateValuesForZone(index);
    }
  });
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

function actionHandler(/** @type {MouseEvent} */ ev, properties) {
  const precalculatedValue = properties
    ? properties.precalculatedValue
    : undefined;
  const contextElement = properties ? properties.contextElement : undefined;
  const triggerElement = contextElement || ev.currentTarget;
  const element = ev.currentTarget;
  let action =
    element.getAttribute('data-action') ||
    element.getAttribute('data-change') ||
    element.getAttribute('data-dragvalue');
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
      const settings = DOM.element(`#zone${zoneindex} .popupsettings`);
      if (settings.style.display == 'flex') {
        settings.style.display = 'none';
      } else {
        settings.style.display = 'flex';
      }
    },
    fixedvel_value: () => {
      zone.fixedvel_value = document.getElementById(
        'fixedvel' + zoneindex
      ).value;
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
        zone.sequence.active = false;
        zone.sequence.selectedStepNumber = -1;
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
      if (!zone.enabled && zone.sequence.active) {
        zone.sequence.selectedStepNumber = -1;
        zone.sequence.isLiveRecoding = false;
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
    delete: () => {
      const scrollPos = window.scrollY;
      zone.dismiss();
      zones.list.splice(zoneindex, 1);
      midiController.updateUsedPorts(listUsedPorts());
      renderZones();
      window.scrollTo({ top: scrollPos });
    },
    changeColor: () => {
      zone.randomizeColor();
      updateValuesForZone(zoneindex);
    },
    showeuclid: () => {
      const dialog = DOM.element(`#zone${zoneindex} .euclid`);
      if (dialog.style.display == 'block') {
        DOM.hide(dialog);
      } else {
        DOM.show(dialog);
      }
    },
    euclid: () => {
      let hits = parseInt(DOM.element(`#euchits${zoneindex}`).value);
      let len = parseInt(DOM.element(`#euclen${zoneindex}`).value);
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
      toast('Sent all CC values!', { triggerElement: triggerElement });
    },
    cc_edit: () => {
      // TODO rename to toggle
      zone.editCC = !zone.editCC;
      updateControllerValues(zone, zoneindex);
    },
    cc_select: () => {
      zone.selectedCCIndex = params[2];
      if (zone.editCC) {
        updateControllerValues(zone, zoneindex);
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
        type: 0,
        label: `Ctrl #${parseInt(zone.selectedCCIndex) + 1}`,
        val: 0
      });
      zone.selectedCCIndex++;
      renderControllersForZone(zone, zoneindex);
    },
    cc_remove: () => {
      zone.cc_controllers.splice(zone.selectedCCIndex, 1);
      zone.selectedCCIndex--;
      renderControllersForZone(zone, zoneindex);
    },
    cc_change_type: () => {
      zone.cc_controllers[zone.selectedCCIndex].type = parseInt(element.value);
      renderControllersForZone(zone, zoneindex);
      updateControllerValues(zone, zoneindex);
    },
    // cc_focused: () => {
    //   zone.learnCCIndex = params[3] == 1 ? params[2] : -1;
    //   console.log('Learning CC: ', zone.learnCCIndex);
    // },
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
      zone.sequence.active = !zone.sequence.active;
      zone.sequence.selectedStepNumber = -1;
      if (zone.sequence.active) {
        zone.arp_enabled = false;
        zone.renderNotes();
      } else {
        zone.sequence.isLiveRecoding = false;
      }
      updateValuesForZone(zoneindex);
    },
    select_step: () => {
      const stepNo = parseInt(params[2]);
      if (zone.sequence.selectedStepNumber == stepNo) {
        zone.sequence.selectedStepNumber = -1;
      } else {
        zone.sequence.selectedStepNumber = stepNo;
      }
      updateValuesForZone(zoneindex);
    },
    seq_division: () => {
      zone.sequence.division = element.selectedIndex;
      updateValuesForZone(zoneindex);
    },
    seq_steps: () => {
      const v = parseInt(element.value);
      zone.sequence.length = v;
      updateValuesForZone(zoneindex);
    },
    seq_step_length: () => {
      const v = parseInt(element.value);
      if (zone.sequence.selectedStep) {
        zone.sequence.selectedStep.length = v;
        updateValuesForZone(zoneindex);
      }
    },
    seq_clear_all: () => {
      zone.sequence.steps.length = 0;
      updateValuesForZone(zoneindex);
      zone.sequence.selectedStepNumber = zone.sequence.selectedStepNumber;
      toast('Sequence cleared.', { triggerElement: triggerElement });
    },
    seq_transpose: () => {
      const semitones = parseInt(element.options[element.selectedIndex].value);
      zone.sequence.transpose(semitones);
      toast('Sequence transposed by ' + semitones + ' semitones.', {
        triggerElement: triggerElement
      });
      DOM.addClass(`#zone${zoneindex} .grid`, 'steps-changed');
      setTimeout(() => {
        element.selectedIndex = 0;
        DOM.removeClass(`#zone${zoneindex} .grid`, 'steps-changed');
      }, 1000);
    },
    seq_adjust: () => {
      const adjustment = element.options[element.selectedIndex].value;
      let seq = zone.sequence;
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
          toast('Sequence doubled in length.', {
            triggerElement: triggerElement
          });
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
          toast('Sequence made double time slower.', {
            triggerElement: triggerElement
          });
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
          toast('Sequence made triple time slower.', {
            triggerElement: triggerElement
          });
          break;
      }
      setTimeout(() => {
        element.selectedIndex = 0;
      }, 100);
    },
    seq_clear_step: () => {
      if (params[2] != 'undefined') {
        zone.sequence.steps[parseInt(params[2])] = null;
        updateValuesForZone(zoneindex);
        toast('Step cleared.', { triggerElement: triggerElement });
      }
    },
    seq_step_probability: () => {
      if (zone.sequence.selectedStep) {
        zone.sequence.selectedStep.probability = calcPercentage();
        updateValuesForZone(zoneindex);
      }
    },
    seq_step_velocity: () => {
      if (zone.sequence.selectedStep) {
        zone.sequence.selectedStep.notesArray.forEach((note) => {
          const newvelo = note.velo + precalculatedValue;
          note.velo = Math.max(1, Math.min(127, newvelo));
        });
        updateValuesForZone(zoneindex);
      }
    },
    seq_step_apply_to_all: () => {
      const actionIndex = element.selectedIndex;
      if (zone.sequence.selectedStep && actionIndex > 0) {
        let what = '';
        zone.sequence.steps.forEach((s) => {
          if (s) {
            switch (actionIndex) {
              case 1:
                s.length = zone.sequence.selectedStep.length;
                what = 'step length';
                break;
              case 2:
                s.gateLength = zone.sequence.selectedStep.gateLength;
                what = 'gate length';
                break;
              case 3:
                s.condition = zone.sequence.selectedStep.condition;
                what = 'trigger condition';
                break;
              case 4:
                s.probability = zone.sequence.selectedStep.probability;
                what = 'probability';
                break;
            }
          }
        });
        toast('Applied ' + what + ' to all steps in sequence.', {
          triggerElement: triggerElement
        });
        updateValuesForZone(zoneindex);
        DOM.addClass(element.closest('.grid'), 'steps-changed');
      }
      if (actionIndex > 0) {
        setTimeout(() => {
          element.selectedIndex = 0;
          DOM.removeClass(element.closest('.grid'), 'steps-changed');
        }, 1000);
      }
    },
    seq_gatelength: () => {
      if (zone.sequence.selectedStep) {
        zone.sequence.selectedStep.gateLength = calcPercentage();
        updateValuesForZone(zoneindex);
      }
    },
    seq_copy_step: () => {
      if (params[2] != 'undefined') {
        Zone.seqClipboardStep = JSON.stringify(
          zone.sequence.steps[parseInt(params[2])]
        );
        // toast('Step copied to clipboard', { triggerElement: triggerElement });
      }
    },
    seq_paste_step: () => {
      if (params[2] != 'undefined' && Zone.seqClipboardStep) {
        zone.sequence.steps[parseInt(params[2])] = JSON.parse(
          Zone.seqClipboardStep
        );
        // toast(
        //   'Step from clipboard pasted on position ' + (parseInt(params[2]) + 1),
        //   { triggerElement: triggerElement }
        // );
        updateValuesForZone(zoneindex);
      } else {
        toast('Nothing to paste, clipboard is empty.', {
          triggerElement: triggerElement
        });
      }
    },
    seq_step_move: () => {
      if (zone.sequence.selectedStep) {
        const direction = parseInt(params[2]);
        let newPos =
          (zone.sequence.selectedStepNumber + direction) % zone.sequence.length;
        if (newPos < 0) {
          newPos = zone.sequence.length - 1;
        }
        if (
          !zone.sequence.steps[newPos] ||
          zone.sequence.steps[newPos].length == 0
        ) {
          zone.sequence.steps[newPos] =
            zone.sequence.steps[zone.sequence.selectedStepNumber];
          zone.sequence.steps[zone.sequence.selectedStepNumber] = null;
          zone.sequence.selectedStepNumber = newPos;
          zone.sequence.isHotRecordingNotes = false;
          updateValuesForZone(zoneindex);
        }
      }
    },
    seq_move: () => {
      zone.sequence.selectedStepNumber = -1;
      const direction = parseInt(params[2]);
      const limit = zone.sequence.length;
      const newSeq = [];
      for (let i = 0; i < Sequence.MAX_STEPS; i++) {
        newSeq[i] = zone.sequence.steps[i];
      }
      const srcOffset = direction > 0 ? limit - 1 : 1;
      for (let i = 0; i < limit; i++) {
        newSeq[i] = zone.sequence.steps[(i + srcOffset) % limit];
      }
      zone.sequence.steps = newSeq;
      updateValuesForZone(zoneindex);
    },
    seq_copy: () => {
      const copyData = {
        steps: zone.sequence.steps,
        length: zone.sequence.length,
        division: zone.sequence.division
      };
      Zone.seqClipboardSequence = JSON.stringify(copyData);
      toast('Sequence copied to clipboard.', {
        triggerElement: triggerElement
      });
    },
    seq_paste: () => {
      if (Zone.seqClipboardSequence) {
        const copyData = JSON.parse(Zone.seqClipboardSequence);
        Object.assign(zone.sequence, copyData);
        updateValuesForZone(zoneindex);
        toast('Sequence pasted from clipboard.', {
          triggerElement: triggerElement
        });
      } else {
        toast('Clipboard is empty, nothing to paste.', {
          triggerElement: triggerElement
        });
      }
    },
    seq_copy_to_layer_0: () => {
      const targetLayer = parseInt(params[2]);
      const copyData = JSON.parse(
        JSON.stringify({
          steps: zone.sequence.steps,
          length: zone.sequence.length,
          division: zone.sequence.division,
          ticks: zone.sequence.ticks
        })
      );
      Object.assign(zone.sequence.layers[targetLayer], copyData);
      updateValuesForZone(zoneindex);
      toast(
        'Sequence copied to layer ' + String.fromCharCode(65 + targetLayer),
        {
          triggerElement: triggerElement
        }
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
    seq_paste_steps: () => {
      if (Zone.seqClipboardSequence) {
        const startIndex = parseInt(params[2]);
        const seqData = JSON.parse(Zone.seqClipboardSequence);
        for (let i = 0; i < seqData.length; i++) {
          zone.sequence.steps[startIndex + i] = seqData.steps[i];
        }
        if (zone.sequence.length < startIndex + seqData.length) {
          zone.sequence.length = startIndex + seqData.length;
        }
        updateValuesForZone(zoneindex);
        toast(`Sequence from clipboard pasted from step ${startIndex + 1}.`, {
          triggerElement: triggerElement
        });
      } else {
        toast('Clipboard is empty, nothing to paste.', {
          triggerElement: triggerElement
        });
      }
    },
    seq_step_condition: () => {
      if (zone.sequence.selectedStep) {
        zone.sequence.selectedStep.condition = element.selectedIndex;
        updateValuesForZone(zoneindex);
      }
    },
    seq_step_add_notes: () => {
      zone.sequence.stepAddNotes = !zone.sequence.stepAddNotes;
      updateValuesForZone(zoneindex);
    },
    seq_step_advance: () => {
      zone.sequence.stepAdvance = !zone.sequence.stepAdvance;
      updateValuesForZone(zoneindex);
    },
    seq_record_live: () => {
      zone.sequence.selectedStepNumber = -1;
      zone.sequence.isLiveRecoding = !zone.sequence.isLiveRecoding;
      updateValuesForZone(zoneindex);
      toast(
        zone.sequence.isLiveRecoding
          ? 'Live recording enabled!'
          : 'Stopped live recording.',
        { triggerElement: triggerElement }
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
  const element = ev.currentTarget;
  const menuSpecification = element.getAttribute('data-contextmenu');
  const menuActions = menuSpecification.split(',');
  const contextMenuElement = DOM.element('#contextmenu');
  const srcRect = element.getBoundingClientRect();
  let top = srcRect.top + 23;
  if (top > window.innerHeight - 40) {
    top = top - 26 * 2.25;
  }
  contextMenuElement.style.top = top + 'px';
  contextMenuElement.style.left = srcRect.left - 3 + 'px';
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
      case 'seq_paste_steps':
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
  menuActions.forEach((act) => {
    if (act == '-') {
      DOM.addHTML(contextMenuElement, 'beforeend', `<hr/>`);
    } else {
      const parts = act.split(':');
      const name = contextMenuActionLabel[parts[1]];
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
      actionHandler(event, { contextElement: element });
    });
  });
  window.dispatchEvent(new CustomEvent('resetHideOnLeaveContextMenuTimeout'));
  contextMenuElement.style.display = 'block';
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
  const action = e.getAttribute('data-action');
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
  }
  triggerSave();
}

/**
 * Render all zones completely. #zones element will be cleared first.
 */
function renderZones() {
  DOM.empty('#zones');
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
  zone.canvasElement = DOM.element(`#canvas${index}`);
  zone.patternCanvas = DOM.element(`#canvasPattern${index}`);
  zone.sequencerElement = DOM.element(`#zone${index} .seq`);
  zone.sequencerGridElement = DOM.element(`#zone${index} .seq .grid`);
  zone.sequencerProgressElement = DOM.element(`#zone${index} .seqprogress`);
  zone.sequencerGridStepElements = DOM.all(`#zone${index} .seq .grid .step`);
  zone.dom.markerlow = DOM.element(`#zone${index} .marker.low`);
  zone.dom.markerhigh = DOM.element(`#zone${index} .marker.high`);
  zone.dom.join = DOM.element(`#zone${index} .join`);
  zone.dom.current = DOM.element(`#zone${index} .current`);
  renderMarkersForZone(index);
  renderControllersForZone(zone, index);
  initOutputPortsForZone(index);
  updateValuesForZone(index);
  zone.renderPattern();
  const dragHandler = DOM.element(`#zone${index} .dragzone`);
  dragHandler.addEventListener('mousedown', (ev) => {
    if (zones.list.length > 1) {
      new DragZone(index, ev, () => {
        triggerSave();
        renderZones();
      });
    }
  });

  DOM.all(`#zone${index} *[data-action]`).forEach((e) => {
    e.addEventListener('click', actionHandler);
  });
  DOM.all(`#zone${index} *[data-contextmenu]`).forEach((e) => {
    e.addEventListener('contextmenu', contextHandler);
  });
  DOM.all(`#zone${index} *[data-change]`).forEach((e) => {
    e.addEventListener('input', actionHandler);
  });
  DOM.all(`#zone${index} *[data-focus-change]`).forEach((e) => {
    e.addEventListener('focus', actionHandler);
    e.addEventListener('blur', actionHandler);
  });
  const followValueDiv = DOM.element('#valuefollow');
  DOM.all(`#zone${index} *[data-dragvalue]`).forEach((e) => {
    let dragstartx = 0;
    let dragvalue = 0;
    let isdragging = false;
    const hint = e.getAttribute('data-draghint');
    const updateDragValue = (ev) => {
      followValueDiv.style.top = ev.pageY + 'px';
      followValueDiv.style.left = ev.pageX + 'px';
      followValueDiv.innerHTML = hint + (dragvalue >= 0 ? '+' : '') + dragvalue;
    };
    e.addEventListener('mousedown', (ev) => {
      isdragging = true;
      dragstartx = ev.pageX;
      dragvalue = 0;
      followValueDiv.style.display = 'block';
      updateDragValue(ev);
    });
    e.addEventListener('mousemove', (ev) => {
      if (isdragging) {
        dragvalue = ev.pageX - dragstartx;
        updateDragValue(ev);
      }
    });
    const dragendhandler = (ev) => {
      if (isdragging) {
        isdragging = false;
        followValueDiv.style.display = 'none';
        dragvalue = ev.pageX - dragstartx;
        actionHandler(ev, { precalculatedValue: dragvalue });
      }
    };
    e.addEventListener('mouseup', dragendhandler);
    e.addEventListener('mouseleave', dragendhandler);
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
  DOM.all(`#zone${index} .pattern, #zone${index} .ch.solo`).forEach((e) => {
    e.addEventListener('dblclick', dblClickHandler);
  });
  let hideOnLeaveTimeout = null;
  const resetHideOnLeaveTimeout = () => {
    if (hideOnLeaveTimeout) {
      clearTimeout(hideOnLeaveTimeout);
    }
  };
  DOM.all(`#zone${index} .hideonleave`).forEach((e) => {
    e.addEventListener('mouseleave', function () {
      hideOnLeaveTimeout = setTimeout(() => {
        e.style.display = 'none';
      }, 667);
    });
    e.addEventListener('mousemove', function () {
      resetHideOnLeaveTimeout();
    });
  });
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
  const zone = zones.list[index];
  const low = tempLo != undefined ? tempLo : zone.low;
  const high = tempHigh != undefined ? tempHigh : zone.high;
  const xlow = low / 127.0;
  const xhi = high / 127.0;
  const xclow = zone.low / 127.0;
  const xchi = zone.high / 127.0;
  const width = DOM.element(`#zone${index} .range`).offsetWidth;
  const xpad = (0.75 / 127.0) * width;
  zone.dom.markerlow.style.left = `${xlow * width}px`;
  zone.dom.markerhigh.style.right = `${width - xhi * width - xpad}px`;
  zone.dom.markerlow.innerHTML =
    MIDI.NOTENAMES[low % 12] + (parseInt(low / 12) - 1);
  zone.dom.markerhigh.innerHTML =
    MIDI.NOTENAMES[high % 12] + (parseInt(high / 12) - 1);
  zone.dom.join.style.left = `${xlow * width}px`;
  zone.dom.join.style.right = `${width - xhi * width - xpad}px`;
  zone.dom.current.style.left = `${xclow * width}px`;
  zone.dom.current.style.right = `${width - xchi * width - xpad}px`;
  let ocount = 0;
  DOM.all(`#zone${index} .range .oct`, (e) => {
    ocount++;
    e.style.left = `${((ocount * 12.0) / 127.0) * width}px`;
    e.innerHTML = ocount - 1;
  });
  if (tempLo != undefined) {
    DOM.addClass(zone.dom.markerlow, 'hover');
  } else {
    DOM.removeClass(zone.dom.markerlow, 'hover');
  }
  if (tempHigh != undefined) {
    DOM.addClass(zone.dom.markerhigh, 'hover');
  } else {
    DOM.removeClass(zone.dom.markerhigh, 'hover');
  }
}

function renderControllersForZone(/** @type {Zone} */ zone, index) {
  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((e) => e.remove());
  DOM.addHTML(
    `#zone${index} .ccpots`,
    'afterbegin',
    zoneTemplate.getControllerHTML(zone, index)
  );
  const suckEvent = (e) => {
    e.stopPropagation();
  };
  DOM.on(`#zone${index} .ccpots input`, 'keyup', suckEvent);
  DOM.on(`#zone${index} .ccpots input`, 'focus', (e) => {
    e.target.select();
  });

  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((pot, ix) => {
    pot.addEventListener('wheel', (e) => {
      if (zone.cc_controllers[ix].type > 1) {
        return;
      }
      e.preventDefault();
      if (zone.editCC) {
        return;
      }
      const newV = Math.min(
        Math.max(
          parseInt(zone.cc_controllers[ix].val + Math.sign(e.deltaY)),
          0
        ),
        127
      );
      if (newV != zone.cc_controllers[ix].val) {
        zone.cc_controllers[ix].val = newV;
        zone.sendCC(ix);
        updateControllerValues(zone, index);
        triggerSave();
      }
    });
    pot.addEventListener('mousedown', (e) => {
      if (zone.cc_controllers[ix].type > 1 || zone.editCC) {
        return;
      }
      potDragHandler.startDrag(
        pot,
        e,
        (v) => {
          const oldVal = zone.cc_controllers[ix].val;
          if (v != oldVal) {
            zone.cc_controllers[ix].val = v;
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
  if (muted > 0) {
    DOM.addClass(elAllMuteOff, 'active');
  } else {
    DOM.removeClass(elAllMuteOff, 'active');
  }
  if (Zone.solocount > 0) {
    DOM.addClass(elAllSoloOff, 'active');
  } else {
    DOM.removeClass(elAllSoloOff, 'active');
  }
  if (held > 0) {
    DOM.addClass(elAllHoldOff, 'active');
  } else {
    DOM.removeClass(elAllHoldOff, 'active');
  }
}

function updateValuesForZone(index) {
  /** @type {Zone} */
  const zone = zones.list[index];
  const zoneElement = DOM.element(`#zone${index}`);
  function setPercent(className, pcnt) {
    DOM.element(`#zone${index} .percent.${className}`).value = pcnt;
    DOM.element(`#zone${index} output[for="${className}${index}"]`).value =
      pcnt + '%';
  }
  if (zoneElement) {
    zoneElement.dataset['colorindex'] = zone.colorIndex;
    DOM.removeClass(`#zone${index} *[data-action]`, 'selected');
    if (Zone.solocount > 0 && !zone.solo) {
      DOM.addClass(`#zone${index}`, 'soloed-out');
    } else {
      DOM.removeClass(`#zone${index}`, 'soloed-out');
    }
    const zoneIsEnabled = zone.enabled && (Zone.solocount === 0 || zone.solo);
    if (zoneIsEnabled) {
      DOM.removeClass(`#zone${index}`, 'disabled');
    } else {
      DOM.addClass(`#zone${index}`, 'disabled');
    }
    if (zone.show_cc) {
      DOM.addClass(`#zone${index}`, 'show-cc');
    } else {
      DOM.removeClass(`#zone${index}`, 'show-cc');
    }
    if (zone.sequence.active) {
      DOM.addClass(`#zone${index}`, 'show-seq');
      DOM.hide(zone.sequencerProgressElement);
      DOM.removeClass(
        `#zone${index} .seq .grid .step.selected-step`,
        'selected-step'
      );
      DOM.all(`#zone${index} .seq .grid .step`).forEach((e, i) => {
        if (i < zone.sequence.length) {
          DOM.removeClass(e, 'unused');
          if (zone.sequence.steps[i] && zone.sequence.steps[i].length > 0) {
            DOM.addClass(e, 'active');
          } else {
            DOM.removeClass(e, 'active');
          }
        } else {
          DOM.addClass(e, 'unused');
        }
      });
      if (zone.sequence.isLiveRecoding) {
        DOM.addClass(`#zone${index} .seq_record_live`, 'selected');
      } else {
        DOM.removeClass(`#zone${index} .seq_record_live`, 'selected');
      }
      if (zone.sequence.selectedStepNumber > -1) {
        DOM.addClass(`#zone${index} .seq`, 'has-selection');
        DOM.all(`#zone${index} .seq .grid .step`)[
          zone.sequence.selectedStepNumber
        ].classList.add('selected-step');
        if (zone.sequence.stepAddNotes) {
          DOM.addClass(`#zone${index} .seq-step-add-notes`, 'selected');
        }
        if (zone.sequence.stepAdvance) {
          DOM.addClass(`#zone${index} .seq-step-advance`, 'selected');
        }

        let step = zone.sequence.steps[zone.sequence.selectedStepNumber];
        if (step && step.length > 0) {
          let pcnt = parseInt(step.probability * 100);
          setPercent('seq_step_probability', pcnt);
          pcnt = parseInt(step.gateLength * 100);
          setPercent('seq_gatelength', pcnt);

          DOM.element(`#zone${index} .seq_step_condition`).selectedIndex =
            zone.sequence.steps[zone.sequence.selectedStepNumber].condition;
          DOM.element(`#zone${index} .seq_step_length`).value =
            zone.sequence.steps[zone.sequence.selectedStepNumber].length;
        } else {
          DOM.element(`#zone${index} .seq_step_length`).value = 1;
          DOM.element(`#zone${index} .seq_step_condition`).selectedIndex = 0;
          setPercent('seq_step_probability', 100);
          setPercent('seq_gatelength', 100);
        }
        zone.sequence.updateRecordingState();
      } else {
        DOM.removeClass(`#zone${index} .seq`, 'has-selection');
      }
      DOM.element(`#zone${index} .seq_steps`).value = zone.sequence.length;
      DOM.element(`#zone${index} .seq_division`).selectedIndex =
        zone.sequence.division;
      const layerIndicator = DOM.element(`#zone${index} .seq-layer-indicator`);
      if (zone.sequence.activeLayerIndex != zone.sequence.nextLayerIndex) {
        layerIndicator.classList.add('pending');
        layerIndicator.innerHTML = 'ABCD'.charAt(zone.sequence.nextLayerIndex);
      } else {
        layerIndicator.classList.remove('pending');
        layerIndicator.innerHTML = 'ABCD'.charAt(
          zone.sequence.activeLayerIndex
        );
      }
    } else {
      DOM.removeClass(`#zone${index}`, 'show-seq');
      if (zone.sequence.steps.length > 0) {
        DOM.show(zone.sequencerProgressElement);
      } else {
        DOM.hide(zone.sequencerProgressElement);
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
      if (zone[p]) {
        DOM.addClass(`#zone${index} .${p}`, 'selected');
      }
    });
    ['channel', 'arp_direction', 'arp_division', 'arp_octaves'].forEach((p) => {
      DOM.element(`#zone${index} .${p}`).selectedIndex = zone[p];
    });
    ['arp_gatelength', 'arp_probability'].forEach((p) => {
      const pcnt = parseInt(zone[p] * 100);
      const elem = DOM.element(`#zone${index} .percent.${p}`);
      elem.value = pcnt;
      elem.parentElement.querySelector('output').value = pcnt + '%';
    });
    if (zone.arp_enabled) {
      DOM.addClass(`#zone${index}`, 'arp-enabled');
    } else {
      DOM.removeClass(`#zone${index}`, 'arp-enabled');
    }
    DOM.all(`#zone${index} .octselect`, (e) => {
      const parts = e.getAttribute('data-action').split(':');
      if (parts[2] == zone.octave) {
        DOM.addClass(e, 'selected');
      }
    });
    setPercent('velocity_scaling', parseInt(zone.velocity_scaling * 100));
    DOM.element(`#euchits${index}`).value = zone.euclid_hits;
    DOM.element(`#euclen${index}`).value = zone.euclid_length;
    DOM.element(`#zone${index} input.programnumber`).value = zone.pgm_no
      ? zone.pgm_no
      : '';
    DOM.element(`#fixedvel${index}`).value = zone.fixedvel_value;
    const nameField = DOM.element(`#zone${index} .output-config-name`);
    if (zones.outputConfigNames[zones.list[index].configId]) {
      nameField.value = zones.outputConfigNames[zones.list[index].configId];
    } else {
      nameField.value = '';
      nameField.placeholder = DOM.element(
        `#zone${index} select.outport`
      ).selectedOptions[0].innerHTML;
    }
    if (midiController.clockOutputPorts[zone.outputPortId] === true) {
      DOM.addClass(`#zone${index} .sendClock`, 'selected');
    }
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

function updateControllerValues(/** @type {Zone} */ zone, zoneindex) {
  zone.cc_controllers.forEach((c, ix) => {
    const rangePath = describeArc(28, 30, 18, -135, 135);
    const valDegrees = 270 * (c.type == 1 ? (c.val - 64) / 64 : c.val / 127);
    const valuePath =
      c.type == 1
        ? describeArc(28, 30, 18, 0, valDegrees / 2)
        : describeArc(28, 30, 18, -135, -135 + valDegrees);
    DOM.element(`#pot_range_${zoneindex}_${ix}`).setAttribute('d', rangePath);
    DOM.element(`#pot_value_${zoneindex}_${ix}`).setAttribute('d', valuePath);
    DOM.element(`#pot_zero_${zoneindex}_${ix}`).style.display =
      c.type == 1 ? 'block' : 'none';
    const potcontainer = DOM.element(`#pot_${zoneindex}_${ix}`);
    potcontainer.dataset.type = c.type;
    DOM.element(`#pot_${zoneindex}_${ix} div.cclabel`).innerHTML = c.label;
    let displayValue = c.val;
    if (c.type == 0) {
      displayValue = zone.remapCCValue(c.val, ix);
    } else if (c.type == 1) {
      displayValue = displayValue - 64;
    }
    DOM.element(`#pot_${zoneindex}_${ix} .value`).innerHTML = displayValue;
    const tools = DOM.element(`#zone${zoneindex} .cc-editor`);

    if (c.type == 3) {
      // buttons
      for (let i = 0; i < 4; i++) {
        const btn = potcontainer.querySelector(`.ccbtn${i}`);
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
          const labelin = tools.querySelector(
            `input[data-change="${zoneindex}:cc_button_label:${i}"]`
          );
          const valuein = tools.querySelector(
            `input[data-change="${zoneindex}:cc_button_value:${i}"]`
          );
          labelin.value = label || '';
          valuein.value = typeof value == 'undefined' ? '' : value;
        }
      }
    }

    if (ix == zone.selectedCCIndex) {
      DOM.addClass(`#pot_${zoneindex}_${ix}`, 'selected');
      if (zone.editCC) {
        tools.dataset.type = c.type;
        tools.querySelector('.cclabel').value = c.label;
        tools.querySelector('.cc-in').value =
          typeof c.number_in == 'undefined' ? '' : c.number_in;
        tools.querySelector('.cc-out').value = c.number;
        tools.querySelector('.cc-min').value = c.min || 0;
        tools.querySelector('.cc-max').value = c.max || 127;
        tools.querySelector('.cc_change_type').value = c.type;
      }
    } else {
      DOM.removeClass(`#pot_${zoneindex}_${ix}`, 'selected');
    }
  });

  if (zone.editCC) {
    DOM.addClass(`#zone${zoneindex} .ccpots`, 'cc-edit');
  } else {
    DOM.removeClass(`#zone${zoneindex} .ccpots`, 'cc-edit');
  }
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
  const select = DOM.element(`#zone${index} select.outport`);
  DOM.empty(select);
  const noSelectionLabel =
    outputs.length > 0 ? '(select MIDI output)' : '(no outputs available)';
  DOM.addHTML(
    select,
    'beforeend',
    `<option value="*">${noSelectionLabel}</option>`
  );
  // DOM.element(`#zone${index} .output-config-name`).value =
  //   zones.outputConfigNames[zones.list[index].configId] || '';
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
  Sequence.ACTIVE_LAYER_INDEX = layerIndex;
  zones.list.forEach((zone) => {
    zone.sequence.nextLayerIndex = layerIndex;
    if (!clockRunning) {
      zone.sequence.activeLayerIndex = layerIndex;
    }
  });
  DOM.removeClass('#tools *[data-select-seq-layer]', 'selected');
  DOM.addClass(
    DOM.all('#tools *[data-select-seq-layer]')[layerIndex],
    'selected'
  );
  updateValuesForAllZones();
}

let toastTimer;
function toast(message, properties) {
  const triggerElement = properties.triggerElement;
  const longer = properties.longer;
  const position = properties.position;
  if (toastTimer) {
    clearTimeout(toastTimer);
    // toastHide();
  }
  DOM.element('#toast .toastinner').innerHTML = message;
  if (position) {
    toastElement.style.top = position.top;
    toastElement.style.left = position.left;
  } else if (triggerElement) {
    const srcRect = triggerElement.getBoundingClientRect();
    let top = srcRect.top + 26;
    console.log(srcRect, window.innerHeight);
    if (top > window.innerHeight - 40) {
      top = top - 26 * 2.25;
    }
    toastElement.style.top = top + 'px';
    toastElement.style.left = srcRect.left + 'px';
  } else {
    toastElement.style.top = toastElement.style.left = '';
  }
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
  toast
};
