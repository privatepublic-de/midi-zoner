import DOM from '../modules/domutils';
import { Zone } from '../modules/zone/zone-class';
import { Sequence } from '../modules/zone/sequence';
import { DIV_TICKS } from '../modules/zone/seq-layer';
import MIDI from '../modules/midi';
import * as view from '../modules/viewcontroller';
import { ipcRenderer, webFrame } from 'electron';
import { ZoneArrangementJSON } from '../modules/zone/interfaces';
import { UndoHistory } from '../modules/undo-history';

// Type aliases for class types
type ZoneType = Zone;
type MIDIInstance = InstanceType<typeof MIDI>;

interface InputPortDef {
  id: string;
  ch: number;
  isSelected: boolean;
}

interface ZonesData {
  list: ZoneType[];
  inChannel: number;
  clockOutputPorts: Record<string, boolean>;
  clockSuppressTransportPorts: Record<string, boolean>;
  selectedInputPorts: Record<string, InputPortDef>;
  tempo: number;
  sendInternalClockIfPlaying: boolean;
  outputConfigNames: Record<string, string>;
  arrangementIndex: number;
  nextArrangementIndex: number;
  arrangementQuantIndex: number;
  keySwitchEnabled: boolean;
  knownPortNames: Record<string, string>;
}

interface PortDescriptor {
  id: string;
  name: string;
  fullName: string;
  isSelectedClockInput?: boolean;
}

const zones: ZonesData = {
  list: [],
  inChannel: 0,
  clockOutputPorts: {},
  clockSuppressTransportPorts: {},
  selectedInputPorts: {},
  tempo: 120,
  sendInternalClockIfPlaying: false, // TODO misnamed; means send everything
  outputConfigNames: {},
  arrangementIndex: 0,
  nextArrangementIndex: 0,
  arrangementQuantIndex: 2,
  keySwitchEnabled: true,
  knownPortNames: {}
};

const debounce = function <T extends (...args: any[]) => void>(
  func: T,
  delay: number
): T {
  let timer: ReturnType<typeof setTimeout>;
  return function (this: any, ...args: any[]) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  } as T;
};

const saveZones = debounce(() => {
  localStorage.setItem('zones', JSON.stringify(zones));
}, 500);

const undoHistory = new UndoHistory();

const channelOptions = (function (): string {
  var result = '';
  for (var i = 0; i < 16; i++) {
    result += `<option>Ch ${i + 1}</option>`;
  }
  return result;
})();

function syncZoneInputPorts(midi: MIDIInstance): void {
  const portIds = new Set<string>();
  zones.list.forEach((zone) => {
    if (zone.inputPortId) portIds.add(zone.inputPortId);
  });
  midi.zoneInputPorts = portIds;
  midi.selectDevices(midi.deviceIdInClock);
  zones.selectedInputPorts = midi.selectedInputPorts;
}

function loadZones(midi: MIDIInstance): void {
  const zonesJson = localStorage.getItem('zones');
  if (zonesJson) {
    applyStoredZones(JSON.parse(zonesJson), midi);
    syncZoneInputPorts(midi);
  }
}

function migrateFromLegacyZone(zoneData: any): ZoneArrangementJSON[] {
  const oldLayers: any[] = zoneData.sequence?.layers || [];
  const baseFields = {
    enabled: zoneData.enabled ?? true,
    solo: zoneData.solo ?? false,
    octave: zoneData.octave ?? 0,
    fixedvel: zoneData.fixedvel ?? false,
    fixedvel_value: zoneData.fixedvel_value ?? 127,
    velocity_scaling: zoneData.velocity_scaling ?? 1,
    mod: zoneData.mod ?? true,
    sustain: zoneData.sustain ?? true,
    cc: zoneData.cc ?? false,
    at2mod: zoneData.at2mod ?? false,
    pitchbend: zoneData.pitchbend ?? true,
    programchange: zoneData.programchange ?? false,
    arp_enabled: zoneData.arp_enabled ?? false,
    arp_hold: zoneData.arp_hold ?? false,
    arp_direction: zoneData.arp_direction ?? 0,
    arp_octaves: zoneData.arp_octaves ?? 0,
    arp_division: zoneData.arp_division ?? 11,
    arp_gatelength: zoneData.arp_gatelength ?? 0.5,
    arp_repeat: zoneData.arp_repeat ?? 0,
    arp_probability: zoneData.arp_probability ?? 1,
    arp_velocity: zoneData.arp_velocity ?? 0,
    arp_transpose: zoneData.arp_transpose ?? false,
    arp_transpose_amount: zoneData.arp_transpose_amount ?? 0,
    arp_pattern: zoneData.arp_pattern ?? [true, true, true, true, true, true, true, true],
    arp_holdlist: zoneData.arp_holdlist ?? [],
    arp_sortedHoldList: zoneData.arp_sortedHoldList ?? [],
    euclid_hits: zoneData.euclid_hits ?? 5,
    euclid_length: zoneData.euclid_length ?? 8,
  };
  // Map each legacy seq layer (A/B/C/D) to the corresponding arrangement
  return [0, 1, 2, 3].map((i) => {
    const layer = oldLayers[i] || oldLayers[0] || {};
    return {
      ...baseFields,
      sequence: {
        active: zoneData.sequence?.active ?? false,
        steps: layer.steps ?? [],
        length: layer.length ?? 16,
        ticks: layer.ticks ?? DIV_TICKS[14],
        division: layer.division ?? 14,
        isDrumSequence: zoneData.sequence?.isDrumSequence ?? false,
        drumLanes: zoneData.sequence?.drumLanes ?? 4,
        drum_lanes: layer.drum_lanes ?? []
      }
    };
  });
}

function createZone(midi: MIDIInstance, zoneData: any): Zone {
  const zone = new Zone(midi);

  zone.channel = zoneData.channel ?? 0;
  zone.preferredOutputPortId = zoneData.preferredOutputPortId ?? MIDI.INTERNAL_PORT_ID;
  zone.outputPortId = zoneData.preferredOutputPortId ?? MIDI.INTERNAL_PORT_ID;
  zone.inputPortId = zoneData.inputPortId ?? null;
  zone.inputChannel = zoneData.inputChannel ?? null;
  zone.label = zoneData.label ?? '';
  zone.low = zoneData.low ?? 0;
  zone.high = zoneData.high ?? 127;
  zone.show_cc = zoneData.show_cc ?? false;
  zone.pgm_no = zoneData.pgm_no ?? null;
  zone.bank_msb = zoneData.bank_msb ?? null;
  zone.bank_lsb = zoneData.bank_lsb ?? null;
  if (zoneData.cc_controllers) zone.cc_controllers = zoneData.cc_controllers;
  if (zoneData.colorIndex != null) zone.colorIndex = zoneData.colorIndex;

  if (Array.isArray(zoneData.arrangements) && zoneData.arrangements.length > 0) {
    zone.arrangements = [...zoneData.arrangements];
    while (zone.arrangements.length < 4) {
      zone.arrangements.push(JSON.parse(JSON.stringify(zone.arrangements[0])));
    }
  } else {
    zone.arrangements = migrateFromLegacyZone(zoneData);
  }

  zone.loadArrangement(zones.arrangementIndex || 0);
  return zone;
}

function applyStoredZones(
  storedZones: Partial<ZonesData> & { list?: object[] },
  midi: MIDIInstance,
  append?: boolean
): void {
  if (storedZones) {
    if (append) {
      // add storedZones to existing zones, but don't overwrite any settings
      for (let i = 0; i < (storedZones.list?.length ?? 0); i++) {
        zones.list.push(createZone(midi, storedZones.list![i]));
      }
    } else {
      // overwrite existing zones with stored zones
      zones.list.forEach((z) => z.dismiss());
      Object.assign(zones, storedZones);
      if (!zones.tempo || !isFinite(zones.tempo)) zones.tempo = 120;
      // Ensure knownPortNames values are strings (old data may have stored objects)
      if (zones.knownPortNames) {
        for (const key of Object.keys(zones.knownPortNames)) {
          if (typeof zones.knownPortNames[key] !== 'string') {
            delete zones.knownPortNames[key];
          }
        }
      }
      zones.list = [];
      for (let i = 0; i < (storedZones.list?.length ?? 0); i++) {
        zones.list.push(createZone(midi, storedZones.list![i]));
      }
      Sequence.setQuantDiv(zones.arrangementQuantIndex ?? 2);
    }
    midi.clockOutputPorts = zones.clockOutputPorts;
    midi.suppressTransportPorts = zones.clockSuppressTransportPorts ?? {};
    midi.selectedInputPorts = zones.selectedInputPorts;
  }
}

const closeQueue: (() => void)[] = [];

function bodyClickHandler(): void {
  let callback = closeQueue.pop();
  if (callback) {
    callback();
  }

}

function onBackgroundClick(
  callback: () => void,
  filterElement: string | Element
): void {
  DOM.on(filterElement, 'click', (ev) => {
    ev.stopPropagation();
  });
  closeQueue.push(callback);
}

let hideOnLeaveContextMenuTimeout: ReturnType<typeof setTimeout> | null = null;
function resetHideOnLeaveContextMenuTimeout(): void {
  if (hideOnLeaveContextMenuTimeout) {
    clearTimeout(hideOnLeaveContextMenuTimeout);
  }
}

function closeContextMenu(): void {
  resetHideOnLeaveContextMenuTimeout();
  (DOM.get('#contextmenu') as HTMLElement).style.display = 'none';
  DOM.removeClass('*', 'contextMenuTrigger');
}

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STORAGE_KEY = 'zoomFactor';
let currentZoomFactor = parseFloat(localStorage.getItem(ZOOM_STORAGE_KEY) || '1');

function applyZoom(factor: number): void {
  currentZoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(factor * 10) / 10));
  webFrame.setZoomFactor(currentZoomFactor);
  localStorage.setItem(ZOOM_STORAGE_KEY, String(currentZoomFactor));
}

applyZoom(currentZoomFactor);

document.addEventListener('DOMContentLoaded', function () {
  DOM.get('#zoomIn')!.addEventListener('click', () => applyZoom(currentZoomFactor + ZOOM_STEP));
  DOM.get('#zoomOut')!.addEventListener('click', () => applyZoom(currentZoomFactor - ZOOM_STEP));
  DOM.get('#zoomReset')!.addEventListener('click', () => applyZoom(1.0));
  const contextMenuElement = DOM.get('#contextmenu') as HTMLElement;
  DOM.on(document, 'click', bodyClickHandler);
  const select_in_clock = DOM.get('#midiClockInDeviceId') as HTMLSelectElement;
  const select_mackie = DOM.get('#mackieControlDeviceId') as HTMLSelectElement;
  const select_mackie_out = DOM.get('#mackieControlOutputDeviceId') as HTMLSelectElement;
  const startClockButton = DOM.get('#startClockButton') as HTMLElement;
  const bpmInput = DOM.get('#bpm') as HTMLInputElement;
  document.getElementById('zones')!.addEventListener('mousedown', (e) => {
    if (!midi.deviceIdMackieControl && !midi.deviceIdMackieOutput) return;
    const zoneEl = (e.target as Element).closest('#zones > .zone[id^="zone"]') as HTMLElement | null;
    if (!zoneEl) return;
    const zoneIndex = parseInt(zoneEl.id.replace('zone', ''));
    if (isNaN(zoneIndex) || zoneIndex === mackieSelectedZone) return;
    mackieSelectedZone = zoneIndex;
    sendMackieLeds();
  });
  const optionNoDevice = '<option value="">(No devices available)</option>';
  function updateBpmInput(): void {
    if (midi.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      DOM.addClass('.clocksettings', 'isInternal');
      DOM.removeClass('.clocksettings', 'isExternal');
      bpmInput.setAttribute('type', 'number');
      if (document.activeElement !== bpmInput) bpmInput.value = String(zones.tempo);
      bpmInput.disabled = false;
    } else {
      DOM.removeClass('.clocksettings', 'isInternal');
      DOM.addClass('.clocksettings', 'isExternal');
      bpmInput.setAttribute('type', 'text');
      bpmInput.value = midi.detectedBpm !== null ? midi.detectedBpm.toFixed(1) : '---';
      bpmInput.disabled = true;
    }
  }
  function updateClockOutputCount(): void {
    let count = 0;
    for (const [portid, enabled] of Object.entries(midi.clockOutputPorts)) {
      let present = false;
      midi.outputPortsRegistered.forEach((p: PortDescriptor) => {
        if (parseInt(p.id) == parseInt(portid)) {
          present = true;
        }
      });
      if (enabled && present) {
        count++;
      }
    }
    (DOM.get('#clockOutPortsCount') as HTMLElement).innerHTML =
      count > 0 ? String(count) : '-';
  }

  function updateInputDisplay(inputs: PortDescriptor[]): void {
    let displayString = '';
    const count = inputs.reduce((selcount, inp) => {
      if (
        midi.selectedInputPorts[inp.id] &&
        midi.selectedInputPorts[inp.id].isSelected
      ) {
        return selcount + 1;
      } else {
        return selcount;
      }
    }, 0);
    inputs.forEach((inp) => {
      if (
        midi.selectedInputPorts[inp.id] &&
        midi.selectedInputPorts[inp.id].isSelected
      ) {
        if (displayString.length > 0) {
          displayString += ', ';
        }
        displayString +=
          count < 3
            ? inp.fullName
            : inp.name.substr(0, 10).trim() + (inp.name.length > 10 ? '…' : '');
      }
    });
    if (count == 0) {
      displayString = '(no input device selected)';
    }
    displayString = count + ': ' + displayString;
    (DOM.get('#midiInputSelector') as HTMLElement).innerHTML = displayString;
  }

  function updateInputSelection(inputs: PortDescriptor[]): void {
    const listContainer = DOM.get(
      '#inputPortWindow #inputPortList'
    ) as HTMLElement;
    DOM.empty(listContainer);
    if (!inputs) {
      return;
    }
    inputs.forEach((inport) => {
      const isSelected =
        midi.selectedInputPorts[inport.id] &&
        midi.selectedInputPorts[inport.id].isSelected;
      DOM.addHTML(
        listContainer,
        'beforeend',
        `<div class="clockOutOption ${
          isSelected ? 'selected' : ''
        }" data-portid="${
          inport.id
        }"><span class="material-icons sel">check_circle</span
        ><span class="material-icons unsel">radio_button_unchecked</span>
        <span>${inport.fullName}</span>
        <span class="chsel"><select tabindex="-1">${channelOptions}</select></span>
        </div>`
      );
      (
        DOM.get(
          `#inputPortList .clockOutOption[data-portid="${inport.id}"] select`
        ) as HTMLSelectElement
      ).selectedIndex = (midi.selectedInputPorts[inport.id] || {}).ch || 0;
    });
    DOM.all('#inputPortWindow #inputPortList .clockOutOption').forEach(
      (option) => {
        const portid = option.getAttribute('data-portid')!;
        const channelSelector = DOM.get(
          `#inputPortList .clockOutOption[data-portid="${portid}"] select`
        ) as HTMLSelectElement;
        option.addEventListener('click', (e) => {
          const state = !(
            midi.selectedInputPorts[portid] &&
            midi.selectedInputPorts[portid].isSelected
          );
          DOM.switchClass(option, state, 'selected');
          midi.selectInputPort(portid, channelSelector.selectedIndex, state);
          zones.selectedInputPorts = midi.selectedInputPorts;
          midi.selectDevices(midi.deviceIdInClock);
          saveZones();
          updateInputDisplay(inputs);
        });
        DOM.attachInside(option, 'select', 'click', (ev) => {
          ev.stopPropagation();
        });
        DOM.attachInside(option, 'select', 'change', (ev: Event) => {
          midi.selectInputPort(portid, channelSelector.selectedIndex, true);
          zones.selectedInputPorts = midi.selectedInputPorts;
          saveZones();
        });
      }
    );
    updateInputDisplay(inputs);
  }

  function updateClockReceivers(outputs: PortDescriptor[]): void {
    const clockOutListContainer = DOM.get(
      '#clockOutPortWindow #clockOutPortList'
    ) as HTMLElement;
    DOM.empty(clockOutListContainer);
    if (!outputs) {
      return;
    }
    outputs.forEach((outport) => {
      const isSelected = midi.clockOutputPorts[outport.id] === true;
      const isSuppressed = midi.suppressTransportPorts[outport.id] === true;
      DOM.addHTML(
        clockOutListContainer,
        'beforeend',
        `<div class="clockOutOption ${
          isSelected ? 'selected' : ''
        }" data-portid="${
          outport.id
        }"><span class="material-icons sel">check_circle</span
        ><span class="material-icons unsel">radio_button_unchecked</span>
        <span class="outname">${outport.fullName}</span
        ><span class="clockSuppressBtn material-icons${isSuppressed ? ' active' : ''}" data-portid="${outport.id}" title="Free-running clock: send only ticks, no start/stop (keeps delay/reverb synced while transport is stopped)">sync_lock</span>
        </div>`
      );
    });
    DOM.all('#clockOutPortWindow #clockOutPortList .clockOutOption').forEach(
      (option) => {
        option.addEventListener('click', (e) => {
          const portid = option.getAttribute('data-portid')!;
          const state = !(midi.clockOutputPorts[portid] === true);
          DOM.switchClass(option, state, 'selected');
          midi.updateClockOutputReceiver(portid, state);
          view.updateValuesForAllZones();
          zones.clockOutputPorts = midi.clockOutputPorts;
          saveZones();
          updateClockOutputCount();
        });
      }
    );
    DOM.all('#clockOutPortWindow #clockOutPortList .clockSuppressBtn').forEach(
      (btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const portid = btn.getAttribute('data-portid')!;
          if (!(midi.clockOutputPorts[portid] === true)) return;
          const state = !(midi.suppressTransportPorts[portid] === true);
          midi.updateClockSuppressTransport(portid, state);
          DOM.switchClass(btn, state, 'active');
          zones.clockSuppressTransportPorts = midi.suppressTransportPorts;
          saveZones();
        });
      }
    );
    updateClockOutputCount();
    DOM.all('#clockOutPortWindow input[name="sendinternal"]').forEach((el) => {
      const inputEl = el as HTMLInputElement;
      if (
        inputEl.id == 'sendinternalplaying' &&
        zones.sendInternalClockIfPlaying
      ) {
        inputEl.checked = true;
      }
      if (
        inputEl.id == 'sendinternalalways' &&
        !zones.sendInternalClockIfPlaying
      ) {
        inputEl.checked = true;
      }
    });
    midi.sendClockIfPlaying = zones.sendInternalClockIfPlaying;
  }
  let activeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let portsFirstUpdateDone = false;
  let initialized = false;
  let clockRunning = false;
  let mackieSelectedZone: number | null = null;
  let mackieVPotAccum = 0;
  let sendMackieLeds: () => void = () => {};
  let syncMackieFader: () => void = () => {};
  const midi = new MIDI({
    eventHandler: (event: MIDIMessageEvent) => {
      if (midi.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
        // handle start/stop messages with internal clock active
        if (
          event.data[0] == MIDI.MESSAGE.SYSTEM_EXCLUSIVE &&
          event.data[1] == MIDI.MESSAGE.SYSTEM_EXCLUSIVE_REAL_TIME &&
          event.data[3] == 6
        ) {
          if (event.data[4] == 2) {
            // MMC PLAY
            midi.startClock();
          } else if (event.data[4] == 1) {
            // MMC STOP
            midi.stopClock();
            zones.list.forEach((z) => {
              z.stopped();
            });
          }
        } else if (
          event.data[0] == MIDI.MESSAGE.START ||
          event.data[0] == MIDI.MESSAGE.CONTINUE
        ) {
          midi.startClock();
        } else if (event.data[0] == MIDI.MESSAGE.STOP) {
          midi.stopClock();
          zones.list.forEach((z) => {
            z.stopped();
          });
        }
      }

      let msgtype = event.data[0] & 0xf0;
      const sourcePortId = event.target
        ? (event.target as MIDIInput).id
        : MIDI.INTERNAL_PORT_ID;
      const isMackiePort = !!(midi.deviceIdMackieControl && sourcePortId === midi.deviceIdMackieControl);
      if (
        !isMackiePort &&
        zones.keySwitchEnabled &&
        msgtype === MIDI.MESSAGE.NOTE_ON &&
        event.data[1] < 20 &&
        event.data[2] > 0
      ) {
        // handle key switches
        if (event.data[1] < 8) {
          // toggle mute
          view.toggleZoneMute(event.data[1]);
        } else if (event.data[1] < 16) {
          // toggle sequencer
          view.toggleSequencerOnZone(event.data[1] - 8);
        } else {
          // select arrangement A/B/C/D (notes 16-19)
          view.selectArrangement(event.data[1] - 16);
        }
        // do nothing else
        return;
      }
      if (msgtype === MIDI.MESSAGE.NOTE_ON && event.data[2] === 0) {
        msgtype = MIDI.MESSAGE.NOTE_OFF;
      }
      const sourceChannel = event.data[0] & 0x0f;
      if (isMackiePort) {
        if (
          (event.data[0] & 0xf0) === MIDI.MESSAGE.NOTE_ON &&
          (event.data[0] & 0x0f) === 0 &&
          event.data[2] > 0
        ) {
          const note = event.data[1];
          // Transport (internal clock only)
          if (midi.deviceIdInClock === MIDI.INTERNAL_PORT_ID) {
            if (note === 94 && !midi.isClockRunning) {
              clockRunning = true;
              midi.startClock();
            } else if (note === 93 && midi.isClockRunning) {
              clockRunning = false;
              midi.stopClock();
            }
          }
          // Channel strip (zones 0–7)
          const zoneIndex = note % 8;
          if (note < 32 && zoneIndex < zones.list.length) {
            const zone = zones.list[zoneIndex];
            if (note < 8) {
              view.toggleSequencerOnZone(zoneIndex); // Rec arm → seq enable
            } else if (note < 16) {
              zone.solo = !zone.solo;
              if (zone.solo) zone.enabled = true;
              view.updateValuesForAllZones();
              saveZones();
            } else if (note < 24) {
              zone.enabled = !zone.enabled;
              view.updateValuesForAllZones();
              saveZones();
            } else {
              mackieSelectedZone = zoneIndex;
              syncMackieFader();
            }
          }
          // F1–F4 → arrangements A–D
          if (note >= 54 && note <= 57) {
            view.selectArrangement(note - 54);
          }
          // Rewind/FastForward → prev/next arrangement
          if (note === 91) {
            view.selectArrangement((zones.nextArrangementIndex + 3) % 4);
          }
          if (note === 92) {
            view.selectArrangement((zones.nextArrangementIndex + 1) % 4);
          }
          // V-Pot press → toggle fixed velocity on selected zone
          if (note === 37 && mackieSelectedZone !== null && mackieSelectedZone < zones.list.length) {
            const zone = zones.list[mackieSelectedZone];
            zone.fixedvel = !zone.fixedvel;
            view.updateValuesForZone(mackieSelectedZone);
            saveZones();
          }
          sendMackieLeds();
        }
        // V-Pot rotation → octave of selected zone
        if (
          (event.data[0] & 0xf0) === MIDI.MESSAGE.CONTROLLER &&
          event.data[1] === 21 &&
          mackieSelectedZone !== null &&
          mackieSelectedZone < zones.list.length
        ) {
          const cw = event.data[2] < 64;
          const delta = cw ? 1 : -1;
          mackieVPotAccum = Math.sign(delta) === Math.sign(mackieVPotAccum) ? mackieVPotAccum + delta : delta;
          if (Math.abs(mackieVPotAccum) >= 2) {
            const zone = zones.list[mackieSelectedZone];
            zone.octave = Math.max(-3, Math.min(3, zone.octave + Math.sign(mackieVPotAccum)));
            view.updateValuesForZone(mackieSelectedZone);
            saveZones();
            mackieVPotAccum = 0;
          }
        }
        // Jog encoder → BPM (internal clock only)
        if (
          (event.data[0] & 0xf0) === MIDI.MESSAGE.CONTROLLER &&
          event.data[1] === 60 &&
          midi.deviceIdInClock === MIDI.INTERNAL_PORT_ID
        ) {
          const raw = event.data[2];
          const cw = raw < 64;
          const speed = cw ? raw : raw - 64;
          const step = speed <= 3 ? 1 : speed <= 10 ? 2 : 5;
          zones.tempo = Math.min(240, Math.max(30, zones.tempo + (cw ? step : -step)));
          midi.setInternalBPM(zones.tempo);
          bpmInput.value = String(zones.tempo);
          saveZones();
        }
        // Fader → velocity scaling or fixed velocity of selected zone
        if (
          (event.data[0] & 0xf0) === MIDI.MESSAGE.PITCH_BEND &&
          mackieSelectedZone !== null &&
          mackieSelectedZone < zones.list.length
        ) {
          const value = event.data[1] | (event.data[2] << 7);
          const faderZone = zones.list[mackieSelectedZone];
          if (faderZone.fixedvel) {
            faderZone.fixedvel_value = Math.round(value * 127 / 16383);
          } else {
            faderZone.velocity_scaling = Math.min(2, value / 8192);
          }
          view.updateValuesForZone(mackieSelectedZone);
          saveZones();
        }
        return;
      }
      zones.list.forEach((zone, index) => {
        if (zone.inputPortId !== null) {
          if (zone.inputPortId !== sourcePortId) return;
          if (zone.inputChannel !== null && zone.inputChannel !== sourceChannel) return;
        } else if (midi.zoneInputPorts.has(sourcePortId)) {
          const portDef = midi.selectedInputPorts[sourcePortId];
          if (!portDef?.isSelected || portDef.ch !== sourceChannel) return;
        }
        const resultMessage = zone.handleMidi(msgtype, event.data);
        if (resultMessage && /^(updateCC|midiLearn)/.test(resultMessage)) {
          const colonPos = resultMessage.indexOf(':');
          const onlyIndex = colonPos > -1 ? parseInt(resultMessage.slice(colonPos + 1)) : undefined;
          const isLearn = resultMessage.startsWith('midiLearn');
          requestAnimationFrame(() => {
            view.updateControllerValues(zone, index, onlyIndex);
            if (isLearn) {
              const ccInInput = document.querySelector(`#zone${index} .cc-editor .cc-in`) as HTMLInputElement;
              if (ccInInput) {
                ccInInput.classList.add('midi-learn-flash');
                setTimeout(() => ccInInput.classList.remove('midi-learn-flash'), 300);
              }
            }
          });
        } else if (resultMessage == 'updateDrumLaneNote') {
          requestAnimationFrame(() => {
            view.updateValuesForZone(index);
            // Flash the input to show MIDI learn was successful
            const input = document.querySelector(`#zone${index} input.midi-learn-active`) as HTMLInputElement;
            if (input) {
              input.classList.add('midi-learn-flash');
              setTimeout(() => input.classList.remove('midi-learn-flash'), 300);
            }
          });
        }
      });
    },
    clockHandler: (pos: number, tickIntervalMs: number) => {
      if (zones.nextArrangementIndex !== zones.arrangementIndex) {
        Sequence.QUANT_TICK_N = pos % Sequence.QUANT_TICKS;
        if (Sequence.QUANT_TICK_N === 0) {
          const newIndex = zones.nextArrangementIndex;
          zones.list.forEach((z) => {
            z.saveArrangement(zones.arrangementIndex);
            z.stopped();
            z.loadArrangement(newIndex);
          });
          zones.arrangementIndex = newIndex;
          view.selectArrangement(newIndex);
          sendMackieLeds();
          saveZones();
        }
      }
      for (let i = 0; i < zones.list.length; i++) {
        zones.list[i].clock(pos, tickIntervalMs);
      }
    },
    transportHandler: (started: boolean) => {
      if (started) {
        startClockButton.classList.add('selected');
        DOM.addClass(document.body, 'running');
        document.querySelectorAll('.zone.lanes-expanded').forEach((el) => {
          el.classList.remove('lanes-expanded');
        });
      } else {
        startClockButton.classList.remove('selected');
        DOM.removeClass(document.body, 'running');
        zones.list.forEach((z) => {
          z.stopped();
        });
      }
      if (midi.deviceIdInClock !== MIDI.INTERNAL_PORT_ID) {
        sendMackieLeds();
      }
    },
    panicHandler: () => {
      zones.list.forEach((z) => z.panic());
      console.log('app: distributed panic to all zones');
      setTimeout(() => {
        view.toast(
          'Sent "notes off" and CC 120, 122, 123 to all channels and used ports!'
        );
      }, 1);
    },
    portsChangedHandler: (available: boolean, inputs: PortDescriptor[], outputs: PortDescriptor[], msg?: string) => {
      if (!initialized) {
        initialized = true;
        if (available) {
          console.log('app: MIDI available');
          DOM.get('#midiPanic')!.addEventListener('click', () => {
            midi.panic();
          });
          loadZones(midi);
          view.renderZones();
        function updateUndoRedoButtons(): void {
          const undoBtn = DOM.get('#undoBtn') as HTMLButtonElement | null;
          const redoBtn = DOM.get('#redoBtn') as HTMLButtonElement | null;
          if (undoBtn) undoBtn.disabled = !undoHistory.canUndo;
          if (redoBtn) redoBtn.disabled = !undoHistory.canRedo;
        }

        function applyUndoRedoSnapshot(snapshot: string): void {
          applyStoredZones(JSON.parse(snapshot), midi);
          syncZoneInputPorts(midi);
          view.renderZones();
          view.selectArrangement(zones.arrangementIndex);
          updateBpmInput();
          midi.setInternalBPM(zones.tempo);
          saveZones();
          updateUndoRedoButtons();
          sendMackieLeds();
        }

        DOM.get('#undoBtn')!.addEventListener('click', () => {
          const snapshot = undoHistory.undo(JSON.stringify(zones));
          if (snapshot) applyUndoRedoSnapshot(snapshot);
        });
        DOM.get('#redoBtn')!.addEventListener('click', () => {
          const snapshot = undoHistory.redo(JSON.stringify(zones));
          if (snapshot) applyUndoRedoSnapshot(snapshot);
        });

        undoHistory.onChange = updateUndoRedoButtons;
        updateUndoRedoButtons();

        function createNewZone(): void {
          undoHistory.push(JSON.stringify(zones));
          let colorIndex = 0;
          if (zones.list.length > 0) {
            colorIndex = zones.list[zones.list.length - 1].colorIndex + 1;
          }
          const newZone = new Zone(midi, colorIndex);
          if (zones.list.length > 0) {
            newZone.preferredOutputPortId = newZone.outputPortId =
              zones.list[zones.list.length - 1].outputPortId;
          }
          zones.list.push(newZone);
          saveZones();
          view.renderLastZone();
          DOM.get(`#zone${zones.list.length - 1}`)!.scrollIntoView();
        }
        window.addEventListener('resize', () => {
          requestAnimationFrame(view.renderMarkersForAllZones);
        });
        DOM.get('#newzone')!.addEventListener('click', createNewZone);
        DOM.get('#deleteallzones')!.addEventListener('click', async () => {
          await ipcRenderer
            .invoke(
              'open-confirm',
              'Delete all zones',
              'Do really want to empty this scene and delete all zones?'
            )
            .then((result: boolean) => {
              if (result == true) {
                view.deleteAllZones();
              }
            });
        });
        let colorOffset = 0;
        DOM.get('#shuffleColors')!.addEventListener('click', () => {
          colorOffset++;
          zones.list.forEach((zone: ZoneType, index: number) => {
            zone.randomizeColor(colorOffset + index);
          });
          view.updateValuesForAllZones();
          saveZones();
        });
        startClockButton.addEventListener('click', () => {
          if (midi.deviceIdInClock === MIDI.INTERNAL_PORT_ID) {
            clockRunning = !clockRunning;
            if (clockRunning) {
              startClockButton.classList.add('selected');
              midi.startClock();
            } else {
              startClockButton.classList.remove('selected');
              midi.stopClock();
              zones.list.forEach((z) => {
                z.stopped();
              });
            }
            sendMackieLeds();
          }
        });
        let bpmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        const commitBpmGesture = (): void => {
          if (bpmDebounceTimer) { clearTimeout(bpmDebounceTimer); bpmDebounceTimer = null; }
          const currentJSON = JSON.stringify(zones);
          undoHistory.endGesture(currentJSON);
          if (document.activeElement === bpmInput) undoHistory.startGesture(currentJSON);
        };
        bpmInput.addEventListener('focus', () => {
          bpmInput.select();
          undoHistory.startGesture(JSON.stringify(zones));
        });
        bpmInput.addEventListener('input', (e) => {
          const parsed = parseInt((e.target as HTMLInputElement).value);
          if (isNaN(parsed)) return;
          const bpm = Math.min(Math.max(parsed, 30), 240);
          zones.tempo = bpm;
          midi.setInternalBPM(bpm);
          saveZones();
          if (bpmDebounceTimer) clearTimeout(bpmDebounceTimer);
          bpmDebounceTimer = setTimeout(commitBpmGesture, 1000);
        });
        bpmInput.addEventListener('blur', () => {
          commitBpmGesture();
        });
        updateBpmInput();
        midi.bpmDetectedHandler = (bpm: number | null) => {
          if (midi.deviceIdInClock !== MIDI.INTERNAL_PORT_ID) {
            bpmInput.value = bpm !== null ? bpm.toFixed(1) : '';
            bpmInput.classList.toggle('hasClock', bpm !== null);
          }
        };
        updateClockOutputCount();
        midi.setInternalBPM(zones.tempo);
        view.selectArrangement(zones.arrangementIndex || 0);
        Sequence.setQuantDiv(zones.arrangementQuantIndex ?? 2);
        (DOM.get('#tools #seqquant') as HTMLSelectElement).value = String(
          zones.arrangementQuantIndex ?? 2
        );
        (DOM.get('#keySwitchEnabled') as HTMLInputElement).checked =
          zones.keySwitchEnabled !== false;
        document.body.addEventListener('keydown', (ev) => {
          if ((document.activeElement as HTMLElement).tagName != 'INPUT') {
            if (ev.key == ' ') {
              ev.preventDefault();
            }
          }
        });
        document.body.addEventListener('keydown', (ev) => {
          if ((document.activeElement as HTMLElement).tagName != 'INPUT') {
            if (ev.code == 'Space') {
              startClockButton.click();
            }
            if (ev.code.indexOf('Digit') == 0) {
              const numIndex = '1234567890'.indexOf(ev.code.charAt(5));
              if (numIndex > -1 && !ev.shiftKey) {
                view.toggleZoneMute(numIndex);
              } else if (numIndex > -1 && ev.shiftKey) {
                view.toggleSequencerOnZone(numIndex);
              }
            } else if (ev.code.indexOf('Key') == 0) {
              const letterIndex = 'QWERTYUIOP'.indexOf(ev.code.charAt(3));
              if (letterIndex > -1) {
                view.toggleSequencerOnZone(letterIndex);
              } else {
                const arrIndex = 'ZXCV'.indexOf(ev.code.charAt(3));
                if (arrIndex > -1) {
                  view.selectArrangement(arrIndex);
                }
              }
            }
          }
        });
        DOM.get('#save')!.addEventListener('click', async (e) => {
          await ipcRenderer
            .invoke('open-save', JSON.stringify(zones))
            .then(
              (result: {
                canceled: boolean;
                message: string;
                warning?: boolean;
              }) => {
                if (!result.canceled) {
                  view.toast(result.message, { warning: result.warning });
                }
              }
            );
        });
        DOM.get('#load')!.addEventListener('click', async (e) => {
          await ipcRenderer
            .invoke('open-load')
            .then((result: string | null) => {
              if (result) {
                try {
                  undoHistory.push(JSON.stringify(zones));
                  applyStoredZones(JSON.parse(result), midi, true);
                  syncZoneInputPorts(midi);
                  view.renderZones();
                  saveZones();
                  updateUndoRedoButtons();
                  zones.list.forEach((zone) => zone.sendProgramChange());
                } catch (ex) {
                  console.log('app: Error loading file', ex);
                  view.toast(
                    'Error loading file! The selected file is possibly no midi-zoner scene...',
                    { warning: true }
                  );
                }
              }
            });
        });
        sendMackieLeds = (): void => {
          zones.list.forEach((_, i) => {
            const el = DOM.get(`#zone${i}`);
            if (el) DOM.switchClass(el, i === mackieSelectedZone, 'mackie-selected');
          });
          for (let i = 0; i < 8; i++) {
            const zone = zones.list[i];
            const active = i < zones.list.length;
            midi.sendMackie(i,      active && zone.sequence.active ? 127 : 0);
            midi.sendMackie(i + 8,  active && zone.solo ? 127 : 0);
            midi.sendMackie(i + 16, active && !zone.enabled ? 127 : 0);
            midi.sendMackie(i + 24, i === mackieSelectedZone ? 127 : 0);
          }
          for (let a = 0; a < 4; a++) {
            midi.sendMackie(54 + a, zones.arrangementIndex === a ? 127 : 0);
          }
          midi.sendMackie(94, midi.isClockRunning ? 127 : 0);
          midi.sendMackie(93, midi.isClockRunning ? 0 : 127);
          midi.sendMackie(91, (zones.arrangementIndex & 1) ? 127 : 0);
          midi.sendMackie(92, (zones.arrangementIndex >> 1 & 1) ? 127 : 0);
          syncMackieFader();
        };
        syncMackieFader = (): void => {
          if (!midi.deviceIdMackieOutput || mackieSelectedZone === null || mackieSelectedZone >= zones.list.length) return;
          const sz = zones.list[mackieSelectedZone];
          let value: number;
          if (sz.fixedvel) {
            value = Math.round((typeof sz.fixedvel_value === 'number' ? sz.fixedvel_value : 127) * 16383 / 127);
          } else {
            const vs = typeof sz.velocity_scaling === 'number' ? sz.velocity_scaling : 1;
            value = Math.min(16383, Math.round(vs * 8192));
          }
          const msg = new Uint8Array(3);
          msg[0] = 0xe0; // Pitch Bend ch 1
          msg[1] = value & 0x7f;
          msg[2] = (value >> 7) & 0x7f;
          midi.send(msg, midi.deviceIdMackieOutput);
        };
        view.setStateChangeCallback(sendMackieLeds);
        } else {
          console.log('app:', msg);
        }
      }
      // port update — debounced to coalesce rapid statechange events
      if (activeUpdateTimer) clearTimeout(activeUpdateTimer);
      activeUpdateTimer = setTimeout(() => {
        if (!available) return;
        console.log('app: MIDI port update');
        // rebuild clock source selector
        DOM.empty(select_in_clock);
        DOM.addHTML(
          select_in_clock,
          'beforeend',
          /*html*/ `<option value="*">midi-zoner internal</option>`
        );
        if (inputs.length > 0) {
          inputs.forEach((input) => {
            DOM.addHTML(
              select_in_clock,
              'beforeend',
              `<option value="${input.id}" ${
                input.isSelectedClockInput ? 'selected' : ''
              }>${input.name}</option>`
            );
          });
        } else {
          DOM.addHTML(select_in_clock, 'beforeend', optionNoDevice);
        }
        // rebuild Mackie Control selector
        const savedMackieId = localStorage.getItem('mackieControlPortId') ?? '';
        DOM.empty(select_mackie);
        DOM.addHTML(select_mackie, 'beforeend', '<option value="">(None)</option>');
        inputs.forEach((input) => {
          DOM.addHTML(
            select_mackie,
            'beforeend',
            `<option value="${input.id}" ${input.id === savedMackieId ? 'selected' : ''}>${input.name}</option>`
          );
        });
        midi.deviceIdMackieControl = savedMackieId || null;
        // rebuild Mackie Output selector
        const savedMackieOutId = localStorage.getItem('mackieControlOutputPortId') ?? '';
        DOM.empty(select_mackie_out);
        DOM.addHTML(select_mackie_out, 'beforeend', '<option value="">(None)</option>');
        outputs.forEach((output) => {
          DOM.addHTML(
            select_mackie_out,
            'beforeend',
            `<option value="${output.id}" ${output.id === savedMackieOutId ? 'selected' : ''}>${output.name}</option>`
          );
        });
        midi.deviceIdMackieOutput = savedMackieOutId || null;
        midi.selectDevices(midi.deviceIdInClock);
        if (!portsFirstUpdateDone && midi.deviceIdMackieControl && zones.list.length > 0) {
          mackieSelectedZone = 0;
        }
        sendMackieLeds();
        syncMackieFader();
        // remember port names so missing devices can be labelled
        outputs.forEach((p) => { zones.knownPortNames[p.id] = p.name; });
        inputs.forEach((p) => { zones.knownPortNames[p.id] = p.name; });
        saveZones();
        // update zone port selectors and send program changes for reconnected ports
        const prevPortIds = zones.list.map((z) => z.outputPortId);
        midi.updateUsedPorts(view.updateOutputPortsForAllZone(outputs));
        view.updateInputPortsForAllZones(inputs);
        zones.list.forEach((zone, i) => {
          if (
            zone.pgm_no != null &&
            zone.preferredOutputPortId !== MIDI.INTERNAL_PORT_ID &&
            zone.outputPortId === zone.preferredOutputPortId &&
            (prevPortIds[i] !== zone.outputPortId || !portsFirstUpdateDone)
          ) {
            zone.sendProgramChange();
          }
        });
        portsFirstUpdateDone = true;
        if (midi.deviceIdInClock !== MIDI.INTERNAL_PORT_ID && midi.knownPorts[midi.deviceIdInClock] == null) {
          console.log('app: Clock in port', midi.deviceIdInClock, 'not available. Switching to internal clock.');
          midi.selectDevices(MIDI.INTERNAL_PORT_ID);
          localStorage.setItem('midiInClockId', MIDI.INTERNAL_PORT_ID);
        }
        updateBpmInput();
        updateClockReceivers(outputs);
        updateInputSelection(inputs);
        DOM.addClass(document.body, 'updated');
        setTimeout(() => {
          DOM.removeClass(document.body, 'updated');
        }, 1000);
        view.toast(`MIDI devices updated! <br/>${msg ? msg : ''}`);
      }, 100);
    }
  });
  select_in_clock.addEventListener('change', () => {
    const inClockId = (
      DOM.find(select_in_clock, 'option:checked')[0] as HTMLOptionElement
    ).value;
    midi.selectDevices(inClockId);
    updateBpmInput();
    localStorage.setItem('midiInClockId', inClockId);
  });
  select_mackie.addEventListener('change', () => {
    const portId = (select_mackie.querySelector('option:checked') as HTMLOptionElement).value;
    midi.deviceIdMackieControl = portId || null;
    midi.selectDevices(midi.deviceIdInClock);
    localStorage.setItem('mackieControlPortId', portId);
    if (!portId) {
      mackieSelectedZone = null;
    }
    sendMackieLeds();
  });
  select_mackie_out.addEventListener('change', () => {
    const portId = (select_mackie_out.querySelector('option:checked') as HTMLOptionElement).value;
    midi.deviceIdMackieOutput = portId || null;
    localStorage.setItem('mackieControlOutputPortId', portId);
    sendMackieLeds();
  });
  DOM.get('#clockSendButton')!.addEventListener('click', (e) => {
    const clockoutcontainer = DOM.get('#clockOutPortWindow') as HTMLElement;
    const isVisible = clockoutcontainer.style.display == 'block';
    clockoutcontainer.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      setTimeout(() => {
        onBackgroundClick(() => {
          clockoutcontainer.style.display = 'none';
        }, '#clockOutPortWindow');
      }, 0);
    }
  });
  DOM.get('#midiInputSelector')!.addEventListener('click', () => {
    const container = DOM.get('#inputPortWindow') as HTMLElement;
    const isVisible = container.style.display == 'block';
    container.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) {
      setTimeout(() => {
        onBackgroundClick(() => {
          container.style.display = 'none';
        }, '#inputPortWindow');
      }, 0);
    }
  });
  DOM.on('#clockOutPortWindow input[name="sendinternal"]', 'change', () => {
    midi.sendClockIfPlaying = zones.sendInternalClockIfPlaying =
      (
        document.querySelector(
          'input[name="sendinternal"]:checked'
        ) as HTMLInputElement
      ).value == '1';
    saveZones();
  });
  DOM.on('#tools *[data-select-arrangement]', 'click', (ev) => {
    const el = ev.target as HTMLElement;
    const selectedArr = parseInt(el.dataset.selectArrangement!);
    view.selectArrangement(selectedArr);
  });
  DOM.on('#tools *[data-select-arrangement][data-contextmenu]', 'contextmenu', (ev) => {
    view.showContextMenuFor(ev as MouseEvent);
  });
  DOM.on('#tools #seqquant', 'change', (ev) => {
    const quantDiv = parseInt((ev.target as HTMLSelectElement).value);
    Sequence.setQuantDiv(quantDiv);
    zones.arrangementQuantIndex = quantDiv;
    saveZones();
  });
  DOM.on('#aboutBtn', 'click', () => ipcRenderer.invoke('open-about'));
  DOM.on('#keySwitchEnabled', 'change', (ev) => {
    zones.keySwitchEnabled = (ev.target as HTMLInputElement).checked;
    saveZones();
  });
  view.initController({ saveData: saveZones, data: zones as any, midi, history: undoHistory });

  contextMenuElement.addEventListener('mouseleave', function () {
    hideOnLeaveContextMenuTimeout = setTimeout(() => {
      closeContextMenu();
    }, 1333);
  });
  contextMenuElement.addEventListener('mousemove', function () {
    resetHideOnLeaveContextMenuTimeout();
  });
  window.addEventListener('closeContextMenu', closeContextMenu);
  window.addEventListener(
    'resetHideOnLeaveContextMenuTimeout',
    resetHideOnLeaveContextMenuTimeout
  );
  onBackgroundClick(closeContextMenu, '#contextmenu');
});
