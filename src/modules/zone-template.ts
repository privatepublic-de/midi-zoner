import { Zone } from './zone/zone-class';
import { Sequence } from './zone/sequence';

import fs from 'fs';
import { escapeHTML } from './domutils';
import path from 'path';
import { pageBlocks, sectionBlocks } from './zone/cc-layout';

// Type alias for the Zone class type
type ZoneType = Zone;

const templateZone = fs.readFileSync(
  path.join(__dirname, '../../res/template-zone.html'),
  'utf8'
);

const templateController = fs.readFileSync(
  path.join(__dirname, '../../res/template-controller.html'),
  'utf8'
);

const interpolateTemplate = function (
  templateString: string,
  templateVars: Record<string, any>
): string {
  const func = new Function(
    ...Object.keys(templateVars),
    'return `' + templateString + '`;'
  );
  return func(...Object.values(templateVars));
};

const cycleConditions = (function (): string {
  let s = '<hr/>';
  let lastCycleCond = 2;
  for (const cond of Sequence.CYCLE_CONDITIONS) {
    if (cond[0] != lastCycleCond) {
      s += '<hr/>';
      lastCycleCond = cond[0];
    }
    s += `<option>${cond[1]} : ${cond[0]}</option>`;
  }
  return s;
})();

const noteLengthOptions = (function (): string {
  let s = '';
  [
    ['2/1', '1/1•', '1/1'],
    ['1/2•', '1/1t', '1/2'],
    ['1/4•', '1/2t', '1/4'],
    ['1/8•', '1/4t', '1/8'],
    ['1/16•', '1/8t', '1/16'],
    ['1/16t', '1/32', '1/32t']
  ].forEach((group) => {
    s += '<hr/>';
    group.forEach((opt) => (s += '<option>' + opt + '</option>'));
  });
  return s;
})();

const checkboxIcons =
  '<span class="material-icons sel">check_box</span><span class="material-icons unsel">check_box_outline_blank</span>';

export function getControllerHTML(zone: ZoneType, zoneindex: number): string {
  const pot = (ix: number): string =>
    interpolateTemplate(templateController, {
      cc: zone.cc_controllers[ix],
      ix: ix,
      zoneindex: zoneindex,
      esc: escapeHTML
    });
  // Only the page shown; one block per section, a section starts a new row unless new_row is false
  const pages = pageBlocks(zone.cc_controllers);
  const page = pages[Math.min(zone.ccPage, pages.length - 1)];
  const blocks = sectionBlocks(zone.cc_controllers, page.start, page.end);
  const continuesRow = (n: number): boolean =>
    n > 0 && n < blocks.length && zone.cc_controllers[blocks[n].section]?.new_row === false;
  return blocks
    .map((block, n) => {
      const section = block.section >= 0 ? zone.cc_controllers[block.section] : null;
      const inline = continuesRow(n);
      // The last section on a row takes the rest of it, so its ruler runs to the edge
      const last = !continuesRow(n + 1);
      const head = section?.label.trim() ? `<div class="ccsection-head">${escapeHTML(section.label)}</div>` : '';
      return (
        (n > 0 && !inline ? '<div class="ccsection-break"></div>' : '') +
        `<div class="ccsection${inline ? ' inline' : ''}${last ? ' last' : ''}" data-group="${section?.group || 0}">` +
        `${head}<div class="ccsection-pots">${block.items.map(pot).join('')}</div></div>`
      );
    })
    .join('');
}

export function getHTML(zone: ZoneType, zoneindex: number): string {
  const index = zoneindex;
  let channelOptions = '';
  for (let i = 0; i < 16; i++) {
    channelOptions += `<option value="${i}">Ch ${i + 1}</option>`;
  }

  let sequencerGrid = '';
  for (let i = 0; i < Sequence.MAX_STEPS; i++) {
    sequencerGrid += `<div class="step" data-dragselect="${i}" data-contextmenu="${index}:seq_copy_step:${i},${index}:seq_paste_step:${i},-,${index}:seq_clear_step:${i},${index}:seq_clear_locks:${i},${index}:seq_clear_all">${
      `<span class="beat-num">${i + 1}</span>`
    }<span class="material-icons chance-mark">casino</span><span class="lock-dot"></span></div>`;
  }

  let drumLanes = '';
  for (let ln = 0; ln < Sequence.MAX_LANES_DRUMS; ln++) {
    drumLanes += `
      <div class="drum-lane lane${ln}" data-contextmenu="${index}:seq_copy_lane:${ln},${index}:seq_paste_lane:${ln},-,${index}:seq_clear_lane:${ln}">
        <div class="lane-header">
          <div class="action ch enabled seq_toggle_lane_enabled" data-action="${index}:seq_toggle_lane_enabled:${ln}" title="Mute this lane">M</div>
          <div class="action ch solo seq_toggle_lane_solo" data-action="${index}:seq_toggle_lane_solo:${ln}" title="Solo this lane">S</div>
          <input class="lane-label" type="text" maxlength="5" placeholder="${ln + 1}" title="Name this lane" data-change="${index}:seq_drum_lane_label:${ln}" tabindex="-1"/>
          <div class="lane-controls-ext">
            <div class="lane-ctrl-label">Note</div>
            <div class="val"><input type="number" min="0" max="127" title="The note this lane plays (0–127)" value="${36 + ln}" data-change="${index}:seq_drumlane_note:${ln}"/></div>
            <div class="lane-ctrl-label">Len</div>
            <div class="val lane-len-wrap"><input type="number" class="lane-steps" min="1" max="${Sequence.MAX_STEPS_DRUMS}" value="16" title="Steps in this lane" data-change="${index}:seq_drum_lane_steps:${ln}" tabindex="-1"/></div>
            <div class="lane-toolbar">
              <span class="action lane-shift-left" data-action="${index}:seq_drumlane_move:${ln}:-1" title="Shift the lane to the left">‹</span>
              <span class="action lane-shift-right" data-action="${index}:seq_drumlane_move:${ln}:1" title="Shift the lane to the right">›</span>
              <span class="action lane-euc-btn" data-action="${index}:seq_toggle_lane_euclid:${ln}" title="Euclidean: spread its hits evenly over the lane">E</span>
              <div class="euc-panel hideonleave">
                <input class="euc-hits" type="range" min="1" max="32" value="4" data-change="${index}:seq_euclid_lane:${ln}"/>
                <span class="euc-val">4</span>
              </div>
            </div>
          </div>
        </div>
        <div class="lane-expand-toggle" data-action="${index}:seq_toggle_lanes_expand" title="Show or hide the lanes' settings">${
          ln === 0
            ? '<span class="lane-expand-chevron"><i class="material-icons">chevron_right</i></span>'
            : ''
        }</div>`;

    for (let i = 0; i < Sequence.MAX_STEPS_DRUMS; i++) {
      const stepId = Sequence.getIdForDrumStep(ln, i);
      drumLanes += `<div class="step" data-action="${index}:seq_drumstep_select:${stepId}" data-dblclickaction="${index}:seq_clear_step:${stepId}" data-dragselect="${stepId}" data-contextmenu="${index}:seq_copy_step:${stepId},${index}:seq_paste_step:${stepId},-,${index}:seq_clear_step:${stepId},${index}:seq_clear_locks:${stepId}">${
        `<span class="beat-num">${i + 1}</span>`
      }<span class="material-icons chance-mark">casino</span><span class="lock-dot"></span></div>`;
    }
    drumLanes += '</div>';
  }

  const transposeMenu = [
    'label:Transpose by semitones',
    '-',
    ...[12, -12].map((n) => `${index}:seq_transpose:${n}`),
    '-',
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `${index}:seq_transpose:${n}`),
    '-',
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => `${index}:seq_transpose:${-n}`)
  ].join(',');
  const adjustMenu = [
    'label:Adjust sequence',
    '-',
    `${index}:seq_adjust:double`,
    '-',
    `${index}:seq_adjust:halftime`,
    `${index}:seq_adjust:thirdtime`,
    '-',
    `${index}:seq_adjust:veloup`,
    `${index}:seq_adjust:velodown`,
    '-',
    `${index}:seq_adjust:seq_legato`,
    `${index}:seq_adjust:seq_staccato`,
    '-',
    `${index}:seq_adjust:euclid-distrib`
  ].join(',');

  const zoneMuteKeyboardHint =
    index < 10 ? `(key ${(index + 1) % 10})` : '';

  return interpolateTemplate(templateZone, {
    index: index,
    zoneNumber: index + 1,
    zoneMuteKeyboardHint: zoneMuteKeyboardHint,
    channelOptions: channelOptions,
    sequencerGrid: sequencerGrid,
    drumLanes: drumLanes,
    seqMaxSteps: Sequence.MAX_STEPS,
    cycleConditions: cycleConditions,
    checkboxIcons: checkboxIcons,
    noteLengthOptions: noteLengthOptions,
    transposeMenu: transposeMenu,
    adjustMenu: adjustMenu
  });
}
