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
            <div class="ccpot-inner">
              <div class="ccpot-front">
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
                  <path
                    id="pot_value_${zoneindex}_${ix}"
                    d=""
                    stroke="var(--brighter-4)"
                    stroke-width="9"
                    fill="none"
                  />
                  <rect
                    id="pot_zero_${zoneindex}_${ix}"
                    x="28" y="7" width="1" height="10" fill="#000000" />
                </svg>
                <input class="cclabel" type="text" value="${
                  cc.label
                }" data-change="${zoneindex}:cc_label:${ix}"/>
                <div class="cc-edit-action" data-action="${zoneindex}:cc_edit:${ix}" onMouseDown="event.stopPropagation()">
                  edit
                </div>
                <span class="value">127</span>
              </div>
              <div class="ccpot-back">
                <div>CC Number</div>
                <div class="cc" title="Enter input and output cc number\nAny CC input from MIDI-In controller is learned now!">
                  <input type="text" class="cc-in" value="${
                    cc.number_in || cc.number
                  }" data-change="${zoneindex}:cc_number_in:${ix}"/>
                  <span>&rarr;</span>
                  <input type="text" class="cc-out" value="${
                    cc.number
                  }" data-change="${zoneindex}:cc_number:${ix}"/>
                </div>
                <div class="cc_togglepolarity" data-action="${zoneindex}:cc_togglepolarity:${ix}">mode</div>
                <div class="cc_tools">
                  <span class="material-icons" data-action="${zoneindex}:cc_left:${ix}">arrow_back</span>
                  <span class="material-icons" data-action="${zoneindex}:cc_edit:-1">360</span>
                  <span class="material-icons" data-action="${zoneindex}:cc_right:${ix}">arrow_forward</span>
                </div>
                <div data-action="${zoneindex}:cc_remove:${ix}">remove</div>
              </div>
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
    for (let i = 0; i < Zone.Sequence.MAX_STEPS; i++) {
      sequencerGrid += `<div class="step" data-action="${index}:select_step:${i}">${
        i + 1
      }</div>`;
    }
    const zoneSoloKeyboardHint =
      index < 10 ? `or press '${(index + 1) % 10}' on computer keyboard` : '';
    return /*html*/ `<section class="zone" id="zone${index}">
      <div class="channels">
        <div
          class="ch state enabled"
          data-action="${index}:enabled"
          title="Enable zone (send MIDI out)"
        >
        <span class="material-icons isenabled"> check </span>
        <span class="material-icons isdisabled"> close </span>
        </div>
        <div class="ch state solo" data-action="${index}:solo" title="Solo Zone\n(Double click ${zoneSoloKeyboardHint} for this zone only)">
          S
        </div>
        <div class="ch state showccs" data-action="${index}:toggle_show_cc" title="Show CC controllers">
              <i class="material-icons">tune</i>
            </div>
        <div class="ch state showseq" data-action="${index}:toggle_seq" 
          title="Enable step sequencer">
          <i class="material-icons">view_comfy</i>
        </div>
        <input type="text" class="output-config-name" placeholder="(untitled)"
          onKeyUp="event.stopPropagation();"
          data-change="${index}:output_config_name"/>
        <select class="outport" data-change="${index}:outport">
          <option value="*"></option>
        </select>
        <div
            class="mch sendClock"
            data-action="${index}:sendClock"
            title="Transmit clock to this device"
          ><i class="material-icons sel">watch_later</i
          ><i class="material-icons unsel">query_builder</i>
        </div>
        ${channelselectors}
        <div class="zonetools">
            <div class="randzonecolor rtool" title="Change color">
              <label><input data-change="${index}:color" type="color" /><i class="material-icons">palette</i></label>
            </div>
            <div class="dragzone rtool" title="Drag zone">
              <i class="material-icons">import_export</i>
            </div>
            <div class="delzone rtool" data-action="${index}:delete" title="Remove zone">
              <i class="material-icons">close</i>
            </div>
        </div>
      </div>
      <div class="ccpots">
        <div class="ccpotttools">
          <i class="material-icons" title="Add new control" data-action="${index}:add_cc_controller">add</i>
          <div class="action" style="margin:5px 0 0 0" data-action="${index}:send_all_cc">send all</div>
        </div>
      </div>
      <div class="seq" data-action="${index}:select_step:-1">
        <div class="seqtools">
          <div class="label">Sequencer:</div>
          <div class="label">Steps</div>
          <div class="val">
            <input title="Number of steps in sequence" class="seq_steps" type="number" min="1" max="${Sequence.MAX_STEPS}" value="16" data-change="${index}:seq_steps" /> 
          </div>
          <div class="drop-down" title="Step resolution">
            <select class="seq_division" data-change="${index}:seq_division">
              ${noteLengthOptions}
            </select>
          </div>
          <div class="action" title="Move whole sequence 1 step left" data-action="${index}:seq_move:-1"><i class="material-icons">chevron_left</i></div>
          <div class="action" title="Move whole sequence 1 step right" data-action="${index}:seq_move:1"><i class="material-icons">chevron_right</i></div>
          <div class="action" title="Copy sequence" data-action="${index}:seq_copy"><i class="material-icons">content_copy</i></div>
          <div class="action" title="Paste sequence" data-action="${index}:seq_paste"><i class="material-icons">content_paste</i></div>
          <div class="action" title="Clear complete sequence" data-action="${index}:seq_clear_all"><i class="material-icons">clear</i></div>
          <div class="action seq_record_live" title="Live recording while sequence is playing" data-action="${index}:seq_record_live"><i class="material-icons">piano</i></div>
        </div>
        <div class="grid">
          <div class="step-container">${sequencerGrid}</div>
          <div class="step-info" data-action="${index}:ignore">
            <div class="step-notes"></div>
            <div class="step-props step-controls">
              <div class="label">Length</div>
              <input class="seq_step_length" type="number" min="1" max="${Sequence.MAX_STEPS}" value="1" data-change="${index}:seq_step_length"/> 
              <div
                class="percent seq_gatelength"
                data-action="${index}:seq_gatelength"
                title="Gate length"
              >
                <span class="inner"></span>
                <span class="pcnt">50</span>
              </div>
              <div class="label">Condition</div>
              <div class="drop-down" title="Select step play condition">
                <select class="seq_step_condition" data-change="${index}:seq_step_condition">
                  <option>always</option>
                    <option title="Previous was played">Prev.</option>
                    <option title="Previous was not played">Not prev.</option>
                    <option title="Only in first cycle">1st</option>
                    <option title="Not in first cycle">Not 1st</option>
                  ${cycleConditions}
                </select>
              </div>
              <div class="label">Prob</div>
              <div
                class="percent seq_step_probability"
                data-action="${index}:seq_step_probability"
                title="Step probability"
              >
                <span class="inner"></span>
                <span class="pcnt">50</span>
              </div>
              <div class="action" title="Apply probability to all steps" data-action="${index}:seq_step_probability_all"><i class="material-icons">keyboard_double_arrow_right</i></div>
            </div>
            <div class="step-controls">
                <div class="action" title="Move step left (if free space)" data-action="${index}:seq_step_move:-1"><i class="material-icons">chevron_left</i></div>
                <div class="action" title="Move step right (if free space)" data-action="${index}:seq_step_move:1"><i class="material-icons">chevron_right</i></div>
                <div class="action" title="Copy step" data-action="${index}:seq_copy_step"><i class="material-icons">content_copy</i></div>
                <div class="action" title="Paste step" data-action="${index}:seq_paste_step"><i class="material-icons">content_paste</i></div>
                <div class="action" title="Clear step" data-action="${index}:seq_clear_step"><i class="material-icons">clear</i></div>
                <div
                  class="check seq-step-add-notes"
                  data-action="${index}:seq_step_add_notes"
                  title="New notes are added (not overwritten)"
                >
                  ${checkboxIcons}Add notes
                </div>
                <div
                  class="check seq-step-advance"
                  data-action="${index}:seq_step_advance"
                  title="Advance step after note input"
                >
                  ${checkboxIcons}Advance
                </div>
              </div>
              <div class="step-info-close" data-action="${index}:select_step:-1"><i class="material-icons">close</i></div>
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
        <div class="val label">Oct</div>
        <div class="val octaves" title="Transpose octave">
          <a class="octselect" data-action="${index}:octave:-3"></a>
          <a class="octselect" data-action="${index}:octave:-2"></a>
          <a class="octselect" data-action="${index}:octave:-1"></a>
          <a class="octselect octcenter selected" data-action="${index}:octave:0"></a>
          <a class="octselect" data-action="${index}:octave:1"></a>
          <a class="octselect" data-action="${index}:octave:2"></a>
          <a class="octselect" data-action="${index}:octave:3"></a>
        </div>
        <div class="hidden">
          <div
            class="check pitchbend"
            data-action="${index}:pitchbend"
            title="Transmit pitch bend messages"
          >
            ${checkboxIcons}PB
          </div>
          <div
            class="check mod"
            data-action="${index}:mod"
            title="Transmit mod wheel messages (CC 1)"
          >
            ${checkboxIcons}MW
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
            class="check fixedvel"
            data-action="${index}:fixedvel"
            title="Use fixed velocity"
          >
            ${checkboxIcons}FVel
            <input type="number" id="fixedvel${index}" onclick="event.stopPropagation();" data-change="${index}:fixedvel_value" value="127" min="1" max="127"/>
          </div>
          <div class="check scale_velocity"
            data-action="${index}:scale_velocity"
            title="Scale velocity %"
          >
            ${checkboxIcons}Vel%
            <input type="number" id="scalevel${index}" onclick="event.stopPropagation();" data-change="${index}:scale_velocity_value" value="100" min="1" max="200"/>
          </div>
          <div
            class="check cc"
            data-action="${index}:cc"
            title="Transmit control change messages"
          >
            ${checkboxIcons}CC
          </div>
          <div
            class="check at2mod"
            data-action="${index}:at2mod"
            title="Convert channel pressure (aftertouch) to mod (CC 1)"
          >
            ${checkboxIcons}AT&gt;MW
          </div>
          <div
            class="check programchange"
            data-action="${index}:programchange"
            title="Transmit program change messages"
          >
            ${checkboxIcons}Prg
            <input
              title="Send a program change message"
              class="programnumber"
              type="number"
              value=""
              min="1" max="128"
              data-change="${index}:changeprogram"
              onclick="event.stopPropagation();"
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
          <select class="arp_direction" data-change="${index}:arp_direction" title="Arp play direction">
            <option>Up</option>
            <option>Down</option>
            <option>Up / Down</option>
            <option>Random</option>
            <option>Order</option>
          </select>
        </div>
        <div class="drop-down">
          <select class="arp_division" data-change="${index}:arp_division">
            ${noteLengthOptions}
          </select>
        </div>
        <div class="label">Octs</div>
        <div class="drop-down">
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
        <div class="label">Len</div>
        <div
          class="percent arp_gatelength"
          data-action="${index}:arp_gatelength"
          title="Note length"
        >
          <span class="inner"></span>
          <span class="pcnt">50</span>
        </div>
        <div class="label">Prob</div>
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
          class="action patgen"
          title="Create or shift pattern"
          data-action="${index}:showeuclid"
        >
          <i class="material-icons">settings</i>
        </div>
        <div class="euclid hideonleave">
          <p>Create euclidian pattern</p>
          <p>
            <input
              id="euchits${index}"
              type="number"
              min="1"
              value="8"
              size="3"
              title="Steps"
            />
            in
            <input
              type="number"
              id="euclen${index}"
              min="1"
              value="8"
              size="3"
              title="Length"
            />
            <span class="submit" data-action="${index}:euclid">OK</span>
          </p>
          <p>
            <span class="submit" data-action="${index}:pattern_shift:-1"
              >&lt;</span
            >
            Shift pattern
            <span class="submit" data-action="${index}:pattern_shift:1"
              >&gt;</span
            >
          </p>
        </div>
      </div>
    </section>`;
  }
};
