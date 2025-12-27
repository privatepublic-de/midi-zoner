import DOM from '../domutils';
import MIDI from '../midi';
import { ZonesData, PortDescriptor } from './types';

let cachedOutputPorts: PortDescriptor[] = [];

export function getCachedOutputPorts(): PortDescriptor[] {
  return cachedOutputPorts;
}

export function listUsedPorts(zones: ZonesData): Set<string> {
  const usedPorts = new Set<string>();
  for (let i = 0; i < zones.list.length; i++) {
    usedPorts.add(zones.list[i].outputPortId);
  }
  return usedPorts;
}

export function updateOutputPortsForAllZones(
  zones: ZonesData,
  outputs: PortDescriptor[],
  updateValuesForAllZones: () => void
): Set<string> {
  cachedOutputPorts = outputs;
  for (let i = 0; i < zones.list.length; i++) {
    updateOutputPortsForZone(zones, i, outputs, updateValuesForAllZones);
  }
  return listUsedPorts(zones);
}

export function initOutputPortsForZone(
  zones: ZonesData,
  index: number,
  updateValuesForAllZones: () => void
): void {
  if (cachedOutputPorts.length > 0) {
    updateOutputPortsForZone(zones, index, cachedOutputPorts, updateValuesForAllZones);
  }
}

export function updateOutputPortsForZone(
  zones: ZonesData,
  index: number,
  outputs: PortDescriptor[],
  updateValuesForAllZones: () => void
): void {
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
