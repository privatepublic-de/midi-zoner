import { ActionContext, ActionHelpers, ActionMap } from '../types';
import { ipcRenderer } from 'electron';
import { labelForZone } from '../action-labels';
import { CCControllerType, isHiResCC } from '../../zone/interfaces';
import { escapeHTML } from '../../domutils';
import {
  controllersFromPreset,
  findDevicePreset,
  getDevicePresets,
  saveDevicePreset
} from '../../device-presets';
import { askDevicePresetMeta } from '../device-preset-dialog';
import { openDevicePresetManager } from '../device-preset-manager';

export function createCCActions(
  ctx: ActionContext,
  helpers: ActionHelpers,
  renderControllersForZone: (zone: typeof ctx.zone, index: number) => void
): ActionMap {
  const {
    zone, zoneindex, element, actionParam1, actionParam2, ev,
    zones, pushHistory, triggerSave,
    updateValuesForZone, updateControllerValues, toast
  } = ctx;

  const actions: ActionMap = {
    cc_toggle: () => {
      zone.show_cc = !zone.show_cc;
      updateValuesForZone(zoneindex);
      triggerSave();
      if (zone.show_cc) {
        toast('Right-click a controller to edit it');
      }
    },
    cc_send_all: () => {
      zone.sendAllCC();
      toast('All CC values sent');
    },
    cc_edit: () => {
      if (zone.cc_controllers.length === 0) return;
      zone.editCC = !zone.editCC;
      if (zone.selectedCCIndex < 0) zone.selectedCCIndex = 0;
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
      triggerSave();
    },
    cc_number: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number = parseInt(inputElement.value);
        triggerSave();
      }
    },
    cc_number_lsb: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_lsb = parseInt(inputElement.value);
        triggerSave();
      }
    },
    cc_14bit_format: () => {
      const c = zone.cc_controllers[zone.selectedCCIndex];
      const [bits, order] = (element as HTMLSelectElement).value.split(':');
      c.lsb_bits = parseInt(bits);
      c.msb_first = order == 'msb';
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_nrpn_msb: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].nrpn_msb = Math.min(127, parseInt(inputElement.value));
        triggerSave();
      }
    },
    cc_nrpn_lsb: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].nrpn_lsb = Math.min(127, parseInt(inputElement.value));
        triggerSave();
      }
    },
    cc_nrpn_data_lsb: () => {
      const c = zone.cc_controllers[zone.selectedCCIndex];
      const [cc, bits] = (element as HTMLSelectElement).value.split(':');
      c.nrpn_data_lsb_cc = bits ? parseInt(cc) : null;
      c.nrpn_data_lsb_bits = bits ? parseInt(bits) : 0;
      triggerSave();
    },
    cc_number_in: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].number_in = parseInt(inputElement.value);
        triggerSave();
      }
    },
    cc_min: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].min = parseInt(inputElement.value);
        updateControllerValues(zone, zoneindex);
        triggerSave();
      }
    },
    cc_max: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].max = parseInt(inputElement.value);
        updateControllerValues(zone, zoneindex);
        triggerSave();
      }
    },
    cc_discrete_values: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9,]/g, '');
      const raw = inputElement.value.trim();
      let discreteValues: number[];
      if (raw === '') {
        discreteValues = [];
      } else if (/^\d+$/.test(raw)) {
        // Single integer 2–64: auto-expand to N equal steps
        const n = parseInt(raw);
        if (n >= 2 && n <= 64) {
          const c = zone.cc_controllers[zone.selectedCCIndex];
          const maxVal = isHiResCC(c.type) ? 16383 : 127;
          discreteValues = Array.from({ length: n }, (_, i) =>
            Math.round(i * maxVal / (n - 1))
          );
        } else {
          discreteValues = [n].filter(v => !isNaN(v) && v >= 0);
        }
      } else {
        discreteValues = raw.split(',')
          .map(v => parseInt(v))
          .filter(v => !isNaN(v) && v >= 0);
      }
      zone.cc_controllers[zone.selectedCCIndex].discreteValues = discreteValues;
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_notenum2cc: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].note_cc = parseInt(inputElement.value);
      } else {
        zone.cc_controllers[zone.selectedCCIndex].note_cc = null;
      }
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_notevelocity2cc: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        zone.cc_controllers[zone.selectedCCIndex].velocity_cc = parseInt(inputElement.value);
      } else {
        zone.cc_controllers[zone.selectedCCIndex].velocity_cc = null;
      }
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_button_label: () => {
      (zone.cc_controllers[zone.selectedCCIndex] as any)[`buttonlabel${actionParam1}`] =
        (element as HTMLInputElement).value;
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_button_value: () => {
      const inputElement = element as HTMLInputElement;
      inputElement.value = inputElement.value.replace(/[^0-9]/g, '');
      if (inputElement.value != '') {
        (zone.cc_controllers[zone.selectedCCIndex] as any)[`buttonvalue${actionParam1}`] =
          parseInt(inputElement.value);
        updateControllerValues(zone, zoneindex);
        triggerSave();
      }
    },
    cc_button_trig: () => {
      const ccindex = parseInt(actionParam1);
      const btnindex = actionParam2;
      zone.cc_controllers[ccindex].val =
        (zone.cc_controllers[ccindex] as any)[`buttonvalue${btnindex}`];
      zone.sendCC(ccindex);
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_preset_apply: () => {
      const preset = findDevicePreset(actionParam1);
      if (!preset) return;
      // Shift-click appends to the existing controllers instead of replacing them
      const append = ev.shiftKey && zone.cc_controllers.length > 0;
      zone.cc_controllers = controllersFromPreset(preset, zone.cc_controllers, append);
      if (!append) zone.devicePreset = { id: preset.id, name: preset.name };
      zone.selectedCCIndex = Math.min(zone.selectedCCIndex, zone.cc_controllers.length - 1);
      zone.show_cc = true;
      renderControllersForZone(zone, zoneindex);
      updateValuesForZone(zoneindex);
      triggerSave();
      toast(
        append
          ? `Added ${preset.controllers.length} controllers from "${escapeHTML(preset.name)}"`
          : `Applied preset "${escapeHTML(preset.name)}" (⇧-click appends instead)`
      );
    },
    cc_preset_save: async () => {
      const linked = findDevicePreset(zone.devicePreset?.id);
      const portName = zones.knownPortNames?.[zone.outputPortId];
      const meta = await askDevicePresetMeta(
        {
          name: linked?.name ?? zone.label ?? '',
          device: linked?.device ?? portName ?? '',
          portMatch: linked?.portMatch ?? portName ?? '',
          notes: linked?.notes ?? ''
        },
        [...new Set(getDevicePresets().map((p) => p.device))]
      );
      if (!meta) return;
      try {
        const saved = await saveDevicePreset(meta, zone.cc_controllers, null);
        if (!saved) return;
        zone.devicePreset = { id: saved.id, name: saved.name };
        updateControllerValues(zone, zoneindex);
        triggerSave();
        toast(`Saved device preset "${escapeHTML(saved.name)}"`);
      } catch (e) {
        toast(`Could not save the preset: ${escapeHTML(String(e))}`, { warning: true });
      }
    },
    cc_preset_update: async () => {
      const linked = findDevicePreset(zone.devicePreset?.id);
      if (!linked || linked.source != 'user') return;
      const confirmed: boolean = await ipcRenderer.invoke(
        'open-confirm',
        'Update device preset',
        `Overwrite preset "${linked.name}" with the controllers of this zone?`
      );
      if (!confirmed) return;
      try {
        await saveDevicePreset(linked, zone.cc_controllers, linked.id);
        updateControllerValues(zone, zoneindex);
        toast(`Updated device preset "${escapeHTML(linked.name)}"`);
      } catch (e) {
        toast(`Could not save the preset: ${escapeHTML(String(e))}`, { warning: true });
      }
    },
    cc_presets_manage: () => {
      openDevicePresetManager({
        usage: (id) => zones.list.filter((z) => z.devicePreset?.id === id).length,
        changed: () => {
          // Linked zones show the preset's current name (deleted presets keep the last one)
          zones.list.forEach((z, i) => {
            const preset = findDevicePreset(z.devicePreset?.id);
            if (preset && z.devicePreset) z.devicePreset.name = preset.name;
            if (z.editCC) updateControllerValues(z, i);
          });
          triggerSave();
        }
      });
    },
    cc_add: () => {
      // After the selected controller, or at the end when none is selected
      const selected = zone.cc_controllers[zone.selectedCCIndex];
      const insertAt = selected ? zone.selectedCCIndex + 1 : zone.cc_controllers.length;
      const type = selected?.type ?? CCControllerType.UNIPOLAR_ROTARY;
      zone.cc_controllers.splice(insertAt, 0, {
        number: 1,
        number_in: null,
        min: 0,
        max: type == CCControllerType.NRPN ? 16383 : 127,
        type,
        label: `Ctrl #${insertAt + 1}`,
        val: 0,
        note_cc: null,
        velocity_cc: null
      } as any);
      zone.selectedCCIndex = insertAt;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
    },
    cc_remove: async () => {
      const snapshotBeforeRemove = JSON.stringify(zones);
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
            pushHistory(snapshotBeforeRemove, labelForZone(zone, zoneindex, `Remove CC ${description}`));
            zone.cc_controllers.splice(zone.selectedCCIndex, 1);
            zone.selectedCCIndex--;
            renderControllersForZone(zone, zoneindex);
            triggerSave();
          }
        });
    },
    cc_change_type: () => {
      const c = zone.cc_controllers[zone.selectedCCIndex];
      const newType = parseInt((element as HTMLSelectElement).value);
      // Keep the knob position when the value range changes between 0–127 and 0–16383
      if (isHiResCC(newType) && !isHiResCC(c.type)) {
        c.val = c.val << 7;
      } else if (!isHiResCC(newType) && isHiResCC(c.type)) {
        c.val = c.val >> 7;
      }
      if (newType == CCControllerType.NRPN && c.type != CCControllerType.NRPN) {
        if ((c.max ?? 127) <= 127) c.max = 16383;
        if (c.nrpn_data_lsb_cc === undefined) {
          c.nrpn_data_lsb_cc = 38;
          c.nrpn_data_lsb_bits = 7;
        }
      } else if (newType != CCControllerType.NRPN && c.type == CCControllerType.NRPN) {
        c.min = Math.min(c.min || 0, 127);
        c.max = Math.min(c.max ?? 127, 127);
      }
      c.type = newType;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
    },
    cc_change_group: () => {
      zone.cc_controllers[zone.selectedCCIndex].group = (element as HTMLSelectElement).selectedIndex;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
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
        triggerSave();
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
