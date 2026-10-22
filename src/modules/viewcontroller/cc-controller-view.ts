import DOM from '../domutils';
import * as zoneTemplate from '../zone-template';
import potDragHandler from '../potdraghandler';
import { ZoneType } from './types';
import { CCController, CCControllerType, isHiResCC } from '../zone/interfaces';
import { labelForZone } from './action-labels';
import { differsFromPreset, findDevicePreset } from '../device-presets';

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

/** Background arc of every knob (viewBox 0 0 56 56) */
export const knobRangePath = describeArc(28, 30, 18, -135, 135);

// NRPN controllers with at most this many steps get tick marks like snap steps
const MAX_NRPN_TICKS = 24;

export function isBipolarController(c: CCController): boolean {
  return (
    c.type == CCControllerType.BIPOLAR_ROTARY ||
    c.type == CCControllerType.BIPOLAR_14BIT ||
    (c.type == CCControllerType.NRPN && !!c.bipolar)
  );
}

/** Value arc and tick marks of a knob (viewBox 0 0 56 56) */
export function knobPaths(c: CCController): { value: string; discrete: string; bipolar: boolean } {
  const is14bit = isHiResCC(c.type);
  const bipolar = isBipolarController(c);
  const valDegrees = is14bit
    ? 270 * (bipolar ? (c.val - 8192) / 8192 : c.val / 16383)
    : 270 * (bipolar ? (c.val - 64) / 64 : c.val / 127);
  let ticks = c.discreteValues || [];
  if (c.type == CCControllerType.NRPN) {
    const steps = (c.max ?? 16383) - (c.min || 0);
    ticks = steps > 0 && steps <= MAX_NRPN_TICKS
      ? Array.from({ length: steps + 1 }, (_, i) => Math.round((i * 16383) / steps))
      : [];
  }
  return {
    value: bipolar ? describeArc(28, 30, 18, 0, valDegrees / 2) : describeArc(28, 30, 18, -135, -135 + valDegrees),
    discrete: describeDiscreteValues(ticks, is14bit),
    bipolar
  };
}

/** The number shown on a knob and its value name, if any */
export function controllerDisplay(zone: ZoneType, c: CCController, ix: number): { value: string; name: string } {
  const is14bit = isHiResCC(c.type);
  let displayValue: number = c.val;
  // Index into valueNames: the snap step, or the value counted from min
  let nameIndex = -1;
  if (c.type == CCControllerType.UNIPOLAR_ROTARY) {
    displayValue = zone.remapCCValue(c.val, ix);
    nameIndex = c.discreteValues?.length ? c.discreteValues.indexOf(c.val) : displayValue - (c.min || 0);
  } else if (c.type == CCControllerType.NRPN) {
    displayValue = zone.nrpnValue(c);
    nameIndex = displayValue - (c.min || 0);
    if (c.bipolar) displayValue -= Math.round(((c.min || 0) + (c.max ?? 16383)) / 2);
  } else if (is14bit) {
    const bits = 7 + (c.lsb_bits ?? 7);
    displayValue = zone.hiResValue(c) - (isBipolarController(c) ? 1 << (bits - 1) : 0);
  } else if (isBipolarController(c)) {
    displayValue -= 64;
  }
  return { value: String(displayValue), name: c.valueNames?.[nameIndex] ?? '' };
}

/** Name of the linked device preset, "•" when the controllers were changed since */
export function devicePresetLabel(zone: ZoneType): string {
  if (!zone.devicePreset) return 'Presets';
  const linked = findDevicePreset(zone.devicePreset.id);
  return zone.devicePreset.name + (!linked || differsFromPreset(zone.cc_controllers, linked) ? ' •' : '');
}

/** Rotary types; buttons, note to CC and spacers have no knob to drag */
export function isRotary(c: CCController): boolean {
  return c.type < CCControllerType.SPACER || isHiResCC(c.type);
}

type ControllersChangedListener = (zone: ZoneType, zoneindex: number, onlyIndex?: number) => void;
let controllersChanged: ControllersChangedListener | null = null;

/** Called after every update of a zone's controllers (the controller editor follows it) */
export function onControllersChanged(listener: ControllersChangedListener): void {
  controllersChanged = listener;
}

/**
 * Drags a controller's value with the mouse: sends when the transmitted value changes,
 * one undo entry per drag.
 */
export function startControllerDrag(
  zone: ZoneType,
  zoneindex: number,
  ix: number,
  e: MouseEvent,
  onGestureStart: (label: string) => void,
  onGestureEnd: () => void,
  triggerSave: () => void
): void {
  const ctrl = zone.cc_controllers[ix];
  const is14bit = isHiResCC(ctrl.type);
  onGestureStart(labelForZone(zone, zoneindex, ctrl.label || `CC ${ix + 1}`));
  potDragHandler.startDrag(
    e,
    is14bit ? ctrl.val : ctrl.val << 7,
    (v) => {
      const oldVal = ctrl.val;
      const oldOutput = zone.ccOutputValue(ix);
      if (is14bit) {
        ctrl.val = v;
      } else {
        zone.snap2DiscreteValue(v >> 7, ix);
      }
      if (ctrl.val !== oldVal) {
        // Narrow ranges map many knob positions onto one value: send only real changes
        if (zone.ccOutputValue(ix) !== oldOutput) zone.sendCC(ix);
        updateControllerValues(zone, zoneindex, ix);
      }
    },
    () => {
      onGestureEnd();
      triggerSave();
    }
  );
}

export function updateControllerValues(zone: ZoneType, zoneindex: number, onlyIndex?: number): void {
  zone.cc_controllers.forEach((c, ix) => {
    if (onlyIndex !== undefined && ix !== onlyIndex) return;
    const potselector = `#pot_${zoneindex}_${ix}`;
    const knob = knobPaths(c);
    if (onlyIndex === undefined) {
      zone._$(`${potselector}_range`)?.setAttribute('d', knobRangePath);
    }
    zone._$(`${potselector}_value`)?.setAttribute('d', knob.value);
    (zone._$(`${potselector}_zero`) as HTMLElement).style.display = knob.bipolar ? 'block' : 'none';
    zone._$(`${potselector}_discrete`)?.setAttribute('d', knob.discrete);
    const potcontainer = zone._$(potselector) as HTMLElement;
    potcontainer.dataset.type = String(c.type);
    potcontainer.dataset.group = String(c.group || 0);
    potcontainer.dataset.hasInput = c.number_in != null ? '1' : '';
    (zone._$(`${potselector} div.cclabel`) as HTMLElement).textContent =
      c.type == CCControllerType.NOTE_TO_CC ? 'Note to CC' : c.label;
    const display = controllerDisplay(zone, c, ix);
    (zone._$(`${potselector} .value`) as HTMLElement).textContent = display.value;
    const valueName = zone._$(`${potselector} .valuename`) as HTMLElement | null;
    if (valueName) {
      valueName.textContent = display.name;
      valueName.title = display.name;
    }
    if (c.type == CCControllerType.NOTE_TO_CC) {
      let infotext = '';
      if (c.note_cc != null) {
        infotext += '<div>Note: <br/>#' + c.note_cc + '</div>';
      }
      if (c.velocity_cc != null) {
        infotext += '<div>Velocity: <br/>#' + c.velocity_cc + '</div>';
      }
      (zone._$(`${potselector} .info`) as HTMLElement).innerHTML = infotext;
    }
    if (c.type == CCControllerType.BUTTON_BANK) {
      let visibleButtons = 0;
      for (let i = 0; i < 8; i++) {
        const btn = zone._$(`${potselector} .ccbtn${i}`) as HTMLElement;
        const label = (c as any)[`buttonlabel${i}`];
        const value = (c as any)[`buttonvalue${i}`];
        if (
          typeof label != 'undefined' &&
          typeof value != 'undefined' &&
          label.trim() != ''
        ) {
          btn.style.display = '';
          btn.textContent = label;
          visibleButtons++;
          if (value == c.val) {
            btn.classList.add('selected');
          } else {
            btn.classList.remove('selected');
          }
        } else {
          btn.style.display = 'none';
        }
      }
      // One column up to 3 buttons, then two columns of up to 4 rows
      const rows = visibleButtons <= 3 ? Math.max(visibleButtons, 1) : Math.ceil(visibleButtons / 2);
      (zone._$(`${potselector} .buttons`) as HTMLElement).style.setProperty('--button-rows', String(rows));
    }
  });
  controllersChanged?.(zone, zoneindex, onlyIndex);
}

export function renderControllersForZone(
  zone: ZoneType,
  index: number,
  actionHandler: (ev: MouseEvent, overrideaction?: string) => void,
  triggerSave: () => void,
  onGestureStart: (label: string) => void,
  onGestureEnd: () => void
): void {
  DOM.all(`#zone${index} .ccpots .ccpot, #zone${index} .ccpots .ccpots-empty`).forEach((e) => e.remove());
  DOM.addHTML(
    `#zone${index} .ccpots .container`,
    'afterbegin',
    zoneTemplate.getControllerHTML(zone, index)
  );
  zone.elements.emptyCache();

  DOM.all(`#zone${index} .ccpots .ccpot`).forEach((pot, ix) => {
    // The zone is for playing; double-click opens the controller editor
    pot.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.ccbtn')) return;
      actionHandler(e as MouseEvent, `${index}:cc_edit:${ix}`);
    });
    pot.addEventListener('mousedown', (e) => {
      const mouseEvent = e as MouseEvent;
      if (!isRotary(zone.cc_controllers[ix]) || mouseEvent.button !== 0) return;
      startControllerDrag(zone, index, ix, mouseEvent, onGestureStart, onGestureEnd, triggerSave);
    });
  });
  if (zone.cc_controllers.length === 0) {
    const container = document.querySelector(`#zone${index} .ccpots .container`) as HTMLElement;
    const placeholder = document.createElement('div');
    placeholder.className = 'ccpots-empty';
    placeholder.title = 'Add a controller';
    placeholder.dataset.action = `${index}:cc_add`;
    placeholder.innerHTML = '<span class="material-icons">add</span>';
    container.appendChild(placeholder);
  }

  DOM.all(`#zone${index} .ccpots *[data-action]`).forEach((e) => {
    e.addEventListener('click', actionHandler as EventListener);
  });
}
