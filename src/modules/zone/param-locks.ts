import { CCController, CCControllerType, isHiResCC, isLayoutEntry } from './interfaces';

/**
 * A parameter lock on a sequencer step: the value `v` a controller transmits (device
 * units, as `transmittedValue()` returns it), keyed by the controller's address `a`,
 * so locks survive reordering and replacing the zone's controllers.
 */
export interface ParamLock {
  a: string;
  v: number;
}

const MAX_LOCKS_PER_STEP = 32;
const ADDRESS_PATTERN = /^(cc:\d{1,3}|(nrpn|hr):\d{1,3}:\d{1,3})$/;

/**
 * What a controller sends to: `cc:<n>` for 7-bit controllers, `nrpn:<msb>:<lsb>`,
 * `hr:<msb cc>:<lsb cc>` for 14-bit pairs. Null for controllers without a value.
 */
export function controllerAddress(c: CCController): string | null {
  if (isLayoutEntry(c.type) || c.type == CCControllerType.NOTE_TO_CC) return null;
  if (c.type == CCControllerType.NRPN) return `nrpn:${(c.nrpn_msb || 0) & 0x7f}:${(c.nrpn_lsb || 0) & 0x7f}`;
  if (isHiResCC(c.type)) return `hr:${c.number & 0x7f}:${(c.number_lsb || 0) & 0x7f}`;
  return `cc:${c.number & 0x7f}`;
}

/** 14-bit type value at its resolution: 0–16383, or 0–1023 at 10 bit */
export function hiResValue(c: CCController): number {
  return c.val >> (7 - (c.lsb_bits ?? 7));
}

/** NRPN value in device units: the knob's 0–16383 mapped onto min–max */
export function nrpnValue(c: CCController): number {
  const min = c.min || 0;
  const max = c.max ?? 16383;
  return Math.round(min + (max - min) * (c.val / 16383));
}

/** A 7-bit knob position (0–127) mapped onto the controller's min–max */
export function remapCCValue(c: CCController, valueIn: number): number {
  const value = Math.floor(c.min + (c.max - c.min) * (valueIn / 127.0));
  return Math.max(0, Math.min(127, value));
}

/** The value a controller transmits for its current `val` */
export function transmittedValue(c: CCController): number {
  if (c.type == CCControllerType.NRPN) return nrpnValue(c);
  if (isHiResCC(c.type)) return hiResValue(c);
  if (c.type == CCControllerType.SELECTOR) return c.val;
  return remapCCValue(c, c.val);
}

/** The closest snap step of a knob with `discreteValues`, otherwise the value itself */
export function snappedKnobValue(c: CCController, value: number): number {
  if (c.type != CCControllerType.UNIPOLAR_ROTARY || !c.discreteValues?.length) return value;
  return c.discreteValues.reduce((prev, curr) => (Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev));
}

/** The `val` at which a controller transmits `sent` (or comes as close as it can) */
export function knobValueFor(c: CCController, sent: number): number {
  if (c.type == CCControllerType.BUTTON_BANK || c.type == CCControllerType.SELECTOR) return sent;
  if (c.type == CCControllerType.NRPN) {
    const min = c.min || 0;
    const max = c.max ?? 16383;
    return max > min ? Math.max(0, Math.min(16383, Math.round(((sent - min) * 16383) / (max - min)))) : 0;
  }
  if (isHiResCC(c.type)) return Math.max(0, Math.min(16383, sent << (7 - (c.lsb_bits ?? 7))));
  const min = c.min || 0;
  const max = c.max ?? 127;
  const clamp = (k: number): number => Math.max(0, Math.min(127, k));
  const estimate = clamp(max != min ? Math.round(((sent - min) * 127) / (max - min)) : 0);
  // Sending rounds down: a neighbour of the estimate may be the position that sends `sent`
  const exact = [0, 1, -1, 2, -2].map((d) => clamp(estimate + d)).find((k) => remapCCValue(c, k) === sent);
  return snappedKnobValue(c, exact ?? estimate);
}

/** Whether a lock on this controller can glide: continuous values only */
function canSlide(c: CCController): boolean {
  return c.type != CCControllerType.BUTTON_BANK && c.type != CCControllerType.SELECTOR && !c.discreteValues?.length;
}

/** Locks from a scene file or clipboard (untrusted): valid addresses and values only, one per address */
export function parseLocks(raw: unknown): ParamLock[] {
  if (!Array.isArray(raw)) return [];
  const byAddress = new Map<string, number>();
  for (const lock of raw) {
    const a = lock?.a;
    const v = lock?.v;
    if (typeof a != 'string' || !ADDRESS_PATTERN.test(a) || typeof v != 'number' || !Number.isFinite(v)) continue;
    if (a.split(':').slice(1).some((n) => Number(n) > 127)) continue;
    byAddress.delete(a); // the last one wins
    byAddress.set(a, Math.max(0, Math.min(a.startsWith('cc:') ? 127 : 16383, Math.round(v))));
  }
  return [...byAddress].slice(-MAX_LOCKS_PER_STEP).map(([a, v]) => ({ a, v }));
}

/** What ParamLocks needs from its zone */
export interface LockHost {
  readonly cc_controllers: CCController[];
  sendTransmitted(c: CCController, value: number): void;
  /** Lock values were sent or reverted: the knobs following them redraw */
  lockValuesChanged(): void;
}

interface Glide {
  from: number;
  to: number;
  startPos: number;
  endPos: number;
}

/**
 * Plays a zone's parameter locks (Elektron style): a played step sends its locks; a
 * lock holds until the next played step of the same lane that doesn't lock that
 * address, which sends the controller's own value again. Per address the highest
 * lane holding a lock wins (drum lanes; the melodic sequence is lane -1). Locks on a
 * step with `slide` glide there over the step's length. Owned by the zone, so it
 * survives arrangement switches (they replace the sequence).
 */
export class ParamLocks {
  /** Last value transmitted per address, by locks and by the zone's own controllers */
  private sent = new Map<string, number>();
  /** Addresses whose last transmission was a lock (or an audition) rather than the controller's own value */
  private dirty = new Set<string>();
  /** Address -> lane -> locked value */
  private held = new Map<string, Map<number, number>>();
  private glides = new Map<string, Glide>();
  private pendingRelease: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: LockHost) {}

  /** The controller playing an address: the first one on it */
  controllerFor(address: string): CCController | undefined {
    return this.host.cc_controllers.find((c) => controllerAddress(c) === address);
  }

  noteTransmitted(address: string, value: number): void {
    this.sent.set(address, value);
    this.dirty.delete(address);
  }

  /** The value a lock (or a slide, or an audition) left on an address, if it was sent last */
  liveValue(address: string): number | undefined {
    return this.dirty.has(address) ? this.sent.get(address) : undefined;
  }

  /** Lets the user hear a lock while editing it */
  audition(c: CCController, value: number): void {
    this.sendLock(c, value);
  }

  private sendLock(c: CCController, value: number): void {
    this.host.sendTransmitted(c, value);
    const address = controllerAddress(c);
    if (address) this.dirty.add(address);
    this.host.lockValuesChanged();
  }

  /** A step played (its condition and chance passed): send its locks, revert the lane's others */
  stepPlayed(lane: number, locks: ParamLock[], slide: boolean, pos: number, durationTicks: number): void {
    const touched = new Set<string>();
    this.held.forEach((lanes, address) => {
      if (lanes.has(lane) && !locks.some((l) => l.a === address)) {
        lanes.delete(lane);
        touched.add(address);
      }
    });
    for (const lock of locks) {
      if (!this.controllerFor(lock.a)) continue; // no controller on it (any more): dormant
      let lanes = this.held.get(lock.a);
      if (!lanes) this.held.set(lock.a, (lanes = new Map()));
      lanes.set(lane, lock.v);
      touched.add(lock.a);
    }
    touched.forEach((address) => {
      const c = this.controllerFor(address);
      if (!c) return;
      const target = this.effectiveValue(address, c);
      if (slide && durationTicks > 0 && canSlide(c) && locks.some((l) => l.a === address)) {
        this.glides.set(address, {
          from: this.sent.get(address) ?? transmittedValue(c),
          to: target,
          startPos: pos,
          endPos: pos + durationTicks
        });
        return;
      }
      this.glides.delete(address);
      if (this.sent.get(address) === target) return;
      if (this.held.has(address)) {
        this.sendLock(c, target);
      } else {
        this.host.sendTransmitted(c, target); // reverted: the controller's own value
        this.host.lockValuesChanged();
      }
    });
  }

  /** Clock tick: advance glides, sending only values that change */
  tick(pos: number): void {
    this.glides.forEach((g, address) => {
      const c = this.controllerFor(address);
      const t = Math.max(0, Math.min(1, (pos - g.startPos) / (g.endPos - g.startPos)));
      if (!c || t >= 1) this.glides.delete(address);
      if (!c) return;
      const value = Math.round(g.from + (g.to - g.from) * t);
      if (this.sent.get(address) !== value) this.sendLock(c, value);
    });
  }

  /** Transport start: every locked address starts from the controller's own value */
  start(lockedAddresses: Iterable<string>): void {
    this.cancelPending();
    this.held.clear();
    this.glides.clear();
    for (const address of lockedAddresses) {
      const c = this.controllerFor(address);
      if (c) this.host.sendTransmitted(c, transmittedValue(c));
    }
  }

  /**
   * Sequence stopped: locks no longer hold. The controllers' own values are sent again
   * (after `delayMs`, so ringing notes keep their sound) where a lock or an audition
   * was sent last, and for locked addresses where the last value sent is unknown.
   */
  stop(lockedAddresses: Iterable<string>, delayMs = 0): void {
    this.cancelPending();
    this.held.clear();
    this.glides.clear();
    const addresses = [...lockedAddresses];
    if (delayMs <= 0) {
      this.restore(addresses);
      return;
    }
    this.pendingRelease = setTimeout(() => {
      this.pendingRelease = null;
      this.restore(addresses);
    }, delayMs);
  }

  /** Drop a delayed restore (start, panic, zone deleted) */
  cancelPending(): void {
    if (this.pendingRelease === null) return;
    clearTimeout(this.pendingRelease);
    this.pendingRelease = null;
  }

  private restore(lockedAddresses: string[]): void {
    const addresses = new Set(lockedAddresses.filter((a) => !this.sent.has(a)));
    this.dirty.forEach((address) => addresses.add(address));
    addresses.forEach((address) => {
      const c = this.controllerFor(address);
      if (c) this.host.sendTransmitted(c, transmittedValue(c));
      this.dirty.delete(address);
    });
    if (addresses.size > 0) this.host.lockValuesChanged();
  }

  /** The highest lane's lock on an address, otherwise the controller's own value */
  private effectiveValue(address: string, c: CCController): number {
    const lanes = this.held.get(address);
    let top = -Infinity;
    let value = transmittedValue(c);
    lanes?.forEach((v, lane) => {
      if (lane > top) {
        top = lane;
        value = v;
      }
    });
    if (lanes?.size === 0) this.held.delete(address);
    return value;
  }
}
