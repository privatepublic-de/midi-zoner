import DOM from '../modules/domutils';
import { Zone } from '../modules/zone/zone-class';
import { Sequence } from '../modules/zone/sequence';
import { DIV_TICKS } from '../modules/zone/seq-layer';
import MIDI from '../modules/midi';
import * as view from '../modules/viewcontroller';
import { ipcRenderer } from 'electron';
import { ZoneArrangementJSON } from '../modules/zone/interfaces';

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
  selectedInputPorts: Record<string, InputPortDef>;
  tempo: number;
  sendInternalClockIfPlaying: boolean;
  outputConfigNames: Record<string, string>;
  arrangementIndex: number;
  nextArrangementIndex: number;
  arrangementQuantIndex: number;
  keySwitchEnabled: boolean;
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
  selectedInputPorts: {},
  tempo: 120,
  sendInternalClockIfPlaying: false, // TODO misnamed; means send everything
  outputConfigNames: {},
  arrangementIndex: 0,
  nextArrangementIndex: 0,
  arrangementQuantIndex: 2,
  keySwitchEnabled: true
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
      zones.list = [];
      for (let i = 0; i < (storedZones.list?.length ?? 0); i++) {
        zones.list.push(createZone(midi, storedZones.list![i]));
      }
      Sequence.setQuantDiv(zones.arrangementQuantIndex ?? 2);
    }
    midi.clockOutputPorts = zones.clockOutputPorts;
    midi.selectedInputPorts = zones.selectedInputPorts;
  }
}

const closeQueue: (() => void)[] = [];

function bodyClickHandler(): void {
  let callback = closeQueue.pop();
  if (callback) {
    callback();
  }
  DOM.removeClass('#toast', 'fade');
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

document.addEventListener('DOMContentLoaded', function () {
  const contextMenuElement = DOM.get('#contextmenu') as HTMLElement;
  DOM.on(document, 'click', bodyClickHandler);
  const select_in_clock = DOM.get('#midiClockInDeviceId') as HTMLSelectElement;
  const startClockButton = DOM.get('#startClockButton') as HTMLElement;
  const bpmInput = DOM.get('#bpm') as HTMLInputElement;
  const optionNoDevice = '<option value="">(No devices available)</option>';
  function updateBpmInput(): void {
    if (midi.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      DOM.addClass('.clocksettings', 'isInternal');
      DOM.removeClass('.clocksettings', 'isExternal');
      bpmInput.setAttribute('type', 'number');
      bpmInput.value = String(zones.tempo);
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
      DOM.addHTML(
        clockOutListContainer,
        'beforeend',
        `<div class="clockOutOption ${
          isSelected ? 'selected' : ''
        }" data-portid="${
          outport.id
        }"><span class="material-icons sel">check_circle</span
        ><span class="material-icons unsel">radio_button_unchecked</span>
        <span class="outname">${outport.fullName}</span>
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
      if (
        zones.keySwitchEnabled &&
        msgtype === MIDI.MESSAGE.NOTE_ON &&
        event.data[1] < 16 &&
        event.data[2] > 0
      ) {
        // handle key switches
        if (event.data[1] < 8) {
          // toggle mute
          view.toggleZoneMute(event.data[1]);
        } else {
          // toggle sequencer
          view.toggleSequencerOnZone(event.data[1] - 8);
        }
        // do nothing else
        return;
      }
      if (msgtype === MIDI.MESSAGE.NOTE_ON && event.data[2] === 0) {
        msgtype = MIDI.MESSAGE.NOTE_OFF;
      }
      const sourcePortId = event.target
        ? (event.target as MIDIInput).id
        : MIDI.INTERNAL_PORT_ID;
      const sourceChannel = event.data[0] & 0x0f;
      zones.list.forEach((zone, index) => {
        if (zone.inputPortId !== null) {
          if (zone.inputPortId !== sourcePortId) return;
          if (zone.inputChannel !== null && zone.inputChannel !== sourceChannel) return;
        } else if (midi.zoneInputPorts.has(sourcePortId)) {
          const portDef = midi.selectedInputPorts[sourcePortId];
          if (!portDef?.isSelected || portDef.ch !== sourceChannel) return;
        }
        const resultMessage = zone.handleMidi(msgtype, event.data);
        if (resultMessage == 'updateCC') {
          requestAnimationFrame(() => {
            view.updateControllerValues(zone, index);
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
    },
    panicHandler: () => {
      zones.list.forEach((z) => z.panic());
      console.log('app: distributed panic to all zones');
      setTimeout(() => {
        view.toast(
          'Sent "notes off" and CC 120, 122, 123 to all channels and used ports!',
          { longer: true }
        );
      }, 1);
    },
    completeHandler: (midiavailable: boolean, message: string) => {
      // availability handler
      if (midiavailable) {
        console.log('app: MIDI available');
        DOM.get('#midiPanic')!.addEventListener('click', () => {
          midi.panic();
        });
        loadZones(midi);
        midi.selectDevices(midi.deviceIdInClock);
        const updateClockInterface = function (): void {
          console.log('app: Clock input device changed');
        };
        DOM.get('#midiClockInDeviceId')!.addEventListener(
          'change',
          updateClockInterface
        );
        updateClockInterface();
        view.renderZones();
        function createNewZone(): void {
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
        let clockRunning = false;
        startClockButton.addEventListener('click', () => {
          clockRunning = !clockRunning;
          if (true || !midi.deviceInClock) {
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
          }
        });
        bpmInput.addEventListener('input', (e) => {
          const bpm = Math.min(
            Math.max(parseInt((e.target as HTMLInputElement).value), 30),
            240
          );
          zones.tempo = bpm;
          midi.setInternalBPM(bpm);
          saveZones();
        });
        updateBpmInput();
        midi.bpmDetectedHandler = (bpm: number | null) => {
          if (midi.deviceIdInClock !== MIDI.INTERNAL_PORT_ID) {
            bpmInput.value = bpm !== null ? bpm.toFixed(1) : '---';
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
                  view.toast(result.message, {
                    longer: true,
                    warning: result.warning
                  });
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
                  applyStoredZones(JSON.parse(result), midi, true);
                  syncZoneInputPorts(midi);
                  view.renderZones();
                  saveZones();
                } catch (ex) {
                  console.log('app: Error loading file', ex);
                  view.toast(
                    'Error loading file! The selected file is possibly no midi-zoner scene...',
                    {
                      longer: true,
                      warning: true
                    }
                  );
                }
              }
            });
        });
      } else {
        console.log('app:', message);
      }
    },
    updatePortsHandler: (
      inputs: PortDescriptor[],
      outputs: PortDescriptor[],
      msg: string
    ) => {
      if (activeUpdateTimer) {
        clearTimeout(activeUpdateTimer);
        activeUpdateTimer = null;
      }
      activeUpdateTimer = setTimeout(() => {
        console.log('app: MIDI port update');
        console.log(
          'app: MIDI inputs ----------',
          JSON.stringify(inputs, null, 2)
        );
        console.log(
          'app: MIDI outputs ----------',
          JSON.stringify(outputs, null, 2)
        );
        // midi settings
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
        // zones
        midi.updateUsedPorts(view.updateOutputPortsForAllZone(outputs));
        view.updateInputPortsForAllZones(inputs);
        if (midi.knownPorts[midi.deviceIdInClock] == null) {
          console.log(
            'app: Clock in port',
            midi.deviceIdInClock,
            'not available. Switching to internal clock.'
          );
          midi.selectDevices(MIDI.INTERNAL_PORT_ID);
        }
        updateBpmInput();
        updateClockReceivers(outputs);
        updateInputSelection(inputs);
        DOM.addClass(document.body, 'updated');
        setTimeout(() => {
          DOM.removeClass(document.body, 'updated');
        }, 1000);
        view.toast(`MIDI devices updated! <br/>${msg ? msg : ''}`, {
          longer: true
        });
      }, 100);
    },
    updateClockReceiverHandler: updateClockReceivers
  });
  const list = [select_in_clock];
  list.forEach((el) => {
    el.addEventListener('change', () => {
      const inClockId = (
        DOM.find(select_in_clock, 'option:checked')[0] as HTMLOptionElement
      ).value;
      midi.selectDevices(inClockId);
      updateBpmInput();
      localStorage.setItem('midiInClockId', inClockId);
    });
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
  DOM.on('#tools #seqquant', 'change', (ev) => {
    const quantDiv = parseInt((ev.target as HTMLSelectElement).value);
    Sequence.setQuantDiv(quantDiv);
    zones.arrangementQuantIndex = quantDiv;
    saveZones();
  });
  DOM.on('#keySwitchEnabled', 'change', (ev) => {
    zones.keySwitchEnabled = (ev.target as HTMLInputElement).checked;
    saveZones();
  });
  view.initController({ saveData: saveZones, data: zones as any, midi });

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
