import { Meter, DEFAULT_METER } from './meter';

/**
 * Song position for the track view: the last clock tick and when it came, so the
 * view can scroll smoothly between ticks, plus what each zone sent (NoteHistory).
 * Run positions are clock ticks (24 per quarter) since Start. All runs of a session
 * lie on one session timeline, each starting on the whole bar after the last one
 * ended, so what was played before a stop stays reachable.
 */
const SESSION_BAR = 96; // 4/4

const timeline = {
  running: false,
  pos: 0, // last tick
  at: 0, // performance.now() of the last tick
  intervalMs: 0,
  stopPos: 0, // where the last run ended
  run: 0, // counts runs from position 0 (Start); Continue keeps the run
  runStart: 0, // session position of the current run's position 0
  nextRunStart: 0, // where the next run will start (stopped: where the playhead waits)
  runStarts: [] as number[], // session positions of every run's start
  // Run position where the current arrangement's song began: 0 at Start, the switch
  // position when an arrangement is entered while running (its song starts at bar 1)
  sectionStart: 0,
  // Counting in before Start: the last count-in tick (negative, -1 just before Start), else null
  countIn: null as number | null,
  // The current arrangement's meter (its song's bars and beats)
  meter: DEFAULT_METER as Meter
};

function timelineClock(pos: number, tickIntervalMs: number): void {
  if (pos === 0) {
    timeline.run++;
    timeline.sectionStart = 0;
    timeline.runStart = timeline.nextRunStart;
    timeline.runStarts.push(timeline.runStart);
  }
  timeline.pos = pos;
  timeline.at = performance.now();
  if (tickIntervalMs > 0) timeline.intervalMs = tickIntervalMs;
}

function timelineTransport(started: boolean): void {
  if (!started && timeline.running) {
    timeline.stopPos = nowTick();
    const end = timeline.runStart + timeline.stopPos;
    timeline.nextRunStart = Math.max(timeline.nextRunStart, Math.ceil(end / SESSION_BAR) * SESSION_BAR);
  }
  timeline.at = performance.now();
  timeline.running = started;
  timeline.countIn = null;
}

/** The current arrangement's meter; set before an arrangement's song starts, so a take ends in its own */
function timelineMeter(meter: Meter): void {
  timeline.meter = meter;
}

/** A count-in tick (negative positions before Start), null: the count-in was cancelled */
function timelineCountIn(pos: number | null, tickIntervalMs: number): void {
  timeline.countIn = pos;
  timeline.at = performance.now();
  if (tickIntervalMs > 0) timeline.intervalMs = tickIntervalMs;
}

/** Counting in: how far Start is ahead (negative ticks, with the part of a tick since the last), else null */
function countInNow(): number | null {
  if (timeline.countIn === null) return null;
  const part = timeline.intervalMs > 0 ? Math.min(1, (performance.now() - timeline.at) / timeline.intervalMs) : 0;
  return Math.min(0, timeline.countIn + part);
}

/** The current run position with the part of a tick since the last one; holds when ticks pause */
function nowTick(): number {
  if (!timeline.running) return timeline.stopPos;
  if (timeline.intervalMs <= 0) return timeline.pos;
  return timeline.pos + Math.min(1, (performance.now() - timeline.at) / timeline.intervalMs);
}

/** Now on the session timeline; stopped: where the next run will start */
function sessionNow(): number {
  return timeline.running ? timeline.runStart + nowTick() : timeline.nextRunStart;
}

/** An arrangement was entered at this run position: its song starts there at bar 1 */
function timelineSection(pos: number): void {
  timeline.sectionStart = pos;
}

/** Position in the current arrangement's song (ticks from its bar 1); stopped: where Start begins (bar 1) */
function songNow(): number {
  return timeline.running ? nowTick() - timeline.sectionStart : 0;
}

/** Song position where the last section ended or is now (stopped: where it stopped) */
function songEnd(): number {
  return (timeline.running ? nowTick() : timeline.stopPos) - timeline.sectionStart;
}

/** Where notes released now end: stopped, where the last run ended (ring-outs) */
function releaseAt(): number {
  return timeline.running ? sessionNow() : timeline.runStart + timeline.stopPos;
}

interface HistoryNote {
  pitch: number;
  velo: number;
  start: number;
  end: number | null; // null while sounding
  live?: boolean; // played through from the input (it also shows in the take being recorded)
}

/**
 * The notes a zone sent this session, at session positions, in the order they
 * started (the oldest dropped beyond MAX). Pitch span kept for the lane's rows.
 */
class NoteHistory {
  static MAX = 50000;
  // A note that started this long before a range is still looked at by between()
  static LOOKBACK = 96 * 64;
  notes: HistoryNote[] = [];
  low = 128;
  high = -1;

  /** `keep`: notes that started longer ago than this (ticks) are let go, else up to MAX notes are kept */
  constructor(private readonly keep = Infinity) {}

  /** The notes starting from `lookback` before `from` up to `to` (binary search on start) */
  between(from: number, to: number, lookback = NoteHistory.LOOKBACK): HistoryNote[] {
    const notes = this.notes;
    let lo = 0;
    let hi = notes.length;
    const after = from - lookback;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].start < after) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < notes.length && notes[end].start < to) end++;
    return notes.slice(lo, end);
  }

  noteOn(pitch: number, velo: number, live = false): void {
    if (!timeline.running) return;
    this.noteOff(pitch);
    this.notes.push({ pitch, velo, start: sessionNow(), end: null, live });
    if (pitch < this.low) this.low = pitch;
    if (pitch > this.high) this.high = pitch;
    if (this.notes.length > NoteHistory.MAX) this.notes.splice(0, this.notes.length - NoteHistory.MAX);
    // past `keep`: let go in batches (when the oldest is twice as old), not on every note
    const now = this.notes[this.notes.length - 1].start;
    if (this.notes[0].start < now - 2 * this.keep) {
      const from = now - this.keep;
      let i = 0;
      while (i < this.notes.length && this.notes[i].start < from) i++;
      this.notes.splice(0, i);
    }
  }

  noteOff(pitch: number): void {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i];
      if (n.pitch === pitch && n.end === null) {
        n.end = Math.max(n.start, releaseAt());
        return;
      }
    }
  }

  closeAll(): void {
    const t = releaseAt();
    for (const n of this.notes) if (n.end === null) n.end = Math.max(n.start, t);
  }
}

export { timeline, timelineClock, timelineTransport, timelineSection, timelineCountIn, timelineMeter, countInNow, nowTick, sessionNow, songNow, songEnd, NoteHistory, HistoryNote };
