const DOM = require('./modules/domutils');
const Zone = require('./modules/zone').Zone;
const Sequence = require('./modules/zone').Sequence;
const MIDI = require('./modules/midi');
const viewcontroller = require('./modules/viewcontroller');
const view = require('./modules/viewcontroller');

const zones = {
  list: [],
  inChannel: 0,
  clockOutputPorts: {},
  selectedInputPorts: {},
  tempo: 120,
  sendInternalClockIfPlaying: false,
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

function savedScenesKeys() {
  const scenesj = localStorage.getItem('scenes');
  if (scenesj) {
    return Object.keys(JSON.parse(scenesj)).sort();
  } else {
    return [];
  }
}

function existingScenesHtml(className) {
  const savedList = savedScenesKeys();
  let existingHtml;
  if (savedList.length > 0) {
    existingHtml = `<ul class="${className}">`;
    savedList.forEach((k, index) => {
      existingHtml += /*html*/ `
        <li data-index="${index}">
          <i data-act="delete" class="material-icons">delete</i>
          ${k}
        </li>`;
    });
    existingHtml += '</ul>';
  } else {
    existingHtml = '<p><i>(nothing saved yet)</i></p>';
  }
  return existingHtml;
}

function attachSceneActionHandlers(container, reloadFunction, midi) {
  DOM.find(container, 'li *[data-act="delete"]').forEach((e) => {
    e.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const index = new Number(e.parentElement.getAttribute('data-index'));
      const key = savedScenesKeys()[index];
      if (confirm('Delete scene "' + key + '"?')) {
        const scenesJ = localStorage.getItem('scenes');
        const scenes = scenesJ ? JSON.parse(scenesJ) : {};
        delete scenes[key];
        localStorage.setItem('scenes', JSON.stringify(scenes));
        reloadFunction();
      }
    });
  });
}

let isLoadSaveDialogOpenend = false;

function openLoadDialog(midi) {
  const container = DOM.element('#loadsave');
  DOM.empty(container);
  DOM.addHTML(
    container,
    'beforeend',
    /*html*/ `<div onclick="closeLoadSaveDialog()" class="lsCancel"><i class="material-icons">close</i></div>
    <h2>Load scene</h2>
    ${existingScenesHtml('load')}`
  );
  DOM.on('#loadsave li', 'click', (ev) => {
    const index = new Number(ev.target.getAttribute('data-index'));
    const scenesJ = localStorage.getItem('scenes');
    const scenes = scenesJ ? JSON.parse(scenesJ) : {};
    const scene = scenes[savedScenesKeys()[index]];
    if (scene) {
      applyStoredZones(JSON.parse(scene), midi, true);
      view.renderZones();
      saveZones();
    }
    closeLoadSaveDialog();
  });
  attachSceneActionHandlers(
    container,
    () => {
      openLoadDialog(midi);
    },
    midi
  );
  DOM.show(container);
  onBackgroundClick(closeLoadSaveDialog, '#loadsave');
  isLoadSaveDialogOpenend = true;
}

function openSaveDialog() {
  const container = DOM.element('#loadsave');
  DOM.empty(container);
  DOM.addHTML(
    container,
    'beforeend',
    /*html*/ `<div onclick="closeLoadSaveDialog()" class="lsCancel"><i class="material-icons">close</i></div>
    <h2>Save scene</h2>
    <p><input type="text" placeholder="Enter name" id="newSceneName"/> 
    <button id="saveNew" class="lightButton">Save</button></p>
    <h2>Overwrite existing scene</h2>
    ${existingScenesHtml('save')}`
  );
  function saveSceneWithKey(key) {
    const scenesJ = localStorage.getItem('scenes');
    const scenes = scenesJ ? JSON.parse(scenesJ) : {};
    scenes[key] = JSON.stringify(zones);
    localStorage.setItem('scenes', JSON.stringify(scenes));
  }
  const nameInput = DOM.element('#newSceneName');
  DOM.element('#saveNew').addEventListener('click', () => {
    if (nameInput.value && nameInput.value.trim() != '') {
      saveSceneWithKey(nameInput.value.trim());
      closeLoadSaveDialog();
    }
  });
  DOM.on('#loadsave li', 'click', (ev) => {
    const index = new Number(ev.target.getAttribute('data-index'));
    saveSceneWithKey(savedScenesKeys()[index]);
    closeLoadSaveDialog();
  });
  attachSceneActionHandlers(container, openSaveDialog);
  DOM.show(container);
  nameInput.value = '';
  nameInput.focus();
  isLoadSaveDialogOpenend = true;
  onBackgroundClick(closeLoadSaveDialog, '#loadsave');
}

function closeLoadSaveDialog() {
  DOM.hide('#loadsave');
  isLoadSaveDialogOpenend = false;
}

document.addEventListener('DOMContentLoaded', function () {
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
    midi.sendInternalClockIfPlaying = zones.sendInternalClockIfPlaying;
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
        document.body.addEventListener('keyup', (ev) => {
          if (
            !isLoadSaveDialogOpenend &&
            document.activeElement.tagName != 'INPUT'
          ) {
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
          }
        });
        DOM.element('#save').addEventListener('click', (e) => {
          e.stopPropagation();
          openSaveDialog();
        });
        DOM.element('#load').addEventListener('click', (e) => {
          e.stopPropagation();
          openLoadDialog(midi);
        });
        DOM.element('#loadsave').addEventListener('click', (e) =>
          e.stopPropagation()
        );
        // document.body.addEventListener('click', closeLoadSaveDialog);
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
    midi.sendInternalClockIfPlaying = zones.sendInternalClockIfPlaying =
      document.querySelector('input[name="sendinternal"]:checked').value == '1';
    saveZones();
  });
  DOM.on('#tools *[data-select-seq-layer]', 'click', (ev) => {
    const el = ev.target;
    view.selectSequencerLayer(parseInt(el.dataset.selectSeqLayer));
    DOM.removeClass('#tools *[data-select-seq-layer]', 'selected');
    DOM.addClass(el, 'selected');
  });
  view.initController({ saveData: saveZones, data: zones, midi });
});
