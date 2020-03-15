const DOM = require('./domutils');
const DragZone = require('./dragzone');
const Zone = require('./zone');

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

const catchedMarker = [0, 0, 0, 0];

let zones = {};
let midiController;

function triggerSave() {}

function initController({ saveZones, storage, midi }) {
  triggerSave = saveZones;
  zones = storage;
  midiController = midi;
}

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
    case 'at2mod':
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
    case 'arp_probability':
    case 'arp_gatelength':
      const percent = ev.offsetX / (e.offsetWidth * 0.95);
      zone[params[1]] = Math.max(0, Math.floor(percent * 24) / 24);
      updateValuesForZone(zoneindex);
      break;
    case 'arp_pattern':
      const index = parseInt((ev.offsetX / e.offsetWidth) * 8);
      console.log(index);
      console.log(JSON.stringify(zone.arp_pattern));
      zone.arp_pattern[index] = !zone.arp_pattern[index];
      console.log(JSON.stringify(zone.arp_pattern));
      zone.renderPattern();
      break;
    case 'changeprogram':
      {
        const v = parseInt(e.value);
        if (v > 0 && v < 129) {
          console.log('Program change', v);
          midiController.sendProgramChange(zone.channel, v - 1);
        }
      }
      break;
    case 'prgdec':
    case 'prginc':
      {
        const input = DOM.element(`#zone${zoneindex} input.programnumber`);
        let v = parseInt(input.value);
        v = Number.isInteger(v) ? v : 0;
        if (params[1] == 'prginc') {
          if (v < 128) v++;
        } else {
          if (v > 1) v--;
        }
        v = Math.min(128, Math.max(0, v));
        input.value = v;
        input.dispatchEvent(new Event('change'));
      }
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
      break;
  }
  triggerSave();
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
  const zone = zones.list[zoneindex];
  switch (params[1]) {
    case 'range':
      zone.high = 127;
      zone.low = 0;
      catchedMarker[zoneindex] = 0;
      renderMarkersForZone(zoneindex);
      break;
    case 'arp_pattern':
      for (let i = 0; i < zone.arp_pattern.length; i++) {
        zone.arp_pattern[i] = true;
      }
      zone.renderPattern();
      break;
  }
  triggerSave();
}

function renderZones() {
  DOM.empty('#zones');
  zones.list.forEach((zone, index) => {
    let channelselectors = '';
    for (let i = 0; i < 16; i++) {
      channelselectors += `<div class="ch mch ${
        zone.channel == i ? 'selected' : ''
      } no${i}" data-action="${index}:ch:${i}">${i + 1}</div>`;
    }
    const octavemarkers =
      '<span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span><span class="oct"></span>';
    const html = `<section class="zone" id="zone${index}">
            <div class="delzone" data-action="${index}:delete" title="Remove zone">✕</div>
            <div class="dragzone" title="Drag zone">≡</div>
            <div class="channels"><div class="ch enabled" data-action="${index}:enabled" 
              title="Mute zone">M</div><div class="ch solo" data-action="${index}:solo" 
              title="Solo Zone">S</div>${channelselectors}</div>
            <div class="range" data-hover="${index}:range" data-action="${index}:range">
                ${octavemarkers}
                <span class="join"></span>
                <span class="current"></span>
                <span class="marker low">C-1</span>
                <span class="marker high">G9</span>
                <canvas id="canvas${index}" width="100" height="16"></canvas>
            </div>
            <div class="settings">
                <div class="check arp_enabled" data-action="${index}:arp_enabled"
                  title="Enable arpeggiator"
                >Arp
                <span class="arpanchor"></span></div>
                <div class="val" title="Transpose octave">Oct 
                    <a class="circle" data-action="${index}:octave:-2"></a> 
                    <a class="circle" data-action="${index}:octave:-1"></a> 
                    <a class="circle selected" data-action="${index}:octave:0"></a> 
                    <a class="circle" data-action="${index}:octave:1"></a> 
                    <a class="circle" data-action="${index}:octave:2"></a> 
                </div>
                <div class="hidden">
                  <div class="check mod" data-action="${index}:mod"
                    title="Forward mod wheel messages (CC 1)"
                  >Mod</div>
                  <div class="check at2mod" data-action="${index}:at2mod"
                    title="Convert channel pressure (aftertouch) to mod (CC 1)"
                  >AT &gt; Mod</div>
                  <div class="check sustain" data-action="${index}:sustain"
                    title="Forward sustain pedal messages (CC 64)"
                  >Pedal</div>
                  <div class="check cc" data-action="${index}:cc"
                    title="Forward control change messages"
                  >CCs</div>
                  <div class="check pitchbend" data-action="${index}:pitchbend"
                    title="Forward pitch bend messages"
                  >PB</div>
                  <div class="check fixedvel" data-action="${index}:fixedvel"
                    title="Use fixed velocity 127"
                  >Fixed Vel</div>
                  <div class="check programchange" data-action="${index}:programchange"
                    title="Forward program change messages"
                  >PRGM</div>
                  <div class="val" title="Send program change message">
                    <span class="valuestep" data-action="${index}:prgdec">&lt;</span>
                    <input class="programnumber" type="text" value="" size="3" 
                      onkeyup="
                        if (event.keyCode === 13) {
                          event.preventDefault();
                          this.dispatchEvent(new Event('change'));
                        }
                      "
                      onfocus="this.select()" 
                      data-change="${index}:changeprogram">
                    <span class="valuestep" data-action="${index}:prginc">&gt;</span>
                  </div>
                </div>
            </div>
            <div class="arp-settings">
                <div class="check arp_hold" data-action="${index}:arp_hold"
                      title="Hold notes after key release"
                >Hold</div>
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
                  <select class="arp_division" data-change="${index}:arp_division">
                    <option>2/1</option>
                    <option>1/1.</option>
                    <option>1/1 Note</option>
                    <option>1/2.</option>
                    <option>1/1t</option>
                    <option>1/2 Note</option>
                    <option>1/4.</option>
                    <option>1/2t</option>
                    <option>1/4 Note</option>
                    <option>1/8.</option>
                    <option>1/4t</option>
                    <option>1/8 Note</option>
                    <option>1/16.</option>
                    <option>1/8t</option>
                    <option>1/16 Note</option>
                    <option>1/32.</option>
                    <option>1/32 Note</option>
                    <option>1/16t</option>
                  </select>
                </div>
                <div class="drop-down">
                  Octs
                  <select class="arp_octaves" data-change="${index}:arp_octaves">
                    <option>1</option>
                    <option>2</option>
                    <option>3</option>
                    <option>4</option>
                  </select>
                </div>
                <div class="check arp_repeat" data-action="${index}:arp_repeat">Repeat</div>
                Len
                <div class="percent arp_gatelength" data-action="${index}:arp_gatelength"
                      title="Note length"
                >
                  <span class="inner"></span>
                  <span class="pcnt">50</span>
                </div>
                Prob
                <div class="percent arp_probability" data-action="${index}:arp_probability"
                      title="Note probability"
                >
                  <span class="inner"></span>
                  <span class="pcnt">50</span>
                </div>
                <div class="pattern" data-action="${index}:arp_pattern"
                      title="Arpeggiator pattern"
                ><canvas id="canvasPattern${index}" width="128" height="16"></canvas></div>
            </div>
        </section>`;
    DOM.addHTML('#zones', 'beforeend', html);
    zone.canvasElement = DOM.element(`#canvas${index}`);
    zone.patternCanvas = DOM.element(`#canvasPattern${index}`);
    zone.dom.markerlow = DOM.element(`#zone${index} .marker.low`);
    zone.dom.markerhigh = DOM.element(`#zone${index} .marker.high`);
    zone.dom.join = DOM.element(`#zone${index} .join`);
    zone.dom.current = DOM.element(`#zone${index} .current`);
    renderMarkersForZone(index);
    updateValuesForZone(index);
    zone.renderPattern();
    const dragHandler = DOM.element(`#zone${index} .dragzone`);
    dragHandler.addEventListener('mousedown', ev => {
      new DragZone(index, ev, () => {
        triggerSave();
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
  DOM.all('.pattern').forEach(e => {
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
    const rgb = DOM.hslToRgb(zone.channel / 16, 0.4, 0.3);
    // DOM.element(`#zone${index}`).style.borderColor = 'transparent';
    DOM.element(
      `#zone${index}`
    ).style.background = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`;
  } else {
    DOM.addClass(`#zone${index}`, 'disabled');
    const rgb = DOM.hslToRgb(zone.channel / 16, 0.4, 0.2);
    DOM.element(
      `#zone${index}`
    ).style.background = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`;
  }
  [
    'cc',
    'mod',
    'at2mod',
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
  ['arp_gatelength', 'arp_probability'].forEach(p => {
    const pcnt = parseInt(zone[p] * 100);
    DOM.element(`#zone${index} .percent.${p} .inner`).style.width = `${pcnt}%`;
    DOM.element(`#zone${index} .percent.${p} .pcnt`).innerHTML = pcnt;
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
  triggerSave();
}

function allSoloOff() {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].solo = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

function allHoldOff() {
  for (var i = 0; i < zones.list.length; i++) {
    zones.list[i].arp_hold = false;
  }
  updateValuesForAllZones();
  triggerSave();
}

module.exports = {
  initController,
  renderZones,
  renderMarkersForAllZones,
  allMuteOff,
  allSoloOff,
  allHoldOff
};
