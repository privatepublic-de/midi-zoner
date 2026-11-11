import MIDI from '../midi';

/**
 * MPE input (MIDI Polyphonic Expression, e.g. a ROLI Seaboard): every key plays on a
 * member channel of its own with its own pitch bend, slide (CC 74) and pressure; the
 * master channel (Ch 1 for a lower zone) carries what is for all notes.
 *
 * PASS: member channels go out as they came, for synths that speak MPE.
 * COLLAPSE: everything goes out on the zone channel, for synths that don't: bend, slide
 *   and pressure follow the last played key still held, so a solo over held notes
 *   stays expressive. Pressure counts from a threshold (just playing gives none, like
 *   the dead zone of an aftertouch keyboard), stretched back to 0–127; when another key
 *   takes over it glides there (PressureGlide) instead of jumping. Slide goes out on a
 *   CC of the zone's choice, or not at all (CC 74 is the cutoff on many synths).
 */
export enum MpeMode {
  OFF = 0,
  PASS = 1,
  COLLAPSE = 2
}

/** MPE's default bend range on the master channel, in semitones */
const MASTER_BEND_RANGE = 2;
/** How long pressure glides when another key takes over, in ms */
const PRESSURE_GLIDE_MS = 150;
/** CC number of the slide dimension (MPE "timbre") */
export const MPE_SLIDE_CC = 74;

interface Voice {
  /** Last note started on the channel */
  note: number;
  /** The zone plays that note (in its range, enabled), so it acts on the channel's expression */
  owned: boolean;
  /** 14-bit, 8192 = centre */
  bend: number;
  /** CC 74; null until the controller sends one */
  slide: number | null;
  pressure: number;
}

export interface CollapsedExpression {
  bend?: number;
  slide?: number;
  /** Always set: the pressure to reach (PressureGlide drops repeats) */
  pressure: number;
  /** Pressure now comes from another held key: glide there */
  handover: boolean;
}

/**
 * The state of the member channels as one zone sees it. Expression arrives before its
 * note-on, so every channel's values are kept whether or not the zone owns it; with key
 * splits a zone only acts on channels whose note it plays.
 */
export class MpeInput {
  private voices: Voice[] = [];
  /** Owned channels whose key is down, oldest first */
  private held: number[] = [];
  /** Channel bend, slide and pressure follow in COLLAPSE (kept after release, so the release tail doesn't jump) */
  private source = -1;
  private masterBend = 8192;
  /** What COLLAPSE sent last, so a flood of identical values goes out once; -1 = unknown */
  private sent = { bend: -1, slide: -1 };
  /** The held key pressure came from last time, -1 = none */
  private pressureKey = -1;

  constructor() {
    this.reset();
  }

  reset(): void {
    this.voices = Array.from({ length: 16 }, () => ({
      note: -1,
      owned: false,
      bend: 8192,
      slide: null,
      pressure: 0
    }));
    this.held = [];
    this.source = -1;
    this.masterBend = 8192;
    // Unknown after a reset (panic, mode change, a new zone object on undo): the
    // first values go out even when centred, so the synth can't stay detuned
    this.sent = { bend: -1, slide: -1 };
    this.pressureKey = -1;
  }

  voice(ch: number): Readonly<Voice> {
    return this.voices[ch];
  }

  static isExpression(message: number, data: Uint8Array): boolean {
    return (
      message === MIDI.MESSAGE.PITCH_BEND ||
      message === MIDI.MESSAGE.CHANNEL_PRESSURE ||
      (message === MIDI.MESSAGE.CONTROLLER && data[1] === MPE_SLIDE_CC)
    );
  }

  /** Keeps a channel's bend, slide or pressure; other messages are ignored */
  store(ch: number, message: number, data: Uint8Array): void {
    const v = this.voices[ch];
    if (message === MIDI.MESSAGE.PITCH_BEND) v.bend = data[1] | (data[2] << 7);
    else if (message === MIDI.MESSAGE.CONTROLLER && data[1] === MPE_SLIDE_CC) v.slide = data[2];
    else if (message === MIDI.MESSAGE.CHANNEL_PRESSURE) v.pressure = data[1];
  }

  setMasterBend(data: Uint8Array): void {
    this.masterBend = data[1] | (data[2] << 7);
  }

  /** A new note on the channel: not the zone's until claim() */
  noteStarted(ch: number, note: number): void {
    this.release(ch);
    const v = this.voices[ch];
    v.note = note;
    v.owned = false;
  }

  /** The zone plays the channel's note */
  claim(ch: number): void {
    this.voices[ch].owned = true;
    this.held.push(ch);
    this.source = ch;
  }

  /** The channel's key is up; false when it wasn't the zone's held note */
  noteEnded(ch: number, note: number): boolean {
    if (this.voices[ch].note !== note) return false;
    return this.release(ch);
  }

  private release(ch: number): boolean {
    const i = this.held.indexOf(ch);
    if (i === -1) return false;
    this.held.splice(i, 1);
    if (this.held.length > 0) this.source = this.held[this.held.length - 1];
    return true;
  }

  /**
   * COLLAPSE: the single channel's bend (rescaled from bendIn to bendOut semitones and
   * clamped), slide and pressure, only the parts that changed since last time
   */
  collapsed(o: { bendIn: number; bendOut: number; withBend: boolean; pressureFrom: number }): CollapsedExpression {
    const { bendIn, bendOut, withBend } = o;
    const src = this.source >= 0 ? this.voices[this.source] : null;
    const semis =
      ((this.masterBend - 8192) / 8192) * MASTER_BEND_RANGE +
      (src ? ((src.bend - 8192) / 8192) * bendIn : 0);
    const bend = Math.max(0, Math.min(16383, Math.round(8192 + (semis / Math.max(1, bendOut)) * 8192)));
    // The followed key's pressure from the threshold up, stretched back to 0–127;
    // none once no key is held
    const key = src && this.held.includes(this.source) ? this.source : -1;
    const pressed = key >= 0 ? this.voices[key].pressure : 0;
    const pressure = Math.round((Math.max(0, pressed - o.pressureFrom) * 127) / (127 - o.pressureFrom));
    // Glide only from one held key to another: the first key after silence, or the
    // last one let go, already starts or ends at its own pressure
    const handover = key !== this.pressureKey && key >= 0 && this.pressureKey >= 0;
    const out: CollapsedExpression = { pressure, handover };
    this.pressureKey = key;
    // Bend left out (filtered) stays unknown, so it goes out once it's let through
    if (!withBend) this.sent.bend = -1;
    else if (bend !== this.sent.bend) out.bend = this.sent.bend = bend;
    if (src && src.slide !== null && src.slide !== this.sent.slide) out.slide = this.sent.slide = src.slide;
    return out;
  }
}

/**
 * Sends merged pressure. Values from the key being played go out as they come; when
 * another key takes over, the output glides from where it was to that key's pressure
 * (which may keep moving meanwhile), so it doesn't jump.
 */
export class PressureGlide {
  /** Last value sent, -1 = unknown (the next value goes out whatever it is) */
  private value = -1;
  private target = 0;
  private from = 0;
  private start = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private send: (value: number) => void) {}

  to(target: number, glide: boolean): void {
    this.target = target;
    if (glide && this.value >= 0 && this.value !== target) {
      this.from = this.value;
      this.start = performance.now();
      if (this.timer === null) this.step();
    } else if (this.timer === null && target !== this.value) {
      this.value = target;
      this.send(target);
    } // while gliding, the glide carries on towards the new target
  }

  private step = (): void => {
    const k = Math.min(1, (performance.now() - this.start) / PRESSURE_GLIDE_MS);
    const v = Math.round(this.from + (this.target - this.from) * k);
    if (v !== this.value) {
      this.value = v;
      this.send(v);
    }
    this.timer = k < 1 ? setTimeout(this.step, 10) : null;
  };

  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.value = -1;
  }
}

/**
 * Pressure threshold: 0 (none) – 120. Measured on a Seaboard RISE 49: just playing a key
 * reads 50–100, so 80 gives roughly what a channel aftertouch keyboard does (about half
 * the held time at 0, pressure only from a deliberate push)
 */
export const DEFAULT_PRESSURE_FROM = 80;
export function sanitizePressureFrom(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 120 ? n : fallback;
}

/** Slide target CC, null = off (many synths have the cutoff on CC 74) */
export function sanitizeSlideCC(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 && n <= 127 ? n : null;
}

/** Bend ranges are whole semitones, 1–96 */
export function sanitizeBendRange(value: unknown, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 && n <= 96 ? n : fallback;
}

export function sanitizeMpeMode(value: unknown): MpeMode {
  return value === MpeMode.PASS || value === MpeMode.COLLAPSE ? value : MpeMode.OFF;
}

/**
 * Input routing that zones claim: the ports of zones with their own input, and whether
 * an MPE zone on the global input needs every channel of the selected ports. Ports in
 * either get all channels from midi.ts; app.ts then filters per zone.
 */
export function zoneInputClaims(list: { inputPortId: string | null; mpe: MpeMode }[]): {
  ports: Set<string>;
  allChannels: boolean;
} {
  const ports = new Set<string>();
  let allChannels = false;
  list.forEach((zone) => {
    if (zone.inputPortId) ports.add(zone.inputPortId);
    else if (zone.mpe !== MpeMode.OFF) allChannels = true;
  });
  return { ports, allChannels };
}
