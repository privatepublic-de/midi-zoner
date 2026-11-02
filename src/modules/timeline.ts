/**
 * Song position for the track view: the last clock tick and when it came, so the
 * view can scroll smoothly between ticks, plus what each zone sent (NoteHistory).
 * Positions are in clock ticks (24 per quarter) since Start.
 */
const timeline = {
  running: false,
  pos: 0, // last tick
  at: 0, // performance.now() of the last tick
  intervalMs: 0,
  stopPos: 0, // where the last run ended
  run: 0 // counts runs from position 0 (Start); Continue keeps the run
};

function timelineClock(pos: number, tickIntervalMs: number): void {
  if (pos === 0) timeline.run++;
  timeline.pos = pos;
  timeline.at = performance.now();
  if (tickIntervalMs > 0) timeline.intervalMs = tickIntervalMs;
}

function timelineTransport(started: boolean): void {
  if (!started && timeline.running) timeline.stopPos = nowTick();
  timeline.at = performance.now();
  timeline.running = started;
}

/** The current position with the part of a tick since the last one; holds when ticks pause */
function nowTick(): number {
  if (!timeline.running) return timeline.stopPos;
  if (timeline.intervalMs <= 0) return timeline.pos;
  return timeline.pos + Math.min(1, (performance.now() - timeline.at) / timeline.intervalMs);
}

interface HistoryNote {
  pitch: number;
  velo: number;
  start: number;
  end: number | null; // null while sounding
}

/** The notes a zone sent during the current run (a new run starts empty) */
class NoteHistory {
  static MAX = 512;
  private _notes: HistoryNote[] = [];
  private run = 0;

  get notes(): HistoryNote[] {
    if (this.run !== timeline.run) {
      this._notes = [];
      this.run = timeline.run;
    }
    return this._notes;
  }

  noteOn(pitch: number, velo: number): void {
    if (!timeline.running) return;
    this.noteOff(pitch);
    this.notes.push({ pitch, velo, start: nowTick(), end: null });
    if (this._notes.length > NoteHistory.MAX) this._notes.splice(0, this._notes.length - NoteHistory.MAX);
  }

  noteOff(pitch: number): void {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.pitch === pitch && n.end === null) {
        n.end = Math.max(n.start, nowTick());
        return;
      }
    }
  }

  closeAll(): void {
    const t = nowTick();
    for (const n of this.notes) if (n.end === null) n.end = Math.max(n.start, t);
  }
}

export { timeline, timelineClock, timelineTransport, nowTick, NoteHistory, HistoryNote };
