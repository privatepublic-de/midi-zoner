const Zone = require('./zone');
const fs = require('fs');
const path = require('path');

const templateZone = fs.readFileSync(
  path.join(__dirname, '../res/template-zone.html'),
  'utf8'
);

const templateController = fs.readFileSync(
  path.join(__dirname, '../res/template-controller.html'),
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

const cycleConditions = (function () {
  let s = '<optgroup>';
  let lastCycleCond = 2;
  for (let cond of Zone.Sequence.CYCLE_CONDITIONS) {
    if (cond[0] != lastCycleCond) {
      s += '</optgroup><optgroup>';
      lastCycleCond = cond[0];
    }
    s += `<option>${cond[1]} : ${cond[0]}</option>`;
  }
  s += '</optgroup>';
  return s;
})();

const noteLengthOptions = (function () {
  let s = '';
  [
    ['2/1', '1/1•', '1/1'],
    ['1/2•', '1/1t', '1/2'],
    ['1/4•', '1/2t', '1/4'],
    ['1/8•', '1/4t', '1/8'],
    ['1/16•', '1/8t', '1/16'],
    ['1/32•', '1/32', '1/16t']
  ].forEach((group) => {
    s += '<optgroup>';
    group.forEach((opt) => (s += '<option>' + opt + '</option>'));
    s += '</optgroup>';
  });
  return s;
})();

const octavemarkers = '<span class="oct"></span>'.repeat(10);

const checkboxIcons =
  '<span class="material-icons sel">check_box</span><span class="material-icons unsel">check_box_outline_blank</span>';

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
      zoneNumber: index + 1,
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
