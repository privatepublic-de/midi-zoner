import MIDI from '../../midi';
import { ActionContext, ActionHelpers, ActionMap } from '../types';
import { ipcRenderer } from 'electron';

export function createZoneActions(
  ctx: ActionContext,
  helpers: ActionHelpers
): ActionMap {
  const {
    zone, zoneindex, sequence, element, actionParam1, ev,
    zones, midiController, triggerSave, pushHistory,
    updateValuesForZone, updateValuesForAllZones,
    renderMarkersForZone, renderZones, listUsedPorts,
    updateOutputPortsForZone, cachedOutputPorts,
    updateInputPortsForZone, cachedInputPorts, findTouchedNote
  } = ctx;
  const { applySelectedIndex } = helpers;

  return {
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
      const snapshotBeforeDelete = JSON.stringify(zones);
      const number = zoneindex + 1;
      await ipcRenderer
        .invoke(
          'open-confirm',
          'Delete zone #' + number,
          'Do you really want to delete zone number ' + number + '?'
        )
        .then((result: boolean) => {
          if (result == true) {
            pushHistory(snapshotBeforeDelete);
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
        zone.preferredOutputPortId = selectElement.value;
        zone.outputPortId = cachedOutputPorts.find((p) => p.id === selectElement.value)
          ? selectElement.value
          : MIDI.INTERNAL_PORT_ID;
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
      updateOutputPortsForZone(zoneindex, cachedOutputPorts);
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
    zone_label: () => {
      zone.label = (element as HTMLInputElement).value;
    },
    zone_input_port: () => {
      const select = element as HTMLSelectElement;
      zone.inputPortId = select.value || null;
      const portIds = new Set<string>();
      zones.list.forEach((z) => { if (z.inputPortId) portIds.add(z.inputPortId); });
      midiController.zoneInputPorts = portIds;
      midiController.selectDevices(midiController.deviceIdInClock);
      updateValuesForZone(zoneindex);
    },
    zone_input_channel: () => {
      const select = element as HTMLSelectElement;
      const val = parseInt(select.value);
      zone.inputChannel = isNaN(val) || val < 0 ? null : val;
      updateValuesForZone(zoneindex);
    },
    iorouting_toggle: () => {
      const popup = zone._$('.iorouting-popup') as HTMLElement;
      if (popup) {
        popup.style.display = popup.style.display === 'block' ? 'none' : 'block';
      }
    },
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
  };
}
