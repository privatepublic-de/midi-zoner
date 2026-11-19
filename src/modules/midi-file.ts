import { PPQ } from './zone/seq-layer';
import { TakeJSON, TakeNoteJSON } from './zone/interfaces';
import { Take } from './zone/take';
import { Meter, DEFAULT_METER, barTicks, parseMeter } from './meter';
import { GesturesJSON, BEND, PRESSURE, isStepped, thinSeries, cutGestures } from './zone/gestures';

/**
 * Standard MIDI Files (.mid) read into takes. Pure (no DOM), and the file is untrusted:
 * every read is checked against the data, counts are capped, a broken track keeps what
 * was read before the break.
 */

/** A channel message of a track (file ticks) */
export interface MidiEvent {
  t: number;
  status: number;
  d1: number;
  d2: number;
}

export interface MidiTrack {
  name: string;
  events: MidiEvent[];
  /** Its last event's tick (notes still held there end at it) */
  end: number;
}

export interface MidiFile {
  format: number;
  /** Ticks per quarter note */
  division: number;
  tracks: MidiTrack[];
  /** Set Tempo events of all tracks (they're file-wide), by tick */
  tempos: { t: number; bpm: number }[];
  /** Time Signature events of all tracks, by tick */
  meters: { t: number; n: number; d: number }[];
}

/** What can be imported: the notes of one channel of one track */
export interface MidiPart {
  track: number;
  channel: number;
  name: string;
  notes: number;
  low: number;
  high: number;
}

export interface MidiImport {
  take: TakeJSON;
  /** Notes left out: past Take.MAX_LENGTH or Take.MAX_NOTES */
  cut: boolean;
  /** The meter at the take's start, and whether the file's could be kept as it is */
  meter: Meter;
  meterExact: boolean;
  /** The file's first tempo (null: none given) */
  bpm: number | null;
}

const MAX_TRACKS = 256;
const MAX_EVENTS = 1000000;
/** Tempo and meter changes kept (Take.from keeps 256 sections) */
const MAX_CHANGES = 256;
/** A note still held at its track's end (or one with no length) is at least this long */
const MIN_NOTE = 0.25;

class Reader {
  constructor(private b: Uint8Array, public p: number, private end: number) {}
  get done(): boolean {
    return this.p >= this.end;
  }
  byte(): number {
    if (this.p >= this.end) throw new RangeError('past the end');
    return this.b[this.p++];
  }
  peek(): number {
    if (this.p >= this.end) throw new RangeError('past the end');
    return this.b[this.p];
  }
  /** Variable-length quantity: at most 4 bytes */
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.byte();
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new RangeError('bad length');
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.p + n > this.end) throw new RangeError('past the end');
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
}

const u32 = (b: Uint8Array, p: number): number => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u16 = (b: Uint8Array, p: number): number => (b[p] << 8) | b[p + 1];
const tag = (b: Uint8Array, p: number): string => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** Text of a meta event (old files are Latin-1; control characters dropped) */
function text(bytes: Uint8Array): string {
  let s = '';
  for (const c of bytes.subarray(0, 64)) s += c >= 32 && c !== 127 ? String.fromCharCode(c) : ' ';
  return s.replace(/\s+/g, ' ').trim();
}

/** Reads a Standard MIDI File; throws an Error whose message can be shown */
export function parseMidiFile(b: Uint8Array): MidiFile {
  if (b.length < 14 || tag(b, 0) !== 'MThd') throw new Error('Not a MIDI file');
  const headerLength = u32(b, 4);
  if (headerLength < 6 || 8 + headerLength > b.length) throw new Error('Not a MIDI file');
  const format = u16(b, 8);
  const division = u16(b, 12);
  if (division & 0x8000) throw new Error('MIDI files timed in SMPTE frames can’t be imported');
  if (division === 0) throw new Error('Not a MIDI file');
  const file: MidiFile = { format, division, tracks: [], tempos: [], meters: [] };
  let events = 0;
  let p = 8 + headerLength;
  while (p + 8 <= b.length && file.tracks.length < MAX_TRACKS) {
    const id = tag(b, p);
    const length = u32(b, p + 4);
    const start = p + 8;
    // a last chunk cut short is read as far as it goes
    const end = Math.min(b.length, start + length);
    p = start + length;
    if (id !== 'MTrk') continue;
    const track: MidiTrack = { name: '', events: [], end: 0 };
    const r = new Reader(b, start, end);
    let t = 0;
    let running = 0;
    try {
      while (!r.done && events < MAX_EVENTS) {
        t += r.vlq();
        track.end = t;
        let status = r.peek();
        if (status & 0x80) r.p++;
        else if (running) status = running;
        else break; // data without a status: the track is broken from here
        if (status === 0xff) {
          const type = r.byte();
          const data = r.bytes(r.vlq());
          events++;
          if (type === 0x2f) break; // end of track
          if ((type === 0x03 || (type === 0x04 && !track.name)) && data.length) track.name = text(data);
          else if (type === 0x51 && data.length >= 3) {
            const us = (data[0] << 16) | (data[1] << 8) | data[2];
            if (us > 0 && file.tempos.length < MAX_CHANGES) file.tempos.push({ t, bpm: 60000000 / us });
          } else if (type === 0x58 && data.length >= 2 && file.meters.length < MAX_CHANGES) file.meters.push({ t, n: data[0], d: 2 ** data[1] });
        } else if (status === 0xf0 || status === 0xf7) {
          r.bytes(r.vlq()); // sysex
          events++;
        } else if (status > 0xf0) {
          break; // not allowed in a file
        } else {
          running = status;
          const type = status & 0xf0;
          const d1 = r.byte() & 0x7f;
          const d2 = type === 0xc0 || type === 0xd0 ? 0 : r.byte() & 0x7f;
          track.events.push({ t, status, d1, d2 });
          events++;
        }
      }
    } catch {
      // cut short: keep what was read
    }
    file.tracks.push(track);
  }
  if (file.tracks.length === 0) throw new Error('The MIDI file has no tracks');
  file.tempos.sort((a, b) => a.t - b.t);
  file.meters.sort((a, b) => a.t - b.t);
  return file;
}

/** Each channel of each track that has notes, in file order */
export function partsOf(file: MidiFile): MidiPart[] {
  const parts: MidiPart[] = [];
  file.tracks.forEach((track, i) => {
    const byChannel = new Map<number, MidiPart>();
    for (const e of track.events) {
      if ((e.status & 0xf0) !== 0x90 || e.d2 === 0) continue;
      const channel = e.status & 0x0f;
      let part = byChannel.get(channel);
      if (!part) {
        part = { track: i, channel, name: track.name || `Track ${i + 1}`, notes: 0, low: 127, high: 0 };
        byChannel.set(channel, part);
      }
      part.notes++;
      part.low = Math.min(part.low, e.d1);
      part.high = Math.max(part.high, e.d1);
    }
    parts.push(...[...byChannel.values()].sort((a, b) => a.channel - b.channel));
  });
  return parts;
}

/**
 * A file's time signature as a meter of the app (n/4 or n/8), the same bar length where
 * it has to change (2/2 → 4/4, 12/16 → 6/8); 4/4 when there is none
 */
export function meterOfSignature(n: number, d: number): { meter: Meter; exact: boolean } {
  const exact = (m: Meter | null): { meter: Meter; exact: boolean } | null => (m ? { meter: m, exact: true } : null);
  const quarters = (n * 4) / d;
  const eighths = (n * 8) / d;
  const inQuarters = Number.isInteger(quarters) ? exact(parseMeter({ n: quarters, d: 4 })) : null;
  const inEighths = Number.isInteger(eighths) ? exact(parseMeter({ n: eighths, d: 8 })) : null;
  return (
    (d === 4 || d === 8 ? exact(parseMeter({ n, d })) : null) ??
    // halves and wholes count in quarters, 16ths in eighths
    (d < 4 ? inQuarters ?? inEighths : inEighths ?? inQuarters) ?? {
      meter: DEFAULT_METER,
      exact: false
    }
  );
}

/** CCs that set a synth up rather than play it (bank, volume, pan, data entry, RPN/NRPN): left out */
const SETUP_CCS = new Set([0, 6, 7, 8, 10, 32, 38, 96, 97, 98, 99, 100, 101]);
/** Wheels, aftertouch, breath, foot and expression count as played once they move at all */
const WHEELS = (key: string): boolean => key === BEND || key === PRESSURE || ['c1', 'c2', 'c4', 'c11'].includes(key);

/**
 * One part of the file as a take, shaped as a recorded one: from the bar of its first note
 * (in the file's bars) to the bar line after its last, the file's meters as its sections,
 * its channel's sustain, wheels, aftertouch and played CCs as gestures. The result still
 * goes through Take.from() (as everything from a file).
 */
export function takeFromPart(file: MidiFile, part: MidiPart): MidiImport {
  // multiplied first and kept to 1/8 tick, so bar lines stay exact for any division (480, 960…)
  const toTicks = (t: number): number => Math.round((t * PPQ * 8) / file.division) / 8;
  const track = file.tracks[part.track];
  const events = track?.events.filter((e) => (e.status & 0x0f) === part.channel) ?? [];

  // notes: each note-off ends the oldest held note of its pitch
  const notes: TakeNoteJSON[] = [];
  const held = new Map<number, TakeNoteJSON[]>();
  const series = new Map<string, number[]>();
  for (const e of events) {
    const type = e.status & 0xf0;
    const t = toTicks(e.t);
    if (type === 0x90 && e.d2 > 0) {
      const note: TakeNoteJSON = { t, d: NaN, n: e.d1, v: e.d2 }; // NaN: not released yet
      notes.push(note);
      const list = held.get(e.d1);
      if (list) list.push(note);
      else held.set(e.d1, [note]);
    } else if (type === 0x80 || type === 0x90) {
      const note = held.get(e.d1)?.shift();
      if (note) note.d = Math.max(MIN_NOTE, t - note.t);
    } else {
      const key = type === 0xe0 ? BEND : type === 0xd0 ? PRESSURE : type === 0xb0 && e.d1 < 120 && !SETUP_CCS.has(e.d1) ? 'c' + e.d1 : null;
      if (!key) continue;
      const value = type === 0xe0 ? e.d1 | (e.d2 << 7) : type === 0xd0 ? e.d1 : e.d2;
      const s = series.get(key);
      if (s) s.push(t, value);
      else series.set(key, [t, value]);
    }
  }
  // notes never released last to the track's end
  const trackEnd = toTicks(track?.end ?? 0);
  for (const n of notes) if (isNaN(n.d)) n.d = Math.max(MIN_NOTE, trackEnd - n.t);
  notes.sort((a, b) => a.t - b.t);

  // the file's bars: its time signatures as sections (4/4 until the first)
  const signatures = file.meters.map((m) => ({ t: toTicks(m.t), ...meterOfSignature(m.n, m.d) }));
  const inFile = new Take();
  inFile.sections = [{ t: 0, meter: DEFAULT_METER }];
  for (const s of signatures) {
    if (inFile.sections[inFile.sections.length - 1].t === s.t) inFile.sections.pop();
    inFile.sections.push({ t: s.t, meter: s.meter });
  }
  const first = notes.length ? notes[0].t : 0;
  const from = inFile.barLine(first, 'floor');
  const meter = inFile.sectionAt(from).meter;
  const meterExact = signatures.every((s) => s.exact);

  const take = new Take();
  take.sections = [{ t: 0, meter }, ...inFile.sections.filter((s) => s.t > from).map((s) => ({ t: s.t - from, meter: s.meter }))];
  let cut = notes.length > Take.MAX_NOTES;
  const kept = notes.slice(0, Take.MAX_NOTES).filter((n) => {
    n.t -= from;
    if (n.t < Take.MAX_LENGTH) return true;
    cut = true;
    return false;
  });
  const last = Math.max(0, ...kept.map((n) => n.t + n.d));
  const length = Math.min(Take.MAX_LENGTH, Math.max(take.barLine(last, 'ceil'), barTicks(meter)));

  // gestures: controls that are played, not set once (a loop would send a set value every round):
  // pedals pressed, wheels moved, other CCs taking three values or more
  const g: GesturesJSON = {};
  series.forEach((s, key) => {
    const values = new Set(s.filter((_, i) => i % 2 === 1));
    if (isStepped(key) ? ![...values].some((v) => v >= 64) : values.size < (WHEELS(key) ? 2 : 3)) return;
    g[key] = thinSeries(key, s);
  });

  const json: TakeJSON = {
    start: 0,
    length,
    offset: 0,
    notes: kept,
    at: Date.now(),
    sections: take.sections.map((s) => ({ t: s.t, meter: s.meter })),
    ...(Object.keys(g).length ? { g: cutGestures(g, from, from + length, from) } : {})
  };
  const tempo = file.tempos[0];
  return { take: json, cut, meter, meterExact, bpm: tempo ? tempo.bpm : null };
}

/** "Melody · ch 1 · 214 notes · C4–A5" (the name is from the file: escape it for HTML) */
export function partLabel(part: MidiPart, noteName: (n: number) => string): string {
  return `${part.name} · ch ${part.channel + 1} · ${part.notes} note${part.notes === 1 ? '' : 's'} · ${noteName(part.low)}–${noteName(part.high)}`;
}
