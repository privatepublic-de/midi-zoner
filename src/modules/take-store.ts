import { Take, takeNote } from './zone/take';
import { Meter, DEFAULT_METER, barTicks } from './meter';
import type { TakeNoteJSON, NoteCurveJSON } from './zone/interfaces';
import { updateCurves } from './zone/note-curve';
import type { CurveBuilder } from './zone/note-curve';
import { GestureRecorder, cutGestures } from './zone/gestures';

/**
 * Takes: every run (Start → Stop) records what is played into each zone; when it ends,
 * that is the zone's newest take. They are kept per zone id, apart from the scene data:
 * undo snapshots and localStorage don't carry them (they can grow to megabytes), so
 * undoing a zone's delete or a Load finds them again under its id. They're saved in a
 * file of their own (app.ts) and in scene and zone files.
 *
 * Positions are run ticks (0 = Start); a take holds the run's sections (where each
 * arrangement began, and its meter), so its bars line up as played.
 */

export const MAX_TAKES = 16;

interface Recording {
  /** cb: the key's expression while it's still coming in (MPE) */
  notes: (TakeNoteJSON & { open: boolean; cb?: CurveBuilder })[];
  /** The zone channel's gestures (sustain, wheels; zone/gestures.ts), run ticks */
  g: GestureRecorder;
}

// a take rolls over into a new one before it would reach a take's limits (notes, length)
const ROLL_NOTES = Take.MAX_NOTES - 16;
const ROLL_LENGTH = Take.MAX_LENGTH - 16 * 96;

class TakeStore {
  private byZone = new Map<string, Take[]>();
  private recording = new Map<string, Recording>();
  private sections: { t: number; meter: Meter }[] = [];
  private startedAt = 0;
  private shown = new Map<string, number>();
  private running = false;
  // the latest position a note came at (where a run that never saw Stop ended)
  private lastAt = 0;
  /** Counts changes, so what's saved can tell it's out of date */
  version = 0;
  onChange: (() => void) | null = null;

  private changed(): void {
    this.version++;
    this.onChange?.();
  }

  /** Start: a new run, its first section in this meter (a run still open ends first: Continue without Stop) */
  startRun(meter: Meter): void {
    if (this.running) this.endRun(this.lastAt);
    this.running = true;
    this.recording.clear();
    this.sections = [{ t: 0, meter }];
    this.startedAt = Date.now();
  }

  /** An arrangement was entered at run tick `t`, in its meter */
  section(t: number, meter: Meter): void {
    if (!this.running) return;
    const last = this.sections[this.sections.length - 1];
    if (last && last.t === t) last.meter = meter;
    else this.sections.push({ t, meter });
  }

  /** Returns the recorded note (null while not running), so its expression can follow */
  noteOn(zoneId: string, t: number, n: number, v: number): { x?: NoteCurveJSON; cb?: CurveBuilder } | null {
    if (!this.running) return null;
    this.lastAt = Math.max(this.lastAt, t);
    const rec = this.recordingFor(zoneId);
    // a very long run: what was played so far becomes a take, recording goes on in a new one
    if (rec.notes.length > 0 && (rec.notes.length >= ROLL_NOTES || t - rec.notes[0].t >= ROLL_LENGTH)) {
      this.finish(zoneId, rec, t);
      rec.g.prune(t);
      this.changed();
    }
    this.noteOff(zoneId, t, n);
    const note: Recording['notes'][number] = { t, d: 0, n, v, open: true };
    rec.notes.push(note);
    return note;
  }

  private recordingFor(zoneId: string): Recording {
    let rec = this.recording.get(zoneId);
    if (!rec) {
      rec = { notes: [], g: new GestureRecorder() };
      this.recording.set(zoneId, rec);
    }
    return rec;
  }

  /** A channel gesture (a control's new value) at run tick t */
  gesture(zoneId: string, t: number, key: string, value: number): void {
    if (!this.running) return;
    this.lastAt = Math.max(this.lastAt, t);
    this.recordingFor(zoneId).g.add(key, t, value);
  }

  /** The run starts at tick t with these values held (a pedal down at Start is down in the take) */
  holdGestures(zoneId: string, t: number, values: Map<string, number>): void {
    if (!this.running) return;
    this.recordingFor(zoneId).g.restart(t, values);
  }

  /** A key's expression is finished: the zone's newest take (if it got the note before) catches up */
  updateCurves(zoneId: string, builder: CurveBuilder, curve: NoteCurveJSON): void {
    const take = this.byZone.get(zoneId)?.at(-1);
    if (take && updateCurves(take.notes, builder, curve) > 0) this.changed();
  }

  noteOff(zoneId: string, t: number, n: number): void {
    this.lastAt = Math.max(this.lastAt, t);
    const notes = this.recording.get(zoneId)?.notes;
    if (!notes) return;
    for (let i = notes.length - 1; i >= 0; i--) {
      if (notes[i].open && notes[i].n === n) {
        notes[i].open = false;
        notes[i].d = Math.max(0.25, t - notes[i].t);
        return;
      }
    }
  }

  /** Stop at run tick `end`: each zone's recording becomes its newest take */
  endRun(end: number): void {
    if (!this.running) return;
    this.running = false;
    let any = false;
    this.recording.forEach((rec, zoneId) => {
      if (rec.notes.length === 0) return;
      this.finish(zoneId, rec, end);
      any = true;
    });
    this.recording.clear();
    this.lastAt = 0;
    if (any) this.changed();
  }

  /**
   * A recording ends at run tick `end` and becomes the zone's newest take: from the bar
   * of its first note (in the run's bars) to the bar line after its end
   */
  private finish(zoneId: string, rec: Recording, end: number): void {
    const run = new Take();
    run.sections = this.sections.map((s) => ({ t: s.t, meter: s.meter }));
    const from = run.barLine(rec.notes[0].t, 'floor');
    const take = new Take();
    take.start = 0;
    take.offset = 0;
    take.at = this.startedAt;
    take.runOffset = from;
    take.seq = ++Take.counter;
    // the sections from the one the take starts in, counted from its start
    const first = run.sectionAt(from);
    take.sections = [{ t: 0, meter: first.meter }, ...run.sections.filter((s) => s.t > from).map((s) => ({ t: s.t - from, meter: s.meter }))];
    take.notes = rec.notes.map((n) =>
      takeNote({ ...n, x: n.cb?.curve() ?? n.x }, n.t - from, n.open ? Math.max(0.25, end - n.t) : n.d)
    );
    // up to the bar line after its end (at least past the last note)
    const last = Math.max(end - from, ...take.notes.map((n) => n.t + n.d));
    take.length = Math.min(Take.MAX_LENGTH, Math.max(take.barLine(last, 'ceil'), barTicks(first.meter)));
    take.g = cutGestures(rec.g.gestures(), from, from + take.length, from);
    take.sort();
    this.add(zoneId, take);
    this.shown.set(zoneId, 0);
    rec.notes = [];
  }

  /**
   * What's being recorded into a zone (run ticks; held notes up to `now`), null when
   * nothing; with `from`, only notes from there on (and the ones still sounding there)
   */
  recordingOf(zoneId: string, now: number, from = -Infinity): TakeNoteJSON[] | null {
    const rec = this.recording.get(zoneId);
    if (!rec || rec.notes.length === 0) return null;
    const out: TakeNoteJSON[] = [];
    // newest first, back to a while before `from` (notes are in order of their start)
    for (let i = rec.notes.length - 1; i >= 0; i--) {
      const n = rec.notes[i];
      if (n.t < from - 16 * 96) break;
      const d = n.open ? Math.max(0.25, now - n.t) : n.d;
      if (n.t + d >= from) out.push(takeNote(n, n.t, d));
    }
    return out.reverse();
  }

  /** When the run under way began (as its takes' `at`) */
  get runAt(): number {
    return this.startedAt;
  }

  /** The run's sections so far (while running) */
  get runSections(): { t: number; meter: Meter }[] {
    return this.sections.length ? this.sections : [{ t: 0, meter: DEFAULT_METER }];
  }

  /** A zone's takes, oldest first */
  of(zoneId: string): Take[] {
    return this.byZone.get(zoneId) ?? [];
  }

  has(zoneId: string): boolean {
    return this.of(zoneId).length > 0 || this.recording.has(zoneId);
  }

  /** Adds a take (at `index`, else as the newest); the oldest go beyond MAX_TAKES */
  add(zoneId: string, take: Take, index?: number): void {
    const list = [...this.of(zoneId)];
    list.splice(index ?? list.length, 0, take);
    while (list.length > MAX_TAKES) list.shift();
    this.byZone.set(zoneId, list);
    this.changed();
  }

  /** Removes a take; returns where it was (-1: not there) */
  remove(zoneId: string, take: Take): number {
    const list = this.of(zoneId);
    const index = list.indexOf(take);
    if (index < 0) return -1;
    this.byZone.set(zoneId, list.filter((t) => t !== take));
    this.changed();
    return index;
  }

  /** A take changed in place (notes edited) */
  touched(): void {
    this.changed();
  }

  /** Replaces a zone's takes (the saved takes at start) */
  set(zoneId: string, takes: Take[]): void {
    this.byZone.set(zoneId, takes.slice(-MAX_TAKES));
    this.shown.delete(zoneId);
    this.changed();
  }

  /**
   * Adds takes from a file (a scene or zone file) to a zone's: ones it has already (same
   * id) aren't added twice, nothing it had is lost (undoing a Load can't bring takes back)
   */
  merge(zoneId: string, takes: Take[]): void {
    const have = new Set(this.of(zoneId).map((t) => t.id));
    const added = takes.filter((t) => !have.has(t.id));
    if (added.length === 0) return;
    const list = [...this.of(zoneId), ...added].sort((a, b) => (a.at || 0) - (b.at || 0) || a.seq - b.seq);
    this.byZone.set(zoneId, list.slice(-MAX_TAKES));
    this.changed();
  }

  /** Which take is shown: 0 the newest, 1 the one before … */
  shownIndex(zoneId: string): number {
    return Math.min(this.shown.get(zoneId) ?? 0, Math.max(0, this.of(zoneId).length - 1));
  }

  shownTake(zoneId: string): Take | null {
    const list = this.of(zoneId);
    return list.length ? list[list.length - 1 - this.shownIndex(zoneId)] : null;
  }

  /** Flip through a zone's takes: +1 older, -1 newer */
  browse(zoneId: string, step: number): void {
    const count = this.of(zoneId).length;
    this.shown.set(zoneId, Math.max(0, Math.min(count - 1, this.shownIndex(zoneId) + step)));
  }

  show(zoneId: string, take: Take): void {
    const list = this.of(zoneId);
    const index = list.indexOf(take);
    if (index >= 0) this.shown.set(zoneId, list.length - 1 - index);
  }

  /** A zone's takes for a file */
  toJSON(zoneId: string): ReturnType<Take['toJSON']>[] {
    return this.of(zoneId).map((t) => t.toJSON());
  }

  /** Every zone id that has takes */
  zoneIds(): string[] {
    return [...this.byZone.keys()].filter((id) => this.of(id).length > 0);
  }
}

export const takeStore = new TakeStore();
