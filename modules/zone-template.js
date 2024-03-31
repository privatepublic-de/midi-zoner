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

const noteLengthOptions = /*html*/ `<optgroup><option>2/1</option>
      <option>1/1.</option>
      <option>1/1</option>
      </optgroup>
      <optgroup>
      <option>1/2.</option>
      <option>1/1t</option>
      <option>1/2</option>
      </optgroup>
      <optgroup>
      <option>1/4.</option>
      <option>1/2t</option>
      <option>1/4</option>
      </optgroup>
      <optgroup>
      <option>1/8.</option>
      <option>1/4t</option>
      <option>1/8</option>
      </optgroup>
      <optgroup>
      <option>1/16.</option>
      <option>1/8t</option>
      <option>1/16</option>
      </optgroup>
      <optgroup>
      <option>1/32.</option>
      <option>1/32</option>
      <option>1/16t</option>
      </optgroup>
      `;

const octavemarkers = '<span class="oct"></span>'.repeat(10);

const checkboxIcons = /*html*/ `<span class="material-icons sel">check_box</span
      ><span class="material-icons unsel">check_box_outline_blank</span> `;

module.exports = {
  getControllerHTML: function (/** @type {Zone} */ zone, zoneindex) {
    let controllers = '';
    zone.cc_controllers.forEach((cc, ix) => {
      controllers += /*html*/ `
        <div class="ccpot ${
          cc.type == 2 ? 'spacer' : ''
        }" id="pot_${zoneindex}_${ix}">
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
                    stroke="var(--darker-1)"
                    stroke-width="10"
                    fill="none"
                  />
                  <path
                    id="pot_value_${zoneindex}_${ix}"
                    d=""
                    stroke="var(--brighter-4)"
                    stroke-width="6"
                    fill="none"
                  />
                  <rect
                    id="pot_zero_${zoneindex}_${ix}"
                    x="27" y="8" width="2" height="8" fill="var(--brighter-2)" />
                </svg>
                <div class="cclabel">
                  ${cc.label}
                </div>
                <span class="value">127</span>
              </div>
              <div class="ccpot-back">
                <div><input class="cclabel" type="text" value="${
                  cc.label
                }" data-change="${zoneindex}:cc_label:${ix}"/>
                </div>
                <div class="cc">
                  <input type="text" class="cc-in" 
                    value="${cc.number_in || cc.number}" 
                    data-change="${zoneindex}:cc_number_in:${ix}" 
                    data-focus-change="${zoneindex}:cc_focused:${ix}"
                    title="Enter input cc number.\nAny CC input from MIDI-In controller is learned if this control is selected!"
                   />
                  <span>&rarr;</span>
                  <input type="text" class="cc-out"
                    value="${cc.number}" 
                    data-change="${zoneindex}:cc_number:${ix}"
                    title="Output cc number"
                  />
                </div>
                <div class="cc_change_type" data-action="${zoneindex}:cc_change_type:${ix}">mode</div>
                <div class="cc_tools">
                  <span class="material-icons" title="Move left" data-action="${zoneindex}:cc_left:${ix}">arrow_back</span>
                  <span class="material-icons" title="Remove" data-action="${zoneindex}:cc_remove:${ix}">close</span>
                  <span class="material-icons" title="Add new" data-action="${zoneindex}:cc_add:${ix}">add</span>
                  <span class="material-icons" title="Move right" data-action="${zoneindex}:cc_right:${ix}">arrow_forward</span>
                </div>
              </div>
            </div>
          </div>
      `;
    });
    return controllers; //stripTooltips(controllers);
  },
  getHTML: function (/** @type {Zone} */ zone, zoneindex) {
    const index = zoneindex;
    let channelselectors = `<select class="channel" data-change="${index}:channel">`;
    for (let i = 0; i < 16; i++) {
      channelselectors += `<option value="${i}">Ch ${i + 1}</option>`;
      // const label = i + 1;
      // const title = `Select MIDI channel ${i + 1}`;
      // channelselectors += `<div class="ch mch ${
      //   zone.channel == i ? 'selected' : ''
      // } no${i}" data-action="${index}:ch:${i}" title="${title}">${label}</div>`;
    }
    channelselectors += '</select>';

    let sequencerGrid = '';
    for (let i = 0; i < Zone.Sequence.MAX_STEPS; i++) {
      sequencerGrid += `<div class="step" data-action="${index}:select_step:${i}">${
        i + 1
      }</div>`;
    }
    const zoneMuteKeyboardHint =
      index < 10 ? `('${(index + 1) % 10}' on computer keyboard)` : '';
    return /*html*/ `<section class="zone" id="zone${index}">
      <div class="channels">
        <div
          class="ch state enabled"
          data-action="${index}:enabled"
          title="Enable zone ${zoneMuteKeyboardHint}"
        >
          <span class="material-icons isenabled"> check </span>
          <span class="material-icons isdisabled"> close </span>
        </div>
        <div class="ch state solo" data-action="${index}:solo" title="Solo Zone\n(Double click for this zone only)">
          S
        </div>
        <div class="ch state showseq" data-action="${index}:toggle_seq" 
          title="Enable step sequencer">
          <i class="material-icons">view_comfy</i>
          <progress max="100" value="0" class="seqprogress"></progress>
        </div>
        <div class="ch state showccs" data-action="${index}:toggle_show_cc" title="Show CC controllers">
          CC
        </div>
        <div class="ch state showarp arp_enabled" data-action="${index}:arp_enabled" title="Enable arpeggiator">
          Arp
        </div>
        <div class="outselection">
          <select class="outport" data-change="${index}:outport" title="Select output port or preset">
            <option value="*"></option>
          </select>
          <input type="text" class="output-config-name" placeholder="(untitled)"
            onKeyUp="event.stopPropagation();"
            title="Edit output preset name"
            data-change="${index}:output_config_name"/>
        </div>
        <div
            class="sendClock"
            data-action="${index}:sendClock"
            title="Transmit clock to this device"
          ><i class="material-icons sel">watch_later</i
          ><i class="material-icons unsel">query_builder</i>
        </div>
        ${channelselectors}
        <div class="zonetools">
            <div class="randzonecolor rtool" data-action="${index}:changeColor" title="Change color">
              <label><i class="material-icons">palette</i></label>
            </div>
            <div class="dragzone rtool" title="Drag zone">
              <i class="material-icons">swap_vert</i>
            </div>
            <div class="delzone rtool" data-action="${index}:delete" title="Remove zone">
              <i class="material-icons">close</i>
            </div>
        </div>
      </div>
      <div class="ccpots">
        <div class="ccpotttools">
          <div>
            <i class="material-icons edit-cc-button" title="Edit controls"  data-action="${index}:cc_edit:1">edit</i>
            <i class="material-icons" title="Add new control" data-action="${index}:add_cc_controller">add</i>
          </div>
          <div class="action" style="margin:5px 0 0 0" data-action="${index}:send_all_cc">send all</div>
        </div>
      </div>
      <div class="seq" data-action="${index}:select_step:-1">
        <div class="grid">
          <div class="step-container">${sequencerGrid}</div>
          <div class="step-info" data-action="${index}:ignore">
            <div class="step-notes"></div>
            <div class="step-props step-controls">
              <div class="label">Length</div>
              <input class="seq_step_length" type="number" min="1" max="${Sequence.MAX_STEPS}" value="1" data-change="${index}:seq_step_length"/> 
              <input class="percent seq_gatelength" type="range" data-change="${index}:seq_gatelength" title="Step gate length" />
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
              <input class="percent seq_step_probability" type="range" data-change="${index}:seq_step_probability" title="Step probability" />
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
                <div class="drop-down" title="Apply step properties to all active steps in sequence">
                  <select class="" data-change="${index}:seq_step_apply_to_all">
                    <option>Apply to all…</option>
                    <option>» Step Length</option>
                    <option>» Gate Length</option>
                    <option>» Condition</option>
                    <option>» Probability</option>
                  </select>
                </div>
              </div>
              <div class="step-info-close" data-action="${index}:select_step:-1"><i class="material-icons">close</i></div>
            </div>
        </div>
        <div class="seqtools">
          <div class="label">Steps</div>
          <div class="val">
            <input title="Number of steps in sequence" class="seq_steps" type="number" min="1" max="${Sequence.MAX_STEPS}" value="16" data-change="${index}:seq_steps" /> 
          </div>
          <div class="action" title="Double length" data-action="${index}:seq_double"><i class="material-icons">content_copy</i></div>
          <div class="drop-down" title="Step resolution">
            <select class="seq_division" data-change="${index}:seq_division">
              ${noteLengthOptions}
            </select>
          </div>
          <div class="action" title="Move whole sequence 1 step left" data-action="${index}:seq_move:-1"><i class="material-icons">chevron_left</i></div>
          <div class="action" title="Move whole sequence 1 step right" data-action="${index}:seq_move:1"><i class="material-icons">chevron_right</i></div>
          <div class="drop-down" title="Transpose whole sequence">
            <select class="seq_division" data-change="${index}:seq_transpose">
              <option>Transp.</option>
              <optgroup>
              <option value="-12">oct down</option>
              <option value="12">oct up</option>
              </optgroup><optgroup>
              <option value="-11">-11</option>
              <option value="-10">-10</option>
              <option value="-9">-9</option>
              <option value="-8">-8</option>
              <option value="-7">-7</option>
              <option value="-6">-6</option>
              <option value="-5">-5</option>
              <option value="-4">-4</option>
              <option value="-3">-3</option>
              <option value="-2">-2</option>
              <option value="-1">-1</option>
              </optgroup><optgroup>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
              <option value="6">6</option>
              <option value="7">7</option>
              <option value="8">8</option>
              <option value="9">9</option>
              <option value="10">10</option>
              <option value="11">11</option>
              </optgroup>
            </select>
          </div>
          <div class="action" title="Copy sequence" data-action="${index}:seq_copy"><i class="material-icons">content_copy</i></div>
          <div class="action" title="Paste sequence" data-action="${index}:seq_paste"><i class="material-icons">content_paste</i></div>
          <div class="action" title="Clear complete sequence" data-action="${index}:seq_clear_all"><i class="material-icons">clear</i></div>
          <div class="action seq_record_live" title="Live recording while sequence is playing" data-action="${index}:seq_record_live"><i class="material-icons">piano</i></div>
        </div>
      </div>
      <div class="arp-settings">
        <div
          class="check arp_hold"
          data-action="${index}:arp_hold"
          title="Hold notes after key release"
        >
        ${checkboxIcons}Hold
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
        <div class="label">Octaves</div>
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
        <input type="range" class="percent arp_gatelength" data-change="${index}:arp_gatelength" min="0" max="100" />
        <div class="label">Prob</div>
        <input type="range" class="percent arp_probability" data-change="${index}:arp_probability" min="0" max="100" />
        <div class="label">Pattern</div>
        <div
          class="pattern"
          data-action="${index}:arp_pattern"
          title="Arpeggiator pattern"
        >
          <canvas id="canvasPattern${index}" width="100" height="16"></canvas>
        </div>
        <div
          class="patgen action"
          title="Create or shift pattern"
          data-action="${index}:showeuclid"
        >
          <i class="material-icons">edit</i>
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
          <canvas id="canvas${index}" width="100%" height="20"></canvas>
        </div>
      </div>
      <div class="settings">
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
    </section>`;
  }
};
