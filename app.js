const NOTENAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const zonetemplate = { channel: 0, enabled: true, solo: false, programchange: false, low: 0, high: 127, octave: 0, fixedvel: false, mod: true, sustain: true, cc: true, pitchbend: true };

const zones = {
  list: [
    { channel: 0, enabled: true, solo: false, programchange: false, low: 0, high: 127, octave: 0, fixedvel: false, mod: true, sustain: true, cc: true, pitchbend: true },
    { channel: 1, enabled: true, solo: false, programchange: false, low: 0, high: 127, octave: 0, fixedvel: false, mod: true, sustain: true, cc: true, pitchbend: true },
    { channel: 3, enabled: true, solo: false, programchange: false, low: 0, high: 127, octave: 0, fixedvel: false, mod: true, sustain: true, cc: true, pitchbend: true },
    { channel: 4, enabled: true, solo: false, programchange: false, low: 0, high: 127, octave: 0, fixedvel: false, mod: true, sustain: true, cc: true, pitchbend: true }
  ],
  solocount: 0
};

function saveZones() {
  localStorage.setItem('zones', JSON.stringify(zones));
}

function loadZones() {
  const stored = localStorage.getItem('zones');
  if (stored) {
    Object.assign(zones, JSON.parse(stored));
  }
}

function dispatchEventForZones(event, midiOutDevice) {
  zones.list.forEach( (zone, index) => {
    if (zone.enabled && (zones.solocount===0 || zone.solo)) {
      const msgtype = (event.data[0] & 0xf0);
      switch (msgtype) {
        case 0x80: // note off
        case 0x90: // note on
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
              setTimeout(()=>{ updateKeyForZone(index, event.data[1], (msgtype!=0x80 && velo>0) )},0);
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
      }
    }
  });
}

const catchedMarker = [ 0, 0, 0, 0];

function actionHandler(ev) {
  const e = ev.currentTarget;
  const action = e.getAttribute('data-action');
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
      break;
    case 'ch':
      let number = parseInt(params[2]);
      zone.channel = number;
      break;
    case 'octave':
      zone.octave = parseInt(params[2]);
      break;
    case 'cc':
    case 'sustain':
    case 'mod':
    case 'fixedvel':
    case 'pitchbend':
    case 'enabled':
    case 'programchange':
      zone[params[1]] = !zone[params[1]];
      break;
    case 'solo':
      zone.solo = !zone.solo;
      if (zone.solo) {
        zones.solocount++;
      } else {
        zones.solocount --;
      }
      updateValuesForAllZones();
      break;
    case 'delete':
      if (confirm('Sure?')) {
        zones.list.splice(zoneindex, 1);
        renderZones();
        saveZones();
      }
      break;
  }
  updateValuesForZone(zoneindex);
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
        </section>`;
    DOM.addHTML('#zones', 'beforeend', html);
    renderMarkersForZone(index);
    updateValuesForZone(index);
  });
  DOM.all('*[data-action]').forEach(e => {
    e.addEventListener('click', actionHandler);
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
  if (zone.cc) {
    DOM.addClass(`#zone${index} .check.cc`, 'selected');
  }
  if (zone.mod) {
    DOM.addClass(`#zone${index} .check.mod`, 'selected');
  }
  if (zone.sustain) {
    DOM.addClass(`#zone${index} .check.sustain`, 'selected');
  }
  if (zone.fixedvel) {
    DOM.addClass(`#zone${index} .check.fixedvel`, 'selected');
  }
  if (zone.pitchbend) {
    DOM.addClass(`#zone${index} .check.pitchbend`, 'selected');
  }
  if (zone.enabled) {
    DOM.addClass(`#zone${index} .ch.enabled`, 'selected');
  }
  if (zone.solo) {
    DOM.addClass(`#zone${index} .ch.solo`, 'selected');
  }
  if (zone.programchange) {
    DOM.addClass(`#zone${index} .check.programchange`, 'selected');
  }
  DOM.all(`#zone${index} .circle`, e => {
    const parts = e.getAttribute('data-action').split(':');
    if (parts[2] == zone.octave) {
      DOM.addClass(e, 'selected');
    }
  });

}

function createNewZone() {
  zones.list.push(zonetemplate);
  saveZones();
  renderZones();
  DOM.element(`#zone${zones.list.length-1}`).scrollIntoView();
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
    , dispatchEventForZones
  );
  window.addEventListener('resize', renderMarkersForAllZones);
  DOM.element('#newzone').addEventListener('click', createNewZone);
});
