const DOM = require('./modules/domutils');
const Zone = require('./modules/zone').Zone;
const Sequence = require('./modules/zone').Sequence;
const MIDI = require('./modules/midi');
const viewcontroller = require('./modules/viewcontroller');
const view = require('./modules/viewcontroller');
const { ipcRenderer } = require('electron');

const zones = {
  list: [],
  inChannel: 0,
  clockOutputPorts: {},
  selectedInputPorts: {},
  tempo: 120,
  sendInternalClockIfPlaying: false, // TODO misnomed; means send everything
  outputConfigNames: {}
};

const debounce = function (func, delay) {
  let timer;
  return function () {
    const context = this;
    const args = arguments;
    clearTimeout(timer);
    timer = setTimeout(() => {
      func.apply(context, args);
    }, delay);
  };
};

const saveZones = debounce(() => {
  localStorage.setItem('zones', JSON.stringify(zones));
}, 500);

const channelOptions = (function () {
  var result = '';
  for (var i = 0; i < 16; i++) {
    result += `<option>Ch ${i + 1}</option>`;
  }
  return result;
})();

function loadZones(midi) {
  const zonesJson = localStorage.getItem('zones');
  if (zonesJson) {
    applyStoredZones(JSON.parse(zonesJson), midi);
  }
}

function applyStoredZones(storedZones, midi, append) {
  if (storedZones) {
    const tempList = zones.list;
    if (!append) {
      zones.list.forEach((z) => z.dismiss());
    }
    Object.assign(zones, storedZones);
    zones.list = append ? tempList : [];
    for (let i = 0; i < storedZones.list.length; i++) {
      const zone = new Zone(midi);
      Object.assign(zone, storedZones.list[i]);
      const sequence = new Sequence(zone);
      Object.assign(sequence, storedZones.list[i].sequence);
      sequence.steps.forEach((st) => {
        if (st) {
          st.lastPlayedArray = [];
        }
      });
      zone.sequence = sequence;
      zones.list.push(zone);
    }
    midi.clockOutputPorts = zones.clockOutputPorts;
    midi.selectedInputPorts = zones.selectedInputPorts;
  }
}

const closeQueue = [];

function bodyClickHandler() {
  let callback = closeQueue.pop();
  if (callback) {
    callback();
  }
  DOM.hide('#toast');
}

function onBackgroundClick(callback, filterElement) {
  DOM.on(filterElement, 'click', (ev) => {
    ev.stopPropagation();
  });
  closeQueue.push(callback);
}

let hideOnLeaveContextMenuTimeout = null;
function resetHideOnLeaveContextMenuTimeout() {
  if (hideOnLeaveContextMenuTimeout) {
    clearTimeout(hideOnLeaveContextMenuTimeout);
  }
}

function closeContextMenu() {
  resetHideOnLeaveContextMenuTimeout();
  DOM.element('#contextmenu').style.display = 'none';
  DOM.removeClass('*', 'contextMenuTrigger');
}

document.addEventListener('DOMContentLoaded', function () {
  const contextMenuElement = DOM.element('#contextmenu');
  DOM.on(document, 'click', bodyClickHandler);
  const select_in_clock = DOM.element('#midiClockInDeviceId');
  const startClockButton = DOM.element('#startClockButton');
  const bpmInput = DOM.element('#bpm');
  const optionNoDevice = '<option value="">(No devices available)</option>';
  function updateBpmInput() {
    if (midi.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      DOM.addClass('.clocksettings', 'isInternal');
      bpmInput.value = zones.tempo;
    } else {
      DOM.removeClass('.clocksettings', 'isInternal');
      bpmInput.value = '';
    }
  }
  function updateClockOutputCount() {
    let count = 0;
    for (const [portid, enabled] of Object.entries(midi.clockOutputPorts)) {
      let present = false;
      midi.outputPortsRegistered.forEach((p) => {
        if (parseInt(p.id) == parseInt(portid)) {
          present = true;
        }
      });
      if (enabled && present) {
        count++;
      }
    }
    DOM.element('#clockOutPortsCount').innerHTML = count > 0 ? count : '-';
  }

  function updateInputDisplay(inputs) {
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
    DOM.element('#midiInputSelector').innerHTML = displayString;
  }

  function updateInputSelection(inputs) {
    const listContainer = DOM.element('#inputPortWindow #inputPortList');
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
        <span class="chsel"><select>${channelOptions}</select></span>
        </div>`
      );
      DOM.element(
        `#inputPortList .clockOutOption[data-portid="${inport.id}"] select`
      ).selectedIndex = (midi.selectedInputPorts[inport.id] || {}).ch || 0;
    });
    DOM.all('#inputPortWindow #inputPortList .clockOutOption').forEach(
      (option) => {
        const portid = parseInt(option.getAttribute('data-portid'));
        const channelSelector = DOM.element(
          `#inputPortList .clockOutOption[data-portid="${portid}"] select`
        );
        option.addEventListener('click', (e) => {
          const state = !(
            midi.selectedInputPorts[portid] &&
            midi.selectedInputPorts[portid].isSelected
          );
          if (state) {
            DOM.addClass(option, 'selected');
          } else {
            DOM.removeClass(option, 'selected');
          }
          midi.selectInputPort(portid, channelSelector.selectedIndex, state);
          zones.selectedInputPorts = midi.selectedInputPorts;
          midi.selectDevices(midi.deviceIdInClock);
          saveZones();
          updateInputDisplay(inputs);
        });
        DOM.attachInside(option, 'select', 'click', (ev) => {
          ev.stopPropagation();
        });
        DOM.attachInside(option, 'select', 'change', (ev) => {
          midi.selectInputPort(portid, channelSelector.selectedIndex, true);
          zones.selectedInputPorts = midi.selectedInputPorts;
          saveZones();
        });
      }
    );
    updateInputDisplay(inputs);
  }

  function updateClockReceivers(outputs) {
    const clockOutListContainer = DOM.element(
      '#clockOutPortWindow #clockOutPortList'
    );
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
          const portid = parseInt(option.getAttribute('data-portid'));
          const state = !(midi.clockOutputPorts[portid] === true);
          if (state) {
            DOM.addClass(option, 'selected');
          } else {
            DOM.removeClass(option, 'selected');
          }
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
      if (el.id == 'sendinternalplaying' && zones.sendInternalClockIfPlaying) {
        el.checked = true;
      }
      if (el.id == 'sendinternalalways' && !zones.sendInternalClockIfPlaying) {
        el.checked = true;
      }
    });
    midi.sendClockIfPlaying = zones.sendInternalClockIfPlaying;
  }
  let activeUpdateTimer = null;
  const midi = new MIDI({
    eventHandler: (event) => {
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
      zones.list.forEach((zone, index) => {
        const resultMessage = zone.handleMidi(msgtype, event.data);
        if (resultMessage == 'updateCC') {
          requestAnimationFrame(() => {
            view.updateControllerValues(zone, index);
          });
        }
      });
    },
    clockHandler: (pos) => {
      for (let i = 0; i < zones.list.length; i++) {
        zones.list[i].clock(pos);
      }
    },
    transportHandler: (started) => {
      if (started) {
        startClockButton.classList.add('selected');
        DOM.addClass(document.body, 'running');
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
    },
    completeHandler: (midiavailable, message) => {
      // availability handler
      if (midiavailable) {
        console.log('app: MIDI available');
        DOM.element('#midiPanic').addEventListener('click', () => {
          midi.panic();
        });
        loadZones(midi);
        midi.selectDevices(midi.deviceIdInClock);
        const updateClockInterface = function () {
          console.log('app: Clock input device changed');
        };
        DOM.element('#midiClockInDeviceId').addEventListener(
          'change',
          updateClockInterface
        );
        updateClockInterface();
        view.renderZones();
        function createNewZone() {
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
          DOM.element(`#zone${zones.list.length - 1}`).scrollIntoView();
        }
        window.addEventListener('resize', () => {
          requestAnimationFrame(view.renderMarkersForAllZones);
        });
        DOM.element('#newzone').addEventListener('click', createNewZone);
        DOM.element('#deleteallzones').addEventListener('click', async () => {
          await ipcRenderer
            .invoke(
              'open-confirm',
              'Delete all zones',
              'Do really want to empty this scene and delete all zones?'
            )
            .then((result) => {
              if (result == true) {
                viewcontroller.deleteAllZones();
              }
            });
        });
        let colorOffset = 0;
        DOM.element('#shuffleColors').addEventListener('click', () => {
          colorOffset++;
          zones.list.forEach((/** @type {Zone} */ zone, index) => {
            zone.randomizeColor(colorOffset + index);
          });
          view.renderZones();
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
          const bpm = Math.min(Math.max(parseInt(e.target.value), 30), 240);
          zones.tempo = bpm;
          midi.setInternalBPM(bpm);
          saveZones();
        });
        updateBpmInput();
        updateClockOutputCount();
        midi.setInternalBPM(zones.tempo);
        document.body.addEventListener('keydown', (ev) => {
          if (document.activeElement.tagName != 'INPUT') {
            if (ev.key == ' ') {
              ev.preventDefault();
            }
          }
        });
        document.body.addEventListener('keyup', (ev) => {
          if (document.activeElement.tagName != 'INPUT') {
            if (ev.key == ' ') {
              startClockButton.click();
            }
            const numIndex = '1234567890'.indexOf(ev.key);
            if (numIndex > -1) {
              view.toggleZoneMute(numIndex);
            }
            const letterIndex = 'QWERTYUIOP'.indexOf(ev.code.charAt(3));
            if (letterIndex > -1) {
              view.toggleSequencerOnZone(letterIndex);
            }
            const layerIndex = 'ZXCV'.indexOf(ev.code.charAt(3));
            if (layerIndex > -1) {
              view.selectSequencerLayer(layerIndex);
            }
          }
        });
        DOM.element('#save').addEventListener('click', async (e) => {
          await ipcRenderer
            .invoke('open-save', JSON.stringify(zones))
            .then((result) => {
              if (!result.canceled) {
                viewcontroller.toast(result.message, {
                  longer: true,
                  warning: result.warning
                });
              }
            });
        });
        DOM.element('#load').addEventListener('click', async (e) => {
          await ipcRenderer.invoke('open-load').then((result) => {
            if (result) {
              try {
                applyStoredZones(JSON.parse(result), midi, true);
                view.renderZones();
                saveZones();
              } catch (ex) {
                viewcontroller.toast(
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
    updatePortsHandler: (inputs, outputs) => {
      if (activeUpdateTimer) {
        clearTimeout(activeUpdateTimer);
        activeUpdateTimer = null;
      }
      activeUpdateTimer = setTimeout(() => {
        console.log('app: MIDI port update');
        console.log('app: inputs', inputs);
        console.log('app: outputs', outputs);
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
        viewcontroller.toast('MIDI devices updated!', {
          longer: true
        });
      }, 100);
    },
    updateClockReceiverHandler: updateClockReceivers
  });
  const clockIndicator = DOM.element('.clockIndicator');
  setInterval(() => {
    if (midi.hasClock) {
      clockIndicator.classList.add('hasClock');
    } else {
      clockIndicator.classList.remove('hasClock');
    }
  }, 999);
  const list = [select_in_clock];
  list.forEach((el) => {
    el.addEventListener('change', () => {
      const inClockId = DOM.find(select_in_clock, 'option:checked')[0].value;
      midi.selectDevices(inClockId);
      updateBpmInput();
      localStorage.setItem('midiInClockId', inClockId);
    });
  });
  DOM.element('#clockSendButton').addEventListener('click', (e) => {
    const clockoutcontainer = DOM.element('#clockOutPortWindow');
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
  DOM.element('#midiInputSelector').addEventListener('click', () => {
    const container = DOM.element('#inputPortWindow');
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
      document.querySelector('input[name="sendinternal"]:checked').value == '1';
    saveZones();
  });
  DOM.on('#tools *[data-select-seq-layer]', 'click', (ev) => {
    const el = ev.target;
    view.selectSequencerLayer(parseInt(el.dataset.selectSeqLayer));
  });
  view.initController({ saveData: saveZones, data: zones, midi });

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
