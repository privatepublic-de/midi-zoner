import MIDI from '../../midi';
import { takeStore } from '../../take-store';
import { ActionContext, ActionHelpers, ActionMap } from '../types';
import { ipcRenderer } from 'electron';
import { MpeMode, sanitizeBendRange, sanitizePressureFrom, zoneInputClaims } from '../../zone/mpe';
import { ARRANGEMENT_LETTERS, labelForZone } from '../action-labels';

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
    findTouchedNote,
    toast
  } = ctx;
  const { applySelectedIndex } = helpers;

  /** Ports and channels zones listen to beyond the global input selection */
  const syncZoneInputs = (): void => {
    const claims = zoneInputClaims(zones.list);
    midiController.zoneInputPorts = claims.ports;
    midiController.zoneAllChannels = claims.allChannels;
    midiController.selectDevices(midiController.deviceIdInClock);
  };

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
        sequence.isLiveRecording = false;
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
            pushHistory(snapshotBeforeDelete, labelForZone(zone, zoneindex, 'Delete'));
            const scrollPos = window.scrollY;
            zone.releasePedal();
            zone.dismiss();
            zones.list.splice(zoneindex, 1);
            midiController.updateUsedPorts(listUsedPorts());
            syncZoneInputs();
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
        const parts = selectElement.value.slice(1).split(',');
        zone.channel = parseInt(parts[1]);
        zone.preferredOutputPortId = zone.outputPortId = parts[0];
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
      zone.sendMpeSetup();
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
      syncZoneInputs();
      updateValuesForZone(zoneindex);
    },
    zone_mpe: () => {
      const mode = parseInt((element as HTMLSelectElement).value);
      zone.setMpe(mode === MpeMode.PASS || mode === MpeMode.COLLAPSE ? mode : MpeMode.OFF);
      syncZoneInputs();
      zone.sendMpeSetup();
      updateValuesForZone(zoneindex);
    },
    zone_mpe_setup: () => {
      toast(zone.sendMpeSetup() ? 'MPE setup sent' : 'No output port to send the MPE setup to', { warning: zone.outputPortId === MIDI.INTERNAL_PORT_ID });
    },
    zone_mpe_bend_in: () => {
      zone.mpe_bend_in = sanitizeBendRange((element as HTMLInputElement).value, zone.mpe_bend_in);
      zone.sendMpeSetup(); // the synth's member bend range follows
      updateValuesForZone(zoneindex);
    },
    zone_mpe_pass_bend_out: () => {
      zone.mpe_pass_bend_out = sanitizeBendRange((element as HTMLInputElement).value, zone.mpe_pass_bend_out);
      zone.sendMpeSetup(); // for synths that take the bend range from it
      updateValuesForZone(zoneindex);
    },
    zone_mpe_bend_out: () => {
      zone.mpe_bend_out = sanitizeBendRange((element as HTMLInputElement).value, zone.mpe_bend_out);
      updateValuesForZone(zoneindex);
    },
    zone_mpe_poly_at: () => {
      zone.setMpePolyAT((element as HTMLSelectElement).value === '1');
      updateValuesForZone(zoneindex);
    },
    zone_mpe_at_from: () => {
      zone.mpe_at_from = sanitizePressureFrom((element as HTMLInputElement).value, zone.mpe_at_from);
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
    zone_export: async () => {
      // with its takes (they aren't part of the scene data)
      const takes = takeStore.toJSON(zone.id);
      const payload = JSON.stringify({ list: [{ ...zone.toJSON(), ...(takes.length ? { takes } : {}) }] });
      await ipcRenderer
        .invoke('open-save', payload)
        .then((result: { canceled: boolean; message: string; warning?: boolean }) => {
          if (!result.canceled) {
            toast(result.message, { warning: result.warning });
          }
        });
    },
    zone_arr_copy_to: () => {
      const targetIndex = parseInt(actionParam1);
      if (isNaN(targetIndex) || targetIndex < 0 || targetIndex > 3) return;
      zone.copyArrangementTo(targetIndex);
      toast(`Arrangement ${ARRANGEMENT_LETTERS[zones.arrangementIndex]} → ${ARRANGEMENT_LETTERS[targetIndex]} copied`);
    },
  };
}
