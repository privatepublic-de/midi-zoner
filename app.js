const { ipcRenderer } = require('electron');
const MidiClock = require('midi-clock');
const DragZone = require('./modules/dragzone');

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

class Zone {
  static solocount = 0;
  channel = 0; // 0-based
  enabled = true;
  solo = false;
  programchange = false;
  low = 0;
  high = 127;
  octave = 0;
  fixedvel = false;
  mod = true;
  sustain = true;
  cc = true;
  pitchbend = true;
  arp_enabled = false;
  arp_direction = 0; // 0=UP, 1=DOWN, 2=UP/DOWN, 3=RANDOM, 4=ORDER
  _arp_octaves = 0;
  _arp_division = 6;
  arp_ticks = DIV_TICKS[6];
  arp_gatelength = 0.5;
  arp_repeat = 0;
  arp_velocity = 0; // 0 = as played
  arp_hold = false;
  arp = {
    // holdlist: [],
    orderlist: [],
    sortedlist: [],
    // holdcount: 0,
    noteindex: -1,
    inc: 1,
    lastnote: null,
    repeattrig: false,
    repeatnote: null,
    beat: false
  };
  activeNotes = [];
  holdList = [];
  canvasElement = null;
  midi = null;
  dom = {};

  constructor(midi) {
    this.midi = midi;
  }

  toJSON() {
    return {
      channel: this.channel,
      enabled: this.enabled,
      solo: this.solo,
      programchange: this.programchange,
      low: this.low,
      high: this.high,
      octave: this.octave,
      fixedvel: this.fixedvel,
      mod: this.mod,
      sustain: this.sustain,
      cc: this.cc,
      pitchbend: this.pitchbend,
      arp_enabled: this.arp_enabled,
      arp_direction: this.arp_direction,
      arp_octaves: this._arp_octaves,
      arp_division: this._arp_division,
      arp_gatelength: this.arp_gatelength,
      arp_repeat: this.arp_repeat
    };
  }

  get arp_division() {
    return this._arp_division;
  }

  set arp_division(v) {
    this._arp_division = v;
    this.arp_ticks = DIV_TICKS[v];
  }

  get arp_octaves() {
    return this._arp_octaves;
  }

  set arp_octaves(v) {
    this._arp_octaves = v;
    this.notesChanged();
  }

  addNote(note) {
    if (this.activeNotes.length === 0) {
      this.holdList = [];
    }
    this.activeNotes.push(note);
    this.holdList.push(note);
  }

  removeNote(number) {
    let index = -1;
    for (let i = 0; i < this.activeNotes.length; i++) {
      if (this.activeNotes[i].number === number) {
        index = i;
        break;
      }
    }
    if (index > -1) {
      this.activeNotes.splice(index, 1);
    } else {
      console.log(`Zone.removeNote: Note ${number} not found`);
    }
  }

  handleMidi(message, data, midiOutDevice) {
    if (this.enabled && (Zone.solocount === 0 || this.solo)) {
      switch (message) {
        case MIDI_MESSAGE.NOTE_OFF: // note off
        case MIDI_MESSAGE.NOTE_ON: // note on
          let key = data[1];
          let velo = data[2];
          if (key >= this.low && key <= this.high) {
            key = key + this.octave * 12;
            if (key >= 0 && key <= 127) {
              if (this.fixedvel && velo > 0) {
                velo = 127;
              }
              if (!this.arp_enabled) {
                const outevent = new Uint8Array(data);
                outevent[0] = message + this.channel;
                outevent[1] = key;
                outevent[2] = velo;
                midiOutDevice.send(outevent);
              }
            }
          }
          if (message === MIDI_MESSAGE.NOTE_ON) {
            this.addNote(new Note(key, velo));
          } else {
            this.removeNote(key);
          }
          this.notesChanged();
          break;
        case MIDI_MESSAGE.CONTROLLER: // cc
          if (data[1] == 0x40 && !this.sustain) {
            // no sustain pedal
            return;
          }
          if (data[1] == 0x01 && !this.mod) {
            // no mod wheel
            return;
          }
          if (!this.cc && data[1] != 0x40 && data[1] != 0x01) {
            // no ccs in general
            return;
          }
          const outevent = new Uint8Array(data);
          outevent[0] = message + this.channel;
          midiOutDevice.send(outevent);
          break;
        case MIDI_MESSAGE.PITCH_BEND: // pitch bend
          if (this.pitchbend) {
            const outevent = new Uint8Array(data);
            outevent[0] = message + this.channel;
            midiOutDevice.send(outevent);
          }
          break;
        case MIDI_MESSAGE.PGM_CHANGE: // prgm change
          if (this.programchange) {
            const outevent = new Uint8Array(data);
            outevent[0] = message + this.channel;
            midiOutDevice.send(outevent);
          }
          break;
        default: {
          const outevent = new Uint8Array(data);
          outevent[0] = message + this.channel;
          midiOutDevice.send(outevent);
        }
      }
    }
  }

  notesChanged() {
    this.arp.orderlist = Array.from(this.activeNotes);
    for (let i = 0; i < this._arp_octaves; i++) {
      // add arp octaves
      for (let j = 0; j < this.activeNotes.length; j++) {
        const note = this.activeNotes[j];
        this.arp.orderlist.push(
          new Note(note.number + 12 * (i + 1), note.velo)
        );
      }
    }
    this.arp.sortedlist = Array.from(this.arp.orderlist).sort(
      (a, b) => a.number - b.number
    );
    this.arp.sortedHoldList = Array.from(this.holdList).sort(
      (a, b) => a.number - b.number
    );

    requestAnimationFrame(this.renderNotes.bind(this));
  }

  renderNotes() {
    if (this.canvasElement) {
      this.canvasElement.width = this.canvasElement.parentElement.offsetWidth;
      const ctx = this.canvasElement.getContext('2d');
      const cwidth = this.canvasElement.width;
      ctx.clearRect(0, 0, cwidth, this.canvasElement.height);
      ctx.fillStyle = this.arp_enabled
        ? 'rgba(0,0,0,.5)'
        : 'rgba(255,255,255,.5)';
      const list = this.arp_hold ? this.holdList : this.activeNotes;
      for (let i = 0; i < list.length; i++) {
        const number = list[i].number;
        ctx.fillRect((cwidth * number) / 127, 0, 5, 16);
      }
      if (this.arp_enabled) {
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        const note = this.arp.lastnote;
        if (note) {
          ctx.fillRect((cwidth * note.number) / 127, 0, 5, 16);
        }
      }
    }
  }

  clock(pos) {
    const tickn = pos % this.arp_ticks;
    if (tickn === 0) {
      if (this.arp_enabled) {
        this.arp.beat = true;
        let notes;
        if (this.arp_hold) {
          notes = Array.from(
            this.arp_direction > 2 ? this.holdList : this.arp.sortedHoldList
          );
        } else {
          notes = Array.from(
            this.arp_direction > 2 ? this.arp.orderlist : this.arp.sortedlist
          );
        }
        if (notes.length > 0 /*&& (zones.solocount === 0 || this.solo)*/) {
          // send next note
          const repetition = this.arp_repeat && this.arp.repeattrig;
          if (!repetition) {
            switch (this.arp_direction) {
              case 0: // up
              case 4: // order
                this.arp.noteindex = (this.arp.noteindex + 1) % notes.length;
                break;
              case 1: // down
                this.arp.noteindex--;
                if (this.arp.noteindex < 0) {
                  this.arp.noteindex = notes.length - 1;
                }
                break;
              case 2: // updown
                this.arp.noteindex += this.arp.inc;
                if (this.arp.noteindex >= notes.length - 1) {
                  this.arp.inc = -1;
                  if (this.arp.noteindex > notes.length - 1) {
                    this.arp.noteindex = Math.max(notes.length - 1, 0);
                  }
                } else if (this.arp.noteindex < 1) {
                  this.arp.inc = 1;
                }
                break;
              case 3: // random
                this.arp.noteindex = parseInt(Math.random() * notes.length);
                break;
            }
          }
          if (this.arp.noteindex > -1 && this.arp.noteindex < notes.length) {
            const activeNote = repetition
              ? this.arp.repeatnote
              : notes[this.arp.noteindex];
            let number = repetition
              ? activeNote.number
              : activeNote.number + this.octave * 12;
            while (number > 127) number -= 12;
            while (number < 0) number += 12;
            const note = new Note(number, activeNote.velo);
            this.arp.lastnote = note;
            this.midi.send(
              Uint8Array.from([
                MIDI_MESSAGE.NOTE_ON + this.channel,
                note.number,
                this.fixedvel ? 127 : note.velo
              ])
            );
          }
        }
        this.arp.repeattrig = !this.arp.repeattrig;
        requestAnimationFrame(this.renderNotes.bind(this));
      }
    } else if (tickn > this.arp_ticks * this.arp_gatelength) {
      this.arp.beat = false;
      if (this.arp.lastnote) {
        // send note off
        const note = this.arp.lastnote;
        this.midi.send(
          Uint8Array.from([
            MIDI_MESSAGE.NOTE_OFF + this.channel,
            note.number,
            note.velo
          ])
        );
        this.arp.lastnote = null;
        this.arp.repeatnote = note;
      }
      requestAnimationFrame(this.renderNotes.bind(this));
    }
  }
}

const zones = {
  list: [],
  // solocount: 0,
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
        Zone.solocount--;
        updateValuesForAllZones();
      } else {
        updateValuesForZone(zoneindex);
      }
      break;
    case 'solo':
      if (zone.enabled) {
        zone.solo = !zone.solo;
        if (zone.solo) {
          Zone.solocount++;
        } else {
          Zone.solocount--;
        }
        updateValuesForAllZones();
      }
      break;
    case 'delete':
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
    const rgb = hslToRgb(zone.channel / 16, 0.4, 0.3);
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
    const zone = zones.list[i];
    zone.solo = false;
  }
  Zone.solocount = 0;
  updateValuesForAllZones();
  saveZones();
}

function allHoldOff() {
  for (var i = 0; i < zones.list.length; i++) {
    const zone = zones.list[i];
    zone.arp_hold = false;
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
