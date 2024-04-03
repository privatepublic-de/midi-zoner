const Zone = require('./zone');
const fs = require('fs');
const path = require('path');

const templateZone = fs.readFileSync(
  path.join(__dirname, '../res/zone.template.html'),
  'utf8'
);

const templateController = fs.readFileSync(
  path.join(__dirname, '../res/controller.template.html'),
  'utf8'
);

function stripTooltips(/** @type {string} */ s) {
  return s.replace(/title=\".+?\"/g, '');
}

const interpolateTemplate = function (templateString, templateVars) {
  const func = new Function(
    ...Object.keys(templateVars),
    'return `' + templateString + '`;'
  );
  return func(...Object.values(templateVars));
};

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
      controllers += interpolateTemplate(templateController, {
        cc: cc,
        ix: ix,
        zoneindex: zoneindex
      });
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
    return interpolateTemplate(templateZone, {
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
