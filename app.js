const DOM = require('./modules/domutils');
const Zone = require('./modules/zone');
const MIDI = require('./modules/midi');
const view = require('./modules/viewcontroller');

const zones = {
  list: [],
  inChannel: 0,
  sendClock: false,
  tempo: 120
};

function saveZones() {
  localStorage.setItem('zones', JSON.stringify(zones));
}

function loadZones(midi) {
  const zonesJson = localStorage.getItem('zones');
  if (zonesJson) {
    applyStoredZones(JSON.parse(zonesJson), midi);
  }
}

function applyStoredZones(storedZones, midi) {
  if (storedZones) {
    Object.assign(zones, storedZones);
    zones.list = [];
    for (let i = 0; i < storedZones.list.length; i++) {
      const zone = new Zone(midi);
      Object.assign(zone, storedZones.list[i]);
      zones.list.push(zone);
    }
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

function existingScenesHtml() {
  const savedList = savedScenesKeys();
  let existingHtml;
  if (savedList.length > 0) {
    existingHtml = '<ul>';
    savedList.forEach((k, index) => {
      existingHtml += `<li data-index="${index}"><i class="material-icons">delete</i>${k}</li>`;
    });
    existingHtml += '</ul>';
  } else {
    existingHtml = '<p><i>(nothing saved yet)</i></p>';
  }
  return existingHtml;
}

function attachDeleteHandler(container, reloadFunction) {
  DOM.find(container, 'li i').forEach((e) => {
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
    `<h2>Load scene</h2>
    ${existingScenesHtml()}
    <p><button onclick="closeLoadSaveDialog()" class="lightButton">Cancel</button></p>`
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
  attachDeleteHandler(container, () => {
    openLoadDialog(midi);
  });
  DOM.show(container);
  isLoadSaveDialogOpenend = true;
}

function openSaveDialog() {
  const container = DOM.element('#loadsave');
  DOM.empty(container);
  DOM.addHTML(
    container,
    'beforeend',
    `<h2>Save scene</h2>
    <p><input type="text" placeholder="Enter name" id="newSceneName"/> 
    <button id="saveNew" class="lightButton">Save</button></p>
    <h2>Overwrite existing scene</h2>
    ${existingScenesHtml()}
    <p><button onclick="closeLoadSaveDialog()" class="lightButton">Cancel</button></p>`
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
  attachDeleteHandler(container, openSaveDialog);
  DOM.show(container);
  nameInput.value = '';
  nameInput.focus();
  isLoadSaveDialogOpenend = true;
}

function closeLoadSaveDialog() {
  DOM.hide('#loadsave');
  isLoadSaveDialogOpenend = false;
}

function midiEventHandler(event) {
  const channel = event.data[0] & 0x0f;
  const msgtype = event.data[0] & 0xf0;
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
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const select_in = DOM.element('#midiInDeviceId');
  const select_in_clock = DOM.element('#midiClockInDeviceId');
  const optionNoDevice = '<option value="">(No devices available)</option>';
  let activeUpdateTimer = null;
  const midi = new MIDI({
    eventHandler: midiEventHandler,
    clockHandler: (pos) => {
      for (let i = 0; i < zones.list.length; i++) {
        zones.list[i].clock(pos);
      }
    },
    stoppedHandler: () => {
      zones.list.forEach((z) => {
        z.stopped();
      });
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
        midi.setInternalClockTempo(zones.tempo);
        const updateClockInterface = function () {
          console.log('app: Clock input device changed');
          if (midi.deviceInClock) {
            DOM.removeClass('#midisettings', 'internalClock');
          } else {
            DOM.addClass('#midisettings', 'internalClock');
          }
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
            view.renderZones();
          });
          saveZones();
        });
        DOM.element('#midiInChannel').selectedIndex = zones.inChannel;
        DOM.element('#midiInChannel').addEventListener('change', (e) => {
          zones.inChannel = e.target.selectedIndex;
          saveZones();
        });
        const displayBPM = DOM.element('#displayBPM');
        displayBPM.innerHTML = zones.tempo;
        let bpmStartX = 0;
        let bpmStartTempo = 0;
        let dragBPM = false;
        displayBPM.addEventListener('mousedown', (e) => {
          bpmStartX = e.screenX;
          bpmStartTempo = parseInt(zones.tempo);
          dragBPM = true;
          DOM.addClass(document.body, 'dragging');
        });
        document.body.addEventListener('mousemove', (e) => {
          if (dragBPM) {
            let dragTempo =
              bpmStartTempo + Math.round((e.screenX - bpmStartX) / 2);
            dragTempo = Math.min(Math.max(20, dragTempo), 240);
            zones.tempo = dragTempo;
            midi.setInternalClockTempo(zones.tempo);
            displayBPM.innerHTML = zones.tempo;
          }
        });
        document.body.addEventListener('mouseup', (e) => {
          if (dragBPM) {
            DOM.removeClass(document.body, 'dragging');
            dragBPM = false;
            saveZones();
          }
        });

        const sendClockCheck = DOM.element('#sendClock');
        if (zones.sendClock) {
          DOM.addClass(sendClockCheck, 'selected');
        }
        midi.setSendClock(zones.sendClock);
        sendClockCheck.addEventListener('click', (e) => {
          zones.sendClock = !zones.sendClock;
          if (zones.sendClock) {
            DOM.addClass(sendClockCheck, 'selected');
          } else {
            DOM.removeClass(sendClockCheck, 'selected');
          }
          midi.setSendClock(zones.sendClock);
          saveZones();
        });
        const startClockButton = DOM.element('#startClockButton');
        let clockRunning = false;
        startClockButton.addEventListener('click', () => {
          if (!midi.deviceInClock) {
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
          }
        });
        document.body.addEventListener('keyup', (ev) => {
          if (!isLoadSaveDialogOpenend && ev.key == ' ') {
            startClockButton.click();
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
          '<option value="*INTERNAL*">INTERNAL</option>'
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
        DOM.addClass(document.body, 'updated');
        setTimeout(() => {
          DOM.removeClass(document.body, 'updated');
        }, 1000);
      }, 100);
    }
  });
  const list = [select_in, select_in_clock];
  list.forEach((el) => {
    el.addEventListener('change', () => {
      const inId = DOM.find(select_in, 'option:checked')[0].value;
      const inClockId = DOM.find(select_in_clock, 'option:checked')[0].value;
      midi.selectDevices(inId, inClockId);
      localStorage.setItem('midiInId', inId);
      localStorage.setItem('midiInClockId', inClockId);
    });
  });
  view.initController({ saveData: saveZones, data: zones, midi });
});
