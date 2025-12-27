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

function describeDiscreteValues(values: number[]): string {
  let path = '';
  if (values != null && values.length > 0) {
    for (let i = 0; i < values.length; i++) {
      const degrees = -135 + 270 * (values[i] / 127);
      const point1 = polarToCartesian(28, 30, 15, degrees);
      const point2 = polarToCartesian(28, 30, 21, degrees);
      path +=
        'M ' + point1.x + ' ' + point1.y + 'L ' + point2.x + ' ' + point2.y;
    }
  }
  return path;
}

const rangePath = describeArc(28, 30, 18, -135, 135);

export function updateControllerValues(zone: ZoneType, zoneindex: number): void {
  zone.cc_controllers.forEach((c, ix) => {
    const potselector = `#pot_${zoneindex}_${ix}`;
    const is14bit = c.type == 5 || c.type == 6;
    const isBiploar = c.type == 1 || c.type == 6;
    const valDegrees = is14bit
      ? 270 * (isBiploar ? (c.val - 8192) / 8192 : c.val / 16383)
      : 270 * (isBiploar ? (c.val - 64) / 64 : c.val / 127);
    const valuePath = isBiploar
      ? describeArc(28, 30, 18, 0, valDegrees / 2)
      : describeArc(28, 30, 18, -135, -135 + valDegrees);
    zone._$(`${potselector}_range`)?.setAttribute('d', rangePath);
    zone._$(`${potselector}_value`)?.setAttribute('d', valuePath);
    (zone._$(`${potselector}_zero`) as HTMLElement).style.display = isBiploar ? 'block' : 'none';
    zone
      ._$(`${potselector}_discrete`)
      ?.setAttribute('d', describeDiscreteValues(c.discreteValues || []));
    const potcontainer = zone._$(potselector) as HTMLElement;
    potcontainer.dataset.type = String(c.type);
    potcontainer.dataset.group = String(c.group || 0);
    (zone._$(`${potselector} div.cclabel`) as HTMLElement).innerHTML =
      c.type == 4 ? 'Note to CC' : c.label;
    let displayValue: number = c.val;
    if (c.type == 0) {
      displayValue = zone.remapCCValue(c.val, ix);
    } else if (isBiploar) {
      displayValue = is14bit ? displayValue - 8192 : displayValue - 64;
    }
    (zone._$(`${potselector} .value`) as HTMLElement).innerHTML = String(displayValue);
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
          btn.innerHTML = label;
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
        (zone._$('.cc-editor .cc-in') as HTMLInputElement).value =
          typeof c.number_in == 'undefined' ? '' : String(c.number_in);
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
  DOM.switchClass(zone.elements.ccPots!, zone.editCC, 'cc-edit');
}

export function renderControllersForZone(
  zone: ZoneType,
  index: number,
  actionHandler: (ev: MouseEvent, overrideaction?: string) => void,
  triggerSave: () => void
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
  });

  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((pot, ix) => {
    const is14bit =
      zone.cc_controllers[ix].type == 5 || zone.cc_controllers[ix].type == 6;
    pot.addEventListener('wheel', (e) => {
      if (
        zone.cc_controllers[ix].type > 1 &&
        zone.cc_controllers[ix].type < 5
      ) {
        return;
      }
      e.preventDefault();
      if (zone.editCC) {
        return;
      }
      const wheelEvent = e as WheelEvent;
      const factor = is14bit ? (wheelEvent.shiftKey ? 1 : 8) : 1;
      const newV = Math.min(
        Math.max(
          parseInt(
            String(zone.cc_controllers[ix].val +
              Math.sign(wheelEvent.deltaY + wheelEvent.deltaX) * factor)
          ),
          0
        ),
        is14bit ? 16383 : 127
      );
      if (newV != zone.cc_controllers[ix].val) {
        if (is14bit) {
          zone.cc_controllers[ix].val = newV;
        } else {
          const discreteValues = zone.cc_controllers[ix].discreteValues;
          if (discreteValues?.length > 0) {
            const nextiX =
              discreteValues.indexOf(zone.cc_controllers[ix].val) +
              (newV < zone.cc_controllers[ix].val ? -1 : 1);
            zone.cc_controllers[ix].val =
              discreteValues[
                nextiX < 0
                  ? 0
                  : nextiX >= discreteValues.length
                  ? discreteValues.length - 1
                  : nextiX
              ];
          } else {
            zone.cc_controllers[ix].val = newV;
          }
        }
        zone.sendCC(ix);
        updateControllerValues(zone, index);
        triggerSave();
      }
    });
    pot.addEventListener('mousedown', (e) => {
      const mouseEvent = e as MouseEvent;
      if (
        (zone.cc_controllers[ix].type > 1 &&
          zone.cc_controllers[ix].type < 5) ||
        zone.editCC ||
        mouseEvent.button !== 0
      ) {
        return;
      }
      potDragHandler.startDrag(
        pot as HTMLElement,
        mouseEvent,
        (v) => {
          const oldVal = zone.cc_controllers[ix].val;
          if (v != oldVal) {
            if (is14bit) {
              zone.cc_controllers[ix].val = v;
            } else {
              zone.snap2DiscreteValue(v >> 7, ix);
            }
            zone.sendCC(ix);
            updateControllerValues(zone, index);
          }
        },
        () => {
          triggerSave();
        }
      );
    });
  });
  DOM.all(`#zone${index} .ccpots *[data-action]`).forEach((e) => {
    e.addEventListener('click', actionHandler as EventListener);
  });
  DOM.all(`#zone${index} .ccpots *[data-change]`).forEach((e) => {
    e.addEventListener('input', actionHandler as EventListener);
  });
}
