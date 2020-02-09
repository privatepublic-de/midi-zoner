const { ipcRenderer } = require('electron');
// const objectAssignDeep = require(`object-assign-deep`);
const MidiClock = require('midi-clock');
const EventEmitter = require('events');
const clock = MidiClock(window.webkitAudioContext);

const NOTENAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DIV_TICKS = [ 96, 72, 64, 48, 36, 32, 24, 18, 16, 12, 9, 8, 6, 4, 3 ]; // 24ppq

class Live extends EventEmitter {
  tempo = 120;
  activeNotes = [];
  arpActive = false;

  addNote(note) {
    this.activeNotes.push(note);
    this.emit('noteschanged');
  }

  removeNote(number) {
    let index = -1;
    for (let i=0;i<this.activeNotes.length;i++) {
      if (this.activeNotes[i].number === number) {
        index = i
        break;
      }
    }
    if (index>-1) {
      this.activeNotes.splice(index, 1);
      this.emit('noteschanged');
    } else {
      console.log(`Live.removeNote: Note ${number} not found`);
    }
  }
}

const live = new Live();

class Note {
  number = 0;
  velo = 0;
  constructor(number, velo) {
    this.number = number;
    this.velo = velo;
  }
}


class Zone {
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
  arp_octaves = 0;
  _arp_division = 6;
  arp_ticks = DIV_TICKS[6];
  arp_gatelength = .5;
  arp_repeat = 0;
  arp_velocity = 0; // 0 = as played
  arp_hold = false;
  arp = {
    holdlist: [],
    holdcount: 0,
    noteindex: -1,
    inc: 1,
    lastnote: null,
    repeattrig: false,
    repeatnote: null
  };
  activeNotes = [];
  activeNotesSorted = [];
  midi = null;

  constructor(midi) {
    this.midi = midi;
    this.notesChanged = this.notesChanged.bind(this);
    live.on('noteschanged', this.notesChanged);
  }

  get arp_division() {
    return this._arp_division;
  }

  set arp_division(v) {
    this._arp_division = v;
    this.arp_ticks = DIV_TICKS[v];
    console.log(`Zone: Arp division ${v}, ${this.arp_ticks} ticks`);
  }

  detach() {
    live.off('noteschanged', this.notesChanged);
  }

  notesChanged() {
    this.activeNotes = live.activeNotes.filter(note => note.number>=this.low && note.number<=this.high);
    this.activeNotesSorted = Array.from(this.activeNotes).sort((a,b)=>a.number-b.number);
  }

  clock(pos) {
    if (this.arp_enabled) {
      const remainder = pos % this.arp_ticks;
      if (remainder===0) {
        let notes;
        const activelist = this.arp_direction>2?this.activeNotes:this.activeNotesSorted;;
        if (this.arp_hold) {
          if (this.activeNotes.length>0) {
            if (this.activeNotes.length>=this.arp.holdcount) {
              this.arp.holdlist = Array.from(activelist);
              this.arp.holdcount = this.arp.holdlist.length;
            }
          } else {
            this.arp.holdcount = 0;
          }
          notes = this.arp.holdlist;
        } else {
          notes = activelist;
        }
        if (notes.length>0 && (this.enabled && (zones.solocount===0 || this.solo))) {
          // send next note
          const repetition = this.arp_repeat && this.arp.repeattrig;
          if (!repetition) {
            switch (this.arp_direction) {
              case 0: // up
              case 4: // order
                this.arp.noteindex = (this.arp.noteindex+1)%notes.length;
                break;
              case 1: // down
                this.arp.noteindex--;
                if (this.arp.noteindex<0) {
                  this.arp.noteindex = notes.length-1;
                }
                break;
              case 2: // updown
                this.arp.noteindex+= this.arp.inc;
                if (this.arp.noteindex>=notes.length-1) {
                  this.arp.inc = -1;
                  if (this.arp.noteindex>notes.length-1) {
                    this.arp.noteindex = Math.max(notes.length-1,0);
                  }
                } else if (this.arp.noteindex<1) {
                  this.arp.inc = 1;
                }
                break;
              case 3: // random
                this.arp.noteindex = parseInt(Math.random()*notes.length);
                break;
              }
          }
          if (this.arp.noteindex>-1) {
            const activeNote = repetition?this.arp.repeatnote:notes[this.arp.noteindex];
            const note = new Note(activeNote.number, activeNote.velo);
            this.arp.lastnote = note;
            this.midi.send(Uint8Array.from([0x90+this.channel, note.number, note.velo]));
          }
        }
        this.arp.repeattrig = !this.arp.repeattrig;
      } else if (this.arp.lastnote && remainder>this.arp_ticks*this.arp_gatelength) {
        // send note off
        const note = this.arp.lastnote;
        this.midi.send(Uint8Array.from([0x80+this.channel, note.number, note.velo]));
        this.arp.lastnote = null;
        this.arp.repeatnote = note;
      }
    }
  }

}

const zones = {
  list: [],
  solocount: 0,
  inChannel: 0,
  inChannelExclusive: true
};

function saveZones() {
  console.log('SAVE ZONES disabled for now');
  // localStorage.setItem('zones', JSON.stringify(zones));
}

function loadZones() {
  console.log('LOAD ZONES disabled for now');
  // const stored = localStorage.getItem('zones');
  // if (stored) {
  //   objectAssignDeep(zones, JSON.parse(stored));
  //   for (let i=0; i<zones.list.length; i++) {
  //     zones.list[i] = objectAssignDeep.noMutate(zonetemplate, zones.list[i]); // ensure availability of new properties 
  //   }
  //   console.log(zones);
  // }
}

function midiEventHandler(event, midiOutDevice) {
  if ((event.data[0] & 0x0f) === zones.inChannel) {
    const msgtype = (event.data[0] & 0xf0);
    const noteOn = (msgtype==0x90 && event.data[2]>0);
    const noteOff = msgtype==0x80 || (msgtype==0x90 && event.data[2]===0);
    if (noteOn) {
      live.addNote(new Note(event.data[1], event.data[2]));
    } else if (noteOff) {
      live.removeNote(event.data[1]);
    }
    zones.list.forEach( (zone, index) => {
      if (zone.enabled && (zones.solocount===0 || zone.solo)) {
        switch (msgtype) {
          case 0x80: // note off
          case 0x90: // note on
            if (!zone.arp_enabled) {
              let key = event.data[1];
              let velo = event.data[2];
              if (key >= zone.low && key <= zone.high) {
                key = key + zone.octave * 12;
                if (key>=0 && key<=127) {
                  if (zone.fixedvel && velo > 0) {
                    velo = 127;
                  }
                  const outevent = new Uint8Array(event.data);
                  outevent[0] = msgtype + zone.channel;
                  outevent[1] = key;
                  outevent[2] = velo;
                  midiOutDevice.send(outevent);
                  setTimeout(()=>{ updateKeyForZone(index, event.data[1], noteOn)},0);
                }
              }
            }
            break;
          case 0xb0: // cc
            if (event.data[1] == 0x40 && !zone.sustain) { // no sustain pedal
              return;
            } 
            if (event.data[1] == 0x01 && !zone.mod) { // no mod wheel
              return;
            }
            if (!zone.cc && event.data[1] != 0x40 && event.data[1] != 0x01) { // no ccs in general
              return;
            }
            const outevent = new Uint8Array(event.data);
            outevent[0] = msgtype + zone.channel;
            midiOutDevice.send(outevent);
            break;
          case 0xe0: // pitch bend
            if (zone.pitchbend) {
              const outevent = new Uint8Array(event.data);
              outevent[0] = msgtype + zone.channel;
              midiOutDevice.send(outevent);
            }
            break;
          case 0xc0: // prgm change
            if (zone.programchange) {
              const outevent = new Uint8Array(event.data);
              outevent[0] = msgtype + zone.channel;
              midiOutDevice.send(outevent);
            }
            break;
          default: {
              const outevent = new Uint8Array(event.data);
              outevent[0] = msgtype + zone.channel;
              midiOutDevice.send(outevent);
            }
        }
      }
    });
  } else {
    // msg from other channel
    if (!zones.inChannelExclusive) {
      midiOutDevice.send(event.data);
    }
  }
}

const catchedMarker = [ 0, 0, 0, 0];

function actionHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-action') || e.getAttribute('data-change') ;
  const params = action.split(':');
  const zoneindex = params[0];
  const zone = zones.list[zoneindex];
  switch (params[1]) {
    case 'range':
      let num = parseInt(((ev.clientX - e.offsetLeft) / (e.offsetWidth)) * 128);
      if (num > 127) num = 127;
      if (catchedMarker[zoneindex]<0) {
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
      zone.enabled = !zone.enabled
      if (zone.solo) {
        zone.solo = false;
        zones.solocount--;
        updateValuesForAllZones();
      };
      break;
    case 'solo':
      if (zone.enabled) {
        zone.solo = !zone.solo;
        if (zone.solo) {
          zones.solocount++;
        } else {
          zones.solocount --;
        }
        updateValuesForAllZones();
      }
      break;
    case 'delete':
      if (confirm('Sure?')) {
        zones.list.splice(zoneindex, 1)[0].detach();
        renderZones();
        saveZones();
      }
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
      let num = parseInt(((ev.clientX - e.offsetLeft) / (e.offsetWidth)) * 128);
      if (num > 127) num = 127;
      const middle = zone.low + (zone.high - zone.low) / 2;     
      if (catchedMarker[zoneindex] === 0) {
        catchedMarker[zoneindex] = num<middle?-1:1;
      }
      if (catchedMarker[zoneindex]<0 && num > zone.high) {
        catchedMarker[zoneindex] = 1;
      }
      if (catchedMarker[zoneindex]>0 && num < zone.low) {
        catchedMarker[zoneindex] = -1;
      }
      let tempLow, tempHigh;
      if (catchedMarker[zoneindex]<0) {
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
      channelselectors += `<div class="ch ${zone.channel == i ? 'selected' : ''} no${i}" data-action="${index}:ch:${i}">${i + 1}</div>`;
    }
    const octavemarkers = '<span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span>';
    let html = `<section class="zone" id="zone${index}">
            <div class="delzone" data-action="${index}:delete" title="Remove zone">✕</div>
            <div class="channels"><div class="ch enabled" data-action="${index}:enabled" title="Mute Zone">M</div><div class="ch solo" data-action="${index}:solo" title="Solo Zone">S</div>${channelselectors}</div>
            <div class="range" data-hover="${index}:range" data-action="${index}:range">
                ${octavemarkers}
                <span class="join"></span>
                <span class="current"></span>
                <span class="marker low">C-1</span>
                <span class="marker high">G9</span>
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
                  Octaves
                  <select class="arp_octaves" data-change="${index}:arp_octaves">
                    <option>0</option>
                    <option>1</option>
                    <option>2</option>
                    <option>3</option>
                  </select>
                </div>
                <div class="check arp_repeat" data-action="${index}:arp_repeat">Repeat</div>
                <div class="drop-down">
                  Notes
                  <select class="arp_division" data-change="${index}:arp_division">
                    <option>1/1 --</option>
                    <option>1/2.</option>
                    <option>1/1t</option>
                    <option>1/2 --</option>
                    <option>1/4.</option>
                    <option>1/2t</option>
                    <option>1/4 --</option>
                    <option>1/8.</option>
                    <option>1/4t</option>
                    <option>1/8 --</option>
                    <option>1/16.</option>
                    <option>1/8t</option>
                    <option>1/16 --</option>
                    <option>1/32.</option>
                    <option>1/32 --</option>
                  </select>
                </div>
            </div>
        </section>`;
    DOM.addHTML('#zones', 'beforeend', html);
    renderMarkersForZone(index);
    updateValuesForZone(index);
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
  for (let i=0;i<zones.list.length;i++) {
    renderMarkersForZone(i);
  }
}

function renderMarkersForZone(index, tempLo, tempHigh) {
  const low = tempLo!=undefined ? tempLo : zones.list[index].low;
  const high = tempHigh!=undefined ? tempHigh : zones.list[index].high;
  let xlow = (low / 127.0);
  let xhi = (high / 127.0);
  let xclow = (zones.list[index].low / 127.0);
  let xchi = (zones.list[index].high / 127.0);
  const markerlow = DOM.element(`#zone${index} .marker.low`);
  const markerhigh = DOM.element(`#zone${index} .marker.high`);
  const join = DOM.element(`#zone${index} .join`);
  const current = DOM.element(`#zone${index} .current`);
  const width = DOM.element(`#zone${index} .range`).offsetWidth;
  const xpad = 0.75/127.0 * width;
  markerlow.style.left = `${xlow * width}px`;
  markerhigh.style.right = `${width-xhi * width-xpad}px`;
  markerlow.innerHTML = NOTENAMES[low % 12] + (parseInt(low / 12) - 1);
  markerhigh.innerHTML = NOTENAMES[high % 12] + (parseInt(high / 12) - 1);
  join.style.left = `${xlow * width}px`;
  join.style.right = `${(width-xhi*width-xpad)}px`;
  current.style.left = `${xclow * width}px`;
  current.style.right = `${(width-xchi*width-xpad)}px`;
  let ocount = 0;
  DOM.all(`#zone${index} .range .oct`, e => {
    ocount++;
    e.style.left = `${ocount * 12 / 127.0 * width}px`;
    e.innerHTML = ocount-1;
  });
  if (tempLo!=undefined) {
    DOM.addClass(markerlow, 'hover');
  } else {
    DOM.removeClass(markerlow, 'hover');
  }
  if (tempHigh!=undefined) {
    DOM.addClass(markerhigh, 'hover');
  } else {
    DOM.removeClass(markerhigh, 'hover');
  }
}

function updateKeyForZone(index, key, on) {
  const transp = zones.list[index].octave*12;
  const range = DOM.element(`#zone${index} .range`);
  const width = range.offsetWidth;
  const id = `key${index}_${key}`;
  const x = key / 127.0 * width;
  const isTransposed = (transp!=0);
  if (isTransposed) {
    const id2 = `key${index}_${(key+transp)}`;
    if (on) {
      const x2 = (key+transp) / 127.0 * width;
      DOM.addHTML(range, 'beforeend', `<span class='key' data-key="${id2}" style='left:${x2}px'></span>`);
    } else {
      DOM.all(`*[data-key="${id2}"]`).forEach(e=>e.remove());
    }  
  }
  if (on) {
    DOM.addHTML(range, 'beforeend', `<span class='key ${isTransposed?'transp':''}' data-key="${id}" style='left:${x}px'></span>`);
  } else {
    DOM.all(`*[data-key="${id}"]`).forEach(e=>e.remove());
  }
}

function updateValuesForAllZones() {
  for (let i=0;i<zones.list.length;i++) {
    updateValuesForZone(i);
  }
}

function updateValuesForZone(index) {
  live.arpActive = zones.list.some(z => { return z.enabled && z.arp_enabled });
  const zone = zones.list[index];
  DOM.removeClass(`#zone${index} *[data-action]`, 'selected');
  DOM.addClass(`#zone${index} .no${zone.channel}`, 'selected');
    if (zone.enabled && (zones.solocount===0 || zone.solo)) {
    DOM.removeClass(`#zone${index}`, 'disabled');
    const rgb = hslToRgb(zone.channel/16, .4, .3);
    DOM.element(`#zone${index}`).style.backgroundColor = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`;    
  } else {
    DOM.addClass(`#zone${index}`, 'disabled');
    DOM.element(`#zone${index}`).style.backgroundColor = '';
  }
  [
    "cc",
    "mod",
    "sustain",
    "fixedvel",
    "pitchbend",
    "enabled",
    "solo",
    "programchange",
    "arp_enabled",
    "arp_hold",
    "arp_repeat"
  ].forEach(p => {
    if (zone[p]) {
      DOM.addClass(`#zone${index} .${p}`, 'selected');
    }
  });
  ['arp_direction','arp_division','arp_octaves'].forEach( p=>{
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
  for (var i=0;i<zones.list.length;i++) {
    const zone = zones.list[i];
    zone.enabled = true;
  }
  updateValuesForAllZones();
  saveZones();
}

function allSoloOff() {
  for (var i=0;i<zones.list.length;i++) {
    const zone = zones.list[i];
    zone.solo = false;
  }
  zones.solocount = 0;
  updateValuesForAllZones();
  saveZones();
}

document.addEventListener('DOMContentLoaded', function () {
  loadZones();
  renderZones();
  const midi = new MIDI(
    (midiavailable, message) => {
      if (midiavailable) {
        console.log('MIDI available');
      } else {
        console.log(message);
      }
    }
    , midiEventHandler
  );

  function createNewZone() {
    zones.list.push(new Zone(midi));
    saveZones();
    renderZones();
    DOM.element('#tools').scrollIntoView();
  } 

  window.addEventListener('resize', renderMarkersForAllZones);
  DOM.element('#newzone').addEventListener('click', createNewZone);
  DOM.element('#allMuteOff').addEventListener('click', allMuteOff)
  DOM.element('#allSoloOff').addEventListener('click', allSoloOff);
  DOM.element('#midiInChannel').selectedIndex = zones.inChannel;
  DOM.element('#midiInChannel').addEventListener('change', (e)=>{
    zones.inChannel = e.target.selectedIndex;
    saveZones();
  });
  DOM.element('#inChannelExclusive').checked = zones.inChannelExclusive;
  DOM.element('#inChannelExclusive').addEventListener('change', (e)=>{
    zones.inChannelExclusive = e.target.checked;
    saveZones();
    console.log(zones);
  });
  DOM.element('#inputBPM').addEventListener('mousemove', (e)=>{
    DOM.element('#displayBPM').innerHTML = e.target.value;
    live.tempo = e.target.value;
    clock.setTempo(live.tempo);
  });
  DOM.element('#inputBPM').addEventListener('change', (e)=>{
    localStorage.setItem('tempo', e.target.value);
  });
  live.tempo = (0 + localStorage.getItem('tempo')) || live.tempo;
  DOM.element('#displayBPM').innerHTML = live.tempo;
  DOM.element('#inputBPM').value = live.tempo;
  ipcRenderer.send('show', true);


  // Clock
  const beatElement = DOM.element('#beat');
  clock.on('position', (pos)=>{
    for (let i=0;i<zones.list.length;i++) {
      zones.list[i].clock(pos);
    }
    setTimeout(()=>{
      if (pos%24<12) {
        DOM.addClass(beatElement, 'on');
      } else {
        DOM.removeClass(beatElement, 'on');
      }
    },0);
  });

  clock.setTempo(live.tempo);
  clock.start();
});
