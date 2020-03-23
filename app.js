const DOM = require('./modules/domutils');
const Zone = require('./modules/zone');
const { MIDI, MIDI_MESSAGE } = require('./modules/midi');
const view = require('./modules/viewcontroller');

const zones = {
  list: [],
  inChannel: 0,
  inChannelExclusive: true,
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

function midiEventHandler(event, midiOutDevice) {
  const channel = event.data[0] & 0x0f;
  const msgtype = event.data[0] & 0xf0;
  if (msgtype === MIDI_MESSAGE.NOTE_ON && event.data[2] === 0) {
    msgtype = MIDI_MESSAGE.NOTE_OFF;
  }
  if (channel === zones.inChannel) {
    zones.list.forEach(zone => {
      zone.handleMidi(msgtype, event.data, midiOutDevice);
    });
  } else {
    // msg from other channel
    if (!zones.inChannelExclusive) {
      midiOutDevice.send(event.data);
    }
  }
}

document.addEventListener('DOMContentLoaded', function() {
  const midi = new MIDI({
    eventHandler: midiEventHandler,
    clockHandler: pos => {
      for (let i = 0; i < zones.list.length; i++) {
        zones.list[i].clock(pos);
      }
    },
    panicHandler: () => {
      zones.list.forEach(z => z.panic());
    },
    completeHandler: (midiavailable, message) => {
      // availability handler
      if (midiavailable) {
        console.log('MIDI available');
        loadZones(midi);
        midi.setInternalClockTempo(zones.tempo);
        view.renderZones();
        function createNewZone() {
          zones.list.push(new Zone(midi));
          saveZones();
          view.renderZones();
          DOM.element('#tools').scrollIntoView();
        }
        window.addEventListener('resize', () => {
          requestAnimationFrame(view.renderMarkersForAllZones);
        });
        DOM.element('#newzone').addEventListener('click', createNewZone);
        DOM.element('#allMuteOff').addEventListener('click', view.allMuteOff);
        DOM.element('#allSoloOff').addEventListener('click', view.allSoloOff);
        DOM.element('#allHoldOff').addEventListener('click', view.allHoldOff);
        DOM.element('#midiInChannel').selectedIndex = zones.inChannel;
        DOM.element('#midiInChannel').addEventListener('change', e => {
          zones.inChannel = e.target.selectedIndex;
          saveZones();
        });
        DOM.element('#inChannelExclusive').checked = zones.inChannelExclusive;
        DOM.element('#inChannelExclusive').addEventListener('change', e => {
          zones.inChannelExclusive = e.target.checked;
          saveZones();
        });

        const displayBPM = DOM.element('#displayBPM');
        displayBPM.innerHTML = zones.tempo;
        let bpmStartX = 0;
        let bpmStartTempo = 0;
        let dragBPM = false;
        displayBPM.addEventListener('mousedown', e => {
          bpmStartX = e.screenX;
          bpmStartTempo = parseInt(zones.tempo);
          dragBPM = true;
          DOM.addClass(document.body, 'dragging');
        });
        document.body.addEventListener('mousemove', e => {
          if (dragBPM) {
            let dragTempo =
              bpmStartTempo + Math.round((e.screenX - bpmStartX) / 2);
            dragTempo = Math.min(Math.max(20, dragTempo), 240);
            zones.tempo = dragTempo;
            midi.setInternalClockTempo(zones.tempo);
            displayBPM.innerHTML = zones.tempo;
          }
        });
        document.body.addEventListener('mouseup', e => {
          if (dragBPM) {
            DOM.removeClass(document.body, 'dragging');
            dragBPM = false;
            saveZones();
          }
        });

        const sendClockCheck = DOM.element('#sendClock');
        sendClockCheck.checked = zones.sendClock;
        midi.setSendClock(zones.sendClock);
        sendClockCheck.addEventListener('change', e => {
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
              zones.list.forEach(z => {
                z.stopped();
              });
            }
          }
        });
        document.body.addEventListener('keyup', ev => {
          if (ev.key == ' ') {
            startClockButton.click();
          }
        });
      } else {
        console.log(message);
      }
    }
  });
  view.initController({ saveZones, storage: zones, midi });
});
