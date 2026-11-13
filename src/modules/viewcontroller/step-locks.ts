import { ZoneType } from './types';
import { controllerDisplay, selectorDisplay } from './cc-controller-view';
import { CCController, CCControllerType } from '../zone/interfaces';
import { controllerAddress, knobValueFor } from '../zone/param-locks';

type ActionHandler = (ev: Event, overrideaction?: string) => void;

/** How a lock's address reads when no controller is on it (any more) */
function addressLabel(address: string): string {
  const [kind, a, b] = address.split(':');
  if (kind == 'nrpn') return `NRPN ${a}:${b}`;
  if (kind == 'hr') return `14-bit ${a}/${b}`;
  return `CC ${a}`;
}

/** A lock's value as the controller shows it: entry or button name, value name, number */
function lockValueText(zone: ZoneType, c: CCController, ix: number, sent: number): string {
  const shown = { ...c, val: knobValueFor(c, sent) };
  if (c.type == CCControllerType.SELECTOR) return selectorDisplay(shown).name || String(sent);
  if (c.type == CCControllerType.BUTTON_BANK) {
    for (let i = 0; i < 8; i++) {
      const label = (c as any)[`buttonlabel${i}`];
      if ((c as any)[`buttonvalue${i}`] == shown.val && label?.trim()) return label;
    }
  }
  const display = controllerDisplay(zone, shown, ix);
  return display.name || display.value;
}

/**
 * Fills the step editor's Locks row: one chip per locked address of the selected
 * steps (controller name and value, "~" when the steps differ) with a remove button,
 * and the Slide toggle. Locks without a controller show dimmed.
 */
export function renderStepLocks(zone: ZoneType, zoneindex: number, actionHandler: ActionHandler): void {
  const row = zone._$('.step-locks') as HTMLElement | null;
  const list = row?.querySelector('.lock-list') as HTMLElement | null;
  if (!row || !list) return;
  const steps = zone.sequence.selectedSteps;
  const addresses: string[] = [];
  steps.forEach((st) => st?.locks.forEach((l) => addresses.includes(l.a) || addresses.push(l.a)));
  // In the order of the zone's controllers, dormant locks last
  const order = (a: string): number => {
    const i = zone.cc_controllers.findIndex((c) => controllerAddress(c) === a);
    return i < 0 ? Infinity : i;
  };
  addresses.sort((a, b) => order(a) - order(b));

  list.replaceChildren();
  if (addresses.length === 0) {
    const hint = document.createElement('i');
    hint.textContent = 'Turn a knob to lock its value on this step';
    list.appendChild(hint);
  }
  for (const address of addresses) {
    const values = zone.sequence.selectedLockValues(address);
    const ix = order(address);
    const c = zone.cc_controllers[ix];
    const chip = document.createElement('span');
    chip.className = 'lock-chip';
    const name = document.createElement('span');
    name.className = 'lock-name';
    const value = document.createElement('span');
    value.className = 'lock-value';
    if (c) {
      name.textContent = c.label || addressLabel(address);
      value.textContent = values.some((v) => v !== values[0]) ? '~' : lockValueText(zone, c, ix, values[0]);
    } else {
      chip.classList.add('dormant');
      chip.title = 'No controller on this address: the lock is kept but not sent';
      name.textContent = addressLabel(address);
      value.textContent = values.every((v) => v === values[0]) ? String(values[0]) : '~';
    }
    const remove = document.createElement('i');
    remove.className = 'material-icons';
    remove.textContent = 'close';
    remove.title = 'Remove this lock';
    // Colons separate action parameters
    const action = `${zoneindex}:seq_lock_remove:${address.replace(/:/g, '.')}`;
    remove.addEventListener('click', (ev) => actionHandler(ev, action));
    chip.append(name, value, remove);
    list.appendChild(chip);
  }
  row.classList.toggle('has-locks', addresses.length > 0);
  row.querySelector('.seq-step-slide')?.classList.toggle('selected', steps.some((st) => st?.slide));
}
