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
  let stored = localStorage.getItem('zones');
  if (stored) {
    stored = JSON.parse(stored);
    Object.assign(zones, stored);
    zones.list = [];
    for (let i = 0; i < stored.list.length; i++) {
      const zone = new Zone(midi);
      Object.assign(zone, stored.list[i]);
      zones.list.push(zone);
    }
  }
}

function midiEventHandler(event) {
  const channel = event.data[0] & 0x0f;
  const msgtype = event.data[0] & 0xf0;
  if (msgtype === MIDI.MESSAGE.NOTE_ON && event.data[2] === 0) {
    msgtype = MIDI.MESSAGE.NOTE_OFF;
  }
  if (channel === zones.inChannel) {
    zones.list.forEach((zone) => {
      zone.handleMidi(msgtype, event.data);
    });
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const select_in = DOM.element('#midiInDeviceId');
  const select_in_clock = DOM.element('#midiClockInDeviceId');
  const optionNoDevice = '<option value="">(No devices available)</option>';

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
        sendClockCheck.checked = zones.sendClock;
        midi.setSendClock(zones.sendClock);
        sendClockCheck.addEventListener('change', (e) => {
          zones.sendClock = e.target.checked;
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
          if (ev.key == ' ') {
            startClockButton.click();
          }
        });
      } else {
        console.log('app:', message);
      }
    },
    updatePortsHandler: (inputs, outputs) => {
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
  view.initController({ saveZones, storage: zones, midi });
});
