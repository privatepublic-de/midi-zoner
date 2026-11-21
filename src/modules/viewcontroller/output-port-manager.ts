import DOM, { escapeHTML as esc } from '../domutils';
import MIDI from '../midi';
import { ZonesData, PortDescriptor } from './types';

let cachedOutputPorts: PortDescriptor[] = [];
let cachedInputPorts: PortDescriptor[] = [];

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
      `<option value="${esc(port.id)}">${esc(port.name)}</option>`
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
      `<option value="${esc(port.id)}" data-full-name="${esc(port.fullName ?? port.name)}">${esc(port.name)}</option>`
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
          html += `<option value="$${esc(preset)}">${esc(zones.outputConfigNames[preset])}</option>`;
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

const byName = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** Output configs (named devices) on a port, by channel */
function devicesOn(zones: ZonesData, portId: string): Map<number, string> {
  const named = new Map<number, string>();
  for (const [key, name] of Object.entries(zones.outputConfigNames ?? {})) {
    const [port, ch] = key.split(',');
    if (port === portId && typeof name === 'string' && name) named.set(parseInt(ch), name);
  }
  return named;
}

/**
 * The In/Out popup's port and channel buttons (Nov 21, the user's pick from mocks): every visible
 * output port, alphabetical down the columns, then the 16 channels named after the devices set up
 * on that port. They stand in for the hidden selects `select.outport` / `select.channel`, which
 * still carry the value: a press sets the select and sends its usual input event (initOutGrid).
 */
export function renderOutGrid(zones: ZonesData, index: number): void {
  const zone = zones.list[index];
  const host = DOM.get(`#zone${index} .ior-out`) as HTMLElement | null;
  if (!zone || !host) return;
  const portsEl = host.querySelector('.ior-ports') as HTMLElement;
  const chsEl = host.querySelector('.ior-chs') as HTMLElement;
  const chHead = host.querySelector('.ior-chhead') as HTMLElement;
  const current = zone.preferredOutputPortId;
  const ports = [...cachedOutputPorts].sort((a, b) => byName(a.name, b.name));
  const items = ports.map((p) => ({ id: p.id, name: p.name, title: p.fullName ?? p.name, missing: false }));
  const currentPort = ports.find((p) => p.id === current);
  const missingName =
    !currentPort && current && current !== MIDI.INTERNAL_PORT_ID ? zones.knownPortNames?.[current] : undefined;
  if (typeof missingName === 'string' && missingName) {
    items.push({ id: current, name: missingName, title: `${missingName} isn't connected`, missing: true });
  }
  const key = JSON.stringify([items, current, zone.channel, zones.outputConfigNames]);
  if (host.dataset.key === key) return;
  host.dataset.key = key;

  portsEl.style.setProperty('--port-rows', String(Math.max(1, Math.ceil(items.length / 2))));
  portsEl.innerHTML = items.length
    ? items
        .map((p) => {
          const n = devicesOn(zones, p.id).size;
          const cls = 'ior-pick' + (p.id === current ? ' picked' : '') + (p.missing ? ' missing' : '');
          const count = n ? `<small>${n} ${n === 1 ? 'device' : 'devices'}</small>` : '';
          return `<div class="${cls}" data-port="${esc(p.id)}" title="${esc(p.title)}"><span>${esc(p.name)}</span>${count}</div>`;
        })
        .join('')
    : '<div class="ior-none">No MIDI outputs</div>';

  const portName = currentPort?.name ?? (typeof missingName === 'string' ? missingName : '');
  chHead.textContent = portName ? `Channel on ${portName}` : 'Channel';
  const named = currentPort || missingName ? devicesOn(zones, current) : new Map<number, string>();
  let chs = '';
  for (let ch = 0; ch < 16; ch++) {
    const device = named.get(ch);
    const cls = 'ior-pick' + (ch === zone.channel ? ' picked' : '') + (device ? ' named' : '');
    const title = device ? `${esc(device)} (channel ${ch + 1})` : `Channel ${ch + 1}`;
    chs += `<div class="${cls}" data-ch="${ch}" title="${title}"><b>${ch + 1}</b>${device ? `<span>${esc(device)}</span>` : ''}</div>`;
  }
  chsEl.innerHTML = chs;
}

/** A press on a port or channel button goes through the hidden select, as a pick there would */
export function initOutGrid(index: number): void {
  const host = DOM.get(`#zone${index} .ior-out`) as HTMLElement | null;
  if (!host) return;
  host.addEventListener('click', (ev) => {
    const pick = (ev.target as HTMLElement).closest('.ior-pick') as HTMLElement | null;
    if (!pick) return;
    let select: HTMLSelectElement;
    if (pick.dataset.port !== undefined) {
      select = host.querySelector('select.outport') as HTMLSelectElement;
      if (select.value === pick.dataset.port) return;
      select.value = pick.dataset.port;
    } else {
      select = host.querySelector('select.channel') as HTMLSelectElement;
      const ch = parseInt(pick.dataset.ch ?? '');
      if (isNaN(ch) || select.selectedIndex === ch) return;
      select.selectedIndex = ch;
    }
    select.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * The hidden port select shows the zone's port, or its named device when the port and channel have
 * one, so the name the zone shows (taken from the selected option) follows a channel press too.
 */
export function syncOutportSelect(zones: ZonesData, index: number): void {
  const zone = zones.list[index];
  const select = DOM.get(`#zone${index} select.outport`) as HTMLSelectElement | null;
  if (!zone || !select) return;
  const options = [...select.options].map((o) => o.value);
  const config = '$' + zone.preferredOutputPortId + ',' + zone.channel;
  if (options.includes(config)) select.value = config;
  else if (options.includes(zone.preferredOutputPortId)) select.value = zone.preferredOutputPortId;
}
