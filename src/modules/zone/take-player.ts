import MIDI from '../midi';
import { Note } from './note';
import { Take } from './take';
import type { TakeNoteJSON } from './interfaces';
import type { Zone } from './zone-class';
import { CurveCursor, curveEnd, TAIL_MS } from './note-curve';

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
  /** Its note rings out (Stop, loop off): its expression stays where it is until it ends */
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
    const len = loop.length;
    // whole ticks: a tick never spans the loop's end
    const local = (((elapsed - anchor) % len) + len) % len;
    for (const notes of [loop.notes, layer]) {
      for (const tn of notes) {
        if (tn.t >= local && tn.t < local + 1) this.schedule(tn, tn.t - local, tn.d, later);
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
    for (const ev of this.queue) {
      if (!ev.sounding) continue;
      const note = ev.note;
      if (ringOutNotes) {
        this.zone.ringOutAfterTicks(note.number, Math.max(0, ev.offAt - this.elapsed), () =>
          this.send(MIDI.MESSAGE.NOTE_OFF, note)
        );
      } else {
        this.send(MIDI.MESSAGE.NOTE_OFF, note);
      }
    }
    this.queue.length = 0;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
    // their expression stays where it is while notes ring out, then comes to rest (they stay
    // listed until then, so a panic or undo meanwhile still reaches them)
    for (const v of this.voices) {
      if (v.slot < 0 || !ringOutNotes) this.endVoice(v);
      else if (!v.frozen) {
        v.frozen = true;
        setTimeout(() => this.endVoice(v), Math.max(0, this.zone.ringOutMs(v.endAt - this.elapsed)));
      }
    }
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
