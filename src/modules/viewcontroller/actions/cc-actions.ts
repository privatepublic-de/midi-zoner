import { ActionContext, ActionHelpers, ActionMap } from '../types';
import { ipcRenderer } from 'electron';

export function createCCActions(
  ctx: ActionContext,
  helpers: ActionHelpers,
  renderControllersForZone: (zone: typeof ctx.zone, index: number) => void
): ActionMap {
  const {
    zone, zoneindex, element, actionParam1, actionParam2, ev,
    updateValuesForZone, updateControllerValues, toast
  } = ctx;

  const actions: ActionMap = {
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
        zone.cc_controllers[zone.selectedCCIndex].number = parseInt(inputElement.value);
      }
    },
    cc_number_lsb: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_lsb = parseInt(inputElement.value);
      }
    },
    cc_number_in: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_in = parseInt(inputElement.value);
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
        zone.cc_controllers[zone.selectedCCIndex].note_cc = parseInt(inputElement.value);
      } else {
        zone.cc_controllers[zone.selectedCCIndex].note_cc = null;
      }
      updateControllerValues(zone, zoneindex);
    },
    cc_notevelocity2cc: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].velocity_cc = parseInt(inputElement.value);
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
        (zone.cc_controllers[zone.selectedCCIndex] as any)[`buttonvalue${actionParam1}`] =
          parseInt(inputElement.value);
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
  };

  return actions;
}
