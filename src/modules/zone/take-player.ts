import MIDI from '../midi';
import { Note } from './note';
import { Take } from './take';
import type { TakeNoteJSON } from './interfaces';
import type { Zone } from './zone-class';

interface Scheduled {
  note: Note;
  onAt: number; // ticks since the section began (fractional): a loop's jump can't strand a note-off
  offAt: number;
  sounding: boolean;
  releasing: boolean;
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
    return later;
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
    this.queue.push(ev);
    later(ahead, () => {
      ev.sounding = true;
      this.send(MIDI.MESSAGE.NOTE_ON, note);
      // a note shorter than the rest of this tick ends before the next one
      if (ev.offAt < elapsed + 1 && !ev.releasing) {
        ev.releasing = true;
        later(ev.offAt - ev.onAt, () => this.end(ev));
      }
    });
  }

  /** `elapsed`: ticks since the section began; the song position follows from it (loop) */
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
  }

  private end(ev: Scheduled): void {
    const index = this.queue.indexOf(ev);
    if (index === -1) return;
    this.queue.splice(index, 1);
    // A later note of the same pitch has taken over; its own note-off ends it
    const retriggered = this.queue.some((o) => o.sounding && o.note.number === ev.note.number && o.onAt > ev.onAt);
    if (ev.sounding && !retriggered) this.send(MIDI.MESSAGE.NOTE_OFF, ev.note);
  }

  private send(status: number, note: Note): void {
    const msg = Uint8Array.from([status + note.channel, note.number, status === MIDI.MESSAGE.NOTE_ON ? note.velo : 0]);
    this.zone.handleMidi(status, msg, true);
  }
}
