const Zone = require('./zone');
const fs = require('fs');
const path = require('path');

const template = fs.readFileSync(
  path.join(__dirname, '../res/zone.template.html'),
  'utf8'
);

function stripTooltips(/** @type {string} */ s) {
  return s.replace(/title=\".+?\"/g, '');
}
function interpolateTemplate(template, args) {
  return Object.entries(args).reduce(
    (result, [arg, val]) => result.replaceAll(`$\{${arg}}`, `${val}`),
    template
  );
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
      <option>1/1•</option>
      <option>1/1</option>
      </optgroup>
      <optgroup>
      <option>1/2•</option>
      <option>1/1t</option>
      <option>1/2</option>
      </optgroup>
      <optgroup>
      <option>1/4•</option>
      <option>1/2t</option>
      <option>1/4</option>
      </optgroup>
      <optgroup>
      <option>1/8•</option>
      <option>1/4t</option>
      <option>1/8</option>
      </optgroup>
      <optgroup>
      <option>1/16•</option>
      <option>1/8t</option>
      <option>1/16</option>
      </optgroup>
      <optgroup>
      <option>1/32•</option>
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
    let channelselector = `<select class="channel" data-change="${index}:channel">`;
    for (let i = 0; i < 16; i++) {
      channelselector += `<option value="${i}">Ch ${i + 1}</option>`;
    }
    channelselector += '</select>';

    let sequencerGrid = '';
    for (let i = 0; i < Zone.Sequence.MAX_STEPS; i++) {
      sequencerGrid += `<div class="step" data-action="${index}:select_step:${i}">${
        i + 1
      }</div>`;
    }
    const zoneMuteKeyboardHint =
      index < 10 ? `('${(index + 1) % 10}' on computer keyboard)` : '';
    return interpolateTemplate(template, {
      index: index,
      zoneMuteKeyboardHint: zoneMuteKeyboardHint,
      channelselector: channelselector,
      sequencerGrid: sequencerGrid,
      seqMaxSteps: Sequence.MAX_STEPS,
      cycleConditions: cycleConditions,
      checkboxIcons: checkboxIcons,
      noteLengthOptions: noteLengthOptions,
      octavemarkers: octavemarkers
    });
  }
};
