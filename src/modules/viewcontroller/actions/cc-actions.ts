import { ActionContext, ActionHelpers, ActionMap } from '../types';
import { ipcRenderer } from 'electron';
import { CCController, CCControllerType, isHiResCC } from '../../zone/interfaces';
import { escapeHTML } from '../../domutils';
import {
  controllersFromPreset,
  findDevicePreset,
  getDevicePresets,
  saveDevicePreset
} from '../../device-presets';
import { askDevicePresetMeta } from '../device-preset-dialog';
import { openDevicePresetManager } from '../device-preset-manager';
import { openCCEditor } from '../cc-editor';
import { isSection, newSection } from '../../zone/cc-layout';

export function createCCActions(
  ctx: ActionContext,
  helpers: ActionHelpers,
  renderControllersForZone: (zone: typeof ctx.zone, index: number) => void
): ActionMap {
  const {
    zone, zoneindex, element, actionParam1, actionParam2, ev,
    zones, triggerSave,
    updateValuesForZone, updateControllerValues, toast
  } = ctx;

  // Digits only, clamped to 0–max; null while the field is empty
  const numberField = (max: number): number | null => {
    const input = element as HTMLInputElement;
    input.value = input.value.replace(/[^0-9]/g, '');
    if (input.value == '') return null;
    const value = Math.min(max, parseInt(input.value));
    if (String(value) !== input.value) input.value = String(value);
    return value;
  };
  const selected = (): CCController => zone.cc_controllers[zone.selectedCCIndex];
  // Min/Max are device units for NRPN, CC values otherwise
  const rangeMax = (): number => (selected().type == CCControllerType.NRPN ? 16383 : 127);

  // Knob positions of n evenly spread snap steps
  const evenSteps = (n: number): number[] => Array.from({ length: n }, (_, i) => Math.round((i * 127) / (n - 1)));

  const actions: ActionMap = {
    cc_toggle: () => {
      zone.show_cc = !zone.show_cc;
      updateValuesForZone(zoneindex);
      triggerSave();
      if (zone.show_cc) {
        toast('Double-click a controller to edit it');
      }
    },
    cc_send_all: () => {
      zone.sendAllCC();
      toast('All CC values sent');
    },
    cc_edit: () => {
      openCCEditor(zoneindex, actionParam1 != null ? parseInt(actionParam1) : undefined);
    },
    cc_label: () => {
      const c = selected();
      c.label = (element as HTMLInputElement).value;
      // A section's name is its heading in the zone
      if (isSection(c)) renderControllersForZone(zone, zoneindex);
      else updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_add_section: () => {
      // After the selected controller; each new section gets the next colour
      const insertAt = zone.cc_controllers[zone.selectedCCIndex] ? zone.selectedCCIndex + 1 : zone.cc_controllers.length;
      const sections = zone.cc_controllers.filter(isSection).length;
      zone.cc_controllers.splice(insertAt, 0, newSection('Section', (sections % 4) + 1));
      zone.selectedCCIndex = insertAt;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
    },
    cc_section_new_row: () => {
      const c = selected();
      if (c.new_row === false) delete c.new_row;
      else c.new_row = false;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
    },
    cc_number: () => {
      const value = numberField(127);
      if (value != null) {
        selected().number = value;
        triggerSave();
      }
    },
    cc_number_lsb: () => {
      const value = numberField(127);
      if (value != null) {
        selected().number_lsb = value;
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
      const value = numberField(127);
      if (value != null) {
        selected().nrpn_msb = value;
        triggerSave();
      }
    },
    cc_nrpn_lsb: () => {
      const value = numberField(127);
      if (value != null) {
        selected().nrpn_lsb = value;
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
      // Empty removes the hardware mapping
      selected().number_in = numberField(127);
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_min: () => {
      const value = numberField(rangeMax());
      if (value != null) {
        selected().min = value;
        updateControllerValues(zone, zoneindex);
        triggerSave();
      }
    },
    cc_max: () => {
      const value = numberField(rangeMax());
      if (value != null) {
        selected().max = value;
        updateControllerValues(zone, zoneindex);
        triggerSave();
      }
    },
    cc_snap: () => {
      // On: even steps (as many as there are names, or 8); off: a continuous knob
      const c = selected();
      if (c.discreteValues?.length) delete c.discreteValues;
      else c.discreteValues = evenSteps(Math.max(2, Math.min(64, c.valueNames?.length || 8)));
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_step_spread: () => {
      const n = parseInt(actionParam1);
      if (isNaN(n)) return;
      selected().discreteValues = evenSteps(Math.max(2, Math.min(64, n)));
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_step_value: () => {
      const value = numberField(127);
      const steps = selected().discreteValues;
      if (value == null || !steps) return;
      steps[parseInt(actionParam1)] = value;
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_step_remove: () => {
      const c = selected();
      const i = parseInt(actionParam1);
      c.discreteValues?.splice(i, 1);
      c.valueNames?.splice(i, 1);
      if (!c.discreteValues?.length) delete c.discreteValues;
      if (!c.valueNames?.length) delete c.valueNames;
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_value_add: () => {
      // A step after the last one (snapping knobs), or the name of the next value
      const c = selected();
      const steps = c.discreteValues;
      if (c.type == CCControllerType.UNIPOLAR_ROTARY && steps?.length) {
        const last = steps[steps.length - 1];
        const gap = steps.length > 1 ? last - steps[steps.length - 2] : 16;
        steps.push(Math.max(0, Math.min(127, last + Math.max(1, gap))));
        c.valueNames = c.valueNames ?? [];
        while (c.valueNames.length < steps.length - 1) c.valueNames.push('');
        c.valueNames.push('');
      } else {
        c.valueNames = [...(c.valueNames ?? []), ''];
      }
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_value_name: () => {
      const c = selected();
      const i = parseInt(actionParam1);
      const names = c.valueNames ?? [];
      while (names.length <= i) names.push('');
      names[i] = (element as HTMLInputElement).value.slice(0, 24);
      // Clearing the last name removes it (and other empty ones before it)
      if (i == names.length - 1) while (names.length > 0 && names[names.length - 1].trim() === '') names.pop();
      if (names.length > 0) c.valueNames = names;
      else delete c.valueNames;
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_learn: () => {
      zone.midiLearnCC = !zone.midiLearnCC;
      updateControllerValues(zone, zoneindex);
    },
    cc_clear_input: () => {
      selected().number_in = null;
      zone.midiLearnCC = false;
      updateControllerValues(zone, zoneindex);
      triggerSave();
    },
    cc_nrpn_bipolar: () => {
      const c = zone.cc_controllers[zone.selectedCCIndex];
      c.bipolar = !c.bipolar;
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
      const value = numberField(127);
      if (value != null) {
        (selected() as any)[`buttonvalue${actionParam1}`] = value;
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
            updateControllerValues(z, i);
          });
          triggerSave();
        }
      });
    },
    cc_add: () => {
      // After the selected controller, or at the end when none is selected
      const current = zone.cc_controllers[zone.selectedCCIndex];
      const insertAt = current ? zone.selectedCCIndex + 1 : zone.cc_controllers.length;
      // Same type as the selected controller; after a section or gap a knob
      const type =
        current && current.type != CCControllerType.SECTION && current.type != CCControllerType.SPACER
          ? current.type
          : CCControllerType.UNIPOLAR_ROTARY;
      const labels = new Set(zone.cc_controllers.map((c) => c.label));
      let n = zone.cc_controllers.length + 1;
      while (labels.has(`Ctrl #${n}`)) n++;
      const controller: any = {
        number: 1,
        number_in: null,
        min: 0,
        max: type == CCControllerType.NRPN ? 16383 : 127,
        type,
        label: `Ctrl #${n}`,
        val: 0,
        note_cc: null,
        velocity_cc: null,
        group: current && !isSection(current) ? current.group ?? 0 : 0
      };
      if (type == CCControllerType.NRPN) {
        controller.nrpn_data_lsb_cc = 38;
        controller.nrpn_data_lsb_bits = 7;
      }
      zone.cc_controllers.splice(insertAt, 0, controller);
      zone.selectedCCIndex = insertAt;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
      openCCEditor(zoneindex, insertAt);
    },
    cc_duplicate: () => {
      const current = zone.cc_controllers[zone.selectedCCIndex];
      if (!current) return;
      // A copy is not played by the same hardware control
      const copy = { ...JSON.parse(JSON.stringify(current)), number_in: null };
      zone.cc_controllers.splice(zone.selectedCCIndex + 1, 0, copy);
      zone.selectedCCIndex++;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
    },
    cc_remove: () => {
      const current = zone.cc_controllers[zone.selectedCCIndex];
      if (!current) return;
      zone.cc_controllers.splice(zone.selectedCCIndex, 1);
      // The next controller moves into place
      zone.selectedCCIndex = Math.min(zone.selectedCCIndex, zone.cc_controllers.length - 1);
      zone.midiLearnCC = false;
      renderControllersForZone(zone, zoneindex);
      triggerSave();
      toast(
        isSection(current)
          ? `Deleted section "${escapeHTML(current.label || 'row break')}": its controllers joined the one before (undo brings it back)`
          : `Deleted "${escapeHTML(current.label || 'controller')}" (undo brings it back)`
      );
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
    cc_group_set: () => {
      selected().group = parseInt(actionParam1);
      renderControllersForZone(zone, zoneindex);
      triggerSave();
    },
    cc_move_to: () => {
      const from = parseInt(actionParam1);
      const to = parseInt(actionParam2);
      if (!zone.cc_controllers[from] || to < 0 || to >= zone.cc_controllers.length || from == to) return;
      const [moved] = zone.cc_controllers.splice(from, 1);
      zone.cc_controllers.splice(to, 0, moved);
      zone.selectedCCIndex = to;
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
        const [moved] = zone.cc_controllers.splice(pos, 1);
        zone.cc_controllers.splice(targetPos, 0, moved);
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
