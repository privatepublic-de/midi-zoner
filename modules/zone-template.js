module.exports = {
  getHTML: function (zone, zoneindex) {
    const index = zoneindex;
    let channelselectors = '';
    for (let i = 0; i < 16; i++) {
      channelselectors += `<div class="ch mch ${
        zone.channel == i ? 'selected' : ''
      } no${i}" data-action="${index}:ch:${i}" title="Select MIDI channel ${
        i + 1
      }">${i + 1}</div>`;
    }
    const octavemarkers = '<span class="oct"></span>'.repeat(10);
    const html = `
      <section class="zone" id="zone${index}">
        <div class="delzone rtool" data-action="${index}:delete" title="Remove zone">✕</div>
        <div class="dragzone rtool" title="Drag zone">↑ ↓</div>
        <div class="randzonecolor rtool" data-action="${index}:color" title="Change color">C</div>
        <div class="channels"><div class="ch enabled" data-action="${index}:enabled" 
          title="Receive MIDI events">R</div><div class="ch solo" data-action="${index}:solo" 
          title="Solo Zone">S</div>
          <select class="outport" data-change="${index}:outport">
            <option value="*"></option>
          </select>
          ${channelselectors} 
        </div>
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
              <div class="val prgm" title="Send program change message">
                <span class="valuestep" data-action="${index}:prgdec">&lt;</span>
                <input class="programnumber" type="text" value="" size="3" 
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
            ><canvas id="canvasPattern${index}" width="128" height="16"></canvas>
            </div>
            <div class="check" title="Create euclidian patterns" data-action="${index}:showeuclid">
              <div class="euclid" title="">
                <p>Create euclidian pattern</p>
                <input id="euchits${index}" type="text" value="8" size="3" title="Steps">
                in
                <input type="text" id="euclen${index}" value="8" size="3" title="Length">
                <span class="submit" data-action="${index}:euclid">OK</span>                    
              </div>
              &lt; Create
            </div>
        </div>
      </section>`;
    return html;
  }
};