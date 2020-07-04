const Zone = require('./zone');
module.exports = {
  getControllerHTML: function (/** @type {Zone} */ zone, zoneindex) {
    let controllers = '';
    zone.cc_controllers.forEach((cc, ix) => {
      controllers += /*html*/ `
        <div class="ccpot" id="pot_${zoneindex}_${ix}">
            <svg
              width="100%"
              height="100%"
              viewBox="0 0 56 56"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                id="pot_range_${zoneindex}_${ix}"
                d=""
                stroke="var(--brighter-1)"
                stroke-width="8"
                fill="none"
              />
              <rect
                id="pot_zero_${zoneindex}_${ix}"
                x="26" y="13" width="4" height="10" fill="var(--bg-color)" />
              <path
                id="pot_value_${zoneindex}_${ix}"
                d=""
                stroke="var(--brighter-4)"
                stroke-width="9"
                fill="none"
              />
            </svg>
            <input class="label" type="text" value="${cc.label}" data-change="${zoneindex}:cc_label:${ix}"/>
            <input class="cc" type="text" value="${cc.number}" data-change="${zoneindex}:cc_number:${ix}"/>
            <span class="value">127</span>
            <div class="tools">
              <span class="material-icons" data-action="${zoneindex}:cc_left:${ix}">arrow_back</span>
              <span class="material-icons" data-action="${zoneindex}:cc_remove:${ix}">cancel</span>
              <span class="material-icons" data-action="${zoneindex}:cc_right:${ix}">arrow_forward</span>
              <br/>
              <span data-action="${zoneindex}:cc_togglepolarity:${ix}">bi/uni-pol</span>
            </div>
          </div>
      `;
    });
    return controllers;
  },
  getHTML: function (/** @type {Zone} */ zone, zoneindex) {
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
    const checkboxIcons = /*html*/ `<span class="material-icons sel">check_circle</span
      ><span class="material-icons unsel">radio_button_unchecked</span> `;

    return /*html*/ `<section class="zone" id="zone${index}">
      <div
        class="delzone rtool"
        data-action="${index}:delete"
        title="Remove zone"
      >
        <i class="material-icons">cancel</i>
      </div>
      <div class="dragzone rtool" title="Drag zone">
        <i class="material-icons">import_export</i>
      </div>
      <div class="randzonecolor rtool" title="Change color">
        <label
          ><input data-change="${index}:color" type="color" /><i
            class="material-icons"
            >palette</i
          ></label
        >
      </div>
      <div class="showccs rtool" data-action="${index}:toggle_show_cc" 
        title="Show CC controllers">
        <i class="material-icons">tune</i>
      </div>
      <div class="channels">
        <div
          class="ch enabled"
          data-action="${index}:enabled"
          title="Receive MIDI events"
        >
          R
        </div>
        <div class="ch solo" data-action="${index}:solo" title="Solo Zone">
          S
        </div>
        <select class="outport" data-change="${index}:outport">
          <option value="*"></option>
        </select>
        ${channelselectors}
      </div>
      <div class="ccpots">
        <div class="ccpotttools">
          <label>Program</label>
          <div class="prgm" title="Send program change message">
            <input
              class="programnumber"
              type="text"
              value=""
              data-change="${index}:changeprogram"
            />
            <span class="valuestep" data-action="${index}:prgdec">&lt;</span>
            <span class="valuestep" data-action="${index}:prginc">&gt;</span>
          </div>
          <i class="material-icons" title="Add new control" data-action="${index}:add_cc_controller">add</i>
          <i class="material-icons" title="Send all values" data-action="${index}:send_all_cc">send</i>
        </div>
      </div>
      <div
        class="range"
        data-hover="${index}:range"
        data-action="${index}:range"
        title="Select start and end note
(hold 'shift' for octave locking)"
      >
        ${octavemarkers}
        <span class="join"></span>
        <span class="current"></span>
        <span class="marker low">C-1</span>
        <span class="marker high">G9</span>
        <canvas id="canvas${index}" width="100" height="16"></canvas>
      </div>
      <div class="settings">
        <div
          class="check arp_enabled"
          data-action="${index}:arp_enabled"
          title="Enable arpeggiator"
        >
          Arp <span class="material-icons sel">expand_more</span
          ><span class="material-icons unsel">chevron_right</span>
          <span class="arpanchor"></span>
        </div>
        <div class="val" title="Transpose octave">
          Oct
          <a class="circle" data-action="${index}:octave:-2"></a>
          <a class="circle" data-action="${index}:octave:-1"></a>
          <a class="circle selected" data-action="${index}:octave:0"></a>
          <a class="circle" data-action="${index}:octave:1"></a>
          <a class="circle" data-action="${index}:octave:2"></a>
        </div>
        <div class="hidden">
          <div
            class="check mod"
            data-action="${index}:mod"
            title="Transmit mod wheel messages (CC 1)"
          >
            ${checkboxIcons}Mod
          </div>
          <div
            class="check at2mod"
            data-action="${index}:at2mod"
            title="Convert channel pressure (aftertouch) to mod (CC 1)"
          >
            ${checkboxIcons}AT&gt;Mod
          </div>
          <div
            class="check sustain"
            data-action="${index}:sustain"
            title="Transmit sustain pedal messages (CC 64)"
          >
            ${checkboxIcons}Pedal
          </div>
          <div
            class="check cc"
            data-action="${index}:cc"
            title="Transmit control change messages"
          >
            ${checkboxIcons}CCs
          </div>
          <div
            class="check pitchbend"
            data-action="${index}:pitchbend"
            title="Transmit pitch bend messages"
          >
            ${checkboxIcons}PB
          </div>
          <div
            class="check fixedvel"
            data-action="${index}:fixedvel"
            title="Use fixed velocity 127"
          >
            ${checkboxIcons}Fix Vel
          </div>
          <div
            class="check programchange"
            data-action="${index}:programchange"
            title="Transmit program change messages"
          >
            ${checkboxIcons}PRGM
          </div>
        </div>
      </div>
      <div class="arp-settings">
        <div
          class="check arp_hold"
          data-action="${index}:arp_hold"
          title="Hold notes after key release"
        >
          Hold
        </div>
        <div class="drop-down">
          <select class="arp_direction" data-change="${index}:arp_direction">
            <option>UP</option>
            <option>DOWN</option>
            <option>UP / DOWN</option>
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
        <div class="check arp_repeat" data-action="${index}:arp_repeat">
          ${checkboxIcons}Repeat
        </div>
        Len
        <div
          class="percent arp_gatelength"
          data-action="${index}:arp_gatelength"
          title="Note length"
        >
          <span class="inner"></span>
          <span class="pcnt">50</span>
        </div>
        Prob
        <div
          class="percent arp_probability"
          data-action="${index}:arp_probability"
          title="Note probability"
        >
          <span class="inner"></span>
          <span class="pcnt">50</span>
        </div>
        <div
          class="pattern"
          data-action="${index}:arp_pattern"
          title="Arpeggiator pattern"
        >
          <canvas id="canvasPattern${index}" width="128" height="16"></canvas>
        </div>
        <div
          class="check patgen"
          title="Create or shift pattern"
          data-action="${index}:showeuclid"
        >
          <div class="euclid" title="">
            <p>Create euclidian pattern</p>
            <p>
              <input
                id="euchits${index}"
                type="text"
                value="8"
                size="3"
                title="Steps"
              />
              in
              <input
                type="text"
                id="euclen${index}"
                value="8"
                size="3"
                title="Length"
              />
              <span class="submit" data-action="${index}:euclid">OK</span>
            </p>
            <p>
              <span class="submit" data-action="${index}:pattern-shift-left"
                >&lt;</span
              >
              Shift pattern
              <span class="submit" data-action="${index}:pattern-shift-right"
                >&gt;</span
              >
            </p>
          </div>
          <i class="material-icons">settings</i>
        </div>
      </div>
    </section>`;
  }
};
