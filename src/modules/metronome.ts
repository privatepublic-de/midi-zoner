/**
 * Metronome: a click on every beat while the clock runs, and the count-in before Start
 * (internal clock only, see MIDI.startClock). Clicks play as audio (its own AudioContext,
 * so choosing an output device never touches the clock's) and/or as MIDI notes.
 *
 * Beats are scheduled a few ticks ahead: with an external clock a tick is only known
 * once it arrived, so the next beat is predicted from the tick interval. Accents come
 * from the song position (the caller's `beatAt`), so they follow loop jumps.
 */
import { PPQ } from './zone/seq-layer';

export interface MetronomeSettings {
  click: boolean; // click on every beat while running
  countIn: boolean; // count in before Start (internal clock)
  countInBars: number; // 1 or 2
  volume: number; // 0–1, audio click
  sinkId: string; // audio output device, '' = system default
  midiPortId: string; // '' = no MIDI click
  midiChannel: number; // 0–15
  accentNote: number;
  beatNote: number;
}

/** What plays at a position: nothing, a beat, or the accented first beat of a bar */
export enum Beat {
  NONE = 0,
  BEAT = 1,
  ACCENT = 2
}

const STORAGE_KEY = 'metronome';
const LEAD_MS = 40; // how far ahead a beat is scheduled (covers the audio output latency)
const CLICK_S = 0.03;
const MIDI_NOTE_MS = 50;

const defaults: MetronomeSettings = {
  click: false,
  countIn: false,
  countInBars: 1,
  volume: 0.6,
  sinkId: '',
  midiPortId: '',
  midiChannel: 9,
  accentNote: 76, // GM hi wood block
  beatNote: 77 // GM low wood block
};

const settings: MetronomeSettings = load();

function load(): MetronomeSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const s = { ...defaults, ...(stored && typeof stored === 'object' ? stored : {}) };
    const int = (v: unknown, lo: number, hi: number, def: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
    return {
      click: s.click === true,
      countIn: s.countIn === true,
      countInBars: int(s.countInBars, 1, 2, 1),
      volume: typeof s.volume === 'number' && Number.isFinite(s.volume) ? Math.min(1, Math.max(0, s.volume)) : defaults.volume,
      sinkId: typeof s.sinkId === 'string' ? s.sinkId : '',
      midiPortId: typeof s.midiPortId === 'string' ? s.midiPortId : '',
      midiChannel: int(s.midiChannel, 0, 15, defaults.midiChannel),
      accentNote: int(s.accentNote, 0, 127, defaults.accentNote),
      beatNote: int(s.beatNote, 0, 127, defaults.beatNote)
    };
  } catch {
    return { ...defaults };
  }
}

function save(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function update(change: Partial<MetronomeSettings>): void {
  Object.assign(settings, change);
  if (change.volume !== undefined && master) master.gain.value = settings.volume;
  if (change.sinkId !== undefined) applySink();
  save();
  warmUp();
}

// ---- audio ----

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const scheduled = new Set<OscillatorNode>();

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(ctx.destination);
    applySink();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

let sinkFailed: ((reason: string) => void) | null = null;

function applySink(): void {
  const c = ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
  if (!c?.setSinkId) return;
  c.setSinkId(settings.sinkId).catch((e: unknown) => {
    // the device is gone: back to the system output (the setting stays for when it returns)
    void c.setSinkId!('').catch(() => {});
    if (settings.sinkId) sinkFailed?.(e instanceof Error ? e.message : String(e));
  });
}

/** Opens the audio output ahead of the first click: started on the first beat, it would swallow it */
function warmUp(): void {
  if (settings.click || settings.countIn) audio();
}

/** Context time at which a sound becomes audible at performance.now() time `atMs` */
function contextTimeAt(c: AudioContext, atMs: number): number {
  const ts = c.getOutputTimestamp();
  const when = ts.performanceTime
    ? (ts.contextTime ?? 0) + (atMs - ts.performanceTime) / 1000
    : c.currentTime + (atMs - performance.now()) / 1000 - (c.outputLatency || c.baseLatency || 0);
  return Math.max(c.currentTime, when);
}

function playClick(atMs: number, accent: boolean): void {
  if (settings.volume <= 0) return;
  const c = audio();
  const t = contextTimeAt(c, atMs);
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'triangle';
  osc.frequency.value = accent ? 1760 : 1175;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(accent ? 1 : 0.6, t + 0.001);
  env.gain.exponentialRampToValueAtTime(0.001, t + CLICK_S);
  osc.connect(env).connect(master!);
  osc.start(t);
  osc.stop(t + CLICK_S + 0.01);
  scheduled.add(osc);
  osc.onended = () => {
    scheduled.delete(osc);
    env.disconnect();
  };
}

// ---- MIDI ----

let sendMidi: ((msg: Uint8Array, portId: string, timestamp?: number) => void) | null = null;

function playMidiClick(atMs: number, accent: boolean): void {
  if (!settings.midiPortId || !sendMidi) return;
  const note = accent ? settings.accentNote : settings.beatNote;
  const at = Math.max(performance.now(), atMs);
  sendMidi(Uint8Array.from([0x90 | settings.midiChannel, note, accent ? 120 : 90]), settings.midiPortId, at);
  sendMidi(Uint8Array.from([0x80 | settings.midiChannel, note, 0]), settings.midiPortId, at + MIDI_NOTE_MS);
}

// ---- scheduling ----

let scheduledUpTo = -Infinity; // the last position whose beat is scheduled
// Tick times jitter by a few ms (the internal clock's against the audio block size, an
// external one's on arrival), and so does the tick interval measured from them. Clicks
// follow a steady time and interval: a straight line fitted through the first bar of
// ticks (so the count-in is steady from its first beats), then a phase lock.
const FIT_TICKS = 96;
const PHASE_GAIN = 0.1;
const RATE_GAIN = 0.01;
let steadyPos = 0;
let steadyAt: number | null = null;
let steadyInterval = 0;
// least squares over the ticks since the lock started (x: ticks from the first, y: ms from it)
const fit = { n: 0, x0: 0, y0: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 };

function restartLock(pos: number, atMs: number, interval: number): void {
  Object.assign(fit, { n: 1, x0: pos, y0: atMs, sx: 0, sy: 0, sxx: 0, sxy: 0 });
  steadyAt = atMs;
  steadyInterval = interval;
}

function steadyTime(pos: number, atMs: number, interval: number): number {
  const expected = steadyAt === null ? 0 : steadyAt + steadyInterval;
  if (
    steadyAt === null ||
    pos !== steadyPos + 1 ||
    // a new tempo, a pause or a jump: start over from this tick (the measured interval
    // jitters by some 5 %, smaller tempo changes are followed by the lock)
    Math.abs(interval - steadyInterval) > interval * 0.15 ||
    Math.abs(atMs - expected) >= steadyInterval
  ) {
    restartLock(pos, atMs, interval);
  } else if (fit.n < FIT_TICKS) {
    const x = pos - fit.x0;
    const y = atMs - fit.y0;
    fit.n++;
    fit.sx += x;
    fit.sy += y;
    fit.sxx += x * x;
    fit.sxy += x * y;
    const d = fit.n * fit.sxx - fit.sx * fit.sx;
    if (fit.n >= 4 && d > 0) {
      steadyInterval = (fit.n * fit.sxy - fit.sx * fit.sy) / d;
      steadyAt = fit.y0 + (fit.sy - steadyInterval * fit.sx) / fit.n + steadyInterval * x;
    } else {
      steadyAt = expected;
    }
  } else {
    const err = atMs - expected;
    steadyAt = expected + err * PHASE_GAIN;
    steadyInterval += err * RATE_GAIN;
  }
  steadyPos = pos;
  return steadyAt!;
}
let beatHandler: ((accent: boolean, audible: boolean) => void) | null = null;
const flashTimers = new Set<ReturnType<typeof setTimeout>>();

/**
 * A clock tick at position `pos` (count-in ticks are negative, Start's tick is 0),
 * sounding at `atMs` (performance.now()); schedules the beats up to LEAD_MS ahead.
 * `beatAt(p)` says what plays at position p, `audible(p)` whether it clicks.
 */
function tick(pos: number, atMs: number, intervalMs: number, beatAt: (p: number) => Beat, audible: (p: number) => boolean): void {
  atMs = steadyTime(pos, atMs, intervalMs > 0 ? intervalMs : 60000 / 120 / PPQ);
  const interval = steadyInterval;
  const lead = Math.min(PPQ, Math.max(1, Math.ceil(LEAD_MS / interval)));
  for (let p = Math.max(pos, scheduledUpTo + 1); p <= pos + lead; p++) {
    const beat = beatAt(p);
    if (beat === Beat.NONE) continue;
    const at = atMs + (p - pos) * interval;
    const accent = beat === Beat.ACCENT;
    const sound = audible(p);
    if (sound) playClick(at, accent);
    if (beatHandler) {
      const timer = setTimeout(() => {
        flashTimers.delete(timer);
        beatHandler?.(accent, sound);
      }, Math.max(0, at - performance.now()));
      flashTimers.add(timer);
    }
  }
  scheduledUpTo = Math.max(scheduledUpTo, pos + lead);
  // MIDI has no output latency to cover and a sent note can't be taken back on Stop,
  // so the MIDI click goes out on the beat's own tick
  const beat = settings.midiPortId ? beatAt(pos) : Beat.NONE;
  if (beat !== Beat.NONE && audible(pos)) playMidiClick(atMs, beat === Beat.ACCENT);
}

/** Start, Stop or a cancelled count-in: forget what was scheduled, silence clicks not yet heard */
function reset(): void {
  scheduledUpTo = -Infinity;
  steadyAt = null;
  const now = ctx?.currentTime ?? 0;
  scheduled.forEach((osc) => {
    try {
      osc.stop(now);
    } catch {
      // already stopped
    }
  });
  flashTimers.forEach((t) => clearTimeout(t));
  flashTimers.clear();
}

/** Plays one click now, e.g. when the volume or output changes */
function preview(): void {
  playClick(performance.now(), true);
}

/** Audio output devices for the output selector (labels may be empty without permission) */
async function outputDevices(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
}

function init(
  send: (msg: Uint8Array, portId: string, timestamp?: number) => void,
  onBeat: (accent: boolean, audible: boolean) => void,
  onSinkFailed: (reason: string) => void
): void {
  sendMidi = send;
  beatHandler = onBeat;
  sinkFailed = onSinkFailed;
  warmUp();
}

export { settings as metronomeSettings, update as updateMetronome, warmUp as warmUpMetronome, tick as metronomeTick, reset as resetMetronome, preview as previewMetronome, outputDevices, init as initMetronome };
