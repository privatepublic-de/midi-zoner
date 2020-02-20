const { ipcRenderer } = require('electron');
const MidiClock = require('midi-clock');
const DragZone = require('./modules/dragzone');
const Zone = require('./modules/zone');

const NOTENAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B'
];
const DIV_TICKS = [96, 72, 64, 48, 36, 32, 24, 18, 16, 12, 9, 8, 6, 4, 3]; // 24ppq

class Note {
  number = 0;
  velo = 0;
  constructor(number, velo) {
    this.number = number;
    this.velo = velo;
  }
}

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

const catchedMarker = [0, 0, 0, 0];

function actionHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-action') || e.getAttribute('data-change');
  const params = action.split(':');
  const zoneindex = params[0];
  const zone = zones.list[zoneindex];
  switch (params[1]) {
    case 'range':
      let num = parseInt(((ev.clientX - e.offsetLeft) / e.offsetWidth) * 128);
      if (num > 127) num = 127;
      if (catchedMarker[zoneindex] < 0) {
        zone.low = num;
      } else {
        zone.high = num;
      }
      renderMarkersForZone(zoneindex);
      catchedMarker[zoneindex] = 0;
      // updateValuesForZone(zoneindex);
      break;
    case 'ch':
      let number = parseInt(params[2]);
      zone.channel = number;
      updateValuesForZone(zoneindex);
      break;
    case 'octave':
      zone.octave = parseInt(params[2]);
      updateValuesForZone(zoneindex);
      break;
    case 'cc':
    case 'sustain':
    case 'mod':
    case 'fixedvel':
    case 'pitchbend':
    case 'programchange':
    case 'arp_hold':
    case 'arp_repeat':
    case 'arp_enabled':
      zone[params[1]] = !zone[params[1]];
      updateValuesForZone(zoneindex);
      break;
    case 'arp_direction':
    case 'arp_octaves':
    case 'arp_division':
      zone[params[1]] = e.selectedIndex;
      updateValuesForZone(zoneindex);
      break;
    case 'enabled':
      zone.enabled = !zone.enabled;
      if (zone.solo) {
        zone.solo = false;
        updateValuesForAllZones();
      } else {
        updateValuesForZone(zoneindex);
      }
      break;
    case 'solo':
      if (zone.enabled) {
        zone.solo = !zone.solo;
        updateValuesForAllZones();
      }
      break;
    case 'delete':
      zones.list[zoneindex].solo = false;
      zones.list.splice(zoneindex, 1);
      renderZones();
      saveZones();
      break;
  }
  saveZones();
}

function hoverHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-hover');
  const params = action.split(':');
  const zoneindex = params[0];
  const zone = zones.list[zoneindex];
  switch (params[1]) {
    case 'range':
      let num = parseInt(((ev.clientX - e.offsetLeft) / e.offsetWidth) * 128);
      if (num > 127) num = 127;
      const middle = zone.low + (zone.high - zone.low) / 2;
      if (catchedMarker[zoneindex] === 0) {
        catchedMarker[zoneindex] = num < middle ? -1 : 1;
      }
      if (catchedMarker[zoneindex] < 0 && num > zone.high) {
        catchedMarker[zoneindex] = 1;
      }
      if (catchedMarker[zoneindex] > 0 && num < zone.low) {
        catchedMarker[zoneindex] = -1;
      }
      let tempLow, tempHigh;
      if (catchedMarker[zoneindex] < 0) {
        tempLow = num;
      } else {
        tempHigh = num;
      }
      renderMarkersForZone(zoneindex, tempLow, tempHigh);
      break;
  }
  updateValuesForZone(zoneindex);
}

function hoverOutHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-hover');
  const params = action.split(':');
  const zoneindex = params[0];
  catchedMarker[zoneindex] = 0;
  renderMarkersForZone(zoneindex);
}

function dblClickHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-action');
  const params = action.split(':');
  const zoneindex = params[0];
  zones.list[zoneindex].high = 127;
  zones.list[zoneindex].low = 0;
  catchedMarker[zoneindex] = 0;
  renderMarkersForZone(zoneindex);
  saveZones();
}

function renderZones() {
  DOM.empty('#zones');
  zones.list.forEach((zone, index) => {
    let channelselectors = '';
    for (let i = 0; i < 16; i++) {
      channelselectors += `<div class="ch ${
        zone.channel == i ? 'selected' : ''
      } no${i}" data-action="${index}:ch:${i}">${i + 1}</div>`;
    }
    const octavemarkers =
      '<span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span>';
    const html = `<section class="zone" id="zone${index}">
            <div class="delzone" data-action="${index}:delete" title="Remove zone">✕</div>
            <div class="dragzone" title="Drag zone">≡</div>
            <div class="channels"><div class="ch enabled" data-action="${index}:enabled" title="Mute Zone">M</div><div class="ch solo" data-action="${index}:solo" title="Solo Zone">S</div>${channelselectors}</div>
            <div class="range" data-hover="${index}:range" data-action="${index}:range">
                ${octavemarkers}
                <span class="join"></span>
                <span class="current"></span>
                <span class="marker low">C-1</span>
                <span class="marker high">G9</span>
                <canvas id="canvas${index}" width="100" height="16"></canvas>
            </div>
            <div class="settings">
                <div class="check arp_enabled" data-action="${index}:arp_enabled">ARP</div>
                <div class="val">Oct 
                    <a class="circle" data-action="${index}:octave:-2"></a> 
                    <a class="circle" data-action="${index}:octave:-1"></a> 
                    <a class="circle selected" data-action="${index}:octave:0"></a> 
                    <a class="circle" data-action="${index}:octave:1"></a> 
                    <a class="circle" data-action="${index}:octave:2"></a> 
                </div>
                <div class="check mod" data-action="${index}:mod">Mod</div>
                <div class="check sustain" data-action="${index}:sustain">Pedal</div>
                <div class="check cc" data-action="${index}:cc">CCs</div>
                <div class="check pitchbend" data-action="${index}:pitchbend">PB</div>
                <div class="check programchange" data-action="${index}:programchange">PRGM</div>
                <div class="check fixedvel" data-action="${index}:fixedvel">Fixed Vel</div>
            </div>
            <div class="arp-settings">
                <span class="arpanchor"></span>
                <div class="check arp_hold" data-action="${index}:arp_hold">Hold</div>
                <div class="drop-down">
                  <select class="arp_direction" data-change="${index}:arp_direction">
                    <option>UP</option>
                    <option>DOWN</option>
                    <option>UP/DOWN</option>
                    <option>RANDOM</option>
                    <option>ORDER</option>
                  </select>
                </div>
                <div class="drop-down">
                  Notes
                  <select class="arp_division" data-change="${index}:arp_division">
                    <option>1/1 whole</option>
                    <option>1/2.</option>
                    <option>1/1t</option>
                    <option>1/2 half</option>
                    <option>1/4.</option>
                    <option>1/2t</option>
                    <option>1/4 quarter</option>
                    <option>1/8.</option>
                    <option>1/4t</option>
                    <option>1/8 eighth</option>
                    <option>1/16.</option>
                    <option>1/8t</option>
                    <option>1/16 sixteenth</option>
                    <option>1/32.</option>
                    <option>1/32 thirty2nd</option>
                  </select>
                </div>
                <div class="drop-down">
                  Oct
                  <select class="arp_octaves" data-change="${index}:arp_octaves">
                    <option>1</option>
                    <option>2</option>
                    <option>3</option>
                    <option>4</option>
                  </select>
                </div>
                <div class="check arp_repeat" data-action="${index}:arp_repeat">Repeat</div>
            </div>
        </section>`;
    DOM.addHTML('#zones', 'beforeend', html);
    zone.canvasElement = DOM.element(`#canvas${index}`);
    zone.dom.markerlow = DOM.element(`#zone${index} .marker.low`);
    zone.dom.markerhigh = DOM.element(`#zone${index} .marker.high`);
    zone.dom.join = DOM.element(`#zone${index} .join`);
    zone.dom.current = DOM.element(`#zone${index} .current`);
    renderMarkersForZone(index);
    updateValuesForZone(index);
    const dragHandler = DOM.element(`#zone${index} .dragzone`);
    dragHandler.addEventListener('mousedown', ev => {
      new DragZone(index, ev, () => {
        saveZones();
        renderZones();
      });
    });
  });
  DOM.all('*[data-action]').forEach(e => {
    e.addEventListener('click', actionHandler);
  });
  DOM.all('*[data-change]').forEach(e => {
    e.addEventListener('change', actionHandler);
  });
  DOM.all('*[data-hover]').forEach(e => {
    e.addEventListener('mousemove', hoverHandler);
    e.addEventListener('mouseleave', hoverOutHandler);
    e.addEventListener('dblclick', dblClickHandler);
  });
}

function renderMarkersForAllZones() {
  for (let i = 0; i < zones.list.length; i++) {
    renderMarkersForZone(i);
  }
}

function renderMarkersForZone(index, tempLo, tempHigh) {
  const zone = zones.list[index];
  const low = tempLo != undefined ? tempLo : zone.low;
  const high = tempHigh != undefined ? tempHigh : zone.high;
  const xlow = low / 127.0;
  const xhi = high / 127.0;
  const xclow = zone.low / 127.0;
  const xchi = zone.high / 127.0;
  const width = DOM.element(`#zone${index} .range`).offsetWidth;
  const xpad = (0.75 / 127.0) * width;
  zone.dom.markerlow.style.left = `${xlow * width}px`;
  zone.dom.markerhigh.style.right = `${width - xhi * width - xpad}px`;
  zone.dom.markerlow.innerHTML = NOTENAMES[low % 12] + (parseInt(low / 12) - 1);
  zone.dom.markerhigh.innerHTML =
    NOTENAMES[high % 12] + (parseInt(high / 12) - 1);
  zone.dom.join.style.left = `${xlow * width}px`;
  zone.dom.join.style.right = `${width - xhi * width - xpad}px`;
  zone.dom.current.style.left = `${xclow * width}px`;
  zone.dom.current.style.right = `${width - xchi * width - xpad}px`;
  let ocount = 0;
  DOM.all(`#zone${index} .range .oct`, e => {
    ocount++;
    e.style.left = `${((ocount * 12) / 127.0) * width}px`;
    e.innerHTML = ocount - 1;
  });
  if (tempLo != undefined) {
    DOM.addClass(zone.dom.markerlow, 'hover');
  } else {
    DOM.removeClass(zone.dom.markerlow, 'hover');
  }
  if (tempHigh != undefined) {
    DOM.addClass(zone.dom.markerhigh, 'hover');
  } else {
    DOM.removeClass(zone.dom.markerhigh, 'hover');
  }
}

function updateValuesForAllZones() {
  for (let i = 0; i < zones.list.length; i++) {
    updateValuesForZone(i);
  }
}

function updateValuesForZone(index) {
  const zone = zones.list[index];
  DOM.removeClass(`#zone${index} *[data-action]`, 'selected');
  DOM.addClass(`#zone${index} .no${zone.channel}`, 'selected');
  if (zone.enabled && (Zone.solocount === 0 || zone.solo)) {
    DOM.removeClass(`#zone${index}`, 'disabled');
    const rgb = hslToRgb(zone.channel / 16, 0.5, 0.3);
    DOM.element(
      `#zone${index}`
    ).style.backgroundColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`;
  } else {
    DOM.addClass(`#zone${index}`, 'disabled');
    const rgb = hslToRgb(zone.channel / 16, 0.2, 0.2);
    DOM.element(
      `#zone${index}`
    ).style.backgroundColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`;
  }
  [
    'cc',
    'mod',
    'sustain',
    'fixedvel',
    'pitchbend',
    'enabled',
    'solo',
    'programchange',
    'arp_enabled',
    'arp_hold',
    'arp_repeat'
  ].forEach(p => {
    if (zone[p]) {
      DOM.addClass(`#zone${index} .${p}`, 'selected');
    }
  });
  ['arp_direction', 'arp_division', 'arp_octaves'].forEach(p => {
    DOM.element(`#zone${index} .${p}`).selectedIndex = zone[p];
  });

  if (zone.arp_enabled) {
    DOM.addClass(`#zone${index}`, 'arp-enabled');
  } else {
    DOM.removeClass(`#zone${index}`, 'arp-enabled');
  }
  DOM.all(`#zone${index} .circle`, e => {
    const parts = e.getAttribute('data-action').split(':');
    if (parts[2] == zone.octave) {
      DOM.addClass(e, 'selected');
    }
  });
}

function allMuteOff() {
  for (var i = 0; i < zones.list.length; i++) {
    const zone = zones.list[i];
    zone.enabled = true;
  }
  updateValuesForAllZones();
  saveZones();
}

function allSoloOff() {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].solo = false;
  }
  updateValuesForAllZones();
  saveZones();
}

function allHoldOff() {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].arp_hold = false;
  }
  updateValuesForAllZones();
  saveZones();
}

document.addEventListener('DOMContentLoaded', function() {
  const clock = MidiClock(window.webkitAudioContext);
  const midi = new MIDI(
    (midiavailable, message) => {
      if (midiavailable) {
        console.log('MIDI available');
        loadZones(midi);
        // Clock
        clock.on('position', pos => {
          if (!midi.deviceInClock) {
            if (zones.sendClock) {
              midi.sendClock();
            }
            for (let i = 0; i < zones.list.length; i++) {
              zones.list[i].clock(pos);
            }
          }
        });

        clock.setTempo(zones.tempo);
        if (zones.sendClock) {
          console.log('Starting internal clock send');
          clock.start();
          midi.sendStart();
        }
        renderZones();
        function createNewZone() {
          zones.list.push(new Zone(midi));
          saveZones();
          renderZones();
          DOM.element('#tools').scrollIntoView();
        }

        window.addEventListener('resize', () => {
          requestAnimationFrame(renderMarkersForAllZones);
        });
        DOM.element('#newzone').addEventListener('click', createNewZone);
        DOM.element('#allMuteOff').addEventListener('click', allMuteOff);
        DOM.element('#allSoloOff').addEventListener('click', allSoloOff);
        DOM.element('#allHoldOff').addEventListener('click', allHoldOff);
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
            clock.setTempo(zones.tempo);
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

        DOM.element('#sendClock').checked = zones.sendClock;
        DOM.element('#sendClock').addEventListener('change', e => {
          zones.sendClock = e.target.checked;
          if (zones.sendClock) {
            clock.start();
            if (!midi.deviceInClock) {
              midi.sendStart();
            }
          } else {
            if (!midi.deviceInClock) {
              midi.sendStop();
            }
          }
          saveZones();
        });
      } else {
        console.log(message);
      }
    },
    midiEventHandler,
    pos => {
      for (let i = 0; i < zones.list.length; i++) {
        zones.list[i].clock(pos);
      }
    }
  );

  ipcRenderer.send('show', true);
});
