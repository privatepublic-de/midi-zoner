/**
 * Zone toggles (M, S, Seq, Arp, Trk) that wait for the next bar, beat or 16th while
 * the clock runs (Setup → Switching → Zone switches), so they land in time. The topbar's Quantize chip
 * decides whether they wait; Shift does the opposite of the chip. A waiting chip
 * blinks between its look now and the one it will have; clicking it again cancels.
 * Key switches and Mackie buttons wait like a plain click.
 */
import { ZoneType } from './types';

/** The actions that can wait, and whether the chip will be lit after the toggle */
const LIT_AFTER: Record<string, (zone: ZoneType) => boolean> = {
  // M is lit while muted
  zone_enabled: (zone) => zone.enabled,
  zone_solo: (zone) => !zone.solo,
  toggle_seq: (zone) => !zone.sequence.active,
  zone_arp_enabled: (zone) => !zone.arp_enabled,
  zone_takes: (zone) => !zone.takes_on
};

/** What a waiting toggle will do, for the mini lane's marker */
const TAG: Record<string, (zone: ZoneType) => string> = {
  zone_enabled: (zone) => (zone.enabled ? 'Mute' : 'Unmute'),
  zone_solo: (zone) => (zone.solo ? 'Solo off' : 'Solo'),
  toggle_seq: (zone) => (zone.sequence.active ? 'Seq off' : 'Seq on'),
  zone_arp_enabled: (zone) => (zone.arp_enabled ? 'Arp off' : 'Arp on'),
  zone_takes: (zone) => (zone.takes_on ? 'Trk off' : 'Trk on')
};

const BLINK_MS = 120;

/** Where waiting toggles land: 2 bar, 8 beat, 14 16th (zones.toggleQuantIndex) */
let boundary = 2;

/** Waiting toggles in the order they were asked for */
let pending: { zone: ZoneType; action: string }[] = [];
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkOn = false;

function isQuantizable(action: string): boolean {
  return action in LIT_AFTER;
}

/** Adds the toggle, or cancels it when it is already waiting; true when it waits now */
function requestToggle(zone: ZoneType, action: string): boolean {
  const before = pending.length;
  pending = pending.filter((p) => p.zone !== zone || p.action !== action);
  const waits = pending.length === before;
  if (waits) pending.push({ zone, action });
  markPending();
  return waits;
}

function isPending(zone: ZoneType, action: string): boolean {
  return pending.some((p) => p.zone === zone && p.action === action);
}

/** The waiting toggles of a zone, as their tags (e.g. "Seq on") with their actions */
function pendingOf(zone: ZoneType): { action: string; tag: string }[] {
  return pending.filter((p) => p.zone === zone).map((p) => ({ action: p.action, tag: TAG[p.action](zone) }));
}

function setToggleBoundary(quant: number): void {
  boundary = quant;
}

function toggleBoundary(): number {
  return boundary;
}

function hasPendingToggles(): boolean {
  return pending.length > 0;
}

/** Hands out the waiting toggles and forgets them */
function takePendingToggles(): { zone: ZoneType; action: string }[] {
  const taken = pending;
  pending = [];
  markPending();
  return taken;
}

function chipOf(zone: ZoneType, action: string): HTMLElement | null {
  return (
    zone.elements.zoneElement?.querySelector<HTMLElement>(`.channels [data-action$=":${action}"]`) ?? null
  );
}

/** Puts the blink on the waiting chips (after a toggle or a re-render) */
function markPending(): void {
  document.querySelectorAll('.channels .ch.pending').forEach((el) => {
    el.classList.remove('pending');
    el.removeAttribute('data-flip');
  });
  pending.forEach((p) => chipOf(p.zone, p.action)?.classList.add('pending'));
  if (pending.length > 0 && !blinkTimer) {
    blinkTimer = setInterval(blink, BLINK_MS);
  } else if (pending.length === 0 && blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
    blinkOn = false;
  }
}

/** Every other phase the chip shows the look it will have */
function blink(): void {
  blinkOn = !blinkOn;
  pending.forEach((p) => {
    const chip = chipOf(p.zone, p.action);
    if (!chip) return;
    if (blinkOn) chip.dataset.flip = LIT_AFTER[p.action](p.zone) ? 'on' : 'off';
    else chip.removeAttribute('data-flip');
  });
}

export {
  isQuantizable,
  requestToggle,
  isPending,
  pendingOf,
  setToggleBoundary,
  toggleBoundary,
  hasPendingToggles,
  takePendingToggles,
  markPending
};
