import DOM from '../domutils';
import MIDI from '../midi';
import { ZonesData, PortDescriptor } from './types';

let cachedOutputPorts: PortDescriptor[] = [];
let cachedInputPorts: PortDescriptor[] = [];

function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getCachedOutputPorts(): PortDescriptor[] {
  return cachedOutputPorts;
}

export function getCachedInputPorts(): PortDescriptor[] {
  return cachedInputPorts;
}

export function updateInputPortsForAllZones(
  zones: ZonesData,
  inputs: PortDescriptor[]
): void {
  cachedInputPorts = inputs;
  for (let i = 0; i < zones.list.length; i++) {
    updateInputPortsForZone(zones, i, inputs);
  }
}

export function initInputPortsForZone(
  zones: ZonesData,
  index: number
): void {
  if (cachedInputPorts.length > 0) {
    updateInputPortsForZone(zones, index, cachedInputPorts);
  }
}

export function updateInputPortsForZone(
  zones: ZonesData,
  index: number,
  inputs: PortDescriptor[]
): void {
  const select = DOM.get(`#zone${index} select.inport`) as HTMLSelectElement;
  if (!select) return;
  DOM.empty(select);
  DOM.addHTML(select, 'beforeend', '<option value="">Global</option>');
  inputs.forEach((port) => {
    DOM.addHTML(
      select,
      'beforeend',
      `<option value="${port.id}">${port.name}</option>`
    );
  });
  const inputPortId = zones.list[index].inputPortId;
  if (typeof inputPortId === 'string' && inputPortId && !inputs.find((p) => p.id === inputPortId)) {
    const missingName = zones.knownPortNames?.[inputPortId];
    if (typeof missingName === 'string' && missingName) {
      DOM.addHTML(
        select,
        'beforeend',
        `<option value="${esc(inputPortId)}">⚠ missing: ${esc(missingName)}</option>`
      );
    }
  }
  select.value = inputPortId || '';
}

export function listUsedPorts(zones: ZonesData): Set<string> {
  const usedPorts = new Set<string>();
  for (let i = 0; i < zones.list.length; i++) {
    usedPorts.add(zones.list[i].outputPortId);
  }
  return usedPorts;
}

const _noop = (): void => {};

export function updateOutputPortsForAllZones(
  zones: ZonesData,
  outputs: PortDescriptor[],
  updateValuesForAllZones: () => void
): Set<string> {
  cachedOutputPorts = outputs;
  for (let i = 0; i < zones.list.length; i++) {
    updateOutputPortsForZone(zones, i, outputs, _noop);
  }
  updateValuesForAllZones();
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
    const configId = preferredOutputPortId + ',' + zones.list[index].channel;
    if (zones.outputConfigNames?.[configId]) {
      select.value = '$' + configId;
    }
  } else {
    const missingName = preferredOutputPortId !== MIDI.INTERNAL_PORT_ID
      ? zones.knownPortNames?.[preferredOutputPortId]
      : undefined;
    if (typeof missingName === 'string' && missingName) {
      DOM.addHTML(
        select,
        'beforeend',
        `<option value="${esc(preferredOutputPortId)}">⚠ missing: ${esc(missingName)}</option>`
      );
      select.value = preferredOutputPortId;
    } else {
      select.value = MIDI.INTERNAL_PORT_ID;
    }
    zones.list[index].outputPortId = MIDI.INTERNAL_PORT_ID;
  }
  updateValuesForAllZones();
}
