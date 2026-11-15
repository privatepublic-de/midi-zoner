import MIDI from '../midi';
import { Note } from './note';
import { Take } from './take';
import type { TakeNoteJSON } from './interfaces';
import type { Zone } from './zone-class';
import { CurveCursor, curveEnd, TAIL_MS } from './note-curve';
import { GesturesJSON, firstPointAtOrAfter, isStepped, sendValue, springsBackTo, valueAt } from './gestures';
import { EARLY } from './looper';

/** Expression is sent about this often while a loop note plays it, in ms */
const SAMPLE_MS = 8;

/** A loop note's expression as it plays (zone/note-curve.ts): from its note-on through its release tail */
interface Voice {
  /** The zone's loop voice (MpeInput), -1 until the note-on (or none was free) */
  slot: number;
  cursor: CurveCursor;
  onAt: number;
  endAt: number;
  /** Where the next value is sampled (ticks since the section began) */
  next: number;
  /** Its note rings out (Stop, loop off): its expression stays where it is until its note-off */
  frozen: boolean;
  ended: boolean;
}

interface Scheduled {
  note: Note;
  onAt: number; // ticks since the section began (fractional): a loop's jump can't strand a note-off
  offAt: number;
  sounding: boolean;
  releasing: boolean;
  voice?: Voice;
}

/**
 * Plays a zone's loop every tick: notes between two ticks go out on timers for their
 * place. They are fed through the zone like step notes (arp, octave and range rules apply).
 */
export class TakePlayer {
  private zone: Zone;
  private queue: Scheduled[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private elapsed = 0;
  private tickMs = 20;
  /** Loop notes playing their expression (they outlive the note: release tails) */
  private voices: Voice[] = [];
  /** The gestures it plays (null: start afresh from where the loop is), their controls, what it sent */
  private gestures: { g: GesturesJSON | undefined; length: number } | null = null;
  private gestureKeys: string[] = [];
  private sampled = new Map<string, number>();
  constructor(zone: Zone) {
    this.zone = zone;
  }

  /**
   * The zone's loop: its notes (and an overdub's layer) every cycle from `anchor` on,
   * `elapsed` ticks since the section began. Silent (muted, soloed out): sounding notes
   * end, nothing new starts.
   */
  clockLoop(elapsed: number, tickIntervalMs: number, loop: Take, layer: TakeNoteJSON[], anchor: number, silent: boolean): void {
    const later = this.advance(elapsed, tickIntervalMs);
    if (silent) {
      if (this.queue.length > 0) this.release(true);
      return;
    }
    // it comes in at its first 1 (switched on, or a loop from a take, while running)
    if (elapsed < anchor) return;
    const len = loop.length;
    // whole ticks: a tick never spans the loop's end
    const local = (((elapsed - anchor) % len) + len) % len;
    this.playGestures(loop, local, later);
    for (const notes of [loop.notes, layer]) {
      for (const tn of notes) {
        if (tn.t >= local && tn.t < local + 1) this.schedule(tn, tn.t - local, tn.d, later);
      }
    }
  }

  /**
   * The loop's channel gestures within this tick (zone/gestures.ts), mixed with yours by the
   * zone: each cycle starts from what was held at its 1 (a change up to EARLY before the 1
   * belongs to it, as notes do, so it isn't played at the end); pedals change where they were
   * played, wheels are sampled about every SAMPLE_MS along their lines
   */
  private playGestures(loop: Take, local: number, later: (ticks: number, fn: () => void) => void): void {
    const g = loop.g;
    const keys = g ? Object.keys(g) : [];
    let fresh = local < 1;
    if (!this.gestures || this.gestures.g !== g || this.gestures.length !== loop.length) {
      // another loop, or this one changed: controls it no longer plays go back to yours
      const gone = this.gestureKeys.filter((k) => !keys.includes(k));
      if (gone.length > 0) this.zone.loopGesturesGone(gone);
      this.gestures = { g, length: loop.length };
      this.gestureKeys = keys;
      this.sampled.clear();
      fresh = true;
    }
    if (!g) return;
    const end = loop.length - EARLY;
    const step = Math.min(1, SAMPLE_MS / Math.max(1, this.tickMs));
    for (const key of keys) {
      const s = g[key];
      const at = (t: number): number | undefined => valueAt(key, s, t) ?? springsBackTo(key);
      if (fresh) {
        const v = at(Math.min(local, end));
        if (v !== undefined) {
          this.sampled.set(key, sendValue(key, v));
          this.zone.loopGesture(key, v);
        }
      }
      if (isStepped(key)) {
        for (let i = firstPointAtOrAfter(s, local); i < s.length && s[i] < local + 1; i += 2) {
          const t = s[i];
          if (t <= 0 || t >= end || (fresh && t <= local)) continue;
          const v = s[i + 1];
          later(t - local, () => this.zone.loopGesture(key, v));
        }
        continue;
      }
      for (let t = local + (fresh ? step : 0); t < local + 1 && t < end; t += step) {
        const v = at(t);
        if (v === undefined) continue;
        const out = sendValue(key, v);
        if (this.sampled.get(key) === out) continue;
        this.sampled.set(key, out);
        later(t - local, () => this.zone.loopGesture(key, out));
      }
    }
  }

  /** Releases the notes due before the next tick; returns the timer helper for this tick */
  private advance(elapsed: number, tickIntervalMs: number): (ticks: number, fn: () => void) => void {
    this.elapsed = elapsed;
    this.tickMs = tickIntervalMs;
    const later = (ticks: number, fn: () => void): void => {
      const ms = ticks * tickIntervalMs;
      if (ms < 1) {
        fn();
        return;
      }
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        this.timers.delete(timer);
        fn();
      }, ms);
      this.timers.add(timer);
    };
    for (const ev of this.queue) {
      if (!ev.sounding || ev.releasing || ev.offAt >= elapsed + 1) continue;
      ev.releasing = true;
      later(Math.max(0, ev.offAt - elapsed), () => this.end(ev));
    }
    this.driveVoices(elapsed, later);
    return later;
  }

  /** The expression of the loop notes playing it, sampled within this tick, on timers for their place */
  private driveVoices(elapsed: number, later: (ticks: number, fn: () => void) => void): void {
    if (this.voices.length === 0) return;
    this.voices = this.voices.filter((v) => !v.ended);
    // the zone stopped playing them (arp on, MPE off): their expression comes to rest now
    if (!this.zone.loopExpression) {
      this.endVoices();
      return;
    }
    const step = Math.min(1, SAMPLE_MS / Math.max(1, this.tickMs));
    for (const v of this.voices) {
      while (!v.frozen && v.next < elapsed + 1) {
        const t = v.next;
        v.next += step;
        if (t >= v.endAt) {
          later(t - elapsed, () => this.endVoice(v));
          v.next = Infinity;
          break;
        }
        const at = v.cursor.at(t - v.onAt);
        later(t - elapsed, () => {
          if (v.slot >= 0 && !v.ended) this.zone.loopVoiceAt(v.slot, at);
        });
      }
    }
  }

  private endVoice(v: Voice): void {
    if (v.ended) return;
    v.ended = true;
    if (v.slot >= 0) this.zone.loopVoiceEnd(v.slot);
  }

  /**
   * Every loop note's expression ends now: at rest, or `silently` when the zone's MPE state
   * is gone anyway (panic, undo: the next note sends its own values first)
   */
  endVoices(silently = false): void {
    for (const v of this.voices) {
      if (silently) v.ended = true;
      else this.endVoice(v);
    }
    this.voices = [];
  }

  /** A note `ahead` ticks after this tick, `length` long */
  private schedule(tn: TakeNoteJSON, ahead: number, length: number, later: (ticks: number, fn: () => void) => void): void {
    const zone = this.zone;
    const elapsed = this.elapsed;
    const note = new Note(tn.n, tn.v);
    note.channel = zone.channel;
    note.portId = zone.outputPortId;
    const onAt = elapsed + ahead;
    const ev: Scheduled = { note, onAt, offAt: onAt + length, sounding: false, releasing: false };
    // its expression, through its release tail (at most TAIL_MS at this tempo)
    if (tn.x && zone.loopExpression) {
      const tail = Math.min(curveEnd(tn.x), length + TAIL_MS / Math.max(1, this.tickMs));
      const cursor = new CurveCursor(tn.x);
      ev.voice = { slot: -1, cursor, onAt, endAt: onAt + Math.max(length, tail), next: onAt + 1e-9, frozen: false, ended: false };
      this.voices.push(ev.voice);
    }
    this.queue.push(ev);
    later(ahead, () => {
      // The same pitch still sounding (a chord held over the loop's end into its first note):
      // it ends here, so this note starts afresh instead of a second note-on that many synths
      // don't retrigger on
      for (const other of [...this.queue]) {
        if (other !== ev && other.sounding && other.note.number === note.number) this.end(other);
      }
      ev.sounding = true;
      // its expression goes out ahead of its note-on, as from an MPE keyboard
      const voice = ev.voice;
      if (voice && !voice.ended) voice.slot = zone.loopVoiceStart(note.number, voice.cursor.at(0));
      // Pass through: on its voice's member channel (the note-off follows the note-on's channel)
      this.send(MIDI.MESSAGE.NOTE_ON, note, voice ? zone.loopVoiceChannel(voice.slot) : -1);
      // a note shorter than the rest of this tick ends before the next one
      if (ev.offAt < elapsed + 1 && !ev.releasing) {
        ev.releasing = true;
        later(ev.offAt - ev.onAt, () => this.end(ev));
      }
    });
  }

  /** Sounding notes end (or ring out their length); unsent ones are dropped */
  release(ringOut: boolean): void {
    const ringOutNotes = ringOut && !this.zone.arp_enabled;
    // a ringing note's expression stays where it is and comes to rest with its note-off
    const ringing = new Set<Voice>();
    for (const ev of this.queue) {
      if (!ev.sounding) continue;
      const note = ev.note;
      const voice = ev.voice;
      if (ringOutNotes) {
        if (voice) {
          voice.frozen = true;
          ringing.add(voice);
        }
        this.zone.ringOutAfterTicks(note.number, Math.max(0, ev.offAt - this.elapsed), () => {
          this.send(MIDI.MESSAGE.NOTE_OFF, note);
          if (voice) this.endVoice(voice);
        });
      } else {
        this.send(MIDI.MESSAGE.NOTE_OFF, note);
      }
    }
    this.queue.length = 0;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    // its pedal lifts and wheels rest (after the ringing notes); played again, it starts afresh
    this.zone.loopGesturesEnd(ringOutNotes);
    this.gestures = null;
    this.gestureKeys = [];
    this.sampled.clear();
    // the others (in their release tail, or not started) rest now; ringing ones stay listed
    // until their note-off, so a panic or undo meanwhile still reaches them
    for (const v of this.voices) if (!ringing.has(v)) this.endVoice(v);
    this.voices = this.voices.filter((v) => !v.ended);
  }

  private end(ev: Scheduled): void {
    const index = this.queue.indexOf(ev);
    if (index === -1) return;
    this.queue.splice(index, 1);
    // A later note of the same pitch has taken over; its own note-off ends it
    const retriggered = this.queue.some((o) => o.sounding && o.note.number === ev.note.number && o.onAt > ev.onAt);
    if (ev.sounding && !retriggered) this.send(MIDI.MESSAGE.NOTE_OFF, ev.note);
    if (ev.voice && ev.voice.slot >= 0 && !ev.voice.ended) this.zone.loopVoiceReleased(ev.voice.slot);
  }

  private send(status: number, note: Note, loopChannel = -1): void {
    const msg = Uint8Array.from([status + note.channel, note.number, status === MIDI.MESSAGE.NOTE_ON ? note.velo : 0]);
    this.zone.handleMidi(status, msg, true, undefined, loopChannel);
  }
}
