const DOM = require('./modules/domutils');
const Zone = require('./modules/zone').Zone;
const Sequence = require('./modules/zone').Sequence;
const MIDI = require('./modules/midi');
const view = require('./modules/viewcontroller');

const zones = {
  list: [],
  inChannel: 0,
  clockOutputPorts: {},
  alternativeTheme: false,
  tempo: 120,
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

function loadZones(midi) {
  const zonesJson = localStorage.getItem('zones');
  if (zonesJson) {
    applyStoredZones(JSON.parse(zonesJson), midi);
  }
  updateThemeDisplay();
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
  }
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
          <i data-act="add" class="material-icons" title="Add to exisiting zones">add</i>
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
  DOM.find(container, 'li *[data-act="add"]').forEach((e) => {
    e.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const index = new Number(e.parentElement.getAttribute('data-index'));
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
  });
}

let isLoadSaveDialogOpenend = false;

function openLoadDialog(midi) {
  const container = DOM.element('#loadsave');
  DOM.empty(container);
  DOM.addHTML(
    container,
    'beforeend',
    `<div onclick="closeLoadSaveDialog()" class="lsCancel"><i class="material-icons">close</i></div>
    <h2>Load scene</h2>
    ${existingScenesHtml('load')}`
  );
  DOM.on('#loadsave li', 'click', (ev) => {
    const index = new Number(ev.target.getAttribute('data-index'));
    const scenesJ = localStorage.getItem('scenes');
    const scenes = scenesJ ? JSON.parse(scenesJ) : {};
    const scene = scenes[savedScenesKeys()[index]];
    if (scene) {
      applyStoredZones(JSON.parse(scene), midi);
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
  isLoadSaveDialogOpenend = true;
}

function openSaveDialog() {
  const container = DOM.element('#loadsave');
  DOM.empty(container);
  DOM.addHTML(
    container,
    'beforeend',
    `<div onclick="closeLoadSaveDialog()" class="lsCancel"><i class="material-icons">close</i></div>
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
}

function closeLoadSaveDialog() {
  DOM.hide('#loadsave');
  isLoadSaveDialogOpenend = false;
}

function updateThemeDisplay() {
  if (zones.alternativeTheme) {
    DOM.addClass(document.body, 'altTheme');
  } else {
    DOM.removeClass(document.body, 'altTheme');
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const select_in = DOM.element('#midiInDeviceId');
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
  let activeUpdateTimer = null;
  const midi = new MIDI({
    eventHandler: (event) => {
      if (midi.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
        // handle start/stop messages with internal clock active
        if (event.data[0] == 0xf0 && event.data[1] == 0x7f) {
          // realtime sysex
          if (event.data[2] == 0x7f && event.data[3] == 0x06) {
            if (event.data[4] == 0x01) {
              // stop/pause
              midi.stopClock();
              zones.list.forEach((z) => {
                z.stopped();
              });
            }
            if (event.data[4] == 0x02 || event.data[4] == 0x09) {
              // start/continue
              midi.startClock();
            }
          }
          return;
        } else {
          if (event.data[0] == MIDI.MESSAGE.START) {
            midi.startClock();
          } else if (event.data[0] == MIDI.MESSAGE.STOP) {
            midi.stopClock();
            zones.list.forEach((z) => {
              z.stopped();
            });
          }
        }
      }
      const channel = event.data[0] & 0x0f;
      let msgtype = event.data[0] & 0xf0;
      if (msgtype === MIDI.MESSAGE.NOTE_ON && event.data[2] === 0) {
        msgtype = MIDI.MESSAGE.NOTE_OFF;
      }
      if (channel === zones.inChannel) {
        zones.list.forEach((zone, index) => {
          const resultMessage = zone.handleMidi(msgtype, event.data);
          if (resultMessage == 'updateCC') {
            requestAnimationFrame(() => {
              view.updateControllerValues(zone, index);
            });
          }
        });
      } else {
        // forward messages from other channels
        midi.sendToAllUsedPorts(event.data);
      }
    },
    clockHandler: (pos) => {
      for (let i = 0; i < zones.list.length; i++) {
        zones.list[i].clock(pos);
      }
    },
    transportHandler: (started) => {
      if (started) {
        startClockButton.classList.add('selected');
      } else {
        startClockButton.classList.remove('selected');
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
          const newZone = new Zone(midi, zones.list.length);
          if (zones.list.length > 0) {
            newZone.preferredOutputPortId = newZone.outputPortId =
              zones.list[zones.list.length - 1].outputPortId;
          }
          zones.list.push(newZone);
          saveZones();
          view.renderLastZone();
          DOM.element('#tools').scrollIntoView();
        }
        window.addEventListener('resize', () => {
          requestAnimationFrame(view.renderMarkersForAllZones);
        });
        DOM.element('#newzone').addEventListener('click', createNewZone);
        for (var i = 0; i < 16; i++) {
          DOM.addHTML(
            '#midiInChannel',
            'beforeend',
            `<option>Ch ${i + 1}</option>`
          );
        }
        DOM.element('#shuffleColors').addEventListener('click', () => {
          zones.list.forEach((zone) => {
            zone.randomizeColor();
          });
          view.renderZones();
          saveZones();
        });
        DOM.element('#shuffleColors').addEventListener('dblclick', () => {
          const factor = zones.list.length > 11 ? 1 : 12 / zones.list.length;
          zones.list.forEach((/** @type {Zone} */ zone, index) => {
            zone.randomizeColor(parseInt(index * factor));
          });
          view.renderZones();
          saveZones();
        });
        DOM.element('#toggleTheme').addEventListener('click', () => {
          zones.alternativeTheme = !zones.alternativeTheme;
          saveZones();
          updateThemeDisplay();
          view.updateValuesForAllZones();
        });
        DOM.element('#midiInChannel').selectedIndex = zones.inChannel;
        DOM.element('#midiInChannel').addEventListener('change', (e) => {
          zones.inChannel = e.target.selectedIndex;
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
        midi.setInternalBPM(zones.tempo);
        document.body.addEventListener('keyup', (ev) => {
          if (!isLoadSaveDialogOpenend) {
            if (ev.key == ' ') {
              startClockButton.click();
            }
            const numIndex = '1234567890'.indexOf(ev.key);
            if (numIndex > -1) {
              view.soloZone(numIndex);
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
        document.body.addEventListener('click', closeLoadSaveDialog);
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
        DOM.empty(select_in);
        DOM.empty(select_in_clock);
        DOM.addHTML(
          select_in_clock,
          'beforeend',
          `<option value="*">Internal</option>`
        );
        if (inputs.length > 0) {
          inputs.forEach((input) => {
            DOM.addHTML(
              select_in,
              'beforeend',
              `<option value="${input.id}" ${
                input.isSelectedInput ? 'selected' : ''
              }>${input.name}</option>`
            );
            DOM.addHTML(
              select_in_clock,
              'beforeend',
              `<option value="${input.id}" ${
                input.isSelectedClockInput ? 'selected' : ''
              }>${input.name}</option>`
            );
          });
        } else {
          DOM.addHTML(select_in, 'beforeend', optionNoDevice);
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
          midi.selectDevices(midi.deviceIdIn, MIDI.INTERNAL_PORT_ID);
        }
        updateBpmInput();
        DOM.addClass(document.body, 'updated');
        setTimeout(() => {
          DOM.removeClass(document.body, 'updated');
        }, 1000);
      }, 100);
    }
  });
  const clockIndicator = DOM.element('#clockIndicator');
  setInterval(() => {
    if (midi.hasClock) {
      clockIndicator.classList.add('yes');
    } else {
      clockIndicator.classList.remove('yes');
    }
  }, 999);
  const list = [select_in, select_in_clock];
  list.forEach((el) => {
    el.addEventListener('change', () => {
      const inId = DOM.find(select_in, 'option:checked')[0].value;
      const inClockId = DOM.find(select_in_clock, 'option:checked')[0].value;
      midi.selectDevices(inId, inClockId);
      updateBpmInput();
      localStorage.setItem('midiInId', inId);
      localStorage.setItem('midiInClockId', inClockId);
    });
  });
  view.initController({ saveData: saveZones, data: zones, midi });
});
