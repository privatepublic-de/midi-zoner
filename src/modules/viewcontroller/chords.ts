/**
 * Chords zones: a zone set to "Play chords" or "Play bass" (⋯ menu) plays to another zone's
 * line. While running and without its loop playing it follows live (one decision per line,
 * zone/live-chords.ts, so a chords and a bass zone on one line agree); its loop is made of
 * the chords (Loop chip on a chords zone without a loop, or when the line zone closes a loop),
 * and remembers them (`Zone.chordPlan`) for its chord names and for redoing it when a setting
 * changes. The block (`.chords-block` in the zone template) holds Follows, Style, Rhythm, two
 * pads, More and the actions; in the track view it is the dock's Chords tab. In the cards a
 * zone shows only a summary row (`.chords-sum`), its Edit opens the Chords sheet
 * (`#chordsSheet`), which draws a block of its own for the zone it shows, with the line's chords
 * and bass zones as chips in its header.
 */
import { Zone } from '../zone/zone-class';
import { Take } from '../zone/take';
import { Meter, barTicks } from '../meter';
import { PPQ } from '../zone/seq-layer';
import { takeStore } from '../take-store';
import { timeline, nowTick, NoteHistory } from '../timeline';
import { escapeHTML, setRangeValue } from '../domutils';
import { toast } from './toast';
import { harmonize, progress, segmentsOf, chordName, keyName, RHYTHMS, RHYTHM_ORDER, DOTTED, POWER_BELOW, FREE_FROM, LineNote, Chord, Key, HarmonyOptions } from '../zone/harmonize';
import { LiveChords, HeardNote, Follower, Send, heardChords, HEARD_BARS } from '../zone/live-chords';
import { ChordPart, ChordPlan, ChordSettings, DEFAULT_CHORD_SETTINGS, harmonyOptions, loopSig } from '../zone/chord-settings';
import MIDI from '../midi';
import { STYLE_GROUPS, stylesIn, styleById, styleSettings, differsFromStyle } from '../zone/chord-styles';
import { initSheetHeader, setSheetZone } from './editor-sheet';

interface Hooks {
  zones: () => Zone[];
  /** one undo step changing the zones at `indices` */
  commit: (indices: number[], label: string, change: () => void) => void;
  meter: () => Meter;
}

let hooks: Hooks;

// ------------------------------------------------------------------------------ zones

/** The zone a chords zone follows (null: none or gone) */
export function lineZoneOf(zone: Zone): Zone | null {
  if (!zone.chords) return null;
  return hooks.zones().find((z) => z.id === zone.chords!.follows && z !== zone && !z.chords) ?? null;
}

/** The chords and bass zones following `line`: chords first (their settings choose the chords) */
function followersOf(line: Zone): Zone[] {
  const zs = hooks.zones();
  return zs
    .filter((z) => z.chords && z.chords.follows === line.id && z !== line)
    .sort((a, b) => Number(a.chords!.part === 'bass') - Number(b.chords!.part === 'bass') || zs.indexOf(a) - zs.indexOf(b));
}

/** The zone a chords zone follows, by name: "1 Lead", "Zone 3" */
export function lineLabel(z: Zone): string {
  const i = hooks.zones().indexOf(z);
  return z.label ? `${i + 1} ${z.label}` : `Zone ${i + 1}`;
}

function zoneName(z: Zone): string {
  return z.label || `Zone ${hooks.zones().indexOf(z) + 1}`;
}

/** Who a new chords zone follows: a zone with a loop, else with a sequence, else the first */
function defaultLine(zone: Zone): string {
  const cands = hooks.zones().filter((z) => z !== zone && !z.chords);
  const pick = cands.find((z) => z.loop) ?? cands.find((z) => lineOf(z)) ?? cands[0];
  return pick?.id ?? '';
}

/** The zone's line: its loop, else its melodic sequence, else its shown take */
function lineOf(zone: Zone): { notes: LineNote[]; length: number; anchor: number } | null {
  if (zone.loop && zone.loop.notes.length) {
    return { notes: zone.loop.notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v })), length: zone.loop.length, anchor: zone.looper.anchor };
  }
  const seq = zone.sequence;
  if (!seq.isDrumSequence && seq.steps.some((s) => s && s.notesArray.length)) {
    const ticks = seq.ticks;
    const notes: LineNote[] = [];
    seq.steps.slice(0, seq.length).forEach((s, i) => {
      if (!s) return;
      for (const note of s.notesArray) notes.push({ t: i * ticks, d: Math.max(1, s.length * ticks * s.gateLength), n: note.number, v: note.velo });
    });
    return { notes, length: seq.length * ticks, anchor: 0 };
  }
  const shown = takeStore.shownTake(zone.id);
  if (shown) {
    const vis = shown.visibleNotes();
    if (vis.length) {
      const bar = barTicks(hooks.meter());
      const from = Math.floor(vis[0].s / bar) * bar;
      let end = 0;
      for (const n of vis) end = Math.max(end, n.s + n.d);
      const length = Math.max(bar, Math.ceil((end - from - 6) / bar) * bar);
      return { notes: vis.map((n) => ({ t: n.s - from, d: n.d, n: n.n, v: n.v })).filter((n) => n.t >= 0 && n.t < length), length, anchor: -1 };
    }
  }
  return null;
}

/** The followers of a chords zone's line (empty: none or no line) */
function fellowsOf(z: Zone): Zone[] {
  const line = lineZoneOf(z);
  return line ? followersOf(line) : [];
}

/** The bass zone playing under a chords zone (on the same line), if any; `fs`: the line's followers */
function bassUnder(z: Zone, fs = fellowsOf(z)): Zone | null {
  if (z.chords?.part !== 'chords') return null;
  // a bass holding a pedal point doesn't play the roots: the chords keep theirs
  return fs.find((f) => f !== z && f.chords!.part === 'bass' && f.chordSet.pedal !== 1) ?? null;
}

/** A follower's engine options: its settings, the zone's swing, shells over a bass zone; `fs`: the line's followers */
function optionsOf(z: Zone, fs = fellowsOf(z)): HarmonyOptions {
  const o = harmonyOptions(z.chordSet);
  // a second chords zone on the line keeps clear of the first (it doesn't double its notes)
  const lead = fs[0];
  const above = z.chords?.part === 'chords' && lead && lead !== z && lead.chords?.part === 'chords' ? SECOND_CHORDS_ABOVE : 0;
  return { ...o, register: (o.register ?? 0) + above, swing: z.swingAmount, shell: !!bassUnder(z, fs) };
}

/** How far a second chords zone on the same line sits above the first (semitones) */
const SECOND_CHORDS_ABOVE = 5;

// ------------------------------------------------------------------------------ live

/** One decision per followed line (by its zone id) */
const deciders = new Map<string, LiveChords>();
/** After the chords were switched on: the line's notes before this (session position) aren't heard */
const freshFrom = new Map<string, number>();

/** The clock's tick, for notes sent a little into it (strums) */
let tickMs = 20;
/** Note-ons waiting a few ms (a strum), by zone and pitch: a note-off sent now cancels them (nothing hangs) */
const waiting = new Map<string, ReturnType<typeof setTimeout>>();

const send: Send = (out, on, n, v, delay = 0) => {
  const zone = out as Zone;
  const key = `${zone.id}:${n}`;
  const now = () => {
    const status = on ? MIDI.MESSAGE.NOTE_ON : MIDI.MESSAGE.NOTE_OFF;
    zone.handleMidi(status, Uint8Array.from([status, n, on ? v : 0]), true);
  };
  const ms = delay * tickMs;
  if (!on && ms < 1) {
    const w = waiting.get(key);
    if (w !== undefined) {
      // its note-on hasn't gone out yet: it won't
      clearTimeout(w);
      waiting.delete(key);
      return;
    }
  }
  if (ms < 1) {
    now();
    return;
  }
  const timer = setTimeout(() => {
    if (waiting.get(key) === timer) waiting.delete(key);
    now();
  }, ms);
  if (on) waiting.set(key, timer);
};

/** Plays live: switched on, and its loop isn't playing */
function playsLive(z: Zone): boolean {
  return !!z.chords && z.chordsOn && !(z.loop && z.loopOn);
}

/** The line as played, at song positions: what is played into the zone (also muted) and what its loop and sequence play */
function heard(line: Zone, songPos: number, meter: Meter): HeardNote[] {
  const offset = timeline.runStart + timeline.sectionStart;
  const now = offset + songPos;
  const from = Math.max(now - HEARD_BARS * barTicks(meter), offset, freshFrom.get(line.id) ?? -Infinity);
  const take = (h: NoteHistory, played: boolean) =>
    h
      .between(from, now + 1, 0)
      .filter((n) => n.start >= from && (played || !n.live))
      .map((n) => ({ s: n.start - offset, d: Math.max(1, (n.end ?? now) - n.start), n: n.pitch, v: n.velo, held: n.end === null }));
  return [...take(line.inputHistory, true), ...take(line.noteHistory, false)].sort((a, b) => a.s - b.s);
}

/** The line's take playing along while it sounds (its loop hasn't taken over): its notes are known ahead */
function takeAhead(line: Zone, pos: number): Take | null {
  const take = line.playingTake;
  if (!take || take.length <= 0 || !timeline.running) return null;
  if (line.loop && line.loopOn && pos - timeline.sectionStart >= line.looper.anchor) return null;
  return take;
}

/**
 * The notes of the line's take playing along still to come, from run tick `pos` (this tick's
 * own too: the zones play it after the chords) a bar and a beat ahead, at song positions;
 * null when it plays none (then the chords are guessed as for keys played)
 */
function ahead(line: Zone, pos: number, meter: Meter): HeardNote[] | null {
  const take = takeAhead(line, pos);
  if (!take) return null;
  const len = take.length;
  const end = take.offset + len;
  const until = pos + barTicks(meter) + PPQ;
  const anchor = line.takeAnchor;
  const out: HeardNote[] = [];
  // cycle by cycle from the one playing (run ticks), as the take player plays it
  for (let c = pos < anchor ? anchor : anchor + Math.floor((pos - anchor) / len) * len; c < until; c += len) {
    for (const n of take.notes) {
      if (n.t < take.offset) continue;
      if (n.t >= end) break;
      const at = c + n.t - take.offset;
      if (at < pos) continue;
      if (at >= until) break;
      out.push({ s: at - timeline.sectionStart, d: Math.max(1, Math.min(n.d, end - n.t)), n: n.n, v: n.v, held: false });
    }
  }
  return out;
}

/** Every clock tick (run position): the live chords */
export function chordsTick(pos: number, tickIntervalMs = 0): void {
  if (!hooks) return;
  if (tickIntervalMs > 0) tickMs = tickIntervalMs;
  const zs = hooks.zones();
  const meter = hooks.meter();
  const songPos = pos - timeline.sectionStart;
  // lines someone follows (live or not: a loop kept later wants the chords heard)
  const followed = new Set<string>();
  for (const line of zs) {
    if (line.chords) continue;
    const all = followersOf(line);
    if (!all.length) continue;
    followed.add(line.id);
    const fs = all.filter(playsLive);
    let d = deciders.get(line.id);
    if (!fs.length) {
      if (d) d.stop(send);
      continue;
    }
    if (!d) deciders.set(line.id, (d = new LiveChords()));
    const followers: Follower[] = fs.map((z) => ({ id: z.id, part: z.chords!.part, o: optionsOf(z, all), out: z }));
    let notes: HeardNote[] | null = null;
    d.tick(songPos, () => (notes ??= heard(line, songPos, meter)), followers, meter, send, () => ahead(line, pos, meter));
  }
  // lines gone or followed by nobody: their decisions go
  for (const [id, d] of deciders) {
    if (followed.has(id)) continue;
    d.stop(send);
    deciders.delete(id);
  }
  for (const id of freshFrom.keys()) if (!followed.has(id)) freshFrom.delete(id);
  chipsNextFrame();
}

let chipFrame = 0;

/** The chips and status lines follow on the next frame (once per frame, not on every tick) */
function chipsNextFrame(): void {
  if (chipFrame) return;
  chipFrame = requestAnimationFrame(() => {
    chipFrame = 0;
    updateChordChips();
  });
}

/** Start, Stop, an arrangement switch: live chords start over (the key stays, the chords heard go) */
export function chordsTransport(): void {
  for (const d of deciders.values()) {
    d.stop(send);
    d.log.clear();
  }
  updateChordChips();
}

/** The clock paused (the run goes on): live chords let go and come in again with the ticks; what was heard stays */
export function chordsPause(): void {
  for (const d of deciders.values()) d.stop(send);
  updateChordChips();
}

/** Panic: the synths were reset */
export function chordsPanic(): void {
  for (const d of deciders.values()) d.forget();
  for (const w of waiting.values()) clearTimeout(w);
  waiting.clear();
}

/** Switched on: the line's decider starts fresh (a new key, listening from now) */
function freshStart(line: Zone): void {
  const d = deciders.get(line.id);
  if (d) d.reset(send);
  freshFrom.set(line.id, timeline.running ? timeline.runStart + nowTick() : -Infinity);
}

// ------------------------------------------------------------------------------ loops

function loopOf(notes: LineNote[], length: number): Take {
  const take = new Take();
  take.start = 0;
  take.length = length;
  take.notes = notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v })).sort((a, b) => a.t - b.t);
  return take;
}

/** A plan still matching its loop (the loop's notes weren't edited another way) */
function planOf(zone: Zone): ChordPlan | null {
  const p = zone.chordPlan;
  return p && zone.loop && p.sig === loopSig(zone.loop) && p.length === zone.loop.length ? p : null;
}

/** Loop signatures worked out in this task (a frame's chips and lanes ask several times per zone) */
let sigs: WeakMap<Take, number> | null = null;

/**
 * planOf() for showing (chips, status, lane names): the loop's signature is worked out once per
 * task (a loop's notes can be edited in place, so it isn't kept longer). Decisions use planOf()
 */
function shownPlanOf(zone: Zone): ChordPlan | null {
  const p = zone.chordPlan;
  const loop = zone.loop;
  if (!p || !loop || p.length !== loop.length) return null;
  if (!sigs) {
    sigs = new WeakMap();
    queueMicrotask(() => (sigs = null));
  }
  let sig = sigs.get(loop);
  if (sig === undefined) sigs.set(loop, (sig = loopSig(loop)));
  return p.sig === sig ? p : null;
}

/** The decision settings: the lead zone's (the first chords zone on the line) */
function leadOf(line: Zone): ChordSettings {
  return followersOf(line)[0]?.chordSet ?? DEFAULT_CHORD_SETTINGS;
}

/** Writes a follower's loop from a plan (inside a commit) */
function renderLoop(z: Zone, src: { notes: LineNote[]; length: number }, plan: { key: Key; chords: (Chord | null)[]; length: number }, lead: ChordSettings, anchor: number): void {
  const o = {
    ...optionsOf(z),
    harmony: lead.harmony,
    changes: lead.changes,
    seed: lead.seed,
    frozen: plan.chords,
    key: plan.key
  };
  const acc = harmonize(src.notes, src.length, hooks.meter(), o);
  const notes = z.chords!.part === 'bass' ? acc.bass : acc.notes;
  z.loop = loopOf(notes, src.length);
  z.loopOn = true;
  z.loopPlayer.release(true);
  z.looper.anchor = anchor;
  z.chordPlan = { key: acc.progression.key, length: src.length, chords: acc.progression.chords, sig: loopSig(z.loop) };
}

/** Where a chord loop's bar 1 goes: with the line's loop; a take lines up at the next bar */
function anchorFor(src: { anchor: number }): number {
  if (src.anchor >= 0) return src.anchor;
  if (!timeline.running) return 0;
  const bar = barTicks(hooks.meter());
  return Math.ceil((nowTick() - timeline.sectionStart) / bar) * bar;
}

/**
 * The line's chords as loops of its followers (`which`; one undo step). `fromLive`: the chords
 * heard while it played are kept; `fresh`: chosen anew (Harmony, Chord changes, Other chords), else each
 * keeps its own plan where it has one
 */
function makeLoops(line: Zone, which: Zone[], label: string, fromLive: boolean): boolean {
  const src = lineOf(line);
  if (!src) {
    toast(`${escapeHTML(lineLabel(line))} has no loop or sequence yet: record a loop there first`);
    return false;
  }
  const busy = which.find((z) => z.looper.mode !== 'idle');
  if (busy) {
    toast(`${escapeHTML(zoneName(busy))}: its loop is being recorded, finish that first`);
    return false;
  }
  const meter = hooks.meter();
  const lead = leadOf(line);
  let frozen: (Chord | null)[] | undefined;
  let key: Key | undefined;
  const d = deciders.get(line.id);
  if (fromLive && d && timeline.running) {
    const songNow = nowTick() - timeline.sectionStart;
    frozen = heardChords(d.log, segmentsOf(src.length, meter), src.length, src.anchor >= 0 ? src.anchor : 0, songNow);
    if (!frozen.some((c) => c)) frozen = undefined;
    if (d.key) key = d.key;
  }
  const p = progress(src.notes, src.length, meter, { ...harmonyOptions(lead), ...(frozen ? { frozen } : {}), ...(key ? { key } : {}) });
  const plan = { key: p.key, chords: p.chords as (Chord | null)[], length: src.length };
  const zs = hooks.zones();
  const anchor = anchorFor(src);
  hooks.commit(
    which.map((z) => zs.indexOf(z)),
    label,
    () => which.forEach((z) => renderLoop(z, src, plan, lead, anchor))
  );
  return true;
}

/** Loop chip of a chords zone without a loop: the chords heard (and the rest worked out) become the loop */
export function keepChords(zone: Zone): void {
  const line = lineZoneOf(zone);
  if (!line) {
    toast(`${escapeHTML(zoneName(zone))}: pick the zone it follows first`);
    return;
  }
  // the line's other followers get theirs too, so chords and bass stay together
  makeLoops(line, followersOf(line).filter((z) => z === zone || (z.chordsOn && !planOf(z))), 'Keep Chords', true);
}

/** The line zone recorded or overdubbed its loop (an undo step already): its followers' chords become loops */
export function chordsLineLoopChanged(line: Zone): void {
  if (!hooks || line.chords) return;
  // followers set to follow live (their loop off) or with a loop edited by hand keep theirs
  const fs = followersOf(line).filter((z) => z.chordsOn && (!z.loop || (z.loopOn && planOf(z))));
  if (fs.length) makeLoops(line, fs, 'Chords', true);
}

/** The zone's Swing changed (inside the action's undo step): its loop made of chords is played anew */
export function chordsSwingChanged(zone: Zone): void {
  const line = lineZoneOf(zone);
  const plan = planOf(zone);
  const src = line && lineOf(line);
  if (!zone.chords || !plan || !src || src.length !== plan.length) return;
  renderLoop(zone, src, plan, leadOf(line!), zone.looper.anchor);
}

/** A chords zone's Loop chip switched on again: in step with the line */
export function alignToLine(zone: Zone): void {
  const line = lineZoneOf(zone);
  const src = line && lineOf(line);
  if (src && zone.loop && src.anchor >= 0 && zone.loop.length === src.length) zone.looper.anchor = src.anchor;
}

// ------------------------------------------------------------------------------ role and switch

/** ⋯ menu: Play chords / Play bass (inside the action's undo step) */
export function playChords(zone: Zone, part: ChordPart): void {
  zone.setChordRole({ part, follows: zone.chords?.follows || defaultLine(zone) });
  zone.chordsOn = true;
  // a loop it had (not made of chords) is kept, switched off: the zone follows live
  if (zone.loop && !planOf(zone)) zone.setLoopOn(false);
  const line = lineZoneOf(zone);
  if (line) freshStart(line);
  // which line it took (chosen for you): said once, changed in its settings
  const what = part === 'bass' ? 'a bass line' : 'chords';
  toast(
    line
      ? `${escapeHTML(zoneNumberName(zone))} plays ${what} to ${escapeHTML(lineLabel(line))}`
      : `${escapeHTML(zoneNumberName(zone))} plays ${what}: add a zone to follow, then choose it in its settings`
  );
}

/** ⋯ menu: Stop playing chords: a normal zone again, its Seq and Arp switches back */
export function stopChords(zone: Zone): void {
  zone.setChordRole(null);
}

/** The chip: chords on/off (on: listening anew) */
export function toggleChords(zone: Zone): void {
  zone.setChordsOn(!zone.chordsOn);
  if (zone.chordsOn) {
    const line = lineZoneOf(zone);
    if (line && !followersOf(line).some((z) => z !== zone && playsLive(z))) freshStart(line);
  }
}

/** ⋯ menu entries for a zone */
export function chordsMenu(index: number): string[] {
  const zone = hooks?.zones()[index];
  if (!zone) return [];
  if (zone.chords) return [...(zone.loop ? [`${index}:zone_chords_clear`] : []), `${index}:zone_chords_stop`];
  // a zone others follow can't follow itself
  if (hooks.zones().some((z) => z.chords?.follows === zone.id)) return [];
  return [`${index}:zone_chords_play:chords`, `${index}:zone_chords_play:bass`];
}

// ------------------------------------------------------------------------------ chip and lanes

/** The chord sounding (or, stopped, the loop's first one) */
function chordNow(zone: Zone): string {
  const line = lineZoneOf(zone);
  const plan = shownPlanOf(zone);
  if (zone.loop && zone.loopOn && plan) {
    let at = 0;
    if (timeline.running) {
      const songNow = nowTick() - timeline.sectionStart;
      at = (((songNow - zone.looper.anchor) % plan.length) + plan.length) % plan.length;
    }
    const segs = segmentsOf(plan.length, hooks.meter());
    const i = segs.findIndex((s) => at >= s.t && at < s.end);
    const c = plan.chords[Math.max(0, i)];
    if (c) return chordName(c);
  }
  if (timeline.running && line && zone.chordsOn && playsLive(zone)) {
    const d = deciders.get(line.id);
    if (d?.chord) return chordName(d.chord);
  }
  // nothing sounding: what the zone plays
  return zone.chords?.part === 'bass' ? 'Bass' : 'Chords';
}

/** Whether a zone chooses the chords of its line (the first chords zone on it), else who does */
function leaderOf(zone: Zone): Zone | null {
  const line = lineZoneOf(zone);
  return line ? followersOf(line)[0] ?? null : null;
}

/**
 * Finish, Open end and Play on, for the block's actions (all, hidden: `showEnds()` shows them) and a
 * followed zone's card row (only those `shown`); `cls`: their look
 */
function endsHtml(cls: string, shown?: 'finish' | 'playon'): string {
  const all = [
    { end: 'closed', label: 'Finish', title: 'End with a cadence from the next bar line (IV, V7) and the key’s chord held out, then stay silent while the clock runs on: every chords and bass zone following the same zone' },
    { end: 'open', label: 'Open end', title: 'End open from the next bar line: a bar of IV, then the V held out, unresolved; then stay silent while the clock runs on: every chords and bass zone following the same zone' },
    { end: 'on', label: 'Play on', title: 'Play on: back to following live from the next beat' }
  ];
  return all
    .filter((a) => !shown || (a.end === 'on') === (shown === 'playon'))
    .map((a) => `<a class="${cls} cb-finish" data-end="${a.end}" title="${a.title}"${shown ? '' : ' hidden'}>${a.label}</a>`)
    .join('');
}

/** Which of Finish / Open end / Play on show for a line now: none while stopped or nothing plays live */
function endsShown(line: Zone | null): 'finish' | 'playon' | null {
  if (!line || !timeline.running) return null;
  const d = deciders.get(line.id);
  if (!d) return null;
  return d.finished || d.finishing ? 'playon' : 'finish';
}

function showEnds(root: ParentNode, line: Zone | null): void {
  const shown = endsShown(line);
  root.querySelectorAll<HTMLElement>('.cb-finish').forEach((a) => {
    const on = a.dataset.end === 'on' ? shown === 'playon' : shown === 'finish';
    if (a.hidden === on) a.hidden = !on;
  });
}

/**
 * Finish (`open`: ending on the V) or, while an ending is under way or done, Play on: for all
 * chords and bass zones following the line, live (a chord loop playing goes on)
 */
function finishLine(line: Zone, end: 'closed' | 'open' | 'on'): void {
  const d = deciders.get(line.id);
  const fs = followersOf(line);
  if (!d || !timeline.running) {
    toast('Finish works while the chords play live');
    return;
  }
  if (end === 'on' || d.finished || d.finishing) {
    d.playOn();
    toast(`${escapeHTML(followerNames(fs))} play on`);
  } else {
    const meter = hooks.meter();
    const final = d.finish(nowTick() - timeline.sectionStart, meter, send, end === 'open');
    toast(
      final === null
        ? `${escapeHTML(followerNames(fs))} stop: nothing heard yet to end on`
        : `${escapeHTML(followerNames(fs))} ${end === 'open' ? 'end open' : 'finish'}: the last chord at bar ${Math.round(final / barTicks(meter)) + 1}`
    );
  }
  fs.forEach((z) => showStatus(z));
  updateFollowRows();
}

/** The status line of a chords zone's block: what it does now, in words, and a dot (live, loop, waiting) */
function statusOf(zone: Zone): { dot: 'live' | 'loop' | 'wait'; main: string; more: string[]; tag: string } {
  const st = statusSentence(zone);
  return { ...st, tag: tagOf(zone, st.dot) };
}

/** The status in two or three words, for the tag at the end of the Follows row */
function tagOf(zone: Zone, dot: 'live' | 'loop' | 'wait'): string {
  const line = lineZoneOf(zone);
  if (!line) return 'follows nothing';
  if (!zone.chordsOn) return 'off';
  // the loop's key while it plays, else the key heard live
  const plan = zone.loop && zone.loopOn ? shownPlanOf(zone) : null;
  const key = plan?.key ?? deciders.get(line.id)?.key;
  if (dot === 'loop') return `its loop · ${Take.lengthLabel(zone.loop!.length, hooks.meter())}`;
  if (!timeline.running) return 'waiting';
  const d = deciders.get(line.id);
  if (d?.finished) return 'finished';
  if (d?.finishing) return d.finishing === 'open' ? 'ending open' : 'finishing';
  if (!key) return 'listening…';
  // the line rests: the combo plays on, looser, waiting for it
  if (d?.waiting) return `waits for you · ${keyName(key)}`;
  return `live · ${keyName(key)}`;
}

function statusSentence(zone: Zone): { dot: 'live' | 'loop' | 'wait'; main: string; more: string[] } {
  const line = lineZoneOf(zone);
  if (!line) return { dot: 'wait', main: 'Not following a zone yet', more: ['choose one in its settings'] };
  const leader = leaderOf(zone);
  const from = leader && leader !== zone ? [`chords from ${zoneNumberName(leader)}`] : [];
  const plan = zone.loop && zone.loopOn ? shownPlanOf(zone) : null;
  const d = deciders.get(line.id);
  const key = plan?.key ?? d?.key;
  const keyText = key ? [`key ${keyName(key)}`] : [];
  if (!zone.chordsOn) return { dot: 'wait', main: 'Switched off', more: ['the chip in its header switches it on'] };
  if (zone.loop && zone.loopOn) {
    return {
      dot: 'loop',
      main: `Playing its loop (${Take.lengthLabel(zone.loop.length, hooks.meter())})`,
      // its loop holds the chords it kept (not necessarily the leading zone's now)
      more: ['Loop off: follow live', ...keyText]
    };
  }
  const label = lineLabel(line);
  if (!timeline.running) {
    return { dot: 'wait', main: 'Waiting for the clock', more: [`plays to ${label} while it runs`, ...(zone.loop ? ['its loop is kept, switched off'] : [])] };
  }
  if (d?.finished) return { dot: 'wait', main: 'Finished', more: ['silent while the clock runs on', 'Play on, Stop or Start bring it back'] };
  if (d?.finishing) {
    return { dot: 'live', main: d.finishing === 'open' ? 'Ending open: IV, then the V held out' : 'Finishing: a cadence, then the key’s chord held out', more: ['Play on cancels'] };
  }
  if (!d?.key) return { dot: 'live', main: `Listening to ${label}`, more: ['chords come in once it has heard a few notes'] };
  const under = bassUnder(zone);
  const shells = under ? [`rootless over ${zoneNumberName(under)}`] : [];
  const take = takeAhead(line, nowTick());
  const reads = take ? [`reads its Take ${takeStore.of(line.id).indexOf(take) + 1} a bar ahead`] : [];
  const rests = d.waiting > 0 ? [`plays on, looser, while ${label} rests`] : [];
  return { dot: 'live', main: `Following ${label} live`, more: [...rests, ...from, ...reads, ...shells, ...(zone.loop ? [] : ['Loop keeps these chords']), ...keyText] };
}

/** "2 E-Piano" */
function zoneNumberName(z: Zone): string {
  const i = hooks.zones().indexOf(z);
  return z.label ? `${i + 1} ${z.label}` : `Zone ${i + 1}`;
}

/** The status line, written only when it changed */
function showStatus(zone: Zone): void {
  for (const b of blocksOf(zone)) if (b) showEnds(b, lineZoneOf(zone));
  const els = [...blocksOf(zone), summaryOf(zone)].map((b) => b?.querySelector<HTMLElement>('.cb-status')).filter((e): e is HTMLElement => !!e);
  if (!els.length) return;
  const st = statusOf(zone);
  const key = `${st.dot}|${st.tag}|${st.main}|${st.more.join('|')}`;
  for (const el of els) {
    if (el.dataset.key === key) continue;
    el.dataset.key = key;
    // the tag: a dot and a few words; the whole sentence in its tooltip
    el.title = [st.main, ...st.more].join(' · ');
    el.innerHTML = `<span class="cb-dot-state ${st.dot}"></span>${escapeHTML(st.tag)}`;
  }
}

/**
 * Start over: the line's chords and bass zones forget what they heard (key, chords, notes so far)
 * and listen anew from now; chord loops playing on the line are switched off, kept (one undo step)
 */
function startOver(zone: Zone): void {
  const line = lineZoneOf(zone);
  if (line) startOverLine(line);
}

function startOverLine(line: Zone): void {
  const fs = followersOf(line);
  if (fs.length === 0) return;
  const looping = fs.filter((z) => z.loop && z.loopOn);
  if (looping.find((z) => z.looper.mode !== 'idle')) {
    toast('A loop there is being recorded: finish that first');
    return;
  }
  if (looping.length) {
    const zs = hooks.zones();
    hooks.commit(
      looping.map((z) => zs.indexOf(z)),
      'Start Over',
      () => looping.forEach((z) => z.setLoopOn(false))
    );
  }
  freshStart(line);
  anew.set(line.id, 'listening anew');
  toast(`${escapeHTML(followerNames(fs))} listen anew to ${escapeHTML(lineLabel(line))}`);
  fs.forEach((z) => showStatus(z));
  updateFollowRows();
}

/** Zones as they are on screen (followersOf() puts chords before bass, for the engine) */
function inZoneOrder(fs: Zone[]): Zone[] {
  const zs = hooks.zones();
  return [...fs].sort((a, b) => zs.indexOf(a) - zs.indexOf(b));
}

/** "3 Chords and 4 Bass", in zone order */
function followerNames(fs: Zone[]): string {
  const names = inZoneOrder(fs).map((z) => zoneNumberName(z));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}

// why a followed zone's chords and bass listen anew, until they've heard a key again (zone id → words)
const anew = new Map<string, string>();

/**
 * Take along switched (on, off or to another take) on a zone others follow: they hear different
 * music now, so they forget what they heard and listen anew (chord loops stay as they are)
 */
export function chordsTakeAlongChanged(line: Zone): void {
  const fs = followersOf(line);
  if (fs.length === 0) return;
  freshStart(line);
  const take = line.playingTake;
  const what = take ? `Take ${takeStore.of(line.id).indexOf(take) + 1} plays along` : 'Take along off';
  anew.set(line.id, `listening anew: ${what}`);
  toast(`${escapeHTML(what)} on ${escapeHTML(lineLabel(line))}: ${escapeHTML(followerNames(fs))} listen anew`);
  fs.forEach((z) => showStatus(z));
  updateFollowRows();
}

/**
 * A followed zone's card: "Followed by ● 3 Chords ● 4 Bass · heard D Aeolian  [Start over]"
 * (rebuilt only when what it says changes)
 */
export function updateFollowRows(): void {
  if (!hooks) return;
  hooks.zones().forEach((line) => {
    const el = line.elements?.zoneElement;
    const row = el?.querySelector<HTMLElement>('.card-follow');
    if (!el || !row) return;
    const fs = line.chords ? [] : inZoneOrder(followersOf(line));
    const show = fs.length > 0;
    if (el.classList.contains('has-card-follow') !== show) el.classList.toggle('has-card-follow', show);
    if (!show) return;
    const key = deciders.get(line.id)?.key;
    if (key) anew.delete(line.id);
    const waits = timeline.running && deciders.get(line.id)?.waiting ? ' · waiting for you' : '';
    const dd = deciders.get(line.id);
    const ends = timeline.running && dd ? (dd.finished ? ' · finished' : dd.finishing ? (dd.finishing === 'open' ? ' · ending open' : ' · finishing') : '') : '';
    const status = ends ? ends.slice(3) : key ? `heard ${keyName(key)}${waits}` : anew.get(line.id) ?? (timeline.running ? 'listening…' : '');
    const shown = endsShown(line);
    const colours = fs.map((z) => (z.elements?.zoneElement ? getComputedStyle(z.elements.zoneElement).getPropertyValue('--zone-color').trim() : ''));
    const html =
      '<span class="cf-label">Followed by</span>' +
      fs.map((z, i) => `<span class="cf-who"><span class="cf-dot" style="background:${escapeHTML(colours[i])}"></span>${escapeHTML(zoneNumberName(z))}</span>`).join('') +
      (status ? `<span class="cf-status">· ${escapeHTML(status)}</span>` : '') +
      '<span class="cf-gap"></span>' +
      `<a class="lightButton cf-startover" title="${escapeHTML(`Forget what was heard from ${lineLabel(line)} (key and chords) and listen anew: ${followerNames(fs)}; chord loops playing there are switched off (kept). Switching Take along here does this by itself`)}">Start over</a>` +
      (shown ? endsHtml('lightButton', shown) : '');
    if (row.dataset.html !== html) {
      row.dataset.html = html;
      row.innerHTML = html;
    }
  });
}

/** The chips of chords zones show the chord */
export function updateChordChips(): void {
  if (!hooks) return;
  updateFollowRows();
  hooks.zones().forEach((z) => {
    if (!z.chords) return;
    const chip = z.elements?.zoneElement?.querySelector<HTMLElement>('.channels .showchords');
    if (!chip) return;
    const text = chordNow(z);
    if (chip.textContent !== text) {
      chip.textContent = text;
      chip.classList.toggle('long', text.length > 4);
    }
    showStatus(z);
    renderSummary(z);
    const line = lineZoneOf(z);
    const what = z.chords.part === 'bass' ? 'Bass' : 'Chords';
    const title = !line
      ? `${what} on/off · not following a zone yet (choose one in its settings)`
      : `${what} on/off · follows ${lineLabel(line)}${deciders.get(line.id)?.key ? ' · ' + keyName(deciders.get(line.id)!.key!) : ''}`;
    if (chip.title !== title) chip.title = title;
  });
}

/** Chord names for a zone's lane between song positions: its loop's chords, or the ones played live */
export function chordMarks(zone: Zone, from: number, to: number): { s: number; name: string }[] {
  if (!hooks || !zone.chords) return [];
  const out: { s: number; name: string }[] = [];
  const plan = shownPlanOf(zone);
  if (zone.loop && zone.loopOn && plan) {
    // where the chord changes (the same chord over several beats is one name)
    const segs = segmentsOf(plan.length, hooks.meter());
    const changes: { t: number; name: string }[] = [];
    segs.forEach((seg, i) => {
      const c = plan.chords[i];
      const name = c ? chordName(c) : '';
      if (name && (!changes.length || changes[changes.length - 1].name !== name)) changes.push({ t: seg.t, name });
    });
    // the loop plays from its anchor (bar 1 when stopped), not before
    const anchor = zone.looper.anchor;
    const first = Math.max(0, Math.floor((from - anchor) / plan.length) - 1);
    for (let k = first; anchor + k * plan.length < to; k++) {
      changes.forEach((c, j) => {
        const at = anchor + k * plan.length + c.t;
        // a cycle starts with its first chord's name even when the last one was the same
        if (j === 0 || at >= from) out.push({ s: at, name: c.name });
      });
    }
    return out.filter((m) => m.s < to);
  }
  const line = lineZoneOf(zone);
  const d = line && deciders.get(line.id);
  if (!d) return out;
  // the log is in time order and trimmed (LiveChords.trimLog)
  let last = '';
  const after = from - 4 * barTicks(hooks.meter());
  for (const [s, c] of d.log) {
    if (s >= to) break;
    const name = chordName(c);
    if (name !== last && s >= after) out.push({ s, name });
    last = name;
  }
  return out;
}

// ------------------------------------------------------------------------------ the block


/** The Strum chips (ChordSettings.strum) */
const STRUMS = ['Off', 'Down', 'Up', 'Down & up'];

interface PadSpec {
  name: string;
  x: keyof ChordSettings;
  y: keyof ChordSettings;
  left: string;
  right: string;
  bottom: string;
  top: string;
  title: string;
}

const PADS: Record<ChordPart, PadSpec[]> = {
  chords: [
    { name: 'Chords', x: 'harmony', y: 'colour', left: 'Classic', right: 'Modal', bottom: 'Plain', top: 'Rich', title: 'Which chords: classic (along the circle of fifths) to modal, at the far right free (chords from outside the key); plain triads to rich sevenths and ninths, at the very bottom power chords (double-click: middle)' },
    { name: 'Feel', x: 'length', y: 'bark', left: 'Short', right: 'Long', bottom: 'Soft', top: 'Punchy', title: 'How they are played: short stabs to long and held; even and soft to punchy, the strong hits loud and short (an e-piano\'s barks) over a soft held cushion (double-click: middle)' }
  ],
  bass: [
    { name: 'Line', x: 'bass', y: 'sync', left: 'Roots', right: 'Walking', bottom: 'Straight', top: 'Syncopated', title: 'Which notes and when: the roots held to walking with approach notes and skips; straight to syncopated, with anticipations, off-beats and pickups (double-click: middle, straight)' },
    { name: 'Feel', x: 'length', y: 'vary', left: 'Short', right: 'Long', bottom: 'Tight', top: 'Loose', title: 'How it is played: short to long and held; tight and even to loose, as a player would (double-click: middle)' }
  ]
};

interface SliderSpec {
  k: keyof ChordSettings;
  label: string;
  left: string;
  right: string;
  min?: number;
  max?: number;
  step?: number;
  title: string;
}

const MORE: Record<ChordPart, SliderSpec[]> = {
  chords: [
    { k: 'accents', label: 'Accents', left: 'On-beat', right: 'Off-beat', title: 'Louder on the beat or off it; with Barking up, where the barks fall (middle: the rhythm\'s own strong hits)' },
    { k: 'changes', label: 'Chord changes', left: 'Slow', right: 'Fast', title: 'How often the chord changes; towards Slow, live chords also let passing and off-key notes go by' },
    { k: 'unfold', label: 'Build-up', left: 'Together', right: 'Rolled', title: 'Chords rolled, the 7th and 9th coming in later' },
    { k: 'register', label: 'Register', left: 'Lower', right: 'Higher', min: -12, max: 12, step: 1, title: 'Where the chords sit: semitones down or up (double-click: back to 0)' },
    { k: 'tensions', label: '7th & 9th', left: 'Softer', right: 'Louder', title: 'The 7th, 9th and b5 softer or louder than the triad' },
    { k: 'vary', label: 'Human', left: 'Exact', right: 'Loose', title: 'Velocities vary a little, as a player\'s would' }
  ],
  bass: [
    { k: 'accents', label: 'Accents', left: 'On-beat', right: 'Off-beat', title: 'Louder on the beat or off it' },
    { k: 'harmony', label: 'Harmony', left: 'Fifths', right: 'Modal', title: 'Only when no chords zone follows the same line (that one chooses the chords)' },
    { k: 'changes', label: 'Chord changes', left: 'Slow', right: 'Fast', title: 'How often the chord changes (when no chords zone follows the same line)' }
  ]
};

const MIDDLE: Partial<Record<keyof ChordSettings, number>> = { length: 0.5, accents: 0.5, tensions: 0.5, register: 0, harmony: 0.3, colour: 0.4, bass: 0.5, vary: 0, changes: 0.5, unfold: 0, sync: 0, bark: 0 };

/** The zone's block and, while the Chords sheet shows the zone, the sheet's */
function blocksOf(zone: Zone): HTMLElement[] {
  const own = zone.elements?.zoneElement?.querySelector<HTMLElement>('.chords-block');
  const out = own ? [own] : [];
  if (sheet && isChordsSheetOpen() && sheetZoneId === zone.id) out.push(sheet.querySelector<HTMLElement>('.chords-block')!);
  return out;
}

function inSheet(el: Element): boolean {
  return !!sheet && sheet.contains(el);
}

/** The block's layout (rebuilt only when this changes, never during a drag) */
function layoutKey(zone: Zone): string {
  const zs = hooks.zones();
  return [zone.chords?.part, zone.chords?.follows, leaderOf(zone) === zone, ...zs.map((z) => `${z.id}:${z.label}:${!!z.chords}:${z.chords?.part}`)].join('|');
}

let dragging: HTMLElement | null = null;

/** Draws a zone's block (after every change of the zone) */
export function renderChordBlock(zone: Zone): void {
  if (!zone.chords || !hooks) return;
  renderSummary(zone);
  if (isChordsSheetOpen() && sheetZoneId === zone.id) renderSheetBar();
  for (const el of blocksOf(zone)) drawBlock(zone, el);
  showStatus(zone);
}

function drawBlock(zone: Zone, el: HTMLElement): void {
  if (!zone.chords) return;
  if (dragging && el.contains(dragging)) return;
  const part = zone.chords.part;
  const key = layoutKey(zone);
  if (el.dataset.layout !== key) {
    el.dataset.layout = key;
    el.innerHTML = blockHTML(zone);
  }
  // values
  const s = zone.chordSet;
  el.querySelectorAll<HTMLElement>('.cb-pad').forEach((pad, i) => {
    const spec = PADS[part][i];
    placeDot(pad, s[spec.x] as number, s[spec.y] as number);
    showReadout(pad, spec, s[spec.x] as number, s[spec.y] as number);
  });
  const rs = el.querySelector<HTMLSelectElement>('.cb-rhythm-sel');
  if (rs && document.activeElement !== rs) rs.value = String(s.rhythm);
  el.querySelectorAll<HTMLElement>('.cb-strum a').forEach((a) => a.classList.toggle('on', Number(a.dataset.strum) === s.strum));
  el.querySelectorAll<HTMLElement>('.cb-flags a').forEach((a) => a.classList.toggle('on', s[a.dataset.flag as 'blues' | 'subs'] === 1));
  el.querySelectorAll<HTMLElement>('.cb-pedal a').forEach((a) => a.classList.toggle('on', Number(a.dataset.pedal) === s.pedal));
  const sw = el.querySelector<HTMLInputElement>('input[data-swing]');
  if (sw) setSlider(sw, zone.swingAmount);
  el.querySelectorAll<HTMLInputElement>('.cb-more input[type=range][data-k]').forEach((inp) => {
    setSlider(inp, s[inp.dataset.k as keyof ChordSettings] as number);
  });
  el.querySelectorAll<HTMLElement>('.cb-best').forEach((b) => (b.hidden = !s.seed));
  // the style, marked • once something was changed since
  const sel = el.querySelector<HTMLSelectElement>('.cb-style');
  if (sel && document.activeElement !== sel) {
    const st = styleById(s.style);
    sel.value = st ? st.id : '';
    const changed = differsFromStyle(s, part);
    for (const opt of sel.options) {
      const name = styleById(opt.value)?.name ?? 'No style';
      const text = st && opt.value === st.id && changed ? `${name} •` : name;
      if (opt.textContent !== text) opt.textContent = text;
    }
  }
}

/** A slider's thumb and its filled part; left alone while held */
function setSlider(inp: HTMLInputElement, v: number): void {
  if (!inp.matches(':active')) setRangeValue(inp, v);
}

/** What a pad's settings sound like, in words (the engine's steps) */
const WORDS: Partial<Record<keyof ChordSettings, (v: number) => string>> = {
  harmony: (v) => (v < 0.2 ? 'fifths' : v < 0.4 ? 'mostly fifths' : v < 0.6 ? 'fifths & modal' : v < 0.75 ? 'mostly modal' : v <= FREE_FROM ? 'modal' : 'free'),
  colour: (v) => (v < POWER_BELOW ? 'power chords' : v <= 0.3 ? 'triads' : v <= 0.65 ? '7ths' : '7ths & 9ths'),
  length: (v) => (v < 0.2 ? 'stabs' : v < 0.45 ? 'short' : v < 0.7 ? 'held' : 'legato'),
  bark: (v) => (v < 0.05 ? 'even' : v < 0.5 ? 'some barks' : 'barking'),
  bass: (v) => (v < 0.2 ? 'roots' : v < 0.45 ? 'root & fifth' : v < 0.7 ? 'approach notes' : v < 0.85 ? 'walking' : 'walking with skips'),
  sync: (v) => (v < 0.05 ? 'straight' : v < 0.35 ? 'a little syncopated' : v < 0.65 ? 'syncopated' : 'wild'),
  vary: (v) => (v < 0.05 ? 'exact' : v < 0.5 ? 'a little loose' : 'loose')
};

function showReadout(pad: HTMLElement, spec: PadSpec, x: number, y: number): void {
  const ro = pad.closest('.cb-padbox')?.querySelector<HTMLElement>('.cb-ro');
  if (!ro) return;
  const text = `${WORDS[spec.x]?.(x) ?? ''} · ${WORDS[spec.y]?.(y) ?? ''}`;
  if (ro.textContent !== text) ro.textContent = text;
}

function placeDot(pad: HTMLElement, x: number, y: number): void {
  const dot = pad.querySelector<HTMLElement>('.cb-dot')!;
  const lx = pad.querySelector<HTMLElement>('.cb-x')!;
  const ly = pad.querySelector<HTMLElement>('.cb-y')!;
  const px = x * 100;
  const py = (1 - y) * 100;
  dot.style.left = `${px}%`;
  dot.style.top = `${py}%`;
  // each line from the dot to the pad's middle: how far the setting is from the middle, each way
  lx.style.left = `${px}%`;
  lx.style.top = `${Math.min(py, 50)}%`;
  lx.style.height = `${Math.abs(py - 50)}%`;
  ly.style.top = `${py}%`;
  ly.style.left = `${Math.min(px, 50)}%`;
  ly.style.width = `${Math.abs(px - 50)}%`;
}

/** The block's controls (the cards' sheet and the track view's dock both have room: More is always shown) */
function blockHTML(zone: Zone): string {
  const part = zone.chords!.part;
  const zs = hooks.zones();
  const line = lineZoneOf(zone);
  const cands = zs.filter((z) => z !== zone && !z.chords);
  const options =
    (line ? '' : `<option value="" selected>${zone.chords!.follows ? '⚠ missing' : 'choose a zone'}</option>`) +
    cands.map((z) => `<option value="${escapeHTML(z.id)}"${z === line ? ' selected' : ''}>${escapeHTML(lineLabel(z))}</option>`).join('');
  const what = part === 'bass' ? 'Bass' : 'Chords';
  // a bass zone on a line a chords zone follows: the chords zone chooses the chords
  const leads = leaderOf(zone) === zone || !line;
  const sliders = MORE[part].filter((m) => leads || (m.k !== 'harmony' && m.k !== 'changes'));
  // a chords zone following another one's choice: Classic ↔ Modal is that zone's
  const leader = leaderOf(zone);
  const chosenBy = part === 'chords' && !leads && leader ? zoneNumberName(leader) : '';
  const pads = PADS[part]
    .map((p, i) => {
      const borrowed = chosenBy && i === 0;
      const title = borrowed ? `${p.title}. Classic ↔ Modal here does nothing: ${chosenBy} chooses the chords on this line` : p.title;
      return `
    <div class="cb-padbox" title="${escapeHTML(title)}">
      <div class="cb-pt"><span class="cb-pt-name">${p.name}</span><span class="cb-ro"></span></div>
      <div class="cb-pad" data-pad="${i}">
        <span class="cb-lbl top">${p.top}</span><span class="cb-lbl bottom">${p.bottom}</span>
        <span class="cb-lbl left${borrowed ? ' off' : ''}">${p.left}</span><span class="cb-lbl right${borrowed ? ' off' : ''}">${p.right}</span>
        <div class="cb-x"></div><div class="cb-y"></div><div class="cb-dot"></div></div>
    </div>`;
    })
    .join('');
  const swingRow = `<label class="cb-sl" title="The zone's Swing (the same as in its settings): each beat's second half later; about 67 % is a triplet swing"><span class="label">Swing</span><small>Straight</small>
      <input type="range" data-swing min="0" max="1" step="0.01" tabindex="-1"><small>Swung</small></label>`;
  // Blues 7ths and Jazz subs: two switches in one row (both on: a jazz blues)
  const bluesRow = `<div class="cb-sl" title="Blues 7ths: the key's I, IV and V are dominant seventh chords. Jazz subs: a dominant's tritone substitute (D♭7 for G7), a ii before its V, dominants leading into each other, towards Classic. Each on/off"><span class="label">Blues &amp; jazz</span>
      <div class="cb-segs cb-flags"><a data-flag="blues">Blues 7ths</a><a data-flag="subs">Jazz subs</a></div></div>`;
  const pedalRow = `<div class="cb-sl" title="Pedal point: the bass holds the key's tonic under the chords; only a chord with a tone a half step above it gets its own root"><span class="label">Pedal</span>
      <div class="cb-segs cb-pedal"><a data-pedal="0">Off</a><a data-pedal="1">On</a></div></div>`;
  const strumRow = `<div class="cb-sl" title="Notes of a chord one after another, quickly, as on a guitar: Down plays the low notes first, Up the high ones first (lighter), Down &amp; up downstrokes on the beats and upstrokes between"><span class="label">Strum</span>
      <div class="cb-segs cb-strum">${STRUMS.map((name, i) => `<a data-strum="${i}">${escapeHTML(name)}</a>`).join('')}</div></div>`;
  // More in two groups: how it plays (feel), then which chords (harmony)
  const row = (k: keyof ChordSettings) => sliders.find((m) => m.k === k);
  const slider = (m: SliderSpec | undefined) =>
    m
      ? `<label class="cb-sl" title="${escapeHTML(m.title)}"><span class="label">${m.label}</span><small>${m.left}</small>
      <input type="range" data-k="${m.k}" min="${m.min ?? 0}" max="${m.max ?? 1}" step="${m.step ?? 0.05}" tabindex="-1"><small>${m.right}</small></label>`
      : '';
  const feel = (part === 'chords' ? strumRow : '') + swingRow + slider(row('accents')) + slider(row('vary'));
  const chordsGroup =
    slider(row('changes')) + slider(row('harmony')) + slider(row('tensions')) + (part === 'chords' ? bluesRow : pedalRow) + slider(row('unfold')) + slider(row('register'));
  const actions = `<span class="cb-actions">
        ${line ? '<a class="cb-text cb-startover" title="Forget what was heard (key and chords) and listen anew, for every chords and bass zone following the same zone; chord loops playing there are switched off (kept)">Start over</a>' : ''}
        ${line ? `<span class="cb-ends">${endsHtml('cb-text')}</span>` : ''}
        ${leads ? '<a class="cb-text cb-best" title="Back to the chords that fit best" hidden>Back to best</a><a class="lightButton cb-another" title="Other chords that also fit">Other chords</a>' : ''}
      </span>`;
  // one row on top (the actions too in the dock, which is low), the pads beside More, the actions
  // in a footer in the sheet
  return `
    <div class="cb-top">
      <span class="cb-what">${what}</span><span class="label">follows</span>
      <select class="cb-follows" tabindex="-1" title="The zone whose line it plays to">${options}</select>
      <span class="label cb-gap">Style</span>
      <select class="cb-style" tabindex="-1" title="Sets this zone and the other chords and bass zones on the same line together (• : changed since)">
        <option value="">No style</option>${STYLE_GROUPS.map((g) => `<optgroup label="${escapeHTML(g)}">${stylesIn(g).map((st) => `<option value="${st.id}">${escapeHTML(st.name)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <span class="label cb-gap">Rhythm</span>
      <select class="cb-rhythm-sel" tabindex="-1" title="How the chords hit">${RHYTHM_ORDER.map((i) => `<option value="${i}"${i === DOTTED ? ' title="Hits on dotted quarters, the bar closed by a shorter group: 3+3+2 8ths in 4/4, 3+3 in 3/4, 3+2+2 in 7/8"' : ''}>${RHYTHMS[i]}</option>`).join('')}</select>
      ${actions}
      <span class="cb-status"></span>
    </div>
    <div class="cb-pads">${pads}</div>
    <div class="cb-more">
      <div class="cb-group"><div class="cb-head">How it plays</div>${feel}</div>
      ${chordsGroup ? `<div class="cb-group"><div class="cb-head">Which chords</div>${chordsGroup}</div>` : ''}
    </div>
    <div class="cb-foot">${actions}</div>`;
}

/** A setting changed (one undo step): a loop made of chords is redone, live it applies to the next chord */
function setSettings(zone: Zone, change: Partial<ChordSettings>, label = 'Chords'): void {
  const zs = hooks.zones();
  const index = zs.indexOf(zone);
  // the zone was replaced meanwhile (undo, an arrangement switch during a drag)
  if (index < 0) return;
  const line = lineZoneOf(zone);
  // only a real change of these chooses new chords (a pad's other axis moved alone doesn't)
  const decides = (['harmony', 'changes', 'seed', 'blues', 'subs'] as const).some((k) => k in change && change[k] !== zone.chordSet[k]);
  const plan = planOf(zone);
  // a change of the chords themselves goes to every follower with a loop made of chords
  if (line && decides && plan && followersOf(line)[0] === zone) {
    makeLoopsWith(line, followersOf(line).filter((z) => planOf(z)), label, () => Object.assign(zone.chordSet, change));
    return;
  }
  // the bass's pedal decides whether the chords leave out their roots: their loops are played anew too
  const chordsToo = line && 'pedal' in change && change.pedal !== zone.chordSet.pedal ? followersOf(line).filter((z) => z !== zone && z.chords!.part === 'chords' && planOf(z)) : [];
  const redo: [Zone, ChordPlan | null][] = [[zone, plan], ...chordsToo.map((z): [Zone, ChordPlan | null] => [z, planOf(z)])];
  hooks.commit([index, ...chordsToo.map((z) => zs.indexOf(z))], label, () => {
    Object.assign(zone.chordSet, change);
    const src = line ? lineOf(line) : null;
    for (const [z, p] of redo) if (p && line && src && src.length === p.length) renderLoop(z, src, p, leadOf(line), z.looper.anchor);
  });
}

/**
 * A style for the zone and the other chords and bass zones on its line (one undo step): their
 * settings set, loops made of chords redone with new chords
 */
function applyStyle(zone: Zone, id: string): void {
  const style = styleById(id);
  if (!style) return;
  const line = lineZoneOf(zone);
  // the chords change only when the zone choosing them gets the style: then every follower with a
  // loop made of chords gets the new ones, so they keep agreeing
  const decides = !!line && leaderOf(zone) === zone;
  // its zone, and from the zone choosing the chords the bass on the line too; another chords zone
  // keeps its own style, and a second chords zone's style is its own only
  const targets = line
    ? [zone, ...(decides && zone.chords!.part === 'chords' ? followersOf(line).filter((z) => z !== zone && z.chords!.part === 'bass') : [])]
    : [zone];
  const zs = hooks.zones();
  const redo = line ? (decides ? followersOf(line) : targets).filter((z) => planOf(z)) : [];
  const touched = [...new Set([...targets, ...redo])];
  const busy = touched.find((z) => z.looper.mode !== 'idle');
  if (busy) {
    toast(`${escapeHTML(zoneName(busy))}: its loop is being recorded, finish that first`);
    renderChordBlock(zone);
    return;
  }
  hooks.commit(
    touched.map((z) => zs.indexOf(z)),
    `Style: ${style.name}`,
    () => {
      for (const z of targets) {
        z.chordSet = styleSettings(style, z.chords!.part);
        z.swingAmount = style.swing ?? 0;
      }
      const src = line && lineOf(line);
      const withPlan = redo.filter((z) => src && z.loop!.length === src.length);
      if (!line || !src || !withPlan.length) return;
      const lead = leadOf(line);
      if (decides) {
        const p = progress(src.notes, src.length, hooks.meter(), harmonyOptions(lead));
        const plan = { key: p.key, chords: p.chords as (Chord | null)[], length: src.length };
        withPlan.forEach((z) => renderLoop(z, src, plan, lead, z.looper.anchor));
      } else {
        // the same chords, played the new way
        withPlan.forEach((z) => renderLoop(z, src, planOf(z)!, lead, z.looper.anchor));
      }
    }
  );
}

/** makeLoops with a settings change inside the same undo step */
function makeLoopsWith(line: Zone, which: Zone[], label: string, change: () => void): void {
  const src = lineOf(line);
  if (!src) return;
  const zs = hooks.zones();
  const indices = which.map((z) => zs.indexOf(z));
  hooks.commit(indices, label, () => {
    change();
    const meter = hooks.meter();
    const lead = leadOf(line);
    const p = progress(src.notes, src.length, meter, harmonyOptions(lead));
    const plan = { key: p.key, chords: p.chords as (Chord | null)[], length: src.length };
    which.forEach((z) => renderLoop(z, src, plan, lead, z.looper.anchor));
  });
}

// ------------------------------------------------------------------------------ cards: summary row and sheet

function summaryOf(zone: Zone): HTMLElement | null {
  return zone.elements?.zoneElement?.querySelector<HTMLElement>('.chords-sum') ?? null;
}

/** The card's one row: what it follows, its style and rhythm, the status tag, Start over, Edit */
function renderSummary(zone: Zone): void {
  const el = summaryOf(zone);
  if (!el || !zone.chords) return;
  const part = zone.chords.part;
  const line = lineZoneOf(zone);
  const s = zone.chordSet;
  const st = styleById(s.style);
  const style = st ? `${st.name}${differsFromStyle(s, part) ? ' •' : ''}` : '';
  const rhythm = part === 'chords' ? RHYTHMS[s.rhythm] : '';
  const key = [part, line ? lineLabel(line) : zone.chords.follows ? '!' : '', style, rhythm].join('|');
  if (el.dataset.key !== key) {
    el.dataset.key = key;
    const what = part === 'bass' ? 'Bass' : 'Chords';
    const follows = line
      ? `<span class="label">follows</span><span class="cs-line">${escapeHTML(lineLabel(line))}</span>`
      : `<span class="cs-none">${zone.chords.follows ? '⚠ the zone it follows is missing' : 'follows no zone yet'}</span>`;
    const parts = [style, rhythm].filter((x) => x).map((x) => `<span class="cs-sep">·</span><span>${escapeHTML(x)}</span>`).join('');
    el.innerHTML =
      `<span class="cb-what">${what}</span>${follows}${parts}<span class="cb-status"></span>` +
      `<a class="lightButton cs-edit" title="Set up the ${part === 'bass' ? 'bass' : 'chords'}: who it follows, style, rhythm, pads and more (double-click the row)"><i class="material-icons">edit</i>Edit</a>`;
  }
  el.title = `${part === 'bass' ? 'Bass' : 'Chords'} of this zone (double-click: edit)`;
}

let sheet: HTMLElement | null = null;
/** Zone.id of the zone the sheet shows (ids survive undo, the zone objects don't) */
let sheetZoneId = '';

export function isChordsSheetOpen(): boolean {
  return !!sheet?.classList.contains('open');
}

function sheetZone(): Zone | null {
  return hooks.zones().find((z) => z.id === sheetZoneId && z.chords) ?? null;
}

/** Opens the Chords sheet on a chords zone (cards only; the track view has its dock tab) */
export function openChordsSheet(zone: Zone): void {
  if (!sheet || !zone.chords) return;
  sheetZoneId = zone.id;
  sheet.classList.add('open');
  sheet.focus();
  refreshChordsSheet();
}

export function closeChordsSheet(): void {
  if (!sheet || !isChordsSheetOpen()) return;
  // a field being changed commits before the sheet goes away
  if (sheet.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  sheet.classList.remove('open');
  sheetZoneId = '';
  window.dispatchEvent(new CustomEvent('closeContextMenu'));
}

/** After zones were re-rendered or changed: redraws the sheet, or closes it when its zone is gone */
export function refreshChordsSheet(): void {
  if (!isChordsSheetOpen()) return;
  const zone = sheetZone();
  if (!zone || document.body.classList.contains('track-view') || document.body.classList.contains('minimized')) {
    closeChordsSheet();
    return;
  }
  renderChordBlock(zone);
}

/** The sheet's header: the line's chords and bass zones as chips, the shown one picked; zone colour, undo names */
function renderSheetBar(): void {
  const zone = sheetZone();
  if (!sheet || !zone) return;
  const zs = hooks.zones();
  const index = zs.indexOf(zone);
  const line = lineZoneOf(zone);
  const zones = line ? followersOf(line) : [zone];
  const colour = (z: Zone) => z.elements?.zoneElement?.dataset.colorindex ?? '0';
  sheet.dataset.colorindex = colour(zone);
  setSheetZone(sheet, zone, index);
  const chips = sheet.querySelector<HTMLElement>('.chs-zones')!;
  const key = zones.map((z) => `${z.id}:${zs.indexOf(z)}:${z.label}:${z.chords!.part}:${colour(z)}:${z === zone}`).join('|');
  if (chips.dataset.key === key) return;
  chips.dataset.key = key;
  chips.innerHTML = zones
    .map((z) => {
      const name = z.label ? `${zs.indexOf(z) + 1} ${z.label}` : `Zone ${zs.indexOf(z) + 1}`;
      const part = z.chords!.part;
      const title = z === zone ? `${name}: shown` : `Show ${name}'s ${part === 'bass' ? 'bass' : 'chords'}`;
      return `<button class="chs-zchip${z === zone ? ' sel' : ''}" data-zone-id="${escapeHTML(z.id)}" data-colorindex="${escapeHTML(colour(z))}" title="${escapeHTML(title)}">${escapeHTML(name)}<small>${part}</small></button>`;
    })
    .join('');
}

function initSheet(): void {
  sheet = document.getElementById('chordsSheet');
  if (!sheet) return;
  initSheetHeader(sheet, closeChordsSheet);
  sheet.addEventListener('click', (ev) => {
    const chip = (ev.target as HTMLElement).closest<HTMLElement>('.chs-zchip');
    if (!chip || chip.dataset.zoneId === sheetZoneId) return;
    const zone = hooks.zones().find((z) => z.id === chip.dataset.zoneId && z.chords);
    if (!zone) return;
    if (sheet!.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    sheetZoneId = zone.id;
    sheet!.focus();
    refreshChordsSheet();
  });
  // a press outside closes (it still lands); menus, dialogs and toasts don't count
  document.addEventListener('mousedown', (ev) => {
    if (!isChordsSheetOpen()) return;
    const t = ev.target as Element;
    if (t.closest('#contextmenu')) {
      ev.preventDefault();
      return;
    }
    if (sheet!.contains(t) || t.closest('dialog, #toast')) return;
    closeChordsSheet();
  });
  sheet.addEventListener('keyup', (ev) => ev.stopPropagation());
  // the Tracks view (its dock has the Chords tab) or the mini view: the sheet closes
  new MutationObserver(() => {
    if (isChordsSheetOpen()) refreshChordsSheet();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

function zoneOfEl(el: Element): Zone | null {
  if (inSheet(el)) return sheetZone();
  const z = el.closest('.zone');
  if (!z) return null;
  const i = parseInt(z.id.replace('zone', ''));
  return hooks.zones()[i] ?? null;
}

function initBlockEvents(): void {
  document.addEventListener('pointerdown', (ev) => {
    const pad = (ev.target as HTMLElement).closest?.('.chords-block .cb-pad') as HTMLElement | null;
    if (!pad || ev.button !== 0) return;
    const zone = zoneOfEl(pad);
    if (!zone?.chords) return;
    ev.preventDefault();
    const spec = PADS[zone.chords.part][parseInt(pad.dataset.pad!)];
    const previous = { ...zone.chordSet };
    dragging = pad;
    pad.setPointerCapture(ev.pointerId);
    pad.classList.add('dragging');
    pad.closest('.cb-padbox')?.classList.add('drag');
    const at = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    };
    const move = (e: PointerEvent) => {
      const p = at(e);
      // live it plays with the next chord; the loop is redone on release
      (zone.chordSet as any)[spec.x] = p.x;
      (zone.chordSet as any)[spec.y] = p.y;
      placeDot(pad, p.x, p.y);
      showReadout(pad, spec, p.x, p.y);
    };
    move(ev);
    const up = (e: PointerEvent) => {
      pad.removeEventListener('pointermove', move);
      pad.removeEventListener('pointerup', up);
      pad.removeEventListener('pointercancel', up);
      pad.classList.remove('dragging');
      pad.closest('.cb-padbox')?.classList.remove('drag');
      dragging = null;
      const p = at(e);
      const change = { [spec.x]: p.x, [spec.y]: p.y } as Partial<ChordSettings>;
      // back to where it was, so the undo step holds the change
      Object.assign(zone.chordSet, { [spec.x]: previous[spec.x], [spec.y]: previous[spec.y] });
      if (previous[spec.x] === p.x && previous[spec.y] === p.y) return;
      setSettings(zone, change);
    };
    pad.addEventListener('pointermove', move);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
  });
  document.addEventListener('dblclick', (ev) => {
    const t = ev.target as HTMLElement;
    const pad = t.closest?.('.chords-block .cb-pad') as HTMLElement | null;
    const zone = zoneOfEl(t);
    if (!zone?.chords) return;
    if (pad) {
      const spec = PADS[zone.chords.part][parseInt(pad.dataset.pad!)];
      setSettings(zone, { [spec.x]: MIDDLE[spec.x] ?? 0.5, [spec.y]: MIDDLE[spec.y] ?? 0.5 } as Partial<ChordSettings>);
    } else if (t.matches('.chords-block input[data-swing]')) {
      const zs = hooks.zones();
      hooks.commit([zs.indexOf(zone)], 'Swing', () => {
        zone.swingAmount = 0;
        chordsSwingChanged(zone);
      });
    } else if (t.matches('.chords-block .cb-more input[type=range][data-k]')) {
      const k = (t as HTMLInputElement).dataset.k as keyof ChordSettings;
      setSettings(zone, { [k]: MIDDLE[k] ?? 0.5 } as Partial<ChordSettings>);
    }
  });
  // the card's summary row: Start over, Edit, a double-click edits
  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest?.('.chords-sum')) return;
    const zone = zoneOfEl(t);
    if (!zone?.chords) return;
    if (t.closest('.cs-edit')) openChordsSheet(zone);
  });
  // a followed zone's card: Start over for all its chords and bass zones
  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const fin = t.closest?.<HTMLElement>('.card-follow .cb-finish');
    if (fin) {
      const line = hooks.zones().find((z) => z.elements?.zoneElement?.contains(t));
      if (line) finishLine(line, fin.dataset.end as 'closed' | 'open' | 'on');
      return;
    }
    if (!t.closest?.('.card-follow .cf-startover')) return;
    const line = hooks.zones().find((z) => z.elements?.zoneElement?.contains(t));
    if (line) startOverLine(line);
  });
  document.addEventListener('dblclick', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest?.('.chords-sum') || t.closest('a')) return;
    const zone = zoneOfEl(t);
    if (zone?.chords) openChordsSheet(zone);
  });
  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest?.('.chords-block')) return;
    const zone = zoneOfEl(t);
    if (!zone?.chords) return;
    const fl = t.closest<HTMLElement>('.cb-flags a');
    if (fl) {
      const k = fl.dataset.flag === 'subs' ? 'subs' : 'blues';
      setSettings(zone, { [k]: zone.chordSet[k] === 1 ? 0 : 1 }, k === 'subs' ? 'Chords: Jazz subs' : 'Chords: Blues 7ths');
      return;
    }
    const pd = t.closest<HTMLElement>('.cb-pedal a');
    if (pd) {
      const i = Number(pd.dataset.pedal);
      if (i !== zone.chordSet.pedal) setSettings(zone, { pedal: i }, 'Bass: Pedal');
      return;
    }
    const st = t.closest<HTMLElement>('.cb-strum a');
    if (st) {
      const i = Number(st.dataset.strum);
      if (i !== zone.chordSet.strum) setSettings(zone, { strum: i });
      return;
    }
    if (t.closest('.cb-startover')) {
      startOver(zone);
      return;
    }
    const fin = t.closest<HTMLElement>('.cb-finish');
    if (fin) {
      const line = lineZoneOf(zone);
      if (line) finishLine(line, fin.dataset.end as 'closed' | 'open' | 'on');
      return;
    }
    if (t.closest('.cb-another')) {
      setSettings(zone, { seed: (zone.chordSet.seed % 9973) + 1 }, 'Other Chords');
      return;
    }
    if (t.closest('.cb-best')) {
      if (zone.chordSet.seed) setSettings(zone, { seed: 0 }, 'Chords: Back to Best');
      return;
    }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest?.('.chords-block')) return;
    const zone = zoneOfEl(t);
    if (!zone?.chords) return;
    if (t.matches('.cb-rhythm-sel')) {
      const i = Number((t as HTMLSelectElement).value);
      (t as HTMLSelectElement).blur();
      if (i !== zone.chordSet.rhythm) setSettings(zone, { rhythm: i });
      return;
    }
    if (t.matches('.cb-style')) {
      const st = styleById((t as HTMLSelectElement).value);
      (t as HTMLSelectElement).blur();
      if (st) applyStyle(zone, st.id);
      else renderChordBlock(zone);
      return;
    }
    if (t.matches('.cb-follows')) {
      const id = (t as HTMLSelectElement).value;
      const zs = hooks.zones();
      hooks.commit([zs.indexOf(zone)], 'Chords Follow', () => {
        zone.chords = { ...zone.chords!, follows: id };
      });
      const line = lineZoneOf(zone);
      if (line) freshStart(line);
      return;
    }
    if (t.matches('input[data-swing]')) {
      const v = parseFloat((t as HTMLInputElement).value);
      (t as HTMLInputElement).blur();
      const zs = hooks.zones();
      hooks.commit([zs.indexOf(zone)], 'Swing', () => {
        zone.swingAmount = v;
        chordsSwingChanged(zone);
      });
      return;
    }
    if (t.matches('.cb-more input[type=range]')) {
      const k = (t as HTMLInputElement).dataset.k as keyof ChordSettings;
      const v = parseFloat((t as HTMLInputElement).value);
      (t as HTMLInputElement).blur();
      setSettings(zone, { [k]: v } as Partial<ChordSettings>);
    }
  });
  // keys typed in the block's fields stay out of the app's shortcuts
  document.addEventListener(
    'keydown',
    (ev) => {
      const t = ev.target as HTMLElement;
      // the sheet: Esc closes, ⌘Z and Space (play/stop) reach the app, nothing else does
      if (isChordsSheetOpen()) {
        const mod = ev.metaKey || ev.ctrlKey;
        if (ev.key === 'Escape') {
          if (t.closest?.('#contextmenu')) return;
          ev.preventDefault();
          ev.stopPropagation();
          closeChordsSheet();
          return;
        }
        if (mod && ev.code === 'KeyZ') return;
        if (ev.code === 'Space' && !t.matches?.('input[type=text], input[type=number], textarea')) {
          // not a press of the focused button or select
          ev.preventDefault();
          return;
        }
        ev.stopPropagation();
        return;
      }
      if (t.closest?.('.chords-block') && ev.code !== 'KeyZ' && ev.code !== 'Space') ev.stopPropagation();
    },
    true
  );
}

export function initChords(h: Hooks): void {
  hooks = h;
  initBlockEvents();
  initSheet();
}
