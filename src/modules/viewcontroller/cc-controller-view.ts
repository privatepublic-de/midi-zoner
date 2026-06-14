import DOM from '../domutils';
import * as zoneTemplate from '../zone-template';
import potDragHandler from '../potdraghandler';
import { ZoneType, ZonesData } from './types';

function polarToCartesian(
  centerX: number,
  centerY: number,
  radius: number,
  degrees: number
): { x: number; y: number } {
  const rad = ((degrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(rad),
    y: centerY + radius * Math.sin(rad)
  };
}

function describeArc(
  x: number,
  y: number,
  radius: number,
  startAngle: number,
  endAngle: number
): string {
  if (startAngle > endAngle) {
    const temp = startAngle;
    startAngle = endAngle;
    endAngle = temp;
  }
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return [
    'M',
    start.x,
    start.y,
    'A',
    radius,
    radius,
    0,
    largeArcFlag,
    0,
    end.x,
    end.y
  ].join(' ');
}

function describeDiscreteValues(values: number[], is14bit: boolean): string {
  let path = '';
  if (values != null && values.length > 0) {
    const maxVal = is14bit ? 16383 : 127;
    for (let i = 0; i < values.length; i++) {
      const degrees = -135 + 270 * (values[i] / maxVal);
      const point1 = polarToCartesian(28, 30, 15, degrees);
      const point2 = polarToCartesian(28, 30, 21, degrees);
      path +=
        'M ' + point1.x + ' ' + point1.y + 'L ' + point2.x + ' ' + point2.y;
    }
  }
  return path;
}

const rangePath = describeArc(28, 30, 18, -135, 135);

export function updateControllerValues(zone: ZoneType, zoneindex: number, onlyIndex?: number): void {
  zone.cc_controllers.forEach((c, ix) => {
    if (onlyIndex !== undefined && ix !== onlyIndex) return;
    const potselector = `#pot_${zoneindex}_${ix}`;
    const is14bit = c.type == 5 || c.type == 6;
    const isBiploar = c.type == 1 || c.type == 6;
    const valDegrees = is14bit
      ? 270 * (isBiploar ? (c.val - 8192) / 8192 : c.val / 16383)
      : 270 * (isBiploar ? (c.val - 64) / 64 : c.val / 127);
    const valuePath = isBiploar
      ? describeArc(28, 30, 18, 0, valDegrees / 2)
      : describeArc(28, 30, 18, -135, -135 + valDegrees);
    if (onlyIndex === undefined) {
      zone._$(`${potselector}_range`)?.setAttribute('d', rangePath);
    }
    zone._$(`${potselector}_value`)?.setAttribute('d', valuePath);
    (zone._$(`${potselector}_zero`) as HTMLElement).style.display = isBiploar ? 'block' : 'none';
    zone
      ._$(`${potselector}_discrete`)
      ?.setAttribute('d', describeDiscreteValues(c.discreteValues || [], is14bit));
    const potcontainer = zone._$(potselector) as HTMLElement;
    potcontainer.dataset.type = String(c.type);
    potcontainer.dataset.group = String(c.group || 0);
    potcontainer.dataset.hasInput = c.number_in != null ? '1' : '';
    (zone._$(`${potselector} div.cclabel`) as HTMLElement).textContent =
      c.type == 4 ? 'Note to CC' : c.label;
    let displayValue: number = c.val;
    if (c.type == 0) {
      displayValue = zone.remapCCValue(c.val, ix);
    } else if (isBiploar) {
      displayValue = is14bit ? displayValue - 8192 : displayValue - 64;
    }
    (zone._$(`${potselector} .value`) as HTMLElement).textContent = String(displayValue);
    if (c.type == 4) {
      let infotext = '';
      if (c.note_cc != null) {
        infotext += '<div>Note: <br/>#' + c.note_cc + '</div>';
      }
      if (c.velocity_cc != null) {
        infotext += '<div>Velocity: <br/>#' + c.velocity_cc + '</div>';
      }
      (zone._$(`${potselector} .info`) as HTMLElement).innerHTML = infotext;
    }
    if (c.type == 3) {
      for (let i = 0; i < 8; i++) {
        const btn = zone._$(`${potselector} .ccbtn${i}`) as HTMLElement;
        const label = (c as any)[`buttonlabel${i}`];
        const value = (c as any)[`buttonvalue${i}`];
        if (
          typeof label != 'undefined' &&
          typeof value != 'undefined' &&
          label.trim() != ''
        ) {
          btn.style.display = 'block';
          btn.textContent = label;
          if (value == c.val) {
            btn.classList.add('selected');
          } else {
            btn.classList.remove('selected');
          }
        } else {
          btn.style.display = 'none';
        }
        if (ix == zone.selectedCCIndex) {
          const labelin = zone._$(
            `input[data-change="${zoneindex}:cc_button_label:${i}"]`
          ) as HTMLInputElement;
          const valuein = zone._$(
            `input[data-change="${zoneindex}:cc_button_value:${i}"]`
          ) as HTMLInputElement;
          labelin.value = label || '';
          valuein.value = typeof value == 'undefined' ? '' : value;
        }
      }
    }
    if (ix == zone.selectedCCIndex) {
      DOM.addClass(potselector, 'selected');
      if (zone.editCC) {
        (zone._$('.cc-editor') as HTMLElement).dataset.type = String(c.type);
        (zone._$('.cc-editor .cclabel') as HTMLInputElement).value = c.label;
        (zone._$('.cc-editor .cc-out-lsb') as HTMLInputElement).value =
          typeof c.number_lsb == 'undefined' ? '' : String(c.number_lsb);
        const ccInEl = zone._$('.cc-editor .cc-in') as HTMLInputElement;
        ccInEl.value = c.number_in != null ? String(c.number_in) : '';
        ccInEl.classList.add('midi-learn-active');
        (zone._$('.cc-editor .cc-out') as HTMLInputElement).value = String(c.number);
        (zone._$('.cc-editor .cc-min') as HTMLInputElement).value = String(c.min || 0);
        (zone._$('.cc-editor .cc-max') as HTMLInputElement).value = String(c.max || 127);
        (zone._$('.cc-editor .cc_change_type') as HTMLSelectElement).value = String(c.type);
        (zone._$('.cc-editor .cc_change_group') as HTMLSelectElement).selectedIndex = c.group || 0;
        (zone._$('.cc-editor .cc_notenum2cc') as HTMLInputElement).value = c.note_cc != null ? String(c.note_cc) : '';
        (zone._$('.cc-editor .cc_notevelocity2cc') as HTMLInputElement).value = c.velocity_cc != null ? String(c.velocity_cc) : '';
        (zone._$('.cc-editor .cc_discrete_values') as HTMLInputElement).value =
          c.discreteValues?.join(',') || '';
      }
    } else {
      DOM.removeClass(potselector, 'selected');
    }
  });
  const wasEditing = zone.elements.ccPots![0]?.classList.contains('cc-edit') ?? false;
  DOM.switchClass(zone.elements.ccPots!, zone.editCC, 'cc-edit');
  if (zone.editCC && !wasEditing) {
    requestAnimationFrame(() => {
      (zone._$('.cc-editor') as HTMLElement)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}

export function renderControllersForZone(
  zone: ZoneType,
  index: number,
  actionHandler: (ev: MouseEvent, overrideaction?: string) => void,
  triggerSave: () => void,
  onGestureStart: () => void,
  onGestureEnd: () => void
): void {
  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((e) => e.remove());
  DOM.addHTML(
    `#zone${index} .ccpots .container`,
    'afterbegin',
    zoneTemplate.getControllerHTML(zone, index)
  );
  zone.elements.emptyCache();
  const suckEvent = (e: Event): void => {
    e.stopPropagation();
  };
  DOM.on(`#zone${index} .ccpots .cc-editor`, 'click', suckEvent);
  DOM.on(`#zone${index} .ccpots input`, 'keyup', suckEvent);
  DOM.on(`#zone${index} .ccpots input`, 'focus', (e) => {
    (e.target as HTMLInputElement).select();
    onGestureStart();
  });
  DOM.on(`#zone${index} .ccpots input`, 'blur', () => {
    onGestureEnd();
  });

  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((pot, ix) => {
    const is14bit =
      zone.cc_controllers[ix].type == 5 || zone.cc_controllers[ix].type == 6;
    (pot.querySelector('.cclabel') as HTMLElement).addEventListener('click', (e) => {
      e.stopPropagation();
      if (zone.selectedCCIndex === ix && zone.editCC) {
        zone.editCC = false;
      } else {
        zone.selectedCCIndex = ix;
        zone.editCC = true;
      }
      updateControllerValues(zone, index);
    });

    pot.addEventListener('mousedown', (e) => {
      const mouseEvent = e as MouseEvent;
      if (
        (e.target as HTMLElement).closest('.cclabel') ||
        (zone.cc_controllers[ix].type > 1 &&
          zone.cc_controllers[ix].type < 5) ||
        zone.editCC ||
        mouseEvent.button !== 0
      ) {
        return;
      }
      onGestureStart();
      const currentValue14 = is14bit
        ? zone.cc_controllers[ix].val
        : zone.cc_controllers[ix].val << 7;
      potDragHandler.startDrag(
        mouseEvent,
        currentValue14,
        (v) => {
          const oldVal = zone.cc_controllers[ix].val;
          if (is14bit) {
            zone.cc_controllers[ix].val = v;
          } else {
            zone.snap2DiscreteValue(v >> 7, ix);
          }
          if (zone.cc_controllers[ix].val !== oldVal) {
            zone.sendCC(ix);
            updateControllerValues(zone, index, ix);
          }
        },
        () => {
          onGestureEnd();
          triggerSave();
        }
      );
    });
  });
  if (zone.cc_controllers.length === 0) {
    const container = document.querySelector(`#zone${index} .ccpots .container`) as HTMLElement;
    const placeholder = document.createElement('div');
    placeholder.className = 'ccpots-empty';
    placeholder.innerHTML = '<span class="material-icons">add</span>';
    placeholder.addEventListener('click', (e) => {
      e.stopPropagation();
      zone.cc_controllers.push({
        number: 1, number_in: null, min: 0, max: 127, type: 0,
        label: 'Ctrl #1', val: 0, note_cc: null, velocity_cc: null
      } as any);
      zone.selectedCCIndex = 0;
      zone.editCC = true;
      renderControllersForZone(zone, index, actionHandler, triggerSave, onGestureStart, onGestureEnd);
      triggerSave();
    });
    container.appendChild(placeholder);
  }

  DOM.all(`#zone${index} .ccpots *[data-action]`).forEach((e) => {
    e.addEventListener('click', actionHandler as EventListener);
  });
  DOM.all(`#zone${index} .ccpots *[data-change]`).forEach((e) => {
    e.addEventListener('input', actionHandler as EventListener);
  });
}
