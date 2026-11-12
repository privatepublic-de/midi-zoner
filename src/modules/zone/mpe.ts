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
 *   takes over it glides there (PressureGlide) instead of jumping. Slide plays the
 *   zone's controllers learned to CC 74 like a hardware knob (any CC/NRPN, range),
 *   and goes nowhere else (CC 74 is the cutoff on many synths). With
 *   poly aftertouch on, each held key sends its own pressure on its note instead.
 */
export enum MpeMode {
  OFF = 0,
  PASS = 1,
  COLLAPSE = 2
}

/** MPE's default bend range on the master channel, in semitones */
const MASTER_BEND_RANGE = 2;
/**
 * How long a zone keeps acting on a channel after its key is up (release tails), in ms.
 * After that the channel's next key, which may land in another zone of a key split,
 * can't move this zone's fading note: its expression arrives before its note-on.
 */
const RELEASE_KEEP_MS = 500;
/** Member channels of a full MPE zone, as a Seaboard uses them */
const MEMBER_CHANNELS = 15;
/** How long pressure glides when another key takes over, in ms */
const PRESSURE_GLIDE_MS = 150;
/** CC number of the slide dimension (MPE "timbre") */
export const MPE_SLIDE_CC = 74;

interface Voice {
  /** Last note started on the channel */
  note: number;
  /** The zone played that note (in its range, enabled), so it acts on the channel's expression */
  owned: boolean;
  /** When its key went up (performance.now()), -1 while held */
  releasedAt: number;
  /** 14-bit, 8192 = centre */
  bend: number;
  /** CC 74; null until the controller sends one */
  slide: number | null;
  pressure: number;
  /** The note the zone sent for the channel's key (after its octave shift) */
  outNote: number;
  /** Poly aftertouch sent last for that note, -1 = none yet */
  sentPoly: number;
}

/** Pressure from the threshold up, stretched back to 0–127 */
function scalePressure(pressure: number, from: number): number {
  return Math.round((Math.max(0, pressure - from) * 127) / (127 - from));
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
      releasedAt: -1,
      bend: 8192,
      slide: null,
      pressure: 0,
      outNote: -1,
      sentPoly: -1
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

  /** The zone plays the channel's note, sent as outNote */
  claim(ch: number, outNote: number): void {
    const v = this.voices[ch];
    v.owned = true;
    v.releasedAt = -1;
    v.outNote = outNote;
    v.sentPoly = -1;
    this.held.push(ch);
    this.source = ch;
  }

  /**
   * Poly aftertouch for a held key: its note and pressure (from the threshold up), or
   * null when the zone doesn't hold the key or the value is unchanged
   */
  polyPressure(ch: number, from: number): { note: number; value: number } | null {
    if (!this.held.includes(ch)) return null;
    const v = this.voices[ch];
    const value = scalePressure(v.pressure, from);
    if (value === v.sentPoly) return null;
    v.sentPoly = value;
    return { note: v.outNote, value };
  }

  /** The channel's key is up; false when it wasn't the zone's held note */
  noteEnded(ch: number, note: number): boolean {
    if (this.voices[ch].note !== note) return false;
    return this.release(ch);
  }

  /** The zone acts on the channel: its key is held, or went up less than RELEASE_KEEP_MS ago */
  owns(ch: number): boolean {
    const v = this.voices[ch];
    return v.owned && (v.releasedAt < 0 || performance.now() - v.releasedAt < RELEASE_KEEP_MS);
  }

  private release(ch: number): boolean {
    const i = this.held.indexOf(ch);
    if (i === -1) return false;
    this.held.splice(i, 1);
    this.voices[ch].releasedAt = performance.now();
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
    const pressure = scalePressure(pressed, o.pressureFrom);
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

/**
 * A 14-bit bend from a keyboard bending inRange semitones to a synth bending outRange:
 * the same pitch, clamped at the synth's limit (unchanged when the ranges match)
 */
export function rescaleBend(bend: number, inRange: number, outRange: number): number {
  if (inRange === outRange) return bend;
  const semis = ((bend - 8192) / 8192) * inRange;
  return Math.max(0, Math.min(16383, Math.round(8192 + (semis / Math.max(1, outRange)) * 8192)));
}

/** An RPN set on a channel, closed with the null RPN so later data entry can't change it */
function rpn(ch: number, param: number, value: number): number[][] {
  const cc = MIDI.MESSAGE.CONTROLLER + ch;
  return [[cc, 101, 0], [cc, 100, param], [cc, 6, value], [cc, 38, 0], [cc, 101, 127], [cc, 100, 127]];
}

/**
 * Pass-through: tells an MPE synth the keyboard's layout. The MPE Configuration Message
 * (RPN 6 on the master channel: the number of member channels) switches it to MPE, then
 * the bend ranges: the master's ±2 and memberBend on each member channel. Master Ch 16
 * is an upper zone (members Ch 1–15), any other a lower zone (master Ch 1, members 2–16).
 */
export function mpeSetupMessages(master: number, memberBend: number): number[][] {
  const upper = master === 15;
  const masterCh = upper ? 15 : 0;
  const messages = [...rpn(masterCh, 6, MEMBER_CHANNELS), ...rpn(masterCh, 0, MASTER_BEND_RANGE)];
  for (let i = 0; i < MEMBER_CHANNELS; i++) messages.push(...rpn(upper ? i : i + 1, 0, memberBend));
  return messages;
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
