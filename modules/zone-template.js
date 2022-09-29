const Zone = require('./zone');
function stripTooltips(/** @type {string} */ s) {
  return s.replace(/title=\".+?\"/g, '');
}
let cycleConditions = '<optgroup>';
let lastCycleCond = 2;
for (let cond of Zone.Sequence.CYCLE_CONDITIONS) {
  if (cond[0] != lastCycleCond) {
    cycleConditions += '</optgroup><optgroup>';
    lastCycleCond = cond[0];
  }
  cycleConditions += `<option>${cond[1]} : ${cond[0]}</option>`;
}
cycleConditions += '</optgroup>';

const noteLengthOptions = `<optgroup><option>2/1</option>
      <option>1/1.</option>
      <option>1/1 Note</option>
      </optgroup>
      <optgroup>
      <option>1/2.</option>
      <option>1/1t</option>
      <option>1/2 Note</option>
      </optgroup>
      <optgroup>
      <option>1/4.</option>
      <option>1/2t</option>
      <option>1/4 Note</option>
      </optgroup>
      <optgroup>
      <option>1/8.</option>
      <option>1/4t</option>
      <option>1/8 Note</option>
      </optgroup>
      <optgroup>
      <option>1/16.</option>
      <option>1/8t</option>
      <option>1/16 Note</option>
      </optgroup>
      <optgroup>
      <option>1/32.</option>
      <option>1/32 Note</option>
      <option>1/16t</option>
      </optgroup>
      `;

const octavemarkers = '<span class="oct"></span>'.repeat(10);

const checkboxIcons = /*html*/ `<span class="material-icons sel">check_circle</span
      ><span class="material-icons unsel">radio_button_unchecked</span> `;

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
            <input class="label" type="text" value="${
              cc.label
            }" data-change="${zoneindex}:cc_label:${ix}"/>
            <div class="cc">
              <input type="text" value="${
                cc.number_in || cc.number
              }" data-change="${zoneindex}:cc_number_in:${ix}"/>
              &rarr;
              <input type="text" value="${
                cc.number
              }" data-change="${zoneindex}:cc_number:${ix}"/>
            </div>
            <span class="value">127</span>
            <div class="tools">
              <span class="material-icons" data-action="${zoneindex}:cc_left:${ix}">arrow_back</span>
              <span class="material-icons" data-action="${zoneindex}:cc_remove:${ix}">cancel</span>
              <span class="material-icons" data-action="${zoneindex}:cc_right:${ix}">arrow_forward</span>
              <br/>
              <span data-action="${zoneindex}:cc_togglepolarity:${ix}">mode</span>
            </div>
          </div>
      `;
    });
    return controllers; //stripTooltips(controllers);
  },
  getHTML: function (/** @type {Zone} */ zone, zoneindex) {
    const index = zoneindex;
    let channelselectors = '';
    for (let i = 0; i < 16; i++) {
      const label = i + 1;
      const title = `Select MIDI channel ${i + 1}`;
      channelselectors += `<div class="ch mch ${
        zone.channel == i ? 'selected' : ''
      } no${i}" data-action="${index}:ch:${i}" title="${title}">${label}</div>`;
    }
    let sequencerGrid = '';
    for (let i = 0; i < 64; i++) {
      sequencerGrid += `<div class="step" data-action="${index}:select_step:${i}">${
        i + 1
      }</div>`;
    }

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
      <div class="showseq rtool" data-action="${index}:toggle_seq" 
        title="Show step sequencer">
        <i class="material-icons">view_comfy</i>
      </div>
      <div class="channels">
        <div
          class="ch enabled"
          data-action="${index}:enabled"
          title="Enable zone (send MIDI out)"
        >
        <span class="material-icons isenabled"> check </span>
        <span class="material-icons isdisabled"> close </span>
        </div>
        <div class="ch solo" data-action="${index}:solo" title="Solo Zone\n(Double click for this zone only)">
          S
        </div>
        <select class="outport" data-change="${index}:outport">
          <option value="*"></option>
        </select>
        <div
            class="mch sendClock"
            data-action="${index}:sendClock"
            title="Transmit clock to this device"
          >
          <span class="material-icons sel">watch_later</span
          ><span class="material-icons unsel">query_builder</span>
        </div>
        ${channelselectors}
      </div>
      <div class="ccpots">
        <div class="ccpotttools">
          <i class="material-icons" title="Send all values" data-action="${index}:send_all_cc">send</i><br/>
          <i class="material-icons" title="Add new control" data-action="${index}:add_cc_controller">add</i>
        </div>
      </div>
      <div class="seq" data-action="${index}:select_step:-1">
        <div class="seqtools">
          Sequencer:
          <div class="val">
            Steps
            <input class="seq_steps" type="number" min="1" max="64" value="16" data-change="${index}:seq_steps" /> 
          </div>
          <div class="drop-down">
            <select class="seq_division" data-change="${index}:seq_division">
              ${noteLengthOptions}
            </select>
          </div>
          <div class="action" data-action="${index}:seq_move:-1"><i class="material-icons">chevron_left</i></div>
          <div class="action" data-action="${index}:seq_move:1"><i class="material-icons">chevron_right</i></div>
          <div class="action" data-action="${index}:seq_copy"><i class="material-icons">content_copy</i></div>
          <div class="action" data-action="${index}:seq_paste"><i class="material-icons">content_paste</i></div>
          <div class="action" data-action="${index}:seq_clear_all"><i class="material-icons">clear</i></div>
        </div>
        <div class="grid">
          <div class="step-container">${sequencerGrid}</div>
          <div class="step-info" data-action="${index}:ignore">
            <p class="no-selection"><i>(select a step to edit)</i></p>
            <p class="step-notes"></p>
            <div class="step-props">
              Length <input class="seq_step_length" type="number" min="1" max="64" value="1" data-change="${index}:seq_step_length"/> 
              Condition
              <div class="drop-down">
                <select class="seq_step_condition" data-change="${index}:seq_step_condition">
                  <option>always</option>
                    <option>Prev. played</option>
                    <option>Prev. not played</option>
                    <option>1st</option>
                    <option>not 1st</option>
                  ${cycleConditions}
                </select>
              </div>
              Prob
              <div
                class="percent seq_probability"
                data-action="${index}:seq_probability"
                title="Step probability"
              >
                <span class="inner"></span>
                <span class="pcnt">50</span>
              </div>
              <p>
                <div class="action" data-action="${index}:seq_step_move:-1"><i class="material-icons">chevron_left</i></div>
                <div class="action" data-action="${index}:seq_step_move:1"><i class="material-icons">chevron_right</i></div>
                <div class="action" data-action="${index}:seq_copy_step"><i class="material-icons">content_copy</i></div>
                <div class="action" data-action="${index}:seq_paste_step"><i class="material-icons">content_paste</i></div>
                <div class="action" data-action="${index}:seq_clear_step"><i class="material-icons">clear</i></div>
              </p>
            </div>
          </div>
          <div style="clear:both"></div>
        </div>
      </div>
      <div class="rangeholder">
        <div
          class="range"
          data-hover="${index}:range"
          data-action="${index}:range"
          title="Select start and end note
  (hold 'shift' for octave note stepping)"
        >
          ${octavemarkers}
          <span class="rangeborder"></span>
          <span class="join"></span>
          <span class="current"></span>
          <span class="marker low">C-1</span>
          <span class="marker high">G9</span>
          <canvas id="canvas${index}" width="100" height="20"></canvas>
        </div>
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
          <a class="octselect" data-action="${index}:octave:-2"></a><a 
          class="octselect" data-action="${index}:octave:-1"></a><a 
          class="octselect selected" data-action="${index}:octave:0"></a><a 
          class="octselect" data-action="${index}:octave:1"></a><a 
          class="octselect" data-action="${index}:octave:2"></a>
        </div>
        <div class="hidden">
          <div
            class="check mod"
            data-action="${index}:mod"
            title="Transmit mod wheel messages (CC 1)"
          >
            ${checkboxIcons}MW
          </div>
          <div
            class="check at2mod"
            data-action="${index}:at2mod"
            title="Convert channel pressure (aftertouch) to mod (CC 1)"
          >
            ${checkboxIcons}AT&gt;MW
          </div>
          <div
            class="check sustain"
            data-action="${index}:sustain"
            title="Transmit sustain pedal messages (CC 64)"
          >
            ${checkboxIcons}Sus
            <span class="innertoggle sustain_on" data-action="${index}:sustain_on">ON</span>
          </div>
          <div
            class="check cc"
            data-action="${index}:cc"
            title="Transmit control change messages"
          >
            ${checkboxIcons}CC
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
            title="Use fixed velocity"
          >
            ${checkboxIcons}Vel
            <select id="fixedvel${index}" onclick="event.stopPropagation();" data-change="${index}:fixedvel_value">
              <option>16</option>
              <option>32</option>
              <option>64</option>
              <option>96</option>
              <option>127</option>
            </select>
          </div>
          <div
            class="check programchange"
            data-action="${index}:programchange"
            title="Transmit program change messages"
          >
            ${checkboxIcons}Prg
          </div>
          <div class="prgm" title="Send program change message">
            <input
              class="programnumber"
              type="number"
              value=""
              min="1" max="128"
              placeholder="Prg#"
              data-change="${index}:changeprogram"
            />
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
          <span
            class="arp_transpose innertoggle"
            title="Use keyboard to transpose held arpeggio"
            data-action="${index}:arp_transpose">
            t
          </span>
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
            ${noteLengthOptions}
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
          <canvas id="canvasPattern${index}" width="200" height="16"></canvas>
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
